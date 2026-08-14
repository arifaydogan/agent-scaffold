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
import { selectExecutionProfile } from "../lib/executor.js";

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

// ── 1. Structured Plan Schema Validation (Strict & Fail-Closed) ────────────────

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

test("Strict Schema Validation: missing risk, parallelSafe, allowedPaths, dependencies or rationale throws OrchestratorValidationError", () => {
  // 1. Missing risk (no silent defaulting)
  const missingRisk = { ...sampleValidPlanJson };
  delete missingRisk.risk;
  assert.throws(
    () => validateOrchestratorPlan(missingRisk),
    (err) => err instanceof OrchestratorValidationError && err.validationErrors.some(e => e.includes("risk"))
  );

  // 2. Missing parallelSafe (no silent defaulting)
  const missingParallel = { ...sampleValidPlanJson };
  delete missingParallel.parallelSafe;
  assert.throws(
    () => validateOrchestratorPlan(missingParallel),
    (err) => err instanceof OrchestratorValidationError && err.validationErrors.some(e => e.includes("parallelSafe"))
  );

  // 3. Missing allowedPaths / scope (no silent defaulting)
  const missingScope = { ...sampleValidPlanJson };
  delete missingScope.allowedPaths;
  assert.throws(
    () => validateOrchestratorPlan(missingScope),
    (err) => err instanceof OrchestratorValidationError && err.validationErrors.some(e => e.includes("allowedPaths"))
  );

  // 4. Missing dependencies (no silent defaulting)
  const missingDeps = { ...sampleValidPlanJson };
  delete missingDeps.dependencies;
  assert.throws(
    () => validateOrchestratorPlan(missingDeps),
    (err) => err instanceof OrchestratorValidationError && err.validationErrors.some(e => e.includes("dependencies"))
  );

  // 5. Missing rationale / reasons (no silent defaulting)
  const missingRationale = { ...sampleValidPlanJson };
  delete missingRationale.rationale;
  assert.throws(
    () => validateOrchestratorPlan(missingRationale),
    (err) => err instanceof OrchestratorValidationError && err.validationErrors.some(e => e.includes("rationale"))
  );
});

// ── 2. Real Codex CLI JSONL Protocol Adapter ──────────────────────────────────

test("Real Codex CLI Adapter: parses realistic multi-event JSONL stream and extracts plan", () => {
  const codexJsonlOutput = [
    JSON.stringify({ type: "thread.started", thread_id: "thr_abc123" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "```json\n" + JSON.stringify(sampleValidPlanJson, null, 2) + "\n```"
          }
        ]
      }
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 150, output_tokens: 80 } })
  ].join("\n");

  const runtime = {
    spawnSync: (cmd, args) => {
      assert.equal(cmd, "codex");
      assert.ok(args.includes("exec"));
      return {
        status: 0,
        stdout: codexJsonlOutput,
        stderr: ""
      };
    }
  };

  const provider = new CodexOrchestratorProvider("codex", {}, runtime);
  const plan = provider.plan(sampleIssue);
  assert.equal(plan.issue, "PACE-100");
  assert.equal(plan.persona, "startup-cto");
  assert.equal(plan.taskAgent, "backend-engineer");
  assert.deepEqual(plan.skills, ["api-design", "security-review", "minimal-change"]);
  assert.equal(plan.risk, "high");
  assert.deepEqual(plan.allowedPaths, ["lib/payments/**", "test/payments/**"]);
});

// ── 3. Real Claude Code Result Envelope Adapter ───────────────────────────────

test("Real Claude Code Adapter: parses Claude JSON envelope and extracts plan from .result", () => {
  const claudeEnvelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Here is the orchestrator plan:\n```json\n" + JSON.stringify(sampleValidPlanJson) + "\n```",
    total_cost_usd: 0.0084,
    duration_ms: 1450
  };

  const runtime = {
    spawnSync: (cmd, args) => {
      assert.equal(cmd, "claude");
      return {
        status: 0,
        stdout: JSON.stringify(claudeEnvelope),
        stderr: ""
      };
    }
  };

  const provider = new ClaudeCodeOrchestratorProvider("claude-code", {}, runtime);
  const plan = provider.plan(sampleIssue);
  assert.equal(plan.persona, "startup-cto");
  assert.equal(plan.taskAgent, "backend-engineer");
  assert.equal(plan.risk, "high");
});

test("Real Claude Code Adapter: handles error envelope and throws OrchestratorProcessError", () => {
  const errorEnvelope = {
    type: "result",
    subtype: "error",
    is_error: true,
    error: "Authentication failed: invalid token"
  };

  const runtime = {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify(errorEnvelope),
      stderr: ""
    })
  };

  const provider = new ClaudeCodeOrchestratorProvider("claude-code", {}, runtime);
  assert.throws(
    () => provider.plan(sampleIssue),
    (err) => err instanceof OrchestratorProcessError && err.stderr.includes("Authentication failed")
  );
});

// ── 4. Real Antigravity Multi-line Stream Adapter ─────────────────────────────

test("Real Antigravity Adapter: parses multi-line JSONL stream and selects terminal SUCCESS event", () => {
  const antigravityStream = [
    JSON.stringify({ status: "QUEUED", timestamp: 100 }),
    JSON.stringify({ status: "PROGRESS", message: "Analyzing architecture dependencies", timestamp: 200 }),
    JSON.stringify({
      status: "SUCCESS",
      ok: true,
      response: JSON.stringify(sampleValidPlanJson),
      timestamp: 300
    })
  ].join("\n");

  const runtime = {
    spawnSync: (cmd, args) => {
      assert.equal(cmd, "agy");
      return {
        status: 0,
        stdout: antigravityStream,
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

test("Real Antigravity Adapter: handles FAILED stream event and throws OrchestratorProcessError", () => {
  const failingStream = [
    JSON.stringify({ status: "QUEUED" }),
    JSON.stringify({ status: "FAILED", ok: false, error: "Model quota exceeded" })
  ].join("\n");

  const runtime = {
    spawnSync: () => ({
      status: 0,
      stdout: failingStream,
      stderr: ""
    })
  };

  const provider = new AntigravityOrchestratorProvider("antigravity", {}, runtime);
  assert.throws(
    () => provider.plan(sampleIssue),
    (err) => err instanceof OrchestratorProcessError && err.stderr.includes("Model quota exceeded")
  );
});

// ── 5. Scope Fail-Closed & Intersection Semantics ─────────────────────────────

test("Explicit Scope Semantics: empty allowedPaths [] remains empty and NEVER broadens to policy persona scope", () => {
  const settings = createTestSettings({
    orchestrator: {
      defaultProvider: "codex",
      providers: {
        codex: { type: "codex", command: ["codex", "exec", "{prompt}"] }
      }
    },
    policy: {
      pathScopes: {
        "backend-engineer": ["lib/**", "src/**"]
      }
    }
  });

  const emptyScopePlan = {
    ...sampleValidPlanJson,
    allowedPaths: [] // Explicit empty scope
  };

  const runtime = {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify(emptyScopePlan),
      stderr: ""
    })
  };

  const plan = issuePlan(settings, sampleIssue, { runtime });
  assert.deepEqual(plan.allowedPaths, [], "Explicit empty allowedPaths [] MUST remain []");
  assert.notDeepEqual(plan.allowedPaths, ["lib/**", "src/**"], "Must NEVER broaden to policy persona scope");
});

test("Scope Intersection: orchestrator paths are strictly intersected with policy pathScopes", () => {
  const settings = createTestSettings({
    orchestrator: {
      defaultProvider: "codex",
      providers: {
        codex: { type: "codex", command: ["codex", "exec", "{prompt}"] }
      }
    },
    policy: {
      pathScopes: {
        "startup-cto": ["lib/**"],
        "backend-engineer": ["lib/**"]
      }
    }
  });

  const planWithBroadScope = {
    ...sampleValidPlanJson,
    allowedPaths: ["lib/payments/**", "infra/terraform/**"] // infra is outside policy lib/**
  };

  const runtime = {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify(planWithBroadScope),
      stderr: ""
    })
  };

  const plan = issuePlan(settings, sampleIssue, { runtime });
  assert.deepEqual(plan.allowedPaths, ["lib/payments/**"], "infra/terraform/** must be stripped by policy intersection");
});

// ── 6. Executor Recommendation Semantics ──────────────────────────────────────

test("Executor Recommendation Semantics: orchestrator recommends Antigravity when default is Codex", () => {
  const settings = createTestSettings({
    orchestrator: {
      defaultProvider: "codex",
      providers: {
        codex: { type: "codex", command: ["codex", "exec", "{prompt}"] }
      }
    },
    executor: {
      defaultProvider: "codex",
      providers: {
        codex: { command: ["codex"], defaultModel: "gpt-5", mode: "accept-edits" },
        antigravity: { command: ["agy"], defaultModel: "claude-sonnet-4-6", mode: "accept-edits" }
      }
    }
  });

  const orchPlan = {
    ...sampleValidPlanJson,
    risk: "normal",
    executor: "antigravity",
    model: "claude-sonnet-4-6"
  };

  const runtime = {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify(orchPlan),
      stderr: ""
    })
  };

  const plan = issuePlan(settings, sampleIssue, { runtime });

  // Assert execution profile resolved to the orchestrator-recommended Antigravity
  assert.equal(plan.execution.provider, "antigravity", "Resolved executor should match recommendation");
  assert.equal(plan.configSnapshot.recommendedExecutor, "antigravity");
  assert.equal(plan.configSnapshot.executorProvider, "antigravity");
});

// ── 7. Typed Failure Semantics & Fail-Closed Contract ─────────────────────────

test("Typed Failure Semantics: unknown provider throws OrchestratorUnavailableError", () => {
  const settings = createTestSettings({
    orchestrator: {
      defaultProvider: "unknown-orchestrator",
      providers: {
        builtin: { type: "builtin" }
      }
    }
  });

  assert.throws(
    () => createOrchestratorProvider(settings),
    (err) => err instanceof OrchestratorUnavailableError && err.message.includes("Unknown orchestrator provider")
  );
});

test("Typed Failure Semantics: malformed JSON throws OrchestratorParseError without fallback", () => {
  const settings = createTestSettings({
    orchestrator: {
      defaultProvider: "custom-cli",
      providers: {
        "custom-cli": { type: "generic-cli", command: ["my-orch", "{prompt}"] }
      }
    }
  });

  const badRuntime = {
    spawnSync: () => ({
      status: 0,
      stdout: "Error: raw non-json text output from CLI",
      stderr: ""
    })
  };

  const provider = createOrchestratorProvider(settings, badRuntime);
  assert.throws(
    () => provider.plan(sampleIssue),
    (err) => err instanceof OrchestratorParseError
  );
});

test("Persona and TaskAgent Separation: distinct values preserved in plan and snapshot", () => {
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
        allowedPaths: ["lib/core/**"],
        dependencies: [],
        rationale: ["Strategic architecture decision"]
      }),
      stderr: ""
    })
  };

  const plan = issuePlan(settings, sampleIssue, { runtime });

  assert.equal(plan.persona, "startup-cto");
  assert.equal(plan.taskAgent, "backend-engineer");
  assert.notEqual(plan.persona, plan.taskAgent);
  assert.equal(plan.configSnapshot.persona, "startup-cto");
  assert.equal(plan.configSnapshot.taskAgent, "backend-engineer");
  assert.equal(plan.configSnapshot.agentId, "backend-engineer");
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
        allowedPaths: ["lib/payments/**"],
        dependencies: [],
        rationale: ["Initial codex decision"]
      }),
      stderr: ""
    })
  };

  // 1. Initial run plans with codex
  const initialPlan = issuePlan(settings, sampleIssue, { runtime: codexRuntime });
  assert.equal(initialPlan.configSnapshot.orchestratorProvider, "codex");

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
          allowedPaths: ["infra/**"],
          dependencies: [],
          rationale: ["Agy decision"]
        }),
        stderr: ""
      };
    }
  };

  const reworkPlan = issuePlan(settings, sampleIssue, {
    originatingRun: { payload: { configSnapshot: initialPlan.configSnapshot } },
    runtime: agyRuntime
  });

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
