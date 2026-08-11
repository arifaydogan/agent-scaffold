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
  } finally {
    await new Promise((resolve) => dashboard.server.close(resolve));
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
