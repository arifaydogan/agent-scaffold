import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { startDashboardServer } from "../lib/dashboard.js";
import { RunStore } from "../lib/store.js";
import { captureOperatorRequest } from "../lib/operator-inbox.js";

function fixture(controlPlane = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-control-"));
  const store = new RunStore(path.join(directory, "runs.sqlite3"));
  const settings = {
    source: path.join(directory, "agent-scaffold.json"),
    projectKey: "PACE",
    repoPath: directory,
    worktreeRoot: path.join(directory, "worktrees"),
    data: {
      project: { key: "PACE", repoPath: ".", baseRef: "epic/provider-neutral-control-plane" },
      policy: { maxConcurrency: 2, maxAttempts: 3, maxChangedFiles: 30 },
      supervisor: { staleAfterSeconds: 90 },
      controlPlane: {
        executionMutationEnabled: true,
        operatorInteractionMutationEnabled: true,
        ...controlPlane
      }
    }
  };
  return { directory, store, settings };
}

function plan(issueKey = "PACE-364") {
  return {
    issue: issueKey,
    summary: "Compact first-run help drawer",
    persona: "frontend-engineer",
    taskAgent: "frontend-engineer",
    skills: ["minimal-change"],
    risk: "normal",
    parallelSafe: true,
    allowedPaths: ["ui/**", "test/ui.test.js"],
    dependencies: [],
    baseRef: "epic/provider-neutral-control-plane",
    baseSha: "a".repeat(40),
    branch: "pace-364-compact-first-run-help-drawer",
    eligible: true,
    eligibilityReasons: [],
    execution: { provider: "codex", model: null, modelProfile: "medium" }
  };
}

async function jsonPost(url, body = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("dashboard plans, fingerprint-checks, and starts one work item without blocking the server", async () => {
  const { store, settings } = fixture();
  const starts = [];
  const dashboard = await startDashboardServer(settings, {
    port: 0,
    store,
    planHandler: async ({ issueKey }) => plan(issueKey),
    startHandler: async request => {
      starts.push(request);
      return { accepted: true, pid: 41234 };
    }
  });
  try {
    const plannedResponse = await jsonPost(`${dashboard.url}/api/control-plane/work-items/PACE-364/plan`);
    assert.equal(plannedResponse.status, 200);
    const planned = await plannedResponse.json();
    assert.equal(planned.plan.taskAgent, "frontend-engineer");
    assert.deepEqual(planned.plan.allowedPaths, ["ui/**", "test/ui.test.js"]);
    assert.equal(planned.plan.baseSha, "a".repeat(40));
    assert.equal(planned.plan.eligible, true);
    assert.ok(planned.plan.planFingerprint);
    assert.equal(planned.plan.compatibility.status, "compatible");
    assert.deepEqual(planned.plan.compatibility.items, []);

    const stale = await jsonPost(`${dashboard.url}/api/control-plane/work-items/PACE-364/start`, {
      planFingerprint: "stale-plan"
    });
    assert.equal(stale.status, 409);
    assert.equal(starts.length, 0);

    const startedResponse = await jsonPost(`${dashboard.url}/api/control-plane/work-items/PACE-364/start`, {
      planFingerprint: planned.plan.planFingerprint
    });
    assert.equal(startedResponse.status, 202);
    assert.equal((await startedResponse.json()).pid, 41234);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].planFingerprint, planned.plan.planFingerprint);
  } finally {
    dashboard.server.closeAllConnections?.();
    await new Promise(resolve => dashboard.server.close(resolve));
    store.database.close();
  }
});

test("dashboard returns a structured compatibility preview for an ineligible work item", async () => {
  const { store, settings } = fixture();
  const dashboard = await startDashboardServer(settings, {
    port: 0,
    store,
    planHandler: async ({ issueKey }) => ({
      ...plan(issueKey),
      eligible: false,
      requestedAllowedPaths: [".agents/**", "bin/**", "lib/**"],
      allowedPaths: [],
      eligibilityReasons: [
        "Missing required labels: agent-ready",
        "No authorized write scope for taskAgent 'backend-engineer'",
        "Git base ref does not exist: epic/pace-244"
      ]
    })
  });
  try {
    const response = await jsonPost(`${dashboard.url}/api/control-plane/work-items/PACE-257/plan`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.plan.compatibility.status, "needs_attention");
    assert.deepEqual(body.plan.compatibility.items.map(entry => entry.category), [
      "work_source",
      "scope",
      "source_control"
    ]);
    assert.equal(body.plan.compatibility.items.every(entry => entry.automatic === false), true);
  } finally {
    dashboard.server.closeAllConnections?.();
    await new Promise(resolve => dashboard.server.close(resolve));
    store.database.close();
  }
});

test("dashboard exposes durable operator inbox, answers once, resumes, and stops active runs", async () => {
  const { store, settings } = fixture();
  const request = captureOperatorRequest(store, {
    issueKey: "PACE-364",
    runId: "00000000-0000-4000-8000-000000000031",
    requestId: "00000000-0000-4000-8000-000000000032",
    result: { status: "blocked", blockers: ["Which title should be displayed?"] },
    planFingerprint: "fp-resume"
  });
  const resumes = [];
  const stops = [];
  const dashboard = await startDashboardServer(settings, {
    port: 0,
    store,
    operatorResponseHandler: async value => {
      resumes.push(value);
      return { accepted: true, pid: 45678 };
    },
    stopHandler: async value => {
      stops.push(value);
      return { accepted: true, runId: value.runId };
    }
  });
  try {
    const inbox = await fetch(`${dashboard.url}/api/control-plane/operator-requests`).then(response => response.json());
    assert.equal(inbox.requests.length, 1);
    assert.equal(inbox.requests[0].status, "open");

    const answeredResponse = await jsonPost(
      `${dashboard.url}/api/control-plane/operator-requests/${request.requestId}/respond`,
      { answer: "Use the Jira summary." }
    );
    assert.equal(answeredResponse.status, 202);
    assert.equal((await answeredResponse.json()).status, "resuming");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].request.answer, "Use the Jira summary.");

    const duplicate = await jsonPost(
      `${dashboard.url}/api/control-plane/operator-requests/${request.requestId}/respond`,
      { answer: "A second answer" }
    );
    assert.equal(duplicate.status, 409);

    const stopped = await jsonPost(
      `${dashboard.url}/api/control-plane/runs/00000000-0000-4000-8000-000000000031/stop`
    );
    assert.equal(stopped.status, 202);
    assert.equal(stops.length, 1);

    const snapshot = await fetch(`${dashboard.url}/api/snapshot`).then(response => response.json());
    assert.equal(snapshot.operatorInbox[0].status, "resuming");
    assert.equal(snapshot.capabilities.execution.startEnabled, false);
    assert.equal(snapshot.capabilities.execution.operatorResponseEnabled, true);
    assert.equal(snapshot.capabilities.execution.stopEnabled, true);
  } finally {
    dashboard.server.closeAllConnections?.();
    await new Promise(resolve => dashboard.server.close(resolve));
    store.database.close();
  }
});

test("dashboard execution mutations fail closed when local opt-in is disabled", async () => {
  const { store, settings } = fixture({ executionMutationEnabled: false, operatorInteractionMutationEnabled: false });
  const dashboard = await startDashboardServer(settings, {
    port: 0,
    store,
    planHandler: async () => plan(),
    startHandler: async () => ({ accepted: true })
  });
  try {
    const planned = await jsonPost(`${dashboard.url}/api/control-plane/work-items/PACE-364/plan`);
    assert.equal(planned.status, 403);
    const started = await jsonPost(`${dashboard.url}/api/control-plane/work-items/PACE-364/start`, { planFingerprint: "fp" });
    assert.equal(started.status, 403);
  } finally {
    dashboard.server.closeAllConnections?.();
    await new Promise(resolve => dashboard.server.close(resolve));
    store.database.close();
  }
});
