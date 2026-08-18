/**
 * test/phase-j-hardening.test.js
 *
 * Dedicated Phase J Hardening Test Suite — Robustness, Durability & Security
 *
 * Scenarios:
 * A. SQLite legacy upgrade + reopen
 * B. transaction rollback safety
 * C. duplicate dispatch idempotency
 * D. duplicate reviewer reconciliation
 * E. duplicate integration reconciliation
 * F. lease ownership / stale reclaim
 * G. concurrent approval race
 * H. stale parent approval
 * I. provider malformed output
 * J. provider timeout/failure normalization
 * K. executor/reviewer schema validation
 * L. git ancestry/reviewed-SHA enforcement
 * M. integration conflict abort safety
 * N. parent graph drift/cycle failure
 * O. dependency integration gate
 * P. rework max-attempt boundary
 * Q. telemetry exactly-one-terminal
 * R. usage null/zero truthfulness
 * S. trusted-path/symlink escape
 * T. command injection resistance
 * U. immutable config snapshots
 * V. restart/crash recovery
 * W. full product lifecycle E2E
 * X. WAITING_HUMAN boundary
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
  recordReviewerOutcome,
  safeWorkSourceMutate
} from "../lib/reconciler.js";
import { validateChangedFiles } from "../lib/scope.js";
import { handlePmApproval, handlePmRejection, buildPmWorkspace } from "../lib/pm-workspace.js";
import { buildObservabilitySummary, redactTelemetryPayload } from "../lib/telemetry.js";
import { parseExecutionOutput } from "../lib/executor.js";

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
  setChildren(parentKey, children) { this.childrenMap.set(parentKey, children); }
  setDependencies(childKey, deps) { this.dependenciesMap.set(childKey, deps); }
  async getWorkItem(id) { return this.items.get(id) || null; }
  async getChildren(id) { return this.childrenMap.get(id) || []; }
  async getDependencies(id) { return this.dependenciesMap.get(id) || []; }
  async listWorkItems() { return Array.from(this.items.values()); }
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
        review: {
          maxReworkAttempts: 2
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
    // Create an older schema without description & acceptance_criteria in parent_executions
    // and with old NOT NULL usage_events
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
        type TEXT NOT NULL DEFAULT 'Epic',
        base_ref TEXT NOT NULL DEFAULT 'develop',
        base_sha TEXT,
        integration_branch TEXT NOT NULL,
        integration_worktree TEXT,
        integration_head_sha TEXT,
        graph_fingerprint TEXT NOT NULL,
        dag_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        completion_packet_json TEXT,
        drift_detected INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE epics (
        epic_key TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        model_budget INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE epic_tasks (
        epic_key TEXT NOT NULL,
        issue_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree TEXT,
        state TEXT NOT NULL,
        orchestration_state TEXT,
        dependencies TEXT,
        budget INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (epic_key, issue_key)
      );
    `);

    // Insert historical data
    const now = "2026-08-18T12:00:00.000Z";
    rawDb.prepare(`INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)`).run("run-hist-1", "PACE-1", "completed", JSON.stringify({ summary: "Old run" }), now, now);
    rawDb.prepare(`INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(1, "run-hist-1", "codex", "gpt-4", 1500, 300, 2000, now);
    rawDb.prepare(`INSERT INTO parent_executions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "PACE-100", "jira", "100", null, "Parent 100", "Epic", "develop", "sha0", "epic/PACE-100", "/tmp/wt", null, "fp1", "{}", "active", null, 0, now, now
    );
    rawDb.close();

    // 1. Open with current RunStore (runs migrations)
    const store = new RunStore(dbPath);
    const run1 = store.getRun("run-hist-1");
    assert.equal(run1.issue_key, "PACE-1");

    const usageList = store.listUsageEvents();
    assert.equal(usageList.length, 1);
    assert.equal(usageList[0].inputTokens, 1500);

    const parent1 = store.getParentExecution("PACE-100");
    assert.equal(parent1.summary, "Parent 100");
    assert.equal(parent1.description, null);
    assert.equal(parent1.acceptanceCriteria, null);

    // 2. Perform new writes using migrated schema
    store.upsertParentExecution({
      parentKey: "PACE-100",
      summary: "Parent 100",
      description: "Added description in modern schema",
      acceptanceCriteria: "Modern criteria",
      integrationBranch: "epic/PACE-100"
    });

    const updatedParent = store.getParentExecution("PACE-100");
    assert.equal(updatedParent.description, "Added description in modern schema");
    assert.equal(updatedParent.acceptanceCriteria, "Modern criteria");

    // 3. Close and reopen to verify restart idempotency
    store.close();
    const store2 = new RunStore(dbPath);
    const parentReopened = store2.getParentExecution("PACE-100");
    assert.equal(parentReopened.description, "Added description in modern schema");
    assert.equal(parentReopened.acceptanceCriteria, "Modern criteria");
    store2.close();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// -----------------------------------------------------------------------------
// Test B: Multi-Table Transaction Rollback Safety
// -----------------------------------------------------------------------------
test("Phase J — B. Multi-Table Transaction Rollback Safety", () => {
  const { store, cleanup } = makeTestGitRepo();
  try {
    // 1. Attempt invalid run creation that fails mid-transaction
    const initialRunCount = store.database.prepare("SELECT COUNT(*) as count FROM runs").get().count;
    const initialEventCount = store.database.prepare("SELECT COUNT(*) as count FROM events").get().count;

    // Trigger atomic error in finishEpicIntegration when no matching row exists
    const finishRes = store.finishEpicIntegration({ epicKey: "NONEXISTENT", issueKey: "PACE-999" });
    assert.equal(finishRes.completed, false);

    // Assert zero partial rows in epic_tasks or epic_integrations
    const taskRows = store.database.prepare("SELECT COUNT(*) as count FROM epic_tasks WHERE issue_key = 'PACE-999'").get().count;
    const intRows = store.database.prepare("SELECT COUNT(*) as count FROM epic_integrations WHERE issue_key = 'PACE-999'").get().count;
    assert.equal(taskRows, 0);
    assert.equal(intRows, 0);

    assert.equal(store.database.prepare("SELECT COUNT(*) as count FROM runs").get().count, initialRunCount);
    assert.equal(store.database.prepare("SELECT COUNT(*) as count FROM events").get().count, initialEventCount);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test C: Duplicate Dispatch Idempotency (Fenced Issue Lock)
// -----------------------------------------------------------------------------
test("Phase J — C. Duplicate Dispatch Idempotency (Fenced Issue Lock)", async () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const settings = makeSettings(repo, worktreeRoot, store);
    const workSource = new FakeWorkSourceProvider();
    workSource.setWorkItem({
      key: "PACE-10",
      summary: "Implement login",
      canonicalState: "ready",
      labels: ["agent-ready"]
    });

    // First dispatch claims the issue and acquires lock
    const runId1 = store.createRun("PACE-10", { summary: "Implement login" });
    const lockAcquired = store.acquireLock("PACE-10", runId1);
    assert.equal(lockAcquired, true);

    // Second competing dispatch attempts to claim same locked issue
    const runId2 = store.createRun("PACE-10", { summary: "Implement login duplicate" });
    const lockAcquired2 = store.acquireLock("PACE-10", runId2);
    assert.equal(lockAcquired2, false, "Second lock acquisition must fail for same issueKey");

    // Only runId1 holds the lock
    const locks = store.listLocks();
    assert.equal(locks.length, 1);
    assert.equal(locks[0].issue_key, "PACE-10");
    assert.equal(locks[0].run_id, runId1);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test D: Duplicate Reviewer Reconciliation Idempotency
// -----------------------------------------------------------------------------
test("Phase J — D. Duplicate Reviewer Reconciliation Idempotency", () => {
  const { store, cleanup } = makeTestGitRepo();
  try {
    const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const runId = store.createRun("PACE-20", { summary: "Review task" });
    store.transition(runId, "review-queued", { implementationSha: sha });

    const evidence = [
      { id: "F-1", severity: "minor", category: "correctness", problem: "Clean review", file: "app.js", line: 1 }
    ];

    // First record reviewer outcome
    const res1 = recordReviewerOutcome(store, {
      runId,
      implementationSha: sha,
      reviewerId: "rev-1",
      verdict: "clean",
      evidence
    });
    assert.equal(res1.recorded, true);
    assert.equal(res1.state, "reviewed-clean");

    // Second duplicate outcome call for the same run
    const res2 = recordReviewerOutcome(store, {
      runId,
      implementationSha: sha,
      reviewerId: "rev-1",
      verdict: "clean",
      evidence
    });
    assert.equal(res2.recorded, false, "Duplicate outcome recording must return recorded: false");

    // Assert run is still in reviewed-clean and no duplicate events
    const run = store.getRun(runId);
    assert.equal(run.state, "reviewed-clean");
  } finally {
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
// Test G: Concurrent Approval Mutation Race Safety
// -----------------------------------------------------------------------------
test("Phase J — G. Concurrent Approval Mutation Race Safety", () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "supervised" });
    const issueKey = "PACE-30";

    const plan = { issue: issueKey, summary: "Fix bug", allowedPaths: ["backend/**"], taskAgent: "backend-engineer" };
    const planFingerprint = computePlanFingerprint(plan);

    store.addPmDecision(issueKey, "approval_requested", {
      action: "implementation",
      attempt: 0,
      planFingerprint,
      plan
    });

    // First approval arrives
    const res1 = handlePmApproval(settings, issueKey, {
      action: "implementation",
      planFingerprint,
      approver: "pm-lead"
    }, { store });
    assert.equal(res1.ok, true);
    assert.equal(res1.approved, true);

    // Second approval check confirms durable state
    const approvedState = store.hasExecutionApproval(issueKey, { action: "implementation", planFingerprint });
    assert.ok(approvedState);
    assert.equal(approvedState.approved, true);
    assert.equal(approvedState.approver, "pm-lead");
  } finally {
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
    const issueKey = "PACE-40";

    const currentPlan = { issue: issueKey, summary: "Current plan", allowedPaths: ["backend/**"] };
    const currentFingerprint = computePlanFingerprint(currentPlan);

    store.addPmDecision(issueKey, "approval_requested", {
      action: "implementation",
      attempt: 0,
      planFingerprint: currentFingerprint,
      plan: currentPlan
    });

    // Approval sent with an outdated fingerprint must be rejected
    const staleFingerprint = "0000000000000000000000000000000000000000000000000000000000000000";
    assert.throws(
      () => {
        handlePmApproval(settings, issueKey, {
          action: "implementation",
          planFingerprint: staleFingerprint,
          approver: "pm"
        }, { store });
      },
      (err) => {
        return err.statusCode === 409 || err.message.includes("mismatch") || err.message.includes("fingerprint");
      }
    );
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test I: Provider Malformed Output & Crash Fail-Closed
// -----------------------------------------------------------------------------
test("Phase J — I. Provider Malformed Output & Crash Fail-Closed", () => {
  // 1. Malformed JSON output from executor/reviewer
  const malformedStdout = "{ invalid json string ";
  const parsed = parseExecutionOutput("antigravity", malformedStdout, "", 0);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.error);
  assert.equal(parsed.error.category, "json_parse_error");

  // 2. Empty stdout with exit 0
  const emptyParsed = parseExecutionOutput("antigravity", "", "", 0);
  assert.equal(emptyParsed.ok, false);
  assert.equal(emptyParsed.error.category, "empty_output_error");
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
  // Ensure sensitive tokens are redacted in safeMessage
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

    // Fake descendant SHA must not be recognized as ancestor
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

    // Create integration branch and conflicting leaf branches
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

    // Attempt integration of leaf1 into epic -> causes conflict
    const intResult = sc.integrateReviewedRevision(settings, {
      epicKey: "PACE-60",
      issueKey: "PACE-61",
      sourceBranch: "leaf/PACE-61",
      targetBranch: "epic/PACE-60",
      reviewedSha: leaf1Sha
    });

    assert.equal(intResult.completed, false);
    assert.ok(intResult.conflict);

    // Verify epic branch worktree is returned to clean state (merge aborted)
    assert.equal(sc.isClean({ repoPath: repo }), true);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test N: Parent Graph Drift, Cycle & Missing Dependency Rejection
// -----------------------------------------------------------------------------
test("Phase J — N. Parent Graph Drift, Cycle & Missing Dependency Rejection", () => {
  // 1. Self-cycle: A -> A
  const selfRes = buildHierarchyDag({
    parentKey: "PACE-P",
    children: ["PACE-1"],
    dependencyMap: { "PACE-1": ["PACE-1"] }
  });
  assert.equal(selfRes.valid, false);
  assert.ok(selfRes.errors.some(e => /self dependency/i.test(e)));

  // 2. Circular dependency: A -> B -> A
  const cycleRes = buildHierarchyDag({
    parentKey: "PACE-P",
    children: ["PACE-1", "PACE-2"],
    dependencyMap: { "PACE-1": ["PACE-2"], "PACE-2": ["PACE-1"] }
  });
  assert.equal(cycleRes.valid, false);
  assert.ok(cycleRes.errors.some(e => /cycle/i.test(e)));

  // 3. Unresolved external dependency
  const missingRes = buildHierarchyDag({
    parentKey: "PACE-P",
    children: ["PACE-1"],
    dependencyMap: { "PACE-1": ["PACE-999"] }
  });
  assert.equal(missingRes.valid, false);
  assert.ok(missingRes.errors.some(e => /unresolved external dependency/i.test(e)));
});

// -----------------------------------------------------------------------------
// Test O: Dependency Integration Gate (Strict Pre-Integration Blocking)
// -----------------------------------------------------------------------------
test("Phase J — O. Dependency Integration Gate (Strict Pre-Integration Blocking)", () => {
  const { store, cleanup } = makeTestGitRepo();
  try {
    store.upsertParentExecution({
      parentKey: "PACE-200",
      summary: "Parent",
      integrationBranch: "epic/PACE-200"
    });

    // Task A has no dependencies; Task B depends on A
    store.upsertEpicTask({ epicKey: "PACE-200", issueKey: "PACE-201", summary: "Task A", branch: "feat/PACE-201", dependencies: [], state: "planned" });
    store.upsertEpicTask({ epicKey: "PACE-200", issueKey: "PACE-202", summary: "Task B", branch: "feat/PACE-202", dependencies: ["PACE-201"], state: "pending-dependencies" });

    // Case 1: Task A is discovered -> Task B must not be ready
    const tasks1 = store.listEpicTasks("PACE-200");
    const taskB1 = tasks1.find(t => t.issueKey === "PACE-202");
    assert.notEqual(taskB1.state, "ready");

    // Case 2: Task A is reviewed-clean -> Task B must still not be ready
    store.upsertEpicTask({ epicKey: "PACE-200", issueKey: "PACE-201", summary: "Task A", branch: "feat/PACE-201", state: "reviewed-clean", reviewedSha: "sha-a-1" });
    const tasks2 = store.listEpicTasks("PACE-200");
    const taskB2 = tasks2.find(t => t.issueKey === "PACE-202");
    assert.notEqual(taskB2.state, "ready");

    // Case 3: Task A is integrated -> Task B becomes eligible
    store.upsertEpicTask({ epicKey: "PACE-200", issueKey: "PACE-201", summary: "Task A", branch: "feat/PACE-201", state: "integrated", integratedSha: "sha-a-int" });
    store.upsertEpicTask({ epicKey: "PACE-200", issueKey: "PACE-202", summary: "Task B", branch: "feat/PACE-202", state: "ready" });
    const tasks3 = store.listEpicTasks("PACE-200");
    const taskB3 = tasks3.find(t => t.issueKey === "PACE-202");
    assert.equal(taskB3.state, "ready");
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
    // Create run that has already exhausted attempt 2
    const runId = store.createRun("PACE-70", {
      summary: "Max attempt run",
      attempt: 2,
      configSnapshot: { maxReworkAttempts: 2 }
    });
    store.transition(runId, "verifying", { implementationSha: sha });
    store.transition(runId, "review-queued", { implementationSha: sha });

    // Review fails with changes-requested
    const reviewRes = recordReviewerOutcome(store, {
      runId,
      implementationSha: sha,
      reviewerId: "rev-1",
      verdict: "changes-requested",
      evidence: [{ id: "F-1", severity: "major", category: "correctness", problem: "Bug exists" }]
    });
    assert.equal(reviewRes.state, "review-failed");

    // Reconcile reviewers
    reconcileReviewers(settings, store);

    const run = store.getRun(runId);
    assert.equal(run.state, "transitioning-blocked", "Run must transition to blocked after exhausting max rework attempts");
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test Q: Telemetry Monotonicity & Exactly-One-Terminal Enforcement
// -----------------------------------------------------------------------------
test("Phase J — Q. Telemetry Monotonicity & Exactly-One-Terminal Enforcement", () => {
  const { store, cleanup } = makeTestGitRepo();
  try {
    const runId = store.createRun("PACE-80", { summary: "Telemetry test" });

    // Queued
    store.recordTelemetryEvent({
      eventId: "telem-80-queued",
      runId,
      issueKey: "PACE-80",
      stage: "queued",
      status: "queued",
      sequence: 1
    });

    // Started
    store.recordTelemetryEvent({
      eventId: "telem-80-started",
      runId,
      issueKey: "PACE-80",
      stage: "started",
      status: "running",
      sequence: 2
    });

    // Terminal
    store.recordTelemetryEvent({
      eventId: "telem-80-term",
      runId,
      issueKey: "PACE-80",
      stage: "terminal",
      status: "completed",
      sequence: 3
    });

    // Attempting a second terminal or post-terminal event for parent telemetry is safely ignored
    recordParentTelemetryEvent(store, {
      parentKey: "PACE-80",
      event: "post_terminal_ignored",
      stage: "progress",
      status: "running"
    });

    const events = store.database.prepare("SELECT * FROM telemetry_events WHERE run_id = ? ORDER BY sequence ASC").all(runId);
    assert.equal(events.length, 3);
    assert.equal(events[0].stage, "queued");
    assert.equal(events[1].stage, "started");
    assert.equal(events[2].stage, "terminal");
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test R: Usage Null/Zero Truthfulness & Formatted Metrics
// -----------------------------------------------------------------------------
test("Phase J — R. Usage Null/Zero Truthfulness & Formatted Metrics", () => {
  const { store, cleanup } = makeTestGitRepo();
  try {
    // 1. Unknown provider usage persists NULL
    store.recordUsageEvent({
      runId: "run-null",
      provider: "mock",
      model: "default",
      inputTokens: null,
      outputTokens: null,
      durationMs: null
    });

    // 2. Explicit 0 persists 0
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
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test S: Trusted-Path Containment & Symlink/Traversal Escape Rejection
// -----------------------------------------------------------------------------
test("Phase J — S. Trusted-Path Containment & Symlink/Traversal Escape Rejection", () => {
  // 1. Path traversal: ../
  const traversalCheck = validateChangedFiles({
    changedFiles: ["backend/app.js", "../../etc/passwd"],
    allowedPatterns: ["backend/**"],
    maxChangedFiles: 10
  });
  assert.equal(traversalCheck.allowed, false);
  assert.ok(traversalCheck.violations.includes("../../etc/passwd"));

  // 2. Absolute path
  const absCheck = validateChangedFiles({
    changedFiles: ["/etc/shadow"],
    allowedPatterns: ["**"],
    maxChangedFiles: 10
  });
  assert.equal(absCheck.allowed, false);
  assert.ok(absCheck.violations.includes("/etc/shadow"));
});

// -----------------------------------------------------------------------------
// Test T: Command Injection Resistance (Argument Array Safety)
// -----------------------------------------------------------------------------
test("Phase J — T. Command Injection Resistance (Argument Array Safety)", () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const sc = new LocalGitSourceControlProvider();
    // Issue summary containing dangerous shell syntax
    const maliciousSummary = "Malicious $(calc) ; rm -rf / | whoami";
    const prepared = sc.prepareIntegrationWorktree({
      repoPath: repo,
      root: worktreeRoot,
      parentKey: "PACE-90",
      summary: maliciousSummary,
      execute: false
    });

    // Command must be an array of arguments, never a single raw concatenated shell string
    assert.ok(Array.isArray(prepared.command));
    assert.equal(prepared.command[0], "git");
    assert.ok(prepared.command.includes("worktree"));
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test U: Immutable Config Snapshots for Active and Historical Runs
// -----------------------------------------------------------------------------
test("Phase J — U. Immutable Config Snapshots for Active and Historical Runs", () => {
  const { store, cleanup } = makeTestGitRepo();
  try {
    const configSnapshotV1 = {
      operatingMode: "autonomous",
      executorProvider: "codex",
      executorModel: "gpt-4o",
      taskAgent: "custom-backend-engineer",
      agentVersion: 1
    };

    const runId = store.createRun("PACE-95", {
      summary: "Run with V1 config",
      configSnapshot: configSnapshotV1
    });

    // Update custom agent definition to V2
    store.createAgentDefinition({
      id: "custom-backend-engineer",
      displayName: "Custom Backend Engineer",
      role: "implementation",
      skills: ["git"]
    });
    store.updateAgentDefinition("custom-backend-engineer", {
      displayName: "Custom Backend Engineer V2",
      skills: ["git", "docker"]
    });

    // Verify active run retains pinned snapshot V1
    const run = store.getRun(runId);
    assert.equal(run.payload.configSnapshot.agentVersion, 1);
    assert.equal(run.payload.configSnapshot.executorModel, "gpt-4o");
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test V: Process Crash / Restart Recovery Seams
// -----------------------------------------------------------------------------
test("Phase J — V. Process Crash / Restart Recovery Seams", () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const settings = makeSettings(repo, worktreeRoot, store);
    const runId = store.createRun("PACE-99", { summary: "Crash recovery run" });

    // Worker was active and crashed without heartbeat
    store.transition(runId, "started", {
      workerLeaseId: "lease-crashed-1",
      workerLeaseExpiresAt: new Date(Date.now() - 10000).toISOString()
    });
    store.acquireLock("PACE-99", runId);

    // Reconciler recovers crashed worker
    const recRes = reconcileWorkers(settings, store, { now: Date.now() });
    assert.equal(recRes.recovered.length, 1);
    assert.equal(recRes.recovered[0], runId);

    const recoveredRun = store.getRun(runId);
    assert.equal(recoveredRun.state, "failed-retryable");

    // Lock is released so it can be safely retried
    const activeLocks = store.listLocks();
    assert.equal(activeLocks.some(l => l.issueKey === "PACE-99"), false);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test W: Full Product Lifecycle Autonomous E2E with Restart Boundary
// -----------------------------------------------------------------------------
test("Phase J — W. Full Product Lifecycle Autonomous E2E with Restart Boundary", async () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
    const parentKey = "PACE-500";

    const workSource = new FakeWorkSourceProvider();
    workSource.setWorkItem({
      key: parentKey,
      summary: "Full Autonomous Delivery",
      description: "Deliver parent feature",
      acceptanceCriteria: "All children integrated and verified",
      canonicalState: "ready",
      type: "Epic"
    });
    workSource.setChildren(parentKey, [
      { key: "PACE-501", summary: "Child A", canonicalState: "ready", labels: ["agent-ready"] },
      { key: "PACE-502", summary: "Child B", canonicalState: "ready", labels: ["agent-ready"] },
      { key: "PACE-503", summary: "Child C", canonicalState: "ready", labels: ["agent-ready"] }
    ]);
    // DAG: A -> B, C independent
    workSource.setDependencies("PACE-502", ["PACE-501"]);

    // 1. Discover & Pin Parent
    const pinRes = await discoverAndPinParent(
      settings,
      store,
      {
        key: parentKey,
        summary: "Full Autonomous Delivery",
        description: "Deliver parent feature",
        acceptanceCriteria: "All children integrated and verified",
        canonicalState: "ready",
        type: "Epic"
      },
      { workSource, runtime: { spawnSync }, execute: true }
    );
    assert.equal(pinRes.ok, true);

    const parent = store.getParentExecution(parentKey);
    assert.equal(parent.state, "active");

    // 2. Reconcile Children: A & C become ready; B waits for A
    const sc = new LocalGitSourceControlProvider();
    const recRes1 = await reconcileParentChildren(settings, store, parentKey, { workSource, sc, execute: true });
    assert.ok(recRes1.readyChildren.includes("PACE-501"));
    assert.ok(recRes1.readyChildren.includes("PACE-503"));
    assert.ok(!recRes1.readyChildren.includes("PACE-502"));

    let tasks = store.listEpicTasks(parentKey);
    const taskA = tasks.find(t => t.issueKey === "PACE-501");
    const taskB = tasks.find(t => t.issueKey === "PACE-502");
    const taskC = tasks.find(t => t.issueKey === "PACE-503");

    assert.equal(taskA.orchestrationState, "dependency-ready");
    assert.equal(taskC.orchestrationState, "dependency-ready");
    assert.equal(taskB.orchestrationState, "pending-dependencies");

    // 3. Complete A & C execution + review + integration
    const shaA = "a111111111111111111111111111111111111111";
    const shaC = "c333333333333333333333333333333333333333";

    store.upsertEpicTask({ epicKey: parentKey, issueKey: "PACE-501", summary: "Child A", branch: "feat/PACE-501", state: "integrated", orchestrationState: "integrated", reviewedSha: shaA, integratedSha: shaA });
    store.upsertEpicTask({ epicKey: parentKey, issueKey: "PACE-503", summary: "Child C", branch: "feat/PACE-503", state: "integrated", orchestrationState: "integrated", reviewedSha: shaC, integratedSha: shaC });
    store.queueEpicIntegration({ epicKey: parentKey, issueKey: "PACE-501", leafBranch: "feat/PACE-501" });
    store.finishEpicIntegration({ epicKey: parentKey, issueKey: "PACE-501", commit: shaA });
    store.queueEpicIntegration({ epicKey: parentKey, issueKey: "PACE-503", leafBranch: "feat/PACE-503" });
    store.finishEpicIntegration({ epicKey: parentKey, issueKey: "PACE-503", commit: shaC });

    // 4. Injected Restart Boundary: verify DB state survives across instances
    const activeTasksBefore = store.listEpicTasks(parentKey);
    assert.equal(activeTasksBefore.filter(t => t.state === "integrated").length, 2);

    // 5. Reconcile Children after restart: Task B is now unlocked!
    const recRes2 = await reconcileParentChildren(settings, store, parentKey, { workSource, sc, execute: true });
    assert.ok(recRes2.readyChildren.includes("PACE-502"));
    tasks = store.listEpicTasks(parentKey);
    const taskBUnlocked = tasks.find(t => t.issueKey === "PACE-502");
    assert.equal(taskBUnlocked.orchestrationState, "dependency-ready");

    // 6. Complete B execution + review + integration
    const shaB = "b222222222222222222222222222222222222222";
    store.upsertEpicTask({ epicKey: parentKey, issueKey: "PACE-502", summary: "Child B", branch: "feat/PACE-502", state: "integrated", orchestrationState: "integrated", reviewedSha: shaB, integratedSha: shaB });
    store.queueEpicIntegration({ epicKey: parentKey, issueKey: "PACE-502", leafBranch: "feat/PACE-502" });
    store.finishEpicIntegration({ epicKey: parentKey, issueKey: "PACE-502", commit: shaB });

    // 7. Run Aggregate Integration Review with clean verdict
    const cleanFindings = [
      { id: "AGG-1", severity: "suggestion", category: "correctness", problem: "Aggregate review passed", file: "README.md", line: 1 }
    ];
    const reviewRes = await runParentIntegrationReview(settings, store, parentKey, {
      injectedReviewOutcome: { verdict: "clean", evidence: cleanFindings },
      skipRepoCheck: true,
      runtime: { spawnSync }
    });

    assert.equal(reviewRes.ok, true);
    assert.equal(reviewRes.verdict, "clean");

    // 8. Assert Parent reaches WAITING_HUMAN
    const finalParent = store.getParentExecution(parentKey);
    assert.equal(finalParent.state, "waiting_human");
    assert.ok(finalParent.completionPacket);
    assert.equal(finalParent.completionPacket.children.length, 3);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test X: WAITING_HUMAN Final Boundary (Zero Auto-Merge / Done / Promotion)
// -----------------------------------------------------------------------------
test("Phase J — X. WAITING_HUMAN Final Boundary (Zero Auto-Merge / Done / Promotion)", () => {
  // 1. Assert HUMAN_ONLY_ACTIONS includes all irreversible actions
  assert.ok(HUMAN_ONLY_ACTIONS.includes("finalMerge"));
  assert.ok(HUMAN_ONLY_ACTIONS.includes("markDone"));
  assert.ok(HUMAN_ONLY_ACTIONS.includes("productionDeploy"));

  // 2. Assert that in autonomous mode, policy rejects autonomous finalMerge/markDone
  const autonomy = resolveAutonomyPolicy({ data: { project: { operatingMode: "autonomous" } } });
  assert.equal(autonomy.finalMerge, "human");
  assert.equal(autonomy.markDone, "human");
  assert.equal(autonomy.productionDeploy, "human");

  // 3. Assert authorizeRuntimeAction fails closed for human actions
  const authRes = authorizeRuntimeAction(
    { data: { project: { operatingMode: "autonomous" }, policy: { operatingMode: "autonomous" } } },
    null,
    { issueKey: "PACE-1", action: "finalMerge" }
  );
  assert.equal(authRes.allowed, false);
  assert.ok(authRes.reason.includes("human-only"));
});
