/**
 * test/phase-e-pm-workspace.test.js
 *
 * Dedicated Phase E Test Suite — PM Workspace:
 * - Work Queue / Inbox aggregation across 8 canonical operational states
 * - Decision Trace unified read model (orchestrator rationale, execution, review findings, pinned agent identity, history)
 * - Lossless structured review findings lifecycle & multiple rework attempts
 * - Durable approval & rejection mutations with plan fingerprint gating and 409 conflict detection
 * - Historical snapshot immutability (config & agent registry v1 -> v2 isolation)
 * - Blocked workspace diagnostics (scope violations, disabled agents, rework limits)
 * - HTTP endpoint security (loopback check, content-type check, mutation flag, no-Done bypass)
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
  classifyOperationalGroup
} from "../lib/pm-workspace.js";
import { computePlanFingerprint, authorizeRuntimeAction } from "../lib/policy.js";
import { recordReviewerOutcome } from "../lib/reconciler.js";

function makeTestStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-ws-test-"));
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

test("PM Workspace Aggregation: groups items into 8 operational states correctly", () => {
  const store = makeTestStore();
  const settings = makeSettings(store, { operatingMode: "supervised" });

  // 1. Awaiting Approval item
  const plan1 = {
    issue: "PACE-101",
    summary: "Auth guard",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    agentId: "backend-engineer",
    agentVersion: 1,
    execution: { provider: "codex", model: "gpt-5" },
    allowedPaths: ["backend/**"],
    risk: "high",
    configSnapshot: {
      operatingMode: "supervised",
      taskAgent: "backend-engineer",
      agentVersion: 1,
      executorProvider: "codex",
      executorModel: "gpt-5"
    }
  };
  const run1Id = store.createRun("PACE-101", plan1);
  store.transition(run1Id, "discovered", plan1);

  // 2. Blocked item (failed-scope)
  const plan2 = {
    issue: "PACE-102",
    summary: "Data pipeline",
    persona: "data-engineer",
    taskAgent: "data-engineer",
    configSnapshot: { operatingMode: "autonomous" }
  };
  const run2Id = store.createRun("PACE-102", plan2);
  store.transition(run2Id, "failed-scope", {
    reason: "Changed files outside allowed scope: frontend/src/app.ts",
    scope: { violations: ["frontend/src/app.ts"] }
  });

  // 3. Executing item
  const plan3 = {
    issue: "PACE-103",
    summary: "Frontend camera grid",
    persona: "frontend-engineer",
    taskAgent: "frontend-engineer",
    configSnapshot: { operatingMode: "autonomous" }
  };
  const run3Id = store.createRun("PACE-103", plan3);
  store.transition(run3Id, "executing", { provider: "antigravity", model: "claude-3-5-sonnet", pid: 4501 });

  // 4. In Review item
  const plan4 = {
    issue: "PACE-104",
    summary: "Review queued task",
    persona: "backend-engineer",
    taskAgent: "backend-engineer"
  };
  const run4Id = store.createRun("PACE-104", plan4);
  store.transition(run4Id, "review-queued", { implementationSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

  // 5. Needs Rework item
  const plan5 = {
    issue: "PACE-105",
    summary: "Rework task",
    persona: "backend-engineer",
    taskAgent: "backend-engineer"
  };
  const run5Id = store.createRun("PACE-105", plan5);
  store.transition(run5Id, "review-failed", {
    verdict: "changes-requested",
    evidence: [{ id: "F-1", severity: "high", category: "correctness", problem: "Null pointer error" }]
  });

  // 6. Human Approval item (Clean review)
  const plan6 = {
    issue: "PACE-106",
    summary: "Completed feature ready for human merge",
    persona: "backend-engineer",
    taskAgent: "backend-engineer"
  };
  const run6Id = store.createRun("PACE-106", plan6);
  store.transition(run6Id, "reviewed-clean", { verdict: "clean", evidence: [{ id: "F-CLEAN", severity: "info", category: "correctness", problem: "Clean review" }] });

  const ws = buildPmWorkspace(settings, { store });

  assert.equal(ws.ok, true);
  assert.equal(ws.counts.awaitingApproval, 1, "PACE-101 must appear in awaitingApproval");
  assert.equal(ws.counts.blocked, 1, "PACE-102 must appear in blocked");
  assert.equal(ws.counts.executing, 1, "PACE-103 must appear in executing");
  assert.equal(ws.counts.inReview, 1, "PACE-104 must appear in inReview");
  assert.equal(ws.counts.needsRework, 1, "PACE-105 must appear in needsRework");
  assert.equal(ws.counts.humanApproval, 1, "PACE-106 must appear in humanApproval");

  // Verify Human Approval is never classified as ready worker work
  assert.equal(ws.groups.ready.some(i => i.issueKey === "PACE-106"), false, "Human Approval item must never appear as ready worker work");
});

test("Detail Read Model: returns pinned agent version/hash, executor, orchestrator rationale, lossless findings, and timeline", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  const plan = {
    issue: "PACE-201",
    summary: "Tenant authorization guards",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    agentId: "backend-engineer",
    agentVersion: 1,
    agentHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    skills: ["api-design", "backend-testing"],
    capabilities: ["edit-code", "run-tests"],
    risk: "high",
    parallelSafe: false,
    dependencies: ["PACE-100"],
    allowedPaths: ["backend/**"],
    rationale: ["Backend security domain requires specialized BE agent with test isolation."],
    metadata: { domain: "security", priority: "urgent" },
    configSnapshot: {
      operatingMode: "supervised",
      taskAgent: "backend-engineer",
      agentVersion: 1,
      agentHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      executorProvider: "codex",
      executorModel: "gpt-5",
      executorModelProfile: "high",
      executorEffort: "high",
      allowedPaths: ["backend/**"],
      risk: "high",
      rationale: ["Backend security domain requires specialized BE agent with test isolation."]
    }
  };

  const runId = store.createRun("PACE-201", plan);
  store.transition(runId, "prepared", { branch: "pace-201-auth", worktree: "/tmp/worktrees/pace-201" });
  store.transition(runId, "executing", { provider: "codex", model: "gpt-5", pid: 9122, usage: { total_tokens: 15400 } });
  store.transition(runId, "verifying", { implementationSha: "1111111111111111111111111111111111111111" });

  // Add review findings
  const findings = [
    {
      id: "SEC-01",
      severity: "high",
      category: "security",
      file: "backend/auth.py",
      line: 42,
      problem: "Tenant ID missing from query filter",
      expected: "WHERE tenant_id = :tenant_id",
      verification: "pytest backend/tests/test_auth.py"
    },
    {
      id: "PERF-02",
      severity: "medium",
      category: "performance",
      file: "backend/auth.py",
      line: 110,
      problem: "Unindexed query on user_roles",
      expected: "Add index on (tenant_id, user_id)",
      verification: "explain analyze query"
    }
  ];

  store.transition(runId, "review-failed", {
    verdict: "changes-requested",
    reviewerId: "security-reviewer",
    implementationSha: "1111111111111111111111111111111111111111",
    evidence: findings
  });

  // PM Decision record
  store.addPmDecision("PACE-201", "execution_approval", {
    action: "implementation",
    approved: true,
    approver: "Arif PM",
    planFingerprint: computePlanFingerprint(plan),
    reason: "Approved security changes"
  });

  const detail = buildPmWorkItemDetail(settings, "PACE-201", { store });

  assert.ok(detail, "Detail read model must exist");
  assert.equal(detail.workItem.key, "PACE-201");
  assert.equal(detail.workItem.sourceUrl, "https://pacebuild.atlassian.net/browse/PACE-201");

  // Orchestrator decision
  assert.equal(detail.orchestratorDecision.persona, "backend-engineer");
  assert.equal(detail.orchestratorDecision.risk, "high");
  assert.deepEqual(detail.orchestratorDecision.allowedPaths, ["backend/**"]);
  assert.ok(detail.orchestratorDecision.rationale.length > 0);

  // Agent identity pinning
  assert.equal(detail.agentIdentity.agentId, "backend-engineer");
  assert.equal(detail.agentIdentity.agentVersion, 1);
  assert.equal(detail.agentIdentity.agentHash, "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
  assert.equal(detail.agentIdentity.liveRegistryStatus, "enabled");

  // Lossless review findings preservation
  assert.equal(detail.review.verdict, "changes-requested");
  assert.equal(detail.review.structuredFindings.length, 2);
  assert.equal(detail.review.structuredFindings[0].id, "SEC-01");
  assert.equal(detail.review.structuredFindings[0].severity, "high");
  assert.equal(detail.review.structuredFindings[0].category, "security");
  assert.equal(detail.review.structuredFindings[0].file, "backend/auth.py");
  assert.equal(detail.review.structuredFindings[0].line, 42);
  assert.equal(detail.review.structuredFindings[0].problem, "Tenant ID missing from query filter");
  assert.equal(detail.review.structuredFindings[0].expected, "WHERE tenant_id = :tenant_id");
  assert.equal(detail.review.structuredFindings[0].verification, "pytest backend/tests/test_auth.py");

  // Chronological timeline with actor attribution
  assert.ok(detail.history.length >= 4);
  const humanEvent = detail.history.find(e => e.actor.type === "human");
  assert.ok(humanEvent, "Timeline must contain human actor PM decision");
  assert.equal(humanEvent.actor.id, "Arif PM");
});

test("Approval Mutations: correct plan fingerprint succeeds, stale fingerprint returns 409 conflict", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store, { operatingMode: "supervised" });

  const plan = {
    issue: "PACE-301",
    summary: "Database migration script",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    agentId: "backend-engineer",
    agentVersion: 1,
    allowedPaths: ["backend/**"],
    risk: "high",
    configSnapshot: {
      operatingMode: "supervised",
      taskAgent: "backend-engineer",
      agentVersion: 1
    }
  };
  store.createRun("PACE-301", plan);
  const correctFingerprint = computePlanFingerprint(plan);

  // 1. Stale / Mismatched Fingerprint must throw 409 conflict
  assert.throws(() => {
    handlePmApproval(settings, "PACE-301", {
      action: "implementation",
      planFingerprint: "stale-fingerprint-99999999999999999999999999999999",
      approver: "PM Operator"
    }, { store });
  }, (err) => {
    return err.statusCode === 409 && err.message.includes("mismatch");
  });

  // 2. Correct Fingerprint succeeds
  const result = handlePmApproval(settings, "PACE-301", {
    action: "implementation",
    planFingerprint: correctFingerprint,
    approver: "PM Operator",
    reason: "Approved migration scope"
  }, { store });

  assert.equal(result.ok, true);
  assert.equal(result.approved, true);
  assert.equal(result.planFingerprint, correctFingerprint);

  // Verify durable storage
  const hasApproval = store.hasExecutionApproval("PACE-301", {
    action: "implementation",
    planFingerprint: correctFingerprint
  });
  assert.ok(hasApproval, "Approval must be durably recorded in store");
  assert.equal(hasApproval.approved, true);
  assert.equal(hasApproval.approver, "PM Operator");
});

test("Approval Mutations: rejection is persisted and audited", () => {
  const store = makeTestStore();
  const settings = makeSettings(store, { operatingMode: "supervised" });

  const plan = {
    issue: "PACE-302",
    summary: "Experimental refactoring",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    allowedPaths: ["backend/**", "lib/**"],
    risk: "high"
  };
  store.createRun("PACE-302", plan);
  const fingerprint = computePlanFingerprint(plan);

  const rejectResult = handlePmRejection(settings, "PACE-302", {
    action: "implementation",
    planFingerprint: fingerprint,
    approver: "Lead Architect",
    reason: "Scope touches protected lib directory"
  }, { store });

  assert.equal(rejectResult.ok, true);
  assert.equal(rejectResult.approved, false);
  assert.equal(rejectResult.reason, "Scope touches protected lib directory");

  const recorded = store.hasExecutionApproval("PACE-302", {
    action: "implementation",
    planFingerprint: fingerprint
  });
  assert.ok(recorded);
  assert.equal(recorded.approved, false);
  assert.equal(recorded.reason, "Scope touches protected lib directory");
});

test("Action-scoped approval isolation: implementation approval does not authorize rework", () => {
  const store = makeTestStore();
  const settings = makeSettings(store, { operatingMode: "supervised" });

  const plan = {
    issue: "PACE-303",
    summary: "API Endpoint",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    allowedPaths: ["backend/**"]
  };
  store.createRun("PACE-303", plan);
  const fingerprint = computePlanFingerprint(plan);

  handlePmApproval(settings, "PACE-303", {
    action: "implementation",
    planFingerprint: fingerprint,
    approver: "PM Operator"
  }, { store });

  // Implementation is approved
  const implAuth = authorizeRuntimeAction(settings, store, {
    issueKey: "PACE-303",
    action: "implementation",
    plan,
    planFingerprint: fingerprint
  });
  assert.equal(implAuth.allowed, true);

  // Rework is NOT approved by implementation approval
  const reworkAuth = authorizeRuntimeAction(settings, store, {
    issueKey: "PACE-303",
    action: "rework",
    plan,
    planFingerprint: fingerprint,
    attempt: 1
  });
  assert.equal(reworkAuth.allowed, false, "Rework action must require separate approval");
});

test("Historical Snapshots: global config & agent registry updates (v1 -> v2) do not alter historical PM detail", () => {
  const store = makeTestStore();
  const settings = makeSettings(store, { operatingMode: "autonomous" });

  // Create a run locked with v1 agent definition
  const plan = {
    issue: "PACE-401",
    summary: "Historic backend run",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    agentId: "backend-engineer",
    agentVersion: 1,
    agentHash: "v1hash1111111111111111111111111111111111111111111111111111111111",
    configSnapshot: {
      operatingMode: "autonomous",
      taskAgent: "backend-engineer",
      agentId: "backend-engineer",
      agentVersion: 1,
      agentHash: "v1hash1111111111111111111111111111111111111111111111111111111111",
      executorProvider: "codex",
      executorModel: "gpt-5",
      allowedPaths: ["backend/**"],
      risk: "normal"
    }
  };
  const runId = store.createRun("PACE-401", plan);
  store.transition(runId, "executing", { provider: "codex", model: "gpt-5" });

  // Update Agent Definition in Registry to v2
  store.updateAgentDefinition("backend-engineer", {
    displayName: "Backend Engineer v2 Enhanced",
    defaultPersona: "backend-specialist",
    skills: ["api-design", "performance-profiling"],
    allowedPaths: ["backend/**", "services/**"]
  });

  const updatedDef = store.getAgentDefinition("backend-engineer");
  assert.equal(updatedDef.currentVersion, 2);

  // Read PM Detail for historical run
  const detail = buildPmWorkItemDetail(settings, "PACE-401", { store });

  assert.equal(detail.agentIdentity.agentVersion, 1, "Historical run must retain pinned version 1");
  assert.equal(detail.agentIdentity.agentHash, "v1hash1111111111111111111111111111111111111111111111111111111111");
  assert.equal(detail.agentIdentity.liveRegistryVersion, 2, "Live registry status must reflect current version 2");
  assert.equal(detail.agentIdentity.isPinnedVersionCurrent, false);
});

test("Blocked Workspace: exact durable reasons for scope violation, disabled agent, and exhausted rework", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  // 1. Scope violation
  const r1 = store.createRun("PACE-501", { issue: "PACE-501", summary: "Scope leak" });
  store.transition(r1, "failed-scope", { reason: "Changed files outside allowed backend/** scope" });

  // 2. Disabled agent
  const r2 = store.createRun("PACE-502", { issue: "PACE-502", summary: "Disabled agent work" });
  store.transition(r2, "blocked", { reason: "Assigned agent 'legacy-worker' is currently disabled in the registry" });

  // 3. Exhausted rework
  const r3 = store.createRun("PACE-503", { issue: "PACE-503", summary: "Rework loop" });
  store.transition(r3, "blocked", { reason: "Agent rework limit exhausted (3/3 attempts). Human attention required." });

  const ws = buildPmWorkspace(settings, { store });

  const blockedItems = ws.groups.blocked;
  assert.equal(blockedItems.length, 3);

  const item1 = blockedItems.find(i => i.issueKey === "PACE-501");
  assert.ok(item1.blockedReason.includes("backend/**"));

  const item2 = blockedItems.find(i => i.issueKey === "PACE-502");
  assert.ok(item2.blockedReason.includes("legacy-worker"));

  const item3 = blockedItems.find(i => i.issueKey === "PACE-503");
  assert.ok(item3.blockedReason.includes("rework limit exhausted"));
});

test("HTTP Server Endpoints: GET /api/pm/workspace, GET /api/pm/work-items/:key, POST approve/reject", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store, { operatingMode: "supervised" });

  const plan = {
    issue: "PACE-601",
    summary: "Payment integration",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    allowedPaths: ["backend/**"],
    configSnapshot: {
      operatingMode: "supervised",
      taskAgent: "backend-engineer"
    }
  };
  store.createRun("PACE-601", plan);
  const fingerprint = computePlanFingerprint(plan);

  const server = createDashboardServer(settings, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    // 1. GET /api/pm/workspace
    const wsRes = await request(server, "/api/pm/workspace");
    assert.equal(wsRes.status, 200);
    assert.equal(wsRes.json.ok, true);
    assert.ok(wsRes.json.counts);
    assert.ok(wsRes.json.groups);

    // 2. GET /api/pm/work-items/:key
    const detailRes = await request(server, "/api/pm/work-items/PACE-601");
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.json.workItem.key, "PACE-601");
    assert.equal(detailRes.json.orchestratorDecision.persona, "backend-engineer");

    // 3. POST approve with stale fingerprint -> 409 Conflict
    const staleRes = await request(server, "/api/pm/work-items/PACE-601/approve", {
      method: "POST",
      json: { action: "implementation", planFingerprint: "stale-fp-000000000000000000000000" }
    });
    assert.equal(staleRes.status, 409, "Stale fingerprint must return 409 Conflict");
    assert.equal(staleRes.json.expected, fingerprint);

    // 4. POST approve with correct fingerprint -> 200 OK
    const approveRes = await request(server, "/api/pm/work-items/PACE-601/approve", {
      method: "POST",
      json: { action: "implementation", planFingerprint: fingerprint, approver: "QA Lead" }
    });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.json.approved, true);

    // 5. POST reject on another item -> 200 OK
    const plan2 = { issue: "PACE-602", summary: "Risky feature", persona: "backend-engineer" };
    store.createRun("PACE-602", plan2);
    const fp2 = computePlanFingerprint(plan2);

    const rejectRes = await request(server, "/api/pm/work-items/PACE-602/reject", {
      method: "POST",
      json: { action: "implementation", planFingerprint: fp2, approver: "PM Lead", reason: "Scope rejection" }
    });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.json.approved, false);

  } finally {
    server.close();
  }
});

test("Security Gates: rejects non-loopback mutation, disabled flag, invalid JSON/content-type, no Done bypass", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store, {
    controlPlane: { pmMutationEnabled: false }
  });

  const plan = { issue: "PACE-701", summary: "Secure task" };
  store.createRun("PACE-701", plan);
  const fingerprint = computePlanFingerprint(plan);

  const server = createDashboardServer(settings, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    // 1. Disabled PM Mutation flag -> 403 Forbidden
    const disabledRes = await request(server, "/api/pm/work-items/PACE-701/approve", {
      method: "POST",
      json: { action: "implementation", planFingerprint: fingerprint }
    });
    assert.equal(disabledRes.status, 403, "Disabled mutation flag must return 403");

    // 2. Non-loopback request header -> 403
    const externalHostRes = await request(server, "/api/pm/work-items/PACE-701/approve", {
      method: "POST",
      headers: { host: "192.168.1.100:4317", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "implementation", planFingerprint: fingerprint })
    });
    assert.equal(externalHostRes.status, 403, "Non-loopback host must return 403");

    // 3. Invalid content-type (e.g. text/plain) -> 415
    const textPlainRes = await request(server, "/api/pm/work-items/PACE-701/approve", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "implementation", planFingerprint: fingerprint })
    });
    assert.equal(textPlainRes.status, 415, "Non-JSON content type must return 415");

    // 4. Human-only action (e.g. markDone, finalMerge) cannot be approved through PM execution gate
    assert.throws(() => {
      handlePmApproval(settings, "PACE-701", {
        action: "markDone",
        planFingerprint: fingerprint
      }, { store });
    }, (err) => err.message.includes("human-only"));

  } finally {
    server.close();
  }
});
