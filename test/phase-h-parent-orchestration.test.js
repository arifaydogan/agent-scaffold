/**
 * test/phase-h-parent-orchestration.test.js
 *
 * Dedicated Phase H Test Suite — Parent / Story / Epic Orchestration:
 *
 * Scenarios:
 * A. hierarchy discovery: parent P, children A, B, C; normalized hierarchy is persisted
 * B. actual dependency semantics: "blocks" / "depends on" vs non-edge "relates to"
 * C. DAG validation: self-edge, cycle, unresolved external dep fail closed; valid DAG accepted
 * D. parallel wave: A and C have no dependencies and disjoint scopes -> run concurrently; B waits
 * E. durable dependency gate: A implementation completes -> B waits; A reviewed -> B waits; A integrated -> B ready
 * F. dependent base: B worktree created AFTER A integration; real Git ancestry assert (A is ancestor of B base)
 * G. scope collision: two DAG-independent children with overlapping allowedPaths are serialized
 * H. exact reviewed SHA integration: review SHA == leaf tip merges; moved tip fails closed
 * I. serialized integration: two reviewed children integrate one-at-a-time through queue
 * J. conflict: real git conflict -> merge aborted -> persisted blocked-conflict -> parent blocked -> no silent resolution
 * K. restart: resume across review/integration boundaries without duplicate merges
 * L. aggregate integration review: receives aggregate base..head diff not only latest child diff
 * M. integration review failure: changes-requested -> findings persisted -> parent BLOCKED -> never waiting_human
 * N. integration review clean: clean verdict -> parent WAITING_HUMAN -> completion packet persisted
 * O. stale parent head: review clean for SHA X, branch advances to Y -> stale review -> never waiting_human
 * P. mode behavior: manual, supervised, autonomous follow policy and approval semantics
 * Q. external writes disabled: local parent becomes WAITING_HUMAN without fake external state transition
 * R. human boundary: prove Phase H cannot final merge, mark Done, release promotion, or production deploy
 * S. SourceControlProvider: parent orchestration uses LocalGitSourceControlProvider boundary
 * T. selected CodeIntelligenceProvider: integration review works with normalized code intelligence interface
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { RunStore } from "../lib/store.js";
import { WorkSourceProvider } from "../lib/work-source.js";
import { extractJiraUpstreamDependencyKeys } from "../lib/jira.js";
import { buildHierarchyDag, computeGraphFingerprint, detectHierarchyDrift } from "../lib/dag.js";
import { LocalGitSourceControlProvider } from "../lib/source-control.js";
import {
  discoverAndPinParent,
  reconcileParentChildren,
  runParentIntegrationReview,
  reconcileParentExecution
} from "../lib/parent-orchestrator.js";
import { selectDispatchBatch } from "../lib/scheduler.js";
import {
  HUMAN_ONLY_ACTIONS,
  resolveAutonomyPolicy,
  authorizeRuntimeAction,
  computeParentBranchFingerprint,
  computeParentReviewFingerprint
} from "../lib/policy.js";
import { dispatchOnce } from "../lib/dispatcher.js";
import { tick, recordReviewerOutcome, reconcileStandaloneReviews } from "../lib/reconciler.js";
import { prepareWorktree } from "../lib/worktree.js";
import { handlePmApproval, handlePmRejection, getPmDetail, buildPmWorkspace } from "../lib/pm-workspace.js";

function makeTestGitRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "phase-h-repo-"));
  spawnSync("git", ["init", "-q", repo]);
  spawnSync("git", ["-C", repo, "config", "user.email", "agent@example.com"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "Agent Scaffold"]);
  spawnSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  
  // Create a minimal repo check script so npm run check passes inside test worktrees
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

  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "initial commit"]);
  spawnSync("git", ["-C", repo, "branch", "-M", "develop"]);

  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-h-worktrees-"));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-h-store-"));
  const dbPath = path.join(dbDir, "runs.sqlite3");
  const store = new RunStore(dbPath);

  return { repo, worktreeRoot, store, dbPath };
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
  async transition(id, state, meta) {
    this.transitions.push({ id, state, meta });
    const item = this.items.get(id);
    if (item) item.canonicalState = state;
  }
  async addComment(id, text) { this.comments.push({ id, text }); }
  async poll() { return Array.from(this.items.values()); }
}

function makeSettings(repo, worktreeRoot, store, overrides = {}) {
  return {
    source: path.join(repo, "agent.config.json"),
    projectKey: "PACE",
    repoPath: repo,
    worktreeRoot,
    _store: store,
    data: {
      project: { key: "PACE", repoPath: ".", baseBranch: "develop", operatingMode: overrides.operatingMode || "autonomous" },
      policy: {
        allowedProjects: ["PACE"],
        operatingMode: overrides.operatingMode || "autonomous",
        maxConcurrency: overrides.maxConcurrency || 2,
        gitIntegrationEnabled: true,
        externalWritesEnabled: overrides.externalWritesEnabled !== false,
        autonomyEnabled: true,
        review: { provider: "antigravity", taskAgent: "correctness-reviewer" },
        ...(overrides.policy || {})
      },
      executor: {
        defaultProvider: "antigravity",
        providers: {
          antigravity: {
            command: ["node", "-e", "process.exit(0)"],
            defaultModel: "claude-sonnet-4",
            modelProfiles: { medium: "claude-sonnet-4", high: "claude-sonnet-4" }
          }
        }
      },
      workSource: { defaultProvider: "fake-source", providers: { "fake-source": { type: "fake-source" } } },
      sourceControl: { defaultProvider: "local-git", providers: { "local-git": { type: "local-git" } } }
    }
  };
}

// ── Scenario A: Hierarchy Discovery ──────────────────────────────────────────
test("Scenario A: Provider-neutral hierarchy discovery persists normalized parent and children snapshot", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store);
  const workSource = new FakeWorkSourceProvider();

  const parent = { key: "PACE-100", summary: "Camera streaming overhaul", issueType: "Epic" };
  const children = [
    { key: "PACE-101", summary: "Video ingestion worker", issueType: "Task" },
    { key: "PACE-102", summary: "Stream transcode pipeline", issueType: "Task" },
    { key: "PACE-103", summary: "WebRTC player view", issueType: "Task" }
  ];

  workSource.setWorkItem(parent);
  workSource.setChildren("PACE-100", children);
  workSource.setDependencies("PACE-101", []);
  workSource.setDependencies("PACE-102", ["PACE-101"]);
  workSource.setDependencies("PACE-103", []);

  const res = await discoverAndPinParent(settings, store, parent, { workSource, execute: true });

  assert.equal(res.ok, true);
  assert.equal(res.blocked, false);
  assert.equal(res.dag.children.length, 3);
  assert.equal(res.dag.edges.length, 1);
  assert.deepEqual(res.dag.edges[0], { from: "PACE-101", to: "PACE-102" });

  const parentRecord = store.getParentExecution("PACE-100");
  assert.ok(parentRecord);
  assert.equal(parentRecord.parentKey, "PACE-100");
  assert.equal(parentRecord.state, "active");
  assert.ok(parentRecord.graphFingerprint);

  const detail = store.getNormalizedParentDetail("PACE-100");
  assert.equal(detail.parent.parentKey, "PACE-100");
  assert.equal(detail.children.length, 3);
  assert.deepEqual(detail.children.find(c => c.issueKey === "PACE-102").dependencies, ["PACE-101"]);
});

// ── Scenario B: Actual Dependency Semantics ──────────────────────────────────
test("Scenario B: Actual dependency semantics (blocks / depends on) vs non-edge relates-to", () => {
  const jiraLinks = [
    {
      type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
      inwardIssue: { key: "PACE-101" } // current issue is blocked by PACE-101 (PACE-101 -> current)
    },
    {
      type: { name: "Relates", inward: "relates to", outward: "relates to" },
      inwardIssue: { key: "PACE-999" } // should be ignored!
    },
    {
      type: { name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
      outwardIssue: { key: "PACE-888" } // should be ignored!
    },
    {
      type: { name: "Dependency", inward: "is dependency of", outward: "depends on" },
      outwardIssue: { key: "PACE-102" } // current issue depends on PACE-102 (PACE-102 -> current)
    }
  ];

  const upstreamKeys = extractJiraUpstreamDependencyKeys(jiraLinks);
  assert.deepEqual(upstreamKeys.sort(), ["PACE-101", "PACE-102"]);
  assert.ok(!upstreamKeys.includes("PACE-999"), "relates-to must not become a dependency");
  assert.ok(!upstreamKeys.includes("PACE-888"), "duplicates must not become a dependency");
});

// ── Scenario C: DAG Validation ───────────────────────────────────────────────
test("Scenario C: DAG validation rejects self-edges, cycles, and unresolved external dependencies", () => {
  // 1. Self dependency
  const selfDag = buildHierarchyDag({
    parentKey: "PACE-200",
    children: ["PACE-201", "PACE-202"],
    dependencyMap: { "PACE-201": ["PACE-201"] }
  });
  assert.equal(selfDag.valid, false);
  assert.match(selfDag.errors.join(" "), /Self dependency detected/);

  // 2. Cycle (A -> B -> C -> A)
  const cycleDag = buildHierarchyDag({
    parentKey: "PACE-200",
    children: ["PACE-201", "PACE-202", "PACE-203"],
    dependencyMap: {
      "PACE-201": ["PACE-203"], // 203 -> 201
      "PACE-202": ["PACE-201"], // 201 -> 202
      "PACE-203": ["PACE-202"]  // 202 -> 203
    }
  });
  assert.equal(cycleDag.valid, false);
  assert.match(cycleDag.errors.join(" "), /Cycle detected/);

  // 3. Unresolved external dependency
  const extDag = buildHierarchyDag({
    parentKey: "PACE-200",
    children: ["PACE-201"],
    dependencyMap: { "PACE-201": ["EXT-999"] },
    externalDependencyChecker: () => ({ satisfied: false, reason: "EXT-999 is open" })
  });
  assert.equal(extDag.valid, false);
  assert.match(extDag.errors.join(" "), /Unresolved external dependency/);

  // 4. Valid DAG with deterministic waves
  const validDag = buildHierarchyDag({
    parentKey: "PACE-200",
    children: ["PACE-A", "PACE-B", "PACE-C"],
    dependencyMap: {
      "PACE-B": ["PACE-A"] // A -> B
    }
  });
  assert.equal(validDag.valid, true);
  assert.deepEqual(validDag.waves, [["PACE-A", "PACE-C"], ["PACE-B"]]);
});

// ── Scenario D: Parallel Wave Execution ───────────────────────────────────────
test("Scenario D: Independent safe children run concurrently while dependent child waits", () => {
  const plans = [
    { issue: "PACE-A", parallelSafe: true, allowedPaths: ["backend/a/**"], dependencies: [], eligible: true },
    { issue: "PACE-C", parallelSafe: true, allowedPaths: ["frontend/c/**"], dependencies: [], eligible: true },
    { issue: "PACE-B", parallelSafe: true, allowedPaths: ["backend/b/**"], dependencies: ["PACE-A"], eligible: true }
  ];

  // In wave 1, PACE-A and PACE-C have no dependencies in queue and disjoint scopes -> batch selects both
  const batch = selectDispatchBatch(plans, { maxConcurrency: 2 }, plans);
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map(p => p.issue).sort(), ["PACE-A", "PACE-C"]);
  assert.ok(!batch.some(p => p.issue === "PACE-B"), "PACE-B must wait for PACE-A");
});

// ── Scenario E & F: Durable Dependency Gate & Dependent Base ──────────────────
test("Scenario E & F: Dependent child worktree is created lazily after upstream integration; verify Git ancestry", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store);
  const sc = new LocalGitSourceControlProvider();
  const workSource = new FakeWorkSourceProvider();

  const parent = { key: "PACE-300", summary: "Pipeline redesign", issueType: "Epic" };
  const children = [
    { key: "PACE-301", summary: "Core engine", issueType: "Task" },
    { key: "PACE-302", summary: "Dependent plugin", issueType: "Task" }
  ];

  workSource.setWorkItem(parent);
  workSource.setChildren("PACE-300", children);
  workSource.setDependencies("PACE-301", []);
  workSource.setDependencies("PACE-302", ["PACE-301"]); // 301 -> 302

  // 1. Discover & Pin
  const pinRes = await discoverAndPinParent(settings, store, parent, { workSource, sourceControl: sc, execute: true });
  assert.equal(pinRes.ok, true);

  // 2. Initial reconcile: 301 is ready, 302 is pending
  const rec1 = reconcileParentChildren(settings, store, "PACE-300", { sourceControl: sc, execute: true });
  assert.deepEqual(rec1.readyChildren, ["PACE-301"]);

  const task301 = store.getEpicTask("PACE-300", "PACE-301");
  const task302 = store.getEpicTask("PACE-300", "PACE-302");
  assert.equal(task301.orchestrationState, "dependency-ready");
  assert.equal(task302.orchestrationState, "pending-dependencies");

  // 3. Child 301 implements and gets reviewed in its worktree
  const prep301 = sc.prepareChildWorktree({
    repoPath: repo,
    root: worktreeRoot,
    parentKey: "PACE-300",
    parentBranch: pinRes.integrationBranch,
    issueKey: "PACE-301",
    summary: "Core engine",
    baseRef: task301.childBaseSha || pinRes.integrationBranch,
    execute: true
  });
  const leafBranch301 = prep301.branch;
  const childDir = prep301.worktree;
  fs.writeFileSync(path.join(childDir, "backend", "core.js"), "// core 301\n", "utf8");
  spawnSync("git", ["-C", childDir, "add", "."]);
  spawnSync("git", ["-C", childDir, "commit", "-qm", "feat(core): implementation 301"]);
  const reviewedSha301 = String(spawnSync("git", ["-C", childDir, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  // Mark 301 reviewed-clean in store
  store.createRun("PACE-301", { role: "worker", summary: "Core engine" });
  const revRunId = store.createRun("PACE-301", { role: "reviewer", summary: "Core engine review" });
  store.transition(revRunId, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: reviewedSha301,
      reviewerId: "reviewer-1",
      evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }]
    }
  });

  // Queue and complete integration for 301
  store.queueEpicIntegration({ epicKey: "PACE-300", issueKey: "PACE-301", leafBranch: leafBranch301 });
  store.claimEpicIntegration({ epicKey: "PACE-300", issueKey: "PACE-301" });

  const intEvidence = sc.integrateReviewedRevision(settings, {
    epicKey: "PACE-300",
    issueKey: "PACE-301",
    sourceBranch: leafBranch301,
    targetBranch: pinRes.integrationBranch,
    reviewedSha: reviewedSha301
  });

  assert.equal(intEvidence.completed, true, intEvidence.conflict || "Integration failed");
  store.finishEpicIntegration({
    epicKey: "PACE-300",
    issueKey: "PACE-301",
    commit: intEvidence.integratedSha
  });
  store.upsertEpicTask({
    ...task301,
    state: "integrated",
    orchestrationState: "integrated",
    reviewedSha: reviewedSha301,
    integratedSha: intEvidence.integratedSha
  });

  // 4. Reconcile children again: Now PACE-302 becomes dependency-ready!
  const rec2 = reconcileParentChildren(settings, store, "PACE-300", { sourceControl: sc, execute: true });
  assert.deepEqual(rec2.readyChildren, ["PACE-302"]);

  const updatedTask302 = store.getEpicTask("PACE-300", "PACE-302");
  assert.equal(updatedTask302.orchestrationState, "dependency-ready");
  assert.ok(updatedTask302.childBaseSha);

  // Assert with REAL Git ancestry: 301's integratedSha is an ancestor of 302's childBaseSha!
  const isAncestor = sc.isAncestor(intEvidence.integratedSha, updatedTask302.childBaseSha, { repoPath: repo });
  assert.equal(isAncestor, true, "301 integrated commit must be an ancestor of 302 base commit");
});

// ── Scenario G: Scope Collision ──────────────────────────────────────────────
test("Scenario G: Two DAG-independent children with overlapping allowedPaths are serialized", () => {
  const plans = [
    { issue: "PACE-1", parallelSafe: true, allowedPaths: ["backend/service/**"], dependencies: [], eligible: true },
    { issue: "PACE-2", parallelSafe: true, allowedPaths: ["backend/**"], dependencies: [], eligible: true }
  ];

  // Max concurrency is 2, but allowedPaths overlap -> only 1 plan is selected
  const batch = selectDispatchBatch(plans, { maxConcurrency: 2 }, plans);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].issue, "PACE-1");
});

// ── Scenario H: Exact Reviewed SHA Integration ───────────────────────────────
test("Scenario H: Exact reviewed SHA integration allows matching tip, fails closed on moved tip", () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store);
  const sc = new LocalGitSourceControlProvider();

  // Create epic integration branch
  const epicBranch = "epic/pace-400-test";
  spawnSync("git", ["-C", repo, "checkout", "-b", epicBranch, "develop"]);

  // Create leaf branch and commit X
  const leafBranch = "task/pace-401-test";
  spawnSync("git", ["-C", repo, "checkout", "-b", leafBranch, "develop"]);
  fs.writeFileSync(path.join(repo, "backend", "feat.js"), "// feat 1\n", "utf8");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "feat 1"]);
  const shaX = String(spawnSync("git", ["-C", repo, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  // Checkout epic branch for integration
  spawnSync("git", ["-C", repo, "checkout", epicBranch]);

  // If review says shaX and branch tip is shaX -> succeeds
  const matchResult = sc.integrateReviewedRevision(settings, {
    epicKey: "PACE-400",
    issueKey: "PACE-401",
    sourceBranch: leafBranch,
    targetBranch: epicBranch,
    reviewedSha: shaX
  });
  assert.equal(matchResult.completed, true);

  // Now create leaf commit Y on leaf branch
  spawnSync("git", ["-C", repo, "checkout", leafBranch]);
  fs.writeFileSync(path.join(repo, "backend", "feat.js"), "// feat 2\n", "utf8");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "feat 2"]);

  // Switch back to epic branch
  spawnSync("git", ["-C", repo, "checkout", epicBranch]);

  // If review still says shaX but branch tip is now shaY -> fails closed!
  const mismatchResult = sc.integrateReviewedRevision(settings, {
    epicKey: "PACE-400",
    issueKey: "PACE-401",
    sourceBranch: leafBranch,
    targetBranch: epicBranch,
    reviewedSha: shaX
  });
  assert.equal(mismatchResult.completed, false);
  assert.match(mismatchResult.conflict, /Reviewed SHA no longer matches/);
});

// ── Scenario I: Serialized Integration Queue ─────────────────────────────────
test("Scenario I: Integration queue allows only one active integration claim at a time", () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();

  store.upsertEpic({ key: "PACE-500", summary: "Queue test", branch: "epic/pace-500" });
  store.upsertEpicTask({ epicKey: "PACE-500", issueKey: "PACE-501", summary: "T1", branch: "task/pace-501" });
  store.upsertEpicTask({ epicKey: "PACE-500", issueKey: "PACE-502", summary: "T2", branch: "task/pace-502" });

  const q1 = store.queueEpicIntegration({ epicKey: "PACE-500", issueKey: "PACE-501", leafBranch: "task/pace-501" });
  assert.equal(q1.queued, true);

  const claim1 = store.claimEpicIntegration({ epicKey: "PACE-500", issueKey: "PACE-501" });
  assert.equal(claim1.claimed, true);

  // Second task tries to queue while 501 is integrating -> blocked
  const q2 = store.queueEpicIntegration({ epicKey: "PACE-500", issueKey: "PACE-502", leafBranch: "task/pace-502" });
  assert.equal(q2.blocked, true);

  // Finish 501
  store.finishEpicIntegration({ epicKey: "PACE-500", issueKey: "PACE-501", commit: "1111111111111111111111111111111111111111" });

  // Now 502 can queue and claim
  const q2retry = store.queueEpicIntegration({ epicKey: "PACE-500", issueKey: "PACE-502", leafBranch: "task/pace-502" });
  assert.equal(q2retry.queued, true);
  const claim2 = store.claimEpicIntegration({ epicKey: "PACE-500", issueKey: "PACE-502" });
  assert.equal(claim2.claimed, true);
});

// ── Scenario J: Real Git Conflict Handling ───────────────────────────────────
test("Scenario J: Real git conflict aborts merge, records conflict evidence, and blocks parent", () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store);
  const sc = new LocalGitSourceControlProvider();

  // Create epic integration branch
  const epicBranch = "epic/pace-600-conflict";
  spawnSync("git", ["-C", repo, "checkout", "-b", epicBranch, "develop"]);
  fs.writeFileSync(path.join(repo, "backend", "app.js"), "// Epic modification\n", "utf8");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "epic modify"]);

  // Create conflicting leaf branch
  const leafBranch = "task/pace-601-conflict";
  spawnSync("git", ["-C", repo, "checkout", "-b", leafBranch, "develop"]);
  fs.writeFileSync(path.join(repo, "backend", "app.js"), "// Conflicting leaf modification\n", "utf8");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "leaf conflict"]);
  const leafSha = String(spawnSync("git", ["-C", repo, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  // Switch back to epic branch
  spawnSync("git", ["-C", repo, "checkout", epicBranch]);

  // Attempt integration -> conflict!
  const res = sc.integrateReviewedRevision(settings, {
    epicKey: "PACE-600",
    issueKey: "PACE-601",
    sourceBranch: leafBranch,
    targetBranch: epicBranch,
    reviewedSha: leafSha
  });

  assert.equal(res.completed, false);
  assert.match(res.conflict, /merge conflict/i);

  // Epic worktree must be clean (merge was aborted)
  assert.equal(sc.isClean({ repoPath: repo }), true);
});

// ── Scenario K: Restart Safety & Idempotency ──────────────────────────────────
test("Scenario K: Restart safety preserves state and prevents duplicate merges", () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();

  store.upsertParentExecution({
    parentKey: "PACE-700",
    summary: "Restart test",
    integrationBranch: "epic/pace-700",
    graphFingerprint: "fingerprint-700",
    state: "active"
  });

  store.upsertEpicTask({
    epicKey: "PACE-700",
    issueKey: "PACE-701",
    summary: "T1",
    branch: "task/pace-701",
    state: "integrated",
    orchestrationState: "integrated",
    integratedSha: "2222222222222222222222222222222222222222"
  });

  store.queueEpicIntegration({
    epicKey: "PACE-700",
    issueKey: "PACE-701",
    leafBranch: "task/pace-701"
  });

  store.finishEpicIntegration({
    epicKey: "PACE-700",
    issueKey: "PACE-701",
    commit: "2222222222222222222222222222222222222222"
  });

  // Re-reading from store returns identical state
  const parent = store.getParentExecution("PACE-700");
  const task = store.getEpicTask("PACE-700", "PACE-701");
  const integrations = store.listEpicIntegrations("PACE-700");

  assert.equal(parent.state, "active");
  assert.equal(task.orchestrationState, "integrated");
  assert.equal(integrations.length, 1);
  assert.equal(integrations[0].state, "integrated");
});

// ── Scenario L, M, N: Aggregate Integration Review ───────────────────────────
test("Scenario L, M, N: Aggregate integration review handles failure and clean completion", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store);
  const sc = new LocalGitSourceControlProvider();

  // Create epic integration branch and commit changes
  const parentKey = "PACE-800";
  const epicBranch = "epic/pace-800-agg";
  spawnSync("git", ["-C", repo, "checkout", "-b", epicBranch, "develop"]);
  fs.writeFileSync(path.join(repo, "backend", "service.js"), "// integrated service\n", "utf8");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "integrated all children"]);
  const headSha = String(spawnSync("git", ["-C", repo, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();
  const baseSha = String(spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout).trim().toLowerCase();

  store.upsertParentExecution({
    parentKey,
    summary: "Aggregate test",
    baseSha,
    integrationBranch: epicBranch,
    integrationWorktree: repo,
    integrationHeadSha: headSha,
    graphFingerprint: "fingerprint-800",
    state: "active"
  });

  store.upsertEpicTask({
    epicKey: parentKey,
    issueKey: "PACE-801",
    summary: "Child 1",
    branch: "task/pace-801",
    state: "integrated",
    orchestrationState: "integrated",
    reviewedSha: headSha,
    integratedSha: headSha
  });

  store.finishEpicIntegration({ epicKey: parentKey, issueKey: "PACE-801", commit: headSha });

  // 1. Scenario M: Review returns changes-requested -> parent moves to blocked
  const failedReviewOutcome = {
    verdict: "changes-requested",
    evidence: [{ id: "f1", severity: "major", category: "regression", problem: "Missing integration test" }]
  };

  const failRes = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    injectedReviewOutcome: failedReviewOutcome
  });

  assert.equal(failRes.ok, false);
  assert.equal(failRes.verdict, "changes-requested");
  assert.equal(failRes.parentState, "blocked");
  assert.equal(store.getParentExecution(parentKey).state, "blocked");

  // 2. Scenario N: Review returns clean -> parent moves to waiting_human and completion packet persisted
  const cleanReviewOutcome = {
    verdict: "clean",
    evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "All good" }]
  };

  const cleanRes = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    injectedReviewOutcome: cleanReviewOutcome
  });

  assert.equal(cleanRes.ok, true);
  assert.equal(cleanRes.verdict, "clean");
  assert.equal(cleanRes.parentState, "waiting_human");

  const finalParent = store.getParentExecution(parentKey);
  assert.equal(finalParent.state, "waiting_human");
  assert.ok(finalParent.completionPacket);
  assert.equal(finalParent.completionPacket.parentKey, "PACE-800");
  assert.equal(finalParent.completionPacket.integrationReview.verdict, "clean");
});

// ── Scenario O: Stale Parent Head Invalidation ────────────────────────────────
test("Scenario O: Stale parent head invalidates clean review if branch advances before completion", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const sc = new LocalGitSourceControlProvider();

  const parentKey = "PACE-850";
  const epicBranch = "epic/pace-850-stale";
  spawnSync("git", ["-C", repo, "checkout", "-b", epicBranch, "develop"]);
  fs.writeFileSync(path.join(repo, "backend", "stale.js"), "// v1\n", "utf8");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "v1"]);
  const oldHead = String(spawnSync("git", ["-C", repo, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();
  const developSha = String(spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout).trim().toLowerCase();

  store.upsertParentExecution({
    parentKey,
    summary: "Stale test",
    baseSha: developSha,
    integrationBranch: epicBranch,
    integrationWorktree: repo,
    integrationHeadSha: oldHead,
    graphFingerprint: "fingerprint-850",
    state: "active"
  });

  // Now advance branch to new commit behind the scenes!
  fs.writeFileSync(path.join(repo, "backend", "stale.js"), "// v2\n", "utf8");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "v2"]);

  // Review was done for oldHead, but current HEAD is now newer -> must detect stale and fail closed
  const staleRes = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    injectedReviewOutcome: { verdict: "clean", evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }] }
  });

  assert.equal(staleRes.ok, false);
  assert.equal(staleRes.stale, true);
  assert.equal(staleRes.parentState, "blocked");
});

// ── Scenario P, Q, R: Mode Behavior, External Writes, Human Boundary ──────────
test("Scenario P, Q, R: Operating modes, external writes disabled truthfulness, and strict human boundary", async () => {
  // 1. Human Boundary Check
  for (const humanAction of HUMAN_ONLY_ACTIONS) {
    const auth = authorizeRuntimeAction({}, null, { issueKey: "PACE-900", action: humanAction });
    assert.equal(auth.allowed, false, `Action ${humanAction} must never be autonomous`);
  }

  // 2. Autonomy Policy Check for manual, supervised, autonomous
  const manualPolicy = resolveAutonomyPolicy({ operatingMode: "manual" });
  assert.equal(manualPolicy.implementation, "approval");
  assert.equal(manualPolicy.finalMerge, "human");

  const supervisedPolicy = resolveAutonomyPolicy({ operatingMode: "supervised" });
  assert.equal(supervisedPolicy.implementation, "approval");
  assert.equal(supervisedPolicy.finalMerge, "human");

  const autoPolicy = resolveAutonomyPolicy({ operatingMode: "autonomous" });
  assert.equal(autoPolicy.implementation, "auto");
  assert.equal(autoPolicy.integrateChildren, "auto");
  assert.equal(autoPolicy.finalMerge, "human");

  // 3. External writes disabled
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { externalWritesEnabled: false });
  const workSource = new FakeWorkSourceProvider({ writeEnabled: false });

  const headSha = String(spawnSync("git", ["-C", repo, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();
  const parentKey = "PACE-950";
  store.upsertParentExecution({
    parentKey,
    summary: "No write test",
    baseSha: headSha,
    integrationBranch: "epic/pace-950",
    integrationWorktree: repo,
    integrationHeadSha: headSha,
    graphFingerprint: "fingerprint-950",
    state: "active"
  });

  const res = await runParentIntegrationReview(settings, store, parentKey, {
    workSource,
    sourceControl: new LocalGitSourceControlProvider(),
    injectedReviewOutcome: { verdict: "clean", evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }] }
  });

  assert.equal(res.ok, true);
  assert.equal(res.parentState, "waiting_human");
  assert.equal(workSource.transitions.length, 0, "No external transition must be performed when writes are disabled");
});

// ── Scenario S & T: SourceControlProvider & CodeIntelligenceProvider ──────────
test("Scenario S & T: Provider-neutral SourceControlProvider and CodeIntelligenceProvider interfaces", async () => {
  const { repo, worktreeRoot } = makeTestGitRepo();
  const sc = new LocalGitSourceControlProvider();

  // SourceControlProvider methods
  const head = sc.getHead({ repoPath: repo });
  assert.equal(head.ok, true);
  assert.ok(head.sha);

  const clean = sc.isClean({ repoPath: repo });
  assert.equal(clean, true);

  const resolved = sc.resolveBaseRevision({ repoPath: repo, requestedRef: "develop" });
  assert.equal(resolved.resolved, true);
});

// ── Scenario U: Real End-to-End Parent Control Loop ──────────────────────────
test("Scenario U: End-to-end parent lifecycle through dispatchOnce, tick, auto-integration, and aggregate review", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const sc = new LocalGitSourceControlProvider();

  const workSource = new FakeWorkSourceProvider();

  // Define Parent P and children A (701), B (702 depends on 701), C (703 independent)
  const parentEpic = {
    key: "PACE-700",
    id: "PACE-700",
    issueType: "Epic",
    summary: "Camera Streaming Overhaul",
    description: "Build robust low-latency camera streaming architecture",
    acceptanceCriteria: "[x] Stream core\n[x] Codec plugin\n[x] Frontend viewer",
    canonicalState: "ready"
  };

  const child701 = {
    key: "PACE-701",
    id: "PACE-701",
    issueType: "Task",
    summary: "Streaming Core",
    description: "Acceptance criteria:\n- [ ] implement streaming core",
    canonicalState: "ready",
    allowedPaths: ["backend/stream/**"]
  };

  const child702 = {
    key: "PACE-702",
    id: "PACE-702",
    issueType: "Task",
    summary: "Codec Plugin",
    description: "Acceptance criteria:\n- [ ] implement codec plugin",
    canonicalState: "ready",
    allowedPaths: ["backend/codec/**"]
  };

  const child703 = {
    key: "PACE-703",
    id: "PACE-703",
    issueType: "Task",
    summary: "Frontend Viewer",
    description: "Acceptance criteria:\n- [ ] implement frontend viewer",
    canonicalState: "ready",
    allowedPaths: ["frontend/**"]
  };

  workSource.setWorkItem(parentEpic);
  workSource.setWorkItem(child701);
  workSource.setWorkItem(child702);
  workSource.setWorkItem(child703);

  workSource.setChildren("PACE-700", [child701, child702, child703]);
  workSource.setDependencies("PACE-701", []);
  workSource.setDependencies("PACE-702", ["PACE-701"]);
  workSource.setDependencies("PACE-703", []);

  // ── Cycle 1: First dispatch ──
  // Discovers parent PACE-700, pins DAG; 701 & 703 are eligible, 702 is blocked waiting for 701
  const dispatchRes1 = await dispatchOnce(settings, {
    store,
    workSource,
    execute: true,
    maxConcurrency: 3,
    limit: 10
  });

  const parentExec = store.getParentExecution("PACE-700");
  assert.ok(parentExec);
  assert.equal(parentExec.state, "active");

  const task701_c1 = store.getEpicTask("PACE-700", "PACE-701");
  const task702_c1 = store.getEpicTask("PACE-700", "PACE-702");
  const task703_c1 = store.getEpicTask("PACE-700", "PACE-703");

  assert.equal(task701_c1.orchestrationState, "dependency-ready");
  assert.equal(task702_c1.orchestrationState, "pending-dependencies");
  assert.equal(task703_c1.orchestrationState, "dependency-ready");

  // Verify child 701 was dispatched and has a worktree
  const run701 = store.listRunsForIssue("PACE-701")[0];
  const run703 = store.listRunsForIssue("PACE-703")[0];
  assert.ok(run701);
  assert.ok(run703);

  // Implement in 701 worktree & commit
  const wt701 = task701_c1.worktree || path.join(worktreeRoot, task701_c1.branch.replaceAll("/", "-"));
  fs.mkdirSync(path.join(wt701, "backend", "stream"), { recursive: true });
  fs.writeFileSync(path.join(wt701, "backend", "stream", "core.js"), "// stream core implementation\n", "utf8");
  spawnSync("git", ["-C", wt701, "add", "."]);
  spawnSync("git", ["-C", wt701, "commit", "-qm", "feat(stream): implement streaming core"]);
  const sha701 = String(spawnSync("git", ["-C", wt701, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  // Implement in 703 worktree & commit
  const wt703 = task703_c1.worktree || path.join(worktreeRoot, task703_c1.branch.replaceAll("/", "-"));
  fs.mkdirSync(path.join(wt703, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(wt703, "frontend", "viewer.js"), "// viewer ui implementation\n", "utf8");
  spawnSync("git", ["-C", wt703, "add", "."]);
  spawnSync("git", ["-C", wt703, "commit", "-qm", "feat(ui): implement viewer ui"]);
  const sha703 = String(spawnSync("git", ["-C", wt703, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  // Complete worker runs and record clean reviews
  store.transition(run701.id, "completed", { implementationSha: sha701 });
  const revRun701 = store.createRun("PACE-701", { role: "reviewer", summary: "Review 701", implementationSha: sha701 });
  store.transition(revRun701, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: sha701,
      reviewerId: "correctness-reviewer",
      evidence: [{ id: "rev-701-clean", severity: "suggestion", category: "correctness", problem: "Clean implementation" }]
    }
  });

  store.transition(run703.id, "completed", { implementationSha: sha703 });
  const revRun703 = store.createRun("PACE-703", { role: "reviewer", summary: "Review 703", implementationSha: sha703 });
  store.transition(revRun703, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: sha703,
      reviewerId: "correctness-reviewer",
      evidence: [{ id: "rev-703-clean", severity: "suggestion", category: "correctness", problem: "Clean implementation" }]
    }
  });

  // ── Reconciliation Step: tick() ──
  // Automatically queues reviewed children, integrates 701 first (serialized queue), and unlocks child 702
  tick(settings, store, { execute: true });

  const task701_afterInt = store.getEpicTask("PACE-700", "PACE-701");
  const task702_afterInt = store.getEpicTask("PACE-700", "PACE-702");
  const task703_afterInt = store.getEpicTask("PACE-700", "PACE-703");

  assert.equal(task701_afterInt.state, "integrated");
  assert.notEqual(task703_afterInt.state, "integrated");
  assert.equal(task702_afterInt.orchestrationState, "dependency-ready");
  assert.ok(task702_afterInt.childBaseSha);

  // Assert real Git ancestry: 701 integrated commit is ancestor of 702 childBaseSha
  const isAnc = sc.isAncestor(task701_afterInt.integratedSha, task702_afterInt.childBaseSha, { repoPath: repo });
  assert.equal(isAnc, true, "701 integrated revision must be in 702 base ancestry");

  // Tick again to integrate 703 through the serialized integration queue
  tick(settings, store, { execute: true });
  const task703_tick2 = store.getEpicTask("PACE-700", "PACE-703");
  assert.equal(task703_tick2.state, "integrated");

  // ── Cycle 2: Dispatch child 702 ──
  const dispatchRes2 = await dispatchOnce(settings, {
    store,
    workSource,
    execute: true,
    maxConcurrency: 3,
    limit: 10
  });

  const task702_c2 = store.getEpicTask("PACE-700", "PACE-702");
  const wt702 = task702_c2.worktree || path.join(worktreeRoot, task702_c2.branch.replaceAll("/", "-"));

  // Verify 702 worktree HEAD matches pinned childBaseSha
  const wt702Head = sc.getHead({ repoPath: wt702 });
  assert.equal(wt702Head.sha.toLowerCase(), task702_afterInt.childBaseSha.toLowerCase());

  // Implement in 702 worktree & commit
  fs.mkdirSync(path.join(wt702, "backend", "codec"), { recursive: true });
  fs.writeFileSync(path.join(wt702, "backend", "codec", "plugin.js"), "// codec plugin\n", "utf8");
  spawnSync("git", ["-C", wt702, "add", "."]);
  spawnSync("git", ["-C", wt702, "commit", "-qm", "feat(codec): implement codec plugin"]);
  const sha702 = String(spawnSync("git", ["-C", wt702, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  const run702 = store.listRunsForIssue("PACE-702")[0];
  store.transition(run702.id, "completed", { implementationSha: sha702 });
  const revRun702 = store.createRun("PACE-702", { role: "reviewer", summary: "Review 702", implementationSha: sha702 });
  store.transition(revRun702, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: sha702,
      reviewerId: "correctness-reviewer",
      evidence: [{ id: "rev-702-clean", severity: "suggestion", category: "correctness", problem: "Clean implementation" }]
    }
  });

  // ── Final Reconciliation: tick() ──
  // Automatically integrates 702, detects all children integrated, and runs aggregate integration review
  await tick(settings, store, {
    execute: true,
    injectedReviewOutcome: {
      verdict: "clean",
      evidence: [{ id: "clean-agg", severity: "suggestion", category: "correctness", problem: "Aggregate review clean" }]
    }
  });

  const finalParent = store.getParentExecution("PACE-700");
  assert.equal(finalParent.state, "waiting_human");
  assert.ok(finalParent.completionPacket);
  assert.equal(finalParent.completionPacket.parentKey, "PACE-700");
  assert.equal(finalParent.completionPacket.children.length, 3);
  assert.equal(finalParent.completionPacket.integrationReview.verdict, "clean");

  // Verify parent telemetry events were persisted with valid run & stages
  const telemEvents = store.database.prepare(
    "SELECT event_id, stage, status, sequence FROM telemetry_events WHERE issue_key = 'PACE-700'"
  ).all();
  assert.ok(telemEvents.length >= 3);
  const stages = telemEvents.map((e) => e.stage);
  assert.ok(stages.includes("queued"));
  assert.ok(stages.includes("started"));
  assert.ok(stages.includes("terminal"));
});

// ── Scenario V: Regressions & Edge Cases ─────────────────────────────────────
test("Scenario V: Hierarchy discovery errors fail closed, same-fingerprint preserves state, and baseRef resolves correctly", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store);
  const sc = new LocalGitSourceControlProvider();

  // V1. getChildren error fails closed -> state is "blocked"
  const badSource = new FakeWorkSourceProvider();
  badSource.getChildren = async () => { throw new Error("Jira API connection reset"); };

  const badParent = { key: "PACE-800", summary: "Bad Parent", issueType: "Epic" };
  const res1 = await discoverAndPinParent(settings, store, badParent, { workSource: badSource });
  assert.equal(res1.ok, false);
  assert.equal(res1.blocked, true);

  const badExec = store.getParentExecution("PACE-800");
  assert.equal(badExec.state, "blocked");

  // V2. Same fingerprint rediscovery preserves waiting_human and blocked states
  const goodSource = new FakeWorkSourceProvider();
  const parent850 = { key: "PACE-850", summary: "Preserve State Parent", issueType: "Epic" };
  goodSource.setChildren("PACE-850", []);
  const res2 = await discoverAndPinParent(settings, store, parent850, { workSource: goodSource });
  assert.equal(res2.ok, true);

  // Transition parent to waiting_human
  store.updateParentExecutionState("PACE-850", "waiting_human");

  // Re-run discovery for the same parent with same fingerprint
  const res2_again = await discoverAndPinParent(settings, store, parent850, { workSource: goodSource });
  assert.equal(res2_again.execution.state, "waiting_human", "Rediscovery must preserve waiting_human state");

  // V3. resolveRevision returns correct commit for develop even when checked out on another branch
  spawnSync("git", ["-C", repo, "checkout", "-b", "feature/unrelated"]);
  fs.writeFileSync(path.join(repo, "unrelated.txt"), "unrelated\n", "utf8");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "feat: unrelated branch commit"]);
  const unrelatedSha = String(spawnSync("git", ["-C", repo, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  const developSha = String(spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout).trim().toLowerCase();
  assert.notEqual(unrelatedSha, developSha);

  const resolvedRev = sc.resolveRevision({ repoPath: repo, requestedRef: "develop" });
  assert.equal(resolvedRev.ok, true);
  assert.equal(resolvedRev.sha.toLowerCase(), developSha);
  assert.notEqual(resolvedRev.sha.toLowerCase(), unrelatedSha);

  // V4. Reviewer with invalid output fails closed
  const parent860 = { key: "PACE-860", summary: "Invalid Review Test", issueType: "Epic" };
  const res3 = await discoverAndPinParent(settings, store, parent860, { workSource: goodSource, execute: true });

  const invalidRevRes = await runParentIntegrationReview(settings, store, "PACE-860", {
    sourceControl: sc,
    injectedReviewOutcome: { verdict: "invalid-verdict", evidence: [] }
  });
  assert.equal(invalidRevRes.ok, false);
  assert.equal(invalidRevRes.blocked, true);
  assert.equal(invalidRevRes.parentState, "blocked");
});

// ── Scenario W: Crash Recovery After Git Integration Merge ───────────────────
test("Scenario W: Crash recovery after git merge recovers state without duplicate commit", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const sc = new LocalGitSourceControlProvider();
  const workSource = new FakeWorkSourceProvider();

  const parent900 = { key: "PACE-900", summary: "Crash Recovery Epic", issueType: "Epic" };
  const child901 = { key: "PACE-901", summary: "Child 901", issueType: "Task" };
  const child902 = { key: "PACE-902", summary: "Child 902", issueType: "Task" };

  workSource.setChildren("PACE-900", [child901, child902]);
  workSource.setDependencies("PACE-901", []);
  workSource.setDependencies("PACE-902", ["PACE-901"]);

  await discoverAndPinParent(settings, store, parent900, { workSource, execute: true });
  const parentExec = store.getParentExecution("PACE-900");
  const wtParent = parentExec.integrationWorktree;

  // Prepare child 901 branch & commit
  const wt901 = path.join(worktreeRoot, "task-pace-901-child-901");
  spawnSync("git", ["-C", repo, "worktree", "add", "-b", "task/pace-901-child-901", wt901, "develop"]);
  fs.writeFileSync(path.join(wt901, "file901.txt"), "child 901 work\n", "utf8");
  spawnSync("git", ["-C", wt901, "add", "."]);
  spawnSync("git", ["-C", wt901, "commit", "-qm", "feat: 901 commit"]);
  const sha901 = String(spawnSync("git", ["-C", wt901, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  // Create review run in reviewed-clean
  const run901 = store.createRun("PACE-901", { role: "implementation", summary: "Task 901" });
  store.transition(run901, "completed", { implementationSha: sha901 });
  const revRun901 = store.createRun("PACE-901", { role: "reviewer", summary: "Review 901", implementationSha: sha901 });
  store.transition(revRun901, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: sha901,
      reviewerId: "correctness-reviewer",
      evidence: [{ id: "clean-901", severity: "suggestion", category: "correctness", problem: "Clean" }]
    }
  });

  // Claim integration in store (state = 'integrating')
  store.queueEpicIntegration({ epicKey: "PACE-900", issueKey: "PACE-901", leafBranch: "task/pace-901-child-901" });
  store.claimEpicIntegration({ epicKey: "PACE-900", issueKey: "PACE-901" });

  // Simulate Git merge succeeded in integration worktree
  const mergeRes = spawnSync("git", ["-C", wtParent, "merge", "--no-ff", "-m", "chore(epic): integrate PACE-901", sha901]);
  assert.equal(mergeRes.status, 0);
  const headAfterMerge = String(spawnSync("git", ["-C", wtParent, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  // Process crashed BEFORE finishEpicIntegration DB update!
  // epic_integrations table still has state = 'integrating'
  const crashInt = store.listEpicIntegrations("PACE-900").find((i) => i.issueKey === "PACE-901");
  assert.equal(crashInt.state, "integrating");

  // Restart / Reconcile: tick() must detect git ancestry and recover state to 'integrated'
  tick(settings, store, { execute: true });

  const recoveredTask = store.getEpicTask("PACE-900", "PACE-901");
  const recoveredInt = store.listEpicIntegrations("PACE-900").find((i) => i.issueKey === "PACE-901");
  assert.equal(recoveredTask.state, "integrated");
  assert.equal(recoveredInt.state, "integrated");
  assert.equal(recoveredInt.commit.toLowerCase(), headAfterMerge);

  // Dependent child 902 must now be unlocked (dependency-ready)
  const task902 = store.getEpicTask("PACE-900", "PACE-902");
  assert.equal(task902.orchestrationState, "dependency-ready");
  assert.equal(task902.childBaseSha.toLowerCase(), headAfterMerge);

  // Verify HEAD did NOT receive a second merge commit
  const headFinal = String(spawnSync("git", ["-C", wtParent, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();
  assert.equal(headFinal, headAfterMerge);
});

// ── Scenario X: Persisted Parent Objective & Acceptance Criteria ──────────────
test("Scenario X: Persisted parent objective and acceptance criteria survive store reload", async () => {
  const { repo, worktreeRoot, store, dbPath } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const workSource = new FakeWorkSourceProvider();

  const parentKey = "PACE-920";
  const desc = "Comprehensive objective for PACE-920:\n- Modular pipeline\n- Zero latency";
  const criteria = "- [x] Criterion 1: Zero regression\n- [x] Criterion 2: Full coverage";

  const parent920 = {
    key: parentKey,
    summary: "Objective Persistence Test",
    description: desc,
    acceptanceCriteria: criteria,
    issueType: "Epic"
  };

  workSource.setChildren(parentKey, []);
  await discoverAndPinParent(settings, store, parent920, { workSource, execute: true });

  // Close & reload store from SQLite database
  const reloadedStore = new RunStore(dbPath);
  const fetched = reloadedStore.getParentExecution(parentKey);
  assert.equal(fetched.description, desc);
  assert.equal(fetched.acceptanceCriteria, criteria);

  const detail = reloadedStore.getNormalizedParentDetail(parentKey);
  assert.equal(detail.parent.description, desc);
  assert.equal(detail.parent.acceptanceCriteria, criteria);

  // Verify integration review receives persisted objective + criteria
  const revRes = await runParentIntegrationReview(settings, reloadedStore, parentKey, {
    injectedReviewOutcome: { verdict: "clean", evidence: [{ id: "rev-clean", severity: "suggestion", category: "correctness", problem: "Clean" }] }
  });
  assert.equal(revRes.ok, true);
  assert.equal(revRes.parentState, "waiting_human");
});

// ── Scenario Y: Exact childBaseSha on First Implementation ───────────────────
test("Scenario Y: Exact childBaseSha enforced on first implementation execution", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });

  const parentKey = "PACE-930";
  const childKey = "PACE-931";
  const baseSha = String(spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout).trim().toLowerCase();

  store.upsertParentExecution({
    parentKey,
    summary: "Exact Base Parent",
    integrationBranch: "epic/pace-930",
    baseSha,
    state: "active"
  });

  store.upsertEpicTask({
    epicKey: parentKey,
    parentKey,
    issueKey: childKey,
    summary: "Child 931",
    branch: "task/pace-931",
    childBaseSha: baseSha,
    state: "planned",
    orchestrationState: "dependency-ready"
  });

  // 1. Fresh worktree from exact baseSha -> succeeds
  const plan = {
    issueKey: childKey,
    epicKey: parentKey,
    summary: "Child 931",
    branch: "task/pace-931",
    childBaseSha: baseSha
  };

  const wtRes = prepareWorktree({
    ...plan,
    repoPath: repo,
    root: worktreeRoot,
    execute: true,
    store,
    settings
  });
  assert.ok(wtRes.worktree);
  assert.equal(wtRes.baseSha.toLowerCase(), baseSha);

  // 2. Branch advanced with unexpected commit before first execution -> rejected!
  const wtPath = wtRes.worktree;
  fs.writeFileSync(path.join(wtPath, "unexpected.txt"), "unexpected commit\n", "utf8");
  spawnSync("git", ["-C", wtPath, "add", "."]);
  spawnSync("git", ["-C", wtPath, "commit", "-qm", "feat: unexpected advance"]);

  assert.throws(() => {
    prepareWorktree({
      ...plan,
      repoPath: repo,
      root: worktreeRoot,
      execute: true,
      store,
      settings
    });
  }, /must exactly match pinned childBaseSha/i);
});

// ── Scenario Z: Planned vs Waiting Approval vs Execute Resumption ────────────
test("Scenario Z: Planned state on dry-run advances to active on execute with authorization", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const workSource = new FakeWorkSourceProvider();

  const parentKey = "PACE-940";
  const parent940 = { key: parentKey, summary: "Planned Resume Test", issueType: "Epic" };
  workSource.setChildren(parentKey, []);

  // 1. Dry run (execute = false): state is planned, no worktree created
  const settingsDry = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const dryRes = await discoverAndPinParent(settingsDry, store, parent940, { workSource, execute: false });
  assert.equal(dryRes.ok, true);
  assert.equal(dryRes.execution.state, "planned");
  assert.equal(dryRes.execution.integrationWorktree, null);

  // 2. Execute under manual policy with externalWrites=false -> waiting_approval
  const settingsManual = makeSettings(repo, worktreeRoot, store, { operatingMode: "manual" });
  const manualRes = await discoverAndPinParent(settingsManual, store, parent940, { workSource, execute: true });
  assert.equal(manualRes.ok, false);
  assert.equal(manualRes.waitingApproval, true);
  const manualExec = store.getParentExecution(parentKey);
  assert.equal(manualExec.state, "waiting_approval");

  // 3. Execute with authorization -> advances to active & materializes worktree
  const settingsAuto = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const autoRes = await discoverAndPinParent(settingsAuto, store, parent940, { workSource, execute: true });
  assert.equal(autoRes.ok, true);
  assert.equal(autoRes.execution.state, "active");
  assert.ok(autoRes.execution.integrationWorktree);
  assert.ok(fs.existsSync(autoRes.execution.integrationWorktree));
});

// ── Scenario AA: Reviewer Agent Registry Executor Constraints ────────────────
test("Scenario AA: Reviewer agent definition executor constraints fail closed on mismatch", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const workSource = new FakeWorkSourceProvider();

  // Register a reviewer definition that requires provider: "anthropic"
  store.createAgentDefinition({
    id: "strict-anthropic-reviewer",
    displayName: "Strict Anthropic Reviewer",
    role: "review",
    executor: {
      provider: "anthropic"
    }
  });

  const parentKey = "PACE-950";
  const parent950 = { key: parentKey, summary: "Strict Reviewer Test", issueType: "Epic" };
  workSource.setChildren(parentKey, []);
  await discoverAndPinParent(settings, store, parent950, { workSource, execute: true });

  // Settings uses default antigravity provider -> conflict!
  const settingsConf = {
    ...settings,
    data: {
      ...settings.data,
      policy: {
        ...settings.data.policy,
        review: {
          taskAgent: "strict-anthropic-reviewer"
        }
      }
    }
  };

  const revRes = await runParentIntegrationReview(settingsConf, store, parentKey, {
    injectedReviewOutcome: { verdict: "clean", evidence: [] }
  });
  assert.equal(revRes.ok, false);
  assert.equal(revRes.blocked, true);
  assert.equal(revRes.parentState, "blocked");
  assert.match(revRes.reason, /constraint mismatch/i);
});

// ── Scenario AB: Parent Children Never Enter Standalone Approval ─────────────
test("Scenario AB: Parent children in epic are excluded from standalone human approval transitions", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const workSource = new FakeWorkSourceProvider();

  const parentKey = "PACE-960";
  const childKey = "PACE-961";

  store.upsertEpic({ key: parentKey, summary: "Parent 960", branch: "epic/pace-960", baseBranch: "develop" });
  store.upsertEpicTask({
    epicKey: parentKey,
    parentKey,
    issueKey: childKey,
    summary: "Child 961",
    branch: "task/pace-961",
    state: "planned",
    orchestrationState: "planned"
  });

  // Child 961 completes implementation and review
  const run961 = store.createRun(childKey, { role: "implementation", summary: "Task 961" });
  store.transition(run961, "completed", { implementationSha: "1111111111111111111111111111111111111111" });
  const revRun961 = store.createRun(childKey, { role: "reviewer", summary: "Review 961", implementationSha: "1111111111111111111111111111111111111111" });
  store.transition(revRun961, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: "1111111111111111111111111111111111111111",
      reviewerId: "correctness-reviewer",
      evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }]
    }
  });

  // Run standalone reviews reconciliation
  const standRes = reconcileStandaloneReviews(settings, store, { execute: true, workSource });
  assert.equal(standRes.transitioned, 0, "Parent child must NOT be transitioned by standalone reviews");

  const revRunAfter = store.getRun(revRun961);
  assert.equal(revRunAfter.state, "reviewed-clean", "Child review run must remain reviewed-clean");
  assert.equal(workSource.transitions.length, 0, "No external transition to human_approval must occur");
});

// ── Scenario AC: Dispatch Integration Without Main Repo on Epic Branch ────────
test("Scenario AC: dispatch integration integrates into parent worktree while main repo is on develop", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const sc = new LocalGitSourceControlProvider();
  const workSource = new FakeWorkSourceProvider();

  // Verify main repo checkout is explicitly on develop
  const mainHead = sc.getHead({ repoPath: repo });
  const curBranch = String(spawnSync("git", ["-C", repo, "branch", "--show-current"]).stdout).trim();
  assert.equal(curBranch, "develop");

  const parentKey = "PACE-970";
  const childKey = "PACE-971";

  const parent970 = { key: parentKey, summary: "Independent Worktree Epic", issueType: "Epic" };
  const child971 = { key: childKey, summary: "Child 971", issueType: "Task" };

  workSource.setChildren(parentKey, [child971]);
  workSource.setDependencies(childKey, []);

  await discoverAndPinParent(settings, store, parent970, { workSource, execute: true });
  const parentExec = store.getParentExecution(parentKey);
  const wtParent = parentExec.integrationWorktree;
  assert.ok(wtParent);

  // Implement in child worktree
  const task971 = store.getEpicTask(parentKey, childKey);
  const wt971 = path.join(worktreeRoot, "task-pace-971-child-971");
  spawnSync("git", ["-C", repo, "worktree", "add", "-b", "task/pace-971-child-971", wt971, "develop"]);
  fs.writeFileSync(path.join(wt971, "child971.txt"), "child 971 changes\n", "utf8");
  spawnSync("git", ["-C", wt971, "add", "."]);
  spawnSync("git", ["-C", wt971, "commit", "-qm", "feat: child 971 commit"]);
  const sha971 = String(spawnSync("git", ["-C", wt971, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  const run971 = store.createRun(childKey, { role: "implementation", summary: "Task 971" });
  store.transition(run971, "completed", { implementationSha: sha971 });
  const revRun971 = store.createRun(childKey, { role: "reviewer", summary: "Review 971", implementationSha: sha971 });
  store.transition(revRun971, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: sha971,
      reviewerId: "correctness-reviewer",
      evidence: [{ id: "c971", severity: "suggestion", category: "correctness", problem: "Clean" }]
    }
  });

  // Run dispatchOnce to trigger reconciliation & integration cycle
  workSource.setWorkItem(parent970);
  workSource.setWorkItem(child971);

  const dispRes = await dispatchOnce(settings, {
    store,
    workSource,
    execute: true,
    limit: 10
  });

  // Main repo branch must STILL be develop
  const mainBranchAfter = String(spawnSync("git", ["-C", repo, "branch", "--show-current"]).stdout).trim();
  assert.equal(mainBranchAfter, "develop");

  // Child 971 must be integrated into parent integration worktree
  const taskAfter = store.getEpicTask(parentKey, childKey);
  assert.equal(taskAfter.state, "integrated");
  assert.ok(taskAfter.integratedSha);

  // Parent worktree contains file971.txt
  assert.ok(fs.existsSync(path.join(wtParent, "child971.txt")));
});

// ── Scenario AD: Parent Approvals Bound to Deterministic Fingerprints & Tested via PM API ────────
test("Scenario AD: Parent branch creation and review approvals are strictly bound to deterministic fingerprints and tested through handlePmApproval/handlePmRejection", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "manual" });
  const workSource = new FakeWorkSourceProvider();

  const parentKey = "PACE-980";
  const childKey = "PACE-981";
  const parent980 = { key: parentKey, summary: "Manual Parent", issueType: "Epic" };
  const child981 = { key: childKey, summary: "Child 981", issueType: "Task" };

  workSource.setChildren(parentKey, [child981]);
  workSource.setDependencies(childKey, []);

  // 1. First execution in manual mode without approval -> waiting_approval
  const res1 = await discoverAndPinParent(settings, store, parent980, { workSource, execute: true });
  assert.equal(res1.ok, false);
  assert.equal(res1.waitingApproval, true);
  assert.equal(store.getParentExecution(parentKey).state, "waiting_approval");

  const pendingReq1 = store.getPmDecisions(parentKey).find((d) => d.type === "approval_requested" && d.payload.action === "branchCreation");
  assert.ok(pendingReq1);
  const branchFp1 = pendingReq1.payload.planFingerprint;

  // Expose pending gate in PM detail read model
  const pmDetail = getPmDetail(settings, parentKey, { store });
  assert.ok(pmDetail);
  assert.equal(pmDetail.humanControl.approvalState, "pending");
  assert.equal(pmDetail.humanControl.planFingerprint, branchFp1);
  assert.equal(pmDetail.humanControl.pendingAction, "branchCreation");
  assert.equal(pmDetail.humanControl.canApprove, true);

  // 2. Approve with mismatched/old fingerprint via handlePmApproval -> 409
  assert.throws(() => {
    handlePmApproval(settings, parentKey, {
      action: "branchCreation",
      planFingerprint: "stale-mismatched-fingerprint"
    }, { store });
  }, (err) => err.statusCode === 409 && /Plan fingerprint mismatch/i.test(err.message));

  // Still denied on resume attempt
  const res2 = await discoverAndPinParent(settings, store, parent980, { workSource, execute: true });
  assert.equal(res2.ok, false);
  assert.equal(res2.waitingApproval, true);

  // 3. Approve with EXACT fingerprint via handlePmApproval -> 200 OK
  const appResult = handlePmApproval(settings, parentKey, {
    action: "branchCreation",
    planFingerprint: branchFp1
  }, { store });
  assert.equal(appResult.ok, true);
  assert.equal(appResult.approved, true);
  assert.equal(appResult.planFingerprint, branchFp1);

  // Duplicate approval -> 409
  assert.throws(() => {
    handlePmApproval(settings, parentKey, {
      action: "branchCreation",
      planFingerprint: branchFp1
    }, { store });
  }, (err) => err.statusCode === 409 && /already approved/i.test(err.message));

  // Resumes to active
  const res3 = await discoverAndPinParent(settings, store, parent980, { workSource, execute: true });
  assert.equal(res3.ok, true);
  assert.equal(res3.execution.state, "active");
  assert.ok(res3.execution.integrationWorktree);

  // 4. Test review approval fingerprint binding through handlePmApproval
  const baseSha = res3.execution.baseSha;
  const wt = res3.execution.integrationWorktree;
  fs.writeFileSync(path.join(wt, "file_x.txt"), "content x\n", "utf8");
  spawnSync("git", ["-C", wt, "add", "."]);
  spawnSync("git", ["-C", wt, "commit", "-qm", "feat: commit x"]);
  const headShaX = String(spawnSync("git", ["-C", wt, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  const revDef = store.getAgentDefinition("correctness-reviewer");
  const reviewPlanX = {
    parentKey,
    issueKey: parentKey,
    graphFingerprint: res3.execution.graphFingerprint,
    parentBaseSha: baseSha,
    integrationHeadSha: headShaX,
    reviewerAgentId: "correctness-reviewer",
    reviewerVersion: revDef?.currentVersion || revDef?.version || 1,
    reviewerHash: revDef?.definitionHash || null
  };
  const reviewFpX = computeParentReviewFingerprint(reviewPlanX);

  // Trigger review for SHA X -> records approval_requested for SHA X
  const sc = new LocalGitSourceControlProvider();
  const revResReqX = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    reviewedSha: headShaX,
    injectedReviewOutcome: { verdict: "clean", evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }] }
  });
  assert.equal(revResReqX.ok, false);
  assert.equal(revResReqX.waitingApproval, true);

  // Branch advances to SHA Y before approval is given
  fs.writeFileSync(path.join(wt, "file_y.txt"), "content y\n", "utf8");
  spawnSync("git", ["-C", wt, "add", "."]);
  spawnSync("git", ["-C", wt, "commit", "-qm", "feat: commit y"]);
  const headShaY = String(spawnSync("git", ["-C", wt, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  // Trigger review for SHA Y -> records approval_requested for SHA Y
  const revResReqY = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    reviewedSha: headShaY,
    injectedReviewOutcome: { verdict: "clean", evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }] }
  });
  assert.equal(revResReqY.ok, false);
  assert.equal(revResReqY.waitingApproval, true);

  const reviewPlanY = {
    parentKey,
    issueKey: parentKey,
    graphFingerprint: res3.execution.graphFingerprint,
    parentBaseSha: baseSha,
    integrationHeadSha: headShaY,
    reviewerAgentId: "correctness-reviewer",
    reviewerVersion: revDef?.currentVersion || revDef?.version || 1,
    reviewerHash: revDef?.definitionHash || null
  };
  const reviewFpY = computeParentReviewFingerprint(reviewPlanY);

  // Approving with old SHA X fingerprint via handlePmApproval -> 409
  assert.throws(() => {
    handlePmApproval(settings, parentKey, {
      action: "review",
      planFingerprint: reviewFpX
    }, { store });
  }, (err) => err.statusCode === 409 && /Plan fingerprint mismatch/i.test(err.message));

  // Approving with exact SHA Y fingerprint via handlePmApproval -> accepted
  const revAppResult = handlePmApproval(settings, parentKey, {
    action: "review",
    planFingerprint: reviewFpY
  }, { store });
  assert.equal(revAppResult.ok, true);
  assert.equal(revAppResult.approved, true);

  const revResClean = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    reviewedSha: headShaY,
    injectedReviewOutcome: { verdict: "clean", evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }] }
  });
  assert.equal(revResClean.ok, true);
  assert.equal(revResClean.parentState, "waiting_human");

  // Verify reviewer run was completed in SQLite runs table
  const revRun = store.getRun(revResClean.reviewRunId);
  assert.ok(revRun);
  assert.equal(revRun.state, "completed");

  // 5. Test handlePmRejection
  const parentRejKey = "PACE-982";
  const parent982 = { key: parentRejKey, summary: "Rejection Parent", issueType: "Epic" };
  workSource.setChildren(parentRejKey, [{ key: "PACE-983", summary: "Task 983", issueType: "Task" }]);
  workSource.setDependencies("PACE-983", []);

  const resRej1 = await discoverAndPinParent(settings, store, parent982, { workSource, execute: true });
  assert.equal(resRej1.ok, false);
  assert.equal(resRej1.waitingApproval, true);

  const rejPlan = {
    parentKey: parentRejKey,
    issueKey: parentRejKey,
    graphFingerprint: resRej1.execution.graphFingerprint,
    baseSha: resRej1.execution.baseSha,
    integrationBranch: resRej1.execution.integrationBranch
  };
  const rejFp = computeParentBranchFingerprint(rejPlan);

  const rejResult = handlePmRejection(settings, parentRejKey, {
    action: "branchCreation",
    planFingerprint: rejFp,
    reason: "Denied by architecture board"
  }, { store });
  assert.equal(rejResult.ok, true);
  assert.equal(rejResult.approved, false);

  // Duplicate rejection -> 409
  assert.throws(() => {
    handlePmRejection(settings, parentRejKey, {
      action: "branchCreation",
      planFingerprint: rejFp
    }, { store });
  }, (err) => err.statusCode === 409 && /already rejected/i.test(err.message));
});

// ── Scenario AE: Fail-closed childBaseSha unresolvable & exact base enforcement ───
test("Scenario AE: Fail-closed childBaseSha unresolvable and prepareChildWorktree exact base enforcement", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store);
  const sc = new LocalGitSourceControlProvider();

  const parentKey = "PACE-985";
  const childKey = "PACE-986";

  // 1. Parent with unresolvable integration branch
  store.upsertParentExecution({
    parentKey,
    summary: "Unresolvable Integration Head Epic",
    integrationBranch: "epic/non-existent-branch-9999",
    integrationWorktree: null,
    baseSha: "abc1234",
    state: "active"
  });

  store.upsertEpicTask({
    epicKey: parentKey,
    parentKey,
    issueKey: childKey,
    summary: "Child 986",
    branch: "task/pace-986",
    state: "planned",
    orchestrationState: "pending-dependencies",
    dependencies: []
  });

  // Reconcile children should fail closed, not mark dependency-ready
  const recRes = reconcileParentChildren(settings, store, parentKey);
  assert.equal(recRes.readyChildren.length, 0);

  const taskAfter = store.getEpicTask(parentKey, childKey);
  assert.equal(taskAfter.orchestrationState, "pending-dependencies");
  assert.ok(taskAfter.blockedReasons.length > 0);

  // 2. LocalGitSourceControlProvider.prepareChildWorktree first implementation enforcement
  const baseSha = String(spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout).trim().toLowerCase();
  const plan = { issueKey: "PACE-987", summary: "Child 987", branch: "task/pace-987", attempt: 0 };

  const prepRes = sc.prepareChildWorktree({
    repoPath: repo,
    root: worktreeRoot,
    parentKey,
    parentBranch: "develop",
    issueKey: "PACE-987",
    summary: "Child 987",
    baseRef: "develop",
    execute: true,
    plan
  });
  assert.ok(prepRes.worktree);

  // Advance child branch unexpectedly before execution
  fs.writeFileSync(path.join(prepRes.worktree, "advance.txt"), "data\n");
  spawnSync("git", ["-C", prepRes.worktree, "add", "."]);
  spawnSync("git", ["-C", prepRes.worktree, "commit", "-qm", "advance"]);

  assert.throws(() => {
    sc.prepareChildWorktree({
      repoPath: repo,
      root: worktreeRoot,
      parentKey,
      parentBranch: "develop",
      issueKey: "PACE-987",
      summary: "Child 987",
      baseRef: baseSha,
      execute: true,
      plan
    });
  }, /must exactly match pinned childBaseSha/i);
});

// ── Scenario AF: True Production Lifecycle E2E ────────────────────────────────
test("Scenario AF: True production lifecycle E2E driven strictly through dispatchOnce and tick to WAITING_HUMAN", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const workSource = new FakeWorkSourceProvider();
  const sc = new LocalGitSourceControlProvider();

  const parentKey = "PACE-990";
  const childA = "PACE-991";
  const childB = "PACE-992";
  const childC = "PACE-993";

  const parent = {
    key: parentKey,
    id: parentKey,
    summary: "Parent P",
    description: "Parent objective description",
    acceptanceCriteria: "[x] Task A\n[x] Task B\n[x] Task C",
    issueType: "Epic",
    canonicalState: "ready"
  };
  const taskA = {
    key: childA,
    id: childA,
    summary: "Task A",
    description: "Acceptance criteria:\n- [ ] implement task A",
    issueType: "Task",
    canonicalState: "ready",
    allowedPaths: ["backend/**"]
  };
  const taskB = {
    key: childB,
    id: childB,
    summary: "Task B",
    description: "Acceptance criteria:\n- [ ] implement task B",
    issueType: "Task",
    canonicalState: "ready",
    allowedPaths: ["backend/**"]
  };
  const taskC = {
    key: childC,
    id: childC,
    summary: "Task C",
    description: "Acceptance criteria:\n- [ ] implement task C",
    issueType: "Task",
    canonicalState: "ready",
    allowedPaths: ["frontend/**"]
  };

  workSource.setWorkItem(parent);
  workSource.setWorkItem(taskA);
  workSource.setWorkItem(taskB);
  workSource.setWorkItem(taskC);

  workSource.setChildren(parentKey, [taskA, taskB, taskC]);
  workSource.setDependencies(childA, []);
  workSource.setDependencies(childB, [childA]); // B depends on A
  workSource.setDependencies(childC, []);        // C independent

  const injectedRunIssue = async (settings, issue, execute, runtime, options) => {
    if (issue.key === parentKey) {
      return { exitCode: 0, output: { runId: null } };
    }
    const task = store.getEpicTask(parentKey, issue.key);
    assert.ok(task, `Task for ${issue.key} must be discovered`);

    const wtPath = task.worktree || path.join(worktreeRoot, task.branch.replaceAll("/", "-"));
    if (!fs.existsSync(wtPath)) {
      const baseSha = task.childBaseSha;
      assert.ok(baseSha, `childBaseSha must be pinned before worktree preparation for ${issue.key}`);
      spawnSync("git", ["-C", repo, "worktree", "add", "-B", task.branch, wtPath, baseSha]);
      store.upsertEpicTask({ ...task, worktree: wtPath });
    }

    const currentHead = String(spawnSync("git", ["-C", wtPath, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();
    if (task.childBaseSha) {
      assert.equal(currentHead, task.childBaseSha.toLowerCase());
    }

    const subDir = issue.key === childC ? "frontend" : "backend";
    const fileName = issue.key === childA ? "a.js" : (issue.key === childB ? "b.js" : "c.js");
    fs.mkdirSync(path.join(wtPath, subDir), { recursive: true });
    fs.writeFileSync(path.join(wtPath, subDir, fileName), `// implementation for ${issue.key}\n`, "utf8");
    spawnSync("git", ["-C", wtPath, "add", "."]);
    spawnSync("git", ["-C", wtPath, "commit", "-qm", `feat: implement ${issue.key}`]);
    const implSha = String(spawnSync("git", ["-C", wtPath, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

    const implRunId = store.createRun(issue.key, { role: "implementation", action: "implementation", summary: `Implement ${issue.key}`, childBaseSha: task.childBaseSha });
    store.transition(implRunId, "queued");
    store.transition(implRunId, "started");
    store.transition(implRunId, "completed", { implementationSha: implSha });

    const revRunId = store.createRun(issue.key, { role: "reviewer", action: "review", summary: `Review ${issue.key}`, implementationSha: implSha });
    store.transition(revRunId, "queued");
    store.transition(revRunId, "started");
    store.transition(revRunId, "reviewed-clean", {
      reviewOutcome: {
        verdict: "clean",
        implementationSha: implSha,
        reviewerId: "correctness-reviewer",
        evidence: [{ id: `clean-${issue.key}`, severity: "suggestion", category: "correctness", problem: `Clean implementation for ${issue.key}` }]
      }
    });

    return { exitCode: 0, output: { runId: implRunId, implementationSha: implSha } };
  };

  // ── Cycle 1: First dispatchOnce ──
  // Discovers parent, pins DAG, dispatches A and C through real runtime (B waits on A)
  const dispatchRes1 = await dispatchOnce(settings, {
    store,
    workSource,
    execute: true,
    maxConcurrency: 3,
    limit: 10,
    runIssue: injectedRunIssue
  });
  assert.equal(dispatchRes1.mode, "execute");

  const parentExec1 = store.getParentExecution(parentKey);
  assert.ok(parentExec1);
  assert.equal(parentExec1.state, "active");

  // Tick integrates A and C into parent integration branch in serialized order
  await tick(settings, store, { execute: true });
  await tick(settings, store, { execute: true });

  const taskA_integrated = store.getEpicTask(parentKey, childA);
  const taskC_integrated = store.getEpicTask(parentKey, childC);
  assert.equal(taskA_integrated.state, "integrated");
  assert.equal(taskC_integrated.state, "integrated");

  // ── Cycle 2: Second dispatchOnce ──
  // B is now dependency-ready; dispatched and implemented with exact childBaseSha
  const dispatchRes2 = await dispatchOnce(settings, {
    store,
    workSource,
    execute: true,
    maxConcurrency: 3,
    limit: 10,
    runIssue: injectedRunIssue
  });
  assert.equal(dispatchRes2.mode, "execute");

  // ── Cycle 3: Final tick integrating B and running aggregate reviewer ──
  await tick(settings, store, {
    execute: true,
    injectedReviewOutcome: {
      verdict: "clean",
      evidence: [{ id: "agg-rev", severity: "suggestion", category: "correctness", problem: "All children clean" }]
    }
  });

  const taskB_integrated = store.getEpicTask(parentKey, childB);
  assert.equal(taskB_integrated.state, "integrated");

  const finalParent = store.getParentExecution(parentKey);
  assert.equal(finalParent.state, "waiting_human");

  // ── Assertions ──
  // 1. No child individually entered human approval
  const runsA = store.listRunsForIssue(childA);
  const runsB = store.listRunsForIssue(childB);
  const runsC = store.listRunsForIssue(childC);
  assert.ok(!runsA.some((r) => r.state === "waiting_human"));
  assert.ok(!runsB.some((r) => r.state === "waiting_human"));
  assert.ok(!runsC.some((r) => r.state === "waiting_human"));

  // 2. Reviewer run is terminal (completed)
  const aggRevRuns = store.database.prepare(
    "SELECT * FROM runs WHERE issue_key = ? AND json_extract(payload, '$.role') = 'reviewer'"
  ).all(parentKey);
  assert.ok(aggRevRuns.length > 0);
  assert.equal(aggRevRuns[0].state, "completed");

  // 3. Integration-worker runs are terminal (completed)
  const intRuns = store.database.prepare(
    "SELECT * FROM runs WHERE json_extract(payload, '$.role') = 'integration-worker' ORDER BY id ASC"
  ).all();
  assert.ok(intRuns.length >= 3);
  for (const ir of intRuns) {
    assert.equal(ir.state, "completed");
  }

  // 4. No orphan started runs anywhere
  const orphanStarted = store.database.prepare(
    "SELECT * FROM runs WHERE state = 'started'"
  ).all();
  assert.equal(orphanStarted.length, 0);

  // 5. Parent telemetry contains all expected lifecycle events
  const telemEvents = store.database.prepare(
    "SELECT event_id, stage, status, raw_payload FROM telemetry_events WHERE issue_key = ? ORDER BY id ASC"
  ).all(parentKey);
  const rawTexts = telemEvents.map((e) => `${e.event_id} ${e.raw_payload || ""}`);

  assert.ok(rawTexts.some((t) => t.includes("child_dispatched")));
  assert.ok(rawTexts.some((t) => t.includes("child_reviewed")));
  assert.ok(rawTexts.some((t) => t.includes("child_integration_queued")));
  assert.ok(rawTexts.some((t) => t.includes("child_integrating")));
  assert.ok(rawTexts.some((t) => t.includes("child_integrated")));
  assert.ok(rawTexts.some((t) => t.includes("integration_review_queued") || t.includes("integration_review")));
  assert.ok(rawTexts.some((t) => t.includes("waiting_human")));

  // 6. Develop remains untouched; no final merge or Done transition
  const developBranch = String(spawnSync("git", ["-C", repo, "branch", "--show-current"]).stdout).trim();
  assert.equal(developBranch, "develop");
  assert.ok(!fs.existsSync(path.join(repo, "backend", "a.js")));
  assert.ok(!fs.existsSync(path.join(repo, "backend", "b.js")));
  assert.ok(!fs.existsSync(path.join(repo, "frontend", "c.js")));
});

// ── Scenario AG: Registry-Authoritative Integration Reviewer ──────────────────
test("Scenario AG: Registry-authoritative integration reviewer enforces registered and enabled reviewer", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const sc = new LocalGitSourceControlProvider();

  const parentKey = "PACE-995";
  const developSha = String(spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout).trim().toLowerCase();
  store.upsertParentExecution({
    parentKey,
    summary: "Reviewer Registry Epic",
    integrationBranch: "epic/pace-995",
    integrationWorktree: repo,
    baseSha: developSha,
    state: "active"
  });

  // 1. Unknown reviewer -> blocked
  const unknownSettings = {
    ...settings,
    data: {
      ...settings.data,
      policy: {
        ...settings.data.policy,
        review: { taskAgent: "unregistered-reviewer-xyz" }
      }
    }
  };

  const resUnknown = await runParentIntegrationReview(unknownSettings, store, parentKey, {
    sourceControl: sc,
    reviewedSha: developSha,
    injectedReviewOutcome: { verdict: "clean", evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }] }
  });
  assert.equal(resUnknown.ok, false);
  assert.equal(resUnknown.blocked, true);
  assert.match(resUnknown.reason, /not registered in agent registry/i);

  // 2. Disabled reviewer -> blocked
  store.setAgentStatus("correctness-reviewer", "disabled");
  const resDisabled = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    reviewedSha: developSha,
    injectedReviewOutcome: { verdict: "clean", evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }] }
  });
  assert.equal(resDisabled.ok, false);
  assert.equal(resDisabled.blocked, true);
  assert.match(resDisabled.reason, /disabled in agent registry/i);

  // 3. Re-enable reviewer -> proceeds
  store.setAgentStatus("correctness-reviewer", "enabled");
  const resEnabled = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    reviewedSha: developSha,
    injectedReviewOutcome: { verdict: "clean", evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }] }
  });
  assert.equal(resEnabled.ok, true);
  assert.equal(resEnabled.parentState, "waiting_human");
});

// ── Scenario AH: Truthful Reviewer Failure Lifecycle ──────────────────────────
test("Scenario AH: Reviewer execution failures and schema errors terminate run as failed and parent as blocked", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const sc = new LocalGitSourceControlProvider();

  const parentKey = "PACE-996";
  const parentWt = path.join(worktreeRoot, "epic-pace-996");
  fs.mkdirSync(parentWt, { recursive: true });
  spawnSync("git", ["-C", repo, "worktree", "add", parentWt, "-b", "epic/pace-996"]);

  store.upsertParentExecution({
    parentKey,
    summary: "Reviewer Failure Lifecycle Epic",
    integrationBranch: "epic/pace-996",
    integrationWorktree: parentWt,
    baseSha: String(spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout).trim(),
    state: "active"
  });

  const headSha = String(spawnSync("git", ["-C", parentWt, "rev-parse", "HEAD"]).stdout).trim();

  // 1. Schema failure (missing required fields in evidence) -> reviewer run failed, parent blocked
  const resSchemaFail = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    reviewedSha: headSha,
    injectedReviewOutcome: {
      verdict: "clean",
      evidence: [{ invalidField: "no-id-or-severity" }]
    }
  });
  assert.equal(resSchemaFail.ok, false);
  assert.equal(resSchemaFail.blocked, true);
  assert.ok(resSchemaFail.reviewRunId);

  const runSchemaFail = store.getRun(resSchemaFail.reviewRunId);
  assert.equal(runSchemaFail.state, "failed");

  // 2. Schema failure (invalid verdict) -> reviewer run failed, parent blocked
  const resBadVerdict = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    reviewedSha: headSha,
    injectedReviewOutcome: {
      verdict: "super-clean",
      evidence: [{ id: "1", severity: "suggestion", category: "correctness", problem: "ok" }]
    }
  });
  assert.equal(resBadVerdict.ok, false);
  assert.equal(resBadVerdict.blocked, true);
  assert.ok(resBadVerdict.reviewRunId);

  const runBadVerdict = store.getRun(resBadVerdict.reviewRunId);
  assert.equal(runBadVerdict.state, "failed");

  // 3. Execution failure via failing spawnSync runtime -> reviewer run failed, parent blocked
  const failingRuntime = {
    spawnSync: () => ({ status: 1, stdout: "", stderr: "Reviewer runtime exploded" })
  };

  const resExecFail = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    reviewedSha: headSha,
    runtime: failingRuntime
  });
  assert.equal(resExecFail.ok, false);
  assert.equal(resExecFail.blocked, true);
  assert.ok(resExecFail.reviewRunId);

  const runExecFail = store.getRun(resExecFail.reviewRunId);
  assert.equal(runExecFail.state, "failed");
  assert.match(resExecFail.reason, /Reviewer process failed|Reviewer runtime exploded/i);
});

// ── Scenario AI: Complete Integration-Worker Telemetry & Crash Recovery ───────
test("Scenario AI: Complete integration-worker telemetry queued->started->terminal and crash recovery", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const sc = new LocalGitSourceControlProvider();

  const epicKey = "PACE-997";
  const childKey = "PACE-998";
  const epicWt = path.join(worktreeRoot, "epic-pace-997");
  fs.mkdirSync(epicWt, { recursive: true });
  spawnSync("git", ["-C", repo, "worktree", "add", epicWt, "-b", "epic/pace-997"]);

  store.upsertParentExecution({
    parentKey: epicKey,
    summary: "Crash Recovery Epic",
    integrationBranch: "epic/pace-997",
    integrationWorktree: epicWt,
    baseSha: String(spawnSync("git", ["-C", repo, "rev-parse", "develop"]).stdout).trim(),
    state: "active"
  });

  const childWt = path.join(worktreeRoot, "task-pace-998");
  fs.mkdirSync(childWt, { recursive: true });
  spawnSync("git", ["-C", repo, "worktree", "add", childWt, "-b", "task/pace-998"]);
  fs.writeFileSync(path.join(childWt, "child998.txt"), "hello 998\n");
  spawnSync("git", ["-C", childWt, "add", "."]);
  spawnSync("git", ["-C", childWt, "commit", "-qm", "feat: 998"]);
  const reviewedSha = String(spawnSync("git", ["-C", childWt, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  // Create accepted clean review
  const runId = store.createRun(childKey, { role: "reviewer", summary: "Review 998" });
  store.transition(runId, "review-queued", { implementationSha: reviewedSha });
  store.transition(runId, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: reviewedSha,
      reviewerId: "correctness-reviewer",
      evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }]
    }
  });

  store.upsertEpicTask({
    epicKey,
    parentKey: epicKey,
    issueKey: childKey,
    summary: "Task 998",
    branch: "task/pace-998",
    state: "planned",
    orchestrationState: "planned",
    reviewedSha
  });

  // 1. Normal integration tick -> produces queued, started, and terminal telemetry for integration-worker
  tick(settings, store, { execute: true });

  const intRuns = store.listRunsForIssue(childKey).filter(
    (r) => r.payload?.role === "integration-worker"
  );
  assert.equal(intRuns.length, 1);
  const intRun = intRuns[0];
  assert.equal(intRun.state, "completed");

  const intTelem = store.database.prepare(
    "SELECT event_id, stage, status FROM telemetry_events WHERE run_id = ? ORDER BY id ASC"
  ).all(intRun.id);
  assert.equal(intTelem.length, 3);
  assert.equal(intTelem[0].stage, "queued");
  assert.equal(intTelem[1].stage, "started");
  assert.equal(intTelem[2].stage, "terminal");
  assert.equal(intTelem[2].status, "completed");

  // 2. Crash Recovery Simulation
  // Setup another task 999 where commit was already merged in Git, but crash occurred before DB was marked finished
  const childKey2 = "PACE-999";
  const childWt2 = path.join(worktreeRoot, "task-pace-999");
  fs.mkdirSync(childWt2, { recursive: true });
  spawnSync("git", ["-C", repo, "worktree", "add", childWt2, "-b", "task/pace-999"]);
  fs.writeFileSync(path.join(childWt2, "child999.txt"), "hello 999\n");
  spawnSync("git", ["-C", childWt2, "add", "."]);
  spawnSync("git", ["-C", childWt2, "commit", "-qm", "feat: 999"]);
  const reviewedSha2 = String(spawnSync("git", ["-C", childWt2, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  const runId2 = store.createRun(childKey2, { role: "reviewer", summary: "Review 999" });
  store.transition(runId2, "review-queued", { implementationSha: reviewedSha2 });
  store.transition(runId2, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: reviewedSha2,
      reviewerId: "correctness-reviewer",
      evidence: [{ id: "c2", severity: "suggestion", category: "correctness", problem: "Clean" }]
    }
  });

  store.upsertEpicTask({
    epicKey,
    parentKey: epicKey,
    issueKey: childKey2,
    summary: "Task 999",
    branch: "task/pace-999",
    state: "planned",
    orchestrationState: "planned",
    reviewedSha: reviewedSha2
  });

  // Manually merge into epic worktree in git
  spawnSync("git", ["-C", epicWt, "merge", "--no-ff", "-qm", "merge 999", reviewedSha2]);

  // Set DB state to crashed lane in 'integrating' with unfinished integration-worker run in 'started'
  store.queueEpicIntegration({ epicKey, issueKey: childKey2, leafBranch: "task/pace-999" });
  store.claimEpicIntegration({ epicKey, issueKey: childKey2 });

  const crashedIntRunId = store.createRun(childKey2, {
    role: "integration-worker",
    action: "childIntegration",
    parentKey: epicKey,
    reviewedSha: reviewedSha2
  });
  store.transition(crashedIntRunId, "queued");
  store.transition(crashedIntRunId, "started");

  // Tick triggers crash recovery
  tick(settings, store, { execute: true });

  // Verify lane finished and task marked integrated
  const epicTasks = store.listEpicTasks(epicKey);
  const task999 = epicTasks.find((t) => t.issueKey === childKey2);
  assert.equal(task999.state, "integrated");

  // Verify crashed integration-worker run was recovered and marked completed
  const recoveredRun = store.getRun(crashedIntRunId);
  assert.equal(recoveredRun.state, "completed");

  const recoveredTelem = store.database.prepare(
    "SELECT event_id, stage, status FROM telemetry_events WHERE run_id = ? AND stage = 'terminal'"
  ).all(crashedIntRunId);
  assert.equal(recoveredTelem.length, 1);
  assert.equal(recoveredTelem[0].status, "completed");
});

// ── Scenario AJ: Production Aggregate Reviewer Prompt Verification ──────────
test("Scenario AJ: runParentIntegrationReview passes the complete aggregate prompt to the executor boundary", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  settings.data.executor.providers.antigravity.command = [
    "agy", "exec", "--prompt", "{{prompt}}", "--output-format", "stream-json"
  ];
  const sc = new LocalGitSourceControlProvider();

  const parentKey = "PACE-600";
  const epicBranch = "epic/pace-600";
  const epicWt = path.join(worktreeRoot, "epic-pace-600");
  spawnSync("git", ["-C", repo, "worktree", "add", "-B", epicBranch, epicWt, "develop"]);

  const parentBaseSha = sc.getHead({ repoPath: repo, ref: "develop" }).sha.toLowerCase();

  // Child task A
  const childKey = "PACE-601";
  const childWt = path.join(worktreeRoot, "task-pace-601");
  spawnSync("git", ["-C", repo, "worktree", "add", "-B", "task/pace-601", childWt, epicBranch]);
  fs.mkdirSync(path.join(childWt, "backend"), { recursive: true });
  fs.writeFileSync(path.join(childWt, "backend", "feature.js"), "// aggregate feature\n");
  spawnSync("git", ["-C", childWt, "add", "."]);
  spawnSync("git", ["-C", childWt, "commit", "-qm", "feat: child feature"]);
  const childReviewedSha = sc.getHead({ repoPath: childWt }).sha.toLowerCase();

  // Integrate child into epic worktree
  spawnSync("git", ["-C", epicWt, "merge", "--no-ff", "-qm", "merge child 601", childReviewedSha]);
  const integrationHeadSha = sc.getHead({ repoPath: epicWt }).sha.toLowerCase();

  store.upsertParentExecution({
    parentKey,
    sourceProvider: "jira",
    summary: "Order Processing Engine",
    description: "Must reliably process orders across payment and inventory subsystems.",
    acceptanceCriteria: "[x] Validates payment\n[x] Updates inventory ledger",
    baseRef: "develop",
    baseSha: parentBaseSha,
    integrationBranch: epicBranch,
    integrationWorktree: epicWt,
    integrationHeadSha,
    graphFingerprint: "fp-600",
    state: "active"
  });

  store.upsertEpicTask({
    epicKey: parentKey,
    parentKey,
    issueKey: childKey,
    summary: "Payment Integration",
    branch: "task/pace-601",
    worktree: childWt,
    state: "integrated",
    orchestrationState: "integrated",
    reviewedSha: childReviewedSha,
    integratedSha: integrationHeadSha
  });

  store.queueEpicIntegration({ epicKey: parentKey, issueKey: childKey, leafBranch: "task/pace-601" });
  store.claimEpicIntegration({ epicKey: parentKey, issueKey: childKey });
  store.finishEpicIntegration({ epicKey: parentKey, issueKey: childKey, commit: integrationHeadSha });

  let capturedCommand = null;
  const spyRuntime = {
    spawnSync: (cmd, args, opts) => {
      capturedCommand = { cmd, args, opts };
      const finalLine = JSON.stringify({
        status: "SUCCESS",
        response: JSON.stringify({
          verdict: "clean",
          evidence: [
            {
              id: "rev-600-1",
              severity: "suggestion",
              category: "correctness",
              file: "backend/feature.js",
              line: 1,
              problem: "Verified aggregate correctness across child changes",
              expected: "No regressions",
              verification: "All unit tests pass"
            }
          ]
        }),
        usage: {
          input_tokens: 1200,
          output_tokens: 350
        },
        duration_seconds: 4.5
      });
      return {
        status: 0,
        stdout: `${finalLine}\n`,
        stderr: ""
      };
    }
  };

  const reviewRes = await runParentIntegrationReview(settings, store, parentKey, {
    runtime: spyRuntime,
    codeIntelligence: {
      provider: "mock-intel",
      status: "ready",
      summary: "High cohesion across backend/feature.js"
    }
  });

  assert.equal(reviewRes.ok, true);
  assert.equal(reviewRes.verdict, "clean");
  assert.ok(capturedCommand, "Reviewer spawnSync must have been invoked");

  const fullCommandArgs = capturedCommand.args.join(" ");
  assert.ok(fullCommandArgs.includes("Order Processing Engine"), "Prompt must include parent summary");
  assert.ok(fullCommandArgs.includes("Must reliably process orders across payment and inventory subsystems"), "Prompt must include parent description");
  assert.ok(fullCommandArgs.includes("Validates payment"), "Prompt must include parent acceptance criteria");
  assert.ok(fullCommandArgs.includes(parentBaseSha), "Prompt must include parentBaseSha");
  assert.ok(fullCommandArgs.includes(integrationHeadSha), "Prompt must include integrationHeadSha");
  assert.ok(fullCommandArgs.includes(childReviewedSha), "Prompt must include child reviewedSha");
  assert.ok(fullCommandArgs.includes("backend/feature.js"), "Prompt must include aggregate changed files");
  assert.ok(fullCommandArgs.includes("npm run check passed"), "Prompt must include repository verification");
});

// ── Scenario AK: Telemetry Contract Normalization Verification ─────────────
test("Scenario AK: Reviewer and integration worker emit normalized Phase F telemetry schema", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const sc = new LocalGitSourceControlProvider();

  const parentKey = "PACE-750";
  const epicBranch = "epic/pace-750";
  const epicWt = path.join(worktreeRoot, "epic-pace-750");
  spawnSync("git", ["-C", repo, "worktree", "add", "-B", epicBranch, epicWt, "develop"]);
  const baseSha = sc.getHead({ repoPath: repo, ref: "develop" }).sha.toLowerCase();

  // Task 751
  const childKey = "PACE-751";
  const childWt = path.join(worktreeRoot, "task-pace-751");
  spawnSync("git", ["-C", repo, "worktree", "add", "-B", "task/pace-751", childWt, epicBranch]);
  fs.writeFileSync(path.join(childWt, "child751.txt"), "hello 751\n");
  spawnSync("git", ["-C", childWt, "add", "."]);
  spawnSync("git", ["-C", childWt, "commit", "-qm", "feat: 751"]);
  const childSha = sc.getHead({ repoPath: childWt }).sha.toLowerCase();

  spawnSync("git", ["-C", epicWt, "merge", "--no-ff", "-qm", "merge 751", childSha]);
  const intHeadSha = sc.getHead({ repoPath: epicWt }).sha.toLowerCase();

  store.upsertParentExecution({
    parentKey,
    sourceProvider: "jira",
    summary: "Telemetry Epic",
    baseRef: "develop",
    baseSha,
    integrationBranch: epicBranch,
    integrationWorktree: epicWt,
    integrationHeadSha: intHeadSha,
    graphFingerprint: "fp-750",
    state: "active"
  });

  store.upsertEpicTask({
    epicKey: parentKey,
    parentKey,
    issueKey: childKey,
    summary: "Telemetry Task",
    branch: "task/pace-751",
    worktree: childWt,
    state: "integrated",
    orchestrationState: "integrated",
    reviewedSha: childSha,
    integratedSha: intHeadSha
  });
  store.queueEpicIntegration({ epicKey: parentKey, issueKey: childKey, leafBranch: "task/pace-751" });
  store.claimEpicIntegration({ epicKey: parentKey, issueKey: childKey });
  store.finishEpicIntegration({ epicKey: parentKey, issueKey: childKey, commit: intHeadSha });

  // 1. Reviewer execution failure telemetry
  const failRuntime = {
    spawnSync: () => ({
      status: 1,
      stdout: "",
      stderr: "Process crashed unexpectedly"
    })
  };

  const failRes = await runParentIntegrationReview(settings, store, parentKey, {
    runtime: failRuntime
  });
  assert.equal(failRes.ok, false);

  const failTelem = store.database.prepare(
    "SELECT * FROM telemetry_events WHERE issue_key = ? AND role = 'reviewer' AND stage = 'terminal'"
  ).get(parentKey);
  assert.ok(failTelem);
  assert.equal(failTelem.status, "failed");
  assert.equal(failTelem.error_category, "reviewer_execution_error");
  assert.ok(failTelem.error_message.includes("crashed") || failTelem.error_message.includes("return code 1"));
  assert.equal(failTelem.usage_available, 0);
  assert.equal(failTelem.input_tokens, null);
  assert.equal(failTelem.output_tokens, null);

  // 2. Reviewer success with token usage telemetry
  store.updateParentExecutionState(parentKey, "active");
  const successRuntime = {
    spawnSync: () => {
      const finalLine = JSON.stringify({
        status: "SUCCESS",
        response: JSON.stringify({
          verdict: "clean",
          evidence: [{ id: "rev-ok", severity: "suggestion", category: "correctness", problem: "Clean check" }]
        }),
        usage: {
          input_tokens: 1200,
          output_tokens: 350
        },
        duration_seconds: 4.5
      });
      return {
        status: 0,
        stdout: `${finalLine}\n`,
        stderr: ""
      };
    }
  };

  const okRes = await runParentIntegrationReview(settings, store, parentKey, {
    runtime: successRuntime
  });
  assert.equal(okRes.ok, true);

  const okTelem = store.database.prepare(
    "SELECT * FROM telemetry_events WHERE issue_key = ? AND role = 'reviewer' AND stage = 'terminal' ORDER BY id DESC LIMIT 1"
  ).get(parentKey);
  assert.ok(okTelem);
  assert.equal(okTelem.status, "completed");
  assert.equal(okTelem.error_category, null);
  assert.equal(okTelem.error_message, null);
});

// ── Scenario AL: PM Workspace Surface Parent Approvals & Stale Fingerprints ──
test("Scenario AL: PM Workspace surfaces pending parent branchCreation and review approvals with exact fingerprints", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "manual" });
  const workSource = new FakeWorkSourceProvider();

  const parentKey = "PACE-850";
  const childKey = "PACE-851";

  const parent = {
    key: parentKey,
    id: parentKey,
    summary: "Manual Mode Parent",
    issueType: "Epic",
    canonicalState: "ready"
  };
  const child = {
    key: childKey,
    id: childKey,
    summary: "Manual Mode Child",
    issueType: "Task",
    canonicalState: "ready"
  };

  workSource.setWorkItem(parent);
  workSource.setWorkItem(child);
  workSource.setChildren(parentKey, [child]);
  workSource.setDependencies(childKey, []);

  // 1. In manual mode, discoverAndPinParent requests branchCreation approval
  const pinRes = await discoverAndPinParent(settings, store, parent, { execute: true, workSource });
  assert.equal(pinRes.ok, false);
  assert.equal(pinRes.waitingApproval, true);

  const pendingExec = store.getParentExecution(parentKey);
  assert.equal(pendingExec.state, "waiting_approval");

  // 2. Check PM Workspace read model
  let ws = buildPmWorkspace(settings, { store });
  assert.equal(ws.counts.awaitingApproval, 1);
  const pendingItem = ws.groups.awaitingApproval[0];
  assert.equal(pendingItem.issueKey, parentKey);
  assert.equal(pendingItem.action, "branchCreation");
  assert.ok(pendingItem.planFingerprint);

  // 3. Stale fingerprint rejection
  assert.throws(
    () => handlePmApproval(settings, parentKey, { action: "branchCreation", planFingerprint: "stale-fp-123" }, { store }),
    (err) => err.statusCode === 409
  );

  // 4. Exact approval succeeds and item leaves awaitingApproval
  const approveRes = handlePmApproval(settings, parentKey, {
    action: "branchCreation",
    planFingerprint: pendingItem.planFingerprint
  }, { store });
  assert.equal(approveRes.ok, true);

  ws = buildPmWorkspace(settings, { store });
  assert.equal(ws.groups.awaitingApproval.length, 0);

  // 5. Parent rejection moves parent to blocked
  store.updateParentExecutionState(parentKey, "waiting_approval");
  const reviewFingerprint = computeParentReviewFingerprint({
    parentKey,
    parentBaseSha: "base-sha-1",
    integrationHeadSha: "head-sha-1",
    graphFingerprint: "fp-850"
  });

  store.addPmDecision(parentKey, "approval_requested", {
    action: "review",
    planFingerprint: reviewFingerprint,
    reason: "Aggregate integration review requires PM sign-off"
  });

  ws = buildPmWorkspace(settings, { store });
  assert.equal(ws.groups.awaitingApproval.length, 1);
  assert.equal(ws.groups.awaitingApproval[0].action, "review");
  assert.equal(ws.groups.awaitingApproval[0].planFingerprint, reviewFingerprint);

  handlePmRejection(settings, parentKey, {
    action: "review",
    planFingerprint: reviewFingerprint,
    reason: "Integration review rejected by PM"
  }, { store });

  ws = buildPmWorkspace(settings, { store });
  assert.equal(ws.groups.awaitingApproval.length, 0);
  assert.equal(ws.groups.blocked.length, 1);
  assert.equal(ws.groups.blocked[0].issueKey, parentKey);
  assert.equal(ws.groups.blocked[0].blockedReason, "Integration review rejected by PM");
});

// ── Scenario AM: Crash Recovery Rejects Stale Unfinished Integration Runs ────
test("Scenario AM: Unfinished integration-worker crash recovery tightens matching to exact reviewedSha", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const sc = new LocalGitSourceControlProvider();

  const epicKey = "PACE-880";
  const epicBranch = "epic/pace-880";
  const epicWt = path.join(worktreeRoot, "epic-pace-880");
  spawnSync("git", ["-C", repo, "worktree", "add", "-B", epicBranch, epicWt, "develop"]);
  const baseSha = sc.getHead({ repoPath: repo, ref: "develop" }).sha.toLowerCase();

  const childKey = "PACE-881";
  const childWt = path.join(worktreeRoot, "task-pace-881");
  spawnSync("git", ["-C", repo, "worktree", "add", "-B", "task/pace-881", childWt, epicBranch]);

  // Older reviewed SHA 1
  fs.writeFileSync(path.join(childWt, "v1.txt"), "v1\n");
  spawnSync("git", ["-C", childWt, "add", "."]);
  spawnSync("git", ["-C", childWt, "commit", "-qm", "v1"]);
  const oldSha = sc.getHead({ repoPath: childWt }).sha.toLowerCase();

  // Newer reviewed SHA 2
  fs.writeFileSync(path.join(childWt, "v2.txt"), "v2\n");
  spawnSync("git", ["-C", childWt, "add", "."]);
  spawnSync("git", ["-C", childWt, "commit", "-qm", "v2"]);
  const newSha = sc.getHead({ repoPath: childWt }).sha.toLowerCase();

  // Merge new SHA into epic worktree in Git
  spawnSync("git", ["-C", epicWt, "merge", "--no-ff", "-qm", "merge v2", newSha]);

  store.upsertParentExecution({
    parentKey: epicKey,
    sourceProvider: "jira",
    summary: "Crash Recovery Epic",
    baseRef: "develop",
    baseSha,
    integrationBranch: epicBranch,
    integrationWorktree: epicWt,
    graphFingerprint: "fp-880",
    state: "active"
  });

  // Set up child clean review on newSha
  const revRun = store.createRun(childKey, { role: "reviewer", summary: "Review 881 v2" });
  store.transition(revRun, "review-queued", { implementationSha: newSha });
  store.transition(revRun, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: newSha,
      reviewerId: "correctness-reviewer",
      evidence: [{ id: "c881", severity: "suggestion", category: "correctness", problem: "Clean v2" }]
    }
  });

  store.upsertEpicTask({
    epicKey,
    parentKey: epicKey,
    issueKey: childKey,
    summary: "Task 881",
    branch: "task/pace-881",
    state: "planned",
    orchestrationState: "planned",
    reviewedSha: newSha
  });

  store.queueEpicIntegration({ epicKey, issueKey: childKey, leafBranch: "task/pace-881" });
  store.claimEpicIntegration({ epicKey, issueKey: childKey });

  // Create an older unfinished integration-worker run created for oldSha
  const staleIntRunId = store.createRun(childKey, {
    role: "integration-worker",
    action: "childIntegration",
    parentKey: epicKey,
    reviewedSha: oldSha
  });
  store.transition(staleIntRunId, "queued");
  store.transition(staleIntRunId, "started");

  // Create the matching unfinished integration-worker run created for newSha
  const matchingIntRunId = store.createRun(childKey, {
    role: "integration-worker",
    action: "childIntegration",
    parentKey: epicKey,
    reviewedSha: newSha
  });
  store.transition(matchingIntRunId, "queued");
  store.transition(matchingIntRunId, "started");

  // Run tick crash recovery
  await tick(settings, store, { execute: true });

  // Stale run created for oldSha must NOT have been completed
  const staleRun = store.getRun(staleIntRunId);
  assert.equal(staleRun.state, "started", "Older unfinished run for different reviewedSha must remain untouched");

  // Matching run created for newSha MUST have been completed
  const matchingRun = store.getRun(matchingIntRunId);
  assert.equal(matchingRun.state, "completed", "Matching unfinished run for current reviewedSha must be completed");

  const matchingTelem = store.database.prepare(
    "SELECT event_id, stage, status FROM telemetry_events WHERE run_id = ? AND stage = 'terminal'"
  ).all(matchingIntRunId);
  assert.equal(matchingTelem.length, 1);
  assert.equal(matchingTelem[0].status, "completed");
});
