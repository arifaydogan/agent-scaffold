import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { evaluateIssue } from "./policy.js";
import {
  buildExecutorCommand,
  parseExecutionOutput,
  selectExecutionProfile
} from "./executor.js";
import { routeIssue } from "./routing.js";
import { parseGitStatus, validateChangedFiles } from "./scope.js";
import { RunStore } from "./store.js";
import { prepareWorktree } from "./worktree.js";

export function issuePlan(settings, issue) {
  const eligibility = evaluateIssue(issue, settings.data.policy);
  const route = routeIssue(issue);
  const execution = settings.data.executor
    ? selectExecutionProfile(settings, issue, route)
    : null;
  const allowedPaths = settings.data.policy.pathScopes?.[route.persona] || [];
  const worktree = prepareWorktree({
    repoPath: settings.repoPath,
    root: settings.worktreeRoot,
    issueKey: issue.key,
    summary: issue.summary
  });
  return {
    issue: issue.key,
    summary: issue.summary,
    eligible: eligibility.allowed,
    eligibilityReasons: eligibility.reasons,
    ...route,
    allowedPaths,
    execution: execution
      ? {
          provider: execution.provider,
          agent: execution.agent,
          model: execution.model,
          modelProfile: execution.modelProfile,
          effort: execution.effort,
          mode: execution.mode
        }
      : null,
    ...worktree
  };
}

export function getStore(settings) {
  return new RunStore(
    path.join(path.dirname(settings.source), ".agent-runtime", "runs.sqlite3")
  );
}

export function materializeWorkspaceInstructions(settings, worktree) {
  const relativePaths = [
    "AGENTS.md",
    "ORCHESTRATION.md",
    "PACEBUILD_ORCHESTRATOR.md",
    ".agents"
  ];
  for (const relativePath of relativePaths) {
    const source = path.join(settings.repoPath, relativePath);
    const target = path.join(worktree, relativePath);
    if (fs.existsSync(source) && !fs.existsSync(target)) {
      fs.cpSync(source, target, { recursive: true });
    }
  }
  const instructionFiles = [
    path.join(worktree, "AGENTS.md"),
    path.join(worktree, "ORCHESTRATION.md"),
    path.join(worktree, "PACEBUILD_ORCHESTRATOR.md"),
    path.join(worktree, ".agents", "rules", "orchestration-gates.md")
  ];
  return {
    instructionFiles,
    missing: instructionFiles.filter((file) => !fs.existsSync(file))
  };
}

// Maximum number of progress events to persist per run (bounded).
const MAX_PROGRESS_EVENTS = 20;

// Redact values that look like secrets or long tokens from progress text.
// Covers: long base64 strings, Bearer auth headers, JWT segments (dot-separated base64),
// and plain long alphanumeric API-key patterns.
function redactProgressText(text) {
  if (!text || typeof text !== "string") return text;
  return text
    // Bearer <token> and Authorization headers
    .replace(/\bBearer\s+[A-Za-z0-9+/_.~-]{10,}/gi, "Bearer [redacted]")
    // JWT-like three-part dotted tokens (header.payload.signature)
    .replace(/\b[A-Za-z0-9+/_-]{10,}\.[A-Za-z0-9+/_-]{10,}\.[A-Za-z0-9+/_-]{10,}\b/g, "[redacted]")
    // Long base64 or alphanumeric secrets (20+ chars)
    .replace(/\b[A-Za-z0-9+/]{20,}={0,2}\b/g, "[redacted]");
}

/**
 * Stream an antigravity provider run asynchronously.
 * - Persists "queued" BEFORE spawning.
 * - Spawns the process (non-blocking).
 * - Streams structured JSON lines from stdout into bounded, redacted progress events.
 * - Persists started/model_selected/progress/terminal outcome.
 * - Resolves when the process exits.
 *
 * @param {object} params
 * @param {RunStore} params.store
 * @param {string} params.runId
 * @param {object} params.built  - result of buildExecutorCommand
 * @param {object} params.profile
 * @param {object} params.plan
 * @param {object} params.prepared
 * @param {number} params.timeoutMs
 * @returns {Promise<{exitCode: number, telemetry: object, scope: object}>}
 */
export function spawnProviderAsync(params, runtime = { spawn }) {
  const { store, runId, built, profile, plan, prepared, timeoutMs, issueKey = "" } = params;

  // CRITICAL: persist queued BEFORE spawning so the control plane is aware.
  store.transition(runId, "queued", {
    provider: profile.provider,
    agent: profile.agent,
    model: profile.model,
    modelProfile: profile.modelProfile,
    command: built.redactedCommand,
    cwd: built.cwd,
    logFile: built.logFile
  });

  return new Promise((resolve) => {
    let progressCount = 0;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let startedEmitted = false;
    let modelSelectedEmitted = false;
    const collectedStdout = [];
    let killed = false;

    const child = runtime.spawn(built.command[0], built.command.slice(1), {
      cwd: built.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    // Safety timeout: kill if provider runs too long.
    const killTimer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      store.transition(runId, "failed", {
        reason: "Provider timeout",
        timeoutMs,
        provider: profile.provider,
        model: profile.model
      });
      // Release the issue lock so a retry can acquire it.
      store.releaseLock(issueKey, runId);
      const scope = buildScopeResult(prepared, plan, 1);
      resolve({ exitCode: 4, telemetry: { ok: false }, scope });
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(killTimer);
      store.transition(runId, "failed", {
        reason: "Spawn error",
        error: error.message,
        provider: profile.provider,
        model: profile.model
      });
      // Release the lock so a retry can acquire it (matches timeout handler behaviour).
      store.releaseLock(issueKey, runId);
      resolve({ exitCode: 1, telemetry: { ok: false }, scope: buildScopeResult(prepared, plan, 0) });
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      collectedStdout.push(chunk);
      // Process complete lines.
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event = null;
        try {
          event = JSON.parse(trimmed);
        } catch {
          // Not JSON — skip
        }
        if (!event || typeof event !== "object") continue;

        // Emit "started" on the first JSON event from the provider.
        if (!startedEmitted) {
          startedEmitted = true;
          store.transition(runId, "started", {
            provider: profile.provider,
            model: profile.model
          });
        }

        // Emit "model_selected" at most once when the provider reports the model it chose.
        if (!modelSelectedEmitted && event.model && event.type !== "progress") {
          modelSelectedEmitted = true;
          store.transition(runId, "model_selected", {
            provider: profile.provider,
            model: event.model || profile.model
          });
          continue;
        }

        // Emit bounded progress events — drop if we've hit the cap.
        if (progressCount < MAX_PROGRESS_EVENTS) {
          const text = redactProgressText(
            event.text || event.message || event.content_block?.text || null
          );
          if (text) {
            progressCount += 1;
            store.transition(runId, "progress", {
              seq: progressCount,
              text,
              provider: profile.provider
            });
          }
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.once("close", (code) => {
      clearTimeout(killTimer);
      if (killed) return; // timeout handler already called resolve()
      const returnCode = code ?? 1;
      const stdout = Buffer.concat(collectedStdout).toString("utf8");
      fs.writeFileSync(
        built.logFile + ".stdio",
        "STDOUT\n" + stdout + "\n\nSTDERR\n" + stderrBuffer + "\n",
        "utf8"
      );
      const telemetry = parseExecutionOutput(
        profile.provider,
        stdout,
        stderrBuffer,
        returnCode
      );
      const scope = buildScopeResult(prepared, plan, returnCode);
      const accepted = telemetry.ok && scope.allowed;
      store.transition(
        runId,
        accepted ? "verifying" : scope.allowed ? "failed-retryable" : "failed-scope",
        {
          returnCode,
          provider: profile.provider,
          model: profile.model,
          conversationId: telemetry.conversationId || null,
          durationSeconds: telemetry.durationSeconds || null,
          turns: telemetry.turns || null,
          usage: telemetry.usage || null,
          permissionDenied: telemetry.permissionDenied || false,
          result: telemetry.result || null,
          scope,
          logFile: built.logFile
        }
      );
      resolve({ exitCode: accepted ? 0 : scope.allowed ? returnCode || 4 : 5, telemetry, scope });
    });
  });
}

function buildScopeResult(prepared, plan, returnCode) {
  const gitStatus = spawnSync(
    "git",
    ["-c", "safe.directory=*", "-C", prepared.worktree, "status", "--porcelain=v1"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  if (gitStatus.status !== 0) {
    return {
      allowed: false,
      changedFiles: [],
      violations: [],
      reasons: ["Unable to inspect worktree changes"]
    };
  }
  return validateChangedFiles({
    changedFiles: parseGitStatus(gitStatus.stdout),
    allowedPatterns: plan.allowedPaths,
    maxChangedFiles: plan.maxChangedFiles || 30
  });
}

/**
 * Run an issue that has already been resolved locally (no Jira required).
 * The caller supplies a plain issue packet identical to what JiraClient.getIssue() returns.
 * This is the "local-run" path for control-plane use without Jira credentials.
 */
export function runIssueLocal(settings, issuePacket, execute, runtime = { spawnSync, spawn }) {
  return runIssue(settings, issuePacket, execute, runtime);
}

/**
 * Main run entry point. For the antigravity provider, execution is asynchronous
 * (spawn + streaming). For all other providers, execution remains synchronous
 * (spawnSync) for backward compatibility.
 *
 * Returns { exitCode, output } for synchronous paths.
 * Returns a Promise<{ exitCode, output }> for the async (antigravity) path.
 */
export function runIssue(settings, issue, execute, runtime = { spawnSync, spawn }) {
  const plan = issuePlan(settings, issue);
  const store = getStore(settings);
  const runId = store.createRun(issue.key, plan);
  if (!plan.eligible) {
    store.transition(runId, "blocked", { reasons: plan.eligibilityReasons });
    return { exitCode: 2, output: { runId, ...plan } };
  }
  store.transition(runId, "eligible", plan);
  if (!execute) {
    return { exitCode: 0, output: { runId, mode: "dry-run", ...plan } };
  }
  if (!store.acquireLock(issue.key, runId)) {
    store.transition(runId, "blocked", { reason: "issue already locked" });
    return { exitCode: 3, output: { runId, error: "issue already locked" } };
  }
  store.transition(runId, "claimed");
  const profile = selectExecutionProfile(settings, issue, plan);
  const prepared = prepareWorktree({
    repoPath: settings.repoPath,
    root: settings.worktreeRoot,
    issueKey: issue.key,
    summary: issue.summary,
    execute: true
  });
  const instructionContext = materializeWorkspaceInstructions(
    settings,
    prepared.worktree
  );
  if (instructionContext.missing.length) {
    store.transition(runId, "blocked", {
      reason: "Workspace instructions are missing",
      missing: instructionContext.missing
    });
    store.releaseLock(issue.key, runId);
    return {
      exitCode: 6,
      output: {
        runId,
        error: "Workspace instructions are missing",
        missing: instructionContext.missing
      }
    };
  }
  store.transition(runId, "prepared", prepared);
  const providerInstruction =
    profile.provider === "antigravity"
      ? "Edit only this worktree. Do not run shell commands; return required validation commands to the scheduler."
      : "Run the relevant tests and report their results.";
  const instructionFiles = instructionContext.instructionFiles;
  const prompt = [
    "Implement Jira issue " + issue.key + ": " + issue.summary,
    "Workspace root: " + prepared.worktree,
    "Read these exact instruction files without listing parent directories: " +
      instructionFiles.join(" ; "),
    issue.description,
    "Assigned task agent: " + profile.agent,
    "Risk: " + plan.risk + "; parallel safe: " + plan.parallelSafe,
    "Allowed changed paths: " + plan.allowedPaths.join(", "),
    providerInstruction,
    "Follow the canonical PaceBuild approval gates. Do not push, merge, write externally, or transition the issue to Done."
  ].join("\n\n");
  const built = buildExecutorCommand({
    settings,
    profile,
    prepared,
    prompt,
    runId
  });

  // Antigravity provider: async streaming path.
  // spawnProviderAsync handles all state transitions starting with "queued" (before spawn).
  // Do NOT emit "executing" here — that would appear before "queued" and break lifecycle ordering.
  if (profile.provider === "antigravity") {
    return spawnProviderAsync(
      {
        store,
        runId,
        built,
        profile,
        plan,
        prepared,
        issueKey: issue.key,
        timeoutMs: (profile.config.timeoutSeconds || 3600) * 1000
      },
      runtime
    ).then(({ exitCode, telemetry, scope }) => ({
      exitCode,
      output: {
        runId,
        returnCode: exitCode,
        provider: profile.provider,
        model: profile.model,
        telemetry,
        scope
      }
    }));
  }

  // Non-antigravity providers: synchronous spawnSync path (backward-compatible).
  // "executing" is only emitted here. Antigravity uses queued→started→model_selected→progress instead.
  store.transition(runId, "executing", {
    provider: profile.provider,
    agent: profile.agent,
    model: profile.model,
    modelProfile: profile.modelProfile,
    effort: profile.effort,
    command: built.redactedCommand,
    cwd: built.cwd,
    logFile: built.logFile
  });
  const result = runtime.spawnSync(built.command[0], built.command.slice(1), {
    cwd: built.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: profile.config.timeoutSeconds * 1000
  });
  const returnCode = result.status ?? 1;
  const stdout = result.stdout || "";
  const stderr = result.stderr || result.error?.message || "";
  fs.writeFileSync(
    built.logFile + ".stdio",
    "STDOUT\n" + stdout + "\n\nSTDERR\n" + stderr + "\n",
    "utf8"
  );
  const telemetry = parseExecutionOutput(
    profile.provider,
    stdout,
    stderr,
    returnCode
  );
  const gitStatus = runtime.spawnSync(
    "git",
    [
      "-c",
      "safe.directory=*",
      "-C",
      prepared.worktree,
      "status",
      "--porcelain=v1"
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const scope =
    gitStatus.status === 0
      ? validateChangedFiles({
          changedFiles: parseGitStatus(gitStatus.stdout),
          allowedPatterns: plan.allowedPaths,
          maxChangedFiles: settings.data.policy.maxChangedFiles || 30
        })
      : {
          allowed: false,
          changedFiles: [],
          violations: [],
          reasons: ["Unable to inspect worktree changes"]
        };
  const accepted = telemetry.ok && scope.allowed;
  store.transition(
    runId,
    accepted ? "verifying" : scope.allowed ? "failed-retryable" : "failed-scope",
    {
      returnCode,
      provider: profile.provider,
      model: profile.model,
      conversationId: telemetry.conversationId || null,
      durationSeconds: telemetry.durationSeconds || null,
      turns: telemetry.turns || null,
      usage: telemetry.usage || null,
      permissionDenied: telemetry.permissionDenied || false,
      result: telemetry.result || null,
      scope,
      logFile: built.logFile
    }
  );
  return {
    exitCode: accepted ? 0 : scope.allowed ? returnCode || 4 : 5,
    output: {
      runId,
      returnCode,
      provider: profile.provider,
      model: profile.model,
      telemetry,
      scope
    }
  };
}
