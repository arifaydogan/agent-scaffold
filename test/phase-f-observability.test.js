/**
 * test/phase-f-observability.test.js
 *
 * Dedicated Phase F Test Suite — Observability & Telemetry Canonical Hardening:
 * 1. Canonical source: buildRunObservability consumes telemetry_events, metadata appears in API.
 * 2. Idempotency & Monotonicity in Store: transaction, duplicate eventId no-op, terminal locking, sequence ordering.
 * 3. Instrument every execution path: sync and async reviewers produce queued -> started -> terminal with role="reviewer".
 * 4. Orchestrator provider execution: real mocked CLI/Codex orchestrator produces queued -> started -> terminal.
 * 5. Truthful token normalization: partial usage does not infer total, null preserved.
 * 6. Truthful cost accounting: cost is null for partial usage, historical cost pinned across config changes.
 * 7. Real durable provider cooldown: reuses activeProviderCooldowns(store), cooling_down status reflected.
 * 8. Strict attempt semantics: identity.attempt comes from plan.attempt, totalAttempts excludes reviews.
 * 9. Pre-persistence redaction & API safety: secrets/prompts sanitized before SQLite and in serialized API response.
 * 10. Aggregate observability summary & zero state: windowing (1h, 24h, 7d), empty store returns truthful empty metrics.
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
import { spawnProviderAsync, handleReview, createConfigSnapshot, issuePlan } from "../lib/runtime.js";
import { CliOrchestratorProvider, CodexOrchestratorProvider } from "../lib/orchestrator.js";

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

// ── Test 1: Canonical source & API verification ──────────────────────────────

test("1. Canonical telemetry source: buildRunObservability consumes telemetry_events and API reflects it exactly", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  const plan = {
    issue: "PACE-101",
    summary: "Refactor auth controller",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    agentVersion: 2,
    agentHash: "sha256-v2",
    role: "implementation",
    action: "implementation",
    attempt: 0,
    configSnapshot: {
      operatingMode: "autonomous",
      taskAgent: "backend-engineer",
      agentVersion: 2,
      executorProvider: "codex",
      executorModel: "gpt-5"
    }
  };
  const runId = store.createRun("PACE-101", plan);

  // Record canonical telemetry events directly in telemetry_events table
  const rec1 = store.recordTelemetryEvent({
    eventId: `telem-${runId}-1-queued`,
    runId,
    issueKey: "PACE-101",
    role: "implementation",
    action: "implementation",
    attempt: 0,
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    agentVersion: 2,
    agentHash: "sha256-v2",
    provider: "codex",
    model: "gpt-5",
    stage: "queued",
    status: "queued",
    sequence: 1
  });
  assert.equal(rec1.recorded, true);

  const rec2 = store.recordTelemetryEvent({
    eventId: `telem-${runId}-2-started`,
    runId,
    issueKey: "PACE-101",
    role: "implementation",
    action: "implementation",
    attempt: 0,
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    provider: "codex",
    model: "gpt-5",
    stage: "started",
    status: "running",
    sequence: 2
  });
  assert.equal(rec2.recorded, true);

  const rec3 = store.recordTelemetryEvent({
    eventId: `telem-${runId}-term-ok`,
    runId,
    issueKey: "PACE-101",
    role: "implementation",
    action: "implementation",
    attempt: 0,
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    provider: "codex",
    model: "gpt-5",
    stage: "terminal",
    status: "completed",
    sequence: 999,
    durationMs: 4500,
    usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, available: true }
  });
  assert.equal(rec3.recorded, true);

  // Transition run in business store
  store.transition(runId, "completed", { returnCode: 0 });

  // Verify through buildRunObservability
  const obs = buildRunObservability(settings, runId, { store });
  assert.ok(obs);
  assert.equal(obs.identity.runId, runId);
  assert.equal(obs.identity.role, "implementation");
  assert.equal(obs.agent.agentVersion, 2);
  assert.equal(obs.usage.totalTokens, 1500);
  assert.equal(obs.events.length, 3);
  assert.equal(obs.events[0].eventId, `telem-${runId}-1-queued`);

  // Verify through HTTP API: GET /api/observability/runs/:runId
  const server = createDashboardServer(settings, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const res = await request(server, `/api/observability/runs/${runId}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.identity.runId, runId);
    assert.equal(res.json.identity.role, "implementation");
    assert.equal(res.json.agent.agentVersion, 2);
    assert.equal(res.json.usage.inputTokens, 1200);
    assert.equal(res.json.usage.outputTokens, 300);
    assert.equal(res.json.usage.totalTokens, 1500);
    assert.equal(res.json.events.length, 3);
    assert.equal(res.json.events[2].eventId, `telem-${runId}-term-ok`);
  } finally {
    server.close();
  }
});

// ── Test 2: Idempotency & Monotonicity in Store ──────────────────────────────

test("2. Store idempotency and lifecycle monotonicity guarantees", () => {
  const store = makeTestStore();
  const runId = store.createRun("PACE-201", { issue: "PACE-201" });

  // 1. Missing eventId throws
  assert.throws(
    () => store.recordTelemetryEvent({ runId, stage: "queued" }),
    /explicit, deterministic eventId/
  );

  // 2. Non-existent runId throws
  assert.throws(
    () => store.recordTelemetryEvent({ eventId: "evt-fake", runId: "non-existent-run", stage: "queued" }),
    /does not exist/
  );

  // 3. Negative lifecycle tests:
  const badRunId = store.createRun("PACE-202", { issue: "PACE-202" });

  // A. started as first event -> rejected
  const rBadStarted = store.recordTelemetryEvent({
    eventId: "bad-started",
    runId: badRunId,
    stage: "started",
    status: "running",
    sequence: 1
  });
  assert.equal(rBadStarted.recorded, false, "started as first event without queued must be rejected");

  // B. progress before started -> rejected
  const rBadProgress = store.recordTelemetryEvent({
    eventId: "bad-progress",
    runId: badRunId,
    stage: "progress",
    status: "running",
    sequence: 1
  });
  assert.equal(rBadProgress.recorded, false, "progress before started must be rejected");

  // C. terminal as first event -> rejected
  const rBadTerminal = store.recordTelemetryEvent({
    eventId: "bad-terminal",
    runId: badRunId,
    stage: "terminal",
    status: "completed",
    sequence: 999
  });
  assert.equal(rBadTerminal.recorded, false, "terminal as first event without queued/started must be rejected");

  // 4. Proper lifecycle progression on valid runId
  const r1 = store.recordTelemetryEvent({
    eventId: "evt-1",
    runId,
    stage: "queued",
    status: "queued",
    sequence: 1
  });
  assert.deepEqual(r1, { eventId: "evt-1", recorded: true });

  // 5. Progress before started (even after queued) -> rejected
  const rProgBeforeStarted = store.recordTelemetryEvent({
    eventId: "evt-prog-early",
    runId,
    stage: "progress",
    sequence: 2
  });
  assert.equal(rProgBeforeStarted.recorded, false, "progress before started must be rejected");

  // 6. Duplicate eventId returns recorded: false with no new row
  const rDuplicate = store.recordTelemetryEvent({
    eventId: "evt-1",
    runId,
    stage: "queued",
    status: "queued",
    sequence: 1
  });
  assert.deepEqual(rDuplicate, { eventId: "evt-1", recorded: false });
  assert.equal(store.listTelemetryEvents(runId).length, 1);

  // 7. Started after queued -> recorded: true
  const r2 = store.recordTelemetryEvent({
    eventId: "evt-2",
    runId,
    stage: "started",
    status: "running",
    sequence: 2
  });
  assert.equal(r2.recorded, true);

  // 8. Sequence cannot move backwards
  const rBackwards = store.recordTelemetryEvent({
    eventId: "evt-backwards",
    runId,
    stage: "progress",
    sequence: 1 // less than current max sequence 2
  });
  assert.equal(rBackwards.recorded, false);

  // 9. Terminal event after queued & started -> recorded: true
  const rTerm = store.recordTelemetryEvent({
    eventId: "evt-term-1",
    runId,
    stage: "terminal",
    status: "completed",
    sequence: 999,
    usage: { inputTokens: 500, outputTokens: 100 }
  });
  assert.equal(rTerm.recorded, true);

  // 10. Reject any event after terminal
  const rPostTerminal = store.recordTelemetryEvent({
    eventId: "evt-post-term",
    runId,
    stage: "progress",
    sequence: 1000
  });
  assert.equal(rPostTerminal.recorded, false);

  // 11. Reject duplicate terminal with a different eventId
  const rDupTerm = store.recordTelemetryEvent({
    eventId: "evt-term-2",
    runId,
    stage: "terminal",
    status: "failed",
    sequence: 999
  });
  assert.equal(rDupTerm.recorded, false);

  // Total events must remain exactly 3 (queued, started, terminal)
  const allEvents = store.listTelemetryEvents(runId);
  assert.equal(allEvents.length, 3);
  assert.equal(allEvents[0].stage, "queued");
  assert.equal(allEvents[1].stage, "started");
  assert.equal(allEvents[2].stage, "terminal");
});

// ── Test 3: Instrument every provider execution path (Worker & Reviewer) ─────

test("3. Reviewer execution paths: sync Codex and async Antigravity both record role=reviewer", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  // A. Synchronous Codex Reviewer
  const syncIssue = {
    key: "PACE-301",
    summary: "Auth review sync",
    description: "Acceptance Criteria:\n- Code is clean\n- Tests pass",
    canonicalState: "review",
    labels: ["agent-ready"]
  };
  const syncSettings = makeSettings(store, {
    policy: {
      review: { provider: "codex", modelProfile: "medium" }
    }
  });

  const baseRun1 = store.createRun("PACE-301", {
    issue: "PACE-301",
    role: "implementation",
    taskAgent: "backend-engineer",
    configSnapshot: { operatingMode: "autonomous", taskAgent: "backend-engineer" }
  });
  store.transition(baseRun1, "review-queued", {
    implementationSha: "1111111111111111111111111111111111111111"
  });

  let syncQueuedBeforeSpawn = false;
  let syncSpawnOccurred = false;

  const syncRuntime = {
    spawnSync: (cmd, args = [], opts) => {
      if (cmd === "git") {
        if (args.includes("status")) return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "1111111111111111111111111111111111111111\n", stderr: "" };
      }
      syncSpawnOccurred = true;
      const runs = store.listRunsDetailed(10);
      const revRun = runs.find(r => r.issue_key === "PACE-301" && r.state !== "review-queued");
      if (revRun) {
        const events = store.listTelemetryEvents(revRun.id);
        syncQueuedBeforeSpawn = events.some(e => e.stage === "queued" && e.role === "reviewer");
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "SUCCESS",
          result: { verdict: "clean", evidence: [] },
          usage: { input_tokens: 800, output_tokens: 200, total_tokens: 1000 }
        }),
        stderr: ""
      };
    },
    spawn: () => ({ on: () => {} })
  };

  const syncReviewOutcome = await handleReview(syncSettings, syncIssue, true, syncRuntime);
  assert.ok(syncSpawnOccurred, "Sync reviewer process spawn must have occurred");
  assert.ok(syncQueuedBeforeSpawn, "Sync reviewer must record queued telemetry BEFORE spawnSync");

  const syncRunId = syncReviewOutcome.output.runId;
  const syncTelem = store.listTelemetryEvents(syncRunId);
  assert.ok(syncTelem.length >= 3, "Must have queued, started, terminal");
  assert.equal(syncTelem[0].stage, "queued");
  assert.equal(syncTelem[0].role, "reviewer");
  assert.equal(syncTelem[0].action, "review");
  assert.equal(syncTelem.at(-1).stage, "terminal");
  assert.equal(syncTelem.at(-1).role, "reviewer");
  assert.equal(syncTelem.at(-1).status, "completed");

  // B. Asynchronous Antigravity Reviewer
  const asyncIssue = {
    key: "PACE-302",
    summary: "Auth review async",
    description: "Acceptance Criteria:\n- Code is clean\n- Tests pass",
    canonicalState: "review",
    labels: ["agent-ready"]
  };
  const asyncSettings = makeSettings(store, {
    policy: {
      review: { provider: "antigravity", modelProfile: "medium" }
    }
  });

  const baseRun2 = store.createRun("PACE-302", {
    issue: "PACE-302",
    role: "implementation",
    taskAgent: "backend-engineer",
    configSnapshot: { operatingMode: "autonomous", taskAgent: "backend-engineer" }
  });
  store.transition(baseRun2, "review-queued", {
    implementationSha: "2222222222222222222222222222222222222222"
  });

  const asyncRuntime = {
    spawnSync: (cmd, args = []) => {
      if (cmd === "git") {
        if (args.includes("status")) return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "2222222222222222222222222222222222222222\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    spawn: (cmd, args, opts) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 8888;
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({
          status: "SUCCESS",
          response: JSON.stringify({ verdict: "clean", evidence: [] }),
          usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 }
        }) + "\n"));
        child.emit("close", 0);
      }, 10);
      return child;
    }
  };

  const asyncReviewOutcome = await handleReview(asyncSettings, asyncIssue, true, asyncRuntime);
  const asyncRunId = asyncReviewOutcome.output.runId;
  const asyncTelem = store.listTelemetryEvents(asyncRunId);
  assert.ok(asyncTelem.length >= 3);
  assert.equal(asyncTelem[0].stage, "queued");
  assert.equal(asyncTelem[0].role, "reviewer");
  assert.equal(asyncTelem[0].action, "review");
  assert.equal(asyncTelem.at(-1).stage, "terminal");
  assert.equal(asyncTelem.at(-1).role, "reviewer");
  assert.equal(asyncTelem.at(-1).status, "completed");
});

// ── Test 4: Instrument orchestrator provider execution ───────────────────────

test("4. Orchestrator provider execution produces truthful queued -> started -> terminal telemetry", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  let orchestratorQueuedBeforeSpawn = false;
  let orchestratorSpawnOccurred = false;

  const mockOrchestratorRuntime = {
    spawnSync: (cmd, args, opts) => {
      orchestratorSpawnOccurred = true;
      const runs = store.listRunsDetailed(10);
      const planRun = runs.find(r => r.issue_key === "PACE-401");
      if (planRun) {
        const events = store.listTelemetryEvents(planRun.id);
        orchestratorQueuedBeforeSpawn = events.some(e => e.stage === "queued" && e.role === "orchestrator");
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          issue: "PACE-401",
          summary: "Orchestrated backend task",
          persona: "architect",
          taskAgent: "backend-engineer",
          skills: ["minimal-change"],
          risk: "low",
          parallelSafe: true,
          allowedPaths: ["backend/**"],
          dependencies: [],
          rationale: ["Strategic routing via CLI orchestrator"],
          usage: { input_tokens: 450, output_tokens: 150, total_tokens: 600 }
        }),
        stderr: ""
      };
    }
  };

  const provider = new CliOrchestratorProvider("codex", {
    command: ["codex", "exec", "{prompt}"]
  }, mockOrchestratorRuntime);

  const issue = { key: "PACE-401", summary: "Orchestrated backend task" };
  const plan = provider.plan(issue, { store, settings });

  assert.ok(orchestratorSpawnOccurred, "Orchestrator CLI spawn must have occurred");
  assert.ok(orchestratorQueuedBeforeSpawn, "Orchestrator queued event must be recorded BEFORE spawnSync");
  assert.ok(plan.metadata?.planningRunId, "Planning run ID must be attached to metadata");

  const planningRunId = plan.metadata.planningRunId;
  const events = store.listTelemetryEvents(planningRunId);
  assert.ok(events.length >= 3, "Orchestrator run must record queued, started, terminal");
  assert.equal(events[0].stage, "queued");
  assert.equal(events[0].role, "orchestrator");
  assert.equal(events[0].action, "planning");
  assert.equal(events[1].stage, "started");
  assert.equal(events[2].stage, "terminal");
  assert.equal(events[2].status, "completed");
  assert.equal(events[2].usage.totalTokens, 600);

  // B. Orchestrator returns malformed JSON -> throws OrchestratorParseError, terminal(failed) recorded
  const malformedRuntime = {
    spawnSync: () => ({ status: 0, stdout: "{ malformed json: not valid ...", stderr: "" })
  };
  const malformedProvider = new CliOrchestratorProvider("codex", { command: ["codex"] }, malformedRuntime);
  const issueMalformed = { key: "PACE-402", summary: "Malformed plan" };
  assert.throws(
    () => malformedProvider.plan(issueMalformed, { store, settings }),
    (err) => err.name === "OrchestratorParseError"
  );
  const planRunsMalformed = store.listRunsDetailed(10).filter(r => r.issue_key === "PACE-402");
  assert.equal(planRunsMalformed.length, 1);
  assert.equal(planRunsMalformed[0].state, "failed");
  const malformedTelem = store.listTelemetryEvents(planRunsMalformed[0].id);
  assert.equal(malformedTelem.length, 3);
  assert.equal(malformedTelem[0].stage, "queued");
  assert.equal(malformedTelem[1].stage, "started");
  assert.equal(malformedTelem[2].stage, "terminal");
  assert.equal(malformedTelem[2].status, "failed");
  assert.equal(malformedTelem[2].error?.category, "telemetry_parse_error");

  // C. Orchestrator returns invalid plan schema -> throws OrchestratorValidationError, terminal(failed) recorded
  const invalidSchemaRuntime = {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        issue: "PACE-403",
        summary: "Invalid persona task",
        persona: "non-existent-persona",
        taskAgent: "non-existent-persona"
      }),
      stderr: ""
    })
  };
  const invalidSchemaProvider = new CliOrchestratorProvider("codex", { command: ["codex"] }, invalidSchemaRuntime);
  const issueInvalid = { key: "PACE-403", summary: "Invalid schema plan" };
  assert.throws(
    () => invalidSchemaProvider.plan(issueInvalid, { store, settings }),
    (err) => err.name === "OrchestratorValidationError"
  );
  const planRunsInvalid = store.listRunsDetailed(10).filter(r => r.issue_key === "PACE-403");
  assert.equal(planRunsInvalid.length, 1);
  assert.equal(planRunsInvalid[0].state, "failed");
  const invalidTelem = store.listTelemetryEvents(planRunsInvalid[0].id);
  assert.equal(invalidTelem.length, 3);
  assert.equal(invalidTelem[0].stage, "queued");
  assert.equal(invalidTelem[1].stage, "started");
  assert.equal(invalidTelem[2].stage, "terminal");
  assert.equal(invalidTelem[2].status, "failed");
  assert.equal(invalidTelem[2].error?.category, "policy_block");
});

// ── Test 5: Truthful token normalization (Partial usage) ─────────────────────

test("5. Truthful token normalization: partial usage never infers totalTokens", () => {
  // A. Only inputTokens known -> totalTokens must be null
  const partialInputOnly = normalizeUsage({ input_tokens: 1000, output_tokens: null });
  assert.equal(partialInputOnly.inputTokens, 1000);
  assert.equal(partialInputOnly.outputTokens, null);
  assert.equal(partialInputOnly.totalTokens, null, "totalTokens must be null if outputTokens is unknown");
  assert.equal(partialInputOnly.available, true);

  // B. Only outputTokens known -> totalTokens must be null
  const partialOutputOnly = normalizeUsage({ input_tokens: null, output_tokens: 250 });
  assert.equal(partialOutputOnly.inputTokens, null);
  assert.equal(partialOutputOnly.outputTokens, 250);
  assert.equal(partialOutputOnly.totalTokens, null, "totalTokens must be null if inputTokens is unknown");
  assert.equal(partialOutputOnly.available, true);

  // C. Both input and output known -> totalTokens computed
  const fullBoth = normalizeUsage({ input_tokens: 1000, output_tokens: 250 });
  assert.equal(fullBoth.inputTokens, 1000);
  assert.equal(fullBoth.outputTokens, 250);
  assert.equal(fullBoth.totalTokens, 1250);
  assert.equal(fullBoth.available, true);

  // D. Provider explicitly supplies totalTokens (e.g. 1400 even if cached breakdown differs)
  const explicitTotal = normalizeUsage({ input_tokens: 1000, output_tokens: 250, total_tokens: 1400 });
  assert.equal(explicitTotal.totalTokens, 1400);

  // E. Empty / null usage -> available false, all null
  const emptyUsage = normalizeUsage(null);
  assert.equal(emptyUsage.available, false);
  assert.equal(emptyUsage.inputTokens, null);
  assert.equal(emptyUsage.outputTokens, null);
  assert.equal(emptyUsage.totalTokens, null);
});

// ── Test 6: Truthful cost accounting & historical immutability ───────────────

test("6. Truthful cost accounting: null for partial usage, historical run cost immutable across config updates", () => {
  const pricingV1 = {
    models: {
      "gpt-5": { inputPricePerMillion: 3.0, outputPricePerMillion: 15.0, currency: "USD", pricingVersion: "2026-Q1" }
    }
  };

  // 1. Partial usage -> cost must be null
  const partialUsage = { inputTokens: 1000, outputTokens: null, available: true };
  const costPartial = calculateCost({ usage: partialUsage, pricing: pricingV1, model: "gpt-5" });
  assert.equal(costPartial, null, "Cost must be null if any required token dimension is missing");

  // 2. Full usage -> cost calculated
  const fullUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000, available: true };
  const costFull = calculateCost({ usage: fullUsage, pricing: pricingV1, model: "gpt-5" });
  assert.ok(costFull);
  assert.equal(costFull.amount, 18.0);
  assert.equal(costFull.currency, "USD");
  assert.equal(costFull.pricingVersion, "2026-Q1");

  // 3. Historical run cost remains pinned when global pricing changes (using real createConfigSnapshot)
  const store = makeTestStore();
  const settings = makeSettings(store, {
    policy: {
      pricing: pricingV1
    }
  });

  const issue601 = {
    key: "PACE-601",
    summary: "Cost immutability check",
    description: "Acceptance Criteria:\n- Unit tests pass",
    labels: ["agent-ready"]
  };
  const plan601 = issuePlan(settings, issue601, {
    store,
    runtime: {
      spawnSync: () => ({
        status: 0,
        stdout: JSON.stringify({
          issue: "PACE-601",
          summary: "Cost immutability check",
          persona: "backend-engineer",
          taskAgent: "backend-engineer",
          skills: ["minimal-change"],
          risk: "low",
          parallelSafe: true,
          allowedPaths: ["backend/**"],
          dependencies: [],
          rationale: ["Cost immutability check"]
        })
      })
    }
  });
  assert.ok(plan601.configSnapshot?.pricing, "createConfigSnapshot must pin pricing into configSnapshot");
  assert.deepEqual(plan601.configSnapshot.pricing, pricingV1);

  const runId = store.createRun("PACE-601", plan601);
  store.recordTelemetryEvent({
    eventId: `telem-${runId}-1-q`,
    runId,
    stage: "queued",
    sequence: 1
  });
  store.recordTelemetryEvent({
    eventId: `telem-${runId}-2-s`,
    runId,
    stage: "started",
    sequence: 2
  });
  store.recordTelemetryEvent({
    eventId: `telem-${runId}-term`,
    runId,
    issueKey: "PACE-601",
    stage: "terminal",
    status: "completed",
    sequence: 999,
    provider: "codex",
    model: "gpt-5",
    usage: fullUsage
  });
  store.transition(runId, "completed", { returnCode: 0 });

  const obsV1 = buildRunObservability(settings, runId, { store });
  assert.equal(obsV1.cost.amount, 18.0);
  assert.equal(obsV1.cost.pricingVersion, "2026-Q1");

  // Mutate global settings to pricing v2 (e.g. 5x price increase)
  settings.data.policy.pricing = {
    models: {
      "gpt-5": { inputPricePerMillion: 15.0, outputPricePerMillion: 75.0, currency: "USD", pricingVersion: "2026-Q2" }
    }
  };

  const obsV2 = buildRunObservability(settings, runId, { store });
  assert.equal(obsV2.cost.amount, 18.0, "Historical run cost must remain pinned to snapshot pricing");
  assert.equal(obsV2.cost.pricingVersion, "2026-Q1");

  // 4. Run without snapshot pricing returns cost: null without falling back to global settings pricing
  const planNoPricing = {
    issue: "PACE-602",
    summary: "No pricing snapshot",
    configSnapshot: {
      pricing: null,
      executorProvider: "codex",
      executorModel: "gpt-5"
    }
  };
  const runIdNoPricing = store.createRun("PACE-602", planNoPricing);
  store.recordTelemetryEvent({
    eventId: `telem-${runIdNoPricing}-1-q`,
    runId: runIdNoPricing,
    stage: "queued",
    sequence: 1
  });
  store.recordTelemetryEvent({
    eventId: `telem-${runIdNoPricing}-2-s`,
    runId: runIdNoPricing,
    stage: "started",
    sequence: 2
  });
  store.recordTelemetryEvent({
    eventId: `telem-${runIdNoPricing}-term`,
    runId: runIdNoPricing,
    stage: "terminal",
    status: "completed",
    sequence: 999,
    provider: "codex",
    model: "gpt-5",
    usage: fullUsage
  });
  store.transition(runIdNoPricing, "completed", {});

  const obsNoPricing = buildRunObservability(settings, runIdNoPricing, { store });
  assert.equal(obsNoPricing.cost, null, "Cost must be null when snapshot.pricing is null (no fallback to mutable global pricing)");
});

// ── Test 7: Real durable provider cooldown ───────────────────────────────────

test("7. Real durable provider cooldown: persisted retryAfter evidence reflects cooling_down", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  // Initially 0 observations -> status unknown
  const initialHealth = buildProviderHealth(settings, store, 86400000);
  const codexInitial = initialHealth.find(p => p.provider === "codex");
  assert.equal(codexInitial.status, "unknown");

  // Create a run that failed with retryAfterSeconds (rate limit evidence)
  const r1 = store.createRun("PACE-701", {
    executor: "codex",
    execution: { provider: "codex" }
  });
  store.transition(r1, "failed-retryable", {
    provider: "codex",
    retryAfterSeconds: 120 // 2 minutes cooldown
  });

  const healthCooling = buildProviderHealth(settings, store, 86400000);
  const codexCooling = healthCooling.find(p => p.provider === "codex");
  assert.equal(codexCooling.status, "cooling_down", "Status must be cooling_down when active cooldown exists");
  assert.ok(codexCooling.cooldownUntil);
});

// ── Test 8: Strict attempt semantics ─────────────────────────────────────────

test("8. Strict attempt semantics: identity.attempt from plan.attempt, totalAttempts excludes reviews", () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  // 1. Implementation Run (Attempt 0)
  const r1 = store.createRun("PACE-801", {
    issue: "PACE-801",
    role: "implementation",
    attempt: 0,
    taskAgent: "backend-engineer"
  });
  store.recordTelemetryEvent({ eventId: `t-${r1}-1`, runId: r1, stage: "queued", role: "implementation", attempt: 0, sequence: 1 });
  store.recordTelemetryEvent({ eventId: `t-${r1}-term`, runId: r1, stage: "terminal", status: "completed", sequence: 999 });
  store.transition(r1, "completed", {});

  // 2. Review Run (Attempt not incremented)
  const r2 = store.createRun("PACE-801", {
    issue: "PACE-801",
    role: "reviewer",
    type: "review",
    taskAgent: "qa-reviewer"
  });
  store.recordTelemetryEvent({ eventId: `t-${r2}-1`, runId: r2, stage: "queued", role: "reviewer", action: "review", sequence: 1 });
  store.recordTelemetryEvent({ eventId: `t-${r2}-term`, runId: r2, stage: "terminal", status: "completed", sequence: 999 });
  store.transition(r2, "completed", {});

  // 3. Rework Run (Attempt 1)
  const r3 = store.createRun("PACE-801", {
    issue: "PACE-801",
    role: "rework",
    action: "rework",
    attempt: 1,
    taskAgent: "backend-engineer"
  });
  store.recordTelemetryEvent({ eventId: `t-${r3}-1`, runId: r3, stage: "queued", role: "rework", action: "rework", attempt: 1, sequence: 1 });
  store.recordTelemetryEvent({ eventId: `t-${r3}-term`, runId: r3, stage: "terminal", status: "completed", sequence: 999 });
  store.transition(r3, "completed", {});

  const obsRework = buildRunObservability(settings, r3, { store });
  assert.equal(obsRework.identity.attempt, 1, "Rework attempt must be exactly 1");
  assert.equal(obsRework.timing.totalAttempts, 2, "totalAttempts must count only execution/rework runs (2), excluding review (1)");
});

// ── Test 9: Pre-persistence redaction and API safety ─────────────────────────

test("9. Pre-persistence redaction & HTTP API safety: secrets/prompts never persist or serialize", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  const runId = store.createRun("PACE-901", { issue: "PACE-901" });

  const rawDirtyPayload = {
    apiKey: "sk-proj-superSecretAPIKey1234567890",
    token: "ghp_PersonalAccessTokenSecretValue123456",
    auth: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitivePayload",
    password: "DatabasePassword999!",
    prompt: "System prompt containing confidential architectural rules",
    environment: {
      JIRA_API_TOKEN: "jiraTokenSecret123",
      DB_URI: "postgres://dbadmin:p@ssword123@db.internal:5432/pace"
    },
    safeTelemetry: "Execution finished normally"
  };

  store.recordTelemetryEvent({
    eventId: `telem-${runId}-1-q`,
    runId,
    stage: "queued",
    sequence: 1
  });
  store.recordTelemetryEvent({
    eventId: `telem-${runId}-2-s`,
    runId,
    stage: "started",
    sequence: 2
  });
  store.recordTelemetryEvent({
    eventId: `telem-${runId}-term-dirty`,
    runId,
    issueKey: "PACE-901",
    stage: "terminal",
    status: "completed",
    sequence: 999,
    raw: rawDirtyPayload,
    error: {
      category: "provider_process_error",
      safeMessage: "Failed with Authorization: Bearer sk-proj-123456789012345"
    }
  });
  store.transition(runId, "completed", { returnCode: 0 });

  // Direct SQLite inspection: assert raw secret strings NEVER hit disk
  const rawDbRow = store.database.prepare("SELECT raw_payload, error_message FROM telemetry_events WHERE run_id = ? AND stage = 'terminal'").get(runId);
  assert.ok(rawDbRow, "Terminal row must exist in SQLite");
  assert.ok(!rawDbRow.raw_payload.includes("sk-proj-superSecretAPIKey1234567890"), "Raw API key must not be in SQLite");
  assert.ok(!rawDbRow.raw_payload.includes("ghp_PersonalAccessTokenSecretValue123456"), "Raw GitHub token must not be in SQLite");
  assert.ok(!rawDbRow.raw_payload.includes("DatabasePassword999!"), "Raw password must not be in SQLite");
  assert.ok(!rawDbRow.raw_payload.includes("confidential architectural rules"), "Raw prompt must not be in SQLite");

  // HTTP API inspection: assert secrets never serialize to clients
  const server = createDashboardServer(settings, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const res = await request(server, `/api/observability/runs/${runId}`);
    assert.equal(res.status, 200);
    const bodyStr = res.body;

    assert.ok(!bodyStr.includes("sk-proj-superSecretAPIKey1234567890"));
    assert.ok(!bodyStr.includes("ghp_PersonalAccessTokenSecretValue123456"));
    assert.ok(!bodyStr.includes("DatabasePassword999!"));
    assert.ok(!bodyStr.includes("confidential architectural rules"));
    assert.ok(!bodyStr.includes("jiraTokenSecret123"));
  } finally {
    server.close();
  }
});

// ── Test 10: Aggregate summary & Truthful zero state ─────────────────────────

test("10. Aggregate summary API & Truthful zero state: windows (1h, 24h, 7d) and truthful empty metrics", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  const server = createDashboardServer(settings, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    // 1. 1h window on empty store
    const res1h = await request(server, "/api/observability/summary?window=1h");
    assert.equal(res1h.status, 200);
    assert.equal(res1h.json.window, "1h");
    assert.equal(res1h.json.metrics.activeRuns, 0);
    assert.equal(res1h.json.metrics.totalUsage.available, false);
    assert.equal(res1h.json.metrics.totalUsage.totalTokens, null);
    assert.equal(res1h.json.metrics.averageExecutionDurationMs, null);

    // 2. 7d window on empty store
    const res7d = await request(server, "/api/observability/summary?window=7d");
    assert.equal(res7d.status, 200);
    assert.equal(res7d.json.window, "7d");
    assert.equal(res7d.json.runs.length, 0);

    // 3. 404 on unknown runId
    const res404 = await request(server, "/api/observability/runs/unknown-run-id-999");
    assert.equal(res404.status, 404);

    // 4. 405 on POST
    const res405 = await request(server, "/api/observability/providers", { method: "POST" });
    assert.equal(res405.status, 405);

    // 5. Orchestrator usage from canonical terminal telemetry appears in aggregate summary
    const orchRunId = store.createRun("PACE-1001", {
      issue: "PACE-1001",
      role: "orchestrator",
      action: "planning",
      taskAgent: "orchestrator"
    });
    store.recordTelemetryEvent({
      eventId: `telem-${orchRunId}-1-q`,
      runId: orchRunId,
      issueKey: "PACE-1001",
      role: "orchestrator",
      action: "planning",
      stage: "queued",
      sequence: 1
    });
    store.recordTelemetryEvent({
      eventId: `telem-${orchRunId}-2-s`,
      runId: orchRunId,
      issueKey: "PACE-1001",
      role: "orchestrator",
      action: "planning",
      stage: "started",
      sequence: 2
    });
    store.recordTelemetryEvent({
      eventId: `telem-${orchRunId}-term-ok`,
      runId: orchRunId,
      issueKey: "PACE-1001",
      role: "orchestrator",
      action: "planning",
      stage: "terminal",
      status: "completed",
      sequence: 999,
      durationMs: 3200,
      usage: { inputTokens: 5000, outputTokens: 2000, totalTokens: 7000, available: true }
    });
    store.transition(orchRunId, "completed", {});

    const resOrch = await request(server, "/api/observability/summary?window=24h");
    assert.equal(resOrch.status, 200);
    assert.equal(resOrch.json.metrics.totalUsage.available, true);
    assert.equal(resOrch.json.metrics.totalUsage.totalTokens, 7000);
    assert.equal(resOrch.json.metrics.totalUsage.inputTokens, 5000);
    assert.equal(resOrch.json.metrics.totalUsage.outputTokens, 2000);
    assert.equal(resOrch.json.metrics.runsCompleted, 1);
  } finally {
    server.close();
  }
});
