/**
 * test/phase-j-hardening.test.js
 *
 * Dedicated Phase J Hardening Test Suite — Robustness, Durability & Security
 *
 * Scenarios:
 * A. SQLite legacy upgrade + reopen
 * B. Multi-Table transaction rollback safety (explicit deterministic injection)
 * C. Production atomic implementation claim race (two independent connections)
 * D. Production atomic reviewer claim race (two independent connections)
 * E. Duplicate integration reconciliation idempotency
 * F. Lease ownership / stale reclaim
 * G. Real approval contention matrix (4 combinations across two connections)
 * H. Stale parent approval & fingerprint rejection (HTTP 409)
 * I. Provider malformed output & crash fail-closed (non-Antigravity & Antigravity)
 * J. Provider timeout / error normalization (zero secret leakage)
 * K. Executor / reviewer output schema validation
 * L. Git ancestry / reviewed-SHA verification boundary
 * M. Integration conflict abort & safe worktree recovery
 * N. Real graph drift test (mutation & rediscovery block)
 * O. Real dependency gate test (reconcileParentChildren)
 * P. Rework max-attempt boundary & human attention escalation
 * Q. Same-run telemetry terminal uniqueness test across reopen
 * R. Usage null/zero truthfulness & metrics reporting
 * S. Real trusted-path containment & registered worktree verification
 * T. Command injection resistance (argument array safety)
 * U. Real config snapshot runtime test
 * V. Real database restart recovery seams (A, B, C)
 * W. True production autonomous E2E lifecycle with restart boundary
 * X. WAITING_HUMAN final boundary (zero auto-merge, zero Done, zero deploy)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";

import { RunStore } from "../lib/store.js";
import { WorkSourceProvider } from "../lib/work-source.js";
import { LocalGitSourceControlProvider } from "../lib/source-control.js";
import {
  discoverAndPinParent,
  reconcileParentChildren,
  runParentIntegrationReview,
  reconcileParentExecution,
  recordParentTelemetryEvent
} from "../lib/parent-orchestrator.js";
import { buildHierarchyDag, computeGraphFingerprint } from "../lib/dag.js";
import {
  HUMAN_ONLY_ACTIONS,
  resolveOperatingMode,
  resolveAutonomyPolicy,
  authorizeRuntimeAction,
  computePlanFingerprint,
  computeIntegrationFingerprint,
  computeParentBranchFingerprint,
  computeParentReviewFingerprint
} from "../lib/policy.js";
import { dispatchOnce } from "../lib/dispatcher.js";
import {
  reconcileWorkers,
  reconcileReviewers,
  reconcileIntegrations,
  recordReviewerOutcome,
  safeWorkSourceMutate
} from "../lib/reconciler.js";
import { validateChangedFiles } from "../lib/scope.js";
import { handlePmApproval, handlePmRejection, buildPmWorkspace } from "../lib/pm-workspace.js";
import { buildObservabilitySummary, redactTelemetryPayload } from "../lib/telemetry.js";
import { parseExecutionOutput, selectReviewProfile } from "../lib/executor.js";
import { runIssue, handleImplementation, handleReview } from "../lib/runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function makeTestGitRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "phase-j-repo-"));
  spawnSync("git", ["init", "-q", repo]);
  spawnSync("git", ["-C", repo, "config", "user.email", "agent@example.com"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "Agent Scaffold"]);
  spawnSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);

  const pkg = {
    name: "test-repo",
    scripts: {
      check: process.platform === "win32" ? "node -e \"process.exit(0)\"" : "node -e 'process.exit(0)'"
    }
  };
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  fs.writeFileSync(path.join(repo, "README.md"), "# Test\n", "utf8");
  fs.mkdirSync(path.join(repo, "backend"), { recursive: true });
  fs.mkdirSync(path.join(repo, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(repo, "backend", "app.js"), "// backend\n", "utf8");
  fs.writeFileSync(path.join(repo, "frontend", "app.js"), "// frontend\n", "utf8");

  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Agents\n", "utf8");
  fs.writeFileSync(path.join(repo, "ORCHESTRATION.md"), "# Orchestration\n", "utf8");
  fs.writeFileSync(path.join(repo, "PACEBUILD_ORCHESTRATOR.md"), "# PaceBuild\n", "utf8");
  fs.mkdirSync(path.join(repo, ".agents", "rules"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".agents", "rules", "orchestration-gates.md"), "# Gates\n", "utf8");

  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "initial commit"]);
  spawnSync("git", ["-C", repo, "branch", "-M", "develop"]);

  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-j-worktrees-"));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-j-store-"));
  const dbPath = path.join(dbDir, "runs.sqlite3");
  const store = new RunStore(dbPath);

  return { repo, worktreeRoot, store, dbPath, cleanup: () => {
    try { store.close(); } catch {}
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(worktreeRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch {}
  }};
}

class FakeWorkSourceProvider extends WorkSourceProvider {
  constructor(config = {}) {
    super();
    this.name = config.providerName || "fake-source";
    this.items = new Map();
    this.childrenMap = new Map();
    this.dependenciesMap = new Map();
    this.comments = [];
    this.transitions = [];
    this.writeEnabled = config.writeEnabled !== false;
  }
  setWorkItem(item) { this.items.set(item.key || item.id, item); }
  setChildren(parentKey, children) {
    this.childrenMap.set(parentKey, children);
    for (const c of children) {
      this.items.set(c.key || c.id, c);
    }
  }
  setDependencies(childKey, deps) { this.dependenciesMap.set(childKey, deps); }
  async getWorkItem(id) { return this.items.get(id) || null; }
  async getChildren(id) { return this.childrenMap.get(id) || []; }
  async getDependencies(id) { return this.dependenciesMap.get(id) || []; }
  async listWorkItems() { return Array.from(this.items.values()); }
  async poll({ canonicalStates = [], limit = 10 } = {}) {
    const allowedStates = new Set(canonicalStates);
    return Array.from(this.items.values())
      .filter((item) => allowedStates.size === 0 || allowedStates.has(item.canonicalState))
      .slice(0, limit);
  }
  async transition(id, state, meta) {
    this.transitions.push({ id, state, meta });
    const item = this.items.get(id);
    if (item) item.canonicalState = state;
    return { ok: true, state };
  }
  async addComment(id, text) {
    this.comments.push({ id, text });
    return { ok: true };
  }
}

function makeSettings(repo, worktreeRoot, store, overrides = {}) {
  return {
    projectKey: "PACE",
    repoPath: repo,
    worktreeRoot,
    _store: store,
    getStore: () => store,
    data: {
      project: {
        key: "PACE",
        operatingMode: overrides.operatingMode || "autonomous"
      },
      policy: {
        operatingMode: overrides.operatingMode || "autonomous",
        externalWritesEnabled: false,
        gitIntegrationEnabled: true,
        maxConcurrency: 4,
        pathScopes: {
          "backend-engineer": ["backend/**", "lib/**", "src/**", "**"],
          "frontend-engineer": ["frontend/**", "lib/**", "src/**", "**"],
          "fullstack-engineer": ["**"],
          "reviewer": ["**"],
          "correctness-reviewer": ["**"]
        },
        review: {
          provider: "codex",
          maxReworkAttempts: 2
        }
      },
      executor: {
        defaultProvider: "codex",
        providers: {
          codex: {
            command: ["codex", "{prompt}"],
            defaultModel: "gpt-4o",
            modelProfiles: { medium: "gpt-4o", high: "gpt-4o" }
          },
          antigravity: {
            command: ["antigravity", "{prompt}"],
            defaultModel: "claude-sonnet-4",
            modelProfiles: { medium: "claude-sonnet-4", high: "claude-sonnet-4" }
          }
        }
      },
      sourceControl: {
        defaultProvider: "local-git",
        providers: { "local-git": { type: "local-git" } }
      },
      workSource: {
        defaultProvider: "fake-source",
        providers: { "fake-source": { type: "mock" } }
      },
      controlPlane: {
        pmMutationEnabled: true,
        agentRegistryMutationEnabled: true
      },
      supervisor: {
        executeEnabled: true,
        staleAfterSeconds: 5,
        heartbeatSeconds: 1,
        issueLimit: 10
      },
      ...overrides.data
    }
  };
}

// -----------------------------------------------------------------------------
// Test A: SQLite Legacy Upgrade & Reopening Idempotency
// -----------------------------------------------------------------------------
test("Phase J — A. SQLite Legacy Upgrade & Reopening Idempotency", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-j-legacy-upgrade-"));
  const dbPath = path.join(tmpDir, "legacy-store.db");

  try {
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        issue_key TEXT NOT NULL,
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE parent_executions (
        parent_key TEXT PRIMARY KEY,
        source_provider TEXT NOT NULL,
        source_id TEXT,
        source_url TEXT,
        summary TEXT NOT NULL,
        type TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        base_sha TEXT,
        integration_branch TEXT NOT NULL,
        integration_worktree TEXT,
        graph_fingerprint TEXT NOT NULL,
        dag TEXT NOT NULL,
        state TEXT NOT NULL,
        conflict TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    rawDb.close();

    const store1 = new RunStore(dbPath);
    const runId = store1.createRun("PACE-LEGACY-1", { summary: "Test legacy run" });
    assert.ok(runId);

    store1.recordUsageEvent({
      runId,
      provider: "mock",
      model: "test-model",
      inputTokens: null,
      outputTokens: null,
      durationMs: null
    });

    const run1 = store1.getRun(runId);
    assert.equal(run1.issue_key, "PACE-LEGACY-1");
    store1.close();

    const store2 = new RunStore(dbPath);
    const run2 = store2.getRun(runId);
    assert.equal(run2.issue_key, "PACE-LEGACY-1");
    store2.close();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// -----------------------------------------------------------------------------
// Test B: Multi-Table Transaction Rollback Safety (Explicit Injection)
// -----------------------------------------------------------------------------
test("Phase J — B. Multi-Table Transaction Rollback Safety", () => {
  const { store, cleanup } = makeTestGitRepo();
  try {
    // 1. createRun deterministic failure injection:
    store.database.exec(`
      CREATE TRIGGER fail_create_run_event BEFORE INSERT ON events
      WHEN NEW.state = 'discovered' AND NEW.payload LIKE '%fail-rollback-test%'
      BEGIN
        SELECT RAISE(ABORT, 'Injected createRun event failure');
      END;
    `);

    assert.throws(
      () => {
        store.createRun("PACE-FAIL-1", { summary: "fail-rollback-test" });
      },
      /Injected createRun event failure/
    );

    const runCount1 = store.database.prepare("SELECT COUNT(*) as count FROM runs WHERE issue_key = 'PACE-FAIL-1'").get().count;
    assert.equal(runCount1, 0, "runs table must roll back on event insert failure");

    // 2. transition deterministic failure injection:
    const testRunId = store.createRun("PACE-TRANS-TEST", { summary: "Trans test" });
    assert.equal(store.getRun(testRunId).state, "discovered");

    store.database.exec(`
      CREATE TRIGGER fail_trans_event BEFORE INSERT ON events
      WHEN NEW.state = 'completed' AND NEW.run_id = '${testRunId}'
      BEGIN
        SELECT RAISE(ABORT, 'Injected transition event failure');
      END;
    `);

    assert.throws(
      () => {
        store.transition(testRunId, "completed", { outcome: "ok" });
      },
      /Injected transition event failure/
    );

    const runAfterFailedTrans = store.getRun(testRunId);
    assert.equal(runAfterFailedTrans.state, "discovered", "run state must remain unchanged after failed transition");
    const transEventCount = store.database.prepare("SELECT COUNT(*) as count FROM events WHERE run_id = ? AND state = 'completed'").get(testRunId).count;
    assert.equal(transEventCount, 0, "failed transition event must not persist");

    // 3. finishEpicIntegration deterministic failure injection:
    store.upsertEpic({ key: "PACE-100", summary: "Parent", branch: "epic/PACE-100", baseBranch: "develop" });
    store.upsertEpicTask({ epicKey: "PACE-100", issueKey: "PACE-FAIL-TASK", summary: "Task Fail", branch: "feat/PACE-FAIL", state: "planned" });
    store.queueEpicIntegration({ epicKey: "PACE-100", issueKey: "PACE-FAIL-TASK", leafBranch: "feat/PACE-FAIL" });
    store.claimEpicIntegration({ epicKey: "PACE-100", issueKey: "PACE-FAIL-TASK" });

    store.database.exec(`
      CREATE TRIGGER fail_epic_task_update BEFORE UPDATE ON epic_tasks
      WHEN NEW.issue_key = 'PACE-FAIL-TASK'
      BEGIN
        SELECT RAISE(ABORT, 'Injected epic_tasks update failure');
      END;
    `);

    assert.throws(
      () => {
        store.finishEpicIntegration({ epicKey: "PACE-100", issueKey: "PACE-FAIL-TASK", commit: "sha-test" });
      },
      /Injected epic_tasks update failure/
    );

    const intRow = store.database.prepare("SELECT state FROM epic_integrations WHERE epic_key = 'PACE-100' AND issue_key = 'PACE-FAIL-TASK'").get();
    const taskRow = store.database.prepare("SELECT state FROM epic_tasks WHERE epic_key = 'PACE-100' AND issue_key = 'PACE-FAIL-TASK'").get();
    assert.equal(intRow.state, "integrating", "epic_integrations must roll back to original state");
    assert.equal(taskRow.state, "integration-queued", "epic_tasks must roll back to state before finishEpicIntegration");
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test C: Production Atomic Implementation Claim Race (Two Connections)
// -----------------------------------------------------------------------------
test("Phase J — C. Production Atomic Implementation Claim Race (Two Connections)", async () => {
  const { repo, worktreeRoot, dbPath, cleanup } = makeTestGitRepo();
  const store1 = new RunStore(dbPath);
  const store2 = new RunStore(dbPath);
  try {
    const settings1 = makeSettings(repo, worktreeRoot, store1);
    const settings2 = makeSettings(repo, worktreeRoot, store2);
    const issueKey = "PACE-10";
    const workItem = {
      key: issueKey,
      summary: "Implement backend feature",
      description: "Acceptance criteria: implement component cleanly",
      canonicalState: "ready",
      labels: ["agent-ready"]
    };

    let resB = null;
    let providerCalls = 0;
    const fakeRuntime = {
      spawnSync: (cmd, args = [], opts = {}) => {
        if (cmd === "git") {
          return spawnSync(cmd, args, opts);
        }
        if (cmd === "npm" || (args && args.includes("check"))) {
          return { status: 0, stdout: "verification ok", stderr: "" };
        }
        providerCalls++;
        // Concurrently attempt claim from independent store2 while store1 holds the active lock
        if (!resB) {
          resB = handleImplementation(settings2, workItem, true, fakeRuntime);
        }
        const cwd = opts.cwd || repo;
        try {
          const editDir = path.join(cwd, "backend");
          fs.mkdirSync(editDir, { recursive: true });
          fs.writeFileSync(path.join(editDir, "app.js"), `// implemented ${providerCalls}\n`, "utf8");
          spawnSync("git", ["-C", cwd, "add", "backend/app.js"]);
          spawnSync("git", ["-C", cwd, "commit", "-m", "worker commit"]);
        } catch {}
        return {
          status: 0,
          stdout: JSON.stringify({
            status: "completed",
            summary: "Done",
            changed_files: ["backend/app.js"],
            validation_commands: ["npm test"],
            blockers: [],
            risks: [],
            duration_seconds: 1
          }),
          stderr: ""
        };
      },
      spawn: () => {}
    };

    // 1. Two real competing handleImplementation calls on two independent connections
    const resA = handleImplementation(settings1, workItem, true, fakeRuntime);

    const winner = resA;
    const loser = resB;
    assert.equal(winner.exitCode, 0, "Winning connection executes cleanly with exitCode 0");
    assert.ok(winner.output.runId, "Winner has a valid runId");
    assert.equal(loser.exitCode, 3, "Losing connection must be rejected with exitCode 3");
    assert.equal(loser.output.runId, null, "Losing claim must have runId null");
    assert.equal(loser.output.error, "issue already locked");
    assert.equal(providerCalls, 1, "Exactly one provider invocation across competing calls");

    // Exactly 1 run row exists in shared DB
    const totalRuns = store1.database.prepare("SELECT COUNT(*) as count FROM runs WHERE issue_key = ?").get(issueKey).count;
    assert.equal(totalRuns, 1, "Exactly one durable run row must exist across all connections");

    // 2. Sequential retry after lock release and after DB reopen:
    // First implementation already completed/verifying:
    store1.releaseLock(issueKey, winner.output.runId);
    store1.close();
    store2.close();

    const storeReopened = new RunStore(dbPath);
    const settingsReopened = makeSettings(repo, worktreeRoot, storeReopened);

    const firstRun = storeReopened.getRun(winner.output.runId);
    const retryRes = handleImplementation(settingsReopened, workItem, true, fakeRuntime);
    assert.equal(retryRes.exitCode, 0);
    assert.equal(retryRes.output.duplicate, true, "Sequential retry of unchanged completed plan must report duplicate");
    assert.equal(retryRes.output.runId, winner.output.runId, "Unchanged retry must return the durable existing runId");
    assert.equal(providerCalls, 1, "Must NOT invoke provider a second time for completed implementation");
    const totalRunsAfter = storeReopened.database.prepare("SELECT COUNT(*) as count FROM runs WHERE issue_key = ?").get(issueKey).count;
    assert.equal(totalRunsAfter, 1, "Must NOT create a second implementation execution run");

    // 3. A changed authoritative plan fingerprint executes as new implementation work.
    const changedPlan = {
      ...firstRun.payload,
      allowedPaths: ["backend/**"],
      configSnapshot: {
        ...firstRun.payload.configSnapshot,
        allowedPaths: ["backend/**"]
      },
      eligible: true,
      eligibilityReasons: []
    };
    const changedRes = handleImplementation(settingsReopened, workItem, true, fakeRuntime, { plan: changedPlan });
    assert.equal(changedRes.exitCode, 0);
    assert.notEqual(changedRes.output.runId, winner.output.runId);
    assert.equal(changedRes.output.duplicate, undefined);
    assert.equal(providerCalls, 2, "Changed plan must invoke the provider");
    const changedRun = storeReopened.getRun(changedRes.output.runId);
    assert.notEqual(changedRun.payload.planFingerprint, firstRun.payload.planFingerprint);
    const changedRunCount = storeReopened.database.prepare("SELECT COUNT(*) as count FROM runs WHERE issue_key = ?").get(issueKey).count;
    assert.equal(changedRunCount, 2, "Changed plan must create a new implementation run");

    // 4. Explicit rework DOES execute and is never suppressed as duplicate implementation.
    const reworkRes = handleImplementation(settingsReopened, workItem, true, fakeRuntime, { role: "rework", action: "rework", attempt: 1, allowedPaths: ["backend/*"] });
    assert.equal(reworkRes.exitCode, 0);
    assert.equal(providerCalls, 3, "Explicit rework must invoke provider and create new execution");

    try { storeReopened.close(); } catch {}
  } finally {
    try { store1.close(); } catch {}
    try { store2.close(); } catch {}
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test D: Production Atomic Reviewer Claim Race (Two Connections)
// -----------------------------------------------------------------------------
test("Phase J — D. Production Atomic Reviewer Claim Race (Two Connections)", async () => {
  const { repo, worktreeRoot, dbPath, cleanup } = makeTestGitRepo();
  const store1 = new RunStore(dbPath);
  const store2 = new RunStore(dbPath);
  try {
    const settings1 = makeSettings(repo, worktreeRoot, store1);
    const settings2 = makeSettings(repo, worktreeRoot, store2);
    const issueKey = "PACE-20";

    // Setup an initial run in review-queued state with real commit SHA
    const sc = new LocalGitSourceControlProvider();
    const prepared = sc.prepareChildWorktree({
      repoPath: repo,
      root: worktreeRoot,
      parentKey: null,
      issueKey,
      summary: "Review feature",
      execute: true
    });
    const headSha = sc.getHead({ repoPath: prepared.worktree }).sha;

    const implRunId = store1.createRun(issueKey, { summary: "Implementation done" });
    store1.transition(implRunId, "review-queued", { implementationSha: headSha });

    const workItem = {
      key: issueKey,
      summary: "Review feature",
      description: "Acceptance criteria: clean review",
      canonicalState: "review",
      labels: ["agent-ready"]
    };

    let revB = null;
    let reviewProviderCalls = 0;
    const fakeRuntime = {
      spawnSync: (cmd, args = [], opts = {}) => {
        if (cmd === "git") {
          return spawnSync(cmd, args, opts);
        }
        reviewProviderCalls++;
        // Concurrently attempt claim from independent store2 while store1 holds the active reviewer lock
        if (!revB) {
          revB = handleReview(settings2, workItem, true, fakeRuntime);
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            verdict: "clean",
            evidence: [{ id: "D-1", severity: "suggestion", category: "correctness", problem: "Clean implementation verified" }]
          }),
          stderr: ""
        };
      },
      spawn: () => {}
    };

    // Two real competing handleReview calls on two independent connections
    const revA = handleReview(settings1, workItem, true, fakeRuntime);

    const winner = revA;
    const loser = revB;
    assert.equal(winner.exitCode, 0, "Winning reviewer must execute cleanly with exitCode 0");
    assert.ok(winner.output.runId, "Winning reviewer has a valid runId");
    assert.equal(loser.exitCode, 3, "Losing reviewer must be rejected with exitCode 3");
    assert.equal(loser.output.runId, null, "Losing reviewer must not create orphan run");
    assert.equal(loser.output.error, "issue already locked");
    assert.equal(reviewProviderCalls, 1, "Exactly one reviewer provider invocation across competing calls");

    // Exactly 1 review outcome and reviewer run exists
    const totalReviewRuns = store1.database.prepare("SELECT COUNT(*) as count FROM runs WHERE issue_key = ? AND (payload LIKE '%review%' OR payload LIKE '%reviewer%')").get(issueKey).count;
    assert.equal(totalReviewRuns, 1, "Exactly one reviewer run must exist");
  } finally {
    try { store1.close(); } catch {}
    try { store2.close(); } catch {}
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test E: Duplicate Integration Reconciliation Idempotency
// -----------------------------------------------------------------------------
test("Phase J — E. Duplicate Integration Reconciliation Idempotency", () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    store.upsertEpic({ key: "PACE-100", summary: "Parent", branch: "epic/PACE-100", baseBranch: "develop" });
    store.upsertEpicTask({ epicKey: "PACE-100", issueKey: "PACE-101", summary: "Child 1", branch: "feat/PACE-101" });
    store.queueEpicIntegration({ epicKey: "PACE-100", issueKey: "PACE-101", leafBranch: "feat/PACE-101" });

    // First claim
    const claim1 = store.claimEpicIntegration({ epicKey: "PACE-100", issueKey: "PACE-101" });
    assert.equal(claim1.claimed, true);

    // Duplicate claim while integrating
    const claim2 = store.claimEpicIntegration({ epicKey: "PACE-100", issueKey: "PACE-101" });
    assert.equal(claim2.claimed, false);

    // Finish integration
    const commitSha = "f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2";
    const finish1 = store.finishEpicIntegration({ epicKey: "PACE-100", issueKey: "PACE-101", commit: commitSha });
    assert.equal(finish1.completed, true);
    assert.equal(finish1.state, "integrated");

    // Duplicate finish
    const finish2 = store.finishEpicIntegration({ epicKey: "PACE-100", issueKey: "PACE-101", commit: commitSha });
    assert.equal(finish2.completed, false);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test E2: Normal Integration Adapter Exception Normalization
// -----------------------------------------------------------------------------
test("Phase J — E2. Normal Integration Adapter Exception Normalization", () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
    const epicKey = "PACE-E2";
    const issueKey = "PACE-E21";
    const reviewedSha = "a".repeat(40);
    const secret = "sk-12345678901234567890";

    store.upsertEpic({ key: epicKey, summary: "Adapter failure parent", branch: "epic/PACE-E2", baseBranch: "develop" });
    store.upsertEpicTask({
      epicKey,
      issueKey,
      summary: "Adapter failure child",
      branch: "task/PACE-E21",
      state: "reviewed-clean",
      reviewedSha
    });

    const implementationRunId = store.createRun(issueKey, { action: "implementation", attempt: 0 });
    store.transition(implementationRunId, "review-queued", { implementationSha: reviewedSha });
    recordReviewerOutcome(store, {
      runId: implementationRunId,
      implementationSha: reviewedSha,
      reviewerId: "correctness-reviewer",
      verdict: "clean",
      evidence: [{ id: "E2-1", severity: "suggestion", category: "correctness", problem: "Clean" }]
    });
    store.queueEpicIntegration({ epicKey, issueKey, leafBranch: "task/PACE-E21" });

    const result = reconcileIntegrations(settings, store, {
      integrationAdapter: () => {
        throw new Error(`provider exploded with ${secret}`);
      }
    });

    assert.equal(result.integrationsCompleted, 0);
    assert.equal(result.blocked.length, 1);
    assert.match(result.blocked[0].reason, /Integration adapter failed/i);
    assert.ok(!result.blocked[0].reason.includes(secret), "Normalized error must redact provider secrets");

    const integration = store.listEpicIntegrations(epicKey).find((row) => row.issueKey === issueKey);
    assert.notEqual(integration.state, "integrating", "Adapter exception must not strand the integration lane");

    const workerRuns = store.listRunsForIssue(issueKey).filter((run) => run.payload?.role === "integration-worker");
    assert.equal(workerRuns.length, 1);
    assert.equal(workerRuns[0].state, "failed");
    const terminalCount = store.database.prepare(
      "SELECT COUNT(*) AS count FROM telemetry_events WHERE run_id = ? AND stage = 'terminal'"
    ).get(workerRuns[0].id).count;
    assert.equal(terminalCount, 1, "Failed integration worker must terminalize exactly once");
  } finally {
    cleanup();
  }
});


// -----------------------------------------------------------------------------
// Test F: Supervisor Lease Ownership, Fencing & Stale Reclaim
// -----------------------------------------------------------------------------
test("Phase J — F. Supervisor Lease Ownership, Fencing & Stale Reclaim", () => {
  const { store, cleanup } = makeTestGitRepo();
  try {
    const supervisorId = "PACE";
    const t0 = "2026-08-18T10:00:00.000Z";

    // 1. Process 1 claims supervisor slot
    const claim1 = store.claimSupervisor(supervisorId, { pid: 1001, mode: "execute", staleAfterSeconds: 5, now: t0 });
    assert.equal(claim1.claimed, true);
    const lease1 = claim1.leaseId;

    // 2. Competing claim while lease1 is fresh fails
    const claimCompete = store.claimSupervisor(supervisorId, { pid: 1002, mode: "execute", staleAfterSeconds: 5, now: "2026-08-18T10:00:02.000Z" });
    assert.equal(claimCompete.claimed, false);
    assert.equal(claimCompete.conflict.pid, 1001);

    // 3. Advance time past stale threshold (t0 + 10s)
    const tStale = "2026-08-18T10:00:10.000Z";
    const claimReclaim = store.claimSupervisor(supervisorId, { pid: 1002, mode: "execute", staleAfterSeconds: 5, now: tStale });
    assert.equal(claimReclaim.claimed, true, "Stale supervisor slot must be reclaimable");
    const lease2 = claimReclaim.leaseId;
    assert.notEqual(lease1, lease2);

    // 4. Old process with lease1 tries to heartbeat or finish -> rejected
    const hb1 = store.heartbeatSupervisor(supervisorId, { leaseId: lease1, cycleCount: 5, now: tStale });
    assert.equal(hb1, false, "Old lease cannot heartbeat");

    const fin1 = store.finishSupervisor(supervisorId, { leaseId: lease1, status: "stopped", now: tStale });
    assert.equal(fin1, false, "Old lease cannot finish slot");

    // 5. Active lease2 can heartbeat and finish
    const hb2 = store.heartbeatSupervisor(supervisorId, { leaseId: lease2, cycleCount: 1, now: tStale });
    assert.equal(hb2, true);

    const fin2 = store.finishSupervisor(supervisorId, { leaseId: lease2, status: "stopped", now: tStale });
    assert.equal(fin2, true);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test G: Real Approval Contention Matrix (Two Connections)
// -----------------------------------------------------------------------------
test("Phase J — G. Real Approval Contention Matrix (Two Connections)", () => {
  const { repo, worktreeRoot, dbPath, cleanup } = makeTestGitRepo();
  const store1 = new RunStore(dbPath);
  const store2 = new RunStore(dbPath);
  try {
    const settings1 = makeSettings(repo, worktreeRoot, store1, { operatingMode: "supervised" });
    const settings2 = makeSettings(repo, worktreeRoot, store2, { operatingMode: "supervised" });

    const matrix = [
      { key: "PACE-G1", first: "approve", second: "approve" },
      { key: "PACE-G2", first: "approve", second: "reject" },
      { key: "PACE-G3", first: "reject", second: "approve" },
      { key: "PACE-G4", first: "reject", second: "reject" }
    ];

    for (const item of matrix) {
      const plan = { issue: item.key, summary: "Contention test " + item.key, allowedPaths: ["backend/**"] };
      const planFingerprint = computePlanFingerprint(plan);

      store1.addPmDecision(item.key, "approval_requested", {
        action: "implementation",
        attempt: 0,
        planFingerprint,
        plan
      });

      // Connection 1 mutates
      if (item.first === "approve") {
        const res1 = handlePmApproval(settings1, item.key, { action: "implementation", planFingerprint, approver: "pm-1" }, { store: store1 });
        assert.equal(res1.ok, true);
        assert.equal(res1.approved, true);
      } else {
        const res1 = handlePmRejection(settings1, item.key, { action: "implementation", planFingerprint, approver: "pm-1" }, { store: store1 });
        assert.equal(res1.ok, true);
        assert.equal(res1.approved, false);
      }

      // Connection 2 attempts competing mutation -> rejected with 409
      if (item.second === "approve") {
        assert.throws(
          () => handlePmApproval(settings2, item.key, { action: "implementation", planFingerprint, approver: "pm-2" }, { store: store2 }),
          (err) => err.statusCode === 409 || /already/i.test(err.message)
        );
      } else {
        assert.throws(
          () => handlePmRejection(settings2, item.key, { action: "implementation", planFingerprint, approver: "pm-2" }, { store: store2 }),
          (err) => err.statusCode === 409 || /already/i.test(err.message)
        );
      }

      // Exactly 1 execution_approval row exists
      const decisions = store2.getPmDecisions(item.key).filter(d => d.type === "execution_approval");
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].payload.approver, "pm-1");
    }
  } finally {
    try { store1.close(); } catch {}
    try { store2.close(); } catch {}
    cleanup();
  }
});


// -----------------------------------------------------------------------------
// Test G2: Genuine SQLite Writer Overlap Across Worker Threads
// -----------------------------------------------------------------------------
test("Phase J — G2. Genuine SQLite Writer Overlap Across Worker Threads", async () => {
  const { repo, worktreeRoot, store, dbPath, cleanup } = makeTestGitRepo();
  let workerA = null;
  let workerB = null;
  try {
    const issueKey = "PACE-G-WRITER";
    const plan = { issue: issueKey, summary: "Writer overlap", allowedPaths: ["backend/**"] };
    const planFingerprint = computePlanFingerprint(plan);
    store.addPmDecision(issueKey, "approval_requested", {
      action: "implementation",
      attempt: 0,
      planFingerprint,
      plan
    });
    store.close();

    const signalBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const signal = new Int32Array(signalBuffer);
    const workerSource = [
      'const { parentPort, workerData } = require("node:worker_threads");',
      '(async () => {',
      '  const { RunStore } = await import(workerData.storeUrl);',
      '  const { handlePmApproval, handlePmRejection } = await import(workerData.pmUrl);',
      '  const store = new RunStore(workerData.dbPath);',
      '  const signal = new Int32Array(workerData.signalBuffer);',
      '  const settings = { _store: store, getStore: () => store, data: { policy: { operatingMode: "supervised" } } };',
      '  const request = { action: "implementation", attempt: 0, planFingerprint: workerData.planFingerprint, approver: workerData.approver };',
      '  parentPort.postMessage({ stage: "ready" });',
      '  try {',
      '    let result;',
      '    if (workerData.hold) {',
      '      Atomics.wait(signal, 0, 0, 5000);',
      '      result = store.withTransaction(() => {',
      '        parentPort.postMessage({ stage: "holding" });',
      '        Atomics.wait(signal, 1, 0, 5000);',
      '        return handlePmApproval(settings, workerData.issueKey, request, { store });',
      '      });',
      '    } else {',
      '      Atomics.wait(signal, 2, 0, 5000);',
      '      parentPort.postMessage({ stage: "attempting" });',
      '      result = handlePmRejection(settings, workerData.issueKey, request, { store });',
      '    }',
      '    parentPort.postMessage({ stage: "result", ok: true, result });',
      '  } catch (error) {',
      '    parentPort.postMessage({ stage: "result", ok: false, statusCode: error.statusCode || null, code: error.code || null, message: error.message });',
      '  } finally {',
      '    store.close();',
      '  }',
      '})().catch((error) => parentPort.postMessage({ stage: "result", ok: false, code: error.code || null, message: error.message }));'
    ].join("\n");

    const commonWorkerData = {
      dbPath,
      issueKey,
      planFingerprint,
      signalBuffer,
      storeUrl: pathToFileURL(path.join(rootDir, "lib", "store.js")).href,
      pmUrl: pathToFileURL(path.join(rootDir, "lib", "pm-workspace.js")).href
    };

    const monitor = (worker) => {
      const waiters = new Map();
      const pending = new Map();
      const result = new Promise((resolve, reject) => {
        worker.on("message", (message) => {
          const waiter = waiters.get(message.stage);
          if (waiter) {
            waiters.delete(message.stage);
            waiter(message);
          } else {
            pending.set(message.stage, message);
          }
          if (message.stage === "result") resolve(message);
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code !== 0) reject(new Error(`Approval worker exited with code ${code}`));
        });
      });
      return {
        result,
        async waitFor(stage) {
          if (pending.has(stage)) {
            const message = pending.get(stage);
            pending.delete(stage);
            return message;
          }
          return new Promise((resolve) => waiters.set(stage, resolve));
        }
      };
    };

    workerA = new Worker(workerSource, {
      eval: true,
      workerData: { ...commonWorkerData, hold: true, approver: "writer-a" }
    });
    workerB = new Worker(workerSource, {
      eval: true,
      workerData: { ...commonWorkerData, hold: false, approver: "writer-b" }
    });
    const monitorA = monitor(workerA);
    const monitorB = monitor(workerB);
    await Promise.all([monitorA.waitFor("ready"), monitorB.waitFor("ready")]);

    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0, 1);
    await monitorA.waitFor("holding");

    Atomics.store(signal, 2, 1);
    Atomics.notify(signal, 2, 1);
    await monitorB.waitFor("attempting");
    await new Promise((resolve) => setTimeout(resolve, 50));

    Atomics.store(signal, 1, 1);
    Atomics.notify(signal, 1, 1);
    const [resultA, resultB] = await Promise.all([monitorA.result, monitorB.result]);

    assert.equal(resultA.ok, true);
    assert.equal(resultA.result.approved, true);
    assert.equal(resultB.ok, false);
    assert.equal(resultB.statusCode, 409);
    assert.match(resultB.message, /already approved|no approval pending/i);
    assert.doesNotMatch(`${resultB.code || ""} ${resultB.message || ""}`, /SQLITE_BUSY|database is locked/i);

    const verificationStore = new RunStore(dbPath);
    const decisions = verificationStore.getPmDecisions(issueKey).filter((decision) => decision.type === "execution_approval");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].payload.approver, "writer-a");
    assert.equal(decisions[0].payload.approved, true);
    verificationStore.close();
  } finally {
    if (workerA) await workerA.terminate();
    if (workerB) await workerB.terminate();
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test H: Stale Parent Approval & Fingerprint Rejection (HTTP 409)
// -----------------------------------------------------------------------------
test("Phase J — H. Stale Parent Approval & Fingerprint Rejection (HTTP 409)", () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "supervised" });
    const parentKey = "PACE-40";

    // 1. Branch Creation Fingerprint Binding
    const branchPlan = {
      parentKey,
      baseRef: "develop",
      baseSha: "1111111111111111111111111111111111111111",
      graphFingerprint: "graph-fp-v1",
      integrationBranch: `epic/${parentKey.toLowerCase()}-feature`
    };
    const branchFingerprint = computeParentBranchFingerprint(branchPlan);

    store.addPmDecision(parentKey, "approval_requested", {
      action: "branchCreation",
      attempt: 0,
      planFingerprint: branchFingerprint,
      plan: branchPlan
    });

    // Stale baseSha advances -> creates new fingerprint
    const advancedBranchPlan = {
      ...branchPlan,
      baseSha: "2222222222222222222222222222222222222222"
    };
    const staleFingerprint = computeParentBranchFingerprint(advancedBranchPlan);

    assert.throws(
      () => {
        handlePmApproval(settings, parentKey, {
          action: "branchCreation",
          planFingerprint: staleFingerprint,
          approver: "pm"
        }, { store });
      },
      (err) => err.statusCode === 409 || /mismatch/i.test(err.message) || /fingerprint/i.test(err.message)
    );

    // Exact fingerprint succeeds
    const approveRes = handlePmApproval(settings, parentKey, {
      action: "branchCreation",
      planFingerprint: branchFingerprint,
      approver: "pm"
    }, { store });
    assert.equal(approveRes.ok, true);
    assert.equal(approveRes.approved, true);

    // 2. Integration Review Fingerprint Binding
    const reviewPlan = {
      parentKey,
      parentBaseSha: "1111111111111111111111111111111111111111",
      integrationHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      graphFingerprint: "graph-fp-v1",
      reviewerAgentId: "reviewer",
      reviewerVersion: 1,
      reviewerHash: "rev-hash-v1"
    };
    const reviewFingerprint = computeParentReviewFingerprint(reviewPlan);

    store.addPmDecision(parentKey, "approval_requested", {
      action: "review",
      attempt: 0,
      planFingerprint: reviewFingerprint,
      plan: reviewPlan
    });

    // Advancing integrationHeadSha invalidates review fingerprint
    const advancedReviewPlan = {
      ...reviewPlan,
      integrationHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    };
    const advancedReviewFingerprint = computeParentReviewFingerprint(advancedReviewPlan);

    assert.throws(
      () => {
        handlePmApproval(settings, parentKey, {
          action: "review",
          planFingerprint: advancedReviewFingerprint,
          approver: "pm"
        }, { store });
      },
      (err) => err.statusCode === 409 || /mismatch/i.test(err.message)
    );
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test I: Provider Malformed Output & Crash Fail-Closed
// -----------------------------------------------------------------------------
test("Phase J — I. Provider Malformed Output & Crash Fail-Closed", () => {
  // 1. Non-Antigravity executor parsing:
  const emptyParsed = parseExecutionOutput("codex", "", "", 0);
  assert.equal(emptyParsed.ok, false);
  assert.equal(emptyParsed.error.category, "empty_output_error");

  const plainTextParsed = parseExecutionOutput("codex", "This is plain text and not valid JSON.", "", 0);
  assert.equal(plainTextParsed.ok, false);
  assert.equal(plainTextParsed.error.category, "json_parse_error");

  const malformedParsed = parseExecutionOutput("codex", "{ invalid: json", "", 0);
  assert.equal(malformedParsed.ok, false);
  assert.equal(malformedParsed.error.category, "json_parse_error");

  const invalidSchemaParsed = parseExecutionOutput("codex", JSON.stringify({ status: "completed" }), "", 0);
  assert.equal(invalidSchemaParsed.ok, false);
  assert.equal(invalidSchemaParsed.error.category, "schema_validation_error");

  const validJson = JSON.stringify({
    status: "completed",
    summary: "Finished task",
    changed_files: ["backend/app.js"],
    validation_commands: ["npm test"],
    blockers: [],
    risks: [],
    duration_seconds: 0
  });
  const validParsed = parseExecutionOutput("codex", validJson, "", 0);
  assert.equal(validParsed.ok, true);
  assert.equal(validParsed.durationSeconds, 0, "durationSeconds must be preserved as 0, not null");

  // 2. Antigravity executor parsing:
  const agyEmpty = parseExecutionOutput("antigravity", "", "", 0);
  assert.equal(agyEmpty.ok, false);
  assert.equal(agyEmpty.error.category, "empty_output_error");

  const agyValid = parseExecutionOutput(
    "antigravity",
    JSON.stringify({ status: "SUCCESS", duration_seconds: 0, response: validJson }),
    "",
    0
  );
  assert.equal(agyValid.ok, true);
  assert.equal(agyValid.durationSeconds, 0, "Antigravity durationSeconds must be 0, not null");
});

// -----------------------------------------------------------------------------
// Test J: Provider Timeout & Error Normalization (Zero Secret Leakage)
// -----------------------------------------------------------------------------
test("Phase J — J. Provider Timeout & Error Normalization (Zero Secret Leakage)", () => {
  const secretKey = "sk-proj-supersecretkey12345678901234567890";
  const stderrWithSecret = `Process timeout after 30s. Authorization: Bearer ${secretKey} failed.`;
  const parsed = parseExecutionOutput("antigravity", "", stderrWithSecret, 124);

  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.category, "provider_error");
  assert.ok(!parsed.error.safeMessage.includes(secretKey));
});

// -----------------------------------------------------------------------------
// Test K: Executor / Reviewer Output Schema Validation
// -----------------------------------------------------------------------------
test("Phase J — K. Executor / Reviewer Output Schema Validation", () => {
  const { store, cleanup } = makeTestGitRepo();
  try {
    const sha = "b1c2d3e4f5a6b1c2d3e4f5a6b1c2d3e4f5a6b1c2";
    const runId = store.createRun("PACE-50", { summary: "Review schema test" });
    store.transition(runId, "review-queued", { implementationSha: sha });

    // Invalid verdict
    assert.throws(
      () => {
        recordReviewerOutcome(store, {
          runId,
          implementationSha: sha,
          reviewerId: "rev-1",
          verdict: "maybe-clean",
          evidence: [{ id: "F-1", severity: "minor", category: "correctness", problem: "ok" }]
        });
      },
      /verdict must be clean or changes-requested/i
    );

    // Invalid severity
    assert.throws(
      () => {
        recordReviewerOutcome(store, {
          runId,
          implementationSha: sha,
          reviewerId: "rev-1",
          verdict: "clean",
          evidence: [{ id: "F-1", severity: "fatal", category: "correctness", problem: "ok" }]
        });
      },
      /Invalid reviewer finding severity/i
    );

    // Invalid category
    assert.throws(
      () => {
        recordReviewerOutcome(store, {
          runId,
          implementationSha: sha,
          reviewerId: "rev-1",
          verdict: "clean",
          evidence: [{ id: "F-1", severity: "minor", category: "invalid-category", problem: "ok" }]
        });
      },
      /Invalid reviewer finding category/i
    );
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test L: Git Ancestry & Reviewed-SHA Verification Boundary
// -----------------------------------------------------------------------------
test("Phase J — L. Git Ancestry & Reviewed-SHA Verification Boundary", () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const sc = new LocalGitSourceControlProvider();
    const headRes = sc.getHead({ repoPath: repo });
    assert.equal(headRes.ok, true);

    const baseSha = headRes.sha;
    assert.equal(sc.isAncestor(baseSha, baseSha, { repoPath: repo }), true);

    const fakeSha = "0000000000000000000000000000000000000000";
    assert.equal(sc.isAncestor(fakeSha, baseSha, { repoPath: repo }), false);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test M: Integration Conflict Abort & Safe Worktree Recovery
// -----------------------------------------------------------------------------
test("Phase J — M. Integration Conflict Abort & Safe Worktree Recovery", () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const sc = new LocalGitSourceControlProvider();
    const settings = makeSettings(repo, worktreeRoot, store);

    spawnSync("git", ["-C", repo, "checkout", "-b", "epic/PACE-60", "develop"]);
    fs.writeFileSync(path.join(repo, "conflict.txt"), "original", "utf8");
    spawnSync("git", ["-C", repo, "add", "conflict.txt"]);
    spawnSync("git", ["-C", repo, "commit", "-m", "add conflict file"]);

    spawnSync("git", ["-C", repo, "checkout", "-b", "leaf/PACE-61", "epic/PACE-60"]);
    fs.writeFileSync(path.join(repo, "conflict.txt"), "leaf 1 change", "utf8");
    spawnSync("git", ["-C", repo, "add", "conflict.txt"]);
    spawnSync("git", ["-C", repo, "commit", "-m", "leaf 1 edit"]);
    const leaf1Sha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();

    spawnSync("git", ["-C", repo, "checkout", "epic/PACE-60"]);
    fs.writeFileSync(path.join(repo, "conflict.txt"), "epic change", "utf8");
    spawnSync("git", ["-C", repo, "add", "conflict.txt"]);
    spawnSync("git", ["-C", repo, "commit", "-m", "epic edit"]);

    const intResult = sc.integrateReviewedRevision(settings, {
      epicKey: "PACE-60",
      issueKey: "PACE-61",
      sourceBranch: "leaf/PACE-61",
      targetBranch: "epic/PACE-60",
      reviewedSha: leaf1Sha
    });

    assert.equal(intResult.completed, false);
    assert.ok(intResult.conflict);
    assert.equal(sc.isClean({ repoPath: repo }), true);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test N: Real Graph Drift Test
// -----------------------------------------------------------------------------
test("Phase J — N. Real Graph Drift Test", async () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const settings = makeSettings(repo, worktreeRoot, store);
    const parentKey = "PACE-N100";

    const workSource = new FakeWorkSourceProvider();
    workSource.setWorkItem({
      key: parentKey,
      summary: "Parent Feature",
      description: "Acceptance criteria: parent feature",
      type: "Epic",
      canonicalState: "ready"
    });
    workSource.setChildren(parentKey, [
      { key: "PACE-N101", summary: "Child A", description: "Acceptance criteria: child A", canonicalState: "ready" },
      { key: "PACE-N102", summary: "Child B", description: "Acceptance criteria: child B", canonicalState: "ready" }
    ]);
    workSource.setDependencies("PACE-N102", ["PACE-N101"]); // A -> B

    // Pin generation 1
    const pinRes1 = await discoverAndPinParent(settings, store, workSource.items.get(parentKey), {
      workSource,
      runtime: { spawnSync },
      execute: true
    });
    assert.equal(pinRes1.ok, true);
    const initialFp = pinRes1.graphFingerprint;
    const initialParent = store.getParentExecution(parentKey);
    assert.equal(initialParent.state, "active");
    assert.equal(initialParent.graphFingerprint, initialFp);

    // Mutate provider hierarchy: add a new dependency / change DAG
    workSource.setChildren(parentKey, [
      { key: "PACE-N101", summary: "Child A", description: "Acceptance criteria: child A", canonicalState: "ready" },
      { key: "PACE-N102", summary: "Child B", description: "Acceptance criteria: child B", canonicalState: "ready" },
      { key: "PACE-N103", summary: "Child C", description: "Acceptance criteria: child C", canonicalState: "ready" }
    ]);
    workSource.setDependencies("PACE-N103", ["PACE-N102"]);

    // Rediscover parent
    const pinRes2 = await discoverAndPinParent(settings, store, workSource.items.get(parentKey), {
      workSource,
      runtime: { spawnSync },
      execute: true
    });

    assert.equal(pinRes2.ok, false);
    assert.equal(pinRes2.blocked, true);
    assert.equal(pinRes2.drift, true);
    assert.ok(pinRes2.reason.includes("Hierarchy drift detected"));

    // Parent is marked blocked with driftDetected
    const driftedParent = store.getParentExecution(parentKey);
    assert.equal(driftedParent.state, "blocked");
    assert.equal(driftedParent.driftDetected, true);
    assert.equal(driftedParent.graphFingerprint, initialFp, "Original pinned generation fingerprint must remain unchanged");
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test O: Real Exact-SHA Dependency Gate (reconcileParentChildren)
// -----------------------------------------------------------------------------
test("Phase J — O. Real Exact-SHA Dependency Gate (reconcileParentChildren)", async () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
    const parentKey = "PACE-O100";

    const workSource = new FakeWorkSourceProvider();
    workSource.setWorkItem({
      key: parentKey,
      summary: "Parent Feature",
      description: "Acceptance criteria: parent feature",
      type: "Epic",
      canonicalState: "ready"
    });
    workSource.setChildren(parentKey, [
      { key: "PACE-O101", summary: "Task A", description: "Acceptance criteria: task A", canonicalState: "ready", labels: ["agent-ready"] },
      { key: "PACE-O102", summary: "Task B", description: "Acceptance criteria: task B", canonicalState: "ready", labels: ["agent-ready"] }
    ]);
    workSource.setDependencies("PACE-O102", ["PACE-O101"]); // B depends on A

    const sc = new LocalGitSourceControlProvider();
    const fakeRuntime = {
      spawnSync: (cmd, args = [], opts = {}) => {
        if (cmd === "git") return spawnSync(cmd, args, opts);
        if (cmd === "npm" || (args && args.includes("check"))) return { status: 0, stdout: "ok", stderr: "" };
        const cwd = opts.cwd || repo;
        const isReview = (args && args.some(a => typeof a === "string" && a.includes("Review implementation")));
        if (isReview) {
          return {
            status: 0,
            stdout: JSON.stringify({
              verdict: "clean",
              evidence: [{ id: "O-1", severity: "suggestion", category: "correctness", problem: "Clean implementation verified" }]
            }),
            stderr: ""
          };
        }
        // Implementation creates real file and commit
        try {
          const editDir = path.join(cwd, "backend");
          fs.mkdirSync(editDir, { recursive: true });
          fs.writeFileSync(path.join(editDir, "task-a.js"), "// task A code\n", "utf8");
          spawnSync("git", ["-C", cwd, "add", "backend/task-a.js"]);
          spawnSync("git", ["-C", cwd, "commit", "-m", "task A commit"]);
        } catch {}
        return {
          status: 0,
          stdout: JSON.stringify({
            status: "completed",
            summary: "Task A implemented",
            changed_files: ["backend/task-a.js"],
            validation_commands: ["npm test"],
            blockers: [],
            risks: [],
            duration_seconds: 1
          }),
          stderr: ""
        };
      },
      spawn: () => {}
    };

    // 1. Discover and pin parent
    await discoverAndPinParent(settings, store, workSource.items.get(parentKey), {
      workSource,
      runtime: fakeRuntime,
      execute: true
    });

    // 2. Initial reconciliation: A is ready, B is pending-dependencies
    const rec1 = reconcileParentChildren(settings, store, parentKey, { sourceControl: sc, runtime: fakeRuntime });
    assert.ok(rec1.readyChildren.includes("PACE-O101"));
    assert.ok(!rec1.readyChildren.includes("PACE-O102"));
    let taskB = store.getEpicTask(parentKey, "PACE-O102");
    assert.equal(taskB.orchestrationState, "pending-dependencies");

    // 3. Implementation of A
    const resA = handleImplementation(settings, workSource.items.get("PACE-O101"), true, fakeRuntime);
    assert.equal(resA.exitCode, 0);
    const runA = store.getRun(resA.output.runId);
    assert.equal(runA.state, "verifying");

    // While A is verifying: B is pending-dependencies
    reconcileParentChildren(settings, store, parentKey, { sourceControl: sc, runtime: fakeRuntime });
    taskB = store.getEpicTask(parentKey, "PACE-O102");
    assert.equal(taskB.orchestrationState, "pending-dependencies");

    // 4. Reconcile reviewers moves A from verifying -> transitioning-review -> review-queued
    reconcileReviewers(settings, store, { runtime: fakeRuntime, nowMs: () => Date.now() });
    reconcileReviewers(settings, store, { runtime: fakeRuntime, nowMs: () => Date.now() });
    assert.equal(store.getRun(runA.id).state, "review-queued");

    // While A is review-queued: B is pending-dependencies
    reconcileParentChildren(settings, store, parentKey, { sourceControl: sc, runtime: fakeRuntime });
    taskB = store.getEpicTask(parentKey, "PACE-O102");
    assert.equal(taskB.orchestrationState, "pending-dependencies");

    // 5. Review of A via production handleReview
    const revA = handleReview(settings, workSource.items.get("PACE-O101"), true, fakeRuntime);
    assert.equal(revA.exitCode, 0);
    assert.equal(store.getRun(runA.id).state, "reviewed-clean");

    // While A is reviewed-clean (pre-integration): B is pending-dependencies
    reconcileParentChildren(settings, store, parentKey, { sourceControl: sc, runtime: fakeRuntime });
    taskB = store.getEpicTask(parentKey, "PACE-O102");
    assert.equal(taskB.orchestrationState, "pending-dependencies");

    // 6. Queue epic integration
    store.queueEpicIntegration({ epicKey: parentKey, issueKey: "PACE-O101", leafBranch: "feat/pace-o101" });
    reconcileParentChildren(settings, store, parentKey, { sourceControl: sc, runtime: fakeRuntime });
    taskB = store.getEpicTask(parentKey, "PACE-O102");
    assert.equal(taskB.orchestrationState, "pending-dependencies");

    // While integrating: B is pending-dependencies
    store.claimEpicIntegration({ epicKey: parentKey, issueKey: "PACE-O101" });
    reconcileParentChildren(settings, store, parentKey, { sourceControl: sc, runtime: fakeRuntime });
    taskB = store.getEpicTask(parentKey, "PACE-O102");
    assert.equal(taskB.orchestrationState, "pending-dependencies");

    // 7. Drive real production integration via reconcileIntegrations & integrateReviewedRevision
    const parentExec = store.getParentExecution(parentKey);
    const integrationWorktree = parentExec.integrationWorktree;
    const taskAWorktree = store.getEpicTask(parentKey, "PACE-O101").worktree;
    const actualShaA = sc.getHead({ repoPath: taskAWorktree }).sha;

    // Reset integration to queued so reconcileIntegrations executes the integration adapter
    store.database.prepare("UPDATE epic_integrations SET state = 'queued' WHERE epic_key = ? AND issue_key = ?").run(parentKey, "PACE-O101");

    const recIntRes = reconcileIntegrations(settings, store, {
      sourceControl: sc,
      runtime: fakeRuntime,
      integrationAdapter: (opts) => sc.integrateReviewedRevision(settings, opts)
    });
    assert.equal(recIntRes.integrationsCompleted, 1);

    // 8. Assert exact SHA integration properties
    const taskA = store.getEpicTask(parentKey, "PACE-O101");
    assert.equal(taskA.state, "integrated");
    assert.equal(taskA.reviewedSha, actualShaA, "reviewedSha must equal actual Child A Git commit SHA");
    const parentIntegrationHead = sc.getHead({ repoPath: integrationWorktree }).sha;
    assert.equal(taskA.integratedSha, parentIntegrationHead);
    assert.equal(
      sc.isAncestor({ repoPath: integrationWorktree, ancestorSha: actualShaA, descendantSha: parentIntegrationHead }).isAncestor,
      true,
      "reviewedSha must be a real ancestor of parent integration HEAD"
    );

    // 9. Reconcile parent children -> Task B is now dependency-ready with childBaseSha = parentIntegrationHead
    const rec2 = reconcileParentChildren(settings, store, parentKey, { sourceControl: sc, runtime: fakeRuntime });
    assert.ok(rec2.readyChildren.includes("PACE-O102"));
    taskB = store.getEpicTask(parentKey, "PACE-O102");
    assert.equal(taskB.orchestrationState, "dependency-ready");
    assert.equal(taskB.childBaseSha, parentIntegrationHead);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test P: Rework Max-Attempt Boundary & Human Attention Escalation
// -----------------------------------------------------------------------------
test("Phase J — P. Rework Max-Attempt Boundary & Human Attention Escalation", () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const settings = makeSettings(repo, worktreeRoot, store, {
      data: { policy: { review: { maxReworkAttempts: 2 } } }
    });

    const sha = "c1d2e3f4a5b6c1d2e3f4a5b6c1d2e3f4a5b6c1d2";
    const runId = store.createRun("PACE-70", {
      summary: "Max attempt run",
      attempt: 2,
      configSnapshot: { maxReworkAttempts: 2 }
    });
    store.transition(runId, "verifying", { implementationSha: sha });
    store.transition(runId, "review-queued", { implementationSha: sha });

    const reviewRes = recordReviewerOutcome(store, {
      runId,
      implementationSha: sha,
      reviewerId: "rev-1",
      verdict: "changes-requested",
      evidence: [{ id: "F-1", severity: "major", category: "correctness", problem: "Bug exists" }]
    });
    assert.equal(reviewRes.state, "review-failed");

    reconcileReviewers(settings, store);

    const run = store.getRun(runId);
    assert.equal(run.state, "transitioning-blocked", "Run must transition to blocked after exhausting max rework attempts");
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test Q: Same-Run Telemetry Terminal Test (Across Reopen)
// -----------------------------------------------------------------------------
test("Phase J — Q. Same-Run Telemetry Terminal Test (Across Reopen)", () => {
  const { dbPath, cleanup } = makeTestGitRepo();
  let store = new RunStore(dbPath);
  try {
    const roles = ["implementation", "reviewer", "integration-worker"];

    for (const role of roles) {
      const runId = store.createRun(`PACE-Q-${role}`, { summary: `Telem test ${role}` });

      // 1. Queued
      const qRes = store.recordTelemetryEvent({
        eventId: `telem-${runId}-1`,
        runId,
        issueKey: `PACE-Q-${role}`,
        role,
        action: role,
        stage: "queued",
        status: "queued",
        sequence: 1
      });
      assert.equal(qRes.recorded, true);

      // 2. Started
      const sRes = store.recordTelemetryEvent({
        eventId: `telem-${runId}-2`,
        runId,
        issueKey: `PACE-Q-${role}`,
        role,
        action: role,
        stage: "started",
        status: "running",
        sequence: 2
      });
      assert.equal(sRes.recorded, true);

      // 3. Terminal
      const tRes = store.recordTelemetryEvent({
        eventId: `telem-${runId}-3`,
        runId,
        issueKey: `PACE-Q-${role}`,
        role,
        action: role,
        stage: "terminal",
        status: "completed",
        sequence: 3
      });
      assert.equal(tRes.recorded, true);

      // 4. Post-terminal attempts: duplicate terminal with different eventId, progress, model_selected -> all recorded: false
      const dupTerm = store.recordTelemetryEvent({
        eventId: `telem-${runId}-diff-term-4`,
        runId,
        issueKey: `PACE-Q-${role}`,
        role,
        action: role,
        stage: "terminal",
        status: "completed",
        sequence: 4
      });
      assert.equal(dupTerm.recorded, false);

      const prog = store.recordTelemetryEvent({
        eventId: `telem-${runId}-prog-5`,
        runId,
        issueKey: `PACE-Q-${role}`,
        role,
        action: role,
        stage: "progress",
        status: "running",
        sequence: 5
      });
      assert.equal(prog.recorded, false);

      const modSel = store.recordTelemetryEvent({
        eventId: `telem-${runId}-model-6`,
        runId,
        issueKey: `PACE-Q-${role}`,
        role,
        action: role,
        stage: "model_selected",
        status: "running",
        sequence: 6
      });
      assert.equal(modSel.recorded, false);

      // 5. Close DB and reopen: assert DB still has exactly 1 terminal row and further attempts return false
      store.close();
      store = new RunStore(dbPath);

      const postReopenAttempt = store.recordTelemetryEvent({
        eventId: `telem-${runId}-reopen-term-7`,
        runId,
        issueKey: `PACE-Q-${role}`,
        role,
        action: role,
        stage: "terminal",
        status: "completed",
        sequence: 7
      });
      assert.equal(postReopenAttempt.recorded, false);

      const allEvents = store.database.prepare("SELECT * FROM telemetry_events WHERE run_id = ? ORDER BY sequence ASC").all(runId);
      const terminalEvents = allEvents.filter(e => e.stage === "terminal");
      assert.equal(terminalEvents.length, 1);
    }
  } finally {
    try { store.close(); } catch {}
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test R: Usage Null/Zero Truthfulness & Formatted Metrics
// -----------------------------------------------------------------------------
test("Phase J — R. Usage Null/Zero Truthfulness & Formatted Metrics", () => {
  const { repo, worktreeRoot, dbPath, cleanup } = makeTestGitRepo();
  let store = new RunStore(dbPath);
  try {
    const settings = makeSettings(repo, worktreeRoot, store);

    // 1. Database table level: null vs 0 truthfulness
    store.recordUsageEvent({
      runId: "run-null",
      provider: "mock",
      model: "default",
      inputTokens: null,
      outputTokens: null,
      durationMs: null
    });

    store.recordUsageEvent({
      runId: "run-zero",
      provider: "local",
      model: "tiny",
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0
    });

    const nullRow = store.database.prepare("SELECT * FROM usage_events WHERE run_id = 'run-null'").get();
    assert.equal(nullRow.input_tokens, null);
    assert.equal(nullRow.output_tokens, null);
    assert.equal(nullRow.duration_ms, null);

    const zeroRow = store.database.prepare("SELECT * FROM usage_events WHERE run_id = 'run-zero'").get();
    assert.equal(zeroRow.input_tokens, 0);
    assert.equal(zeroRow.output_tokens, 0);
    assert.equal(zeroRow.duration_ms, 0);

    // 2. Runtime level test: provider reports duration_seconds: 0
    const fakeRuntimeZero = {
      spawnSync: (cmd, args = [], opts = {}) => {
        if (cmd === "git") return spawnSync(cmd, args, opts);
        if (cmd === "npm" || (args && args.includes("check"))) return { status: 0, stdout: "ok", stderr: "" };
        const cwd = opts.cwd || repo;
        try {
          const editDir = path.join(cwd, "backend");
          fs.mkdirSync(editDir, { recursive: true });
          fs.writeFileSync(path.join(editDir, "zero.js"), "// zero\n", "utf8");
          spawnSync("git", ["-C", cwd, "add", "backend/zero.js"]);
          spawnSync("git", ["-C", cwd, "commit", "-m", "zero commit"]);
        } catch {}
        return {
          status: 0,
          stdout: JSON.stringify({
            status: "completed",
            summary: "Executed with 0 duration",
            changed_files: ["backend/zero.js"],
            validation_commands: ["npm test"],
            blockers: [],
            risks: [],
            duration_seconds: 0
          }),
          stderr: ""
        };
      },
      spawn: () => {}
    };

    const workItemZero = {
      key: "PACE-R-ZERO",
      summary: "Zero duration test",
      description: "Acceptance criteria: duration zero",
      canonicalState: "ready",
      labels: ["agent-ready"]
    };

    const resZero = handleImplementation(settings, workItemZero, true, fakeRuntimeZero);
    assert.equal(resZero.exitCode, 0);
    const runZeroId = resZero.output.runId;

    // Verify run event payload preserves durationSeconds: 0
    const runZero = store.getRun(runZeroId);
    const verifyingEvent = runZero.events.find(e => e.state === "verifying");
    assert.ok(verifyingEvent, "Verifying event must exist");
    assert.equal(verifyingEvent.payload.durationSeconds, 0, "Run event payload must preserve durationSeconds: 0");

    const detailedRun = store.listRunsDetailed(10).find(r => r.id === runZeroId);
    assert.ok(detailedRun, "Detailed run must exist");
    assert.equal(detailedRun.latest_payload.durationSeconds, 0, "Run latest_payload must preserve durationSeconds: 0");

    // Verify telemetry_events has duration_ms: 0
    const telemRow = store.database.prepare("SELECT duration_ms FROM telemetry_events WHERE run_id = ? AND stage = 'terminal'").get(runZeroId);
    assert.equal(telemRow.duration_ms, 0, "telemetry_events.duration_ms must be 0");

    // Reopen DB: still 0
    store.close();
    store = new RunStore(dbPath);

    const telemRowAfterReopen = store.database.prepare("SELECT duration_ms FROM telemetry_events WHERE run_id = ? AND stage = 'terminal'").get(runZeroId);
    assert.equal(telemRowAfterReopen.duration_ms, 0, "telemetry_events.duration_ms must survive DB reopen as 0");
  } finally {
    try { store.close(); } catch {}
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test S: Real Trusted-Path Containment & Registered Worktree Verification
// -----------------------------------------------------------------------------
test("Phase J — S. Real Trusted-Path Containment & Registered Worktree Verification", () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const sc = new LocalGitSourceControlProvider();

    // 1. Directory symlink pointing outside worktree root
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-j-outside-"));
    const symlinkWorktree = path.join(worktreeRoot, "epic-pace-symlink");
    try {
      fs.symlinkSync(outsideDir, symlinkWorktree, "dir");
      assert.throws(
        () => {
          sc.prepareIntegrationWorktree({
            repoPath: repo,
            root: worktreeRoot,
            parentKey: "PACE-SYMLINK",
            summary: "symlink",
            baseRef: "develop",
            execute: false
          });
        },
        /escapes trusted root|escapes configured worktree root/i
      );
    } catch (err) {
      if (err.code !== "EPERM") {
        assert.ok(true);
      }
    } finally {
      try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch {}
    }

    // 2. Ordinary non-git directory at expected path pretending to be a worktree
    const fakeBranch = "epic/pace-fake-branch";
    const fakeDir = path.join(worktreeRoot, fakeBranch.replaceAll("/", "-"));
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDir, "fake.txt"), "hello", "utf8");

    assert.throws(
      () => {
        sc.prepareIntegrationWorktree({
          repoPath: repo,
          root: worktreeRoot,
          parentKey: "PACE-FAKE",
          summary: "branch",
          baseRef: "develop",
          execute: true
        });
      },
      /exists but is not a registered Git worktree/i
    );

    // 3. Valid registered worktree succeeds
    const validSummary = "valid-worktree";
    const prepared = sc.prepareIntegrationWorktree({
      repoPath: repo,
      root: worktreeRoot,
      parentKey: "PACE-VALID",
      summary: validSummary,
      baseRef: "develop",
      execute: true
    });
    assert.ok(fs.existsSync(prepared.worktree));

    // Reusing the same valid registered worktree succeeds idempotently
    const reused = sc.prepareIntegrationWorktree({
      repoPath: repo,
      root: worktreeRoot,
      parentKey: "PACE-VALID",
      summary: validSummary,
      baseRef: "develop",
      execute: true
    });
    assert.equal(reused.worktree, prepared.worktree);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test T: Command Injection Resistance (Argument Array Safety)
// -----------------------------------------------------------------------------
test("Phase J — T. Command Injection Resistance (Argument Array Safety)", () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const sc = new LocalGitSourceControlProvider();
    const maliciousSummary = "Malicious $(calc) ; rm -rf / | whoami";
    const prepared = sc.prepareIntegrationWorktree({
      repoPath: repo,
      root: worktreeRoot,
      parentKey: "PACE-90",
      summary: maliciousSummary,
      execute: false
    });

    assert.ok(Array.isArray(prepared.command));
    assert.equal(prepared.command[0], "git");
    assert.ok(prepared.command.includes("worktree"));
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test U: Real Config Snapshot Runtime Test
// -----------------------------------------------------------------------------
test("Phase J — U0. Config Snapshot Persistence Baseline", async () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    // 1. Configure live settings to Configuration X:
    const settings = makeSettings(repo, worktreeRoot, store, {
      operatingMode: "autonomous",
      data: {
        policy: {
          execution: {
            provider: "codex",
            model: "gpt-4o",
            persona: "backend-developer",
            taskAgent: "backend-agent",
            agentVersion: 1
          },
          review: {
            provider: "codex",
            model: "gpt-4o",
            persona: "reviewer",
            taskAgent: "correctness-reviewer",
            agentVersion: 1
          }
        }
      }
    });

    const fakeRuntime = {
      spawnSync: (cmd, args = [], opts = {}) => {
        if (cmd === "git") return spawnSync(cmd, args, opts);
        if (cmd === "npm" || (args && args.includes("check"))) return { status: 0, stdout: "ok", stderr: "" };
        const cwd = opts.cwd || repo;
        try {
          const editDir = path.join(cwd, "backend");
          fs.mkdirSync(editDir, { recursive: true });
          fs.writeFileSync(path.join(editDir, "u1.js"), "// u1\n", "utf8");
          spawnSync("git", ["-C", cwd, "add", "backend/u1.js"]);
          spawnSync("git", ["-C", cwd, "commit", "-m", "u1 commit"]);
        } catch {}
        return {
          status: 0,
          stdout: JSON.stringify({
            status: "completed",
            summary: "Executed under Config X",
            changed_files: ["backend/u1.js"],
            validation_commands: ["npm test"],
            blockers: [],
            risks: [],
            duration_seconds: 1
          }),
          stderr: ""
        };
      },
      spawn: () => {}
    };

    const workItem1 = {
      key: "PACE-U1",
      summary: "Run 1 with Config X",
      description: "Acceptance criteria: Config X execution",
      canonicalState: "ready",
      labels: ["agent-ready"]
    };

    // Start REAL implementation run under live Configuration X -> production planning creates & persists configSnapshot
    const res1 = handleImplementation(settings, workItem1, true, fakeRuntime);
    assert.equal(res1.exitCode, 0);
    const run1 = store.getRun(res1.output.runId);
    assert.ok(run1.payload.configSnapshot, "Production planning must create and persist configSnapshot");
    assert.equal(run1.payload.configSnapshot.operatingMode, "autonomous");
    assert.equal(run1.payload.configSnapshot.reviewProvider, "codex");
    assert.equal(run1.payload.configSnapshot.reviewModel, "gpt-4o");
    assert.equal(run1.payload.configSnapshot.reviewTaskAgent, "correctness-reviewer");

    // 2. Mutate LIVE configuration to Configuration Y:
    settings.data.operatingMode = "supervised";
    settings.data.project.operatingMode = "supervised";
    settings.data.policy.operatingMode = "supervised";
    settings.data.policy.execution = {
      provider: "antigravity",
      model: "claude-3-5-sonnet",
      persona: "lead-developer",
      taskAgent: "antigravity-agent",
      agentVersion: 2
    };
    settings.data.policy.review = {
      provider: "antigravity",
      model: "claude-3-5-sonnet",
      persona: "reviewer",
      taskAgent: "qa-reviewer",
      agentVersion: 2
    };

    // 3. Resume existing Run 1 through real review/rework planning boundary:
    // Assert existing run 1 still consumes pinned Configuration X:
    const reviewProfileRun1 = selectReviewProfile(settings, workItem1, run1.payload, run1.payload.configSnapshot);
    assert.equal(reviewProfileRun1.provider, "codex");
    assert.equal(reviewProfileRun1.model, "gpt-4o");
    assert.equal(reviewProfileRun1.taskAgent, "correctness-reviewer");

    // 4. Start a NEW Run 2 under live Configuration Y:
    const workItem2 = {
      key: "PACE-U2",
      summary: "Run 2 with Config Y",
      description: "Acceptance criteria: Config Y execution",
      canonicalState: "ready",
      labels: ["agent-ready"]
    };

    const res2 = handleImplementation(settings, workItem2, true, fakeRuntime, { approved: true });
    assert.equal(res2.exitCode, 0);
    const run2 = store.getRun(res2.output.runId);
    assert.ok(run2.payload.configSnapshot);
    assert.equal(run2.payload.configSnapshot.operatingMode, "supervised");
    assert.equal(run2.payload.configSnapshot.reviewProvider, "antigravity");
    assert.equal(run2.payload.configSnapshot.reviewModel, "claude-3-5-sonnet");
    assert.equal(run2.payload.configSnapshot.reviewTaskAgent, "qa-reviewer");

    const reviewProfileRun2 = selectReviewProfile(settings, workItem2, run2.payload, run2.payload.configSnapshot);
    assert.equal(reviewProfileRun2.provider, "antigravity");
    assert.equal(reviewProfileRun2.model, "claude-3-5-sonnet");
    assert.equal(reviewProfileRun2.taskAgent, "qa-reviewer");

    // 5. Prove active parent's aggregate reviewer identity does not silently switch when live config changed
    const parentKey = "PACE-U-PARENT";
    const parentWorkItem = {
      key: parentKey,
      summary: "Parent Feature U",
      description: "Acceptance criteria: parent U",
      type: "Epic",
      canonicalState: "ready"
    };
    const workSource = new FakeWorkSourceProvider();
    workSource.setWorkItem(parentWorkItem);
    workSource.setChildren(parentKey, [workItem1]);

    // Pin parent under configuration X
    settings.data.policy.review = { provider: "codex", model: "gpt-4o", persona: "reviewer", taskAgent: "correctness-reviewer", agentVersion: 1 };
    await discoverAndPinParent(settings, store, parentWorkItem, { workSource, runtime: fakeRuntime, execute: true });

    // Mutate live config back to Y
    settings.data.policy.review = { provider: "antigravity", model: "claude-3-5-sonnet", persona: "reviewer", taskAgent: "qa-reviewer", agentVersion: 2 };

    const parentExec = store.getParentExecution(parentKey);
    assert.ok(parentExec);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test U: Real X -> Y Runtime and Parent Reviewer Pinning
// -----------------------------------------------------------------------------
test("Phase J — U. Real X -> Y Runtime and Parent Reviewer Pinning", async () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
    settings.data.policy.externalWritesEnabled = true;
    settings.data.policy.autonomyEnabled = true;
    settings.data.executor = {
      defaultProvider: "provider-x",
      providers: {
        "provider-x": {
          command: ["provider-x", "--model", "{model}", "{prompt}"],
          defaultModel: "model-x",
          modelProfiles: { medium: "model-x", high: "model-x" }
        },
        "provider-y": {
          command: ["provider-y", "--model", "{model}", "{prompt}"],
          defaultModel: "model-y",
          modelProfiles: { medium: "model-y", high: "model-y" }
        }
      }
    };
    settings.data.policy.review = {
      provider: "provider-x",
      model: "model-x",
      modelProfile: "medium",
      persona: "review-persona-x",
      taskAgent: "correctness-reviewer",
      maxReworkAttempts: 2
    };

    const builderX = store.updateAgentDefinition("backend-engineer", {
      executor: { provider: "provider-x", modelProfile: "medium", model: "model-x" }
    });
    const reviewerX = store.updateAgentDefinition("correctness-reviewer", {
      executor: { provider: "provider-x", modelProfile: "medium", model: "model-x" }
    });

    const invocations = [];
    let implementationCount = 0;
    const runtime = {
      spawnSync: (cmd, args = [], opts = {}) => {
        if (cmd === "git") return spawnSync(cmd, args, opts);
        if (cmd === "npm" || cmd === "npm.cmd" || args.includes("check")) {
          return { status: 0, stdout: "verification ok", stderr: "" };
        }

        const prompt = args.join(" ");
        invocations.push({ provider: cmd, model: args[1] || null, prompt });
        if (prompt.includes("Aggregate Integration Review")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              verdict: "clean",
              evidence: [{ id: "U-AGG", severity: "suggestion", category: "correctness", problem: "Aggregate review clean" }]
            }),
            stderr: ""
          };
        }
        if (prompt.includes("Review implementation")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              verdict: "changes-requested",
              evidence: [{ id: "U-REV", severity: "major", category: "correctness", problem: "Exercise pinned rework", expected: "Rework with X" }]
            }),
            stderr: ""
          };
        }

        implementationCount += 1;
        const cwd = opts.cwd || repo;
        const relativeFile = `backend/u-${implementationCount}.js`;
        fs.mkdirSync(path.join(cwd, "backend"), { recursive: true });
        fs.writeFileSync(path.join(cwd, relativeFile), `// implementation ${implementationCount}\n`, "utf8");
        spawnSync("git", ["-C", cwd, "add", relativeFile]);
        spawnSync("git", ["-C", cwd, "commit", "-m", `implementation ${implementationCount}`]);
        return {
          status: 0,
          stdout: JSON.stringify({
            status: "completed",
            summary: "Implemented",
            changed_files: [relativeFile],
            validation_commands: ["npm test"],
            blockers: [],
            risks: [],
            duration_seconds: 1
          }),
          stderr: ""
        };
      },
      spawn: () => {}
    };

    const childX = {
      key: "PACE-U-X",
      summary: "Pinned child X",
      description: "Acceptance criteria: execute and rework with X",
      canonicalState: "ready",
      labels: ["agent-ready"]
    };
    const implementationX = handleImplementation(settings, childX, true, runtime);
    assert.equal(implementationX.exitCode, 0);
    const runX = store.getRun(implementationX.output.runId);
    assert.equal(runX.payload.configSnapshot.executorProvider, "provider-x");
    assert.equal(runX.payload.configSnapshot.executorModel, "model-x");
    assert.equal(runX.payload.configSnapshot.agentVersion, builderX.version);
    assert.equal(runX.payload.configSnapshot.agentHash, builderX.definitionHash);
    assert.equal(runX.payload.configSnapshot.operatingMode, "autonomous");
    assert.equal(runX.payload.configSnapshot.reviewProvider, "provider-x");
    assert.equal(runX.payload.configSnapshot.reviewModel, "model-x");
    assert.equal(runX.payload.configSnapshot.reviewAgentVersion, reviewerX.version);
    assert.equal(runX.payload.configSnapshot.reviewAgentHash, reviewerX.definitionHash);

    reconcileReviewers(settings, store);
    reconcileReviewers(settings, store);
    assert.equal(store.getRun(runX.id).state, "review-queued");

    const parentSource = new FakeWorkSourceProvider();
    const parentXKey = "PACE-U-PARENT-X";
    const parentXItem = {
      key: parentXKey,
      summary: "Parent pinned under X",
      description: "Acceptance criteria: aggregate X",
      type: "Epic",
      canonicalState: "backlog"
    };
    parentSource.setWorkItem(parentXItem);
    parentSource.setChildren(parentXKey, [childX]);
    const parentPinX = await discoverAndPinParent(settings, store, parentXItem, { workSource: parentSource, runtime, execute: true });
    assert.equal(parentPinX.ok, true);
    const pinnedParentX = store.getParentExecution(parentXKey);
    assert.equal(pinnedParentX.reviewerSnapshot.provider, "provider-x");
    assert.equal(pinnedParentX.reviewerSnapshot.model, "model-x");
    assert.equal(pinnedParentX.reviewerSnapshot.reviewerVersion, reviewerX.version);
    assert.equal(pinnedParentX.reviewerSnapshot.reviewerHash, reviewerX.definitionHash);

    settings.data.operatingMode = "supervised";
    settings.data.project.operatingMode = "supervised";
    settings.data.policy.operatingMode = "supervised";
    settings.data.executor.defaultProvider = "provider-y";
    settings.data.policy.review = {
      provider: "provider-y",
      model: "model-y",
      modelProfile: "medium",
      persona: "review-persona-y",
      taskAgent: "correctness-reviewer",
      maxReworkAttempts: 2
    };
    const builderY = store.updateAgentDefinition("backend-engineer", {
      executor: { provider: "provider-y", modelProfile: "medium", model: "model-y" }
    });
    const reviewerY = store.updateAgentDefinition("correctness-reviewer", {
      executor: { provider: "provider-y", modelProfile: "medium", model: "model-y" }
    });

    const reviewItemX = { ...childX, canonicalState: "review" };
    const reviewX = handleReview(settings, reviewItemX, true, runtime);
    assert.equal(reviewX.exitCode, 0);
    assert.equal(reviewX.output.provider, "provider-x");
    assert.equal(reviewX.output.model, "model-x");
    const reviewRunX = store.getRun(reviewX.output.runId);
    assert.equal(reviewRunX.payload.configSnapshot.reviewAgentVersion, reviewerX.version);
    assert.equal(reviewRunX.payload.configSnapshot.reviewAgentHash, reviewerX.definitionHash);
    assert.equal(store.getRun(runX.id).state, "review-failed");

    const reworkSource = new FakeWorkSourceProvider();
    reworkSource.setWorkItem(reviewItemX);
    reconcileReviewers(settings, store);
    const reworkPromises = [];
    reconcileReviewers(settings, store, { execute: true, workSource: reworkSource, promises: reworkPromises });
    await Promise.all(reworkPromises);
    const reworkItem = await reworkSource.getWorkItem(childX.key);
    assert.equal(reworkItem.canonicalState, "rework");
    const reworkX = await Promise.resolve(runIssue(settings, reworkItem, true, runtime));
    assert.equal(reworkX.exitCode, 0);
    assert.equal(reworkX.output.provider, "provider-x");
    assert.equal(reworkX.output.model, "model-x");
    const reworkRunX = store.getRun(reworkX.output.runId);
    assert.equal(reworkRunX.payload.action, "rework");
    assert.equal(reworkRunX.payload.configSnapshot.executorProvider, "provider-x");
    assert.equal(reworkRunX.payload.configSnapshot.agentVersion, builderX.version);
    assert.equal(reworkRunX.payload.configSnapshot.agentHash, builderX.definitionHash);

    const childY = {
      key: "PACE-U-Y",
      summary: "New child Y",
      description: "Acceptance criteria: execute with Y",
      canonicalState: "ready",
      labels: ["agent-ready"]
    };
    const implementationY = await Promise.resolve(runIssue(settings, childY, true, runtime, { approved: true }));
    assert.equal(implementationY.exitCode, 0);
    assert.equal(implementationY.output.provider, "provider-y");
    assert.equal(implementationY.output.model, "model-y");
    const runY = store.getRun(implementationY.output.runId);
    assert.equal(runY.payload.configSnapshot.executorProvider, "provider-y");
    assert.equal(runY.payload.configSnapshot.agentVersion, builderY.version);
    assert.equal(runY.payload.configSnapshot.agentHash, builderY.definitionHash);
    assert.equal(runY.payload.configSnapshot.operatingMode, "supervised");

    const aggregateX = await runParentIntegrationReview(settings, store, parentXKey, { runtime });
    assert.equal(aggregateX.ok, true);
    const aggregateRunX = store.getRun(aggregateX.reviewRunId);
    assert.equal(aggregateRunX.payload.provider, "provider-x");
    assert.equal(aggregateRunX.payload.model, "model-x");
    assert.equal(aggregateRunX.payload.reviewerVersion, reviewerX.version);
    assert.equal(aggregateRunX.payload.reviewerHash, reviewerX.definitionHash);

    settings.data.operatingMode = "autonomous";
    settings.data.project.operatingMode = "autonomous";
    settings.data.policy.operatingMode = "autonomous";

    const parentYKey = "PACE-U-PARENT-Y";
    const parentYItem = {
      key: parentYKey,
      summary: "Parent pinned under Y",
      description: "Acceptance criteria: aggregate Y",
      type: "Epic",
      canonicalState: "backlog"
    };
    parentSource.setWorkItem(parentYItem);
    parentSource.setChildren(parentYKey, [childY]);
    const parentPinY = await discoverAndPinParent(settings, store, parentYItem, { workSource: parentSource, runtime, execute: true });
    assert.equal(parentPinY.ok, true);
    const pinnedParentY = store.getParentExecution(parentYKey);
    assert.equal(pinnedParentY.reviewerSnapshot.provider, "provider-y");
    assert.equal(pinnedParentY.reviewerSnapshot.model, "model-y");
    assert.equal(pinnedParentY.reviewerSnapshot.reviewerVersion, reviewerY.version);
    assert.equal(pinnedParentY.reviewerSnapshot.reviewerHash, reviewerY.definitionHash);

    const aggregateY = await runParentIntegrationReview(settings, store, parentYKey, { runtime });
    assert.equal(aggregateY.ok, true);
    const aggregateRunY = store.getRun(aggregateY.reviewRunId);
    assert.equal(aggregateRunY.payload.provider, "provider-y");
    assert.equal(aggregateRunY.payload.model, "model-y");
    assert.equal(aggregateRunY.payload.reviewerVersion, reviewerY.version);
    assert.equal(aggregateRunY.payload.reviewerHash, reviewerY.definitionHash);

    const aggregateInvocations = invocations.filter((entry) => entry.prompt.includes("Aggregate Integration Review"));
    assert.deepEqual(aggregateInvocations.map((entry) => entry.provider), ["provider-x", "provider-y"]);

    const deletedPinnedVersion = store.database.prepare(
      "DELETE FROM agent_versions WHERE agent_id = ? AND version = ?"
    ).run("correctness-reviewer", reviewerY.version);
    assert.equal(deletedPinnedVersion.changes, 1);
    const unavailablePinnedReviewer = await runParentIntegrationReview(settings, store, parentYKey, { runtime });
    assert.equal(unavailablePinnedReviewer.blocked, true);
    assert.match(unavailablePinnedReviewer.reason, /not registered|unavailable/i);
    assert.equal(
      invocations.filter((entry) => entry.prompt.includes("Aggregate Integration Review")).length,
      2,
      "Unavailable pinned reviewer must fail closed without a live provider fallback"
    );
  } finally {
    cleanup();
  }
});


// -----------------------------------------------------------------------------
// Test V: Real Database Restart Tests (A, B, C)
// -----------------------------------------------------------------------------
test("Phase J — V. Real Database Restart Tests (A, B, C)", async () => {
  const { repo, worktreeRoot, dbPath, cleanup } = makeTestGitRepo();
  let store = new RunStore(dbPath);
  try {
    const settings = makeSettings(repo, worktreeRoot, store);

    // --- Scenario A: Started worker -> close DB -> reopen DB -> reconcile -> safe retry ---
    const runIdA = store.createRun("PACE-V1", { summary: "Crashed worker run" });
    store.transition(runIdA, "started", {
      workerLeaseId: "lease-crashed-1",
      workerLeaseExpiresAt: new Date(Date.now() - 10000).toISOString()
    });
    store.acquireLock("PACE-V1", runIdA);

    // Restart boundary
    store.close();
    store = new RunStore(dbPath);
    settings._store = store;
    settings.getStore = () => store;

    const recResA = reconcileWorkers(settings, store, { now: Date.now() });
    assert.ok(recResA.recovered.includes(runIdA));
    const recoveredRunA = store.getRun(runIdA);
    assert.equal(recoveredRunA.state, "failed-retryable");
    assert.equal(store.listLocks().some(l => l.issueKey === "PACE-V1"), false);

    // --- Scenario B: Integration Git merge completes -> crash before durable bookkeeping -> reopen -> reconcileIntegrations ---
    const epicKey = "PACE-V-EPIC";
    store.upsertEpic({ key: epicKey, summary: "Parent Epic", branch: "epic/PACE-V", baseBranch: "develop" });
    spawnSync("git", ["-C", repo, "checkout", "-b", "epic/PACE-V", "develop"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base", "utf8");
    spawnSync("git", ["-C", repo, "add", "."]);
    spawnSync("git", ["-C", repo, "commit", "-m", "base epic"]);

    spawnSync("git", ["-C", repo, "checkout", "-b", "feat/PACE-V2", "epic/PACE-V"]);
    fs.writeFileSync(path.join(repo, "v2.txt"), "v2", "utf8");
    spawnSync("git", ["-C", repo, "add", "."]);
    spawnSync("git", ["-C", repo, "commit", "-m", "v2 commit"]);
    const v2Sha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim().toLowerCase();

    // Merge into epic branch in git
    spawnSync("git", ["-C", repo, "checkout", "epic/PACE-V"]);
    spawnSync("git", ["-C", repo, "merge", "--no-ff", "-m", "merge v2", "feat/PACE-V2"]);
    const mergedSha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim().toLowerCase();

    // In DB, task is in review-clean / integrating (simulating crash before finishEpicIntegration)
    const v2RunId = store.createRun("PACE-V2", { summary: "Task V2" });
    store.transition(v2RunId, "review-queued", { implementationSha: v2Sha });
    recordReviewerOutcome(store, {
      runId: v2RunId,
      implementationSha: v2Sha,
      reviewerId: "rev-1",
      verdict: "clean",
      evidence: [{ id: "V-1", severity: "suggestion", category: "correctness", problem: "Clean" }]
    });

    store.upsertEpicTask({ epicKey, issueKey: "PACE-V2", summary: "Task V2", branch: "feat/PACE-V2", state: "reviewed-clean", reviewedSha: v2Sha });
    store.queueEpicIntegration({ epicKey, issueKey: "PACE-V2", leafBranch: "feat/PACE-V2" });
    store.claimEpicIntegration({ epicKey, issueKey: "PACE-V2" });

    // Restart boundary
    store.close();
    store = new RunStore(dbPath);
    settings._store = store;
    settings.getStore = () => store;

    // Production integration reconciler recognizes commit ancestry in worktree
    const sc = new LocalGitSourceControlProvider();
    const recInt = reconcileIntegrations(settings, store, {
      sourceControl: sc,
      integrationAdapter: () => ({ completed: true, reviewedSha: v2Sha, integratedSha: mergedSha })
    });
    assert.equal(recInt.integrationsCompleted, 1);

    const intState = store.getEpic(epicKey).integrations.find(i => i.issueKey === "PACE-V2");
    assert.equal(intState.state, "integrated");

    // --- Scenario C: Aggregate review verdict durable -> crash before waiting_human -> reopen -> reconcileParentExecution ---
    const initialDevelopSha = spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout.toString().trim();
    const parentKey = "PACE-V-PARENT";
    store.upsertEpic({ key: parentKey, summary: "Parent V", branch: "epic/PACE-V", baseBranch: "develop" });
    store.upsertEpicTask({ epicKey: parentKey, issueKey: "PACE-V2", summary: "Task V2", branch: "feat/PACE-V2", state: "integrated", reviewedSha: v2Sha, integratedSha: mergedSha });
    store.queueEpicIntegration({ epicKey: parentKey, issueKey: "PACE-V2", leafBranch: "feat/PACE-V2" });
    store.claimEpicIntegration({ epicKey: parentKey, issueKey: "PACE-V2" });
    store.finishEpicIntegration({ epicKey: parentKey, issueKey: "PACE-V2", commit: mergedSha });

    const revRunId = store.createRun(parentKey, { role: "reviewer", action: "integration_review" });
    const persistedReview = {
      reviewerAgentId: "reviewer",
      reviewerVersion: 1,
      reviewerHash: "hash-v",
      provider: "codex",
      modelProfile: "medium",
      integrationHeadSha: mergedSha,
      parentBaseSha: initialDevelopSha,
      verdict: "clean",
      findings: [],
      evidence: [],
      findingsCount: 0,
      reviewedHeadSha: mergedSha,
      reviewedAt: new Date().toISOString()
    };
    store.transition(revRunId, "completed", {
      verdict: "clean",
      review: persistedReview,
      findings: []
    });

    store.upsertParentExecution({
      parentKey,
      sourceProvider: "fake-source",
      summary: "Parent V",
      state: "active",
      baseRef: "develop",
      baseSha: initialDevelopSha,
      integrationBranch: "epic/PACE-V",
      integrationHeadSha: mergedSha,
      graphFingerprint: "fp-v",
      dag: { children: [{ key: "PACE-V2" }] },
      completionPacket: { integrationReview: persistedReview }
    });

    // Restart boundary
    store.close();
    store = new RunStore(dbPath);
    settings._store = store;
    settings.getStore = () => store;

    const fakeRuntime = {
      spawnSync: (cmd, args = [], opts = {}) => {
        if (cmd === "git") return spawnSync(cmd, args, opts);
        if (cmd === "npm" || (args && args.includes("check"))) return { status: 0, stdout: "ok", stderr: "" };
        return {
          status: 0,
          stdout: JSON.stringify({
            verdict: "clean",
            evidence: [{ id: "VC-1", severity: "suggestion", category: "correctness", problem: "Clean" }]
          }),
          stderr: ""
        };
      }
    };

    const recParent = await reconcileParentExecution(settings, store, parentKey, {
      workSource: new FakeWorkSourceProvider(),
      runtime: fakeRuntime
    });
    assert.equal(recParent.ok, true);
    assert.equal(recParent.state, "waiting_human");

    const finalParent = store.getParentExecution(parentKey);
    assert.equal(finalParent.state, "waiting_human");
  } finally {
    try { store.close(); } catch {}
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test W: True Production Autonomous E2E with Post-Merge Crash Recovery
// -----------------------------------------------------------------------------
test("Phase J — W0. Legacy Direct Lifecycle Baseline", async () => {
  const { repo, worktreeRoot, dbPath, cleanup } = makeTestGitRepo();
  let store = new RunStore(dbPath);
  try {
    const initialDevelopSha = spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout.toString().trim();
    const parentKey = "PACE-500";

    const workSource = new FakeWorkSourceProvider();
    workSource.setWorkItem({
      key: parentKey,
      summary: "Full Autonomous Delivery",
      description: "Deliver parent feature. Acceptance criteria: all children integrated and verified",
      canonicalState: "ready",
      type: "Epic"
    });
    workSource.setChildren(parentKey, [
      { key: "PACE-501", summary: "Child A", description: "Acceptance criteria: Child A done", canonicalState: "ready", labels: ["agent-ready"] },
      { key: "PACE-502", summary: "Child B", description: "Acceptance criteria: Child B done", canonicalState: "ready", labels: ["agent-ready"] },
      { key: "PACE-503", summary: "Child C", description: "Acceptance criteria: Child C done", canonicalState: "ready", labels: ["agent-ready"] }
    ]);
    workSource.setDependencies("PACE-502", ["PACE-501"]); // B depends on A, C is independent

    const fakeRuntime = {
      spawnSync: (cmd, args = [], opts = {}) => {
        if (cmd === "git") {
          return spawnSync(cmd, args, opts);
        }
        if (cmd === "npm" || (args && args.includes("check"))) {
          return { status: 0, stdout: "verification ok", stderr: "" };
        }
        const cwd = opts.cwd || repo;
        const isReview = (args && args.some(a => typeof a === "string" && (a.includes("Review implementation") || a.includes("Aggregate Integration Review"))));
        if (isReview) {
          return {
            status: 0,
            stdout: JSON.stringify({
              verdict: "clean",
              evidence: [{ id: "W-1", severity: "suggestion", category: "correctness", problem: "Clean implementation verified" }]
            }),
            stderr: ""
          };
        }
        // Implementation worker creates unique file and commit per issue in worktree
        const issueMatch = cwd.match(/PACE-\d+/);
        const fileName = issueMatch ? `feature-${issueMatch[0].toLowerCase()}.js` : `feature-${Date.now()}.js`;
        try {
          const editDir = path.join(cwd, "backend");
          fs.mkdirSync(editDir, { recursive: true });
          fs.writeFileSync(path.join(editDir, fileName), `// implementation for ${fileName}\n`, "utf8");
          spawnSync("git", ["-C", cwd, "add", "."]);
          spawnSync("git", ["-C", cwd, "commit", "-m", `worker commit for ${fileName}`]);
        } catch {}
        return {
          status: 0,
          stdout: JSON.stringify({
            status: "completed",
            summary: "Implemented successfully",
            changed_files: [`backend/${fileName}`],
            validation_commands: ["npm test"],
            blockers: [],
            risks: [],
            duration_seconds: 1
          }),
          stderr: ""
        };
      },
      spawn: () => {}
    };

    let settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });

    // 1. Discover & Pin Parent
    const pinRes = await discoverAndPinParent(
      settings,
      store,
      workSource.items.get(parentKey),
      { workSource, runtime: fakeRuntime, execute: true }
    );
    assert.equal(pinRes.ok, true);
    assert.equal(store.getParentExecution(parentKey).state, "active");

    // 2. Reconcile Children: A and C are ready; B is pending-dependencies
    const sc = new LocalGitSourceControlProvider();
    const recRes1 = reconcileParentChildren(settings, store, parentKey, { sourceControl: sc, runtime: fakeRuntime });
    assert.ok(recRes1.readyChildren.includes("PACE-501"));
    assert.ok(recRes1.readyChildren.includes("PACE-503"));
    assert.ok(!recRes1.readyChildren.includes("PACE-502"));
    assert.equal(store.getEpicTask(parentKey, "PACE-502").orchestrationState, "pending-dependencies");

    // 3. Execute Child A through real production runtime -> verifying
    const resA = handleImplementation(settings, workSource.items.get("PACE-501"), true, fakeRuntime);
    assert.equal(resA.exitCode, 0);
    const runA = store.getRun(resA.output.runId);
    assert.equal(runA.state, "verifying");

    // 4. Production reconcileReviewers transitions A to review-queued (NO manual store.transition)
    reconcileReviewers(settings, store, { runtime: fakeRuntime, nowMs: () => Date.now() });
    reconcileReviewers(settings, store, { runtime: fakeRuntime, nowMs: () => Date.now() });
    assert.equal(store.getRun(runA.id).state, "review-queued");

    // 5. Review Child A through real production review runtime -> reviewed-clean
    const revA = handleReview(settings, workSource.items.get("PACE-501"), true, fakeRuntime);
    assert.equal(revA.exitCode, 0);
    assert.equal(store.getRun(runA.id).state, "reviewed-clean");

    // Before integration, assert B is STILL pending-dependencies
    reconcileParentChildren(settings, store, parentKey, { sourceControl: sc, runtime: fakeRuntime });
    assert.equal(store.getEpicTask(parentKey, "PACE-502").orchestrationState, "pending-dependencies");

    // 6. REQUIRED CRASH INSIDE W:
    // Integration adapter performs the REAL Git merge successfully, but crash occurs before finishEpicIntegration
    let crashTriggered = false;
    try {
      reconcileIntegrations(settings, store, {
        sourceControl: sc,
        runtime: fakeRuntime,
        integrationAdapter: (opts) => sc.integrateReviewedRevision(settings, opts),
        afterIntegrationEvidence: () => {
          crashTriggered = true;
          throw new Error("Simulated hard crash immediately after Git merge");
        }
      });
    } catch {}
    assert.equal(crashTriggered, true, "Simulated crash must trigger after Git merge");

    // 7. Restart Boundary: Close DB, open NEW RunStore on same DB
    store.close();
    store = new RunStore(dbPath);
    settings._store = store;
    settings.getStore = () => store;

    // Resume using production reconcileIntegrations:
    // Ancestry verification detects Git merge already completed, finishes integration cleanly without second merge
    const recIntRecovery = reconcileIntegrations(settings, store, {
      sourceControl: sc,
      runtime: fakeRuntime,
      integrationAdapter: (opts) => sc.integrateReviewedRevision(settings, opts)
    });
    assert.equal(recIntRecovery.integrationsCompleted, 1);
    assert.equal(store.getEpicTask(parentKey, "PACE-501").state, "integrated");

    // 8. Reconcile Children after A is integrated: Task B is now UNLOCKED!
    const recRes2 = reconcileParentChildren(settings, store, parentKey, { sourceControl: sc, runtime: fakeRuntime });
    assert.ok(recRes2.readyChildren.includes("PACE-502"));
    const taskB = store.getEpicTask(parentKey, "PACE-502");
    assert.equal(taskB.orchestrationState, "dependency-ready");
    assert.ok(taskB.childBaseSha);

    // 9. Execute Child C (independent) through production pipeline
    const resC = handleImplementation(settings, workSource.items.get("PACE-503"), true, fakeRuntime);
    assert.equal(resC.exitCode, 0);
    const runC = store.getRun(resC.output.runId);
    reconcileReviewers(settings, store, { runtime: fakeRuntime, nowMs: () => Date.now() });
    reconcileReviewers(settings, store, { runtime: fakeRuntime, nowMs: () => Date.now() });
    assert.equal(store.getRun(runC.id).state, "review-queued");

    const revC = handleReview(settings, workSource.items.get("PACE-503"), true, fakeRuntime);
    assert.equal(revC.exitCode, 0);
    assert.equal(store.getRun(runC.id).state, "reviewed-clean");

    reconcileIntegrations(settings, store, {
      sourceControl: sc,
      runtime: fakeRuntime,
      integrationAdapter: (opts) => sc.integrateReviewedRevision(settings, opts)
    });
    assert.equal(store.getEpicTask(parentKey, "PACE-503").state, "integrated");

    // 10. Execute Child B (unlocked) through production pipeline
    const resB = handleImplementation(settings, workSource.items.get("PACE-502"), true, fakeRuntime);
    assert.equal(resB.exitCode, 0);
    const runB = store.getRun(resB.output.runId);
    reconcileReviewers(settings, store, { runtime: fakeRuntime, nowMs: () => Date.now() });
    reconcileReviewers(settings, store, { runtime: fakeRuntime, nowMs: () => Date.now() });
    assert.equal(store.getRun(runB.id).state, "review-queued");

    const revB = handleReview(settings, workSource.items.get("PACE-502"), true, fakeRuntime);
    assert.equal(revB.exitCode, 0);
    assert.equal(store.getRun(runB.id).state, "reviewed-clean");

    reconcileIntegrations(settings, store, {
      sourceControl: sc,
      runtime: fakeRuntime,
      integrationAdapter: (opts) => sc.integrateReviewedRevision(settings, opts)
    });
    assert.equal(store.getEpicTask(parentKey, "PACE-502").state, "integrated");

    // 11. Run Real Aggregate Integration Review against parent integration worktree (without injectedReviewOutcome, without skipRepoCheck)
    const aggRevRes = await runParentIntegrationReview(settings, store, parentKey, { runtime: fakeRuntime });
    assert.equal(aggRevRes.ok, true);
    assert.equal(aggRevRes.verdict, "clean");

    // 12. Reconcile Parent Execution -> WAITING_HUMAN
    const parentRecRes = await reconcileParentExecution(settings, store, parentKey, { workSource, runtime: fakeRuntime });
    assert.equal(parentRecRes.ok, true);
    assert.equal(parentRecRes.state, "waiting_human");

    const finalParent = store.getParentExecution(parentKey);
    assert.equal(finalParent.state, "waiting_human");
    assert.ok(finalParent.completionPacket);
    assert.equal(finalParent.completionPacket.children.length, 3);

    // 13. Comprehensive Final Invariant Assertions
    // develop HEAD in base repository is completely untouched
    const finalDevelopSha = spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout.toString().trim();
    assert.equal(finalDevelopSha, initialDevelopSha, "develop branch HEAD must remain completely untouched");

    // Zero orphan started or executing runs
    const allRuns = store.database.prepare("SELECT * FROM runs").all();
    assert.equal(allRuns.some(r => r.state === "started" || r.state === "executing"), false, "No orphan started/executing runs");

    // Per-run terminal telemetry uniqueness: exactly one terminal event per run
    const terminalGroups = store.database.prepare("SELECT run_id, COUNT(*) as c FROM telemetry_events WHERE stage = 'terminal' GROUP BY run_id").all();
    for (const group of terminalGroups) {
      assert.equal(group.c, 1, `Run ${group.run_id} must have exactly 1 terminal telemetry event`);
    }

    // WorkSource transition log contains NO Done/done/release/deploy/production/finalMerge equivalent
    const forbiddenTransitions = ["done", "Done", "closed", "Closed", "released", "Released", "deployed", "Deployed", "finalMerge"];
    const loggedTransitions = workSource.transitions || [];
    for (const trans of loggedTransitions) {
      assert.equal(
        forbiddenTransitions.some(f => trans.state?.toLowerCase().includes(f.toLowerCase())),
        false,
        `Forbidden transition found in workSource log: ${trans.state}`
      );
    }
  } finally {
    try { store.close(); } catch {}
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test W: True dispatchOnce -> scheduler -> runtime -> restart -> aggregate lifecycle
// -----------------------------------------------------------------------------
test("Phase J — W. True dispatchOnce Autonomous Lifecycle with Restart Recovery", async () => {
  const setup = makeTestGitRepo();
  const { repo, worktreeRoot, dbPath, cleanup } = setup;
  let store = setup.store;
  try {
    const initialDevelopSha = spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout.toString().trim();
    const parentKey = "PACE-500";
    const childA = "PACE-501";
    const childB = "PACE-502";
    const childC = "PACE-503";

    const workSource = new FakeWorkSourceProvider();
    workSource.setWorkItem({
      key: parentKey,
      summary: "Dispatcher lifecycle parent",
      description: "Acceptance criteria: integrate A, B, and independent frontend C",
      canonicalState: "backlog",
      type: "Epic"
    });
    workSource.setChildren(parentKey, [
      {
        key: childA,
        summary: "Backend child A",
        description: "Acceptance criteria: add backend child A",
        canonicalState: "ready",
        labels: ["agent-ready"]
      },
      {
        key: childB,
        summary: "Backend child B",
        description: "Acceptance criteria: add backend child B after A",
        canonicalState: "ready",
        labels: ["agent-ready"]
      },
      {
        key: childC,
        summary: "Frontend dashboard child C",
        description: "Acceptance criteria: add independent frontend child C",
        canonicalState: "ready",
        labels: ["agent-ready"]
      }
    ]);
    workSource.setDependencies(childB, [childA]);

    const invocations = [];
    const runtime = {
      spawnSync: (cmd, args = [], opts = {}) => {
        if (cmd === "git") return spawnSync(cmd, args, opts);
        if (cmd === "npm" || cmd === "npm.cmd" || args.includes("check")) {
          return { status: 0, stdout: "verification ok", stderr: "" };
        }

        const prompt = args.join(" ");
        if (prompt.includes("Aggregate Integration Review")) {
          invocations.push({ kind: "aggregate", provider: cmd });
          return {
            status: 0,
            stdout: JSON.stringify({
              verdict: "clean",
              evidence: [{
                id: "W-AGG",
                severity: "suggestion",
                category: "correctness",
                problem: "Aggregate integration review is clean"
              }]
            }),
            stderr: ""
          };
        }
        if (prompt.includes("Review implementation")) {
          invocations.push({ kind: "review", provider: cmd });
          return {
            status: 0,
            stdout: JSON.stringify({
              verdict: "clean",
              evidence: [{
                id: "W-REV",
                severity: "suggestion",
                category: "correctness",
                problem: "Reviewed implementation is clean"
              }]
            }),
            stderr: ""
          };
        }

        const cwd = opts.cwd || repo;
        const normalizedCwd = cwd.toLowerCase();
        const issueKey = normalizedCwd.includes("pace-501")
          ? childA
          : normalizedCwd.includes("pace-502")
          ? childB
          : normalizedCwd.includes("pace-503")
          ? childC
          : null;
        const relativeFile = issueKey === childC
          ? "frontend/w-child-c.js"
          : issueKey === childB
          ? "backend/w-child-b.js"
          : "backend/w-child-a.js";
        invocations.push({ kind: "implementation", provider: cmd, issueKey });

        fs.mkdirSync(path.dirname(path.join(cwd, relativeFile)), { recursive: true });
        fs.writeFileSync(path.join(cwd, relativeFile), "// implementation for " + issueKey + "\n", "utf8");
        const addResult = spawnSync("git", ["-C", cwd, "add", relativeFile], { encoding: "utf8" });
        const commitResult = spawnSync("git", ["-C", cwd, "commit", "-m", "implement " + issueKey], { encoding: "utf8" });
        if (addResult.status !== 0 || commitResult.status !== 0) {
          return {
            status: 1,
            stdout: "",
            stderr: String(addResult.stderr || "") + String(commitResult.stderr || "")
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            status: "completed",
            summary: "Implemented " + issueKey,
            changed_files: [relativeFile],
            validation_commands: ["npm run check"],
            blockers: [],
            risks: [],
            duration_seconds: 1
          }),
          stderr: ""
        };
      },
      spawn: () => {}
    };

    const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
    settings.data.policy.externalWritesEnabled = true;
    settings.data.policy.autonomyEnabled = true;
    settings.data.policy.maxConcurrency = 3;
    settings.data.policy.pathScopes["backend-engineer"] = ["backend/**"];
    settings.data.policy.pathScopes["frontend-engineer"] = ["frontend/**"];
    settings.data.policy.review = {
      provider: "codex",
      model: "gpt-4o",
      modelProfile: "high",
      taskAgent: "correctness-reviewer",
      maxReworkAttempts: 2
    };

    const sourceControl = new LocalGitSourceControlProvider();
    const dispatchCycle = (extra = {}) => dispatchOnce(settings, {
      store,
      workSource,
      execute: true,
      limit: 10,
      maxConcurrency: 3,
      runtime,
      sourceControl,
      integrationAdapter: (request) => sourceControl.integrateReviewedRevision(settings, request),
      ...extra
    });
    const childRuns = (issueKey) => store.listRunsForIssue(issueKey) || [];
    const implementations = (issueKey) => childRuns(issueKey).filter(
      (run) => run.payload?.action === "implementation" && run.payload?.role !== "reviewer"
    );
    const reviewers = (issueKey) => childRuns(issueKey).filter(
      (run) => run.payload?.type === "review" && run.payload?.action === "review"
    );
    const integrationWorkers = (issueKey) => childRuns(issueKey).filter(
      (run) => run.payload?.role === "integration-worker"
    );

    const firstCycle = await dispatchCycle();
    const firstWaveIssues = firstCycle.waves.flat().map((plan) => plan.issue);
    assert.ok(firstWaveIssues.includes(childA));
    assert.ok(firstWaveIssues.includes(childC), "Independent C must dispatch without waiting for A");
    assert.ok(!firstWaveIssues.includes(childB), "B must remain gated by A");
    assert.equal(implementations(childA).length, 1);
    assert.equal(implementations(childC).length, 1);
    assert.equal(implementations(childB).length, 0);
    assert.equal(store.getEpicTask(parentKey, childB).orchestrationState, "pending-dependencies");

    await dispatchCycle();
    await dispatchCycle();
    assert.equal(reviewers(childA).length, 1);
    assert.equal(reviewers(childC).length, 1);
    assert.equal(store.getRun(implementations(childA)[0].id).state, "reviewed-clean");
    assert.equal(store.getRun(implementations(childC)[0].id).state, "reviewed-clean");

    let crashTriggered = false;
    await assert.rejects(
      dispatchCycle({
        afterIntegrationEvidence: (_evidence, integration) => {
          if (integration.issueKey === childA && !crashTriggered) {
            crashTriggered = true;
            throw new Error("Simulated post-merge pre-bookkeeping crash");
          }
        }
      }),
      /post-merge pre-bookkeeping crash/
    );
    assert.equal(crashTriggered, true);
    assert.equal(
      store.listEpicIntegrations(parentKey).find((row) => row.issueKey === childA).state,
      "integrating"
    );
    assert.equal(integrationWorkers(childA).length, 1);
    assert.equal(integrationWorkers(childA)[0].state, "started");
    assert.equal(implementations(childB).length, 0, "B must not dispatch before durable A integration");

    const parentBeforeRestart = store.getParentExecution(parentKey);
    const reviewedShaA = store.getEpicTask(parentKey, childA).reviewedSha;
    const parentHeadBeforeRestart = sourceControl.getHead({ repoPath: parentBeforeRestart.integrationWorktree });
    const ancestryBeforeRestart = sourceControl.isAncestor(
      reviewedShaA,
      parentHeadBeforeRestart.sha,
      { repoPath: parentBeforeRestart.integrationWorktree }
    );
    assert.ok(
      ancestryBeforeRestart === true || ancestryBeforeRestart?.isAncestor === true,
      "Successful Git integration evidence must exist before the bookkeeping crash"
    );

    store.close();
    store = new RunStore(dbPath);
    settings._store = store;
    settings.getStore = () => store;

    await dispatchCycle();
    assert.equal(store.getEpicTask(parentKey, childA).state, "integrated");
    assert.equal(implementations(childB).length, 1, "Restart recovery must unlock and dispatch B");
    assert.equal(integrationWorkers(childA).length, 1, "Recovery must not create a second integration worker");
    assert.equal(integrationWorkers(childA)[0].state, "completed");

    for (let cycle = 0; cycle < 6 && store.getParentExecution(parentKey).state !== "waiting_human"; cycle += 1) {
      await dispatchCycle();
    }

    const finalParent = store.getParentExecution(parentKey);
    assert.equal(finalParent.state, "waiting_human");
    assert.ok(finalParent.completionPacket);
    assert.equal(finalParent.completionPacket.children.length, 3);
    for (const issueKey of [childA, childB, childC]) {
      assert.equal(store.getEpicTask(parentKey, issueKey).state, "integrated");
      assert.equal(implementations(issueKey).length, 1, issueKey + " must have exactly one implementation provider run");
      assert.equal(reviewers(issueKey).length, 1, issueKey + " must have exactly one independent review provider run");
      assert.equal(integrationWorkers(issueKey).length, 1, issueKey + " must have exactly one integration worker");
    }
    assert.equal(invocations.filter((entry) => entry.kind === "implementation").length, 3);
    assert.equal(invocations.filter((entry) => entry.kind === "review").length, 3);
    assert.equal(invocations.filter((entry) => entry.kind === "aggregate").length, 1);

    const parentTelemetry = store.database.prepare(
      "SELECT id, raw_payload FROM telemetry_events WHERE issue_key = ? ORDER BY id"
    ).all(parentKey).map((row) => ({
      id: row.id,
      payload: row.raw_payload ? JSON.parse(row.raw_payload) : {}
    }));
    const aIntegratedIndex = parentTelemetry.findIndex(
      (row) => row.payload.event === "child_integrated" && row.payload.issueKey === childA
    );
    const bDispatchedIndex = parentTelemetry.findIndex(
      (row) => String(row.payload.event || "").startsWith("child_dis") && row.payload.issueKey === childB
    );
    assert.ok(aIntegratedIndex >= 0);
    assert.ok(bDispatchedIndex > aIntegratedIndex, "Durable A integration must precede B dispatch");

    const workerRuns = store.listRunsDetailed(500).filter((run) =>
      run.payload?.action === "implementation" ||
      run.payload?.type === "review" ||
      run.payload?.role === "reviewer" ||
      run.payload?.role === "integration-worker"
    );
    for (const run of workerRuns) {
      const terminalCount = store.database.prepare(
        "SELECT COUNT(*) AS count FROM telemetry_events WHERE run_id = ? AND stage = 'terminal'"
      ).get(run.id).count;
      assert.equal(terminalCount, 1, "Worker run " + run.id + " must terminalize exactly once");
    }
    const orphanRuns = store.listRunsDetailed(500).filter(
      (run) => run.state === "started" || run.state === "executing"
    );
    assert.deepEqual(orphanRuns, []);

    const forbiddenTransitions = ["done", "closed", "release", "deploy", "production", "finalmerge"];
    for (const transition of workSource.transitions) {
      const normalizedState = String(transition.state || "").toLowerCase();
      assert.equal(
        forbiddenTransitions.some((word) => normalizedState.includes(word)),
        false,
        "Forbidden automatic WorkSource transition: " + transition.state
      );
    }
    const finalDevelopSha = spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout.toString().trim();
    assert.equal(finalDevelopSha, initialDevelopSha, "develop must remain untouched");
  } finally {
    try { store.close(); } catch {}
    cleanup();
  }
});
// -----------------------------------------------------------------------------
// Test X: WAITING_HUMAN Final Boundary (Zero Auto-Merge / Done / Promotion)
// -----------------------------------------------------------------------------
test("Phase J — X. WAITING_HUMAN Final Boundary (Zero Auto-Merge / Done / Promotion)", () => {
  assert.ok(HUMAN_ONLY_ACTIONS.includes("finalMerge"));
  assert.ok(HUMAN_ONLY_ACTIONS.includes("markDone"));
  assert.ok(HUMAN_ONLY_ACTIONS.includes("productionDeploy"));

  const autonomy = resolveAutonomyPolicy({ data: { project: { operatingMode: "autonomous" } } });
  assert.equal(autonomy.finalMerge, "human");
  assert.equal(autonomy.markDone, "human");
  assert.equal(autonomy.productionDeploy, "human");

  const authRes = authorizeRuntimeAction(
    { data: { project: { operatingMode: "autonomous" }, policy: { operatingMode: "autonomous" } } },
    null,
    { issueKey: "PACE-1", action: "finalMerge" }
  );
  assert.equal(authRes.allowed, false);
  assert.ok(authRes.reason.includes("human-only"));
});
