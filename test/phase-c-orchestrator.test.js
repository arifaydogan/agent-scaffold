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
import { computePlanFingerprint, authorizeRuntimeAction } from "../lib/policy.js";
import { intersectTwoPatterns, intersectPathScopes, isSubScope, validateChangedFiles } from "../lib/scope.js";

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

test("Strict Schema Validation: missing required fields throws OrchestratorValidationError", () => {
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

test("Fail-Closed Issue Identity: missing issue/summary in output or mismatched issue key fails closed", () => {
  // Missing issue key in provider output (must NOT fill from context)
  const missingIssue = { ...sampleValidPlanJson };
  delete missingIssue.issue;
  assert.throws(
    () => validateOrchestratorPlan(missingIssue, { issue: sampleIssue }),
    (err) => err instanceof OrchestratorValidationError && err.validationErrors.some(e => e.includes("issue"))
  );

  // Missing summary in provider output (must NOT fill from context)
  const missingSummary = { ...sampleValidPlanJson };
  delete missingSummary.summary;
  assert.throws(
    () => validateOrchestratorPlan(missingSummary, { issue: sampleIssue }),
    (err) => err instanceof OrchestratorValidationError && err.validationErrors.some(e => e.includes("summary"))
  );

  // Returned issue PACE-999 does not match requested work item PACE-100
  const mismatchedIssue = { ...sampleValidPlanJson, issue: "PACE-999" };
  assert.throws(
    () => validateOrchestratorPlan(mismatchedIssue, { issue: sampleIssue }),
    (err) => err instanceof OrchestratorValidationError && err.validationErrors.some(e => e.includes("does not match requested work item"))
  );
});

// ── 2. Real Codex CLI JSONL Protocol Adapter ──────────────────────────────────

test("Real Codex CLI Adapter: parses actual Codex JSONL event schema with item.type === 'agent_message' and item.text", () => {
  const codexJsonlOutput = [
    JSON.stringify({ type: "thread.started", thread_id: "thr_abc123" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "reasoning", content: "Thinking about the payment architecture..." }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "```json\n" + JSON.stringify(sampleValidPlanJson, null, 2) + "\n```"
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

test("Real Codex CLI Adapter: handles turn.failed / error events and throws OrchestratorProcessError", () => {
  const codexFailedStream = [
    JSON.stringify({ type: "thread.started", thread_id: "thr_abc123" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "turn.failed", error: { message: "Context window exceeded during orchestration planning" } })
  ].join("\n");

  const runtime = {
    spawnSync: () => ({
      status: 0,
      stdout: codexFailedStream,
      stderr: ""
    })
  };

  const provider = new CodexOrchestratorProvider("codex", {}, runtime);
  assert.throws(
    () => provider.plan(sampleIssue),
    (err) => err instanceof OrchestratorProcessError && err.stderr.includes("Context window exceeded")
  );
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

test("Real Antigravity Adapter: QUEUED -> PROGRESS(response=valid plan) -> EOF fails closed and does not accept intermediate plan", () => {
  const incompleteStream = [
    JSON.stringify({ status: "QUEUED", timestamp: 100 }),
    JSON.stringify({
      status: "PROGRESS",
      message: "Drafting plan",
      response: JSON.stringify(sampleValidPlanJson),
      timestamp: 200
    })
  ].join("\n");

  const runtime = {
    spawnSync: () => ({
      status: 0,
      stdout: incompleteStream,
      stderr: ""
    })
  };

  const provider = new AntigravityOrchestratorProvider("antigravity", {}, runtime);
  assert.throws(
    () => provider.plan(sampleIssue),
    (err) => err instanceof OrchestratorParseError && err.message.includes("did not reach terminal SUCCESS event")
  );
});

// ── 5. Hard Scope Containment & Intersection Semantics ────────────────────────

test("Hard Path-Scope Containment: isSubScope respects * vs ** correctly", () => {
  // Hard policy: lib/* only matches direct children of lib, NOT subdirectories
  assert.equal(isSubScope("lib/deep/**", "lib/*"), false, "lib/deep/** must NOT be contained in lib/*");
  assert.equal(isSubScope("lib/foo.js", "lib/*"), true, "lib/foo.js MUST be contained in lib/*");
  assert.equal(isSubScope("lib/payments/**", "lib/**"), true, "lib/payments/** MUST be contained in lib/**");
  assert.equal(isSubScope("infra/**", "lib/**"), false, "infra/** must NOT be contained in lib/**");
});

test("Hard Path-Scope Intersection: exact glob intersection and suffix constraints", () => {
  // 1. Hard policy: **/*.md + orchestrator: src/** -> effective: src/**/*.md (NOT src/**, src/app.js denied!)
  const resMd = intersectPathScopes(["src/**"], ["**/*.md"]);
  assert.deepEqual(resMd, ["src/**/*.md"], "src/** intersected with **/*.md must be ['src/**/*.md']");

  // Validate that src/app.js is rejected while src/readme.md is allowed
  const allowedMd = validateChangedFiles({
    changedFiles: ["src/readme.md", "src/docs/guide.md"],
    allowedPatterns: resMd,
    maxChangedFiles: 10
  });
  assert.equal(allowedMd.allowed, true, "src/readme.md must be allowed");

  const deniedJs = validateChangedFiles({
    changedFiles: ["src/app.js"],
    allowedPatterns: resMd,
    maxChangedFiles: 10
  });
  assert.equal(deniedJs.allowed, false, "src/app.js must be denied");

  // 2. Hard policy: src/**/test/*.js + orchestrator: src/foo/** -> effective: src/foo/**/test/*.js
  const resTest = intersectPathScopes(["src/foo/**"], ["src/**/test/*.js"]);
  assert.deepEqual(resTest, ["src/foo/**/test/*.js"]);

  // 3. Mutually exclusive extensions: **/*.md intersect src/**/*.js -> []
  const resDisjoint = intersectPathScopes(["src/**/*.js"], ["**/*.md"]);
  assert.deepEqual(resDisjoint, [], "Disjoint extension patterns must fail closed to []");

  // 4. Hard policy: lib/* + orchestrator: lib/deep/** -> no intersection ([])
  const res1 = intersectPathScopes(["lib/deep/**"], ["lib/*"]);
  assert.deepEqual(res1, [], "lib/deep/** intersected with lib/* must be []");

  // 5. Hard policy: lib/payments/** + orchestrator: lib/** -> effective intersection is lib/payments/**
  const res2 = intersectPathScopes(["lib/**"], ["lib/payments/**"]);
  assert.deepEqual(res2, ["lib/payments/**"], "lib/** intersected with lib/payments/** must be ['lib/payments/**']");

  // 6. Hard policy: lib/** + orchestrator: lib/payments/** -> effective intersection is lib/payments/**
  const res3 = intersectPathScopes(["lib/payments/**"], ["lib/**"]);
  assert.deepEqual(res3, ["lib/payments/**"], "lib/payments/** intersected with lib/** must be ['lib/payments/**']");

  // 7. Hard policy: lib/* + orchestrator: lib/index.js -> effective intersection is lib/index.js
  const res4 = intersectPathScopes(["lib/index.js"], ["lib/*"]);
  assert.deepEqual(res4, ["lib/index.js"], "lib/index.js intersected with lib/* must be ['lib/index.js']");

  // 8. Effective scope can never authorize a path that hard policy would reject
  const effectiveScope = intersectPathScopes(["lib/payments/**", "infra/**"], ["lib/**"]);
  assert.deepEqual(effectiveScope, ["lib/payments/**"]);

  // Test with validateChangedFiles
  const allowed = validateChangedFiles({
    changedFiles: ["lib/payments/service.js"],
    allowedPatterns: effectiveScope,
    maxChangedFiles: 10
  });
  assert.equal(allowed.allowed, true);

  const rejected = validateChangedFiles({
    changedFiles: ["infra/terraform/main.tf"],
    allowedPatterns: effectiveScope,
    maxChangedFiles: 10
  });
  assert.equal(rejected.allowed, false);
});

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
        "backend-engineer": ["lib/**", "src/**"],
        "startup-cto": ["lib/**", "src/**"]
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

test("TaskAgent-Based Path Scope Resolution: hard scope resolved from taskAgent with fail-closed semantics", () => {
  // 1. persona=startup-cto (pathScopes="**"), taskAgent=backend-engineer (pathScopes="backend/**")
  // Orchestrator scope ["backend/**", "infra/**"] -> effective ["backend/**"]
  const settings = createTestSettings({
    orchestrator: {
      defaultProvider: "codex"
    },
    policy: {
      pathScopes: {
        "backend-engineer": ["backend/**"],
        "startup-cto": ["**"],
        "security-engineer": []
      }
    }
  });

  const planStartupCto = {
    ...sampleValidPlanJson,
    persona: "startup-cto",
    taskAgent: "backend-engineer",
    allowedPaths: ["backend/**", "infra/**"]
  };

  const plan1 = issuePlan(settings, sampleIssue, {
    runtime: {
      spawnSync: () => ({ status: 0, stdout: JSON.stringify(planStartupCto), stderr: "" })
    }
  });

  assert.deepEqual(plan1.allowedPaths, ["backend/**"], "Scope must resolve from taskAgent 'backend-engineer' ['backend/**'], not persona 'startup-cto' ['**']");

  // Assert actual changed file under infra/** is rejected
  const changeValidation = validateChangedFiles({
    changedFiles: ["infra/terraform/main.tf"],
    allowedPatterns: plan1.allowedPaths,
    maxChangedFiles: 10
  });
  assert.equal(changeValidation.allowed, false, "infra/** change must be rejected under effective backend/** scope");

  // 2. Configured pathScopes, but unknown taskAgent -> effective []
  const planUnknownAgent = {
    ...sampleValidPlanJson,
    persona: "startup-cto",
    taskAgent: "unknown-role",
    allowedPaths: ["backend/**"]
  };

  const plan2 = issuePlan(settings, sampleIssue, {
    runtime: {
      spawnSync: () => ({ status: 0, stdout: JSON.stringify(planUnknownAgent), stderr: "" })
    }
  });

  assert.deepEqual(plan2.allowedPaths, [], "Unknown taskAgent must fail closed to []");

  // 3. security-engineer explicitly mapped to [] -> effective []
  const planSecurityAgent = {
    ...sampleValidPlanJson,
    persona: "startup-cto",
    taskAgent: "security-engineer",
    allowedPaths: ["backend/**"]
  };

  const plan3 = issuePlan(settings, sampleIssue, {
    runtime: {
      spawnSync: () => ({ status: 0, stdout: JSON.stringify(planSecurityAgent), stderr: "" })
    }
  });

  assert.deepEqual(plan3.allowedPaths, [], "taskAgent explicitly mapped to [] must have effective allowedPaths = []");
});

test("Pre-Execution No-Write-Scope Guard: empty allowedPaths blocks implementation and rework before side effects or worker spawn", () => {
  const settings = createTestSettings({
    orchestrator: {
      defaultProvider: "codex"
    },
    policy: {
      pathScopes: {
        "backend-engineer": ["lib/**"],
        "security-engineer": []
      }
    }
  });
  const store = getStore(settings);

  // 1. Unknown taskAgent -> effective [] -> handleImplementation(... execute: true) returns blocked
  let spawnCallCount = 0;
  let worktreeCallCount = 0;
  let currentMockPlan = null;
  const mockRuntime = {
    spawnSync: (cmd, args) => {
      if (cmd === "codex" && args && args.includes("exec") && args.includes("--json")) {
        return { status: 0, stdout: JSON.stringify(currentMockPlan || sampleValidPlanJson), stderr: "" };
      }
      if (cmd === "codex" || cmd === "agy") {
        spawnCallCount++;
      }
      if (cmd === "git" && args && args.includes("worktree")) {
        worktreeCallCount++;
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  };

  const planUnknown = {
    ...sampleValidPlanJson,
    persona: "startup-cto",
    taskAgent: "unmapped-agent",
    allowedPaths: ["lib/**"]
  };
  currentMockPlan = planUnknown;

  const resUnknown = handleImplementation(settings, sampleIssue, true, mockRuntime, planUnknown);
  assert.equal(resUnknown.exitCode, 2, "Must exit with blocked code");
  assert.equal(spawnCallCount, 0, "Worker spawn count must be 0");
  assert.equal(worktreeCallCount, 0, "Branch/worktree mutation count must be 0");

  const runUnknown = store.getRun(resUnknown.output.runId);
  assert.equal(runUnknown.state, "blocked");
  assert.match(runUnknown.events.at(-1).payload.reasons[0], /No authorized write scope for taskAgent/i);

  // 2. security-engineer explicitly mapped to [] -> handleImplementation(... execute: true) returns blocked
  const planSecurity = {
    ...sampleValidPlanJson,
    persona: "startup-cto",
    taskAgent: "security-engineer",
    allowedPaths: ["lib/**"]
  };
  currentMockPlan = planSecurity;

  const resSecurity = handleImplementation(settings, sampleIssue, true, mockRuntime, planSecurity);
  assert.equal(resSecurity.exitCode, 2, "Must exit with blocked code");
  assert.equal(spawnCallCount, 0, "Worker spawn count must be 0");
  assert.equal(worktreeCallCount, 0, "Branch/worktree mutation count must be 0");

  const runSecurity = store.getRun(resSecurity.output.runId);
  assert.equal(runSecurity.state, "blocked");
  assert.match(runSecurity.events.at(-1).payload.reasons[0], /No authorized write scope for taskAgent/i);

  // 3. Rework with pinned empty allowedPaths -> rework worker does not start
  const retryableRunId = store.createRun(sampleIssue.key, {
    ...sampleValidPlanJson,
    configSnapshot: {
      ...createConfigSnapshot(settings, sampleIssue, sampleValidPlanJson),
      allowedPaths: [] // Pinned empty scope
    }
  });
  store.transition(retryableRunId, "failed-retryable", {
    attempt: 0,
    reviewOutcome: { reviewerId: "reviewer-1", verdict: "changes-requested", evidence: [] }
  });

  const resRework = handleRework(settings, sampleIssue, true, mockRuntime);
  assert.equal(resRework.exitCode, 2, "Rework must exit with blocked code when pinned scope is []");
  assert.equal(spawnCallCount, 0, "Rework worker must not start");
  assert.equal(worktreeCallCount, 0, "Rework worktree must not mutate");

  // 4. Normal valid taskAgent scope -> unaffected and still executes
  let validWorkerSpawned = false;
  const validRuntime = {
    spawnSync: (cmd, args) => {
      if (cmd === "codex" && args && args.includes("exec") && args.includes("--json")) {
        return { status: 0, stdout: JSON.stringify(planValid), stderr: "" };
      }
      if (cmd === "codex") {
        validWorkerSpawned = true;
        return {
          status: 0,
          stdout: JSON.stringify({
            status: "completed",
            summary: "Implementation completed successfully",
            changed_files: [],
            validation_commands: [],
            blockers: [],
            risks: []
          }),
          stderr: ""
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  };

  const planValid = {
    ...sampleValidPlanJson,
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    allowedPaths: ["lib/**"]
  };

  const resValid = handleImplementation(settings, sampleIssue, true, validRuntime, planValid);
  assert.equal(validWorkerSpawned, true, "Valid scope must allow worker execution");
  assert.equal(resValid.exitCode, 0);
});

// ── 6. Full Stable Orchestrator Decision in Fingerprint ────────────────────────

test("Plan Fingerprint: changing dependencies, parallelSafe, or executor recommendations changes fingerprint", () => {
  const basePlan = {
    issue: "PACE-100",
    summary: "Task",
    persona: "startup-cto",
    taskAgent: "backend-engineer",
    skills: ["api-design"],
    risk: "normal",
    parallelSafe: true,
    allowedPaths: ["lib/**"],
    dependencies: ["PACE-10"],
    rationale: ["Strategic decision"],
    executor: "codex",
    model: "gpt-5",
    modelProfile: "high",
    effort: "high",
    configSnapshot: {
      operatingMode: "supervised",
      autonomy: { implementation: "approval" }
    }
  };

  const baseFingerprint = computePlanFingerprint(basePlan);
  assert.ok(baseFingerprint, "Base fingerprint must be a non-empty string");

  // 1. Changing dependencies changes fingerprint
  const changedDeps = { ...basePlan, dependencies: ["PACE-20"] };
  assert.notEqual(computePlanFingerprint(changedDeps), baseFingerprint, "Changing dependencies must change fingerprint");

  // 2. Changing parallelSafe changes fingerprint
  const changedParallel = { ...basePlan, parallelSafe: false };
  assert.notEqual(computePlanFingerprint(changedParallel), baseFingerprint, "Changing parallelSafe must change fingerprint");

  // 3. Changing executor recommendation changes fingerprint
  const changedExecutor = { ...basePlan, executor: "antigravity" };
  assert.notEqual(computePlanFingerprint(changedExecutor), baseFingerprint, "Changing executor recommendation must change fingerprint");

  // 4. Changing rationale changes fingerprint
  const changedRationale = { ...basePlan, rationale: ["Different rationale"] };
  assert.notEqual(computePlanFingerprint(changedRationale), baseFingerprint, "Changing rationale must change fingerprint");

  // Verify approval for Plan A does NOT authorize changed Plan B
  const settings = createTestSettings({ project: { operatingMode: "supervised" } });
  const store = getStore(settings);
  store.recordApprovalDecision("PACE-100", {
    action: "implementation",
    approved: true,
    plan: basePlan
  });

  const authPlanA = authorizeRuntimeAction(settings, store, {
    issueKey: "PACE-100",
    action: "implementation",
    plan: basePlan
  });
  assert.equal(authPlanA.allowed, true, "Plan A with matching fingerprint should be authorized");

  const authPlanB = authorizeRuntimeAction(settings, store, {
    issueKey: "PACE-100",
    action: "implementation",
    plan: changedDeps
  });
  assert.equal(authPlanB.allowed, false, "Plan B with changed dependencies must NOT be authorized by Plan A approval");
});

// ── 7. Executor Recommendation Semantics ──────────────────────────────────────

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

  assert.equal(plan.execution.provider, "antigravity", "Resolved executor should match recommendation");
  assert.equal(plan.configSnapshot.recommendedExecutor, "antigravity");
  assert.equal(plan.configSnapshot.executorProvider, "antigravity");
});

test("Executor Recommendation Semantics: explicit invalid executor/model/effort fails closed without fallback", () => {
  const settings = createTestSettings({
    orchestrator: {
      defaultProvider: "codex"
    },
    policy: {
      review: { provider: "codex", modelProfile: "high" }
    },
    executor: {
      defaultProvider: "codex",
      providers: {
        codex: { command: ["codex"], defaultModel: "gpt-5", modelProfiles: { high: "gpt-5-pro" }, mode: "accept-edits" }
      }
    }
  });

  // 1. Explicit unknown executor provider fails closed (no fallback to default codex)
  const unknownExecPlan = {
    ...sampleValidPlanJson,
    executor: "unknown-nonexistent-provider"
  };
  assert.throws(
    () => issuePlan(settings, sampleIssue, {
      runtime: { spawnSync: () => ({ status: 0, stdout: JSON.stringify(unknownExecPlan), stderr: "" }) }
    }),
    /Recommended executor provider 'unknown-nonexistent-provider' is not configured/
  );

  // 2. Explicit unsupported model fails closed
  const unsupportedModelPlan = {
    ...sampleValidPlanJson,
    executor: "codex",
    model: "claude-unsupported-model"
  };
  assert.throws(
    () => issuePlan(settings, sampleIssue, {
      runtime: { spawnSync: () => ({ status: 0, stdout: JSON.stringify(unsupportedModelPlan), stderr: "" }) }
    }),
    /Recommended model 'claude-unsupported-model' is not supported/
  );

  // 3. Explicit unsupported effort fails closed
  const unsupportedEffortPlan = {
    ...sampleValidPlanJson,
    executor: "codex",
    effort: "extreme-effort"
  };
  assert.throws(
    () => issuePlan(settings, sampleIssue, {
      runtime: { spawnSync: () => ({ status: 0, stdout: JSON.stringify(unsupportedEffortPlan), stderr: "" }) }
    }),
    /Unsupported effort value 'extreme-effort'/
  );
});

test("Snapshot Metadata Persistence: initial plan metadata survives global orchestrator change and rework snapshot restoration", () => {
  const settings = createTestSettings({
    orchestrator: {
      defaultProvider: "codex",
      providers: {
        codex: { type: "codex", command: ["codex", "exec", "{prompt}"] },
        antigravity: { type: "antigravity", command: ["agy", "exec", "{prompt}"] }
      }
    }
  });

  const customMetadata = {
    architectureTier: "payment-gateway-v2",
    complianceRegime: "PCI-DSS-Level-1",
    stableRef: "arch-doc-ref-987"
  };

  const initialPlanOutput = {
    ...sampleValidPlanJson,
    metadata: customMetadata
  };

  const initialPlan = issuePlan(settings, sampleIssue, {
    runtime: {
      spawnSync: () => ({ status: 0, stdout: JSON.stringify(initialPlanOutput), stderr: "" })
    }
  });

  // Verify initial snapshot persisted metadata
  assert.deepEqual(initialPlan.configSnapshot.metadata, customMetadata);
  assert.deepEqual(initialPlan.metadata, customMetadata);

  // Global orchestrator changes to antigravity
  settings.data.orchestrator.defaultProvider = "antigravity";

  // Rework plan created from originatingRun's snapshot restores the stable metadata
  const reworkPlan = issuePlan(settings, sampleIssue, {
    originatingRun: { payload: { configSnapshot: initialPlan.configSnapshot } }
  });

  assert.deepEqual(reworkPlan.configSnapshot.metadata, customMetadata, "Metadata must survive in configSnapshot");
  assert.deepEqual(reworkPlan.metadata, customMetadata, "Metadata must be restored on the rework plan");
});

// ── 8. Typed Failure Semantics & Fail-Closed Provider Contracts ────────────────

test("Typed Failure Semantics: unknown provider or typo in type (e.g. 'codxe') throws OrchestratorUnavailableError", () => {
  const settingsWithTypo = createTestSettings({
    orchestrator: {
      defaultProvider: "typo-provider",
      providers: {
        "typo-provider": {
          type: "codxe", // typo in type
          command: ["codex", "exec", "{prompt}"]
        }
      }
    }
  });

  assert.throws(
    () => createOrchestratorProvider(settingsWithTypo),
    (err) => err instanceof OrchestratorUnavailableError && err.message.includes("Unsupported orchestrator provider type: 'codxe'")
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
    spawnSync: (cmd, args) => {
      if (cmd === "agy") agyCalled = true;
      const promptArg = args ? args.find(a => typeof a === "string" && a.includes("PACE-")) : "";
      const issueKey = promptArg && promptArg.includes("PACE-200") ? "PACE-200" : "PACE-100";
      return {
        status: 0,
        stdout: JSON.stringify({
          issue: issueKey,
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
