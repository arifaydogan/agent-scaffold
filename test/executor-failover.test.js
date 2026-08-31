import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync as realSpawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyExecutionFailure,
  parseExecutionOutput,
  selectExecutionCandidates,
  selectExecutionProfile
} from "../lib/executor.js";
import { computePlanFingerprint } from "../lib/policy.js";
import { runIssue } from "../lib/runtime.js";
import { RunStore } from "../lib/store.js";

function adaptiveSettings(directory) {
  return {
    source: path.join(directory, "agent-scaffold.json"),
    repoPath: directory,
    worktreeRoot: path.join(directory, "worktrees"),
    data: {
      project: { key: "PACE", baseBranch: "develop", operatingMode: "autonomous" },
      policy: {
        allowedProjects: ["PACE"],
        requiredLabels: ["agent-ready"],
        humanOnlyStatuses: ["Done"],
        pathScopes: { "backend-engineer": ["lib/**"] },
        maxChangedFiles: 30
      },
      executor: {
        defaultProvider: "codex",
        adaptiveRouting: {
          enabled: true,
          providerOrder: ["codex", "antigravity", "ollama"],
          modelFallbackProfiles: ["medium", "low"],
          maxAttempts: 3,
          taskProfiles: { "backend-engineer": "medium", "security-engineer": "high" }
        },
        providers: {
          codex: {
            command: ["codex", "exec", "-m", "{model}", "-C", "{worktree}", "{prompt}"],
            defaultModel: "gpt-5.6-terra",
            modelProfiles: { low: "gpt-5.6-luna", medium: "gpt-5.6-terra", high: "gpt-5.6-sol" }
          },
          antigravity: {
            command: ["agy", "--model", "{model}", "-p", "{prompt}"],
            defaultModel: "claude-sonnet-4-6",
            modelProfiles: { low: "gemini-flash", medium: "claude-sonnet-4-6", high: "claude-opus" }
          },
          ollama: {
            enabled: false,
            command: ["codex", "exec", "-m", "{model}", "{prompt}"],
            defaultModel: "qwen",
            modelProfiles: { medium: "qwen" }
          }
        }
      }
    }
  };
}

test("adaptive candidates use task strength, exclude disabled providers, and preserve explicit provider pins", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "executor-candidates-"));
  const settings = adaptiveSettings(directory);
  const issue = { labels: [] };
  const plan = { taskAgent: "security-engineer", persona: "security-engineer", risk: "normal" };
  const primary = selectExecutionProfile(settings, issue, plan);
  const candidates = selectExecutionCandidates(settings, issue, plan, primary);

  assert.equal(primary.modelProfile, "high");
  assert.equal(primary.model, "gpt-5.6-sol");
  assert.ok(candidates.some(candidate => candidate.provider === "antigravity"));
  assert.equal(candidates.some(candidate => candidate.provider === "ollama"), false);

  const pinnedIssue = { labels: ["provider-antigravity"] };
  const pinnedPrimary = selectExecutionProfile(settings, pinnedIssue, plan);
  const pinned = selectExecutionCandidates(settings, pinnedIssue, plan, pinnedPrimary);
  assert.ok(pinned.every(candidate => candidate.provider === "antigravity"));

  const highRiskBackend = selectExecutionProfile(settings, issue, {
    taskAgent: "backend-engineer",
    persona: "backend-engineer",
    risk: "high"
  });
  assert.equal(highRiskBackend.modelProfile, "high", "risk escalation must override the normal task default");
  assert.equal(highRiskBackend.model, "gpt-5.6-sol");
});

test("failure classification only allows safe infrastructure failover", () => {
  const cleanScope = { allowed: true, changedFiles: [] };
  const host = classifyExecutionFailure({
    telemetry: { ok: false },
    returnCode: 0,
    scope: cleanScope,
    stdout: "status: blocked\nblockers:\n - codex-code-mode-host.exe was not found"
  });
  assert.equal(host.category, "tool_host_unavailable");
  assert.equal(host.autoFailover, true);
  assert.equal(host.providerWide, true);

  const auth = classifyExecutionFailure({ telemetry: { ok: false }, scope: cleanScope, stderr: "invalid API key" });
  assert.equal(auth.category, "authentication_failed");
  assert.equal(auth.autoFailover, false);

  const dirty = classifyExecutionFailure({
    telemetry: { ok: false },
    scope: { allowed: true, changedFiles: ["lib/runtime.js"] },
    stderr: "429 rate limit"
  });
  assert.equal(dirty.category, "rate_limited");
  assert.equal(dirty.autoFailover, false);

  const incompatibleModelOptions = classifyExecutionFailure({
    telemetry: { ok: false },
    scope: cleanScope,
    stdout: 'invalid model selection (--model "claude-opus-4-6-thinking" --effort "high"): --effort is not supported for model'
  });
  assert.equal(incompatibleModelOptions.category, "model_configuration_invalid");
  assert.equal(incompatibleModelOptions.autoFailover, true);
});

test("Antigravity terminal result envelopes preserve the provider error", () => {
  const stdout = JSON.stringify({
    event: "result",
    result: {
      conversation_id: "",
      status: "ERROR",
      response: "",
      error: 'invalid model selection: --effort is not supported for model "claude-opus-4-6-thinking"',
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
  const telemetry = parseExecutionOutput("antigravity", stdout, "", 1);

  assert.equal(telemetry.ok, false);
  assert.match(telemetry.error.safeMessage, /--effort is not supported/);
  const failure = classifyExecutionFailure({ telemetry, returnCode: 1, scope: { allowed: true, changedFiles: [] }, stdout });
  assert.equal(failure.category, "model_configuration_invalid");
  assert.equal(failure.autoFailover, true);
});

test("plan fingerprint binds the approved candidate order but not the active fallback cursor", () => {
  const candidates = [
    { provider: "codex", model: "gpt-5.6-terra", modelProfile: "medium", effort: "medium" },
    { provider: "antigravity", model: "claude-sonnet-4-6", modelProfile: "medium", effort: "medium" }
  ];
  const base = { issue: "PACE-1", allowedPaths: ["lib/**"], execution: candidates[0], executionCandidates: candidates };
  assert.equal(
    computePlanFingerprint(base),
    computePlanFingerprint({ ...base, execution: candidates[1] })
  );
  assert.notEqual(
    computePlanFingerprint(base),
    computePlanFingerprint({ ...base, executionCandidates: [...candidates].reverse() })
  );
});

test("clean tool-host failure automatically continues with the next approved provider", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "executor-failover-runtime-"));
  const settings = adaptiveSettings(directory);
  fs.mkdirSync(path.join(directory, ".agents", "rules"), { recursive: true });
  for (const file of ["AGENTS.md", "ORCHESTRATION.md", "PACEBUILD_ORCHESTRATOR.md"]) {
    fs.writeFileSync(path.join(directory, file), "test instructions\n", "utf8");
  }
  fs.writeFileSync(path.join(directory, ".agents", "rules", "orchestration-gates.md"), "test gates\n", "utf8");
  assert.equal(realSpawnSync("git", ["init", "-q", directory]).status, 0);
  assert.equal(realSpawnSync("git", ["-C", directory, "config", "user.email", "test@example.com"]).status, 0);
  assert.equal(realSpawnSync("git", ["-C", directory, "config", "user.name", "Test User"]).status, 0);
  assert.equal(realSpawnSync("git", ["-C", directory, "add", "."]).status, 0);
  assert.equal(realSpawnSync("git", ["-C", directory, "commit", "-qm", "initial"]).status, 0);
  assert.equal(realSpawnSync("git", ["-C", directory, "branch", "-M", "develop"]).status, 0);

  const issue = {
    key: "PACE-900",
    canonicalState: "ready",
    summary: "Exercise adaptive provider routing",
    description: "Acceptance Criteria: complete through the fallback provider",
    issueType: "Task",
    status: "To Do",
    labels: ["agent-ready"]
  };
  const primary = selectExecutionProfile(settings, issue, {
    taskAgent: "backend-engineer",
    persona: "backend-engineer",
    risk: "normal"
  });
  const candidates = selectExecutionCandidates(settings, issue, {
    taskAgent: "backend-engineer",
    persona: "backend-engineer",
    risk: "normal"
  }, primary).filter(candidate => candidate.provider !== "codex" || candidate.model === primary.model);
  const plan = {
    issue: issue.key,
    summary: issue.summary,
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    risk: "normal",
    parallelSafe: true,
    allowedPaths: ["lib/**"],
    eligible: true,
    eligibilityReasons: [],
    execution: candidates[0],
    executionCandidates: candidates,
    adaptiveRouting: settings.data.executor.adaptiveRouting,
    baseRef: "develop"
  };
  const runtime = {
    spawnSync(command, args, options) {
      if (command === "codex") {
        return {
          status: 0,
          stdout: "status: blocked\nblockers:\n - codex-code-mode-host.exe executable not found",
          stderr: "failed to spawn code-mode host"
        };
      }
      return realSpawnSync(command, args, options);
    },
    spawn() {
      const child = new EventEmitter();
      child.pid = 7070;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({
          status: "SUCCESS",
          response: JSON.stringify({
            status: "completed",
            summary: "fallback completed",
            changed_files: [],
            validation_commands: [],
            blockers: [],
            risks: []
          })
        }) + "\n"));
        child.emit("close", 0);
      });
      return child;
    }
  };

  const result = await Promise.resolve(runIssue(settings, issue, true, runtime, { plan }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.provider, "antigravity");
  assert.equal(result.output.failoverHistory.length, 1);
  assert.equal(result.output.failoverHistory[0].category, "tool_host_unavailable");

  const store = new RunStore(path.join(directory, ".agent-runtime", "runs.sqlite3"));
  const runs = store.listRunsDetailed(10).filter(run => run.issue_key === issue.key);
  assert.equal(runs.length, 2);
  assert.equal(runs.some(run => run.state === "failed-retryable" && run.latest_payload.failure?.category === "tool_host_unavailable"), true);
  assert.equal(runs.some(run => run.state === "verifying"), true);
  assert.equal(store.listLocks().length, 1, "successful verifying run keeps its issue lock");
  store.database.close();
});
