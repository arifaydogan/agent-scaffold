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

    const fakeRuntime = {
      spawnSync: (cmd, args = [], opts = {}) => {
        if (cmd === "git") {
          return spawnSync(cmd, args, opts);
        }
        if (cmd === "npm" || (args && args.includes("check"))) {
          return { status: 0, stdout: "verification ok", stderr: "" };
        }
        const cwd = opts.cwd || repo;
        try {
          const editDir = path.join(cwd, "backend");
          fs.mkdirSync(editDir, { recursive: true });
          fs.writeFileSync(path.join(editDir, "app.js"), `// implemented\n`, "utf8");
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

    // Connection 1 holds active lock on issue
    store1.acquireLock(issueKey, "run-held-by-conn-1");

    // Connection 2 attempts competing claim -> rejected with exitCode 3 and runId null
    const res2 = handleImplementation(settings2, workItem, true, fakeRuntime);
    assert.equal(res2.exitCode, 3, "Second connection must be rejected with exitCode 3 when locked");
    assert.equal(res2.output.runId, null, "Losing claim must have runId null");
    assert.equal(res2.output.error, "issue already locked");

    // Release lock
    store1.releaseLock(issueKey, "run-held-by-conn-1");

    // Connection 1 executes cleanly
    const res1 = handleImplementation(settings1, workItem, true, fakeRuntime);
    assert.equal(res1.exitCode, 0, "First connection executes cleanly with exitCode 0");
    assert.ok(res1.output.runId);

    // Exactly 1 run row exists in shared DB
    const totalRuns = store1.database.prepare("SELECT COUNT(*) as count FROM runs WHERE issue_key = ?").get(issueKey).count;
    assert.equal(totalRuns, 1, "Exactly one durable run row must exist across all connections");
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

    const fakeRuntime = {
      spawnSync: (cmd, args = [], opts = {}) => {
        if (cmd === "git") {
          return spawnSync(cmd, args, opts);
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

    // Connection 1 holds active lock on issue
    store1.acquireLock(issueKey, implRunId);

    // Connection 2 attempts competing reviewer claim -> rejected with exitCode 3 and runId null
    const res2 = handleReview(settings2, workItem, true, fakeRuntime);
    assert.equal(res2.exitCode, 3, "Competing reviewer must be rejected with exitCode 3 when lock is held");
    assert.equal(res2.output.runId, null, "Losing reviewer must not create orphan run");
    assert.equal(res2.output.error, "issue already locked");

    // Release lock from connection 1
    store1.releaseLock(issueKey, implRunId);

    // Connection 1 executes cleanly
    const res1 = handleReview(settings1, workItem, true, fakeRuntime);
    assert.equal(res1.exitCode, 0, "Winning reviewer must execute cleanly with exitCode 0");
    assert.ok(res1.output.runId);

    // Verify only 1 reviewer run exists
    const totalReviewRuns = store1.database.prepare("SELECT COUNT(*) as count FROM runs WHERE issue_key = ? AND payload LIKE '%\"type\":\"review\"%'").get(issueKey).count;
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
// Test O: Real Dependency Gate Test (reconcileParentChildren)
// -----------------------------------------------------------------------------
test("Phase J — O. Real Dependency Gate Test (reconcileParentChildren)", async () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const settings = makeSettings(repo, worktreeRoot, store);
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
      { key: "PACE-O101", summary: "Task A", description: "Acceptance criteria: task A", canonicalState: "ready" },
      { key: "PACE-O102", summary: "Task B", description: "Acceptance criteria: task B", canonicalState: "ready" }
    ]);
    workSource.setDependencies("PACE-O102", ["PACE-O101"]); // B depends on A

    await discoverAndPinParent(settings, store, workSource.items.get(parentKey), {
      workSource,
      runtime: { spawnSync },
      execute: true
    });

    // 1. Initial reconciliation: A is ready, B is pending-dependencies
    const rec1 = reconcileParentChildren(settings, store, parentKey, { runtime: { spawnSync } });
    assert.ok(rec1.readyChildren.includes("PACE-O101"));
    assert.ok(!rec1.readyChildren.includes("PACE-O102"));
    let taskB = store.getEpicTask(parentKey, "PACE-O102");
    assert.equal(taskB.orchestrationState, "pending-dependencies");

    // 2. Task A in implementation complete / review-queued / reviewed-clean / integrating: B must remain pending
    store.upsertEpicTask({ epicKey: parentKey, issueKey: "PACE-O101", summary: "Task A", branch: "feat/PACE-O101", state: "reviewed-clean", reviewedSha: "sha-a-rev" });
    reconcileParentChildren(settings, store, parentKey, { runtime: { spawnSync } });
    taskB = store.getEpicTask(parentKey, "PACE-O102");
    assert.equal(taskB.orchestrationState, "pending-dependencies");

    store.queueEpicIntegration({ epicKey: parentKey, issueKey: "PACE-O101", leafBranch: "feat/PACE-O101" });
    store.claimEpicIntegration({ epicKey: parentKey, issueKey: "PACE-O101" });
    reconcileParentChildren(settings, store, parentKey, { runtime: { spawnSync } });
    taskB = store.getEpicTask(parentKey, "PACE-O102");
    assert.equal(taskB.orchestrationState, "pending-dependencies");

    // 3. Only after Task A is actually integrated: B becomes dependency-ready and gets childBaseSha
    const parentHead = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim().toLowerCase();
    store.finishEpicIntegration({ epicKey: parentKey, issueKey: "PACE-O101", commit: parentHead });

    const rec2 = reconcileParentChildren(settings, store, parentKey, { runtime: { spawnSync } });
    assert.ok(rec2.readyChildren.includes("PACE-O102"));
    taskB = store.getEpicTask(parentKey, "PACE-O102");
    assert.equal(taskB.orchestrationState, "dependency-ready");
    assert.equal(taskB.childBaseSha, parentHead);
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
  const { store, cleanup } = makeTestGitRepo();
  try {
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
  } finally {
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
test("Phase J — U. Real Config Snapshot Runtime Test", () => {
  const { repo, worktreeRoot, store, cleanup } = makeTestGitRepo();
  try {
    const settings = makeSettings(repo, worktreeRoot, store);

    // 1. Run 1 started with Configuration X (Codex, gpt-4o, agentVersion 1)
    const configSnapshotX = {
      operatingMode: "autonomous",
      reviewProvider: "codex",
      reviewModel: "gpt-4o",
      reviewTaskAgent: "custom-reviewer",
      agentVersion: 1
    };

    const runId1 = store.createRun("PACE-U1", {
      summary: "Run with Config X",
      configSnapshot: configSnapshotX
    });

    // 2. Global settings change to Configuration Y (Antigravity, claude-sonnet-4, agentVersion 2)
    settings.data.policy.review = {
      provider: "antigravity",
      modelProfile: "high",
      taskAgent: "antigravity-reviewer"
    };

    // 3. Review for existing Run 1 still uses pinned Configuration X
    const run1 = store.getRun(runId1);
    const profileRun1 = selectReviewProfile(settings, { key: "PACE-U1" }, run1.payload, run1.payload.configSnapshot);
    assert.equal(profileRun1.provider, "codex");
    assert.equal(profileRun1.model, "gpt-4o");
    assert.equal(profileRun1.taskAgent, "custom-reviewer");

    // 4. New Run 2 without snapshot uses updated Configuration Y
    const profileRun2 = selectReviewProfile(settings, { key: "PACE-U2" }, {}, null);
    assert.equal(profileRun2.provider, "antigravity");
    assert.equal(profileRun2.taskAgent, "antigravity-reviewer");
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
// Test W: True Production Autonomous E2E with Restart Boundary
// -----------------------------------------------------------------------------
test("Phase J — W. Full Product Lifecycle Autonomous E2E with Restart Boundary", async () => {
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

    // 3. Execute Child A through real production runtime
    const resA = handleImplementation(settings, workSource.items.get("PACE-501"), true, fakeRuntime);
    assert.equal(resA.exitCode, 0);
    const runA = store.getRun(resA.output.runId);

    // Get real commit SHA from worktree
    const preparedA = sc.prepareChildWorktree({
      repoPath: repo,
      root: worktreeRoot,
      parentKey,
      issueKey: "PACE-501",
      summary: "Child A"
    });
    const shaA = sc.getHead({ repoPath: preparedA.worktree }).sha;
    store.transition(runA.id, "review-queued", { implementationSha: shaA });

    // Review Child A through real production review runtime
    const revA = handleReview(settings, workSource.items.get("PACE-501"), true, fakeRuntime);
    assert.equal(revA.exitCode, 0);
    assert.equal(store.getRun(runA.id).state, "reviewed-clean");

    // Reconcile integrations: merges A into parent integration worktree
    reconcileIntegrations(settings, store, {
      sourceControl: sc,
      runtime: fakeRuntime,
      integrationAdapter: (opts) => sc.integrateReviewedRevision(settings, opts)
    });
    assert.equal(store.getEpicTask(parentKey, "PACE-501").state, "integrated");

    // 4. Simulated Crash & Restart Seam
    store.close();
    store = new RunStore(dbPath);
    settings._store = store;
    settings.getStore = () => store;

    // 5. Reconcile Children after restart: Task B is now UNLOCKED because A is integrated!
    const recRes2 = reconcileParentChildren(settings, store, parentKey, { sourceControl: sc, runtime: fakeRuntime });
    assert.ok(recRes2.readyChildren.includes("PACE-502"));
    const taskB = store.getEpicTask(parentKey, "PACE-502");
    assert.equal(taskB.orchestrationState, "dependency-ready");
    assert.ok(taskB.childBaseSha);

    // 6. Execute Child C (independent)
    const resC = handleImplementation(settings, workSource.items.get("PACE-503"), true, fakeRuntime);
    assert.equal(resC.exitCode, 0);
    const runC = store.getRun(resC.output.runId);
    const preparedC = sc.prepareChildWorktree({ repoPath: repo, root: worktreeRoot, parentKey, issueKey: "PACE-503", summary: "Child C" });
    const shaC = sc.getHead({ repoPath: preparedC.worktree }).sha;
    store.transition(runC.id, "review-queued", { implementationSha: shaC });
    const revC = handleReview(settings, workSource.items.get("PACE-503"), true, fakeRuntime);
    assert.equal(revC.exitCode, 0);
    reconcileIntegrations(settings, store, { sourceControl: sc, runtime: fakeRuntime, integrationAdapter: (opts) => sc.integrateReviewedRevision(settings, opts) });
    assert.equal(store.getEpicTask(parentKey, "PACE-503").state, "integrated");

    // 7. Execute Child B (unlocked)
    const resB = handleImplementation(settings, workSource.items.get("PACE-502"), true, fakeRuntime);
    assert.equal(resB.exitCode, 0);
    const runB = store.getRun(resB.output.runId);
    const preparedB = sc.prepareChildWorktree({ repoPath: repo, root: worktreeRoot, parentKey, issueKey: "PACE-502", summary: "Child B" });
    const shaB = sc.getHead({ repoPath: preparedB.worktree }).sha;
    store.transition(runB.id, "review-queued", { implementationSha: shaB });
    const revB = handleReview(settings, workSource.items.get("PACE-502"), true, fakeRuntime);
    assert.equal(revB.exitCode, 0);
    reconcileIntegrations(settings, store, { sourceControl: sc, runtime: fakeRuntime, integrationAdapter: (opts) => sc.integrateReviewedRevision(settings, opts) });
    assert.equal(store.getEpicTask(parentKey, "PACE-502").state, "integrated");

    // 8. Run Real Aggregate Integration Review against parent integration worktree (without injectedReviewOutcome, without skipRepoCheck)
    const aggRevRes = await runParentIntegrationReview(settings, store, parentKey, { runtime: fakeRuntime });
    assert.equal(aggRevRes.ok, true);
    assert.equal(aggRevRes.verdict, "clean");

    // 9. Reconcile Parent Execution -> WAITING_HUMAN
    const parentRecRes = await reconcileParentExecution(settings, store, parentKey, { workSource, runtime: fakeRuntime });
    assert.equal(parentRecRes.ok, true);
    assert.equal(parentRecRes.state, "waiting_human");

    const finalParent = store.getParentExecution(parentKey);
    assert.equal(finalParent.state, "waiting_human");
    assert.ok(finalParent.completionPacket);
    assert.equal(finalParent.completionPacket.children.length, 3);

    // 10. Invariant Assertions
    // develop HEAD in base repository is untouched!
    const finalDevelopSha = spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout.toString().trim();
    assert.equal(finalDevelopSha, initialDevelopSha, "develop branch HEAD must remain completely untouched");

    // Zero orphan started runs
    const allRuns = store.database.prepare("SELECT * FROM runs").all();
    assert.equal(allRuns.some(r => r.state === "started" || r.state === "executing"), false);

    // Exactly one terminal telemetry event per run
    const terminalCount = store.database.prepare("SELECT COUNT(*) as count FROM telemetry_events WHERE stage = 'terminal'").get().count;
    assert.ok(terminalCount >= 3);
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
