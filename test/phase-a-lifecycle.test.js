import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../lib/store.js";
import { dispatchOnce } from "../lib/dispatcher.js";
import { WorkSourceProvider } from "../lib/work-source.js";
import { tick } from "../lib/reconciler.js";

class MockWorkSourceProvider extends WorkSourceProvider {
  constructor(initialIssues) {
    super();
    this.issues = new Map(initialIssues.map(i => [i.key, i]));
    this.mutations = [];
    this.writeEnabled = true;
  }
  async poll(options) {
    return Array.from(this.issues.values())
      .filter(i => {
         if (options.canonicalStates && options.canonicalStates.length > 0) {
           return options.canonicalStates.includes(i.canonicalState);
         }
         return true;
      });
  }
  async addComment(id, comment) {
    this.mutations.push({ type: "comment", id, comment });
  }
  async transition(id, canonicalState, metadata) {
    this.mutations.push({ type: "transition", id, canonicalState });
    const issue = this.issues.get(id);
    if (issue) {
      issue.canonicalState = canonicalState;
    }
  }
  async claim(id, metadata) {}
  async releaseClaim(id, metadata) {}
  async addComment(id, comment) {
    this.mutations.push({ type: "comment", id, comment });
  }
}

function createTestStore() {
  const dbPath = path.join(os.tmpdir(), `phase-a-${randomUUID()}.sqlite3`);
  return new RunStore(dbPath);
}

function createSettings(overrides = {}) {
  return {
    source: "C:/test/config.json",
    projectKey: "PACE",
    repoPath: "C:/test/repo",
    worktreeRoot: "C:/worktrees",
    data: {
      supervisor: { staleAfterSeconds: 90 },
      policy: {
        allowedProjects: ["PACE"],
        humanOnlyStatuses: ["Done"],
        maxConcurrency: 10,
        providerConcurrency: { codex: 2, antigravity: 2 },
        requiredLabels: ["agent-ready"],
        externalWritesEnabled: true,
        gitIntegrationEnabled: false,
        autonomyEnabled: true,
        review: {
          provider: "antigravity",
          modelProfile: "claude-review",
          maxReworkAttempts: 3
        },
        pathScopes: { "backend-engineer": [] }
      },
      workSource: { defaultProvider: "mock", providers: { mock: { type: "mock" } } },
      orchestrator: { defaultProvider: "builtin", providers: { builtin: { type: "builtin" } } },
      executor: {
        defaultProvider: "codex",
        providers: {
          codex: { command: ["codex"] },
          antigravity: { command: ["agy"] }
        }
      },
      ...overrides
    }
  };
}

test("Phase A Lifecycle: ready -> implementation -> review -> clean -> human_approval", async () => {
  const store = createTestStore();
  const settings = createSettings();
  const workSource = new MockWorkSourceProvider([
    {
      key: "PACE-1",
      summary: "Implement login",
      description: "Acceptance criteria: done",
      canonicalState: "ready",
      labels: ["agent-ready"],
      issueType: "Task"
    }
  ]);
  
  // Custom runIssueImpl to mock the builder execution
  async function mockRunIssueImpl(s, issue, execute) {
    const { issuePlan } = await import("../lib/runtime.js");
    const plan = issuePlan(s, issue);
    const runId = store.createRun(plan.issue, plan);
    store.transition(runId, "queued", { provider: plan.execution.provider });
    store.transition(runId, "verifying", {
      implementationSha: "abcdef1234567890abcdef1234567890abcdef12",
      commit: "abcdef1234567890abcdef1234567890abcdef12"
    });
    return { exitCode: 0, output: { runId } };
  }

  // 1. Dispatcher picks up 'ready' and dispatches builder
  const { issuePlan } = await import("../lib/runtime.js");
  console.log("Issue Plan:", JSON.stringify(issuePlan(settings, workSource.issues.get("PACE-1")), null, 2));

  const res1 = await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: mockRunIssueImpl });
  console.log("Dispatch result:", JSON.stringify(res1, null, 2));
  
  const { tick } = await import("../lib/reconciler.js");
  tick(settings, store, { execute: true, workSource });
  
  let runs = store.listRunsDetailed(10);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, "review-queued");
  assert.equal(workSource.issues.get("PACE-1").canonicalState, "ready"); // work source still ready

  // 2. Simulate Reviewer returning "clean" with structured evidence
  const { recordReviewerOutcome } = await import("../lib/reconciler.js");
  recordReviewerOutcome(store, {
    runId: runs[0].id,
    implementationSha: "abcdef1234567890abcdef1234567890abcdef12",
    reviewerId: "claude-123",
    verdict: "clean",
    evidence: [{ id: "C1", severity: "info", category: "security", problem: "All good" }]
  });

  runs = store.listRunsDetailed(10);
  assert.equal(runs[0].state, "reviewed-clean");

  // 3. Reconciler loop processes the reviewed-clean state
  let promises = [];
  tick(settings, store, { execute: true, workSource, promises });
  console.log("Tick 1 promises pushed:", promises.length);
  await Promise.allSettled(promises);
  promises = [];
  tick(settings, store, { execute: true, workSource, promises });
  console.log("Tick 2 promises pushed:", promises.length);
  await Promise.allSettled(promises);

  runs = store.listRunsDetailed(10);
  assert.equal(runs[0].state, "completed");

  // 4. Verify external work source mutated to human_approval
  assert.equal(workSource.issues.get("PACE-1").canonicalState, "human_approval");
  const transitionMutations = workSource.mutations.filter(m => m.type === "transition");
  assert.equal(transitionMutations.length, 1);
  assert.equal(transitionMutations[0].canonicalState, "human_approval");
  
  // Prove structured findings survived persistence losslessly
  const outcome = runs[0].latest_payload.reviewOutcome;
  assert.equal(outcome.evidence[0].problem, "All good");
  assert.equal(outcome.evidence[0].category, "security");
});

test("Phase A Lifecycle: rework exhaustion with maxReworkAttempts = 3", async () => {
  const store = createTestStore();
  const settings = createSettings();
  const workSource = new MockWorkSourceProvider([
    {
      key: "PACE-2",
      summary: "Implement buggy",
      description: "Acceptance criteria: done",
      canonicalState: "ready",
      labels: ["agent-ready"],
      issueType: "Task"
    }
  ]);

  let executionCount = 0;
  async function mockRunIssueImpl(s, issue, execute) {
    executionCount++;
    const { issuePlan } = await import("../lib/runtime.js");
    let plan = issuePlan(s, issue);
    
    if (issue.canonicalState === "rework") {
      const runs = store.listRunsDetailed(100);
      const retryableRun = runs.find(r => r.issue_key === issue.key && r.state === "failed-retryable" && r.latest_payload?.reviewOutcome);
      if (retryableRun) {
        plan.attempt = retryableRun.latest_payload?.attempt || 0;
        plan.previousOutcome = retryableRun.latest_payload.reviewOutcome;
      }
    }
    
    const runId = store.createRun(plan.issue, plan);
    store.transition(runId, "queued", { provider: plan.execution?.provider || "codex" });
    store.transition(runId, "verifying", {
      implementationSha: "deadbeef" + "0".repeat(32)
    });
    return { exitCode: 0, output: { runId } };
  }

  const { recordReviewerOutcome } = await import("../lib/reconciler.js");
  const { tick } = await import("../lib/reconciler.js");

  // Base attempt (attempt 0)
  await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: mockRunIssueImpl });
  let basePromises = [];
  tick(settings, store, { execute: true, workSource, promises: basePromises });
  await Promise.allSettled(basePromises);
  
  assert.equal(executionCount, 1);
  let runs = store.listRunsDetailed(10);
  assert.equal(runs[0].state, "review-queued");

  // Re-run review loop maxReworkAttempts times
  for (let i = 1; i <= 3; i++) {
    runs = store.listRunsDetailed(20);
    console.log(`DUMP RUNS at i=${i}:`, runs.map(r => ({ id: r.id, state: r.state })));
    const activeRun = runs.find(r => r.state === "review-queued");
    assert(activeRun, `No review-queued run found for attempt ${i}`);
    
    // Review fails
    recordReviewerOutcome(store, {
      runId: activeRun.id,
      implementationSha: "deadbeef" + "0".repeat(32),
      reviewerId: "claude-bad",
      verdict: "changes-requested",
      evidence: [{ id: "F" + i, severity: "high", problem: "Fix it" }]
    });

    // Reconciler should transition to transitioning-rework -> failed-retryable -> rework mutation
    let p = [];
    tick(settings, store, { execute: true, workSource, promises: p });
    console.log("Test 2 Tick 1 promises:", p.length);
    await Promise.allSettled(p);
    console.log("State after first tick:", store.listRunsDetailed(10).find(r => r.id === activeRun.id)?.state);
    p = [];
    tick(settings, store, { execute: true, workSource, promises: p });
    console.log("Test 2 Tick 2 promises:", p.length);
    await Promise.allSettled(p);
    console.log("State after second tick:", store.listRunsDetailed(10).find(r => r.id === activeRun.id)?.state);
    
    // Check mutation
    const transitionMutations = workSource.mutations.filter(m => m.type === "transition");
    assert.equal(transitionMutations[transitionMutations.length - 1].canonicalState, "rework");

    // The dispatcher immediately plans a retry and launches mockRunIssueImpl again
    await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: mockRunIssueImpl });
    tick(settings, store, { execute: true, workSource });
    
    // We expect execution count to match attempt + 1
    assert.equal(executionCount, i + 1);
  }

  // After 3 reworks (executionCount = 4), we are at review-queued for the 3rd rework attempt
  runs = store.listRunsDetailed(20);
  const activeRun = runs.find(r => r.state === "review-queued");
  
  // This is the 4th execution (attempt=3). It fails review:
  recordReviewerOutcome(store, {
    runId: activeRun.id,
    implementationSha: "deadbeef" + "0".repeat(32),
    reviewerId: "claude-bad",
    verdict: "changes-requested",
    evidence: [{ id: "F-limit", severity: "high", problem: "Exhausted" }]
  });

  // Reconciler ticks
  let finalP = [];
  tick(settings, store, { execute: true, workSource, promises: finalP });
  await Promise.allSettled(finalP);
  finalP = [];
  tick(settings, store, { execute: true, workSource, promises: finalP });
  await Promise.allSettled(finalP);

  // Because attempt=3 >= maxReworkAttempts(3), it should transition to blocked
  assert.equal(workSource.issues.get("PACE-2").canonicalState, "blocked");
  
  runs = store.listRunsDetailed(20);
  const finalRun = runs.find(r => r.id === activeRun.id);
  assert.equal(finalRun.state, "blocked");
  
  // Execution count remains 4
  assert.equal(executionCount, 4);
});
