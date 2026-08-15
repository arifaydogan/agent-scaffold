/**
 * lib/telemetry.js
 *
 * Phase F — Provider-Neutral Observability & Telemetry Engine (Canonical Hardening).
 *
 * Design invariants:
 * - Authoritative canonical source: `telemetry_events` table in SQLite.
 * - Real idempotency: duplicate eventId returns recorded: false, no usage recorded.
 * - Lifecycle monotonicity: queued -> started -> model_selected/progress* -> terminal.
 * - Truthful token ledger: null means unknown; totalTokens calculated only when BOTH input and output are known.
 * - Truthful cost: null if partial tokens or unknown pricing; historical cost pinned to immutable snapshot.
 * - Real provider cooldowns: reuses canonical activeProviderCooldowns(store).
 * - Strict attempt semantics: identity.attempt from pinned plan.attempt; totalAttempts counts execution/rework runs.
 * - Security: recursive redaction before SQLite persistence and before API serialization.
 */

import { resolveOperatingMode } from "./policy.js";
import { configuredExecutors } from "./executor.js";
import { activeProviderCooldowns } from "./reconciler.js";

// Sensitive keys to recursively redact from metadata/error payloads
const SENSITIVE_KEY_REGEX = /api[_-]?key|token|secret|password|auth|authorization|bearer|credential|cookie|private[_-]?key/i;

/**
 * Recursively redacts sensitive keys, patterns, and values from telemetry objects.
 * Prevents secrets, tokens, raw credentials, prompts, or unredacted env strings from persisting or leaking.
 */
export function redactTelemetryPayload(value, depth = 0) {
  if (depth > 10) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/Basic\s+[A-Za-z0-9._~+/-]+=*/gi, "Basic [REDACTED]")
      .replace(/(?:ghp|gho|pat|xoxb|sk-[a-zA-Z0-9_\-]{15,})[A-Za-z0-9_\-]*/g, "[REDACTED_TOKEN]")
      .replace(/(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@/gi, "$1://[REDACTED_USER]:[REDACTED_PASS]@");
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactTelemetryPayload(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        out[key] = "[REDACTED]";
      } else if (key === "prompt" || key === "rawPrompt") {
        out[key] = "[REDACTED_PROMPT]";
      } else if (key === "env" || key === "environment") {
        out[key] = "[REDACTED_ENV]";
      } else {
        out[key] = redactTelemetryPayload(val, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

/**
 * Helper to safely extract a non-negative integer or null.
 */
function toNullableInt(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * Normalizes provider-specific usage output into the canonical usage ledger.
 *
 * Truthful rule:
 * - If totalTokens is not provided by the provider, it is ONLY calculated as input + output
 *   when BOTH inputTokens and outputTokens are non-null and known!
 * - Never converts unknown (null/undefined) into zero.
 */
export function normalizeUsage(rawUsage, provider = null) {
  if (!rawUsage || typeof rawUsage !== "object") {
    return {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      available: false
    };
  }

  const inputTokens = toNullableInt(
    rawUsage.inputTokens ??
    rawUsage.input_tokens ??
    rawUsage.promptTokens ??
    rawUsage.prompt_tokens
  );

  const outputTokens = toNullableInt(
    rawUsage.outputTokens ??
    rawUsage.output_tokens ??
    rawUsage.completionTokens ??
    rawUsage.completion_tokens
  );

  const cachedInputTokens = toNullableInt(
    rawUsage.cachedInputTokens ??
    rawUsage.cached_input_tokens ??
    rawUsage.cacheReadInputTokens ??
    rawUsage.cache_read_input_tokens ??
    rawUsage.prompt_tokens_details?.cached_tokens
  );

  const reasoningTokens = toNullableInt(
    rawUsage.reasoningTokens ??
    rawUsage.reasoning_tokens ??
    rawUsage.thinkingTokens ??
    rawUsage.completion_tokens_details?.reasoning_tokens
  );

  let totalTokens = toNullableInt(
    rawUsage.totalTokens ??
    rawUsage.total_tokens
  );

  // Truthful Invariant: only calculate total from input + output when BOTH are known!
  if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
    totalTokens = inputTokens + outputTokens;
  }

  const available = inputTokens !== null || outputTokens !== null || totalTokens !== null;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    totalTokens,
    available
  };
}

/**
 * Calculates execution cost only when truthful pricing configuration is provided
 * and all required token dimensions are known.
 * If usage is partial, unavailable, or pricing is unknown -> returns null.
 */
export function calculateCost({ usage, pricing, provider, model }) {
  if (!usage || !usage.available) return null;
  if (!pricing || typeof pricing !== "object") return null;

  const modelPricing = (pricing.models && model && pricing.models[model]) ||
    (pricing.providers && provider && pricing.providers[provider]) ||
    pricing[provider] ||
    pricing[model] ||
    null;

  if (!modelPricing) return null;

  const inputPricePerM = Number(modelPricing.inputPricePerMillion ?? modelPricing.inputPrice);
  const outputPricePerM = Number(modelPricing.outputPricePerMillion ?? modelPricing.outputPrice);

  if (!Number.isFinite(inputPricePerM) || !Number.isFinite(outputPricePerM)) {
    return null;
  }

  // Cost requires both input and output dimensions to be known
  if (usage.inputTokens === null || usage.outputTokens === null) {
    return null;
  }

  const inputCost = (usage.inputTokens / 1_000_000) * inputPricePerM;
  const outputCost = (usage.outputTokens / 1_000_000) * outputPricePerM;
  const totalCost = inputCost + outputCost;

  return {
    amount: Number(totalCost.toFixed(6)),
    currency: modelPricing.currency || pricing.currency || "USD",
    pricingVersion: modelPricing.pricingVersion || pricing.pricingVersion || "1.0",
    inputCost: Number(inputCost.toFixed(6)),
    outputCost: Number(outputCost.toFixed(6))
  };
}

/**
 * Classifies operational failures into normalized categories without destroying original error.
 */
export function classifyError(err, context = {}) {
  if (!err) return null;

  const rawMsg = typeof err === "string" ? err : (err.message || String(err));
  const safeMsg = redactTelemetryPayload(rawMsg);
  const code = err.code || err.providerCode || null;
  const exitCode = context.exitCode ?? err.exitCode ?? null;

  let category = "unknown";
  let retryable = false;

  if (context.scope && !context.scope.allowed) {
    category = "scope_violation";
    retryable = false;
  } else if (/timeout|timed out/i.test(rawMsg)) {
    category = "provider_timeout";
    retryable = true;
  } else if (/auto-denied|permission.*denied/i.test(rawMsg)) {
    category = "permission_denied";
    retryable = false;
  } else if (/telemetry|parse.*error|json.*parse/i.test(rawMsg)) {
    category = "telemetry_parse_error";
    retryable = false;
  } else if (/worktree|checkout failed|git.*failed/i.test(rawMsg)) {
    category = "worktree_error";
    retryable = false;
  } else if (/review.*failed|changes-requested/i.test(rawMsg)) {
    category = "review_failure";
    retryable = true;
  } else if (/policy|ineligible|blocked/i.test(rawMsg)) {
    category = "policy_block";
    retryable = false;
  } else if (/jira.*transition|github.*transition|work-source/i.test(rawMsg)) {
    category = "external_transition_error";
    retryable = true;
  } else if (/abort|sigterm|cancelled/i.test(rawMsg)) {
    category = "cancelled";
    retryable = false;
  } else if (/econnrefused|enotfound|503|unavailable|not configured/i.test(rawMsg) || exitCode === 127) {
    category = "provider_unavailable";
    retryable = true;
  } else if (exitCode !== null && exitCode !== 0) {
    category = "provider_process_error";
    retryable = true;
  }

  return {
    category,
    safeMessage: safeMsg,
    providerCode: code ? String(code) : null,
    retryable
  };
}

/**
 * Derives accurate execution timings from persisted canonical telemetry events.
 */
export function deriveExecutionTimings(events = [], runsWithEvents = [], currentRun = null) {
  if (!Array.isArray(events) || events.length === 0) {
    return {
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      queueWaitMs: null,
      executionDurationMs: null,
      reviewDurationMs: null,
      endToEndDurationMs: null,
      attempt: Number(currentRun?.payload?.attempt ?? 0),
      totalAttempts: 1,
      accumulatedExecutionDurationMs: null,
      accumulatedReviewDurationMs: null
    };
  }

  const queuedEvent = events.find(e => e.stage === "queued" || e.state === "queued");
  const startedEvent = events.find(e => e.stage === "started" || e.state === "started" || e.state === "executing");
  const terminalEvent = events.find(e => e.stage === "terminal" || ["completed", "verifying", "failed", "failed-retryable", "failed-scope", "blocked", "reviewed-clean", "review-failed"].includes(e.state));

  const queuedAt = queuedEvent ? (queuedEvent.timestamp || queuedEvent.created_at) : null;
  const startedAt = startedEvent ? (startedEvent.timestamp || startedEvent.created_at) : null;
  const completedAt = terminalEvent ? (terminalEvent.timestamp || terminalEvent.created_at) : null;

  let queueWaitMs = null;
  if (queuedAt && startedAt) {
    queueWaitMs = Math.max(0, new Date(startedAt).getTime() - new Date(queuedAt).getTime());
  }

  let executionDurationMs = null;
  if (startedAt && completedAt) {
    executionDurationMs = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
  }

  let endToEndDurationMs = null;
  if (queuedAt && completedAt) {
    endToEndDurationMs = Math.max(0, new Date(completedAt).getTime() - new Date(queuedAt).getTime());
  }

  const isReview = events.some(e => e.role === "reviewer" || e.state === "review-queued" || e.state === "reviewed-clean" || e.state === "review-failed");
  const reviewDurationMs = isReview ? executionDurationMs : null;

  // Strict attempt semantics:
  // attempt must come from currentRun plan.attempt, not total count of all issue runs
  const attempt = Number(currentRun?.payload?.attempt ?? 0);

  // totalAttempts counts only execution/rework runs (excluding reviewer or planning runs)
  let totalAttempts = 1;
  let accumulatedExecutionDurationMs = executionDurationMs;
  let accumulatedReviewDurationMs = reviewDurationMs;

  if (Array.isArray(runsWithEvents) && runsWithEvents.length > 0) {
    const executionRuns = runsWithEvents.filter(r => {
      const p = r.payload || {};
      return p.role !== "reviewer" && p.type !== "review" && p.role !== "orchestrator";
    });
    totalAttempts = Math.max(1, executionRuns.length);

    let totalExecMs = 0;
    let totalRevMs = 0;
    let hasAnyTiming = false;

    for (const r of runsWithEvents) {
      const rEvents = r.events || [];
      const rStarted = rEvents.find(e => e.stage === "started" || e.state === "started" || e.state === "executing");
      const rTerminal = rEvents.find(e => e.stage === "terminal" || ["completed", "verifying", "failed", "failed-retryable", "failed-scope", "blocked", "reviewed-clean", "review-failed"].includes(e.state));
      if (rStarted && rTerminal) {
        const ms = Math.max(0, new Date(rTerminal.timestamp || rTerminal.created_at).getTime() - new Date(rStarted.timestamp || rStarted.created_at).getTime());
        hasAnyTiming = true;
        if (r.payload?.role === "reviewer" || r.payload?.type === "review") {
          totalRevMs += ms;
        } else {
          totalExecMs += ms;
        }
      }
    }

    if (hasAnyTiming) {
      accumulatedExecutionDurationMs = totalExecMs || executionDurationMs;
      accumulatedReviewDurationMs = totalRevMs || reviewDurationMs;
    }
  }

  return {
    queuedAt,
    startedAt,
    completedAt,
    queueWaitMs,
    executionDurationMs,
    reviewDurationMs,
    endToEndDurationMs,
    attempt,
    totalAttempts,
    accumulatedExecutionDurationMs,
    accumulatedReviewDurationMs
  };
}

/**
 * Builds the provider health read model from truthful execution history and canonical cooldowns.
 * Reuses canonical activeProviderCooldowns(store).
 * Conservative rule: 0 observations = "unknown", not "healthy".
 */
export function buildProviderHealth(settings, store, windowMs = 86400000) {
  const executors = configuredExecutors(settings);
  const providerNames = Object.keys(executors);

  const detailedRuns = typeof store.listRunsDetailed === "function" ? store.listRunsDetailed(200) : [];
  const now = Date.now();
  const windowStart = new Date(now - windowMs).toISOString();

  // Reuse canonical activeProviderCooldowns(store) directly from reconciler
  const durableCooldowns = typeof activeProviderCooldowns === "function" ? activeProviderCooldowns(store, { now }) : {};

  const providerStats = {};
  for (const name of providerNames) {
    providerStats[name] = {
      provider: name,
      activeRuns: 0,
      queuedRuns: 0,
      recentSuccesses: 0,
      recentFailures: 0,
      durations: [],
      lastSuccessAt: null,
      lastFailureAt: null,
      cooldownUntil: durableCooldowns[name] || null
    };
  }

  for (const run of detailedRuns) {
    const plan = run.payload || {};
    const latest = run.latest_payload || {};
    const execution = plan.execution || {};
    const provider = latest.provider || plan.executor || execution.provider || plan.provider;
    if (!provider || !providerStats[provider]) continue;

    const stats = providerStats[provider];
    const state = run.state;

    if (["started", "executing", "model_selected", "progress"].includes(state)) {
      stats.activeRuns++;
    } else if (state === "queued") {
      stats.queuedRuns++;
    }

    if (run.created_at >= windowStart || run.updated_at >= windowStart) {
      const isSuccess = ["verifying", "completed", "reviewed-clean"].includes(state);
      const isFailure = ["failed", "failed-retryable", "failed-scope"].includes(state);

      if (isSuccess) {
        stats.recentSuccesses++;
        if (!stats.lastSuccessAt || run.updated_at > stats.lastSuccessAt) {
          stats.lastSuccessAt = run.updated_at;
        }
        if (run.worker_started_at && run.latest_event_at) {
          const dur = Math.max(0, new Date(run.latest_event_at).getTime() - new Date(run.worker_started_at).getTime());
          stats.durations.push(dur);
        }
      } else if (isFailure) {
        stats.recentFailures++;
        if (!stats.lastFailureAt || run.updated_at > stats.lastFailureAt) {
          stats.lastFailureAt = run.updated_at;
        }
      }
    }
  }

  const result = [];
  for (const name of providerNames) {
    const s = providerStats[name];
    const totalObservations = s.recentSuccesses + s.recentFailures;
    const isCoolingDown = Boolean(s.cooldownUntil && new Date(s.cooldownUntil).getTime() > now);

    let successRate = null;
    if (totalObservations > 0) {
      successRate = Number((s.recentSuccesses / totalObservations).toFixed(4));
    }

    let averageDurationMs = null;
    if (s.durations.length > 0) {
      const sum = s.durations.reduce((a, b) => a + b, 0);
      averageDurationMs = Math.round(sum / s.durations.length);
    }

    let status = "unknown";
    if (isCoolingDown) {
      status = "cooling_down";
    } else if (totalObservations === 0) {
      status = "unknown";
    } else if (s.recentFailures > 0 && (successRate === 0 || s.recentFailures >= 3)) {
      status = "degraded";
    } else if (s.recentSuccesses > 0 && (successRate >= 0.8 || s.recentFailures === 0)) {
      status = "healthy";
    } else {
      status = "healthy";
    }

    result.push({
      provider: name,
      status,
      activeRuns: s.activeRuns,
      queuedRuns: s.queuedRuns,
      recentSuccesses: s.recentSuccesses,
      recentFailures: s.recentFailures,
      successRate,
      lastSuccessAt: s.lastSuccessAt,
      lastFailureAt: s.lastFailureAt,
      averageDurationMs,
      cooldownUntil: s.cooldownUntil
    });
  }

  return result;
}

/**
 * Builds the canonical Telemetry Read Model for a single Run.
 * Endpoint: GET /api/observability/runs/:runId
 *
 * Consumes store.listTelemetryEvents(runId) as the authoritative telemetry stream.
 */
export function buildRunObservability(settings, runId, options = {}) {
  const store = options.store || settings?._store;
  if (!store) throw new Error("Store is required for run observability");

  let run;
  try {
    run = store.getRun(runId);
  } catch {
    return null;
  }
  if (!run) return null;

  const plan = run.payload || {};
  const snapshot = plan.configSnapshot || {};

  // 1. Fetch canonical telemetry events from SQLite telemetry_events table
  const telemetryEvents = typeof store.listTelemetryEvents === "function"
    ? store.listTelemetryEvents(runId)
    : [];

  const queuedTelem = telemetryEvents.find(e => e.stage === "queued");
  const startedTelem = telemetryEvents.find(e => e.stage === "started");
  const terminalTelem = telemetryEvents.find(e => e.stage === "terminal");

  // Fetch all runs for this issue key to measure execution/rework history
  const allRunsForIssue = store.database.prepare(
    "SELECT * FROM runs WHERE issue_key = ? ORDER BY created_at ASC"
  ).all(run.issue_key).map(r => ({
    ...r,
    payload: JSON.parse(r.payload),
    events: typeof store.listTelemetryEvents === "function" && store.listTelemetryEvents(r.id).length > 0
      ? store.listTelemetryEvents(r.id)
      : store.database.prepare("SELECT state, payload, created_at FROM events WHERE run_id = ? ORDER BY id ASC").all(r.id).map(e => ({ ...e, payload: JSON.parse(e.payload) }))
  }));

  const eventsForTiming = telemetryEvents.length > 0 ? telemetryEvents : (run.events || []);
  const timings = deriveExecutionTimings(eventsForTiming, allRunsForIssue, run);

  // Authoritative identity
  const role = terminalTelem?.role || queuedTelem?.role || plan.role || (plan.type === "review" ? "reviewer" : (plan.attempt > 0 ? "rework" : "implementation"));
  const action = terminalTelem?.action || queuedTelem?.action || plan.action || (role === "reviewer" ? "review" : (role === "rework" ? "rework" : "implementation"));
  const attempt = Number(plan.attempt ?? (queuedTelem?.attempt ?? 0));

  // Authoritative provider and model from telemetry stream or pinned snapshot
  const provider = terminalTelem?.provider || queuedTelem?.provider || snapshot.executorProvider || plan.execution?.provider || plan.provider || "unassigned";
  const model = terminalTelem?.model || queuedTelem?.model || snapshot.executorModel || plan.execution?.model || plan.model || null;
  const modelProfile = queuedTelem?.modelProfile || snapshot.executorModelProfile || plan.execution?.modelProfile || plan.modelProfile || null;
  const effort = queuedTelem?.effort || snapshot.executorEffort || plan.execution?.effort || plan.effort || null;

  // Authoritative usage from canonical telemetry stream
  const telemWithUsage = [...telemetryEvents].reverse().find(e => e.usage && e.usage.available);
  const genericUsageEvent = [...(run.events || [])].reverse().find(e => e.payload && (e.payload.usage || e.payload.tokens !== undefined));
  const rawGenericUsage = genericUsageEvent?.payload?.usage || (genericUsageEvent?.payload?.tokens ? { total_tokens: genericUsageEvent.payload.tokens } : null);
  const normalizedUsage = telemWithUsage?.usage || normalizeUsage(rawGenericUsage, provider);

  // Authoritative pricing & cost (respects pinned snapshot pricing if present)
  const pricing = snapshot.pricing || settings?.data?.policy?.pricing || settings?.data?.pricing || null;
  const cost = calculateCost({
    usage: normalizedUsage,
    pricing,
    provider,
    model
  });

  // Authoritative error from canonical terminal telemetry event
  const isFailed = Boolean(terminalTelem?.status === "failed") || ["failed", "failed-retryable", "failed-scope", "review-failed"].includes(run.state);
  const terminalError = terminalTelem?.error;
  const genericErrorPayload = (run.events || []).at(-1)?.payload || {};
  const errorObj = isFailed
    ? (terminalError || classifyError(genericErrorPayload.reason || genericErrorPayload.error || run.state, {
        exitCode: genericErrorPayload.returnCode ?? genericErrorPayload.exitCode,
        scope: genericErrorPayload.scope
      }))
    : null;

  return {
    ok: true,
    identity: {
      runId: run.id,
      issueKey: run.issue_key,
      role,
      action,
      attempt
    },
    agent: {
      persona: queuedTelem?.persona || snapshot.persona || plan.persona || "unassigned",
      taskAgent: queuedTelem?.taskAgent || snapshot.taskAgent || plan.taskAgent || "unassigned",
      agentVersion: snapshot.agentVersion ?? plan.agentVersion ?? null,
      agentHash: snapshot.agentHash || plan.agentHash || null
    },
    execution: {
      provider,
      model,
      modelProfile,
      effort
    },
    state: {
      current: run.state,
      isTerminal: Boolean(terminalTelem) || ["completed", "verifying", "failed", "failed-retryable", "failed-scope", "blocked", "reviewed-clean"].includes(run.state),
      outcome: (terminalTelem?.status === "completed" || ["completed", "verifying", "reviewed-clean"].includes(run.state)) ? "success" : (isFailed ? "failure" : "in_progress")
    },
    timing: timings,
    usage: normalizedUsage,
    cost,
    error: errorObj,
    warnings: [],
    events: telemetryEvents
  };
}

/**
 * Builds the Aggregate Observability Summary Read Model.
 * Endpoints: GET /api/observability/summary & GET /api/observability/runs
 */
export function buildObservabilitySummary(settings, options = {}) {
  const store = options.store || settings?._store;
  if (!store) throw new Error("Store is required for observability summary");

  const windowParam = options.window || "24h";
  const windowMsMap = { "1h": 3600000, "24h": 86400000, "7d": 604800000 };
  const windowMs = windowMsMap[windowParam] || 86400000;
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  const detailedRuns = typeof store.listRunsDetailed === "function" ? store.listRunsDetailed(options.limit || 150) : [];
  const providers = buildProviderHealth(settings, store, windowMs);

  let activeRuns = 0;
  let queuedRuns = 0;
  let reviewsInProgress = 0;
  let blockedRuns = 0;
  let runsCompleted = 0;
  let runsFailed = 0;

  let sumDurationMs = 0;
  let countWithDuration = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let availableUsageCount = 0;

  const recentRuns = [];

  for (const run of detailedRuns) {
    const state = run.state;
    const plan = run.payload || {};
    const latest = run.latest_payload || {};
    const snapshot = plan.configSnapshot || {};
    const execution = plan.execution || {};

    const isRunning = ["started", "executing", "model_selected", "progress"].includes(state);
    const isQueued = state === "queued";
    const isReview = state === "review-queued" || state === "verifying" || plan.role === "reviewer";
    const isBlocked = ["blocked", "human_action_required"].includes(state);

    if (isRunning) activeRuns++;
    if (isQueued) queuedRuns++;
    if (isReview && isRunning) reviewsInProgress++;
    if (isBlocked) blockedRuns++;

    // Windowed counts
    if (run.created_at >= windowStart || run.updated_at >= windowStart) {
      if (["verifying", "completed", "reviewed-clean"].includes(state)) {
        runsCompleted++;
      } else if (["failed", "failed-retryable", "failed-scope"].includes(state)) {
        runsFailed++;
      }

      if (run.worker_started_at && run.latest_event_at) {
        const dur = Math.max(0, new Date(run.latest_event_at).getTime() - new Date(run.worker_started_at).getTime());
        sumDurationMs += dur;
        countWithDuration++;
      }

      const rawUsage = latest.usage || (latest.tokens ? { total_tokens: latest.tokens } : null);
      const usage = normalizeUsage(rawUsage);
      if (usage.available) {
        availableUsageCount++;
        totalTokens += usage.totalTokens || 0;
        totalInputTokens += usage.inputTokens || 0;
        totalOutputTokens += usage.outputTokens || 0;
      }
    }

    const itemUsage = normalizeUsage(latest.usage || (latest.tokens ? { total_tokens: latest.tokens } : null));
    recentRuns.push({
      runId: run.id,
      issueKey: run.issue_key,
      role: plan.role || (plan.type === "review" ? "reviewer" : "implementation"),
      taskAgent: snapshot.taskAgent || plan.taskAgent || "unassigned",
      agentVersion: snapshot.agentVersion ?? plan.agentVersion ?? null,
      provider: latest.provider || snapshot.executorProvider || execution.provider || "unassigned",
      model: latest.model || snapshot.executorModel || execution.model || null,
      state: run.state,
      durationSeconds: (run.worker_started_at && run.latest_event_at)
        ? Math.round(Math.max(0, new Date(run.latest_event_at).getTime() - new Date(run.worker_started_at).getTime()) / 1000)
        : 0,
      usage: itemUsage,
      createdAt: run.created_at,
      updatedAt: run.updated_at
    });
  }

  const averageExecutionDurationMs = countWithDuration > 0 ? Math.round(sumDurationMs / countWithDuration) : null;

  return {
    ok: true,
    project: settings.projectKey,
    window: windowParam,
    generatedAt: options.now || new Date().toISOString(),
    metrics: {
      activeRuns,
      queuedRuns,
      reviewsInProgress,
      blockedRuns,
      runsCompleted,
      runsFailed,
      averageExecutionDurationMs,
      totalUsage: {
        available: availableUsageCount > 0,
        availableRunsCount: availableUsageCount,
        totalTokens: availableUsageCount > 0 ? totalTokens : null,
        inputTokens: availableUsageCount > 0 ? totalInputTokens : null,
        outputTokens: availableUsageCount > 0 ? totalOutputTokens : null
      }
    },
    providers,
    runs: recentRuns
  };
}
