import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RunStore } from "../lib/store.js";
import { requestExternalRetry } from "../lib/external-run.js";
import { buildDashboardSnapshot, startDashboardServer } from "../lib/dashboard.js";

function makeSettings(directory) {
  return {
    source: path.join(directory, "agent-scaffold.json"),
    projectKey: "PACE",
    data: {
      policy: {
        maxConcurrency: 2,
        maxAttempts: 3,
        providerConcurrency: { antigravity: 2 }
      },
      supervisor: { staleAfterSeconds: 30 }
    }
  };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pace-control-plane-"));
  const store = new RunStore(path.join(directory, "runs.sqlite3"));
  t.after(() => {
    store.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, settings: makeSettings(directory) };
}

test("retry request copies only the persisted safe plan and is idempotent", (t) => {
  const { store, settings } = fixture(t);
  const originalRunId = store.createRun("PACE-9", {
    summary: "Retry task",
    epicKey: "PACE-124",
    role: "worker",
    attempt: 1,
    branch: "task/pace-9-retry",
    worktree: "C:/safe/worktree",
    allowedPaths: ["ui/**"],
    execution: { provider: "antigravity", model: "gemini-pro" },
    prompt: "must not be copied"
  });
  store.transition(originalRunId, "blocked", { reasons: ["permission resolved"] });

  const first = requestExternalRetry(settings, {
    runId: originalRunId,
    issueKey: "PACE-9"
  }, { store });
  const retry = store.getRun(first.runId);
  assert.equal(retry.state, "retry_requested");
  assert.equal(retry.payload.retryOfRunId, originalRunId);
  assert.equal(retry.payload.attempt, 2);
  assert.equal(retry.payload.execution.provider, "antigravity");
  assert.equal(retry.payload.prompt, undefined);

  const second = requestExternalRetry(settings, {
    runId: originalRunId,
    issueKey: "PACE-9"
  }, { store });
  assert.equal(second.runId, first.runId);
  assert.equal(second.duplicate, true);
});

test("dashboard preserves the latest provider usage after terminal events", (t) => {
  const { store, settings } = fixture(t);
  const runId = store.createRun("PACE-10", { summary: "Usage task" });
  store.transition(runId, "progress", {
    usage: { input_tokens: 100, output_tokens: 25, cached_tokens: 500 }
  });
  store.transition(runId, "blocked", { reasons: ["test blocker"] });

  const snapshot = buildDashboardSnapshot(settings, { store });
  assert.equal(snapshot.runs[0].tokens, 125);
  assert.equal(snapshot.runs[0].usageAvailable, true);
});

test("dashboard treats null provider usage as unavailable", (t) => {
  const { store, settings } = fixture(t);
  const runId = store.createRun("PACE-11", { summary: "Null usage task" });
  store.transition(runId, "progress", { usage: null });

  const snapshot = buildDashboardSnapshot(settings, { store });
  assert.equal(snapshot.runs[0].tokens, 0);
  assert.equal(snapshot.runs[0].usageAvailable, false);
});

test("retry endpoint accepts only constrained localhost task identity", async (t) => {
  const { store, settings } = fixture(t);
  const calls = [];
  const dashboard = await startDashboardServer(settings, {
    port: 0,
    store,
    retryHandler: async (request) => {
      calls.push(request);
      return { runId: "queued-run", state: "retry_requested" };
    }
  });
  t.after(() => {
    dashboard.server.closeAllConnections?.();
    return new Promise((resolve) => dashboard.server.close(resolve));
  });

  const snapshot = await fetch(`${dashboard.url}/api/snapshot`).then((response) => response.json());
  assert.equal(snapshot.capabilities.retryHandler, true);

  const request = { runId: randomUUID(), issueKey: "PACE-11" };
  const accepted = await fetch(`${dashboard.url}/api/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(calls, [request]);

  const rejected = await fetch(`${dashboard.url}/api/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, provider: "arbitrary" })
  });
  assert.equal(rejected.status, 409);
  assert.equal(calls.length, 1);
});
