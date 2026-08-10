/**
 * test/runtime-lifecycle.test.js
 *
 * Focused tests for PACE-354:
 * 1. Lifecycle ordering: queued is persisted BEFORE the provider spawns.
 * 2. Streaming telemetry and redaction.
 * 3. Local execution entry path / no-Jira local commands.
 * 4. Antigravity command construction (--add-dir, no --effort for claude-sonnet-4-6).
 * 5. Dashboard snapshot/UI shaping for live streaming states.
 *
 * Run with: node --test test/runtime-lifecycle.test.js
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { RunStore } from "../lib/store.js";
import { spawnProviderAsync, runIssueLocal } from "../lib/runtime.js";
import { buildExecutorCommand, selectExecutionProfile } from "../lib/executor.js";
import { buildDashboardSnapshot } from "../lib/dashboard.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pace354-"));
}

function baseSettings(directory) {
  return {
    source: path.join(directory, "agent-scaffold.json"),
    repoPath: directory,
    worktreeRoot: path.join(directory, "worktrees"),
    data: {
      policy: {
        allowedProjects: ["PACE"],
        requiredLabels: ["agent-ready"],
        humanOnlyStatuses: ["Tamam"],
        maxChangedFiles: 30
      },
      executor: {
        defaultProvider: "antigravity",
        providers: {
          antigravity: {
            command: [
              "agy",
              "--agent", "{agent}",
              "--model", "{model}",
              "--mode", "{mode}",
              "--output-format", "json",
              "--json-schema", "{resultSchema}",
              "--log-file", "{logFile}",
              "-p", "{prompt}"
            ],
            cwd: "{worktree}",
            mode: "accept-edits",
            defaultModel: "claude-sonnet-4-6",
            modelProfiles: {
              medium: "claude-sonnet-4-6",
              high: "claude-opus-4-6-thinking"
            },
            resultSchema: "adapters/antigravity/execution-result.schema.json",
            timeoutSeconds: 60
          }
        }
      }
    }
  };
}

function eligibleIssue() {
  return {
    key: "PACE-354",
    summary: "Runtime reconciliation and safe checkpoint",
    description: "## Acceptance Criteria\n- [ ] Provider launch persists queued before spawn",
    issueType: "Hikaye",
    status: "Yapılacaklar",
    labels: ["agent-ready", "provider-antigravity"]
  };
}

/**
 * Build a fake spawn runtime that emits controlled stdout JSON lines and exits.
 * Returns { runtime, emitLine, close } for test control.
 */
function fakespawnRuntime(opts = {}) {
  const { exitCode = 0, lines = [], stderrLines = [] } = opts;

  function spawn(_cmd, _args, _opts) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};

    setImmediate(() => {
      for (const line of stderrLines) {
        proc.stderr.emit("data", Buffer.from(line + "\n"));
      }
      for (const line of lines) {
        proc.stdout.emit("data", Buffer.from(line + "\n"));
      }
      proc.emit("close", exitCode);
    });

    return proc;
  }

  return { spawn };
}

// ─── Test 1: queued is persisted BEFORE spawn fires ─────────────────────────

test("lifecycle: queued is persisted before the provider process starts", async () => {
  const dir = tempDir();
  const store = new RunStore(path.join(dir, "runs.sqlite3"));
  const runId = store.createRun("PACE-354", { summary: "test" });
  store.acquireLock("PACE-354", runId);
  store.transition(runId, "claimed");
  store.transition(runId, "prepared", {});

  const profile = {
    provider: "antigravity",
    config: { timeoutSeconds: 10, command: ["agy", "-p", "{prompt}"] },
    agent: "backend-engineer",
    model: "claude-sonnet-4-6",
    modelProfile: "medium",
    effort: "medium",
    mode: "accept-edits"
  };

  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const built = {
    command: ["agy", "-p", "task"],
    redactedCommand: ["agy", "-p", "<redacted>"],
    cwd: dir,
    logFile: path.join(logDir, `${runId}-agy.log`),
    resultSchema: ""
  };
  const plan = { allowedPaths: ["backend/**"], maxChangedFiles: 30 };
  const prepared = { worktree: dir };

  // Track which states appear and their order.
  const statesBeforeSpawn = [];
  let spawnCalled = false;

  const observingRuntime = {
    spawn(cmd, args, opts) {
      // At the moment spawn is called, queued must already be recorded.
      const run = store.getRun(runId);
      statesBeforeSpawn.push(...run.events.map((e) => e.state));
      spawnCalled = true;

      // Return a process that immediately exits successfully with a valid JSON line.
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      setImmediate(() => {
        proc.stdout.emit("data", Buffer.from(JSON.stringify({
          status: "SUCCESS",
          response: JSON.stringify({
            status: "completed",
            summary: "done",
            changed_files: [],
            validation_commands: [],
            blockers: [],
            risks: []
          })
        }) + "\n"));
        proc.emit("close", 0);
      });
      return proc;
    }
  };

  await spawnProviderAsync(
    { store, runId, built, profile, plan, prepared, timeoutMs: 10_000 },
    observingRuntime
  );

  assert.ok(spawnCalled, "spawn must have been called");
  assert.ok(
    statesBeforeSpawn.includes("queued"),
    `queued must be persisted before spawn; states seen: ${statesBeforeSpawn.join(",")}`
  );
});

// ─── Test 2: lifecycle ordering – queued → started → model_selected → progress ─

test("lifecycle: streaming events progress through queued→started→progress", async () => {
  const dir = tempDir();
  const store = new RunStore(path.join(dir, "runs.sqlite3"));
  const runId = store.createRun("PACE-354", { summary: "test" });

  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const profile = {
    provider: "antigravity",
    config: { timeoutSeconds: 10 },
    agent: "backend-engineer",
    model: "claude-sonnet-4-6",
    modelProfile: "medium",
    effort: "medium",
    mode: "accept-edits"
  };
  const built = {
    command: ["agy", "x"],
    redactedCommand: ["agy", "x"],
    cwd: dir,
    logFile: path.join(logDir, `${runId}-agy.log`),
    resultSchema: ""
  };
  const plan = { allowedPaths: [], maxChangedFiles: 30 };
  const prepared = { worktree: dir };

  // Emit: a progress line, then a final SUCCESS line.
  const lines = [
    JSON.stringify({ type: "content_block_delta", content_block: { text: "Analyzing repo..." } }),
    JSON.stringify({
      status: "SUCCESS",
      response: JSON.stringify({
        status: "completed",
        summary: "done",
        changed_files: [],
        validation_commands: [],
        blockers: [],
        risks: []
      })
    })
  ];

  const runtime = fakespawnRuntime({ exitCode: 0, lines });
  await spawnProviderAsync({ store, runId, built, profile, plan, prepared, timeoutMs: 10_000 }, runtime);

  const run = store.getRun(runId);
  const states = run.events.map((e) => e.state);

  assert.ok(states.includes("queued"), `expected queued in ${states}`);
  assert.ok(states.includes("started"), `expected started in ${states}`);
  // queued must come before started
  assert.ok(
    states.indexOf("queued") < states.indexOf("started"),
    "queued must precede started"
  );
  // model_selected (if present) must come after started
  if (states.includes("model_selected")) {
    assert.ok(
      states.indexOf("started") < states.indexOf("model_selected"),
      "model_selected must come after started"
    );
  }
});

// ─── Test 3: progress redaction ───────────────────────────────────────────────

test("streaming: progress text is redacted of long base64/token values", async () => {
  const dir = tempDir();
  const store = new RunStore(path.join(dir, "runs.sqlite3"));
  const runId = store.createRun("PACE-354", { summary: "test" });

  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const profile = {
    provider: "antigravity",
    config: { timeoutSeconds: 10 },
    agent: "backend-engineer",
    model: "claude-sonnet-4-6",
    modelProfile: "medium",
    effort: "medium",
    mode: "accept-edits"
  };
  const built = {
    command: ["agy", "x"],
    redactedCommand: ["agy", "x"],
    cwd: dir,
    logFile: path.join(logDir, `${runId}-agy.log`),
    resultSchema: ""
  };
  const plan = { allowedPaths: [], maxChangedFiles: 30 };
  const prepared = { worktree: dir };

  // Emit a progress line containing a long base64-like secret.
  const secretToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9secretpart";
  const lines = [
    JSON.stringify({ type: "content_block_delta", content_block: { text: `Reading file with token ${secretToken}` } }),
    JSON.stringify({
      status: "SUCCESS",
      response: JSON.stringify({
        status: "completed", summary: "done", changed_files: [],
        validation_commands: [], blockers: [], risks: []
      })
    })
  ];

  const runtime = fakespawnRuntime({ exitCode: 0, lines });
  await spawnProviderAsync({ store, runId, built, profile, plan, prepared, timeoutMs: 10_000 }, runtime);

  const run = store.getRun(runId);
  const progressEvent = run.events.find((e) => e.state === "progress");
  assert.ok(progressEvent, "progress event should be emitted");
  // The long token must be redacted.
  assert.ok(
    !JSON.stringify(progressEvent.payload).includes(secretToken),
    "long token must be redacted from progress event"
  );
  assert.ok(
    JSON.stringify(progressEvent.payload).includes("[redacted]"),
    "redacted marker must appear"
  );

  // Bearer token in progress text must be redacted.
  const runBearer = store.createRun("PACE-354", { summary: "bearer test" });
  const builtB = { ...built, logFile: path.join(logDir, `${runBearer}-b.log`) };
  const bearerLines = [
    JSON.stringify({ type: "content_block_delta", content_block: { text: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMSJ9.abc123def456ghi789" } }),
    JSON.stringify({ status: "SUCCESS", response: JSON.stringify({ status: "completed", summary: "done", changed_files: [], validation_commands: [], blockers: [], risks: [] }) })
  ];
  const runtimeB = fakespawnRuntime({ exitCode: 0, lines: bearerLines });
  await spawnProviderAsync({ store, runId: runBearer, built: builtB, profile, plan, prepared, timeoutMs: 10_000 }, runtimeB);
  const runBearerResult = store.getRun(runBearer);
  const bearerProgress = runBearerResult.events.find((e) => e.state === "progress");
  assert.ok(bearerProgress, "Bearer progress event must be emitted");
  assert.ok(
    !JSON.stringify(bearerProgress.payload).includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
    "JWT header in Bearer header must be redacted"
  );
});

// ─── Test 4: command construction – no --effort for claude-sonnet-4-6 ─────────

test("command construction: --effort is stripped for claude-sonnet-4-6", () => {
  const dir = tempDir();
  const settings = baseSettings(dir);
  // Use a command template that includes --effort to simulate old-style configs.
  settings.data.executor.providers.antigravity.command = [
    "agy", "--agent", "{agent}",
    "--model", "{model}",
    "--effort", "{effort}",
    "--mode", "{mode}",
    "-p", "{prompt}"
  ];

  const issue = { labels: ["provider-antigravity"] };
  const plan = { persona: "backend-engineer", risk: "normal" };
  const profile = selectExecutionProfile(settings, issue, plan);

  assert.equal(profile.model, "claude-sonnet-4-6");

  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const built = buildExecutorCommand({
    settings,
    profile,
    prepared: { worktree: path.join(dir, "worktree") },
    prompt: "do work",
    runId: "run-effort-test"
  });

  assert.ok(!built.command.includes("--effort"), "--effort must not appear in command for claude-sonnet-4-6");
  assert.ok(!built.redactedCommand.includes("--effort"), "--effort must not appear in redacted command");
});

// ─── Test 5: command construction – --add-dir is injected for antigravity ─────

test("command construction: --add-dir worktree is injected before -p for antigravity", () => {
  const dir = tempDir();
  const settings = baseSettings(dir);

  const issue = { labels: ["provider-antigravity"] };
  const plan = { persona: "backend-engineer", risk: "normal" };
  const profile = selectExecutionProfile(settings, issue, plan);

  const worktreePath = path.join(dir, "worktree-abc");
  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const built = buildExecutorCommand({
    settings,
    profile,
    prepared: { worktree: worktreePath },
    prompt: "do work",
    runId: "run-adddir-test"
  });

  const addDirIndex = built.command.indexOf("--add-dir");
  assert.ok(addDirIndex >= 0, "--add-dir must be present in command");
  assert.equal(built.command[addDirIndex + 1], worktreePath, "--add-dir value must be the worktree path");

  // --add-dir must appear before -p
  const promptIndex = built.command.indexOf("-p");
  assert.ok(promptIndex > addDirIndex, "--add-dir must appear before -p");

  // Same check for redacted command
  const redactedAddDir = built.redactedCommand.indexOf("--add-dir");
  assert.ok(redactedAddDir >= 0, "--add-dir must be in redacted command");
});

// ─── Test 6: local-run path does not need Jira (runIssueLocal) ───────────────

test("local-run: runIssueLocal produces dry-run result without Jira credentials", async () => {
  const dir = tempDir();
  const settings = baseSettings(dir);
  settings.data.executor.providers.antigravity.timeoutSeconds = 10;

  const issuePacket = {
    key: "PACE-354",
    summary: "Runtime reconciliation",
    description: "## Acceptance Criteria\n- [ ] Passes",
    issueType: "Hikaye",
    status: "Yapılacaklar",
    labels: ["agent-ready", "provider-antigravity"]
  };

  // Dry run – must not require Jira, must not attempt to spawn.
  const result = runIssueLocal(settings, issuePacket, false);
  // runIssue returns synchronously for dry-run
  const resolved = result instanceof Promise ? await result : result;
  assert.equal(resolved.exitCode, 0);
  assert.equal(resolved.output.mode, "dry-run");
  assert.ok(resolved.output.runId, "must produce a runId");
});

// ─── Test 7: dashboard snapshot treats streaming states as active ─────────────

test("dashboard: queued/started/model_selected/progress are classified as active", () => {
  const dir = tempDir();
  const store = new RunStore(path.join(dir, "runs.sqlite3"));

  const runId = store.createRun("PACE-354", {
    summary: "Streaming run",
    persona: "startup-cto",
    taskAgent: "backend-engineer",
    skills: ["senior-backend"],
    risk: "normal",
    parallelSafe: true,
    allowedPaths: ["backend/**"],
    execution: {
      provider: "antigravity",
      model: "claude-sonnet-4-6",
      modelProfile: "medium"
    }
  });
  store.acquireLock("PACE-354", runId);
  store.transition(runId, "queued", { provider: "antigravity", model: "claude-sonnet-4-6" });
  store.transition(runId, "started", { provider: "antigravity", model: "claude-sonnet-4-6" });
  store.transition(runId, "model_selected", { provider: "antigravity", model: "claude-sonnet-4-6" });
  store.transition(runId, "progress", { seq: 1, text: "Analyzing code", provider: "antigravity" });

  const settings = {
    source: path.join(dir, "agent-scaffold.json"),
    projectKey: "PACE",
    data: { policy: { maxConcurrency: 2, providerConcurrency: { antigravity: 2 } } }
  };

  const snapshot = buildDashboardSnapshot(settings, { store, now: new Date().toISOString() });

  assert.equal(snapshot.runs.length, 1);
  const run = snapshot.runs[0];
  assert.equal(run.stateKind, "active", `progress state must be active, got: ${run.stateKind}`);
  assert.equal(run.taskAgent, "backend-engineer", "taskAgent must be set from plan");
  assert.equal(run.persona, "startup-cto", "persona must be the orchestration role");
  // provider and model must be visible (no secrets)
  assert.equal(run.provider, "antigravity");
  assert.equal(run.model, "claude-sonnet-4-6");
  // progressText must be populated from the latest progress event
  assert.ok(run.progressText, "progressText must be populated from progress event");
  assert.ok(run.progressText.includes("Analyzing"), "progressText must contain the progress text");
});

// ─── Test 8: lock prevents double-launch ──────────────────────────────────────

test("lock: second attempt to launch a locked issue is rejected", () => {
  const dir = tempDir();
  const store = new RunStore(path.join(dir, "runs.sqlite3"));
  const run1 = store.createRun("PACE-354", {});
  assert.equal(store.acquireLock("PACE-354", run1), true);
  const run2 = store.createRun("PACE-354", {});
  assert.equal(store.acquireLock("PACE-354", run2), false, "second lock must fail");
});

// ─── Test 9: timeout triggers failed state and releases the lock ──────────────

test("timeout: spawnProviderAsync transitions to failed and releases the lock", async () => {
  const dir = tempDir();
  const store = new RunStore(path.join(dir, "runs.sqlite3"));
  const runId = store.createRun("PACE-354", { summary: "test" });

  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const profile = {
    provider: "antigravity",
    config: { timeoutSeconds: 1 },
    agent: "backend-engineer",
    model: "claude-sonnet-4-6",
    modelProfile: "medium",
    effort: "medium",
    mode: "accept-edits"
  };
  const built = {
    command: ["agy", "x"],
    redactedCommand: ["agy", "x"],
    cwd: dir,
    logFile: path.join(logDir, `${runId}-agy.log`),
    resultSchema: ""
  };
  const plan = { allowedPaths: [], maxChangedFiles: 30 };
  const prepared = { worktree: dir };

  // Acquire the lock before spawning (as runIssue would do).
  store.acquireLock("PACE-354", runId);
  assert.equal(
    store.listLocks().some((l) => l.issue_key === "PACE-354"),
    true,
    "lock must be held before spawn"
  );

  // This process never emits close naturally – timeout will kill it.
  const hangingRuntime = {
    spawn(_cmd, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => { proc.emit("close", null); };
      return proc;
    }
  };

  // Use a very short timeout (50ms). Pass issueKey so the lock can be released.
  await spawnProviderAsync(
    { store, runId, built, profile, plan, prepared, issueKey: "PACE-354", timeoutMs: 50 },
    hangingRuntime
  );

  const run = store.getRun(runId);
  const states = run.events.map((e) => e.state);
  assert.ok(
    states.includes("failed"),
    `expected failed state after timeout; states: ${states.join(",")}`
  );

  // After timeout failure the lock must be released so a retry can claim it.
  assert.equal(
    store.listLocks().some((l) => l.issue_key === "PACE-354"),
    false,
    "lock must be released after timeout terminal failure"
  );
});

// ─── Test 10: antigravity command enforces stream-json even when config says json ─

test("command construction: stream-json is enforced for antigravity even when template says json", () => {
  const dir = tempDir();
  const settings = baseSettings(dir);

  // Simulate a legacy config that still uses --output-format json.
  settings.data.executor.providers.antigravity.command = [
    "agy",
    "--agent", "{agent}",
    "--model", "{model}",
    "--mode", "{mode}",
    "--output-format", "json",
    "--json-schema", "{resultSchema}",
    "--log-file", "{logFile}",
    "-p", "{prompt}"
  ];

  const issue = { labels: ["provider-antigravity"] };
  const plan = { persona: "backend-engineer", risk: "normal" };
  const profile = selectExecutionProfile(settings, issue, plan);

  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const built = buildExecutorCommand({
    settings,
    profile,
    prepared: { worktree: path.join(dir, "worktree") },
    prompt: "do work",
    runId: "run-streamjson-legacy"
  });

  const fmtIndex = built.command.indexOf("--output-format");
  assert.ok(fmtIndex >= 0, "--output-format must be present in command");
  assert.equal(
    built.command[fmtIndex + 1],
    "stream-json",
    "legacy json value must be replaced with stream-json"
  );

  // Also verify the new-style template (stream-json already present) is unchanged.
  settings.data.executor.providers.antigravity.command = [
    "agy",
    "--output-format", "stream-json",
    "-p", "{prompt}"
  ];
  const builtNew = buildExecutorCommand({
    settings,
    profile,
    prepared: { worktree: path.join(dir, "worktree") },
    prompt: "do work",
    runId: "run-streamjson-new"
  });
  const fmtIndexNew = builtNew.command.indexOf("--output-format");
  assert.ok(fmtIndexNew >= 0, "--output-format must be in new-style command");
  assert.equal(builtNew.command[fmtIndexNew + 1], "stream-json");

  // Verify a template with no --output-format flag gets one injected.
  settings.data.executor.providers.antigravity.command = [
    "agy",
    "-p", "{prompt}"
  ];
  const builtNoFlag = buildExecutorCommand({
    settings,
    profile,
    prepared: { worktree: path.join(dir, "worktree") },
    prompt: "do work",
    runId: "run-streamjson-noflag"
  });
  assert.ok(
    builtNoFlag.command.includes("--output-format"),
    "--output-format must be injected when absent from template"
  );
  const fmtIndexNo = builtNoFlag.command.indexOf("--output-format");
  assert.equal(builtNoFlag.command[fmtIndexNo + 1], "stream-json");
});

// ─── Test 11: spawn error releases the issue lock ─────────────────────────────

test("spawn error: lock is released when child emits an error event", async () => {
  const dir = tempDir();
  const store = new RunStore(path.join(dir, "runs.sqlite3"));
  const runId = store.createRun("PACE-354", { summary: "spawn error test" });

  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const profile = {
    provider: "antigravity",
    config: { timeoutSeconds: 10 },
    agent: "backend-engineer",
    model: "claude-sonnet-4-6",
    modelProfile: "medium",
    effort: "medium",
    mode: "accept-edits"
  };
  const built = {
    command: ["agy-nonexistent", "x"],
    redactedCommand: ["agy-nonexistent", "x"],
    cwd: dir,
    logFile: path.join(logDir, `${runId}-agy.log`),
    resultSchema: ""
  };
  const plan = { allowedPaths: [], maxChangedFiles: 30 };
  const prepared = { worktree: dir };

  // Acquire the lock before spawning.
  store.acquireLock("PACE-354", runId);
  assert.equal(
    store.listLocks().some((l) => l.issue_key === "PACE-354"),
    true,
    "lock must be held before spawn"
  );

  // Runtime that fires an error event immediately.
  const errorRuntime = {
    spawn(_cmd, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      setImmediate(() => proc.emit("error", new Error("ENOENT: not found")));
      return proc;
    }
  };

  await spawnProviderAsync(
    { store, runId, built, profile, plan, prepared, issueKey: "PACE-354", timeoutMs: 10_000 },
    errorRuntime
  );

  const run = store.getRun(runId);
  const states = run.events.map((e) => e.state);
  assert.ok(states.includes("failed"), `expected failed after spawn error; states: ${states.join(",")}`);

  // Lock must be released so a retry can acquire it.
  assert.equal(
    store.listLocks().some((l) => l.issue_key === "PACE-354"),
    false,
    "lock must be released after spawn error"
  );
});
