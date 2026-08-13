import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { RunStore } from "../lib/store.js";
import { WorkSourceProvider } from "../lib/work-source.js";
import { loadSettings } from "../lib/config.js";
import {
  evaluateIssue,
  validateOperatingMode,
  resolveOperatingMode,
  resolveAutonomyPolicy,
  isActionAutonomous,
  authorizeRuntimeAction,
  computePlanFingerprint,
  OPERATING_MODES,
  HUMAN_ONLY_ACTIONS,
  SUPPORTED_AUTONOMY_ACTIONS
} from "../lib/policy.js";
import {
  issuePlan,
  createConfigSnapshot,
  handleImplementation,
  handleReview,
  handleRework,
  getStore
} from "../lib/runtime.js";
import { dispatchOnce } from "../lib/dispatcher.js";
import { reconcileReviewers, reconcileIntegrations, tick } from "../lib/reconciler.js";

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
      .map(i => JSON.parse(JSON.stringify(i)));
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
}

function createTestSettings(overrides = {}) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "repo-phase-b-"));
  fs.writeFileSync(path.join(repoPath, "AGENTS.md"), "test");
  fs.writeFileSync(path.join(repoPath, "ORCHESTRATION.md"), "test");
  fs.writeFileSync(path.join(repoPath, "PACEBUILD_ORCHESTRATOR.md"), "test");
  fs.mkdirSync(path.join(repoPath, ".agents", "rules"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, ".agents", "rules", "orchestration-gates.md"), "test");
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worktrees-phase-b-"));
  const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-phase-b-"));
  fs.mkdirSync(path.join(tempConfigDir, ".agent-runtime"), { recursive: true });

  const configPath = path.join(tempConfigDir, "config.json");
  const rawData = {
    project: {
      key: "PACE",
      repoPath: ".",
      operatingMode: "autonomous"
    },
    worktree: {
      root: worktreeRoot
    },
    policy: {
      allowedProjects: ["PACE"],
      humanOnlyStatuses: ["Done"],
      maxConcurrency: 5,
      requiredLabels: ["agent-ready"],
      externalWritesEnabled: true,
      gitIntegrationEnabled: true,
      autonomyEnabled: true,
      review: {
        provider: "antigravity",
        modelProfile: "claude-review",
        maxReworkAttempts: 3
      },
      pathScopes: { "backend-engineer": ["backend/**"], "frontend-engineer": ["frontend/**"] }
    },
    workSource: { defaultProvider: "mock", providers: { mock: { type: "mock" } } },
    orchestrator: { defaultProvider: "builtin", providers: { builtin: { type: "builtin" } } },
    executor: {
      defaultProvider: "codex",
      providers: {
        codex: { command: ["codex"], modelProfiles: { medium: "gpt-4o", "claude-review": "gpt-4o" } },
        antigravity: { command: ["agy"], modelProfiles: { medium: "claude-3-5-sonnet", "claude-review": "claude-3-5-sonnet" } }
      }
    },
    ...overrides
  };

  fs.writeFileSync(configPath, JSON.stringify(rawData, null, 2));

  return {
    source: configPath,
    projectKey: "PACE",
    repoPath,
    worktreeRoot,
    data: rawData
  };
}

function createMockRuntime() {
  let executions = 0;
  return {
    get executionCount() {
      return executions;
    },
    spawnSync(cmd, args) {
      if (cmd === "git") {
        if (args.includes("status")) return { status: 0, stdout: "" };
        if (args.includes("rev-parse")) return { status: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" };
        if (args.includes("commit-tree")) return { status: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" };
        return { status: 0, stdout: "" };
      }
      executions++;
      return { status: 0, stdout: "build success", stderr: "" };
    },
    spawn(cmd, args) {
      executions++;
      const child = new EventEmitter();
      child.pid = 12345;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({
          status: "SUCCESS",
          ok: true,
          response: JSON.stringify({
            status: "completed",
            summary: "Done",
            verdict: "clean",
            evidence: [{ id: "C1", severity: "suggestion", category: "tests", problem: "OK" }]
          })
        }) + "\n"));
        setTimeout(() => child.emit("close", 0), 5);
      }, 5);
      return child;
    }
  };
}

// ── 1. Operating Modes & Autonomy Validation (Fail-Closed) ───────────────────

test("Fail-Closed Config Validation: invalid types, conflicting modes, and invalid autonomy values throw", () => {
  // Invalid operatingMode types and values
  assert.throws(() => validateOperatingMode(123), /Invalid operatingMode type/);
  assert.throws(() => validateOperatingMode(true), /Invalid operatingMode type/);
  assert.throws(() => validateOperatingMode("invalid-mode"), /Invalid operatingMode/);

  // Conflicting definitions between project and policy throw
  const conflictingSettings = {
    data: {
      project: { operatingMode: "manual" },
      policy: { operatingMode: "autonomous" }
    }
  };
  assert.throws(() => resolveOperatingMode(conflictingSettings), /Conflicting operatingMode definitions/);

  // Invalid autonomy action keys throw
  const badActionSettings = {
    data: {
      project: { operatingMode: "autonomous" },
      policy: {
        autonomy: { unsupportedActionKey: "auto" }
      }
    }
  };
  assert.throws(() => resolveAutonomyPolicy(badActionSettings), /Unsupported autonomy action/);

  // Invalid autonomy values (e.g. "yes", true) throw
  const badValueSettings = {
    data: {
      project: { operatingMode: "autonomous" },
      policy: {
        autonomy: { implementation: "yes" }
      }
    }
  };
  assert.throws(() => resolveAutonomyPolicy(badValueSettings), /Invalid autonomy value/);

  // loadSettings fail-closed on invalid config file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-fail-closed-"));
  const badConfigPath = path.join(tmpDir, "bad-config.json");
  fs.writeFileSync(badConfigPath, JSON.stringify({
    project: { key: "PACE", repoPath: ".", operatingMode: "non-existent-mode" },
    policy: {},
    worktree: { root: "." },
    executor: { defaultProvider: "codex", providers: { codex: { command: ["codex"] } } },
    workSource: { defaultProvider: "mock", providers: { mock: { type: "mock" } } }
  }));

  assert.throws(() => loadSettings(badConfigPath), /Invalid operatingMode/);
});

test("Deterministic Autonomy Policy: resolves permissions and protects human-only gates against hostile overrides", () => {
  const hostileSettings = createTestSettings({
    project: { key: "PACE", operatingMode: "autonomous" },
    policy: {
      allowedProjects: ["PACE"],
      requiredLabels: ["agent-ready"],
      humanOnlyStatuses: ["Done"],
      autonomy: {
        finalMerge: "auto",
        markDone: "auto",
        productionDeploy: "auto",
        destructiveMigration: "auto",
        secretMutation: "auto"
      }
    }
  });

  const resolved = resolveAutonomyPolicy(hostileSettings);
  for (const humanAction of HUMAN_ONLY_ACTIONS) {
    assert.equal(resolved[humanAction], "human", `${humanAction} must remain human-only`);
    assert.equal(isActionAutonomous(hostileSettings, humanAction), false);
    const auth = authorizeRuntimeAction(hostileSettings, null, { issueKey: "PACE-1", action: humanAction });
    assert.equal(auth.allowed, false, `${humanAction} must be denied at runtime`);
  }
});

// ── 2. Action-Scoped and Plan-Scoped Approvals ────────────────────────────────

test("Action-Scoped Approval: manual approval for implementation does NOT authorize rework, review, or child integration", () => {
  const settings = createTestSettings({ project: { key: "PACE", operatingMode: "manual" } });
  const store = getStore(settings);
  const issue = {
    key: "PACE-ACTION-1",
    summary: "Action scoped test issue",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  const plan = issuePlan(settings, issue);

  // Approve implementation ONLY
  store.recordApprovalDecision("PACE-ACTION-1", {
    action: "implementation",
    approved: true,
    approver: "pm@example.com",
    plan
  });

  // Implementation is approved
  const authImpl = authorizeRuntimeAction(settings, store, {
    issueKey: "PACE-ACTION-1",
    action: "implementation",
    plan
  });
  assert.equal(authImpl.allowed, true, "Implementation is approved");

  // Review is NOT approved by an implementation approval
  const authReview = authorizeRuntimeAction(settings, store, {
    issueKey: "PACE-ACTION-1",
    action: "review",
    plan
  });
  assert.equal(authReview.allowed, false, "Review is NOT approved");

  // Rework is NOT approved by an implementation approval
  const authRework = authorizeRuntimeAction(settings, store, {
    issueKey: "PACE-ACTION-1",
    action: "rework",
    plan,
    attempt: 1
  });
  assert.equal(authRework.allowed, false, "Rework is NOT approved");

  // Child integration is NOT approved by an implementation approval
  const authIntegration = authorizeRuntimeAction(settings, store, {
    issueKey: "PACE-ACTION-1",
    action: "childIntegration",
    plan
  });
  assert.equal(authIntegration.allowed, false, "Child integration is NOT approved");
});

test("Plan-Scoped Approval: stale approval for Plan A must NOT authorize changed Plan B", () => {
  const settings = createTestSettings({ project: { key: "PACE", operatingMode: "supervised" } });
  const store = getStore(settings);

  const issueA = {
    key: "PACE-PLAN-1",
    summary: "Backend task",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  const planA = issuePlan(settings, issueA);
  assert.equal(planA.taskAgent, "backend-engineer");

  // Human approves Plan A
  store.recordApprovalDecision("PACE-PLAN-1", {
    action: "implementation",
    approved: true,
    approver: "pm@example.com",
    plan: planA
  });

  // Plan A is authorized
  const evalPlanA = issuePlan(settings, issueA, { store, action: "implementation" });
  assert.equal(evalPlanA.eligible, true, "Plan A is eligible with approval");

  // Issue changes to Frontend task -> Plan B
  const issueB = {
    key: "PACE-PLAN-1",
    summary: "Frontend task",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready", "agent-frontend-engineer"],
    issueType: "Task"
  };

  const planB = issuePlan(settings, issueB, { store, action: "implementation" });
  assert.equal(planB.taskAgent, "frontend-engineer");
  assert.equal(planB.eligible, false, "Plan B is NOT authorized by stale approval for Plan A");
  assert.match(planB.eligibilityReasons[0], /requires human approval/i);
});

// ── 3. Supervised Mode: Rework Requires a Second Approval ───────────────────

test("Supervised Mode: approve implementation -> review fails -> rework waits for a NEW human approval", async () => {
  const settings = createTestSettings({ project: { key: "PACE", operatingMode: "supervised" } });
  const store = getStore(settings);
  const workSource = new MockWorkSourceProvider([
    {
      key: "PACE-SUPER-REWORK",
      summary: "Supervised rework issue",
      description: "Acceptance criteria: done",
      canonicalState: "ready",
      labels: ["agent-ready"],
      issueType: "Task"
    }
  ]);

  const runtime = createMockRuntime();

  // 1. Initial ready state: requires approval
  const dispatchRes1 = await dispatchOnce(settings, { execute: true, workSource, store, runIssueImpl: (s, i, e) => handleImplementation(s, i, e, runtime) });
  assert.equal(dispatchRes1.waves.length, 0, "Wave 0 before approval");

  // 2. Approve implementation
  const plan1 = issuePlan(settings, workSource.issues.get("PACE-SUPER-REWORK"), { store });
  store.recordApprovalDecision("PACE-SUPER-REWORK", {
    action: "implementation",
    approved: true,
    approver: "lead@example.com",
    plan: plan1
  });

  // 3. Worker executes implementation
  const execRes = handleImplementation(settings, workSource.issues.get("PACE-SUPER-REWORK"), true, runtime);
  assert.equal(execRes.exitCode, 0);
  assert.equal(runtime.executionCount, 1);

  // Implementation run moves to review-queued and work source transitions to review
  const runs = store.listRunsDetailed(10);
  const implRun = runs.find(r => r.issue_key === "PACE-SUPER-REWORK");
  store.transition(implRun.id, "review-queued", { implementationSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
  await workSource.transition("PACE-SUPER-REWORK", "review");

  // 4. Review runs and fails (changes-requested)
  const failedReviewOutcome = {
    verdict: "changes-requested",
    reviewerId: "test-reviewer",
    implementationSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    evidence: [{ id: "R1", severity: "major", category: "correctness", problem: "Bug found", expected: "Fix it", verification: "Test" }]
  };
  store.transition(implRun.id, "review-failed", { reviewOutcome: failedReviewOutcome });
  store.transition(implRun.id, "transitioning-rework", { reviewOutcome: failedReviewOutcome });
  await workSource.transition("PACE-SUPER-REWORK", "rework");
  store.transition(implRun.id, "failed-retryable", { attempt: 1, reviewOutcome: failedReviewOutcome });
  store.releaseLock("PACE-SUPER-REWORK", implRun.id);

  // 5. Work source is now in rework. Supervised dispatcher must NOT launch rework automatically!
  const dispatchRes2 = await dispatchOnce(settings, {
    execute: true,
    workSource,
    store,
    runIssueImpl: (s, i, e) => handleRework(s, i, e, runtime)
  });

  assert.equal(dispatchRes2.waves.length, 0, "Rework must NOT start without a new approval for action: rework");
  assert.equal(runtime.executionCount, 1, "Execution count unchanged");

  // 6. Provide the NEW human approval for action: "rework"
  store.recordApprovalDecision("PACE-SUPER-REWORK", {
    action: "rework",
    attempt: 1,
    approved: true,
    approver: "lead@example.com",
    reason: "Approved rework attempt 1"
  });

  // 7. Next dispatcher cycle now launches rework
  const dispatchRes3 = await dispatchOnce(settings, {
    execute: true,
    workSource,
    store,
    runIssueImpl: (s, i, e) => handleRework(s, i, e, runtime)
  });

  assert.equal(dispatchRes3.waves.length, 1, "Rework launched after rework approval");
  assert.equal(runtime.executionCount, 2, "Execution count incremented for rework");
});

// ── 4. Supervised Child Integration Waits for Approval ───────────────────────

test("Supervised Child Integration: integration is blocked until explicit childIntegration approval", () => {
  const settings = createTestSettings({
    project: { key: "PACE", operatingMode: "supervised" },
    policy: {
      allowedProjects: ["PACE"],
      gitIntegrationEnabled: true,
      autonomy: { childIntegration: "approval" }
    }
  });
  const store = getStore(settings);

  // Setup epic with queued child integration
  store.upsertEpic({ key: "PACE-EPIC-10", branch: "epic/pace-epic-10" });
  store.upsertEpicTask({
    epicKey: "PACE-EPIC-10",
    issueKey: "PACE-CHILD-1",
    branch: "feature/pace-child-1"
  });
  store.queueEpicIntegration({
    epicKey: "PACE-EPIC-10",
    issueKey: "PACE-CHILD-1",
    leafBranch: "feature/pace-child-1"
  });

  // Create clean reviewed run for PACE-CHILD-1
  const runId = store.createRun("PACE-CHILD-1", {
    issue: "PACE-CHILD-1",
    configSnapshot: { operatingMode: "supervised" }
  });
  store.transition(runId, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      reviewerId: "reviewer-1",
      evidence: [{ id: "C1", severity: "suggestion", category: "tests", problem: "Clean" }]
    }
  });

  let adapterCalled = false;
  const mockAdapter = () => {
    adapterCalled = true;
    return { completed: true, reviewedSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", integratedSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" };
  };

  // 1. Without approval, reconcileIntegrations blocks
  const res1 = reconcileIntegrations(settings, store, { integrationAdapter: mockAdapter });
  assert.equal(res1.blocked.length, 1);
  assert.match(res1.blocked[0].reason, /requires human approval/i);
  assert.equal(adapterCalled, false);

  // 2. Record approval for action: "childIntegration"
  store.recordApprovalDecision("PACE-CHILD-1", {
    action: "childIntegration",
    approved: true,
    approver: "pm@example.com"
  });

  // 3. ReconcileIntegrations now completes integration
  const res2 = reconcileIntegrations(settings, store, { integrationAdapter: mockAdapter });
  assert.equal(res2.blocked.length, 0);
  assert.equal(res2.integrationsCompleted, 1);
  assert.equal(adapterCalled, true);
});

// ── 5. Behavioral Immutability of Config Snapshots ───────────────────────────

test("Behavioral Immutability: Reviewer execution uses originating implementation run's pinned review provider and model", async () => {
  const settings = createTestSettings({
    project: { key: "PACE", operatingMode: "autonomous" },
    policy: {
      allowedProjects: ["PACE"],
      requiredLabels: ["agent-ready"],
      review: {
        provider: "antigravity",
        modelProfile: "claude-review",
        maxReworkAttempts: 3
      }
    }
  });
  const store = getStore(settings);
  const runtime = createMockRuntime();

  const issue = {
    key: "PACE-IMMUT-1",
    summary: "Immutable review test",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  // 1. Implementation run starts with reviewer antigravity
  const plan = issuePlan(settings, issue);
  assert.equal(plan.configSnapshot.reviewProvider, "antigravity");
  const runId = store.createRun("PACE-IMMUT-1", plan);
  store.transition(runId, "review-queued", { implementationSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });

  // 2. Global settings are mutated to codex
  settings.data.policy.review.provider = "codex";
  settings.data.policy.review.modelProfile = "medium";

  // 3. Reviewer execution for active run resolves from originating snapshot (antigravity)
  const reviewRes = await handleReview(settings, { ...issue, canonicalState: "review" }, true, runtime);
  assert.equal(reviewRes.exitCode, 0);

  const reviewRun = store.getRun(reviewRes.output.runId);
  assert.equal(reviewRun.payload.configSnapshot.reviewProvider, "antigravity", "Review run inherits pinned review provider antigravity");
});

test("Behavioral Immutability: Rework exhaustion respects originating snapshot's maxReworkAttempts", () => {
  const settings = createTestSettings({
    project: { key: "PACE", operatingMode: "autonomous" },
    policy: {
      allowedProjects: ["PACE"],
      requiredLabels: ["agent-ready"],
      review: {
        provider: "antigravity",
        modelProfile: "claude-review",
        maxReworkAttempts: 3
      }
    }
  });
  const store = getStore(settings);

  // Active run started with snapshot maxReworkAttempts = 3
  const plan = issuePlan(settings, {
    key: "PACE-IMMUT-REWORK",
    summary: "Immutable rework test",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  });
  assert.equal(plan.configSnapshot.maxReworkAttempts, 3);
  const runId = store.createRun("PACE-IMMUT-REWORK", plan);

  // Mutate global policy to maxReworkAttempts = 1
  settings.data.policy.review.maxReworkAttempts = 1;

  // Run fails review at attempt 1
  store.transition(runId, "review-failed", {
    attempt: 1,
    reviewOutcome: { verdict: "changes-requested" }
  });

  // reconcileReviewers evaluates with the originating run's snapshot (limit=3).
  // Attempt 1 < limit 3 -> transitions to transitioning-rework, NOT transitioning-blocked!
  reconcileReviewers(settings, store);
  const updatedRun = store.getRun(runId);
  assert.equal(updatedRun.state, "transitioning-rework", "Active run honors snapshot maxReworkAttempts=3, not mutated global 1");
});
