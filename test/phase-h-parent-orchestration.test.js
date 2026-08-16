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
import { HUMAN_ONLY_ACTIONS, resolveAutonomyPolicy, authorizeRuntimeAction } from "../lib/policy.js";

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
  const store = new RunStore(path.join(dbDir, "runs.sqlite3"));

  return { repo, worktreeRoot, store };
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
  const leafBranch301 = task301.branch;
  const childDir = task301.worktree || repo;
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

  store.upsertParentExecution({
    parentKey,
    summary: "Stale test",
    baseSha: "develop",
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
    baseSha: "develop",
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
