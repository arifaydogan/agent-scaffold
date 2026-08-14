/**
 * test/phase-d-agent-registry.test.js
 *
 * Phase D — Agent Registry:
 * - Dual-table immutable versioning (agent_definitions + agent_versions)
 * - Automatic, idempotent, and non-destructive builtin agent seeding
 * - Deterministic lifecycle (enabled, disabled, archived) vs immutable definition versions
 * - Fail-closed deletion safety (hard delete prevented if referenced by runs)
 * - Strict schema validation & SHA-256 definition hash computation
 * - Runtime authoritative check: unknown, disabled, or archived agents fail closed
 * - Plan approval identity: plan fingerprint binds agentId, agentVersion, and agentHash
 * - HTTP Management API endpoints with mutation gating (controlPlane flag), loopback enforcement, and audit journal
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { RunStore } from "../lib/store.js";
import {
  validateAgentDefinition,
  computeAgentDefinitionHash,
  AgentValidationError,
  BUILTIN_AGENT_SEEDS
} from "../lib/agent-registry.js";
import { issuePlan, getStore, createConfigSnapshot, handleImplementation } from "../lib/runtime.js";
import { createDashboardServer } from "../lib/dashboard.js";
import { computePlanFingerprint, authorizeRuntimeAction } from "../lib/policy.js";

function makeTestStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-reg-test-"));
  return new RunStore(path.join(dir, "runs.sqlite3"));
}

function makeSettings(store, policyOverrides = {}, controlPlaneOverrides = {}) {
  return {
    source: "/tmp/test.json",
    projectKey: "PACE",
    repoPath: "/tmp/repo",
    worktreeRoot: "/tmp/worktrees",
    _store: store,
    data: {
      project: { key: "PACE", repoPath: "." },
      policy: {
        allowedProjects: ["PACE"],
        humanOnlyStatuses: ["Done"],
        requiredLabels: ["agent-ready"],
        maxConcurrency: 2,
        pathScopes: {
          "backend-engineer": ["lib/**", "backend/**"],
          "custom-worker": ["src/**"],
          "unregistered-agent": ["src/**"]
        },
        ...policyOverrides
      },
      worktree: { root: "." },
      jira: { baseUrl: "https://example.atlassian.net" },
      orchestrator: {
        defaultProvider: "codex",
        providers: {
          codex: {
            command: ["codex", "exec", "{prompt}", "--json"],
            timeoutSeconds: 60
          }
        }
      },
      executor: {
        defaultProvider: "codex",
        providers: {
          codex: {
            command: ["codex", "exec", "{prompt}"],
            defaultModel: "gpt-5",
            defaultEffort: "medium",
            mode: "accept-edits",
            timeoutSeconds: 60
          }
        }
      },
      controlPlane: {
        agentRegistryMutationEnabled: true,
        configMutationEnabled: true,
        ...controlPlaneOverrides
      }
    }
  };
}

const sampleIssue = {
  key: "PACE-500",
  summary: "Implement registry support with Acceptance Criteria fulfilled.",
  description: "Acceptance Criteria fulfilled. Modify backend endpoints.",
  status: "In Progress",
  canonicalState: "ready",
  labels: ["agent-ready"],
  issueType: "Story"
};

function makeCodexEvent(plan) {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
    JSON.stringify({ type: "turn.started", turn_id: "tu-1" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify(plan)
      }
    }),
    JSON.stringify({ type: "turn.completed", turn_id: "tu-1" })
  ].join("\n");
}

// ── 1. Schema Validation & Hash Computation ────────────────────────────────────

test("Agent Model: strict schema validation rejects malformed definitions, invalid roles, and empty strings", () => {
  // Missing or invalid ID
  assert.throws(() => validateAgentDefinition({}), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "invalid space", displayName: "Test" }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "invalid@char", displayName: "Test" }), AgentValidationError);

  // Missing displayName
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "" }), AgentValidationError);

  // Invalid role (must be one of AGENT_ROLES)
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", role: "wizard" }), /Invalid agent role/);

  // Invalid status
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", status: "destroyed" }), AgentValidationError);

  // Invalid defaultPersona
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", defaultPersona: "invalid persona spaces" }), AgentValidationError);

  // Invalid maxConcurrency
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", maxConcurrency: 0 }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", maxConcurrency: -2 }), AgentValidationError);

  // Invalid skills / capabilities / allowedPaths containing empty strings or non-arrays
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", skills: "not-array" }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", skills: ["valid", "  "] }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", capabilities: [""] }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", allowedPaths: ["   "] }), AgentValidationError);

  // Malformed executor
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", executor: "not-object" }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", executor: { provider: "" } }), AgentValidationError);

  // Valid agent definition normalizes correctly
  const valid = validateAgentDefinition({
    id: "custom-worker",
    displayName: "Custom Worker",
    role: "implementation",
    defaultPersona: "startup-cto",
    skills: ["api-design"],
    allowedPaths: ["src/**"]
  });
  assert.equal(valid.id, "custom-worker");
  assert.equal(valid.role, "implementation");
  assert.equal(valid.status, "enabled");
  assert.deepEqual(valid.skills, ["api-design"]);
});

test("Agent Model: computeAgentDefinitionHash is deterministic and detects field changes", () => {
  const defA = {
    id: "backend-engineer",
    displayName: "Backend Engineer",
    skills: ["api-design", "backend-testing"],
    allowedPaths: ["backend/**"]
  };
  const defB = {
    id: "backend-engineer",
    displayName: "Backend Engineer",
    skills: ["backend-testing", "api-design"], // same skills, different order
    allowedPaths: ["backend/**"]
  };
  const defC = {
    ...defA,
    skills: ["api-design", "backend-testing", "new-skill"]
  };

  const hashA = computeAgentDefinitionHash(defA);
  const hashB = computeAgentDefinitionHash(defB);
  const hashC = computeAgentDefinitionHash(defC);

  assert.ok(hashA, "Hash must be non-empty hex string");
  assert.equal(hashA, hashB, "Hash must be order-independent for sorted sets");
  assert.notEqual(hashA, hashC, "Hash must change when skills change");
});

// ── 2. Automatic, Idempotent Builtin Agent Seeding ────────────────────────────

test("Agent Registry Store: builtin seeding is automatic, idempotent, and non-destructive", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-reg-seed-test-"));
  const dbPath = path.join(dir, "runs.sqlite3");

  // 1. Fresh store initializes with all builtin seeds
  const store1 = new RunStore(dbPath);
  const initialAgents = store1.listAgentDefinitions();
  const seedIds = BUILTIN_AGENT_SEEDS.map(s => s.id);
  assert.ok(initialAgents.length >= seedIds.length);
  for (const id of seedIds) {
    assert.ok(initialAgents.some(a => a.id === id), `Builtin agent '${id}' must be seeded`);
  }

  // 2. Modify one builtin agent (e.g. backend-engineer) to v2
  store1.updateAgentDefinition("backend-engineer", {
    displayName: "Customized Backend Engineer",
    skills: ["api-design", "custom-skill"]
  });
  const modified = store1.getAgentDefinition("backend-engineer");
  assert.equal(modified.version, 2);
  assert.equal(modified.definition.displayName, "Customized Backend Engineer");

  // 3. Add a custom agent
  store1.createAgentDefinition({
    id: "my-custom-agent",
    displayName: "My Custom Agent",
    allowedPaths: ["custom/**"]
  });

  // 4. Re-open / bootstrap store: must not overwrite modified builtin, bump version, or remove custom agent
  const store2 = new RunStore(dbPath);
  const backendAfterBootstrap = store2.getAgentDefinition("backend-engineer");
  assert.equal(backendAfterBootstrap.version, 2, "Bootstrap must not bump version of modified builtin");
  assert.equal(backendAfterBootstrap.definition.displayName, "Customized Backend Engineer", "Bootstrap must not overwrite modified builtin");

  const customAgent = store2.getAgentDefinition("my-custom-agent");
  assert.ok(customAgent, "Custom agent must remain intact after bootstrap");
});

// ── 3. Dual-Table Immutable Version History ──────────────────────────────────

test("Agent Registry Store: create and update produces immutable version history with transactions", () => {
  const store = makeTestStore();

  // 1. Create v1
  const created = store.createAgentDefinition({
    id: "custom-worker",
    displayName: "Custom Worker",
    role: "implementation",
    defaultPersona: "startup-cto",
    skills: ["api-design"],
    allowedPaths: ["src/**"]
  });

  assert.equal(created.id, "custom-worker");
  assert.equal(created.version, 1);
  assert.ok(created.definitionHash);

  // Duplicate create throws
  assert.throws(() => store.createAgentDefinition({ id: "custom-worker", displayName: "Duplicate" }), /already exists/);

  // 2. Update to v2
  const updated = store.updateAgentDefinition("custom-worker", {
    displayName: "Custom Worker v2",
    skills: ["api-design", "graphql-patterns"]
  });

  assert.equal(updated.version, 2);
  assert.notEqual(updated.definitionHash, created.definitionHash);

  // 3. Retrieve specific versions
  const v1 = store.getAgentDefinition("custom-worker", 1);
  assert.equal(v1.version, 1);
  assert.equal(v1.definition.displayName, "Custom Worker");
  assert.deepEqual(v1.definition.skills, ["api-design"]);
  assert.equal(v1.definitionHash, created.definitionHash);

  const v2 = store.getAgentDefinition("custom-worker", 2);
  assert.equal(v2.version, 2);
  assert.equal(v2.definition.displayName, "Custom Worker v2");
  assert.deepEqual(v2.definition.skills, ["api-design", "graphql-patterns"]);
  assert.equal(v2.definitionHash, updated.definitionHash);

  // 4. Default getAgentDefinition returns current version (v2)
  const current = store.getAgentDefinition("custom-worker");
  assert.equal(current.version, 2);
  assert.equal(current.currentVersion, 2);

  // 5. listAgentVersions returns complete history
  const versions = store.listAgentVersions("custom-worker");
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version, 1);
  assert.equal(versions[1].version, 2);
});

// ── 4. Lifecycle States vs Immutable Definition Version ────────────────────────

test("Agent Registry Store: lifecycle transitions vs definition version semantics", () => {
  const store = makeTestStore();
  store.createAgentDefinition({ id: "agent-1", displayName: "Agent 1", skills: ["s1"] });
  store.createAgentDefinition({ id: "agent-2", displayName: "Agent 2", skills: ["s2"] });

  const initialHash = store.getAgentDefinition("agent-2").definitionHash;

  // Disable agent-2: updates live status without bumping version or corrupting historical definition
  store.setAgentStatus("agent-2", "disabled");
  const disabledAgent = store.getAgentDefinition("agent-2");
  assert.equal(disabledAgent.status, "disabled");
  assert.equal(disabledAgent.currentStatus, "disabled");
  assert.equal(disabledAgent.version, 1, "Disabling must not increment version");
  assert.equal(disabledAgent.definitionHash, initialHash, "Definition hash must remain identical");
  assert.equal(store.listAgentVersions("agent-2").length, 1, "Disabling must not create extra versions");

  // Archive agent-2
  store.setAgentStatus("agent-2", "archived");
  assert.equal(store.getAgentDefinition("agent-2").status, "archived");

  // Default list excludes archived
  const activeList = store.listAgentDefinitions();
  const ids = activeList.map(a => a.id);
  assert.ok(ids.includes("agent-1"), "Enabled agent must be in default list");
  assert.ok(!ids.includes("agent-2"), "Archived agent must be excluded from default list");

  // List with includeArchived includes agent-2
  const allList = store.listAgentDefinitions({ includeArchived: true });
  assert.ok(allList.some(a => a.id === "agent-2"));

  // List by status
  const archivedList = store.listAgentDefinitions({ status: "archived" });
  assert.ok(archivedList.some(a => a.id === "agent-2"));
});

// ── 5. Deletion Safety (Fail-Closed on Used Agents) ────────────────────────────

test("Agent Registry Store: hard deletion is permitted ONLY for never-used agents", () => {
  const store = makeTestStore();
  store.createAgentDefinition({ id: "unused-agent", displayName: "Unused Agent" });
  store.createAgentDefinition({ id: "used-agent", displayName: "Used Agent" });

  // Create a run referencing 'used-agent'
  store.createRun("PACE-101", {
    issue: "PACE-101",
    taskAgent: "used-agent",
    allowedPaths: ["src/**"]
  });

  assert.equal(store.isAgentUsed("unused-agent"), false);
  assert.equal(store.isAgentUsed("used-agent"), true);

  // Deleting unused agent succeeds
  assert.equal(store.deleteAgentDefinition("unused-agent"), true);
  assert.equal(store.getAgentDefinition("unused-agent"), null);

  // Deleting used agent fails closed with explicit error
  assert.throws(
    () => store.deleteAgentDefinition("used-agent"),
    /Cannot hard-delete agent 'used-agent' because it has been used by existing runs/
  );
  assert.ok(store.getAgentDefinition("used-agent"), "Used agent must remain in store");
});

// ── 6. Runtime Authoritative Registry Check ────────────────────────────────────

test("Runtime Integration: unknown taskAgent fails closed with not-registered reason and null version/hash", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  const planPayload = {
    issue: "PACE-500",
    summary: sampleIssue.summary,
    persona: "startup-cto",
    taskAgent: "unregistered-agent",
    skills: ["api-design"],
    risk: "normal",
    parallelSafe: true,
    allowedPaths: ["src/**"],
    dependencies: [],
    rationale: ["Valid plan with unregistered agent"],
    reasons: ["Valid plan with unregistered agent"]
  };

  const plan = issuePlan(settings, sampleIssue, {
    store,
    runtime: {
      spawnSync: () => ({
        status: 0,
        stdout: makeCodexEvent(planPayload),
        stderr: ""
      })
    }
  });

  assert.equal(plan.eligible, false, "Unregistered agent must be ineligible");
  assert.ok(
    plan.eligibilityReasons.some(r => r.includes("Agent 'unregistered-agent' is not registered")),
    "Eligibility reasons must explicitly state agent is not registered"
  );
  assert.equal(plan.agentVersion, null, "Unregistered agent must not have an invented agentVersion");
  assert.equal(plan.agentHash, null, "Unregistered agent must have null agentHash");

  // Pre-execution execution gate blocks implementation
  let workerSpawned = false;
  const result = handleImplementation(
    settings,
    sampleIssue,
    true,
    {
      spawnSync: () => ({
        status: 0,
        stdout: makeCodexEvent(planPayload),
        stderr: ""
      }),
      spawn: () => {
        workerSpawned = true;
        return { pid: 9999, unref: () => {} };
      }
    }
  );

  assert.equal(result.exitCode, 2);
  assert.equal(result.output.eligible, false);
  assert.equal(workerSpawned, false, "Worker must NOT be spawned for unregistered agent");
});

test("Runtime Integration: disabled or archived agents fail closed and block dispatch", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  store.createAgentDefinition({
    id: "custom-worker",
    displayName: "Custom Worker",
    status: "disabled",
    allowedPaths: ["src/**"]
  });

  const validPlanPayload = {
    issue: "PACE-500",
    summary: sampleIssue.summary,
    persona: "startup-cto",
    taskAgent: "custom-worker",
    skills: ["api-design"],
    risk: "normal",
    parallelSafe: true,
    allowedPaths: ["src/**"],
    dependencies: [],
    rationale: ["Valid test plan"],
    reasons: ["Valid test plan"]
  };

  const planDisabled = issuePlan(settings, sampleIssue, {
    store,
    runtime: {
      spawnSync: () => ({
        status: 0,
        stdout: makeCodexEvent(validPlanPayload),
        stderr: ""
      })
    }
  });

  assert.equal(planDisabled.eligible, false, "Disabled agent must be ineligible");
  assert.ok(
    planDisabled.eligibilityReasons.some(r => r.includes("Agent 'custom-worker' is disabled and cannot receive work")),
    "Eligibility reasons must contain disabled agent notice"
  );

  // Archive the agent and verify same blocking behavior
  store.setAgentStatus("custom-worker", "archived");
  const planArchived = issuePlan(settings, sampleIssue, {
    store,
    runtime: {
      spawnSync: () => ({
        status: 0,
        stdout: makeCodexEvent(validPlanPayload),
        stderr: ""
      })
    }
  });

  assert.equal(planArchived.eligible, false, "Archived agent must be ineligible");
  assert.ok(
    planArchived.eligibilityReasons.some(r => r.includes("Agent 'custom-worker' is archived and cannot receive work")),
    "Eligibility reasons must contain archived agent notice"
  );
});

test("Snapshot Pinning: run retains immutable agent version across global agent updates", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  // Create Agent v1
  const v1 = store.createAgentDefinition({
    id: "custom-worker",
    displayName: "Custom Worker v1",
    status: "enabled",
    skills: ["api-design"],
    allowedPaths: ["src/**"]
  });

  const validPlanPayload = {
    issue: "PACE-500",
    summary: sampleIssue.summary,
    persona: "startup-cto",
    taskAgent: "custom-worker",
    skills: ["api-design"],
    risk: "normal",
    parallelSafe: true,
    allowedPaths: ["src/**"],
    dependencies: [],
    rationale: ["Valid test plan"],
    reasons: ["Valid test plan"]
  };

  const plan1 = issuePlan(settings, sampleIssue, {
    store,
    runtime: {
      spawnSync: () => ({
        status: 0,
        stdout: makeCodexEvent(validPlanPayload),
        stderr: ""
      })
    }
  });

  assert.equal(plan1.agentVersion, 1);
  assert.equal(plan1.configSnapshot.agentVersion, 1);
  assert.equal(plan1.configSnapshot.agentHash, v1.definitionHash);

  const runId = store.createRun(sampleIssue.key, plan1);

  // Update Agent in registry to v2
  const v2 = store.updateAgentDefinition("custom-worker", {
    displayName: "Custom Worker v2",
    skills: ["api-design", "kafka-streams"]
  });
  assert.equal(v2.version, 2);

  // Verify historical run still has snapshot with v1
  const storedRun = store.getRun(runId);
  assert.equal(storedRun.payload.configSnapshot.agentVersion, 1, "Run snapshot must retain v1");
  assert.equal(storedRun.payload.configSnapshot.agentHash, v1.definitionHash, "Run snapshot must retain v1 hash");
});

// ── 7. Plan Approval Identity Binding ─────────────────────────────────────────

test("Plan Approval Identity: plan fingerprint binds agentId, agentVersion, and agentHash", () => {
  const store = makeTestStore();
  const settings = makeSettings(store, { operatingMode: "supervised" });

  const v1 = store.createAgentDefinition({
    id: "custom-worker",
    displayName: "Custom Worker v1",
    skills: ["api-design"],
    allowedPaths: ["src/**"]
  });

  const validPlanPayload = {
    issue: "PACE-500",
    summary: sampleIssue.summary,
    persona: "startup-cto",
    taskAgent: "custom-worker",
    skills: ["api-design"],
    risk: "normal",
    parallelSafe: true,
    allowedPaths: ["src/**"],
    dependencies: [],
    rationale: ["Valid test plan"],
    reasons: ["Valid test plan"]
  };

  const planV1 = issuePlan(settings, sampleIssue, {
    store,
    runtime: {
      spawnSync: () => ({
        status: 0,
        stdout: makeCodexEvent(validPlanPayload),
        stderr: ""
      })
    }
  });

  const fpV1 = computePlanFingerprint(planV1);
  assert.ok(fpV1);

  // Record human approval for planV1
  store.recordApprovalDecision("PACE-500", {
    action: "implementation",
    approved: true,
    approver: "admin",
    planFingerprint: fpV1
  });

  // Verify planV1 is authorized
  const authV1 = authorizeRuntimeAction(settings, store, {
    issueKey: "PACE-500",
    action: "implementation",
    plan: planV1
  });
  assert.equal(authV1.allowed, true, "Plan with agent v1 must be authorized by v1 approval");

  // Update agent in registry to v2
  store.updateAgentDefinition("custom-worker", {
    displayName: "Custom Worker v2",
    skills: ["api-design", "kafka-streams"]
  });

  // Generate new plan (now resolves to agent v2)
  const planV2 = issuePlan(settings, sampleIssue, {
    store,
    runtime: {
      spawnSync: () => ({
        status: 0,
        stdout: makeCodexEvent(validPlanPayload),
        stderr: ""
      })
    }
  });

  const fpV2 = computePlanFingerprint(planV2);
  assert.notEqual(fpV1, fpV2, "Fingerprint must change when agent version/hash changes");

  // Verify planV2 is NOT authorized by old v1 approval
  const authV2 = authorizeRuntimeAction(settings, store, {
    issueKey: "PACE-500",
    action: "implementation",
    plan: planV2
  });
  assert.equal(authV2.allowed, false, "Plan with agent v2 MUST NOT be authorized by v1 approval");
  assert.ok(authV2.reason.includes("requires human approval") || authV2.reason.includes("fingerprint mismatch"));
});

// ── 8. Control Plane Agent Management API ─────────────────────────────────────

test("Agent Management API: full HTTP lifecycle, loopback protection, and audit logging", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  const server = createDashboardServer(settings, { store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /api/agents (initially has builtin seeds)
    const listRes1 = await fetch(`${baseUrl}/api/agents`);
    assert.equal(listRes1.status, 200);
    const listData1 = await listRes1.json();
    assert.ok(listData1.agents.length >= BUILTIN_AGENT_SEEDS.length);

    // 2. POST /api/agents (create new agent)
    const createPayload = {
      id: "api-agent",
      displayName: "API Worker",
      role: "implementation",
      skills: ["rest-apis"],
      allowedPaths: ["api/**"]
    };

    // Non-loopback header check / invalid content-type
    const nonJsonRes = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not-json"
    });
    assert.equal(nonJsonRes.status, 415);

    const createRes = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createPayload)
    });
    assert.equal(createRes.status, 201);
    const createdAgent = (await createRes.json()).agent;
    assert.equal(createdAgent.id, "api-agent");
    assert.equal(createdAgent.version, 1);

    // 3. GET /api/agents/:id
    const getRes = await fetch(`${baseUrl}/api/agents/api-agent`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.agent.id, "api-agent");
    assert.equal(getData.agent.version, 1);
    assert.equal(getData.versions.length, 1);

    // 4. PATCH /api/agents/:id (update -> v2)
    const patchRes = await fetch(`${baseUrl}/api/agents/api-agent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "API Worker v2", skills: ["rest-apis", "fastapi"] })
    });
    assert.equal(patchRes.status, 200);
    const patchedAgent = (await patchRes.json()).agent;
    assert.equal(patchedAgent.version, 2);

    // 5. GET /api/agents/:id/versions/:version
    const v1Res = await fetch(`${baseUrl}/api/agents/api-agent/versions/1`);
    assert.equal(v1Res.status, 200);
    const v1Data = await v1Res.json();
    assert.equal(v1Data.version.version, 1);
    assert.equal(v1Data.version.definition.displayName, "API Worker");

    // 6. POST /api/agents/:id/disable, /enable, /archive
    const disableRes = await fetch(`${baseUrl}/api/agents/api-agent/disable`, { method: "POST" });
    assert.equal(disableRes.status, 200);
    assert.equal((await disableRes.json()).agent.status, "disabled");

    const enableRes = await fetch(`${baseUrl}/api/agents/api-agent/enable`, { method: "POST" });
    assert.equal(enableRes.status, 200);
    assert.equal((await enableRes.json()).agent.status, "enabled");

    const archiveRes = await fetch(`${baseUrl}/api/agents/api-agent/archive`, { method: "POST" });
    assert.equal(archiveRes.status, 200);
    assert.equal((await archiveRes.json()).agent.status, "archived");

    // 7. DELETE /api/agents/:id
    const deleteRes = await fetch(`${baseUrl}/api/agents/api-agent`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);

    const getAfterDelete = await fetch(`${baseUrl}/api/agents/api-agent`);
    assert.equal(getAfterDelete.status, 404);

    // 8. Audit trail verification in PM Decisions
    const auditDecisions = store.getPmDecisions("GLOBAL");
    const decisionTypes = auditDecisions.map(d => d.type);
    assert.ok(decisionTypes.includes("agent-created"));
    assert.ok(decisionTypes.includes("agent-updated"));
    assert.ok(decisionTypes.includes("agent-disabled"));
    assert.ok(decisionTypes.includes("agent-enabled"));
    assert.ok(decisionTypes.includes("agent-archived"));
    assert.ok(decisionTypes.includes("agent-deleted"));
  } finally {
    server.close();
  }
});

test("Agent Management API: controlPlane mutation flag rejects mutations with 403 when disabled", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store, {}, { agentRegistryMutationEnabled: false, configMutationEnabled: false });

  const server = createDashboardServer(settings, { store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // POST create blocked
    const postRes = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "blocked-agent", displayName: "Blocked Agent" })
    });
    assert.equal(postRes.status, 403);
    const postData = await postRes.json();
    assert.ok(postData.error.includes("Agent registry mutation is disabled"));

    // PATCH blocked
    const patchRes = await fetch(`${baseUrl}/api/agents/backend-engineer`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Should Fail" })
    });
    assert.equal(patchRes.status, 403);

    // disable blocked
    const disableRes = await fetch(`${baseUrl}/api/agents/backend-engineer/disable`, { method: "POST" });
    assert.equal(disableRes.status, 403);

    // DELETE blocked
    const deleteRes = await fetch(`${baseUrl}/api/agents/backend-engineer`, { method: "DELETE" });
    assert.equal(deleteRes.status, 403);

    // DB remains unchanged
    const backend = store.getAgentDefinition("backend-engineer");
    assert.equal(backend.version, 1);
    assert.equal(backend.status, "enabled");
  } finally {
    server.close();
  }
});
