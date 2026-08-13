import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../lib/store.js";
import {
  claimRetryRequest,
  finishRetryRequest,
  recordReviewerOutcome,
  tick
} from "../lib/reconciler.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const NOW = Date.parse("2026-08-11T12:00:00.000Z");

function createTestStore() {
  const dbPath = path.join(os.tmpdir(), `reconciler-test-${randomUUID()}.sqlite3`);
  return new RunStore(dbPath);
}

function settings(overrides = {}) {
  return {
    data: {
      policy: {
        maxConcurrency: 2,
        maxRetryAttempts: 3,
        gitIntegrationEnabled: true,
        externalWritesEnabled: true,
        autonomyEnabled: true,
        providerConcurrency: { codex: 1 },
        ...overrides.policy
      },
      supervisor: {
        staleAfterSeconds: 90,
        ...overrides.supervisor
      }
    }
  };
}

function canonicalPlan(overrides = {}) {
  return {
    summary: "Recover worker",
    epicKey: "PACE-124",
    persona: "startup-cto",
    taskAgent: "devops-engineer",
    skills: ["bounded-autonomy", "multi-agent-reliability"],
    execution: { provider: "codex", agent: "devops-engineer", model: "gpt-5" },
    risk: "normal",
    parallelSafe: true,
    branch: "task/pace-362-recover-worker",
    worktree: "C:/worktrees/task-pace-362-recover-worker",
    allowedPaths: ["lib/**"],
    ...overrides
  };
}

function retryPayload(parentRunId, plan, overrides = {}) {
  return {
    ...plan,
    role: "worker",
    retryOfRunId: parentRunId,
    parentRunId,
    attempt: 1,
    blockerResolution: "User confirmed blocker resolved from control plane",
    ...overrides
  };
}

test("reconciler restart is idempotent with no work", () => {
  const store = createTestStore();
  const result1 = tick(settings(), store, { now: NOW });
  const result2 = tick(settings(), store, { now: NOW });
  assert.deepEqual(result1, result2);
});

test("stale queued lease is recovered without trusting a live or reused PID", () => {
  const store = createTestStore();
  const runId = store.createRun("PACE-1", canonicalPlan());
  store.transition(runId, "queued", {
    pid: process.pid,
    provider: "codex",
    workerLeaseId: "lease-old",
    workerLeaseExpiresAt: "2026-08-11T11:55:00.000Z"
  });
  store.acquireLock("PACE-1", runId);

  const result = tick(settings(), store, { now: NOW });

  assert.equal(result.workers.updated, 1);
  assert.equal(store.getRun(runId).state, "failed-retryable");
  assert.equal(store.listLocks().length, 0);
  assert.match(store.getRun(runId).events.at(-1).payload.reason, /lease expired/i);
});

test("fresh queued lease is not reclaimed", () => {
  const store = createTestStore();
  const runId = store.createRun("PACE-1", canonicalPlan());
  store.transition(runId, "queued", {
    provider: "codex",
    workerLeaseId: "lease-fresh",
    workerLeaseExpiresAt: "2026-08-11T12:01:00.000Z"
  });
  store.acquireLock("PACE-1", runId);

  const result = tick(settings(), store, { now: NOW });

  assert.equal(result.workers.updated, 0);
  assert.equal(store.getRun(runId).state, "queued");
  assert.equal(store.listLocks().length, 1);
});

test("verifying revision queues exactly one review and never self-accepts", async () => {
  const store = createTestStore();
  const runId = store.createRun("PACE-2", canonicalPlan());
  store.transition(runId, "verifying", { commit: SHA_A });

  const first = tick(settings(), store, { now: NOW });
  assert.equal(first.reviewers.reviewsRequested, 1);
  assert.equal(first.reviewers.reviewsAccepted, 0);
  assert.equal(store.getRun(runId).state, "transitioning-review");
  assert.equal(store.getRun(runId).events.at(-1).payload.implementationSha, SHA_A);

  const workSource = { writeEnabled: true, transition: async () => {} };
  const promises = [];
  tick(settings(), store, { now: NOW, execute: true, workSource, promises });
  await Promise.all(promises);
  assert.equal(store.getRun(runId).state, "review-queued");

  const second = tick(settings(), store, { now: NOW });
  assert.equal(second.reviewers.reviewsRequested, 0);
  assert.equal(second.reviewers.reviewsAccepted, 0);
  assert.equal(store.getRun(runId).state, "review-queued");
});

test("review outcome must independently persist matching SHA, reviewer, and evidence", async () => {
  const store = createTestStore();
  const runId = store.createRun("PACE-2", canonicalPlan());
  store.transition(runId, "verifying", { commit: SHA_A });
  tick(settings(), store, { now: NOW });

  const workSource = { writeEnabled: true, transition: async () => {} };
  const promises = [];
  tick(settings(), store, { now: NOW, execute: true, workSource, promises });
  await Promise.all(promises);

  const mismatch = recordReviewerOutcome(store, {
    runId,
    implementationSha: SHA_B,
    reviewerId: "review-agent-1",
    verdict: "clean",
    evidence: [{ id: "C1", severity: "info", category: "test", file: null, line: null, problem: "npm run check: exit 0", expected: null, verification: null }]
  }, { now: NOW });
  assert.equal(mismatch.recorded, false);
  assert.equal(store.getRun(runId).state, "review-queued");

  const accepted = recordReviewerOutcome(store, {
    runId,
    implementationSha: SHA_A,
    reviewerId: "review-agent-1",
    verdict: "clean",
    evidence: [{ id: "C1", severity: "info", category: "test", file: null, line: null, problem: "npm run check: exit 0", expected: null, verification: null }]
  }, { now: NOW });
  assert.equal(accepted.recorded, true);
  assert.equal(store.getRun(runId).state, "reviewed-clean");
  assert.equal(store.getRun(runId).events.at(-1).payload.reviewOutcome.implementationSha, SHA_A);
});

test("review changes request becomes retryable and releases the issue lock", async () => {
  const store = createTestStore();
  const runId = store.createRun("PACE-3", canonicalPlan());
  store.transition(runId, "verifying", { commit: SHA_A });
  store.acquireLock("PACE-3", runId);
  tick(settings(), store, { now: NOW });

  const workSource = { writeEnabled: true, transition: async () => {}, addComment: async () => {} };
  const promises = [];
  tick(settings(), store, { now: NOW, execute: true, workSource, promises });
  await Promise.all(promises);

  recordReviewerOutcome(store, {
    runId,
    implementationSha: SHA_A,
    reviewerId: "review-agent-1",
    verdict: "changes-requested",
    evidence: [{ id: "P1", severity: "error", category: "test", file: null, line: null, problem: "Finding P1", expected: null, verification: null }]
  }, { now: NOW });

  const result = tick(settings(), store, { now: NOW });

  assert.equal(result.reviewers.fixAttemptsRequested, 1);
  assert.equal(store.getRun(runId).state, "transitioning-rework");
  assert.equal(store.listLocks().length, 0);
});

test("integration remains queued without accepted review and real adapter evidence", async () => {
  const store = createTestStore();
  store.upsertEpic({
    key: "EPIC-1",
    summary: "Test Epic",
    branch: "epic/epic-1-test",
    baseBranch: "develop"
  });
  store.upsertEpicTask({
    epicKey: "EPIC-1",
    issueKey: "TASK-1",
    summary: "Task 1",
    branch: "task/task-1"
  });
  store.queueEpicIntegration({ epicKey: "EPIC-1", issueKey: "TASK-1", leafBranch: "task/task-1" });

  let result = tick(settings(), store, { now: NOW });
  assert.equal(result.integrations.integrationsCompleted, 0);
  assert.match(result.integrations.blocked[0].reason, /reviewed SHA/i);
  assert.equal(store.getEpic("EPIC-1").integrations[0].state, "queued");

  const reviewRun = store.createRun("TASK-1", canonicalPlan());
  store.transition(reviewRun, "verifying", { commit: SHA_A });
  tick(settings(), store, { now: NOW });
  const workSource = { writeEnabled: true, transition: async () => {} };
  const promises = [];
  tick(settings(), store, { now: NOW, execute: true, workSource, promises });
  await Promise.all(promises);

  recordReviewerOutcome(store, {
    runId: reviewRun,
    implementationSha: SHA_A,
    reviewerId: "review-agent-1",
    verdict: "clean",
    evidence: [{ id: "C1", severity: "info", category: "test", file: null, line: null, problem: "npm run check: exit 0", expected: null, verification: null }]
  }, { now: NOW });

  result = tick(settings(), store, { now: NOW });
  assert.equal(result.integrations.integrationsCompleted, 0);
  assert.match(result.integrations.blocked[0].reason, /adapter/i);
  assert.equal(store.getEpic("EPIC-1").integrations[0].state, "queued");
});

test("accepted review is claimed once and integrated only with matching adapter evidence", async () => {
  const store = createTestStore();
  store.upsertEpic({ key: "EPIC-2", summary: "Test Epic", branch: "epic/epic-2", baseBranch: "develop" });
  store.upsertEpicTask({
    epicKey: "EPIC-2",
    issueKey: "TASK-2",
    summary: "Task 2",
    branch: "task/task-2"
  });
  store.queueEpicIntegration({ epicKey: "EPIC-2", issueKey: "TASK-2", leafBranch: "task/task-2" });
  const reviewRun = store.createRun("TASK-2", canonicalPlan());
  store.transition(reviewRun, "verifying", { commit: SHA_A });
  tick(settings(), store, { now: NOW });
  const workSource = { writeEnabled: true, transition: async () => {} };
  const promises = [];
  tick(settings(), store, { now: NOW, execute: true, workSource, promises });
  await Promise.all(promises);

  recordReviewerOutcome(store, {
    runId: reviewRun,
    implementationSha: SHA_A,
    reviewerId: "review-agent-2",
    verdict: "clean",
    evidence: [{ id: "C1", severity: "info", category: "test", file: null, line: null, problem: "npm run check: exit 0", expected: null, verification: null }]
  }, { now: NOW });

  let calls = 0;
  const result = tick(settings(), store, {
    now: NOW,
    integrationAdapter: (request) => {
      calls += 1;
      assert.equal(request.reviewedSha, SHA_A);
      assert.equal(request.sourceBranch, "task/task-2");
      assert.equal(request.targetBranch, "epic/epic-2");
      return { completed: true, reviewedSha: SHA_A, integratedSha: SHA_B };
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.integrations.integrationsCompleted, 1);
  assert.equal(store.getEpic("EPIC-2").integrations[0].state, "integrated");
  assert.equal(store.getEpic("EPIC-2").integrations[0].commit, SHA_B);
  assert.equal(store.getRun(reviewRun).state, "reviewed-clean");
  tick(settings(), store, { now: NOW, integrationAdapter: () => { throw new Error("duplicate"); } });
});


test("active provider cooldown is derived from persisted evidence", () => {
  const store = createTestStore();
  const runId = store.createRun("PACE-4", canonicalPlan());
  store.transition(runId, "failed-retryable", {
    provider: "codex",
    cooldownUntil: "2026-08-11T12:05:00.000Z"
  });

  const result = tick(settings(), store, { now: NOW });

  assert.equal(result.cooldowns.codex, "2026-08-11T12:05:00.000Z");
});

test("canonical retry request queues without consuming capacity and claims exactly once", () => {
  const store = createTestStore();
  const plan = canonicalPlan();
  const parentRunId = store.createRun("PACE-5", plan);
  store.transition(parentRunId, "failed-retryable", { reason: "provider failed" });
  const retryRunId = store.createRun("PACE-5", retryPayload(parentRunId, plan));
  store.transition(retryRunId, "retry_requested");

  const first = tick(settings(), store, { now: NOW });
  assert.equal(first.retries.queued, 1);
  assert.equal(first.retries.ready.length, 1);
  assert.equal(first.workers.active, 0, "queued retry must not consume a worker slot");
  assert.equal(store.getRun(retryRunId).state, "retry-ready");

  const second = tick(settings(), store, { now: NOW });
  assert.equal(second.retries.queued, 0);
  assert.equal(second.retries.ready.length, 1);
  assert.equal(claimRetryRequest(store, retryRunId, { now: NOW }), true);
  assert.equal(claimRetryRequest(store, retryRunId, { now: NOW }), false);
  assert.equal(finishRetryRequest(store, retryRunId, { exitCode: 0, runId: "child-1" }, { now: NOW }).recorded, true);
  assert.equal(store.getRun(retryRunId).state, "retry-dispatched");
});

test("unsafe retry payload is durably blocked", () => {
  const store = createTestStore();
  const plan = canonicalPlan();
  const parentRunId = store.createRun("PACE-6", plan);
  store.transition(parentRunId, "failed-retryable", { reason: "provider failed" });
  const retryRunId = store.createRun("PACE-6", {
    ...retryPayload(parentRunId, plan),
    command: ["arbitrary", "command"]
  });
  store.transition(retryRunId, "retry_requested");

  const result = tick(settings(), store, { now: NOW });

  assert.equal(result.retries.blocked.length, 1);
  assert.equal(store.getRun(retryRunId).state, "retry-blocked");
  assert.match(store.getRun(retryRunId).events.at(-1).payload.reason, /unsafe fields/i);
});

test("retry stays queued and consumes no capacity while provider is cooling down", () => {
  const store = createTestStore();
  const plan = canonicalPlan();
  const parentRunId = store.createRun("PACE-7", plan);
  store.transition(parentRunId, "failed-retryable", {
    provider: "codex",
    cooldownUntil: "2026-08-11T12:05:00.000Z"
  });
  const retryRunId = store.createRun("PACE-7", retryPayload(parentRunId, plan));
  store.transition(retryRunId, "retry_requested");

  const result = tick(settings(), store, { now: NOW });

  assert.equal(result.retries.ready.length, 0);
  assert.equal(result.retries.deferred.length, 1);
  assert.match(result.retries.deferred[0].reason, /cooling down/i);
  assert.equal(result.workers.active, 0);
  assert.equal(store.getRun(retryRunId).state, "retry_requested");
});

test("safeWorkSourceMutate returns explicit performed flag and reasons", async () => {
  const { safeWorkSourceMutate } = await import("../lib/reconciler.js");

  // 1. provider.writeEnabled === false
  const ws1 = { writeEnabled: false, transition: async () => {} };
  const res1 = await safeWorkSourceMutate(ws1, settings({ policy: { externalWritesEnabled: true, autonomyEnabled: true } }), "transition", "P-1", "review");
  assert.deepEqual(res1, { performed: false, reason: "provider-write-disabled" });

  // 2. policy.externalWritesEnabled === false
  const ws2 = { writeEnabled: true, transition: async () => {} };
  const res2 = await safeWorkSourceMutate(ws2, settings({ policy: { externalWritesEnabled: false, autonomyEnabled: true } }), "transition", "P-1", "review");
  assert.deepEqual(res2, { performed: false, reason: "external-writes-disabled" });

  // 3. policy.autonomyEnabled === false
  const ws3 = { writeEnabled: true, transition: async () => {} };
  const res3 = await safeWorkSourceMutate(ws3, settings({ policy: { externalWritesEnabled: true, autonomyEnabled: false } }), "transition", "P-1", "review");
  assert.deepEqual(res3, { performed: false, reason: "autonomy-disabled" });

  // 4. All permitted -> performed: true
  let calledWith = null;
  const ws4 = { writeEnabled: true, transition: async (k, s) => { calledWith = [k, s]; return "ok"; } };
  const res4 = await safeWorkSourceMutate(ws4, settings({ policy: { externalWritesEnabled: true, autonomyEnabled: true } }), "transition", "P-1", "review");
  assert.equal(res4.performed, true);
  assert.equal(res4.result, "ok");
  assert.deepEqual(calledWith, ["P-1", "review"]);
});

test("write-disabled operation does not advance transitioning-review or release lock", async () => {
  const store = createTestStore();
  const plan = canonicalPlan();
  const runId = store.createRun("PACE-8", plan);
  store.transition(runId, "transitioning-review", { commit: SHA_A });
  store.acquireLock("PACE-8", runId);

  const disabledWorkSource = {
    writeEnabled: false,
    transition: async () => {}
  };

  const promises = [];
  tick(settings({ policy: { externalWritesEnabled: false } }), store, {
    execute: true,
    workSource: disabledWorkSource,
    promises,
    now: NOW
  });
  await Promise.allSettled(promises);

  // Run remains in transitioning-review and lock is NOT released
  assert.equal(store.getRun(runId).state, "transitioning-review");
  assert.equal(store.listLocks().find(l => l.issue_key === "PACE-8")?.run_id, runId);
});

