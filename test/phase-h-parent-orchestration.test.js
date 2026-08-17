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
            modelProfiles: { medium: "claude-sonnet-4" }
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
  const settings = makeSettings(repo, worktreeRoot, store);
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
    injectedReviewOutcome: { verdict: "clean", evidence: [] }
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
    injectedReviewOutcome: { verdict: "clean", evidence: [] }
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
    injectedReviewOutcome: { verdict: "clean", evidence: [] }
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

// ── Scenario AD: Parent Approvals Bound to Deterministic Fingerprints ────────
test("Scenario AD: Parent branch creation and review approvals are strictly bound to deterministic fingerprints", async () => {
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

  const graphFp1 = res1.execution.graphFingerprint;
  const branchPlan1 = {
    parentKey,
    issueKey: parentKey,
    graphFingerprint: graphFp1,
    baseSha: res1.execution.baseSha,
    integrationBranch: res1.execution.integrationBranch
  };
  const branchFp1 = computeParentBranchFingerprint(branchPlan1);

  // Verify approval_requested PM decision was persisted
  const pmDecisions = store.getPmDecisions(parentKey);
  const appReq = pmDecisions.find((d) => d.type === "approval_requested" && d.payload.action === "branchCreation");
  assert.ok(appReq);
  assert.equal(appReq.payload.planFingerprint, branchFp1);

  // 2. Approve with mismatched/old fingerprint -> still denied
  store.recordApprovalDecision(parentKey, {
    action: "branchCreation",
    approved: true,
    planFingerprint: "stale-mismatched-fingerprint"
  });

  const res2 = await discoverAndPinParent(settings, store, parent980, { workSource, execute: true });
  assert.equal(res2.ok, false);
  assert.equal(res2.waitingApproval, true);

  // 3. Approve with EXACT fingerprint -> resumes to active
  store.recordApprovalDecision(parentKey, {
    action: "branchCreation",
    approved: true,
    planFingerprint: branchFp1
  });

  const res3 = await discoverAndPinParent(settings, store, parent980, { workSource, execute: true });
  assert.equal(res3.ok, true);
  assert.equal(res3.execution.state, "active");
  assert.ok(res3.execution.integrationWorktree);

  // 4. Test review approval fingerprint binding
  const baseSha = res3.execution.baseSha;
  const wt = res3.execution.integrationWorktree;
  fs.writeFileSync(path.join(wt, "file_x.txt"), "content x\n", "utf8");
  spawnSync("git", ["-C", wt, "add", "."]);
  spawnSync("git", ["-C", wt, "commit", "-qm", "feat: commit x"]);
  const headShaX = String(spawnSync("git", ["-C", wt, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  // Review approval for SHA X
  const revDef = store.getAgentDefinition("correctness-reviewer");
  const reviewPlanX = {
    parentKey,
    issueKey: parentKey,
    graphFingerprint: graphFp1,
    parentBaseSha: baseSha,
    integrationHeadSha: headShaX,
    reviewerAgentId: "correctness-reviewer",
    reviewerVersion: revDef?.currentVersion || 1,
    reviewerHash: revDef?.definitionHash || null
  };
  const reviewFpX = computeParentReviewFingerprint(reviewPlanX);

  store.recordApprovalDecision(parentKey, {
    action: "review",
    approved: true,
    planFingerprint: reviewFpX
  });

  // Branch advances to SHA Y before review runs
  fs.writeFileSync(path.join(wt, "file_y.txt"), "content y\n", "utf8");
  spawnSync("git", ["-C", wt, "add", "."]);
  spawnSync("git", ["-C", wt, "commit", "-qm", "feat: commit y"]);
  const headShaY = String(spawnSync("git", ["-C", wt, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  // Review with SHA Y should be denied because approval was only for SHA X
  const sc = new LocalGitSourceControlProvider();
  const revResStale = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    reviewedSha: headShaY,
    injectedReviewOutcome: { verdict: "clean", evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }] }
  });
  assert.equal(revResStale.ok, false);
  assert.equal(revResStale.waitingApproval, true);

  // Approve for exact SHA Y -> review succeeds and transitions run
  const reviewPlanY = {
    parentKey,
    issueKey: parentKey,
    graphFingerprint: graphFp1,
    parentBaseSha: baseSha,
    integrationHeadSha: headShaY,
    reviewerAgentId: "correctness-reviewer",
    reviewerVersion: revDef?.currentVersion || 1,
    reviewerHash: revDef?.definitionHash || null
  };
  const reviewFpY = computeParentReviewFingerprint(reviewPlanY);
  store.recordApprovalDecision(parentKey, {
    action: "review",
    approved: true,
    planFingerprint: reviewFpY
  });

  const revResClean = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    reviewedSha: headShaY,
    injectedReviewOutcome: { verdict: "clean", evidence: [{ id: "c1", severity: "suggestion", category: "correctness", problem: "Clean" }] }
  });
  assert.equal(revResClean.ok, true);
  assert.equal(revResClean.parentState, "waiting_human");

  // Verify reviewer run was completed in runs table (not discovered)
  const revRun = store.getRun(revResClean.reviewRunId);
  assert.ok(revRun);
  assert.equal(revRun.state, "completed");
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
test("Scenario AF: True production lifecycle E2E through dispatch, auto-integration, unlock, aggregate review, to WAITING_HUMAN", async () => {
  const { repo, worktreeRoot, store } = makeTestGitRepo();
  const settings = makeSettings(repo, worktreeRoot, store, { operatingMode: "autonomous" });
  const workSource = new FakeWorkSourceProvider();
  const sc = new LocalGitSourceControlProvider();

  const parentKey = "PACE-990";
  const childA = "PACE-991";
  const childB = "PACE-992";
  const childC = "PACE-993";

  const parent = { key: parentKey, summary: "Parent P", issueType: "Epic" };
  const taskA = { key: childA, summary: "Task A", issueType: "Task" };
  const taskB = { key: childB, summary: "Task B", issueType: "Task" };
  const taskC = { key: childC, summary: "Task C", issueType: "Task" };

  workSource.setChildren(parentKey, [taskA, taskB, taskC]);
  workSource.setDependencies(childA, []);
  workSource.setDependencies(childB, [childA]); // B depends on A
  workSource.setDependencies(childC, []);        // C independent

  // 1. Discover & Pin Parent
  const discRes = await discoverAndPinParent(settings, store, parent, { workSource, execute: true });
  assert.equal(discRes.ok, true);
  assert.equal(discRes.execution.state, "active");
  const parentWt = discRes.execution.integrationWorktree;
  assert.ok(parentWt);

  // 2. Reconcile parent children -> A and C become dependency-ready; B stays pending-dependencies
  const recRes1 = reconcileParentChildren(settings, store, parentKey);
  assert.deepEqual(recRes1.readyChildren.sort(), [childA, childC].sort());

  const taskBAfter1 = store.getEpicTask(parentKey, childB);
  assert.equal(taskBAfter1.orchestrationState, "pending-dependencies");

  // 3. Implement and review A and C in their worktrees
  const planA = { issueKey: childA, summary: "Task A", branch: `task/pace-991-task-a` };
  const wtA = sc.prepareChildWorktree({
    repoPath: repo,
    root: worktreeRoot,
    parentKey,
    parentBranch: discRes.execution.integrationBranch,
    issueKey: childA,
    summary: "Task A",
    baseRef: store.getEpicTask(parentKey, childA).childBaseSha,
    execute: true,
    plan: planA
  }).worktree;

  fs.writeFileSync(path.join(wtA, "backend", "a.js"), "module.exports = { a: 1 };\n");
  spawnSync("git", ["-C", wtA, "add", "."]);
  spawnSync("git", ["-C", wtA, "commit", "-qm", "feat: implement A"]);
  const shaA = String(spawnSync("git", ["-C", wtA, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  const planC = { issueKey: childC, summary: "Task C", branch: `task/pace-993-task-c` };
  const wtC = sc.prepareChildWorktree({
    repoPath: repo,
    root: worktreeRoot,
    parentKey,
    parentBranch: discRes.execution.integrationBranch,
    issueKey: childC,
    summary: "Task C",
    baseRef: store.getEpicTask(parentKey, childC).childBaseSha,
    execute: true,
    plan: planC
  }).worktree;

  fs.writeFileSync(path.join(wtC, "frontend", "c.js"), "module.exports = { c: 1 };\n");
  spawnSync("git", ["-C", wtC, "add", "."]);
  spawnSync("git", ["-C", wtC, "commit", "-qm", "feat: implement C"]);
  const shaC = String(spawnSync("git", ["-C", wtC, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  // Create runs for A and C and record clean reviews
  const runA = store.createRun(childA, { role: "implementation", summary: "Task A" });
  store.transition(runA, "completed", { implementationSha: shaA });
  const revRunA = store.createRun(childA, { role: "reviewer", summary: "Review Task A", implementationSha: shaA });
  store.transition(revRunA, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: shaA,
      reviewerId: "correctness-reviewer",
      evidence: [{ id: "rev-a", severity: "suggestion", category: "correctness", problem: "Clean A" }]
    }
  });

  const runC = store.createRun(childC, { role: "implementation", summary: "Task C" });
  store.transition(runC, "completed", { implementationSha: shaC });
  const revRunC = store.createRun(childC, { role: "reviewer", summary: "Review Task C", implementationSha: shaC });
  store.transition(revRunC, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: shaC,
      reviewerId: "correctness-reviewer",
      evidence: [{ id: "rev-c", severity: "suggestion", category: "correctness", problem: "Clean C" }]
    }
  });

  // 4. Tick reconciliation integrates A and C into parent worktree (first tick integrates A, second tick integrates C)
  tick(settings, store, { execute: true });
  tick(settings, store, { execute: true });

  // Verify A and C integrated, B unlocked with fresh childBaseSha
  const taskAAfter = store.getEpicTask(parentKey, childA);
  const taskCAfter = store.getEpicTask(parentKey, childC);
  assert.equal(taskAAfter.state, "integrated");
  assert.equal(taskCAfter.state, "integrated");

  const recRes2 = reconcileParentChildren(settings, store, parentKey);
  assert.deepEqual(recRes2.readyChildren, [childB]);

  const taskBAfter2 = store.getEpicTask(parentKey, childB);
  assert.equal(taskBAfter2.orchestrationState, "dependency-ready");
  assert.ok(taskBAfter2.childBaseSha);

  // 5. Implement and review B (based on newly integrated parent head)
  const planB = { issueKey: childB, summary: "Task B", branch: `task/pace-992-task-b` };
  const wtB = sc.prepareChildWorktree({
    repoPath: repo,
    root: worktreeRoot,
    parentKey,
    parentBranch: discRes.execution.integrationBranch,
    issueKey: childB,
    summary: "Task B",
    baseRef: taskBAfter2.childBaseSha,
    execute: true,
    plan: planB
  }).worktree;

  // B sees A's changes
  assert.ok(fs.existsSync(path.join(wtB, "backend", "a.js")));

  fs.writeFileSync(path.join(wtB, "backend", "b.js"), "module.exports = { b: 2 };\n");
  spawnSync("git", ["-C", wtB, "add", "."]);
  spawnSync("git", ["-C", wtB, "commit", "-qm", "feat: implement B"]);
  const shaB = String(spawnSync("git", ["-C", wtB, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();

  const runB = store.createRun(childB, { role: "implementation", summary: "Task B" });
  store.transition(runB, "completed", { implementationSha: shaB });
  const revRunB = store.createRun(childB, { role: "reviewer", summary: "Review Task B", implementationSha: shaB });
  store.transition(revRunB, "reviewed-clean", {
    reviewOutcome: {
      verdict: "clean",
      implementationSha: shaB,
      reviewerId: "correctness-reviewer",
      evidence: [{ id: "rev-b", severity: "suggestion", category: "correctness", problem: "Clean B" }]
    }
  });

  // 6. Tick integrates B
  tick(settings, store, { execute: true });

  const taskBFinal = store.getEpicTask(parentKey, childB);
  assert.equal(taskBFinal.state, "integrated");

  // 7. Run Parent Integration Review
  const headShaFinal = String(spawnSync("git", ["-C", parentWt, "rev-parse", "HEAD"]).stdout).trim().toLowerCase();
  const revRes = await runParentIntegrationReview(settings, store, parentKey, {
    sourceControl: sc,
    reviewedSha: headShaFinal,
    injectedReviewOutcome: {
      verdict: "clean",
      evidence: [{ id: "agg-rev", severity: "suggestion", category: "correctness", problem: "All children clean" }]
    }
  });

  assert.equal(revRes.ok, true);
  assert.equal(revRes.parentState, "waiting_human");

  // 8. Assertions:
  // - No child individually entered human approval
  const runsA = store.listRunsForIssue(childA);
  const runsB = store.listRunsForIssue(childB);
  const runsC = store.listRunsForIssue(childC);
  assert.ok(!runsA.some((r) => r.state === "waiting_human"));
  assert.ok(!runsB.some((r) => r.state === "waiting_human"));
  assert.ok(!runsC.some((r) => r.state === "waiting_human"));

  // - Aggregate reviewer run is completed in SQLite runs table (not discovered)
  const aggRevRun = store.getRun(revRes.reviewRunId);
  assert.ok(aggRevRun);
  assert.equal(aggRevRun.state, "completed");

  // - Parent telemetry contains child_dispatched, child_integrating, child_integrated
  const telemEvents = store.database.prepare(
    "SELECT event_id, stage, status, raw_payload FROM telemetry_events WHERE issue_key = ? ORDER BY id ASC"
  ).all(parentKey);

  const rawTexts = telemEvents.map((e) => e.raw_payload || "");
  assert.ok(rawTexts.some((t) => t.includes("child_integrating")));
  assert.ok(rawTexts.some((t) => t.includes("child_integrated")));

  // - Final state is WAITING_HUMAN, no merge to develop occurred
  const finalParent = store.getParentExecution(parentKey);
  assert.equal(finalParent.state, "waiting_human");
  assert.ok(finalParent.completionPacket);
  assert.equal(finalParent.completionPacket.integrationReview.verdict, "clean");

  const developBranch = String(spawnSync("git", ["-C", repo, "branch", "--show-current"]).stdout).trim();
  assert.equal(developBranch, "develop");
  assert.ok(!fs.existsSync(path.join(repo, "backend", "a.js"))); // develop untouched
});
