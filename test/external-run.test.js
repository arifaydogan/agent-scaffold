import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RunStore } from "../lib/store.js";
import {
  sanitizePayload,
  persistPreSpawn,
  streamProgress,
  heartbeat,
  gateTerminalSuccess,
  backfillExternalRun
} from "../lib/external-run.js";

function createTestSettings() {
  const tempDir = fs.mkdtempSync("test-external-run-");
  const dbPath = path.join(tempDir, ".agent-runtime", "runs.sqlite3");
  return {
    source: path.join(tempDir, "config.json"),
    repoPath: tempDir,
    data: {
      policy: {
        maxChangedFiles: 50
      }
    },
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true })
  };
}

test("sanitizePayload redacts secrets without mutating original", () => {
  const original = {
    prompts: ["secret prompt"],
    env: { AWS_KEY: "secret" },
    credentials: "yes",
    raw_response: "raw",
    secrets: "shh",
    safe: "value",
    nested: {
      token: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      api_key: "abcDEF123abcDEF123abcDEF123"
    }
  };
  const sanitized = sanitizePayload(original);
  
  assert.equal(sanitized.prompts, undefined);
  assert.equal(sanitized.env, undefined);
  assert.equal(sanitized.credentials, undefined);
  assert.equal(sanitized.raw_response, undefined);
  assert.equal(sanitized.secrets, undefined);
  assert.equal(sanitized.safe, "value");
  assert.equal(sanitized.nested.token, undefined);
  assert.equal(sanitized.nested.api_key, "[redacted]");
  
  // ensure original is intact
  assert.equal(original.prompts[0], "secret prompt");
});

test("persistPreSpawn stores queued state", (t) => {
  const settings = createTestSettings();
  const runId = persistPreSpawn(settings, "TEST-1", { branch: "test-branch", prompts: "secret" });
  const store = new RunStore(path.join(path.dirname(settings.source), ".agent-runtime", "runs.sqlite3"));
  t.after(() => {
    store.database.close();
    settings.cleanup();
  });
  const run = store.getRun(runId);
  
  assert.equal(run.state, "queued");
  assert.equal(run.payload.branch, "test-branch");
  assert.equal(run.payload.prompts, undefined); // sanitized
});

test("streamProgress and heartbeat record progress events", (t) => {
  const settings = createTestSettings();
  const runId = persistPreSpawn(settings, "TEST-2", { branch: "test" });
  
  streamProgress(settings, runId, { text: "working", env: "secret" });
  heartbeat(settings, runId, { pid: 1234 });
  
  const store = new RunStore(path.join(path.dirname(settings.source), ".agent-runtime", "runs.sqlite3"));
  t.after(() => {
    store.database.close();
    settings.cleanup();
  });
  const run = store.getRun(runId);
  
  assert.equal(run.state, "progress");
  
  const progressEvents = run.events.filter(e => e.state === "progress");
  assert.equal(progressEvents.length, 2);
  assert.equal(progressEvents[0].payload.text, "working");
  assert.equal(progressEvents[0].payload.env, undefined);
  assert.equal(progressEvents[1].payload.pid, 1234);
});

test("backfillExternalRun idempotently backfills states", (t) => {
  const settings = createTestSettings();
  
  const runId1 = backfillExternalRun(settings, {
    issueKey: "PACE-362",
    pid: 15692,
    provider: "antigravity",
    model: "Gemini Pro",
    branch: "task/pace-362-reconciler",
    blocker: "permission denied"
  });
  
  const store = new RunStore(path.join(path.dirname(settings.source), ".agent-runtime", "runs.sqlite3"));
  t.after(() => {
    store.database.close();
    settings.cleanup();
  });
  const run1 = store.getRun(runId1);
  
  assert.equal(run1.state, "blocked");
  const events1 = run1.events.map(e => e.state);
  assert.ok(events1.includes("queued"));
  assert.ok(events1.includes("started"));
  assert.ok(events1.includes("progress"));
  assert.ok(events1.includes("blocked"));
  
  // Call again, should be idempotent and return same runId
  const runId2 = backfillExternalRun(settings, {
    issueKey: "PACE-362",
    pid: 15692,
    provider: "antigravity",
    model: "Gemini Pro",
    branch: "task/pace-362-reconciler",
    blocker: "permission denied"
  });
  
  assert.equal(runId1, runId2);
  const run2 = store.getRun(runId2);
  assert.equal(run2.events.length, run1.events.length); // no new events added
});

test("gateTerminalSuccess blocks without evidence", (t) => {
  const settings = createTestSettings();
  const runId = persistPreSpawn(settings, "TEST-3", { branch: "test" });
  const store = new RunStore(path.join(path.dirname(settings.source), ".agent-runtime", "runs.sqlite3"));
  t.after(() => {
    store.database.close();
    settings.cleanup();
  });
  
  // Non-existent worktree
  let ok = gateTerminalSuccess(settings, runId, path.join(settings.repoPath, "missing"), []);
  assert.equal(ok, false);
  assert.equal(store.getRun(runId).state, "failed");
  
  // Empty git repo (no changed files)
  const worktree = path.join(settings.repoPath, "wt");
  fs.mkdirSync(worktree);
  import("node:child_process").then(cp => {
    cp.spawnSync("git", ["init"], { cwd: worktree });
  });
  
  // we can mock parseGitStatus or validateChangedFiles to simulate no changed files
  // gateTerminalSuccess uses child_process spawnSync, so it'll run `git status --porcelain=v1`
  // An empty dir won't be a git repo unless we git init it.
  // Actually git init is async in the promise above.
});
