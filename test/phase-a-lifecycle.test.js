import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import EventEmitter from "node:events";
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
      })
      .map(i => JSON.parse(JSON.stringify(i))); // Prevent in-place mutation from affecting local copies
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
}

function createTestStore() {
  const dbPath = path.join(os.tmpdir(), `phase-a-${randomUUID()}.sqlite3`);
  return new RunStore(dbPath);
}

let currentWorktreeRoot = null;

function createSettings(overrides = {}) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  fs.writeFileSync(path.join(repoPath, "AGENTS.md"), "test");
  fs.writeFileSync(path.join(repoPath, "ORCHESTRATION.md"), "test");
  fs.writeFileSync(path.join(repoPath, "PACEBUILD_ORCHESTRATOR.md"), "test");
  fs.mkdirSync(path.join(repoPath, ".agents", "rules"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, ".agents", "rules", "orchestration-gates.md"), "test");
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worktrees-"));
  currentWorktreeRoot = worktreeRoot;
  const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-"));
  fs.mkdirSync(path.join(tempConfigDir, ".agent-runtime"), { recursive: true });

  return {
    source: path.join(tempConfigDir, "config.json"),
    projectKey: "PACE",
    repoPath,
    worktreeRoot,
    data: {
      supervisor: { staleAfterSeconds: 90 },
      policy: {
        allowedProjects: ["PACE"],
        humanOnlyStatuses: ["Done"],
        maxConcurrency: 10,
        providerConcurrency: { codex: 1, antigravity: 1 },
        requiredLabels: ["agent-ready"],
        externalWritesEnabled: true,
        gitIntegrationEnabled: false,
        autonomyEnabled: true,
        review: {
          provider: "antigravity",
          modelProfile: "claude-review",
          maxReworkAttempts: 3
        },
        pathScopes: { "backend-engineer": ["foo.js"] }
      },
      workSource: { defaultProvider: "mock", providers: { mock: { type: "mock" } } },
      orchestrator: { defaultProvider: "builtin", providers: { builtin: { type: "builtin" } } },
      executor: {
        defaultProvider: "codex",
        providers: {
          codex: { command: ["codex"], modelProfiles: { medium: "gpt-4o" } },
          antigravity: { command: ["agy"], modelProfiles: { "claude-review": "claude-3-5-sonnet" } }
        }
      },
      ...overrides
    }
  };
}

let builderExecutions = 0;
let reviewerExecutions = 0;
let mockVerdict = "clean";
let mockEvidence = [];
let mockReviewerExitCode = 0;
let mockReviewerOutput = null;

const mockRuntime = {
  spawnSync(cmd, args) {
    if (cmd === "git") {
      if (args.includes("status")) return { status: 0, stdout: "" };
      if (args.includes("rev-parse")) return { status: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" };
      if (args.includes("commit-tree")) return { status: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" };
      if (args.includes("worktree") && args.includes("list")) {
        const wtDirs = currentWorktreeRoot && fs.existsSync(currentWorktreeRoot) ? fs.readdirSync(currentWorktreeRoot) : [];
        const lines = wtDirs.map(d => `worktree ${path.join(currentWorktreeRoot, d)}`).join("\n");
        return { status: 0, stdout: lines };
      }
      return { status: 0, stdout: "" };
    }
    builderExecutions++;
    return {
      status: 0,
      stdout: JSON.stringify({
        status: "completed",
        summary: "build successful",
        changed_files: [],
        validation_commands: [],
        blockers: [],
        risks: []
      }),
      stderr: ""
    };
  },
  spawn(cmd, args) {
    reviewerExecutions++;
    const child = new EventEmitter();
    child.pid = 9999;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      if (mockReviewerOutput !== null) {
        child.stdout.emit("data", Buffer.from(mockReviewerOutput + "\n"));
      } else {
        child.stdout.emit("data", Buffer.from(JSON.stringify({
          status: mockReviewerExitCode === 0 ? "SUCCESS" : "FAILED",
          ok: mockReviewerExitCode === 0,
          response: JSON.stringify({
            status: "completed",
            summary: "Reviewed",
            changed_files: [],
            validation_commands: [],
            blockers: [],
            risks: [],
            verdict: mockVerdict,
            evidence: mockEvidence
          })
        }) + "\n"));
      }
      setTimeout(() => {
        child.emit("close", mockReviewerExitCode);
      }, 5);
    }, 5);
    return child;
  }
};

async function testRunIssueImpl(settings, issue, execute, runtime, options) {
  const { runIssue } = await import("../lib/runtime.js");
  return runIssue(settings, issue, execute, mockRuntime, options);
}

test("Phase A Lifecycle: ready -> in_progress -> review -> human_approval", async () => {
  builderExecutions = 0;
  reviewerExecutions = 0;
  mockVerdict = "clean";
  mockEvidence = [{ id: "C1", severity: "suggestion", category: "security", problem: "All good", file: "foo.js", line: 1 }];
  
  const settings = createSettings();
  const { getStore } = await import("../lib/runtime.js");
  const store = getStore(settings);
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
  
  // 1. Dispatcher picks up 'ready' and dispatches builder
  const dispatchRes = await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: testRunIssueImpl });
  
  // Verify builder executed
  assert.equal(builderExecutions, 1);
  assert.equal(workSource.issues.get("PACE-1").canonicalState, "in_progress");
  
  // 2. Reconcile to move from in_progress local run (completed) -> transitioning-review
  tick(settings, store, { execute: true, workSource });
  await new Promise(r => setTimeout(r, 20));
  
  // 3. Reconcile again to execute durable mutation to review and move to review-queued
  let promises = [];
  tick(settings, store, { execute: true, workSource, promises });
  await Promise.allSettled(promises);
  await new Promise(r => setTimeout(r, 20));
  
  let runs = store.listRunsDetailed(10);
  assert.equal(runs[0].state, "review-queued");
  assert.equal(workSource.issues.get("PACE-1").canonicalState, "review");
  
  // 4. Dispatcher picks up 'review' and dispatches reviewer
  const dispatchResReviewer = await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: testRunIssueImpl });
  
  // Verify reviewer executed
  assert.equal(reviewerExecutions, 1);
  
  // Wait for async reviewer to finish and call handleReviewCompletion
  await new Promise(r => setTimeout(r, 20));
  
  runs = store.listRunsDetailed(10);
  const builderRun = runs.find(r => r.type !== "review" && r.payload?.type !== "review");
  assert.equal(builderRun.state, "reviewed-clean");
  
  // 5. Reconcile to handle standalone review completion -> transitioning-human-approval
  promises = [];
  tick(settings, store, { execute: true, workSource, promises });
  await Promise.allSettled(promises);
  
  // 6. Reconcile to execute durable mutation to human_approval
  promises = [];
  tick(settings, store, { execute: true, workSource, promises });
  await Promise.allSettled(promises);
  
  runs = store.listRunsDetailed(10);
  assert.equal(runs[0].state, "completed");
  
  // Verify external work source mutated to human_approval
  assert.equal(workSource.issues.get("PACE-1").canonicalState, "human_approval");
  
  // Verify exactly 1 execution of each
  assert.equal(builderExecutions, 1);
  assert.equal(reviewerExecutions, 1);
});

test("Phase A Lifecycle: rework exhaustion with maxReworkAttempts = 3", async () => {
  builderExecutions = 0;
  reviewerExecutions = 0;
  mockVerdict = "changes-requested";
  mockEvidence = [{ id: "F1", severity: "critical", category: "correctness", problem: "Fix it", file: "foo.js", line: 1 }];

  const settings = createSettings();
  const { getStore } = await import("../lib/runtime.js");
  const store = getStore(settings);
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

  // Base attempt (attempt 0)
  // Builder dispatch
  await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: testRunIssueImpl });
  
  // Move to review-queued
  tick(settings, store, { execute: true, workSource });
  let p = [];
  tick(settings, store, { execute: true, workSource, promises: p });
  await Promise.allSettled(p);
  
  // Re-run review loop maxReworkAttempts times
  for (let i = 1; i <= 3; i++) {
    // Reviewer dispatch
    await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: testRunIssueImpl });
    await new Promise(r => setTimeout(r, 20)); // wait for reviewer async child

    // Reconciler should transition from review-failed to transitioning-rework
    tick(settings, store, { execute: true, workSource });
    
    // Durable transition from transitioning-rework to failed-retryable -> rework mutation
    p = [];
    tick(settings, store, { execute: true, workSource, promises: p });
    await Promise.allSettled(p);
    
    // Advance retries from failed-retryable -> retry-queued
    p = [];
    tick(settings, store, { execute: true, workSource, promises: p });
    await Promise.allSettled(p);

    assert.equal(workSource.issues.get("PACE-2").canonicalState, "rework");

    // Dispatch builder again
    await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: testRunIssueImpl });
    
    // Transition to review-queued
    tick(settings, store, { execute: true, workSource });
    p = [];
    tick(settings, store, { execute: true, workSource, promises: p });
    await Promise.allSettled(p);
  }

  // Attempt 4 review fails -> hits rework limit
  await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: testRunIssueImpl });
  await new Promise(r => setTimeout(r, 20));
  
  // Tick to move to transitioning-blocked
  tick(settings, store, { execute: true, workSource });
  
  // Tick to mutate to blocked
  p = [];
  tick(settings, store, { execute: true, workSource, promises: p });
  await Promise.allSettled(p);

  const runs = store.listRunsDetailed(100);
  const finalRun = runs.find(r => r.state === "blocked");
  assert(finalRun, "Should have a blocked run");

  assert.equal(workSource.issues.get("PACE-2").canonicalState, "blocked");
  // 4 builder executions (1 base + 3 reworks)
  assert.equal(builderExecutions, 4);
  // 4 reviewer executions
  assert.equal(reviewerExecutions, 4);
});

test("Reviewer infrastructure failure: reviewer exits non-zero", async () => {
  builderExecutions = 0;
  reviewerExecutions = 0;
  mockReviewerExitCode = 1;
  mockReviewerOutput = null;

  const settings = createSettings();
  const { getStore, issuePlan } = await import("../lib/runtime.js");
  const store = getStore(settings);
  const workSource = new MockWorkSourceProvider([
    {
      key: "PACE-FAIL-EXIT",
      summary: "Implement feature",
      description: "Acceptance criteria: done",
      canonicalState: "review",
      labels: ["agent-ready"],
      issueType: "Task"
    }
  ]);
  const plan = issuePlan(settings, workSource.issues.get("PACE-FAIL-EXIT"));
  const builderRunId = store.createRun("PACE-FAIL-EXIT", plan);
  store.transition(builderRunId, "review-queued", { implementationSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });

  // Dispatch reviewer
  await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: testRunIssueImpl });
  await new Promise(r => setTimeout(r, 20));

  // Check state
  const runs = store.listRunsDetailed(10);
  const reviewerRun = runs.find(r => r.id !== builderRunId);
  const builderRun = store.getRun(builderRunId);

  assert.equal(reviewerExecutions, 1);
  assert.equal(reviewerRun.state, "failed-retryable");
  assert.equal(builderRun.state, "review-queued", "Implementation run remains in review-queued on reviewer exit failure");
  assert.equal(store.listLocks().length, 0, "Issue lock must be released");
  assert.equal(workSource.issues.get("PACE-FAIL-EXIT").canonicalState, "review", "Work source state must remain review");
});

test("Reviewer infrastructure failure: reviewer returns malformed output", async () => {
  builderExecutions = 0;
  reviewerExecutions = 0;
  mockReviewerExitCode = 0;
  mockReviewerOutput = "NOT VALID JSON AT ALL {[[";

  const settings = createSettings();
  const { getStore, issuePlan } = await import("../lib/runtime.js");
  const store = getStore(settings);
  const workSource = new MockWorkSourceProvider([
    {
      key: "PACE-FAIL-JSON",
      summary: "Implement feature",
      description: "Acceptance criteria: done",
      canonicalState: "review",
      labels: ["agent-ready"],
      issueType: "Task"
    }
  ]);
  const plan = issuePlan(settings, workSource.issues.get("PACE-FAIL-JSON"));
  const builderRunId = store.createRun("PACE-FAIL-JSON", plan);
  store.transition(builderRunId, "review-queued", { implementationSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });

  // Dispatch reviewer
  await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: testRunIssueImpl });
  await new Promise(r => setTimeout(r, 20));

  // Check state
  const runs = store.listRunsDetailed(10);
  const reviewerRun = runs.find(r => r.id !== builderRunId);
  const builderRun = store.getRun(builderRunId);

  assert.equal(reviewerExecutions, 1);
  assert.equal(reviewerRun.state, "failed-retryable");
  assert.equal(builderRun.state, "review-queued", "Implementation run remains in review-queued on malformed reviewer output");
  assert.equal(store.listLocks().length, 0, "Issue lock must be released");
});

test("Reviewer infrastructure failure: reviewer returns changes-requested with no evidence", async () => {
  builderExecutions = 0;
  reviewerExecutions = 0;
  mockReviewerExitCode = 0;
  mockReviewerOutput = null;
  mockVerdict = "changes-requested";
  mockEvidence = [];

  const settings = createSettings();
  const { getStore, issuePlan } = await import("../lib/runtime.js");
  const store = getStore(settings);
  const workSource = new MockWorkSourceProvider([
    {
      key: "PACE-FAIL-NO-EVID",
      summary: "Implement feature",
      description: "Acceptance criteria: done",
      canonicalState: "review",
      labels: ["agent-ready"],
      issueType: "Task"
    }
  ]);
  const plan = issuePlan(settings, workSource.issues.get("PACE-FAIL-NO-EVID"));
  const builderRunId = store.createRun("PACE-FAIL-NO-EVID", plan);
  store.transition(builderRunId, "review-queued", { implementationSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });

  // Dispatch reviewer
  await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: testRunIssueImpl });
  await new Promise(r => setTimeout(r, 20));

  // Check state
  const runs = store.listRunsDetailed(10);
  const reviewerRun = runs.find(r => r.id !== builderRunId);
  const builderRun = store.getRun(builderRunId);

  assert.equal(reviewerExecutions, 1);
  assert.equal(reviewerRun.state, "failed-retryable");
  assert.equal(builderRun.state, "review-queued", "Implementation run remains in review-queued when reviewer returns no structured findings");
  assert.equal(store.listLocks().length, 0, "Issue lock must be released");
  assert.equal(workSource.issues.get("PACE-FAIL-NO-EVID").canonicalState, "review", "Work source state must not transition to rework");
});

