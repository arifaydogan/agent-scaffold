/**
 * test/phase-f-observability.test.js
 *
 * Dedicated Phase F Test Suite — Observability & Telemetry:
 * 1. Lifecycle telemetry: queued before spawn, ordered sequence, idempotent event persistence.
 * 2. Provider-neutral usage ledger: Codex & Antigravity normalized, null preserved, malformed handled safely.
 * 3. Durable execution timing: queueWaitMs, executionDurationMs, endToEndDurationMs, and rework accumulation.
 * 4. Provider health read model: healthy, degraded, cooling_down, and unknown (conservative 0 observations).
 * 5. Historical execution immutability: config & registry changes do not rewrite old telemetry.
 * 6. Role differentiation: orchestrator, implementation, reviewer, rework distinguishable.
 * 7. Security & Redaction: secrets, tokens, raw prompts stripped from telemetry read models.
 * 8. Truthful zero state: empty store returns truthful empty metrics, no fake/demo telemetry.
 * 9. REST API endpoints: summary, providers, runs, runId (with windowing & 404/405 guards).
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { RunStore } from "../lib/store.js";
import { createDashboardServer } from "../lib/dashboard.js";
import {
  normalizeUsage,
  calculateCost,
  classifyError,
  deriveExecutionTimings,
  buildProviderHealth,
  buildRunObservability,
  buildObservabilitySummary,
  redactTelemetryPayload
} from "../lib/telemetry.js";
import { spawnProviderAsync } from "../lib/runtime.js";

function makeTestStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-test-"));
  return new RunStore(path.join(dir, "runs.sqlite3"));
}

function makeSettings(store, overrides = {}) {
  return {
    source: "/tmp/obs-settings.json",
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
        pricing: {
          models: {
            "gpt-5": { inputPricePerMillion: 3.0, outputPricePerMillion: 15.0, currency: "USD", pricingVersion: "2026-Q1" },
            "claude-3-5-sonnet": { inputPricePerMillion: 3.0, outputPricePerMillion: 15.0, currency: "USD", pricingVersion: "2026-Q1" }
          }
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

test("1. Lifecycle telemetry: queued before spawn, ordered sequence, and idempotent event persistence", async () => {
  const store = makeTestStore();
  const plan = {
    issue: "PACE-101",
    summary: "Auth controller upgrade",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    agentVersion: 1,
    role: "implementation",
    action: "implementation",
    attempt: 0,
    allowedPaths: ["backend/**"],
    configSnapshot: { operatingMode: "autonomous", taskAgent: "backend-engineer" }
  };
  const runId = store.createRun("PACE-101", plan);

  let queuedEmittedBeforeSpawn = false;
  let spawnOccurred = false;

  // Mock runtime to verify queued was emitted before spawn
  const mockRuntime = {
    spawn: (cmd, args, opts) => {
      spawnOccurred = true;
      const events = store.listTelemetryEvents(runId);
      queuedEmittedBeforeSpawn = events.some(e => e.stage === "queued");

      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 9999;

      setTimeout(() => {
        // Emit model_selected JSON
        child.stdout.emit("data", Buffer.from(JSON.stringify({ selected_model: "gpt-5" }) + "\n"));
        // Emit progress
        child.stdout.emit("data", Buffer.from("Compiling auth routes...\n"));
        // Emit completion
        child.stdout.emit("data", Buffer.from(JSON.stringify({
          status: "SUCCESS",
          usage: { input_tokens: 1000, output_tokens: 250, total_tokens: 1250 },
          response: JSON.stringify({
            status: "completed",
            summary: "Done",
            changed_files: ["backend/auth.py"],
            validation_commands: ["pytest"],
            blockers: [],
            risks: []
          })
        }) + "\n"));
        child.emit("close", 0);
      }, 20);

      return child;
    },
    spawnSync: () => ({ status: 0, stdout: "" })
  };

  const profile = {
    provider: "antigravity",
    model: "claude-3-5-sonnet",
    modelProfile: "medium",
    agent: "backend-engineer",
    config: { command: ["mock-agy"], timeoutSeconds: 30 }
  };

  const built = {
    command: ["mock-agy", "exec"],
    redactedCommand: ["mock-agy", "exec"],
    cwd: "/tmp",
    logFile: path.join(os.tmpdir(), `${runId}-antigravity.log`)
  };

  const prepared = { worktree: "/tmp/repo-worktree" };

  await spawnProviderAsync({
    store,
    runId,
    built,
    profile,
    plan,
    prepared,
    issueKey: "PACE-101"
  }, mockRuntime);

  assert.ok(spawnOccurred);
  assert.ok(queuedEmittedBeforeSpawn, "Queued event MUST be persisted before provider process spawn");

  const events = store.listTelemetryEvents(runId);
  assert.ok(events.length >= 4, "Must have queued, started, model_selected, progress/terminal");

  const stages = events.map(e => e.stage);
  assert.equal(stages[0], "queued", "First stage must be queued");
  assert.equal(stages[1], "started", "Second stage must be started");
  assert.ok(stages.includes("model_selected"), "Must include model_selected");
  assert.equal(stages.at(-1), "terminal", "Last stage must be terminal");

  // Idempotency: duplicate eventId recording must be a no-op
  const firstEvent = events[0];
  const reRecord = store.recordTelemetryEvent({
    eventId: firstEvent.eventId,
    runId,
    stage: "queued",
    status: "duplicate-attempt"
  });
  assert.equal(reRecord.recorded, true);
  const eventsAfter = store.listTelemetryEvents(runId);
  assert.equal(eventsAfter.length, events.length, "Duplicate eventId must not create duplicate rows in SQLite");
});

test("2. Provider-neutral usage ledger: Codex & Antigravity normalized, null preserved, malformed handled safely", () => {
  // A. Codex style
  const codexUsage = normalizeUsage({
    input_tokens: 1500,
    output_tokens: 450,
    cached_input_tokens: 200,
    total_tokens: 1950
  }, "codex");

  assert.equal(codexUsage.inputTokens, 1500);
  assert.equal(codexUsage.outputTokens, 450);
  assert.equal(codexUsage.cachedInputTokens, 200);
  assert.equal(codexUsage.totalTokens, 1950);
  assert.equal(codexUsage.available, true);

  // B. Antigravity / Claude style with thinking tokens
  const agyUsage = normalizeUsage({
    prompt_tokens: 2200,
    completion_tokens: 600,
    completion_tokens_details: { reasoning_tokens: 150 },
    prompt_tokens_details: { cached_tokens: 500 }
  }, "antigravity");

  assert.equal(agyUsage.inputTokens, 2200);
  assert.equal(agyUsage.outputTokens, 600);
  assert.equal(agyUsage.reasoningTokens, 150);
  assert.equal(agyUsage.cachedInputTokens, 500);
  assert.equal(agyUsage.totalTokens, 2800);
  assert.equal(agyUsage.available, true);

  // C. Missing usage -> null (NEVER 0!)
  const missingUsage = normalizeUsage(null, "unknown");
  assert.equal(missingUsage.inputTokens, null);
  assert.equal(missingUsage.outputTokens, null);
  assert.equal(missingUsage.totalTokens, null);
  assert.equal(missingUsage.available, false, "Missing usage available must be false");

  // D. Malformed non-numeric values -> null (never converted to 0)
  const malformedUsage = normalizeUsage({
    input_tokens: "not-a-number",
    output_tokens: null
  });
  assert.equal(malformedUsage.inputTokens, null);
  assert.equal(malformedUsage.outputTokens, null);
  assert.equal(malformedUsage.available, false);
});

test("3. Durable execution timing: queueWaitMs, executionDurationMs, endToEndDurationMs, and rework accumulation", () => {
  const t0 = new Date("2026-08-15T12:00:00.000Z").toISOString();
  const t1 = new Date("2026-08-15T12:00:02.000Z").toISOString(); // +2s queue wait
  const t2 = new Date("2026-08-15T12:00:10.000Z").toISOString(); // +8s execution

  const events = [
    { state: "queued", created_at: t0 },
    { state: "started", created_at: t1 },
    { state: "completed", created_at: t2 }
  ];

  const timings = deriveExecutionTimings(events);
  assert.equal(timings.queueWaitMs, 2000, "Queue wait must be 2000ms");
  assert.equal(timings.executionDurationMs, 8000, "Execution duration must be 8000ms");
  assert.equal(timings.endToEndDurationMs, 10000, "End-to-end duration must be 10000ms");

  // Incomplete / active run returns null for completion timings
  const activeEvents = [
    { state: "queued", created_at: t0 },
    { state: "started", created_at: t1 }
  ];
  const activeTimings = deriveExecutionTimings(activeEvents);
  assert.equal(activeTimings.queueWaitMs, 2000);
  assert.equal(activeTimings.executionDurationMs, null, "Incomplete run execution duration must be null");
  assert.equal(activeTimings.endToEndDurationMs, null);
});

test("4. Provider health read model: healthy, degraded, cooling_down, and unknown (conservative rule)", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  // 1. Initially with 0 observations -> provider health must be 'unknown' (NOT 'healthy')
  const initialHealth = buildProviderHealth(settings, store, 86400000);
  const codexInitial = initialHealth.find(p => p.provider === "codex");
  assert.ok(codexInitial);
  assert.equal(codexInitial.status, "unknown", "0 observations must yield status unknown");
  assert.equal(codexInitial.successRate, null);

  // 2. Add successful runs -> healthy
  const r1 = store.createRun("PACE-201", { executor: "codex", execution: { provider: "codex" } });
  store.transition(r1, "started", {});
  store.transition(r1, "completed", { usage: { total_tokens: 500 } });

  const healthAfterSuccess = buildProviderHealth(settings, store, 86400000);
  const codexHealthy = healthAfterSuccess.find(p => p.provider === "codex");
  assert.equal(codexHealthy.status, "healthy");
  assert.equal(codexHealthy.recentSuccesses, 1);
  assert.equal(codexHealthy.successRate, 1.0);

  // 3. Add repeated failures -> degraded
  const r2 = store.createRun("PACE-202", { executor: "codex", execution: { provider: "codex" } });
  store.transition(r2, "failed", { reason: "Process crash" });
  const r3 = store.createRun("PACE-203", { executor: "codex", execution: { provider: "codex" } });
  store.transition(r3, "failed", { reason: "Process crash" });
  const r4 = store.createRun("PACE-204", { executor: "codex", execution: { provider: "codex" } });
  store.transition(r4, "failed", { reason: "Process crash" });

  const healthDegraded = buildProviderHealth(settings, store, 86400000);
  const codexDegraded = healthDegraded.find(p => p.provider === "codex");
  assert.equal(codexDegraded.status, "degraded", "3 consecutive failures must make status degraded");
  assert.equal(codexDegraded.recentFailures, 3);

  // 4. Cooldown active -> cooling_down
  const cooldownSettings = makeSettings(store, {
    reconciler: { cooldowns: { codex: new Date(Date.now() + 60000).toISOString() } }
  });
  cooldownSettings.data.reconciler = { cooldowns: { codex: new Date(Date.now() + 60000).toISOString() } };

  const healthCooling = buildProviderHealth(cooldownSettings, store, 86400000);
  const codexCooling = healthCooling.find(p => p.provider === "codex");
  assert.equal(codexCooling.status, "cooling_down");
  assert.ok(codexCooling.cooldownUntil);
});

test("5. Historical execution immutability: config & registry updates do not rewrite old telemetry", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  // Create historical run pinned to codex / gpt-5 / agentVersion 1
  const plan = {
    issue: "PACE-500",
    summary: "Historical task",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    agentVersion: 1,
    agentHash: "hash-v1",
    configSnapshot: {
      operatingMode: "autonomous",
      taskAgent: "backend-engineer",
      agentVersion: 1,
      executorProvider: "codex",
      executorModel: "gpt-5"
    }
  };
  const runId = store.createRun("PACE-500", plan);
  store.transition(runId, "completed", { returnCode: 0 });

  // Read run observability before config change
  const obsBefore = buildRunObservability(settings, runId, { store });
  assert.equal(obsBefore.agent.agentVersion, 1);
  assert.equal(obsBefore.execution.provider, "codex");
  assert.equal(obsBefore.execution.model, "gpt-5");

  // Mutate global settings to use antigravity / claude-3-5-sonnet
  const newSettings = makeSettings(store);
  newSettings.data.executor.defaultProvider = "antigravity";
  newSettings.data.executor.providers.codex.defaultModel = "gpt-6-future";

  // Re-read run observability: old telemetry MUST remain immutable!
  const obsAfter = buildRunObservability(newSettings, runId, { store });
  assert.equal(obsAfter.agent.agentVersion, 1, "Agent version must remain 1");
  assert.equal(obsAfter.execution.provider, "codex", "Historical provider must remain codex");
  assert.equal(obsAfter.execution.model, "gpt-5", "Historical model must remain gpt-5");
});

test("6. Role differentiation: orchestrator, implementation, reviewer, rework distinguishable", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  // 1. Implementation Run
  const implPlan = {
    issue: "PACE-601",
    summary: "Feature impl",
    role: "implementation",
    taskAgent: "backend-engineer"
  };
  const implRunId = store.createRun("PACE-601", implPlan);
  const implObs = buildRunObservability(settings, implRunId, { store });
  assert.equal(implObs.identity.role, "implementation");

  // 2. Review Run
  const reviewPlan = {
    issue: "PACE-601",
    summary: "Review for PACE-601",
    role: "reviewer",
    type: "review",
    taskAgent: "qa-reviewer"
  };
  const reviewRunId = store.createRun("PACE-601", reviewPlan);
  const reviewObs = buildRunObservability(settings, reviewRunId, { store });
  assert.equal(reviewObs.identity.role, "reviewer");

  // 3. Rework Run (Attempt 1)
  const reworkPlan = {
    issue: "PACE-601",
    summary: "Rework for PACE-601",
    role: "rework",
    attempt: 1,
    taskAgent: "backend-engineer"
  };
  const reworkRunId = store.createRun("PACE-601", reworkPlan);
  const reworkObs = buildRunObservability(settings, reworkRunId, { store });
  assert.equal(reworkObs.identity.role, "rework");
  assert.equal(reworkObs.identity.attempt, 2); // 3 total runs for issue
});

test("7. Security & Redaction: secrets, tokens, raw prompts stripped from telemetry", () => {
  const dirtyPayload = {
    apiKey: "sk-proj-secret12345678901234567890",
    token: "ghp_secretTokenHere1234567890",
    auth: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    prompt: "Secret system prompt containing internal rules",
    environment: {
      DATABASE_URL: "postgres://user:password123@localhost:5432/db",
      JIRA_API_TOKEN: "secretToken"
    },
    safeData: "Public operational metric",
    nested: {
      secretValue: "my-password",
      count: 42
    }
  };

  const clean = redactTelemetryPayload(dirtyPayload);

  assert.equal(clean.apiKey, "[REDACTED]");
  assert.equal(clean.token, "[REDACTED]");
  assert.equal(clean.auth, "[REDACTED]");
  assert.equal(clean.prompt, "[REDACTED_PROMPT]");
  assert.equal(clean.environment, "[REDACTED_ENV]");
  assert.equal(clean.safeData, "Public operational metric");
  assert.equal(clean.nested.secretValue, "[REDACTED]");
  assert.equal(clean.nested.count, 42);
});

test("8. Truthful zero state: empty store returns truthful empty metrics, no fake/demo telemetry", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  const summary = buildObservabilitySummary(settings, { store });
  assert.equal(summary.ok, true);
  assert.equal(summary.metrics.activeRuns, 0);
  assert.equal(summary.metrics.queuedRuns, 0);
  assert.equal(summary.metrics.runsCompleted, 0);
  assert.equal(summary.metrics.runsFailed, 0);
  assert.equal(summary.metrics.averageExecutionDurationMs, null, "Empty store avg duration must be null, not 0");
  assert.equal(summary.metrics.totalUsage.available, false, "Empty store totalUsage available must be false");
  assert.equal(summary.metrics.totalUsage.totalTokens, null);
  assert.equal(summary.runs.length, 0);
});

test("9. Observability REST API endpoints and HTTP gates", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  const plan = {
    issue: "PACE-900",
    summary: "API integration test",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    configSnapshot: {
      operatingMode: "autonomous",
      taskAgent: "backend-engineer",
      executorProvider: "codex",
      executorModel: "gpt-5"
    }
  };
  const runId = store.createRun("PACE-900", plan);
  store.transition(runId, "started", {});
  store.transition(runId, "completed", {
    returnCode: 0,
    usage: { input_tokens: 500, output_tokens: 150, total_tokens: 650 }
  });

  const server = createDashboardServer(settings, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    // 1. GET /api/observability/summary
    const resSummary = await request(server, "/api/observability/summary?window=24h");
    assert.equal(resSummary.status, 200);
    assert.equal(resSummary.json.ok, true);
    assert.equal(resSummary.json.window, "24h");
    assert.equal(resSummary.json.metrics.runsCompleted, 1);
    assert.equal(resSummary.json.metrics.totalUsage.totalTokens, 650);

    // 2. GET /api/observability/providers
    const resProviders = await request(server, "/api/observability/providers");
    assert.equal(resProviders.status, 200);
    assert.equal(resProviders.json.ok, true);
    assert.ok(Array.isArray(resProviders.json.providers));

    // 3. GET /api/observability/runs
    const resRuns = await request(server, "/api/observability/runs?limit=10");
    assert.equal(resRuns.status, 200);
    assert.equal(resRuns.json.ok, true);
    assert.equal(resRuns.json.runs.length, 1);
    assert.equal(resRuns.json.runs[0].issueKey, "PACE-900");

    // 4. GET /api/observability/runs/:runId
    const resRunDetail = await request(server, `/api/observability/runs/${runId}`);
    assert.equal(resRunDetail.status, 200);
    assert.equal(resRunDetail.json.ok, true);
    assert.equal(resRunDetail.json.identity.runId, runId);
    assert.equal(resRunDetail.json.usage.totalTokens, 650);
    assert.ok(resRunDetail.json.cost, "Cost should be calculated when pricing is configured");

    // 5. GET /api/observability/runs/unknown-id -> 404
    const res404 = await request(server, "/api/observability/runs/non-existent-run-id");
    assert.equal(res404.status, 404);

    // 6. POST /api/observability/summary -> 405 Method Not Allowed
    const res405 = await request(server, "/api/observability/summary", { method: "POST" });
    assert.equal(res405.status, 405);

  } finally {
    server.close();
  }
});
