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
  computeIntegrationFingerprint,
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
import { reconcileReviewers, reconcileIntegrations } from "../lib/reconciler.js";
import { selectReviewProfile } from "../lib/executor.js";

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
      operatingMode: "autonomous",
      ...(overrides.project || {})
    },
    worktree: {
      root: worktreeRoot,
      ...(overrides.worktree || {})
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
      pathScopes: {
        "backend-engineer": ["backend/**"],
        "frontend-engineer": ["frontend/**"],
        "devops-engineer": ["devops/**", "lib/**"],
        "qa-engineer": ["test/**"]
      },
      ...(overrides.policy || {})
    },
    workSource: { defaultProvider: "mock", providers: { mock: { type: "mock" } }, ...(overrides.workSource || {}) },
    orchestrator: { defaultProvider: "builtin", providers: { builtin: { type: "builtin" } }, ...(overrides.orchestrator || {}) },
    executor: {
      defaultProvider: "codex",
      providers: {
        codex: { command: ["codex"], modelProfiles: { medium: "gpt-4o", "claude-review": "gpt-4o" } },
        antigravity: { command: ["agy"], modelProfiles: { medium: "claude-3-5-sonnet", "claude-review": "claude-3-5-sonnet" } }
      },
      ...(overrides.executor || {})
    }
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
  const spawnedCommands = [];
  const gitWorktreeCalls = [];
  return {
    get executionCount() {
      return executions;
    },
    spawnedCommands,
    gitWorktreeCalls,
    spawnSync(cmd, args) {
      if (cmd === "git") {
        if (args && args.includes("worktree")) {
          gitWorktreeCalls.push({ cmd, args });
          if (args.includes("list")) {
            const adds = gitWorktreeCalls.filter(c => c.args.includes("add"));
            const lines = adds.map(c => "worktree " + c.args[c.args.length - 2]);
            return { status: 0, stdout: lines.join("\n") };
          }
        }
        if (args && args.includes("status")) return { status: 0, stdout: "" };
        if (args && args.includes("rev-parse")) return { status: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" };
        if (args && args.includes("commit-tree")) return { status: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" };
        return { status: 0, stdout: "" };
      }
      executions++;
      spawnedCommands.push({ type: "sync", cmd, args, command: [cmd, ...(args || [])] });
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "completed",
          summary: "build success",
          changed_files: [],
          validation_commands: [],
          blockers: [],
          risks: []
        }),
        stderr: ""
      };
    },
    spawn(cmd, args) {
      executions++;
      spawnedCommands.push({ type: "async", cmd, args, command: [cmd, ...(args || [])] });
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
  assert.throws(() => validateOperatingMode(123), /Invalid operatingMode type/);
  assert.throws(() => validateOperatingMode(true), /Invalid operatingMode type/);
  assert.throws(() => validateOperatingMode("invalid-mode"), /Invalid operatingMode/);

  const conflictingSettings = {
    data: {
      project: { operatingMode: "manual" },
      policy: { operatingMode: "autonomous" }
    }
  };
  assert.throws(() => resolveOperatingMode(conflictingSettings), /Conflicting operatingMode definitions/);

  const badActionSettings = {
    data: {
      project: { operatingMode: "autonomous" },
      policy: {
        autonomy: { unsupportedActionKey: "auto" }
      }
    }
  };
  assert.throws(() => resolveAutonomyPolicy(badActionSettings), /Unsupported autonomy action/);

  const badValueSettings = {
    data: {
      project: { operatingMode: "autonomous" },
      policy: {
        autonomy: { implementation: "yes" }
      }
    }
  };
  assert.throws(() => resolveAutonomyPolicy(badValueSettings), /Invalid autonomy value/);

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

// ── 2. Strict Fail-Closed Approval Matching and Strengthened Fingerprints ─────

test("Strict Fail-Closed Approval Matching: missing fingerprint or action never grants authorization", () => {
  const settings = createTestSettings({ project: { key: "PACE", operatingMode: "manual" } });
  const store = getStore(settings);
  const issue = {
    key: "PACE-STRICT-1",
    summary: "Strict test issue",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  const plan = issuePlan(settings, issue);

  // 1. Calling recordApprovalDecision without an action throws
  assert.throws(() => store.recordApprovalDecision("PACE-STRICT-1", { approved: true }), /requires an action/);

  // 2. Legacy approval in database without action/fingerprint
  store.addPmDecision("PACE-STRICT-1", "execution_approval", {
    approved: true,
    approver: "legacy-pm",
    planFingerprint: null
  });

  // Legacy approval without action/fingerprint does NOT authorize
  assert.equal(store.hasExecutionApproval("PACE-STRICT-1", { action: "implementation", plan }), null);
  const auth = authorizeRuntimeAction(settings, store, { issueKey: "PACE-STRICT-1", action: "implementation", plan });
  assert.equal(auth.allowed, false);

  // 3. Storing an approval with missing fingerprint does NOT match a fingerprinted plan
  store.addPmDecision("PACE-STRICT-1", "execution_approval", {
    action: "implementation",
    approved: true,
    approver: "legacy-pm",
    planFingerprint: null
  });
  assert.equal(store.hasExecutionApproval("PACE-STRICT-1", { action: "implementation", plan }), null);

  // 4. Valid fingerprinted approval matches correctly
  store.recordApprovalDecision("PACE-STRICT-1", {
    action: "implementation",
    approved: true,
    approver: "pm@example.com",
    plan
  });
  const validApproval = store.hasExecutionApproval("PACE-STRICT-1", { action: "implementation", plan });
  assert.ok(validApproval);
  assert.equal(validApproval.approved, true);
});

test("Strengthened computePlanFingerprint: change to review provider, autonomy, or maxRework invalidates approval", () => {
  const settings = createTestSettings({ project: { key: "PACE", operatingMode: "supervised" } });
  const store = getStore(settings);
  const issue = {
    key: "PACE-FINGERPRINT-1",
    summary: "Fingerprint test issue",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  const planInitial = issuePlan(settings, issue);
  const fpInitial = computePlanFingerprint(planInitial);
  assert.equal(typeof fpInitial, "string");
  assert.equal(fpInitial.length, 64, "Must use full 64-char SHA-256 digest");

  // Approve initial plan
  store.recordApprovalDecision("PACE-FINGERPRINT-1", {
    action: "implementation",
    approved: true,
    approver: "pm@example.com",
    plan: planInitial
  });
  assert.ok(store.hasExecutionApproval("PACE-FINGERPRINT-1", { action: "implementation", plan: planInitial }));

  // 1. Changing ONLY review provider changes fingerprint
  const settingsDiffReview = createTestSettings({
    project: { key: "PACE", operatingMode: "supervised" },
    policy: {
      allowedProjects: ["PACE"],
      requiredLabels: ["agent-ready"],
      review: { provider: "codex", modelProfile: "medium", maxReworkAttempts: 3 }
    }
  });
  const planDiffReview = issuePlan(settingsDiffReview, issue);
  assert.notEqual(computePlanFingerprint(planDiffReview), fpInitial);
  assert.equal(store.hasExecutionApproval("PACE-FINGERPRINT-1", { action: "implementation", plan: planDiffReview }), null);

  // 2. Changing ONLY autonomy policy changes fingerprint
  const settingsDiffAutonomy = createTestSettings({
    project: { key: "PACE", operatingMode: "supervised" },
    policy: {
      allowedProjects: ["PACE"],
      requiredLabels: ["agent-ready"],
      autonomy: { childIntegration: "auto" }
    }
  });
  const planDiffAutonomy = issuePlan(settingsDiffAutonomy, issue);
  assert.notEqual(computePlanFingerprint(planDiffAutonomy), fpInitial);
  assert.equal(store.hasExecutionApproval("PACE-FINGERPRINT-1", { action: "implementation", plan: planDiffAutonomy }), null);

  // 3. Changing ONLY maxReworkAttempts changes fingerprint
  const settingsDiffMaxRework = createTestSettings({
    project: { key: "PACE", operatingMode: "supervised" },
    policy: {
      allowedProjects: ["PACE"],
      requiredLabels: ["agent-ready"],
      review: { provider: "antigravity", modelProfile: "claude-review", maxReworkAttempts: 5 }
    }
  });
  const planDiffMaxRework = issuePlan(settingsDiffMaxRework, issue);
  assert.notEqual(computePlanFingerprint(planDiffMaxRework), fpInitial);
  assert.equal(store.hasExecutionApproval("PACE-FINGERPRINT-1", { action: "implementation", plan: planDiffMaxRework }), null);
});

// ── 3. Operating-Mode Snapshot Resolution ────────────────────────────────────

test("Operating-Mode Snapshot Resolution: supervised run retains supervised mode across review failure and rework", async () => {
  const settings = createTestSettings({ project: { key: "PACE", operatingMode: "supervised" } });
  const store = getStore(settings);
  const runtime = createMockRuntime();

  const workSource = new MockWorkSourceProvider([
    {
      key: "PACE-MODE-SNAP-1",
      summary: "Supervised mode retention issue",
      description: "Acceptance criteria: done",
      canonicalState: "ready",
      labels: ["agent-ready"],
      issueType: "Task"
    }
  ]);

  // Initial plan created in supervised mode
  const plan = issuePlan(settings, workSource.issues.get("PACE-MODE-SNAP-1"), { store });
  assert.equal(plan.configSnapshot.operatingMode, "supervised");

  // Approve implementation and branchCreation
  store.recordApprovalDecision("PACE-MODE-SNAP-1", {
    action: "implementation",
    approved: true,
    approver: "lead@example.com",
    plan
  });
  store.recordApprovalDecision("PACE-MODE-SNAP-1", {
    action: "branchCreation",
    approved: true,
    approver: "lead@example.com",
    plan
  });

  // Worker executes implementation
  handleImplementation(settings, workSource.issues.get("PACE-MODE-SNAP-1"), true, runtime);
  const runs = store.listRunsDetailed(10);
  const implRun = runs.find(r => r.issue_key === "PACE-MODE-SNAP-1");
  store.transition(implRun.id, "review-queued", { implementationSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
  await workSource.transition("PACE-MODE-SNAP-1", "review");

  // Global settings mutated to autonomous
  settings.data.project.operatingMode = "autonomous";

  // Review fails
  const failedOutcome = {
    verdict: "changes-requested",
    reviewerId: "reviewer-1",
    implementationSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    evidence: [{ id: "F1", severity: "major", category: "correctness", problem: "Bug", expected: "Fix", verification: "Test" }]
  };
  store.transition(implRun.id, "review-failed", { reviewOutcome: failedOutcome });
  store.transition(implRun.id, "transitioning-rework", { reviewOutcome: failedOutcome });
  await workSource.transition("PACE-MODE-SNAP-1", "rework");
  store.transition(implRun.id, "failed-retryable", { attempt: 1, reviewOutcome: failedOutcome });
  store.releaseLock("PACE-MODE-SNAP-1", implRun.id);

  // Dispatcher cycle with live mode = autonomous, but originating run mode = supervised!
  const dispatchRes = await dispatchOnce(settings, {
    execute: true,
    workSource,
    store,
    runIssueImpl: (s, i, e) => handleRework(s, i, e, runtime)
  });

  // Must NOT launch automatically because originating run was supervised!
  assert.equal(dispatchRes.waves.length, 0, "Rework must NOT start without approval despite global autonomous mode");
  
  // Verify a new approval_requested decision is persisted for action: rework
  const decisions = store.getPmDecisions("PACE-MODE-SNAP-1");
  const reworkRequest = decisions.find(d => d.type === "approval_requested" && d.payload.action === "rework" && d.payload.attempt === 1);
  assert.ok(reworkRequest, "approval_requested decision for rework attempt 1 must be persisted");
});

// ── 4. Behavioral Snapshot Pinning for Rework ───────────────────────────────

test("Behavioral Snapshot Pinning for Rework: retains originating provider and taskAgent after global mutations", () => {
  const settings = createTestSettings({
    project: { key: "PACE", operatingMode: "autonomous" },
    executor: {
      defaultProvider: "codex",
      providers: {
        codex: { command: ["codex"], modelProfiles: { medium: "gpt-4o", "claude-review": "gpt-4o" } },
        antigravity: { command: ["agy"], modelProfiles: { medium: "claude-3-5-sonnet", "claude-review": "claude-3-5-sonnet" } }
      }
    }
  });
  const store = getStore(settings);

  const issue1 = {
    key: "PACE-REWORK-PIN",
    summary: "Rework pin issue",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  // Run 1 starts with Codex and backend-engineer
  const plan1 = issuePlan(settings, issue1);
  assert.equal(plan1.configSnapshot.executorProvider, "codex");
  assert.equal(plan1.configSnapshot.taskAgent, "backend-engineer");
  const runId1 = store.createRun("PACE-REWORK-PIN", plan1);
  store.transition(runId1, "failed-retryable", {
    attempt: 1,
    reviewOutcome: { verdict: "changes-requested" }
  });
  const retryableRun = store.getRun(runId1);

  // Global settings mutated: default executor changed to antigravity, model changed
  settings.data.executor.defaultProvider = "antigravity";

  // Rework plan for PACE-REWORK-PIN with originatingRun retains pinned codex
  const reworkPlan = issuePlan(settings, { ...issue1, canonicalState: "rework" }, { originatingRun: retryableRun, action: "rework", attempt: 1 });
  assert.equal(reworkPlan.execution.provider, "codex", "Rework retains pinned executor provider codex");
  assert.equal(reworkPlan.configSnapshot.executorProvider, "codex");

  // New unrelated issue uses updated global provider antigravity
  const issue2 = {
    key: "PACE-NEW-2",
    summary: "New unrelated issue",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };
  const newPlan = issuePlan(settings, issue2);
  assert.equal(newPlan.execution.provider, "antigravity", "New run uses updated global provider antigravity");
});

// ── 5. Enforce branchCreation at the Side-Effect Boundary ─────────────────────

test("Enforce branchCreation at Side-Effect Boundary: implementation=auto, branchCreation=approval prevents mutation without approval", () => {
  const settings = createTestSettings({
    project: { key: "PACE", operatingMode: "autonomous" },
    policy: {
      allowedProjects: ["PACE"],
      requiredLabels: ["agent-ready"],
      autonomy: {
        implementation: "auto",
        branchCreation: "approval"
      }
    }
  });
  const store = getStore(settings);
  const runtime = createMockRuntime();

  const issue = {
    key: "PACE-BRANCH-1",
    summary: "Branch creation gate issue",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  // 1. Implementation is auto, but branchCreation is approval -> issue plan is ineligible
  const plan = issuePlan(settings, issue, { store });
  assert.equal(plan.eligible, false, "Plan ineligible when branchCreation requires approval");
  assert.match(plan.eligibilityReasons[0], /branchCreation.*requires.*approval/i);

  // 2. handleImplementation without branchCreation approval blocks and does NOT mutate git
  const res1 = handleImplementation(settings, issue, true, runtime);
  assert.equal(res1.exitCode, 2, "Blocked before worktree creation");
  assert.equal(runtime.executionCount, 0, "No git worktree command executed");

  // 3. Approving implementation alone does NOT authorize branchCreation
  store.recordApprovalDecision("PACE-BRANCH-1", {
    action: "implementation",
    approved: true,
    approver: "lead@example.com",
    plan
  });
  const res2 = handleImplementation(settings, issue, true, runtime);
  assert.equal(res2.exitCode, 2, "Implementation approval does not authorize branchCreation");
  assert.equal(runtime.executionCount, 0);

  // 4. Once branchCreation is explicitly approved, handleImplementation succeeds
  store.recordApprovalDecision("PACE-BRANCH-1", {
    action: "branchCreation",
    approved: true,
    approver: "lead@example.com",
    plan
  });
  const res3 = handleImplementation(settings, issue, true, runtime);
  assert.equal(res3.exitCode, 0, "Execution succeeds with branchCreation approval");
  assert.equal(runtime.executionCount, 1, "Git worktree command executed");
});

// ── 6. Strengthened childIntegration Approval Scoping ─────────────────────────

test("Strengthened childIntegration Approval: approval is scoped to exact child issue, branches, and reviewed SHA", () => {
  const settings = createTestSettings({
    project: { key: "PACE", operatingMode: "supervised" },
    policy: {
      allowedProjects: ["PACE"],
      gitIntegrationEnabled: true,
      autonomy: { childIntegration: "approval" }
    }
  });
  const store = getStore(settings);

  store.upsertEpic({ key: "PACE-EPIC-20", branch: "epic/pace-epic-20" });
  store.upsertEpicTask({
    epicKey: "PACE-EPIC-20",
    issueKey: "PACE-CHILD-20",
    branch: "feature/pace-child-20"
  });
  store.queueEpicIntegration({
    epicKey: "PACE-EPIC-20",
    issueKey: "PACE-CHILD-20",
    leafBranch: "feature/pace-child-20"
  });

  const runId = store.createRun("PACE-CHILD-20", {
    issue: "PACE-CHILD-20",
    configSnapshot: { operatingMode: "supervised" }
  });
  const reviewedShaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  store.transition(runId, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: reviewedShaA,
      reviewerId: "reviewer-1",
      evidence: [{ id: "C1", severity: "suggestion", category: "tests", problem: "Clean" }]
    }
  });

  let adapterCalled = false;
  const mockAdapter = () => {
    adapterCalled = true;
    return { completed: true, reviewedSha: reviewedShaA, integratedSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
  };

  // 1. Approval for a DIFFERENT SHA does NOT authorize integration of SHA A
  const wrongPlan = {
    childIssueKey: "PACE-CHILD-20",
    leafBranch: "feature/pace-child-20",
    targetBranch: "epic/pace-epic-20",
    reviewedSha: "cccccccccccccccccccccccccccccccccccccccc"
  };
  store.recordApprovalDecision("PACE-CHILD-20", {
    action: "childIntegration",
    approved: true,
    approver: "pm@example.com",
    plan: wrongPlan
  });

  const res1 = reconcileIntegrations(settings, store, { integrationAdapter: mockAdapter });
  assert.equal(res1.blocked.length, 1);
  assert.match(res1.blocked[0].reason, /requires human approval/i);
  assert.equal(adapterCalled, false);

  // 2. Approval for the exact integration plan authorizes integration
  const correctPlan = {
    childIssueKey: "PACE-CHILD-20",
    leafBranch: "feature/pace-child-20",
    targetBranch: "epic/pace-epic-20",
    reviewedSha: reviewedShaA
  };
  store.recordApprovalDecision("PACE-CHILD-20", {
    action: "childIntegration",
    approved: true,
    approver: "pm@example.com",
    plan: correctPlan
  });

  const res2 = reconcileIntegrations(settings, store, { integrationAdapter: mockAdapter });
  assert.equal(res2.blocked.length, 0);
  assert.equal(res2.integrationsCompleted, 1);
  assert.equal(adapterCalled, true);
});

// ── 7. Supervised Mode: Rework Requires a Second Approval ───────────────────

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

  // 2. Approve implementation and branchCreation
  const plan1 = issuePlan(settings, workSource.issues.get("PACE-SUPER-REWORK"), { store });
  store.recordApprovalDecision("PACE-SUPER-REWORK", {
    action: "implementation",
    approved: true,
    approver: "lead@example.com",
    plan: plan1
  });
  store.recordApprovalDecision("PACE-SUPER-REWORK", {
    action: "branchCreation",
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
  const reworkPlan = issuePlan(settings, workSource.issues.get("PACE-SUPER-REWORK"), { store, action: "rework", attempt: 1, originatingRun: implRun });
  store.recordApprovalDecision("PACE-SUPER-REWORK", {
    action: "rework",
    attempt: 1,
    approved: true,
    approver: "lead@example.com",
    plan: reworkPlan,
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

test("Action-Scoped Approval: manual + implementation approved + branchCreation not approved -> no branch/worktree mutation and no worker start", async () => {
  const settings = createTestSettings({
    project: { operatingMode: "manual" },
    policy: {
      autonomy: {
        implementation: "approval",
        branchCreation: "approval"
      }
    }
  });
  const store = getStore(settings);

  const issue = {
    key: "PACE-ACTION-SCOPE",
    summary: "Implement feature",
    description: "Acceptance Criteria: Must work.",
    status: "In Progress",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  const plan = issuePlan(settings, issue, { store, action: "implementation" });
  
  // Record approval ONLY for implementation
  store.recordApprovalDecision("PACE-ACTION-SCOPE", {
    action: "implementation",
    approved: true,
    approver: "lead@example.com",
    plan
  });

  const runtime = createMockRuntime();
  const res = handleImplementation(settings, issue, true, runtime);

  // Must fail closed because branchCreation is not approved
  assert.equal(res.exitCode, 2, "handleImplementation must return exitCode 2 (blocked)");
  assert.equal(runtime.executionCount, 0, "No worker process must start");
  assert.equal(runtime.gitWorktreeCalls.length, 0, "No git worktree mutation must occur");

  const run = store.getRun(res.output.runId);
  assert.equal(run.state, "blocked");
  assert.ok(run.events.at(-1)?.payload?.reasons?.some(r => r.includes("branchCreation")));
});

test("Review Authorization Enforcement: manual review without review approval -> reviewer does not start", async () => {
  const settings = createTestSettings({
    project: { operatingMode: "manual" },
    policy: {
      autonomy: {
        implementation: "auto",
        review: "approval"
      }
    }
  });
  const store = getStore(settings);

  const issue = {
    key: "PACE-REVIEW-AUTH",
    summary: "Review feature",
    description: "Acceptance Criteria: Must review.",
    status: "In Review",
    canonicalState: "review",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  const plan = issuePlan(settings, issue, { store, action: "implementation" });
  const implRunId = store.createRun(issue.key, plan);
  store.transition(implRunId, "review-queued", { implementationSha: "1111222233334444555566667777888899990000" });

  const runtime = createMockRuntime();
  const res = handleReview(settings, issue, true, runtime);

  assert.equal(res.exitCode, 2, "handleReview must return exitCode 2 (blocked) when review is not approved");
  assert.equal(runtime.executionCount, 0, "Reviewer provider must not be spawned");

  const reviewRun = store.getRun(res.output.runId);
  assert.equal(reviewRun.state, "blocked");
  assert.ok(reviewRun.events.at(-1)?.payload?.reasons?.some(r => r.includes("review")));
});

test("Pinned Rework Actual Execution: initial run = codex/model-A -> global default becomes antigravity/model-B -> handleRework() invokes codex/model-A", async () => {
  const settings = createTestSettings({
    project: { operatingMode: "autonomous" },
    executor: {
      defaultProvider: "codex",
      providers: {
        codex: {
          command: ["codex", "exec", "{prompt}"],
          defaultModel: "model-A",
          modelProfiles: { "custom-A": "model-A" },
          defaultEffort: "low",
          mode: "accept-edits"
        },
        antigravity: {
          command: ["agy", "exec", "--model", "{model}", "{prompt}"],
          defaultModel: "model-B",
          modelProfiles: { "custom-B": "model-B" },
          defaultEffort: "high",
          mode: "accept-edits"
        }
      }
    }
  });
  const store = getStore(settings);

  const issue = {
    key: "PACE-REWORK-EXEC",
    summary: "Fix feature",
    description: "Acceptance Criteria: Must fix.",
    status: "In Progress",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  const runtime = createMockRuntime();

  // 1. Run initial implementation on codex / model-A
  const initialRes = handleImplementation(settings, issue, true, runtime);
  assert.equal(initialRes.exitCode, 0);
  assert.equal(runtime.executionCount, 1);
  assert.equal(runtime.spawnedCommands[0].command[0], "codex");

  // 2. Mark initial run review-failed and ready for rework
  const implRun = store.listRunsDetailed(5).find(r => r.issue_key === issue.key);
  const failedReviewOutcome = {
    verdict: "changes-requested",
    reviewerId: "reviewer-1",
    implementationSha: "sha-1",
    evidence: [{ id: "F1", severity: "major", category: "correctness", problem: "Bug", expected: "Fix", verification: "Test" }]
  };
  store.transition(implRun.id, "review-queued", { implementationSha: "sha-1" });
  store.transition(implRun.id, "review-failed", { reviewOutcome: failedReviewOutcome });
  store.transition(implRun.id, "failed-retryable", { attempt: 1, reviewOutcome: failedReviewOutcome });
  store.releaseLock(issue.key, implRun.id);

  // 3. Mutate global settings to defaultProvider = "antigravity" (with model-B)
  settings.data.executor.defaultProvider = "antigravity";

  // 4. Execute handleRework
  issue.canonicalState = "rework";
  const reworkRes = handleRework(settings, issue, true, runtime);
  assert.equal(reworkRes.exitCode, 0);
  assert.equal(runtime.executionCount, 2);

  // 5. Assert actual executed command was pinned to codex/model-A, NOT antigravity/model-B!
  const reworkCommand = runtime.spawnedCommands[1];
  assert.equal(reworkCommand.command[0], "codex", "Rework command must use pinned codex provider");
  const executingEvent = store.getRun(reworkRes.output.runId).events.find(e => e.state === "executing");
  assert.equal(executingEvent.payload.provider, "codex", "Rework execution event must record pinned codex provider");
  assert.equal(executingEvent.payload.model, "model-A", "Rework execution event must record pinned model-A");

  // 6. Assert a brand-new issue uses the updated global default (antigravity/model-B)
  const newIssue = {
    key: "PACE-NEW-RUN",
    summary: "New feature",
    description: "Acceptance Criteria: New feature.",
    status: "In Progress",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };
  const newRes = await handleImplementation(settings, newIssue, true, runtime);
  assert.equal(newRes.exitCode, 0);
  assert.equal(runtime.spawnedCommands[2].command[0], "agy", "New run must use new global default antigravity");
  assert.equal(newRes.output.provider, "antigravity");
  assert.equal(newRes.output.model, "model-B");
});

test("Distinct Builder and Reviewer Snapshot Identities: builder and reviewer retain distinct persona, taskAgent, and effort", () => {
  const settings = createTestSettings({
    policy: {
      review: {
        provider: "antigravity",
        persona: "qa-engineer",
        taskAgent: "correctness-reviewer",
        effort: "high",
        modelProfile: "claude-review"
      }
    }
  });

  const issue = {
    key: "PACE-DISTINCT-ID",
    summary: "Complex algorithm",
    description: "Acceptance Criteria: Pass tests.",
    status: "In Progress",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  const builderPlan = {
    persona: "backend-engineer",
    taskAgent: "api-specialist",
    skills: ["api-design", "minimal-change"],
    risk: "normal"
  };

  const snapshot = createConfigSnapshot(settings, issue, builderPlan);

  // Assert builder identity fields
  assert.equal(snapshot.persona, "backend-engineer");
  assert.equal(snapshot.taskAgent, "api-specialist");
  assert.equal(snapshot.agentId, "api-specialist");

  // Assert reviewer identity fields
  assert.equal(snapshot.reviewPersona, "qa-engineer");
  assert.equal(snapshot.reviewTaskAgent, "correctness-reviewer");
  assert.equal(snapshot.reviewEffort, "high");

  // Prove they remain distinct
  assert.notEqual(snapshot.persona, snapshot.reviewPersona, "Builder persona and reviewer persona must be distinct");
  assert.notEqual(snapshot.taskAgent, snapshot.reviewTaskAgent, "Builder taskAgent and reviewer taskAgent must be distinct");

  // Check selectReviewProfile uses snapshot.reviewPersona / snapshot.reviewTaskAgent
  const reviewProfile = selectReviewProfile(settings, issue, null, snapshot);
  assert.equal(reviewProfile.persona, "qa-engineer");
  assert.equal(reviewProfile.taskAgent, "correctness-reviewer");
  assert.equal(reviewProfile.effort, "high");
});

