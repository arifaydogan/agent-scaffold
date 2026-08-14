/**
 * test/phase-d-agent-registry.test.js
 *
 * Phase D — Agent Registry:
 * - Dual-table immutable versioning (agent_definitions + agent_versions)
 * - Automatic, idempotent, and non-destructive builtin agent seeding
 * - Deterministic lifecycle (enabled, disabled, archived) vs immutable definition versions
 * - Fail-closed deletion safety (hard delete prevented if referenced anywhere by runs or reviewers)
 * - Strict schema validation & SHA-256 definition hash computation
 * - Runtime authoritative check: unknown, disabled, or archived agents fail closed
 * - Authoritative agent definition constraints: 3-way path intersection, skills containment, risk floor, concurrency
 * - Reviewer registry lifecycle & snapshot pinning
 * - Plan approval identity: plan fingerprint binds agentId, agentVersion, agentHash, reviewAgentId, reviewAgentVersion, reviewAgentHash
 * - HTTP Management API endpoints with mutation gating (controlPlane flag), loopback enforcement, and audit journal
 * - Legacy migration safety on malformed JSON
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
import { issuePlan, getStore, createConfigSnapshot, handleImplementation, handleReview } from "../lib/runtime.js";
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
  assert.throws(() => validateAgentDefinition({}), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "invalid space", displayName: "Test" }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "invalid@char", displayName: "Test" }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "" }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", role: "wizard" }), /Invalid agent role/);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", status: "destroyed" }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", defaultPersona: "invalid persona spaces" }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", maxConcurrency: 0 }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", maxConcurrency: -2 }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", skills: "not-array" }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", skills: ["valid", "  "] }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", capabilities: [""] }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", allowedPaths: ["   "] }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", executor: "not-object" }), AgentValidationError);
  assert.throws(() => validateAgentDefinition({ id: "valid-id", displayName: "Test", executor: { provider: "" } }), AgentValidationError);

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
    skills: ["backend-testing", "api-design"],
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

  const store1 = new RunStore(dbPath);
  const initialAgents = store1.listAgentDefinitions();
  const seedIds = BUILTIN_AGENT_SEEDS.map(s => s.id);
  assert.ok(initialAgents.length >= seedIds.length);
  for (const id of seedIds) {
    assert.ok(initialAgents.some(a => a.id === id), `Builtin agent '${id}' must be seeded`);
  }

  store1.updateAgentDefinition("backend-engineer", {
    displayName: "Customized Backend Engineer",
    skills: ["api-design", "custom-skill"]
  });
  const modified = store1.getAgentDefinition("backend-engineer");
  assert.equal(modified.version, 2);
  assert.equal(modified.definition.displayName, "Customized Backend Engineer");

  store1.createAgentDefinition({
    id: "my-custom-agent",
    displayName: "My Custom Agent",
    allowedPaths: ["custom/**"]
  });

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

  assert.throws(() => store.createAgentDefinition({ id: "custom-worker", displayName: "Duplicate" }), /already exists/);

  const updated = store.updateAgentDefinition("custom-worker", {
    displayName: "Custom Worker v2",
    skills: ["api-design", "graphql-patterns"]
  });

  assert.equal(updated.version, 2);
  assert.notEqual(updated.definitionHash, created.definitionHash);

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

  const current = store.getAgentDefinition("custom-worker");
  assert.equal(current.version, 2);
  assert.equal(current.currentVersion, 2);

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

  store.setAgentStatus("agent-2", "disabled");
  const disabledAgent = store.getAgentDefinition("agent-2");
  assert.equal(disabledAgent.status, "disabled");
  assert.equal(disabledAgent.currentStatus, "disabled");
  assert.equal(disabledAgent.version, 1, "Disabling must not increment version");
  assert.equal(disabledAgent.definitionHash, initialHash, "Definition hash must remain identical");
  assert.equal(store.listAgentVersions("agent-2").length, 1, "Disabling must not create extra versions");

  store.setAgentStatus("agent-2", "archived");
  assert.equal(store.getAgentDefinition("agent-2").status, "archived");

  const activeList = store.listAgentDefinitions();
  const ids = activeList.map(a => a.id);
  assert.ok(ids.includes("agent-1"), "Enabled agent must be in default list");
  assert.ok(!ids.includes("agent-2"), "Archived agent must be excluded from default list");

  const allList = store.listAgentDefinitions({ includeArchived: true });
  assert.ok(allList.some(a => a.id === "agent-2"));

  const archivedList = store.listAgentDefinitions({ status: "archived" });
  assert.ok(archivedList.some(a => a.id === "agent-2"));
});

test("Agent Lifecycle Isolation: PATCH must never implicitly change disabled or archived status", () => {
  const store = makeTestStore();
  store.createAgentDefinition({ id: "isolated-agent", displayName: "Isolated Agent", skills: ["s1"] });

  // Disable agent
  store.setAgentStatus("isolated-agent", "disabled");
  assert.equal(store.getAgentDefinition("isolated-agent").status, "disabled");

  // Update/PATCH definition
  const updated1 = store.updateAgentDefinition("isolated-agent", {
    displayName: "Isolated Agent v2",
    skills: ["s1", "s2"]
  });
  assert.equal(updated1.version, 2);
  assert.equal(updated1.status, "disabled", "PATCH must preserve disabled status");
  assert.equal(store.getAgentDefinition("isolated-agent").status, "disabled");

  // Archive agent
  store.setAgentStatus("isolated-agent", "archived");
  assert.equal(store.getAgentDefinition("isolated-agent").status, "archived");

  // Update/PATCH definition again
  const updated2 = store.updateAgentDefinition("isolated-agent", {
    displayName: "Isolated Agent v3"
  });
  assert.equal(updated2.version, 3);
  assert.equal(updated2.status, "archived", "PATCH must preserve archived status");
  assert.equal(store.getAgentDefinition("isolated-agent").status, "archived");
});

// ── 5. Deletion Safety (Fail-Closed on All Agent Roles) ─────────────────────────

test("Agent Registry Store: hard deletion is blocked if agent is referenced in any run role", () => {
  const store = makeTestStore();
  store.createAgentDefinition({ id: "unused-agent", displayName: "Unused Agent" });
  store.createAgentDefinition({ id: "worker-agent", displayName: "Worker Agent" });
  store.createAgentDefinition({ id: "reviewer-agent", displayName: "Reviewer Agent" });

  // 1. Worker agent reference
  store.createRun("PACE-101", {
    issue: "PACE-101",
    taskAgent: "worker-agent",
    allowedPaths: ["src/**"]
  });

  assert.equal(store.isAgentUsed("unused-agent"), false);
  assert.equal(store.isAgentUsed("worker-agent"), true);

  // 2. Reviewer agent reference (referenced only via reviewTaskAgent in payload)
  store.createRun("PACE-102", {
    issue: "PACE-102",
    taskAgent: "backend-engineer",
    reviewTaskAgent: "reviewer-agent",
    allowedPaths: ["src/**"]
  });
  assert.equal(store.isAgentUsed("reviewer-agent"), true);

  // Deleting unused succeeds
  assert.equal(store.deleteAgentDefinition("unused-agent"), true);
  assert.equal(store.getAgentDefinition("unused-agent"), null);

  // Deleting worker fails
  assert.throws(
    () => store.deleteAgentDefinition("worker-agent"),
    /Cannot hard-delete agent 'worker-agent' because it has been used by existing runs/
  );

  // Deleting reviewer fails
  assert.throws(
    () => store.deleteAgentDefinition("reviewer-agent"),
    /Cannot hard-delete agent 'reviewer-agent' because it has been used by existing runs/
  );
});

// ── 6. Authoritative Agent Definition Behavioral Constraints ─────────────────

test("Authoritative Agent Definition: constraints effectively shape new plans while historical runs remain pinned", () => {
  const store = makeTestStore();
  const settings = makeSettings(store, {
    pathScopes: {
      "custom-worker": ["src/**"]
    }
  });

  // 1. Register custom-worker v1 with broad allowedPaths, specific skills, and normal risk
  store.createAgentDefinition({
    id: "custom-worker",
    displayName: "Custom Worker v1",
    skills: ["api-design", "database-migration"],
    risk: "normal",
    maxConcurrency: 2,
    allowedPaths: ["src/**"]
  });

  const orchestratorPlanPayload = {
    issue: "PACE-500",
    summary: sampleIssue.summary,
    persona: "startup-cto",
    taskAgent: "custom-worker",
    skills: ["api-design", "unauthorized-skill"], // Orchestrator asks for unauthorized skill
    risk: "low", // Orchestrator asks for low risk
    parallelSafe: true,
    allowedPaths: ["src/deep/**", "outside/**"], // Orchestrator asks for broader paths
    dependencies: [],
    rationale: ["Test plan"]
  };

  const planV1 = issuePlan(settings, sampleIssue, {
    store,
    runtime: {
      spawnSync: () => ({
        status: 0,
        stdout: makeCodexEvent(orchestratorPlanPayload),
        stderr: ""
      })
    }
  });

  // Effective skills must filter out unauthorized skill
  assert.deepEqual(planV1.skills, ["api-design"], "Skills must be contained to registered agent skills");
  // Effective allowedPaths must intersect orchestrator, agent, and policy hard scope
  assert.deepEqual(planV1.allowedPaths, ["src/deep/**"], "Allowed paths must be 3-way intersected fail-closed");
  // Risk baseline must be normal (floor)
  assert.equal(planV1.risk, "normal", "Risk must be elevated to agent definition floor");

  const runId1 = store.createRun("PACE-500", planV1);

  // 2. Update agent definition to v2: narrow allowedPaths, elevate risk floor to high, set maxConcurrency to 1
  store.updateAgentDefinition("custom-worker", {
    displayName: "Custom Worker v2",
    skills: ["database-migration"],
    risk: "high",
    maxConcurrency: 1,
    allowedPaths: ["src/db/**"]
  });

  // 3. Issue new plan: runtime behavior changes automatically based on updated definition
  const planV2 = issuePlan(settings, sampleIssue, {
    store,
    runtime: {
      spawnSync: () => ({
        status: 0,
        stdout: makeCodexEvent(orchestratorPlanPayload),
        stderr: ""
      })
    }
  });

  assert.equal(planV2.agentVersion, 2);
  assert.deepEqual(planV2.skills, ["database-migration"], "Skills must reflect updated definition");
  assert.deepEqual(planV2.allowedPaths, [], "src/deep/** intersect src/db/** is empty fail-closed");
  assert.equal(planV2.risk, "high", "Risk must be high due to updated agent risk floor");
  assert.equal(planV2.maxConcurrency, 1, "Concurrency must reflect updated definition");

  // 4. Verify historical run 1 remains immutable and pinned to v1 contract
  const historicalRun = store.getRun(runId1);
  assert.equal(historicalRun.payload.configSnapshot.agentVersion, 1);
  assert.deepEqual(historicalRun.payload.configSnapshot.skills, ["api-design"]);
  assert.deepEqual(historicalRun.payload.configSnapshot.allowedPaths, ["src/deep/**"]);
  assert.equal(historicalRun.payload.configSnapshot.risk, "normal");
});

// ── 7. Reviewer Registry Rules & Fail-Closed Lifecycle ────────────────────────

test("Reviewer Registry: disabled or archived reviewer blocks review before worker spawn", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  // Create initial implementation run in store with pinned snapshot
  const initialPlan = issuePlan(settings, sampleIssue, {
    store,
    runtime: {
      spawnSync: () => ({
        status: 0,
        stdout: makeCodexEvent({
          issue: "PACE-500",
          summary: sampleIssue.summary,
          persona: "startup-cto",
          taskAgent: "backend-engineer",
          skills: ["api-design"],
          risk: "normal",
          parallelSafe: true,
          allowedPaths: ["lib/**"],
          dependencies: [],
          rationale: ["Initial run"]
        }),
        stderr: ""
      })
    }
  });
  const baseRunId = store.createRun(sampleIssue.key, initialPlan);
  store.transition(baseRunId, "review-queued", {
    implementationSha: "1234567890abcdef1234567890abcdef12345678"
  });

  // Now disable correctness-reviewer in registry
  store.setAgentStatus("correctness-reviewer", "disabled");

  let reviewWorkerSpawned = false;
  const result = handleReview(settings, sampleIssue, true, {
    spawnSync: () => {
      reviewWorkerSpawned = true;
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(result.exitCode, 2, "Disabled reviewer must return exitCode 2 (blocked)");
  assert.equal(result.output.eligible, false);
  assert.ok(
    result.output.eligibilityReasons.some(r => r.includes("Agent 'correctness-reviewer' is disabled and cannot receive work")),
    "Must state reviewer is disabled"
  );
  assert.equal(reviewWorkerSpawned, false, "Review worker must NOT be spawned when reviewer is disabled");
});

// ── 8. Runtime Unregistered / Disabled Worker Fail-Closed ──────────────────────

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

// ── 9. Plan Approval Identity Binding ─────────────────────────────────────────

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

  store.recordApprovalDecision("PACE-500", {
    action: "implementation",
    approved: true,
    approver: "admin",
    planFingerprint: fpV1
  });

  const authV1 = authorizeRuntimeAction(settings, store, {
    issueKey: "PACE-500",
    action: "implementation",
    plan: planV1
  });
  assert.equal(authV1.allowed, true, "Plan with agent v1 must be authorized by v1 approval");

  store.updateAgentDefinition("custom-worker", {
    displayName: "Custom Worker v2",
    skills: ["api-design", "kafka-streams"]
  });

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

  const authV2 = authorizeRuntimeAction(settings, store, {
    issueKey: "PACE-500",
    action: "implementation",
    plan: planV2
  });
  assert.equal(authV2.allowed, false, "Plan with agent v2 MUST NOT be authorized by v1 approval");
  assert.ok(authV2.reason.includes("requires human approval") || authV2.reason.includes("fingerprint mismatch"));
});

// ── 10. Control Plane Agent Management API ────────────────────────────────────

test("Agent Management API: full HTTP lifecycle, loopback protection, and audit logging", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  const server = createDashboardServer(settings, { store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const listRes1 = await fetch(`${baseUrl}/api/agents`);
    assert.equal(listRes1.status, 200);
    const listData1 = await listRes1.json();
    assert.ok(listData1.agents.length >= BUILTIN_AGENT_SEEDS.length);

    const createPayload = {
      id: "api-agent",
      displayName: "API Worker",
      role: "implementation",
      skills: ["rest-apis"],
      allowedPaths: ["api/**"]
    };

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

    const getRes = await fetch(`${baseUrl}/api/agents/api-agent`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.agent.id, "api-agent");
    assert.equal(getData.agent.version, 1);
    assert.equal(getData.versions.length, 1);

    const patchRes = await fetch(`${baseUrl}/api/agents/api-agent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "API Worker v2", skills: ["rest-apis", "fastapi"] })
    });
    assert.equal(patchRes.status, 200);
    const patchedAgent = (await patchRes.json()).agent;
    assert.equal(patchedAgent.version, 2);

    const v1Res = await fetch(`${baseUrl}/api/agents/api-agent/versions/1`);
    assert.equal(v1Res.status, 200);
    const v1Data = await v1Res.json();
    assert.equal(v1Data.version.version, 1);
    assert.equal(v1Data.version.definition.displayName, "API Worker");

    const disableRes = await fetch(`${baseUrl}/api/agents/api-agent/disable`, { method: "POST" });
    assert.equal(disableRes.status, 200);
    assert.equal((await disableRes.json()).agent.status, "disabled");

    const enableRes = await fetch(`${baseUrl}/api/agents/api-agent/enable`, { method: "POST" });
    assert.equal(enableRes.status, 200);
    assert.equal((await enableRes.json()).agent.status, "enabled");

    const archiveRes = await fetch(`${baseUrl}/api/agents/api-agent/archive`, { method: "POST" });
    assert.equal(archiveRes.status, 200);
    assert.equal((await archiveRes.json()).agent.status, "archived");

    const deleteRes = await fetch(`${baseUrl}/api/agents/api-agent`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);

    const getAfterDelete = await fetch(`${baseUrl}/api/agents/api-agent`);
    assert.equal(getAfterDelete.status, 404);

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
    const postRes = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "blocked-agent", displayName: "Blocked Agent" })
    });
    assert.equal(postRes.status, 403);
    const postData = await postRes.json();
    assert.ok(postData.error.includes("Agent registry mutation is disabled"));

    const patchRes = await fetch(`${baseUrl}/api/agents/backend-engineer`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Should Fail" })
    });
    assert.equal(patchRes.status, 403);

    const disableRes = await fetch(`${baseUrl}/api/agents/backend-engineer/disable`, { method: "POST" });
    assert.equal(disableRes.status, 403);

    const deleteRes = await fetch(`${baseUrl}/api/agents/backend-engineer`, { method: "DELETE" });
    assert.equal(deleteRes.status, 403);

    const backend = store.getAgentDefinition("backend-engineer");
    assert.equal(backend.version, 1);
    assert.equal(backend.status, "enabled");
  } finally {
    server.close();
  }
});

// ── 11. Legacy Migration Safety ───────────────────────────────────────────────

test("Agent Registry Migration: malformed legacy definition JSON rolls back and fails migration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-reg-mig-test-"));
  const dbPath = path.join(dir, "legacy.sqlite3");

  // Get Database constructor from RunStore instance
  const tempStore = new RunStore(path.join(dir, "temp.sqlite3"));
  const Database = tempStore.database.constructor;
  tempStore.database.close();

  const rawDb = new Database(dbPath);
  rawDb.exec(`
    CREATE TABLE agent_definitions (
      id TEXT PRIMARY KEY,
      definition TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO agent_definitions(id, definition, version, created_at, updated_at)
    VALUES ('corrupted-agent', '{malformed json definition', 1, '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z');
  `);
  rawDb.close();

  // Attempting to open with RunStore must throw migration error and not silently swallow
  assert.throws(
    () => new RunStore(dbPath),
    /Agent definitions migration failed/
  );
});
