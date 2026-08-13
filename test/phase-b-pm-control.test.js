import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { RunStore } from "../lib/store.js";
import { WorkSourceProvider } from "../lib/work-source.js";
import {
  evaluateIssue,
  validateOperatingMode,
  resolveOperatingMode,
  resolveAutonomyPolicy,
  isActionAutonomous,
  OPERATING_MODES,
  HUMAN_ONLY_ACTIONS
} from "../lib/policy.js";
import {
  issuePlan,
  createConfigSnapshot,
  handleImplementation,
  getStore
} from "../lib/runtime.js";
import { dispatchOnce } from "../lib/dispatcher.js";

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

  return {
    source: path.join(tempConfigDir, "config.json"),
    projectKey: "PACE",
    repoPath,
    worktreeRoot,
    data: {
      project: {
        key: "PACE",
        operatingMode: "autonomous"
      },
      policy: {
        allowedProjects: ["PACE"],
        humanOnlyStatuses: ["Done"],
        maxConcurrency: 5,
        requiredLabels: ["agent-ready"],
        externalWritesEnabled: true,
        gitIntegrationEnabled: false,
        autonomyEnabled: true,
        review: {
          provider: "antigravity",
          modelProfile: "claude-review",
          maxReworkAttempts: 3
        },
        pathScopes: { "backend-engineer": ["backend/**"] }
      },
      workSource: { defaultProvider: "mock", providers: { mock: { type: "mock" } } },
      orchestrator: { defaultProvider: "builtin", providers: { builtin: { type: "builtin" } } },
      executor: {
        defaultProvider: "codex",
        providers: {
          codex: { command: ["codex"], modelProfiles: { medium: "gpt-4o" } },
          antigravity: { command: ["agy"], modelProfiles: { medium: "claude-3-5-sonnet", "claude-review": "claude-3-5-sonnet" } }
        }
      },
      ...overrides
    }
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

// ── 1. Operating Modes Validation & Autonomy Policy ──────────────────────────

test("Operating Modes: validate and resolve operatingMode with defaults and validation", () => {
  assert.equal(validateOperatingMode("manual"), "manual");
  assert.equal(validateOperatingMode("supervised"), "supervised");
  assert.equal(validateOperatingMode("autonomous"), "autonomous");
  assert.throws(() => validateOperatingMode("invalid-mode"), /Invalid operatingMode/);

  const defaultSettings = createTestSettings();
  assert.equal(resolveOperatingMode(defaultSettings), "autonomous");

  const manualSettings = createTestSettings({ project: { key: "PACE", operatingMode: "manual" } });
  assert.equal(resolveOperatingMode(manualSettings), "manual");

  const supervisedSettings = createTestSettings({ project: { key: "PACE", operatingMode: "supervised" } });
  assert.equal(resolveOperatingMode(supervisedSettings), "supervised");
});

test("Deterministic Autonomy Policy: resolves permissions and protects human-only gates", () => {
  const manualSettings = createTestSettings({ project: { key: "PACE", operatingMode: "manual" } });
  assert.equal(isActionAutonomous(manualSettings, "discovery"), true);
  assert.equal(isActionAutonomous(manualSettings, "planning"), true);
  assert.equal(isActionAutonomous(manualSettings, "implementation"), false);
  assert.equal(isActionAutonomous(manualSettings, "review"), false);

  const supervisedSettings = createTestSettings({ project: { key: "PACE", operatingMode: "supervised" } });
  assert.equal(isActionAutonomous(supervisedSettings, "discovery"), true);
  assert.equal(isActionAutonomous(supervisedSettings, "planning"), true);
  assert.equal(isActionAutonomous(supervisedSettings, "implementation"), false);
  assert.equal(isActionAutonomous(supervisedSettings, "review"), true);

  const autonomousSettings = createTestSettings({ project: { key: "PACE", operatingMode: "autonomous" } });
  assert.equal(isActionAutonomous(autonomousSettings, "discovery"), true);
  assert.equal(isActionAutonomous(autonomousSettings, "planning"), true);
  assert.equal(isActionAutonomous(autonomousSettings, "implementation"), true);
  assert.equal(isActionAutonomous(autonomousSettings, "review"), true);

  // Human-only gates remain human-only even if user policy config attempts to set them to auto
  const overrideSettings = createTestSettings({
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

  const resolved = resolveAutonomyPolicy(overrideSettings);
  for (const humanAction of HUMAN_ONLY_ACTIONS) {
    assert.equal(resolved[humanAction], "human", `${humanAction} must remain human-only`);
    assert.equal(isActionAutonomous(overrideSettings, humanAction), false);
  }
});

// ── 2. Manual Mode Behavior ──────────────────────────────────────────────────

test("Manual Mode: discovery and planning allowed, automatic dispatch denied, explicit execution allowed", async () => {
  const settings = createTestSettings({ project: { key: "PACE", operatingMode: "manual" } });
  const store = getStore(settings);
  const workSource = new MockWorkSourceProvider([
    {
      key: "PACE-MANUAL-1",
      summary: "Manual test issue",
      description: "Acceptance criteria: done",
      canonicalState: "ready",
      labels: ["agent-ready"],
      issueType: "Task"
    }
  ]);

  // 1. Planning is allowed
  const plan = issuePlan(settings, workSource.issues.get("PACE-MANUAL-1"));
  assert.ok(plan);
  assert.equal(plan.issue, "PACE-MANUAL-1");
  assert.equal(plan.taskAgent, "backend-engineer");
  assert.equal(plan.eligible, false, "Plan is ineligible for automatic execution in manual mode");
  assert.match(plan.eligibilityReasons[0], /manual operating mode/i);

  // 2. Automatic dispatch does not schedule workers
  const runtime = createMockRuntime();
  const dispatchRes = await dispatchOnce(settings, {
    execute: true,
    workSource,
    store,
    runIssueImpl: async (s, issue, exec) => {
      return handleImplementation(s, issue, exec, runtime);
    }
  });

  assert.equal(dispatchRes.waves.length, 0, "No waves scheduled in manual mode");
  assert.equal(runtime.executionCount, 0, "0 workers started automatically in manual mode");

  // 3. Explicit approved execution is allowed
  const execRes = handleImplementation(
    settings,
    workSource.issues.get("PACE-MANUAL-1"),
    true,
    runtime,
    { approved: true }
  );

  assert.equal(execRes.exitCode, 0);
  assert.equal(runtime.executionCount, 1, "Worker started on explicit approved execution");
});

// ── 3. Supervised Mode Behavior ──────────────────────────────────────────────

test("Supervised Mode: plan generated, worker not started without approval, approval starts worker, rejection denies", async () => {
  const settings = createTestSettings({ project: { key: "PACE", operatingMode: "supervised" } });
  const store = getStore(settings);
  const workSource = new MockWorkSourceProvider([
    {
      key: "PACE-SUPERVISED-1",
      summary: "Supervised test issue",
      description: "Acceptance criteria: done",
      canonicalState: "ready",
      labels: ["agent-ready"],
      issueType: "Task"
    }
  ]);

  const runtime = createMockRuntime();

  // 1. First dispatch cycle: discovers, creates plan and awaiting-approval decision, but does NOT start worker
  const dispatchRes1 = await dispatchOnce(settings, {
    execute: true,
    workSource,
    store,
    runIssueImpl: async (s, issue, exec) => {
      return handleImplementation(s, issue, exec, runtime);
    }
  });

  assert.equal(dispatchRes1.waves.length, 0);
  assert.equal(runtime.executionCount, 0, "Worker must not start before human approval");

  // Verify awaiting-approval decision was recorded in store
  const decisions = store.getPmDecisions("PACE-SUPERVISED-1");
  const requested = decisions.find(d => d.type === "approval_requested");
  assert.ok(requested, "approval_requested decision must be recorded");
  assert.equal(requested.payload.state, "awaiting-approval");

  // 2. Human explicitly approves
  store.recordApprovalDecision("PACE-SUPERVISED-1", {
    approved: true,
    approver: "lead-pm@example.com",
    reason: "Approved for sprint 1"
  });

  // Verify approval decision persists
  assert.equal(store.hasExecutionApproval("PACE-SUPERVISED-1").approved, true);

  // 3. Next dispatch cycle starts worker now that approval is recorded
  const dispatchRes2 = await dispatchOnce(settings, {
    execute: true,
    workSource,
    store,
    runIssueImpl: async (s, issue, exec) => {
      return handleImplementation(s, issue, exec, runtime);
    }
  });

  assert.equal(dispatchRes2.waves.length, 1);
  assert.equal(runtime.executionCount, 1, "Worker started after approval");

  // 4. Rejection scenario with another issue
  workSource.issues.set("PACE-SUPERVISED-2", {
    key: "PACE-SUPERVISED-2",
    summary: "Supervised reject issue",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  });

  // Human rejects PACE-SUPERVISED-2
  store.recordApprovalDecision("PACE-SUPERVISED-2", {
    approved: false,
    approver: "lead-pm@example.com",
    reason: "Out of scope for this milestone"
  });

  const planReject = issuePlan(settings, workSource.issues.get("PACE-SUPERVISED-2"), { store });
  assert.equal(planReject.eligible, false);
  assert.match(planReject.eligibilityReasons[0], /rejected/i);

  const dispatchRes3 = await dispatchOnce(settings, {
    execute: true,
    workSource,
    store,
    runIssueImpl: async (s, issue, exec) => {
      return handleImplementation(s, issue, exec, runtime);
    }
  });

  // No worker scheduled for rejected issue
  assert.equal(dispatchRes3.waves.length, 0);
  assert.equal(runtime.executionCount, 1, "Execution count unchanged on rejection");
});

// ── 4. Autonomous Mode Behavior ──────────────────────────────────────────────

test("Autonomous Mode: ready work starts automatically, Phase A lifecycle continues, human-only gates remain blocked", async () => {
  const settings = createTestSettings({ project: { key: "PACE", operatingMode: "autonomous" } });
  const store = getStore(settings);
  const workSource = new MockWorkSourceProvider([
    {
      key: "PACE-AUTO-1",
      summary: "Autonomous test issue",
      description: "Acceptance criteria: done",
      canonicalState: "ready",
      labels: ["agent-ready"],
      issueType: "Task"
    }
  ]);

  const runtime = createMockRuntime();

  // Ready work starts automatically
  const dispatchRes = await dispatchOnce(settings, {
    execute: true,
    workSource,
    store,
    runIssueImpl: async (s, issue, exec) => {
      return handleImplementation(s, issue, exec, runtime);
    }
  });

  assert.equal(dispatchRes.waves.length, 1);
  assert.equal(runtime.executionCount, 1, "Worker started automatically in autonomous mode");

  // Human-only items (e.g. Epic, Done state) remain blocked
  const epicPlan = issuePlan(settings, {
    key: "PACE-EPIC-1",
    summary: "Epic test",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Epic"
  });
  assert.equal(epicPlan.eligible, false);
  assert.match(epicPlan.eligibilityReasons[0], /Epic issues are human-only/i);

  const donePlan = issuePlan(settings, {
    key: "PACE-DONE-1",
    summary: "Done test",
    description: "Acceptance criteria: done",
    canonicalState: "done",
    labels: ["agent-ready"],
    issueType: "Task"
  });
  assert.equal(donePlan.eligible, false);
  assert.match(donePlan.eligibilityReasons[0], /human-only canonical state/i);
});

// ── 5. Immutable Run Configuration Snapshot ──────────────────────────────────

test("Immutable Run Configuration Snapshot: run retains original snapshot after global config changes", () => {
  const settings = createTestSettings({
    project: { key: "PACE", operatingMode: "autonomous" },
    executor: {
      defaultProvider: "codex",
      providers: {
        codex: { command: ["codex"], modelProfiles: { medium: "gpt-4o" } },
        antigravity: { command: ["agy"], modelProfiles: { medium: "claude-3-5-sonnet", "claude-review": "claude-3-5-sonnet" } }
      }
    }
  });
  const store = getStore(settings);

  const issue1 = {
    key: "PACE-SNAP-1",
    summary: "Snapshot issue 1",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  const plan1 = issuePlan(settings, issue1);
  assert.ok(plan1.configSnapshot, "Plan must contain configSnapshot");
  assert.equal(plan1.configSnapshot.operatingMode, "autonomous");
  assert.equal(plan1.configSnapshot.executorProvider, "codex");
  assert.equal(plan1.configSnapshot.reviewProvider, "antigravity");
  assert.equal(plan1.configSnapshot.taskAgent, "backend-engineer");
  assert.equal(plan1.configSnapshot.maxReworkAttempts, 3);

  const runId1 = store.createRun("PACE-SNAP-1", plan1);
  const initialRun = store.getRun(runId1);
  assert.equal(initialRun.payload.configSnapshot.executorProvider, "codex");
  assert.equal(initialRun.payload.configSnapshot.operatingMode, "autonomous");

  // Mutate global settings
  settings.data.project.operatingMode = "manual";
  settings.data.executor.defaultProvider = "antigravity";
  settings.data.policy.review.maxReworkAttempts = 5;

  // Run 1 in store still retains its immutable original config snapshot!
  const fetchedRun1 = store.getRun(runId1);
  assert.equal(fetchedRun1.payload.configSnapshot.executorProvider, "codex", "Historical run retains original provider codex");
  assert.equal(fetchedRun1.payload.configSnapshot.operatingMode, "autonomous", "Historical run retains original operatingMode autonomous");
  assert.equal(fetchedRun1.payload.configSnapshot.maxReworkAttempts, 3, "Historical run retains original maxReworkAttempts 3");

  // New Run 2 created after global config mutation receives the updated snapshot
  const issue2 = {
    key: "PACE-SNAP-2",
    summary: "Snapshot issue 2",
    description: "Acceptance criteria: done",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };

  const plan2 = issuePlan(settings, issue2);
  assert.equal(plan2.configSnapshot.operatingMode, "manual");
  assert.equal(plan2.configSnapshot.executorProvider, "antigravity");
  assert.equal(plan2.configSnapshot.maxReworkAttempts, 5);

  const runId2 = store.createRun("PACE-SNAP-2", plan2);
  const fetchedRun2 = store.getRun(runId2);
  assert.equal(fetchedRun2.payload.configSnapshot.executorProvider, "antigravity");
  assert.equal(fetchedRun2.payload.configSnapshot.operatingMode, "manual");
  assert.equal(fetchedRun2.payload.configSnapshot.maxReworkAttempts, 5);
});
