import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDashboardSnapshot,
  buildDemoSnapshot,
  startDashboardServer
} from "../lib/dashboard.js";
import { RunStore } from "../lib/store.js";

function settings(directory) {
  return {
    source: path.join(directory, "agent-scaffold.json"),
    projectKey: "PACE",
    data: {
      policy: {
        maxConcurrency: 3,
        providerConcurrency: { antigravity: 2, codex: 1 }
      },
      supervisor: {
        staleAfterSeconds: 30
      }
    }
  };
}

test("dashboard snapshot exposes operational metadata without prompts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dashboard-"));
  const store = new RunStore(path.join(directory, "runs.sqlite3"));
  const runId = store.createRun("PACE-12", {
    summary: "Build camera grid",
    persona: "frontend-engineer",
    skills: ["component-design"],
    risk: "normal",
    parallelSafe: true,
    allowedPaths: ["frontend/**"],
    execution: {
      provider: "antigravity",
      model: "claude-sonnet-4-6",
      modelProfile: "medium"
    },
    description: "secret prompt content must not leave the store"
  });
  store.acquireLock("PACE-12", runId);
  store.transition(runId, "queued", {
    provider: "antigravity",
    model: "claude-sonnet-4-6"
  });

  const queuedSnapshot = buildDashboardSnapshot(settings(directory), {
    store,
    now: "2026-08-09T16:00:00.000Z"
  });
  assert.equal(queuedSnapshot.capacity.active, 0);
  assert.equal(queuedSnapshot.capacity.queued, 1);

  store.transition(runId, "executing", {
    provider: "antigravity",
    model: "claude-sonnet-4-6"
  });

  const snapshot = buildDashboardSnapshot(settings(directory), {
    store,
    now: "2026-08-09T16:00:00.000Z"
  });

  assert.equal(snapshot.totals.active, 1);
  assert.equal(snapshot.capacity.active, 1);
  assert.equal(snapshot.capacity.providers[0].active, 1);
  assert.equal(snapshot.runs[0].persona, "frontend-engineer");
  assert.deepEqual(snapshot.runs[0].skills, ["component-design"]);
  assert.equal(JSON.stringify(snapshot).includes("secret prompt content"), false);
});

test("demo snapshot contains visible active, review, and blocked states", () => {
  const snapshot = buildDemoSnapshot(settings("."), "2026-08-09T16:00:00.000Z");
  assert.equal(snapshot.mode, "demo");
  assert.ok(snapshot.totals.active > 0);
  assert.ok(snapshot.totals.review > 0);
  assert.ok(snapshot.totals.blocked > 0);
});

test("dashboard server is localhost-only and returns secure read-only responses", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dashboard-"));
  const store = new RunStore(path.join(directory, "runs.sqlite3"));
  const dashboard = await startDashboardServer(settings(directory), {
    port: 0,
    demo: true,
    store
  });
  try {
    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(await page.text(), /Agent Operations/);

    const snapshot = await fetch(`${dashboard.url}/api/snapshot`).then((response) =>
      response.json()
    );
    assert.equal(snapshot.mode, "demo");

    const mutation = await fetch(`${dashboard.url}/api/snapshot`, {
      method: "POST"
    });
    assert.equal(mutation.status, 405);
    await mutation.text();
  } finally {
    dashboard.server.closeAllConnections?.();
    await new Promise((resolve) => dashboard.server.close(resolve));
  }
});

test("dashboard exposes localhost-only provider connection lifecycle endpoints", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dashboard-providers-"));
  const store = new RunStore(path.join(directory, "runs.sqlite3"));
  const dashboardSettings = settings(directory);
  dashboardSettings.data.controlPlane = { providerConnectionMutationEnabled: true };
  const calls = [];
  const providerConnections = {
    async list() { return { mutationEnabled: true, secureStore: { supported: true }, connections: [{ id: "jira" }] }; },
    async test(id, body) { calls.push(["test", id, body]); return { ok: true, status: "connected" }; },
    async connect(id, body) { calls.push(["connect", id, body]); return { ok: true, status: "connected" }; },
    async select(id) { calls.push(["select", id]); return { ok: true, status: "selected" }; },
    async disconnect(id) { calls.push(["disconnect", id]); return { ok: true, removed: true }; },
    safeError(error) { return error.message; }
  };
  const dashboard = await startDashboardServer(dashboardSettings, {
    port: 0,
    demo: true,
    store,
    providerConnections
  });
  try {
    const list = await fetch(`${dashboard.url}/api/provider-connections`).then(response => response.json());
    assert.equal(list.connections[0].id, "jira");

    const tested = await fetch(`${dashboard.url}/api/provider-connections/jira/test`, { method: "POST" });
    assert.equal(tested.status, 200);
    await tested.json();

    const remoteTest = await fetch(`${dashboard.url}/api/provider-connections/ollama/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "http://10.0.0.5:11434", trustRemoteEndpoint: true })
    });
    assert.equal(remoteTest.status, 200);
    await remoteTest.json();

    const connected = await fetch(`${dashboard.url}/api/provider-connections/jira/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://example.atlassian.net", email: "agent@example.com", token: "secret-token" })
    });
    assert.equal(connected.status, 202);
    await connected.json();

    const selected = await fetch(`${dashboard.url}/api/provider-connections/ollama/select`, { method: "POST" });
    assert.equal(selected.status, 200);
    await selected.json();

    const disconnected = await fetch(`${dashboard.url}/api/provider-connections/jira`, { method: "DELETE" });
    assert.equal(disconnected.status, 200);
    await disconnected.json();
    assert.deepEqual(calls.map(call => call.slice(0, 2)), [
      ["test", "jira"], ["test", "ollama"], ["connect", "jira"], ["select", "ollama"], ["disconnect", "jira"]
    ]);
    assert.deepEqual(calls[1][2], { endpoint: "http://10.0.0.5:11434", trustRemoteEndpoint: true });
  } finally {
    dashboard.server.closeAllConnections?.();
    await new Promise(resolve => dashboard.server.close(resolve));
  }
});

test("dashboard snapshot exposes epic progress, integration queue, and token budget", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dashboard-epic-"));
  const store = new RunStore(path.join(directory, "runs.sqlite3"));
  store.upsertEpic({
    key: "PACE-124", summary: "Agent orchestration", branch: "epic/pace-124-agent-orchestration",
    baseBranch: "develop", modelBudget: 100
  });
  store.upsertEpicTask({
    epicKey: "PACE-124", issueKey: "PACE-359", summary: "Epic runtime",
    branch: "task/pace-359-epic-runtime", state: "integrated", budget: 100
  });
  const run = store.createRun("PACE-359", { summary: "Epic runtime" });
  store.transition(run, "verifying", { usage: { total_tokens: 40 } });
  const snapshot = buildDashboardSnapshot(settings(directory), { store });
  assert.equal(snapshot.epics.length, 1);
  assert.equal(snapshot.epics[0].completedLeaves, 1);
  assert.equal(snapshot.epics[0].ready, true);
  assert.deepEqual(snapshot.epics[0].modelBudget, { limit: 100, used: 40, remaining: 60 });
});
