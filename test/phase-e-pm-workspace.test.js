/**
 * test/phase-e-pm-workspace.test.js
 *
 * Dedicated Phase E Test Suite — PM Workspace Correctness Hardening:
 * 1. Orchestrator rationale/reasons never treated as blockers (eligible/ready with reasons != blocked)
 * 2. Real Phase A recordReviewerOutcome() integration with lossless structured findings preservation & clean review
 * 3. Server-authoritative action & attempt approval gating:
 *    - Manual mode review: pending approval, implementation -> 409, review -> ok, runtime authorized
 *    - Supervised mode review: autonomous, approve -> 409 no approval pending, no decision written
 *    - Already-approved implementation: duplicate approval -> 409, no duplicate decisions
 *    - Rework attempt isolation: attempt 1 cannot approve attempt 2
 * 4. PM mutations fail closed by default (403 when flags absent)
 * 5. Provider-neutral source identity preservation from plan.workSource
 * 6. Historical identity/state integrity (no fake v1 or fabricated canonical states)
 * 7. Real durable Needs Planning integration via fake WorkSourceProvider discovery lifecycle
 * 8. HTTP server endpoints and security gates (loopback check, Content-Type 415, no-Done bypass)
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { RunStore } from "../lib/store.js";
import { createDashboardServer } from "../lib/dashboard.js";
import {
  buildPmWorkspace,
  buildPmWorkItemDetail,
  handlePmApproval,
  handlePmRejection,
  classifyOperationalGroup,
  determineItemAction,
  determineItemAttempt
} from "../lib/pm-workspace.js";
import { computePlanFingerprint, authorizeRuntimeAction } from "../lib/policy.js";
import { recordReviewerOutcome } from "../lib/reconciler.js";
import { WorkSourceProvider, discoverWorkItems } from "../lib/work-source.js";

function makeTestStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-ws-hardened-"));
  return new RunStore(path.join(dir, "runs.sqlite3"));
}

function makeSettings(store, overrides = {}) {
  return {
    source: "/tmp/pm-settings.json",
    projectKey: "PACE",
    repoPath: "/tmp/repo",
    worktreeRoot: "/tmp/worktrees",
    _store: store,
    data: {
      project: {
        key: "PACE",
        repoPath: ".",
        operatingMode: overrides.operatingMode || "supervised"
      },
      policy: {
        allowedProjects: ["PACE"],
        humanOnlyStatuses: ["Done"],
        operatingMode: overrides.operatingMode || "supervised",
        requiredLabels: ["agent-ready"],
        maxAttempts: 3,
        review: {
          provider: "antigravity",
          modelProfile: "claude-review",
          maxReworkAttempts: 3
        },
        pathScopes: {
          "backend-engineer": ["backend/**"],
          "frontend-engineer": ["frontend/**"]
        },
        ...(overrides.policy || {})
      },
      workSource: {
        defaultProvider: "jira",
        providers: { jira: { type: "jira", baseUrl: "https://pacebuild.atlassian.net" } }
      },
      orchestrator: {
        defaultProvider: "codex",
        providers: { codex: { command: ["codex", "exec"] } }
      },
      executor: {
        defaultProvider: "codex",
        providers: {
          codex: { command: ["codex"], defaultModel: "gpt-5", defaultEffort: "medium" },
          antigravity: { command: ["agy"], defaultModel: "claude-3-5-sonnet", defaultEffort: "medium" }
        }
      },
      controlPlane: {
        configMutationEnabled: true,
        pmMutationEnabled: true,
        agentRegistryMutationEnabled: true,
        ...(overrides.controlPlane || {})
      }
    }
  };
}

async function request(server, pathStr, options = {}) {
  const address = server.address();
  const host = options.host || "127.0.0.1";
  const url = `http://${host}:${address.port}${pathStr}`;
  const headers = { ...(options.headers || {}) };
  if (options.json !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const body = options.json !== undefined ? JSON.stringify(options.json) : options.body;

  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method || "GET", headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          json: parsed
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("1. Orchestrator rationale/reasons are never treated as blockers", () => {
  const store = makeTestStore();
  const settings = makeSettings(store, { operatingMode: "autonomous" });

  const planWithReasons = {
    issue: "PACE-100",
    summary: "Standard routing task",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    reasons: ["Rule-based routing decision", "Selected backend specialist based on path scope"],
    rationale: ["Rule-based routing decision"],
    configSnapshot: {
      operatingMode: "autonomous",
      taskAgent: "backend-engineer",
      rationale: ["Rule-based routing decision"]
    }
  };

  const runId = store.createRun("PACE-100", planWithReasons);
  store.transition(runId, "eligible", { reasons: ["Rule-based routing decision"] });

  const ws = buildPmWorkspace(settings, { store });

  assert.equal(ws.counts.blocked, 0, "Eligible task with orchestrator routing reasons MUST NOT appear in blocked");
  assert.equal(ws.counts.ready, 1, "Autonomous eligible task must appear in ready group");
  assert.equal(ws.groups.ready[0].issueKey, "PACE-100");
  assert.equal(ws.groups.ready[0].blockedReason, null);
});

test("2. Real Phase A review outcome persistence shape & lossless findings integration", () => {
  const store = makeTestStore();
  const settings = makeSettings(store, { operatingMode: "autonomous" });

  const plan = {
    issue: "PACE-200",
    summary: "Auth controller with review cycle",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    agentId: "backend-engineer",
    agentVersion: 1,
    allowedPaths: ["backend/**"],
    configSnapshot: { operatingMode: "autonomous", taskAgent: "backend-engineer" }
  };

  const runId = store.createRun("PACE-200", plan);
  store.transition(runId, "prepared", { branch: "feature/pace-200" });
  store.transition(runId, "executing", { provider: "codex", model: "gpt-5" });
  store.transition(runId, "verifying", {});
  const sha = "a".repeat(40);
  store.transition(runId, "review-queued", { implementationSha: sha });

  // Call real recordReviewerOutcome with changes-requested
  const reviewResult = recordReviewerOutcome(store, {
    runId,
    implementationSha: sha,
    reviewerId: "security-auditor-1",
    verdict: "changes-requested",
    evidence: [
      {
        id: "SEC-101",
        severity: "critical",
        category: "security",
        file: "backend/auth.py",
        line: 88,
        problem: "Missing token revocation check",
        expected: "Verify token against blocklist",
        verification: "pytest backend/tests/test_auth.py"
      }
    ]
  });

  assert.equal(reviewResult.recorded, true);
  assert.equal(reviewResult.state, "review-failed");

  // Verify PM Workspace & PM Detail consume real persisted reviewOutcome shape losslessly
  const detail = buildPmWorkItemDetail(settings, "PACE-200", { store });
  assert.ok(detail);
  assert.equal(detail.review.verdict, "changes-requested");
  assert.equal(detail.review.structuredFindings.length, 1);
  const finding = detail.review.structuredFindings[0];
  assert.equal(finding.id, "SEC-101");
  assert.equal(finding.severity, "critical");
  assert.equal(finding.category, "security");
  assert.equal(finding.file, "backend/auth.py");
  assert.equal(finding.line, 88);
  assert.equal(finding.problem, "Missing token revocation check");
  assert.equal(finding.expected, "Verify token against blocklist");
  assert.equal(finding.verification, "pytest backend/tests/test_auth.py");

  // Test clean review integration on a separate run
  const planClean = {
    issue: "PACE-201",
    summary: "Clean reviewed feature",
    persona: "backend-engineer",
    taskAgent: "backend-engineer"
  };
  const run2Id = store.createRun("PACE-201", planClean);
  store.transition(run2Id, "verifying", {});
  const sha2 = "b".repeat(40);
  store.transition(run2Id, "review-queued", { implementationSha: sha2 });

  const cleanResult = recordReviewerOutcome(store, {
    runId: run2Id,
    implementationSha: sha2,
    reviewerId: "qa-reviewer-2",
    verdict: "clean",
    evidence: [
      {
        id: "CLEAN-OK",
        severity: "suggestion",
        category: "correctness",
        problem: "All tests pass cleanly"
      }
    ]
  });
  assert.equal(cleanResult.recorded, true);
  assert.equal(cleanResult.state, "reviewed-clean");

  const detailClean = buildPmWorkItemDetail(settings, "PACE-201", { store });
  assert.equal(detailClean.review.verdict, "clean");
  assert.equal(detailClean.workItem.operationalGroup, "humanApproval");
});

test("3. Server-authoritative action & attempt approval gating and duplicate protection", () => {
  const store = makeTestStore();

  // A. Manual mode review: review action is pending approval
  const manualSettings = makeSettings(store, { operatingMode: "manual" });
  const manualReviewPlan = {
    issue: "PACE-300",
    summary: "Manual review task",
    role: "reviewer",
    type: "review",
    persona: "qa-engineer",
    taskAgent: "qa-engineer",
    configSnapshot: { operatingMode: "manual", taskAgent: "qa-engineer" }
  };
  const runId = store.createRun("PACE-300", manualReviewPlan);
  store.transition(runId, "review-queued", { implementationSha: "c".repeat(40) });

  const manualFp = computePlanFingerprint(manualReviewPlan);
  const action = determineItemAction(store.getRun(runId), manualSettings, store);
  assert.equal(action, "review", "Review run must resolve to action 'review'");

  // Approving 'implementation' on a manual review run must return 409 Conflict
  assert.throws(() => {
    handlePmApproval(manualSettings, "PACE-300", {
      action: "implementation",
      planFingerprint: manualFp,
      approver: "PM"
    }, { store });
  }, (err) => {
    return err.statusCode === 409 && err.message.includes("Action mismatch");
  });

  // Approving 'review' succeeds
  const appResult = handlePmApproval(manualSettings, "PACE-300", {
    action: "review",
    planFingerprint: manualFp,
    approver: "PM Lead"
  }, { store });

  assert.equal(appResult.ok, true);
  assert.equal(appResult.action, "review");

  // Duplicate / stale second approval must return 409 Conflict without writing a duplicate decision
  const decisionsBefore = store.getPmDecisions("PACE-300").length;
  assert.throws(() => {
    handlePmApproval(manualSettings, "PACE-300", {
      action: "review",
      planFingerprint: manualFp,
      approver: "PM Lead"
    }, { store });
  }, (err) => {
    return err.statusCode === 409 && err.message.includes("already approved");
  });
  const decisionsAfter = store.getPmDecisions("PACE-300").length;
  assert.equal(decisionsAfter, decisionsBefore, "Duplicate approval request must not write a duplicate decision");

  // Runtime review authorization succeeds
  const authReview = authorizeRuntimeAction(manualSettings, store, {
    issueKey: "PACE-300",
    action: "review",
    plan: manualReviewPlan,
    planFingerprint: manualFp
  });
  assert.equal(authReview.allowed, true);

  // Implementation is NOT authorized
  const authImpl = authorizeRuntimeAction(manualSettings, store, {
    issueKey: "PACE-300",
    action: "implementation",
    plan: manualReviewPlan,
    planFingerprint: manualFp
  });
  assert.equal(authImpl.allowed, false, "Approval of review must not authorize implementation");

  // B. Supervised mode review: review is autonomous -> PM approve returns 409 no approval pending
  const supervisedSettings = makeSettings(store, { operatingMode: "supervised" });
  const supervisedReviewPlan = {
    issue: "PACE-302",
    summary: "Supervised review task",
    role: "reviewer",
    type: "review",
    persona: "qa-engineer",
    taskAgent: "qa-engineer",
    configSnapshot: { operatingMode: "supervised", taskAgent: "qa-engineer" }
  };
  const supRunId = store.createRun("PACE-302", supervisedReviewPlan);
  store.transition(supRunId, "review-queued", { implementationSha: "d".repeat(40) });
  const supFp = computePlanFingerprint(supervisedReviewPlan);

  const supDecisionsBefore = store.getPmDecisions("PACE-302").length;
  assert.throws(() => {
    handlePmApproval(supervisedSettings, "PACE-302", {
      action: "review",
      planFingerprint: supFp,
      approver: "PM"
    }, { store });
  }, (err) => {
    return err.statusCode === 409 && err.message.includes("does not require approval");
  });
  const supDecisionsAfter = store.getPmDecisions("PACE-302").length;
  assert.equal(supDecisionsAfter, supDecisionsBefore, "No approval decision written for autonomous action");

  // C. Supervised implementation: duplicate approval protection
  const supervisedImplPlan = {
    issue: "PACE-303",
    summary: "Supervised implementation task",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    configSnapshot: { operatingMode: "supervised", taskAgent: "backend-engineer" }
  };
  store.createRun("PACE-303", supervisedImplPlan);
  const implFp = computePlanFingerprint(supervisedImplPlan);

  // First approval succeeds
  const firstImplApproval = handlePmApproval(supervisedSettings, "PACE-303", {
    action: "implementation",
    planFingerprint: implFp,
    approver: "PM Lead"
  }, { store });
  assert.equal(firstImplApproval.ok, true);

  // Second duplicate approval fails with 409
  assert.throws(() => {
    handlePmApproval(supervisedSettings, "PACE-303", {
      action: "implementation",
      planFingerprint: implFp,
      approver: "PM Lead"
    }, { store });
  }, (err) => {
    return err.statusCode === 409 && err.message.includes("already approved");
  });

  // D. Rework attempt isolation: attempt 1 approval must not approve attempt 2
  const reworkPlan = {
    issue: "PACE-301",
    summary: "Rework task attempt 2",
    role: "rework",
    attempt: 2,
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    configSnapshot: { operatingMode: "supervised", taskAgent: "backend-engineer" }
  };
  store.createRun("PACE-301", reworkPlan);
  const reworkFp = computePlanFingerprint(reworkPlan);

  // Attempting to approve attempt 1 on attempt 2 run throws 409
  assert.throws(() => {
    handlePmApproval(supervisedSettings, "PACE-301", {
      action: "rework",
      attempt: 1,
      planFingerprint: reworkFp,
      approver: "PM"
    }, { store });
  }, (err) => {
    return err.statusCode === 409 && err.message.includes("Attempt mismatch");
  });

  // Approving attempt 2 succeeds
  const reworkAppResult = handlePmApproval(supervisedSettings, "PACE-301", {
    action: "rework",
    attempt: 2,
    planFingerprint: reworkFp,
    approver: "PM"
  }, { store });
  assert.equal(reworkAppResult.ok, true);
  assert.equal(reworkAppResult.attempt, 2);

  // Store has approval for attempt 2, NOT attempt 1
  assert.ok(store.hasExecutionApproval("PACE-301", { action: "rework", attempt: 2, planFingerprint: reworkFp }));
  assert.equal(store.hasExecutionApproval("PACE-301", { action: "rework", attempt: 1, planFingerprint: reworkFp }), null);
});

test("4. PM mutations fail closed by default when controlPlane flags are absent", async () => {
  const store = makeTestStore();
  // Settings with NO controlPlane flags configured
  const settings = {
    source: "/tmp/pm-settings.json",
    projectKey: "PACE",
    _store: store,
    data: {
      project: { key: "PACE", operatingMode: "supervised" },
      policy: { operatingMode: "supervised" },
      controlPlane: {} // Both pmMutationEnabled and configMutationEnabled absent
    }
  };

  const plan = { issue: "PACE-400", summary: "Default closed task" };
  store.createRun("PACE-400", plan);
  const fp = computePlanFingerprint(plan);

  const server = createDashboardServer(settings, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const res = await request(server, "/api/pm/work-items/PACE-400/approve", {
      method: "POST",
      json: { action: "implementation", planFingerprint: fp }
    });
    assert.equal(res.status, 403, "Must fail closed with 403 when mutation flags are absent");
    assert.equal(res.json.error, "PM mutation is disabled");
  } finally {
    server.close();
  }
});

test("5. Provider-neutral source identity preservation from plan.workSource", () => {
  const store = makeTestStore();
  // Global settings default provider is Jira
  const settings = makeSettings(store);

  // Run was created from GitHub Issues with pinned workSource
  const plan = {
    issue: "123",
    summary: "Fix memory leak in stream parser",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    workSource: {
      provider: "github",
      id: "123",
      url: "https://github.com/houndvision/agent-scaffold/issues/123"
    }
  };

  store.createRun("123", plan);

  const detail = buildPmWorkItemDetail(settings, "123", { store });
  assert.ok(detail);
  assert.equal(detail.workItem.sourceProvider, "github", "Pinned sourceProvider must remain github");
  assert.equal(detail.workItem.sourceId, "123");
  assert.equal(detail.workItem.sourceUrl, "https://github.com/houndvision/agent-scaffold/issues/123");
});

test("6. Historical identity/state integrity: no fake v1 and no fabricated canonical states", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  // Create run without agentVersion and with blocked state
  const plan = {
    issue: "PACE-600",
    summary: "Historical task without version",
    persona: "backend-engineer",
    taskAgent: "legacy-agent"
    // agentVersion is missing
  };

  const runId = store.createRun("PACE-600", plan);
  store.transition(runId, "blocked", { reason: "Resource quota exhausted" });

  const detail = buildPmWorkItemDetail(settings, "PACE-600", { store });
  assert.ok(detail);
  assert.equal(detail.agentIdentity.agentVersion, null, "Missing historical agentVersion must be null, not 1");
  assert.equal(detail.workItem.canonicalState, "blocked", "Canonical state must reflect real blocked state, not ready");
  assert.equal(detail.workItem.status, "blocked");
});

test("7. Real provider-neutral discovery path lifecycle and Needs Planning transition", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  // Fake WorkSourceProvider returning a BACKLOG / discovered item
  class FakeWorkSourceProvider extends WorkSourceProvider {
    constructor(items) {
      super();
      this._items = items;
    }
    async listWorkItems(query) {
      return this._items;
    }
    async poll(query) {
      return this._items;
    }
  }

  const fakeWorkSource = new FakeWorkSourceProvider([
    {
      key: "PACE-901",
      id: "PACE-901",
      summary: "Add rate limiting middleware",
      canonicalState: "backlog",
      provider: "fake-provider",
      url: "https://worksources.internal/issues/PACE-901",
      labels: ["agent-ready"],
      priority: "High",
      reporter: "DevOps Lead"
    }
  ]);

  // 1. Run does not yet exist
  const existingRun = store.database.prepare("SELECT 1 FROM runs WHERE issue_key = ?").get("PACE-901");
  assert.equal(existingRun, undefined);

  // 2. Normal discovery path runs and records it durably
  const discoveryResult = await discoverWorkItems(settings, {
    store,
    workSource: fakeWorkSource
  });
  assert.equal(discoveryResult.ok, true);
  assert.equal(discoveryResult.recorded.length, 1);

  // 3. buildPmWorkspace() shows it in needsPlanning
  const wsBefore = buildPmWorkspace(settings, { store });
  assert.equal(wsBefore.counts.needsPlanning, 1, "Backlog item must appear in needsPlanning before a run exists");
  const pmItem = wsBefore.groups.needsPlanning.find(i => i.issueKey === "PACE-901");
  assert.ok(pmItem);
  assert.equal(pmItem.operationalGroup, "needsPlanning");
  assert.equal(pmItem.currentRunState, "unplanned");
  assert.equal(pmItem.summary, "Add rate limiting middleware");
  assert.equal(pmItem.sourceProvider, "fake-provider");
  assert.equal(pmItem.sourceUrl, "https://worksources.internal/issues/PACE-901");

  // Read detail model
  const detail = buildPmWorkItemDetail(settings, "PACE-901", { store });
  assert.ok(detail);
  assert.equal(detail.workItem.key, "PACE-901");
  assert.equal(detail.workItem.operationalGroup, "needsPlanning");
  assert.equal(detail.history[0].stage, "discovered");

  // 4. Later an orchestrator plan and run are created for PACE-901
  const runPlan = {
    issue: "PACE-901",
    summary: "Add rate limiting middleware",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    allowedPaths: ["backend/**"],
    workSource: {
      provider: "fake-provider",
      id: "PACE-901",
      url: "https://worksources.internal/issues/PACE-901"
    }
  };
  const runId = store.createRun("PACE-901", runPlan);
  store.transition(runId, "eligible", {});

  // 5. buildPmWorkspace() is called again -> PACE-901 is NO LONGER in needsPlanning!
  const wsAfter = buildPmWorkspace(settings, { store });
  assert.equal(wsAfter.counts.needsPlanning, 0, "Item must disappear from needsPlanning once an active run exists");
  const plannedItem = wsAfter.items.find(i => i.issueKey === "PACE-901");
  assert.ok(plannedItem);
  assert.notEqual(plannedItem.operationalGroup, "needsPlanning");
});

test("8. Security Gates: loopback check, content-type 415, human-only actions blocked", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store, {
    controlPlane: { pmMutationEnabled: true }
  });

  const plan = { issue: "PACE-800", summary: "Security test task" };
  store.createRun("PACE-800", plan);
  const fp = computePlanFingerprint(plan);

  const server = createDashboardServer(settings, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    // Non-loopback request -> 403
    const nonLoopback = await request(server, "/api/pm/work-items/PACE-800/approve", {
      method: "POST",
      headers: { host: "192.168.1.50:8000" },
      json: { action: "implementation", planFingerprint: fp }
    });
    assert.equal(nonLoopback.status, 403);

    // Non-JSON Content-Type -> 415
    const textPlain = await request(server, "/api/pm/work-items/PACE-800/approve", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "action=implementation"
    });
    assert.equal(textPlain.status, 415);

    // Human-only action cannot be approved via PM workspace
    assert.throws(() => {
      handlePmApproval(settings, "PACE-800", {
        action: "finalMerge",
        planFingerprint: fp
      }, { store });
    }, (err) => err.message.includes("human-only"));

  } finally {
    server.close();
  }
});
