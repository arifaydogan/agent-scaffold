import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OrchestratorError,
  OrchestratorUnavailableError,
  OrchestratorTimeoutError,
  OrchestratorProcessError,
  OrchestratorParseError,
  OrchestratorValidationError,
  validateOrchestratorPlan,
  BuiltinOrchestratorProvider,
  CliOrchestratorProvider,
  CodexOrchestratorProvider,
  AntigravityOrchestratorProvider,
  ClaudeCodeOrchestratorProvider,
  createOrchestratorProvider,
  selectedOrchestratorProviderName,
  describeOrchestratorProviders
} from "../lib/orchestrator.js";
import { issuePlan, createConfigSnapshot, handleImplementation, handleRework, getStore } from "../lib/runtime.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTestSettings(overrides = {}) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "repo-phase-c-"));
  fs.writeFileSync(path.join(repoPath, "AGENTS.md"), "test");
  fs.writeFileSync(path.join(repoPath, "ORCHESTRATION.md"), "test");
  fs.writeFileSync(path.join(repoPath, "PACEBUILD_ORCHESTRATOR.md"), "test");
  fs.mkdirSync(path.join(repoPath, ".agents", "rules"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, ".agents", "rules", "orchestration-gates.md"), "test");
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worktrees-phase-c-"));
  const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-phase-c-"));
  fs.mkdirSync(path.join(tempConfigDir, ".agent-runtime"), { recursive: true });

  const configPath = path.join(tempConfigDir, "config.json");
  const rawData = {
    project: {
      key: "PACE",
      repoPath: ".",
      operatingMode: "autonomous",
      ...(overrides.project || {})
    },
    worktree: {
      root: worktreeRoot,
      ...(overrides.worktree || {})
    },
    orchestrator: {
      defaultProvider: "builtin",
      providers: {
        builtin: { type: "builtin" },
        codex: {
          type: "codex",
          command: ["codex", "exec", "--json", "{prompt}"],
          timeoutSeconds: 30
        },
        antigravity: {
          type: "antigravity",
          command: ["agy", "exec", "--json", "{prompt}"],
          timeoutSeconds: 30
        },
        "claude-code": {
          type: "claude-code",
          command: ["claude", "-p", "{prompt}", "--output-format", "json"],
          timeoutSeconds: 30
        },
        "custom-cli": {
          type: "generic-cli",
          command: ["my-orch", "--issue", "{issueKey}", "--prompt", "{prompt}"],
          timeoutSeconds: 30
        }
      },
      ...(overrides.orchestrator || {})
    },
    policy: {
      allowedProjects: ["PACE"],
      humanOnlyStatuses: ["Done"],
      maxConcurrency: 5,
      requiredLabels: ["agent-ready"],
      externalWritesEnabled: true,
      gitIntegrationEnabled: true,
      autonomyEnabled: true,
      pathScopes: {
        "backend-engineer": ["lib/**", "src/**"],
        "startup-cto": ["**"]
      },
      review: {
        provider: "antigravity",
        modelProfile: "claude-review",
        maxReworkAttempts: 3
      },
      ...(overrides.policy || {})
    },
    executor: {
      defaultProvider: "codex",
      providers: {
        codex: {
          command: ["codex", "exec", "{prompt}"],
          defaultModel: "gpt-5",
          modelProfiles: { medium: "gpt-5", high: "gpt-5-pro" },
          defaultEffort: "medium",
          mode: "accept-edits"
        },
        antigravity: {
          command: ["agy", "exec", "{prompt}"],
          defaultModel: "claude-sonnet-4-6",
          modelProfiles: { "claude-review": "claude-sonnet-4-6" },
          defaultEffort: "medium",
          mode: "accept-edits"
        }
      },
      ...(overrides.executor || {})
    }
  };

  fs.writeFileSync(configPath, JSON.stringify(rawData, null, 2));

  return {
    source: configPath,
    projectKey: "PACE",
    repoPath,
    worktreeRoot,
    data: rawData
  };
}

const sampleIssue = {
  key: "PACE-100",
  summary: "Design payment service API",
  description: "Acceptance Criteria: Must support Stripe and PayPal.",
  status: "In Progress",
  canonicalState: "ready",
  labels: ["agent-ready"],
  issueType: "Task"
};

const sampleValidPlanJson = {
  issue: "PACE-100",
  summary: "Design payment service API",
  persona: "startup-cto",
  taskAgent: "backend-engineer",
  skills: ["api-design", "security-review", "minimal-change"],
  risk: "high",
  parallelSafe: true,
  allowedPaths: ["lib/payments/**", "test/payments/**"],
  dependencies: ["PACE-90"],
  executor: "codex",
  model: "gpt-5-pro",
  effort: "high",
  rationale: ["High-risk payment processing requiring architectural oversight"]
};

// ── 1. Structured Plan Schema Validation ───────────────────────────────────────

test("Structured Orchestrator Plan Schema: valid plan passes validation", () => {
  const validated = validateOrchestratorPlan(sampleValidPlanJson, { issue: sampleIssue });
  assert.equal(validated.issue, "PACE-100");
  assert.equal(validated.summary, "Design payment service API");
  assert.equal(validated.persona, "startup-cto");
  assert.equal(validated.taskAgent, "backend-engineer");
  assert.deepEqual(validated.skills, ["api-design", "security-review", "minimal-change"]);
  assert.equal(validated.risk, "high");
  assert.equal(validated.parallelSafe, true);
  assert.deepEqual(validated.allowedPaths, ["lib/payments/**", "test/payments/**"]);
  assert.deepEqual(validated.dependencies, ["PACE-90"]);
  assert.equal(validated.executor, "codex");
  assert.equal(validated.model, "gpt-5-pro");
  assert.equal(validated.effort, "high");
});

test("Structured Orchestrator Plan Schema: incomplete plan fails validation (missing persona/taskAgent/skills)", () => {
  // Missing persona
  assert.throws(
    () => validateOrchestratorPlan({ issue: "PACE-100", summary: "test", taskAgent: "dev", skills: ["s1"] }),
    (err) => err instanceof OrchestratorValidationError && err.validationErrors.some(e => e.includes("persona"))
  );

  // Missing taskAgent
  assert.throws(
    () => validateOrchestratorPlan({ issue: "PACE-100", summary: "test", persona: "cto", skills: ["s1"] }),
    (err) => err instanceof OrchestratorValidationError && err.validationErrors.some(e => e.includes("taskAgent"))
  );

  // Invalid skills (not array)
  assert.throws(
    () => validateOrchestratorPlan({ issue: "PACE-100", summary: "test", persona: "cto", taskAgent: "dev", skills: "not-array" }),
    (err) => err instanceof OrchestratorValidationError && err.validationErrors.some(e => e.includes("skills"))
  );

  // Invalid risk value
  assert.throws(
    () => validateOrchestratorPlan({ issue: "PACE-100", summary: "test", persona: "cto", taskAgent: "dev", skills: ["s1"], risk: "extreme" }),
    (err) => err instanceof OrchestratorValidationError && err.validationErrors.some(e => e.includes("risk"))
  );
});

// ── 2. Generic CLI Orchestrator Provider ──────────────────────────────────────

test("Generic CLI Orchestrator: valid structured plan is parsed and returned", () => {
  const runtime = {
    spawnSync: (cmd, args) => {
      return {
        status: 0,
        stdout: JSON.stringify(sampleValidPlanJson),
        stderr: ""
      };
    }
  };

  const provider = new CliOrchestratorProvider("custom-cli", {
    command: ["my-orch", "--json", "{prompt}"]
  }, runtime);

  const plan = provider.plan(sampleIssue);
  assert.equal(plan.issue, "PACE-100");
  assert.equal(plan.persona, "startup-cto");
  assert.equal(plan.taskAgent, "backend-engineer");
  assert.equal(plan.risk, "high");
});

test("Generic CLI Orchestrator: parses markdown code blocks ```json ... ```", () => {
  const runtime = {
    spawnSync: () => ({
      status: 0,
      stdout: "Here is the plan:\n```json\n" + JSON.stringify(sampleValidPlanJson) + "\n```\nGood luck!",
      stderr: ""
    })
  };

  const provider = new CliOrchestratorProvider("custom-cli", {
    command: ["my-orch", "{prompt}"]
  }, runtime);

  const plan = provider.plan(sampleIssue);
  assert.equal(plan.issue, "PACE-100");
  assert.equal(plan.persona, "startup-cto");
});

test("Generic CLI Orchestrator: malformed JSON fails closed with OrchestratorParseError", () => {
  const runtime = {
    spawnSync: () => ({
      status: 0,
      stdout: "Sorry, I cannot plan this { broken json ...",
      stderr: ""
    })
  };

  const provider = new CliOrchestratorProvider("custom-cli", {
    command: ["my-orch", "{prompt}"]
  }, runtime);

  assert.throws(
    () => provider.plan(sampleIssue),
    (err) => err instanceof OrchestratorParseError
  );
});

test("Generic CLI Orchestrator: non-zero exit fails explicitly with OrchestratorProcessError", () => {
  const runtime = {
    spawnSync: () => ({
      status: 127,
      stdout: "",
      stderr: "Fatal: Orchestrator failed to initialize"
    })
  };

  const provider = new CliOrchestratorProvider("custom-cli", {
    command: ["my-orch", "{prompt}"]
  }, runtime);

  assert.throws(
    () => provider.plan(sampleIssue),
    (err) => err instanceof OrchestratorProcessError && err.exitCode === 127
  );
});

test("Generic CLI Orchestrator: timeout fails explicitly with OrchestratorTimeoutError", () => {
  const runtime = {
    spawnSync: () => ({
      status: null,
      signal: "SIGTERM",
      error: { code: "ETIMEDOUT", message: "timed out" }
    })
  };

  const provider = new CliOrchestratorProvider("custom-cli", {
    command: ["my-orch", "{prompt}"]
  }, runtime);

  assert.throws(
    () => provider.plan(sampleIssue),
    (err) => err instanceof OrchestratorTimeoutError
  );
});

// ── 3. Provider Adapters ──────────────────────────────────────────────────────

test("Codex Orchestrator Adapter: returns validated canonical plan", () => {
  const runtime = {
    spawnSync: (cmd, args) => {
      assert.equal(cmd, "codex");
      assert.ok(args.includes("exec"));
      return {
        status: 0,
        stdout: JSON.stringify(sampleValidPlanJson),
        stderr: ""
      };
    }
  };

  const provider = new CodexOrchestratorProvider("codex", {}, runtime);
  const plan = provider.plan(sampleIssue);
  assert.equal(plan.persona, "startup-cto");
  assert.equal(plan.taskAgent, "backend-engineer");
  assert.deepEqual(plan.skills, ["api-design", "security-review", "minimal-change"]);
});

test("Antigravity Orchestrator Adapter: handles stream/envelope and returns canonical plan", () => {
  const runtime = {
    spawnSync: (cmd, args) => {
      assert.equal(cmd, "agy");
      // Antigravity returning an envelope object with { status: "SUCCESS", response: "..." }
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "SUCCESS",
          ok: true,
          response: JSON.stringify(sampleValidPlanJson)
        }),
        stderr: ""
      };
    }
  };

  const provider = new AntigravityOrchestratorProvider("antigravity", {}, runtime);
  const plan = provider.plan(sampleIssue);
  assert.equal(plan.persona, "startup-cto");
  assert.equal(plan.taskAgent, "backend-engineer");
  assert.equal(plan.risk, "high");
});

test("Claude Code Orchestrator Adapter: returns canonical schema and fails explicitly when uninstalled/disabled", () => {
  const runtime = {
    spawnSync: (cmd, args) => {
      assert.equal(cmd, "claude");
      return {
        status: 0,
        stdout: JSON.stringify(sampleValidPlanJson),
        stderr: ""
      };
    }
  };

  const enabledProvider = new ClaudeCodeOrchestratorProvider("claude-code", {}, runtime);
  const plan = enabledProvider.plan(sampleIssue);
  assert.equal(plan.persona, "startup-cto");

  // Disabled / uninstalled
  const disabledProvider = new ClaudeCodeOrchestratorProvider("claude-code", { installed: false }, runtime);
  assert.throws(
    () => disabledProvider.plan(sampleIssue),
    (err) => err instanceof OrchestratorUnavailableError
  );
});

test("Configured Orchestrator Failure: does not silently fallback to builtin routing", () => {
  const settings = createTestSettings({
    orchestrator: {
      defaultProvider: "codex",
      providers: {
        codex: {
          type: "codex",
          command: ["codex", "exec", "{prompt}"]
        }
      }
    }
  });

  const failingRuntime = {
    spawnSync: () => ({
      status: 1,
      stdout: "",
      stderr: "Codex server unavailable"
    })
  };

  const orchestrator = createOrchestratorProvider(settings, failingRuntime);
  assert.throws(
    () => orchestrator.plan(sampleIssue),
    (err) => err instanceof OrchestratorProcessError
  );
});

// ── 4. Persona and Task Agent Separation & Snapshot Pinning ──────────────────

test("Persona and TaskAgent Separation: remain distinct in plan and snapshot", () => {
  const settings = createTestSettings({
    orchestrator: {
      defaultProvider: "codex",
      providers: {
        codex: { type: "codex", command: ["codex", "exec", "{prompt}"] }
      }
    }
  });

  const runtime = {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        issue: "PACE-100",
        summary: "Architecture design",
        persona: "startup-cto",
        taskAgent: "backend-engineer",
        skills: ["senior-backend", "api-design", "backend-testing"],
        risk: "high",
        parallelSafe: false,
        allowedPaths: ["lib/core/**"]
      }),
      stderr: ""
    })
  };

  const plan = issuePlan(settings, sampleIssue, { runtime });

  // Assert distinct identity fields in generated plan
  assert.equal(plan.persona, "startup-cto", "Persona must be startup-cto");
  assert.equal(plan.taskAgent, "backend-engineer", "TaskAgent must be backend-engineer");
  assert.notEqual(plan.persona, plan.taskAgent, "Persona and taskAgent must remain distinct");
  assert.deepEqual(plan.skills, ["senior-backend", "api-design", "backend-testing"]);
  assert.deepEqual(plan.allowedPaths, ["lib/core/**"]);

  // Assert distinct identity fields in configSnapshot
  const snapshot = plan.configSnapshot;
  assert.equal(snapshot.persona, "startup-cto");
  assert.equal(snapshot.taskAgent, "backend-engineer");
  assert.equal(snapshot.agentId, "backend-engineer");
  assert.equal(snapshot.orchestratorProvider, "codex");
});

test("Orchestrator Selection is Snapshot-Pinned across global config changes", () => {
  const settings = createTestSettings({
    orchestrator: {
      defaultProvider: "codex",
      providers: {
        codex: { type: "codex", command: ["codex", "exec", "{prompt}"] },
        antigravity: { type: "antigravity", command: ["agy", "exec", "{prompt}"] }
      }
    }
  });

  const codexRuntime = {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        issue: "PACE-100",
        summary: "Task",
        persona: "startup-cto",
        taskAgent: "backend-engineer",
        skills: ["api-design"],
        risk: "high",
        parallelSafe: true,
        allowedPaths: ["lib/payments/**"]
      }),
      stderr: ""
    })
  };

  // 1. Initial run plans with codex
  const initialPlan = issuePlan(settings, sampleIssue, { runtime: codexRuntime });
  assert.equal(initialPlan.configSnapshot.orchestratorProvider, "codex");
  assert.equal(initialPlan.persona, "startup-cto");
  assert.equal(initialPlan.taskAgent, "backend-engineer");

  // 2. Global default orchestrator changes to antigravity
  settings.data.orchestrator.defaultProvider = "antigravity";

  // 3. Rework/subsequent planning for the existing run uses snapshot, NOT calling the new antigravity orchestrator
  let agyCalled = false;
  const agyRuntime = {
    spawnSync: (cmd) => {
      if (cmd === "agy") agyCalled = true;
      return {
        status: 0,
        stdout: JSON.stringify({
          issue: "PACE-100",
          summary: "Task",
          persona: "devops-engineer",
          taskAgent: "infra-specialist",
          skills: ["terraform"],
          risk: "low",
          parallelSafe: true,
          allowedPaths: ["infra/**"]
        }),
        stderr: ""
      };
    }
  };

  const reworkPlan = issuePlan(settings, sampleIssue, {
    originatingRun: { payload: { configSnapshot: initialPlan.configSnapshot } },
    runtime: agyRuntime
  });

  // Must retain codex-pinned routing from snapshot without calling agy!
  assert.equal(agyCalled, false, "Live orchestrator must NOT be invoked for snapshot-pinned lifecycle");
  assert.equal(reworkPlan.configSnapshot.orchestratorProvider, "codex");
  assert.equal(reworkPlan.persona, "startup-cto");
  assert.equal(reworkPlan.taskAgent, "backend-engineer");
  assert.deepEqual(reworkPlan.allowedPaths, ["lib/payments/**"]);

  // 4. A new unrelated issue uses the new global default (antigravity)
  const newIssue = {
    key: "PACE-200",
    summary: "Infra task",
    description: "Acceptance Criteria: Deploy infra.",
    status: "In Progress",
    canonicalState: "ready",
    labels: ["agent-ready"],
    issueType: "Task"
  };
  const newPlan = issuePlan(settings, newIssue, { runtime: agyRuntime });
  assert.equal(agyCalled, true, "New issue must invoke new global default orchestrator");
  assert.equal(newPlan.configSnapshot.orchestratorProvider, "antigravity");
  assert.equal(newPlan.persona, "devops-engineer");
  assert.equal(newPlan.taskAgent, "infra-specialist");
});
