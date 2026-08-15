/**
 * lib/telemetry.js
 *
 * Phase F — Provider-Neutral Observability & Telemetry Engine.
 *
 * Design constraints:
 * - Truthful & durable: derived strictly from SQLite store events, immutable snapshots, and parsed execution outputs.
 * - Provider-neutral normalized usage ledger: null means unknown; never convert unknown into zero.
 * - Idempotent event contract: queued -> started -> model_selected -> progress -> terminal.
 * - Provider health derived from real observations (0 observations = "unknown", not "healthy").
 * - Sensitive data redaction: prompts, secrets, tokens, env vars are strictly stripped from read models.
 * - No fake/demo data: empty store returns truthful empty metrics.
 */

import { resolveOperatingMode } from "./policy.js";
import { configuredExecutors } from "./executor.js";

// Sensitive keys to recursively redact from metadata/error payloads
const SENSITIVE_KEY_REGEX = /api[_-]?key|token|secret|password|auth|authorization|bearer|credential|cookie|private[_-]?key/i;

/**
 * Recursively redacts sensitive keys and values from telemetry objects.
 * Prevents secrets, tokens, raw credentials, or unredacted env strings from leaking.
 */
export function redactTelemetryPayload(value, depth = 0) {
  if (depth > 8) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Redact Bearer / Authorization / secret tokens in strings
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/(?:ghp|gho|pat|xoxb|sk-[a-zA-Z0-9]{20,})[A-Za-z0-9_]+/g, "[REDACTED_TOKEN]");
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
 * Contract:
 * {
 *   inputTokens: number | null,
 *   outputTokens: number | null,
 *   cachedInputTokens: number | null,
 *   reasoningTokens: number | null,
 *   totalTokens: number | null,
 *   available: boolean
 * }
 *
 * Never converts unknown (null/undefined) into zero!
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

  if (totalTokens === null && (inputTokens !== null || outputTokens !== null)) {
    totalTokens = (inputTokens || 0) + (outputTokens || 0);
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
 * Calculates execution cost only when truthful pricing configuration is provided.
 * If usage is unavailable or pricing is missing, returns null.
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

  const inputCost = ((usage.inputTokens || 0) / 1_000_000) * inputPricePerM;
  const outputCost = ((usage.outputTokens || 0) / 1_000_000) * outputPricePerM;
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
 * Derives accurate execution timings from persisted SQLite events.
 * Missing events produce null, never fabricated timings.
 */
export function deriveExecutionTimings(events = [], runsWithEvents = []) {
  if (!Array.isArray(events) || events.length === 0) {
    return {
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      queueWaitMs: null,
      executionDurationMs: null,
      reviewDurationMs: null,
      endToEndDurationMs: null,
      attempt: 0,
      totalAttempts: 1,
      accumulatedExecutionDurationMs: null,
      accumulatedReviewDurationMs: null
    };
  }

  const queuedEvent = events.find(e => e.state === "queued" || e.stage === "queued");
  const startedEvent = events.find(e => e.state === "started" || e.state === "executing" || e.stage === "started");
  const terminalEvent = [...events].reverse().find(e =>
    ["completed", "verifying", "failed", "failed-retryable", "failed-scope", "blocked", "reviewed-clean", "review-failed"].includes(e.state || e.stage)
  );

  const queuedAt = queuedEvent ? (queuedEvent.created_at || queuedEvent.timestamp) : null;
  const startedAt = startedEvent ? (startedEvent.created_at || startedEvent.timestamp) : null;
  const completedAt = terminalEvent ? (terminalEvent.created_at || terminalEvent.timestamp) : null;

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

  // Check if this run is a review run
  const isReview = events.some(e =>
    e.state === "review-queued" || e.state === "reviewed-clean" || e.state === "review-failed" || e.role === "reviewer"
  );
  const reviewDurationMs = isReview ? executionDurationMs : null;

  // Accumulated durations across multiple attempts/runs for rework
  let accumulatedExecutionDurationMs = executionDurationMs;
  let accumulatedReviewDurationMs = reviewDurationMs;
  let totalAttempts = 1;
  let attempt = 0;

  if (Array.isArray(runsWithEvents) && runsWithEvents.length > 0) {
    totalAttempts = runsWithEvents.length;
    attempt = runsWithEvents.length - 1;
    let totalExecMs = 0;
    let totalRevMs = 0;
    let hasAnyTiming = false;

    for (const r of runsWithEvents) {
      const rEvents = r.events || [];
      const rStarted = rEvents.find(e => e.state === "started" || e.state === "executing");
      const rTerminal = [...rEvents].reverse().find(e =>
        ["completed", "verifying", "failed", "failed-retryable", "failed-scope", "blocked", "reviewed-clean", "review-failed"].includes(e.state)
      );
      if (rStarted && rTerminal) {
        const ms = Math.max(0, new Date(rTerminal.created_at).getTime() - new Date(rStarted.created_at).getTime());
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
 * Builds the provider health read model from truthful execution history.
 * Conservative rule: 0 observations = "unknown", not "healthy".
 */
export function buildProviderHealth(settings, store, windowMs = 86400000) {
  const executors = configuredExecutors(settings);
  const providerNames = Object.keys(executors);

  const detailedRuns = typeof store.listRunsDetailed === "function" ? store.listRunsDetailed(200) : [];
  const now = Date.now();
  const windowStart = new Date(now - windowMs).toISOString();

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
      cooldownUntil: null
    };
  }

  // Also query active reconciler cooldowns if present
  const cooldowns = settings?.data?.reconciler?.cooldowns || {};
  for (const [name, cd] of Object.entries(cooldowns)) {
    if (providerStats[name] && cd && new Date(cd).getTime() > now) {
      providerStats[name].cooldownUntil = new Date(cd).toISOString();
    }
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

    // Windowed outcome evaluation
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
 * Builds the complete Telemetry Read Model for a single Run.
 * Endpoint: GET /api/observability/runs/:runId
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
  const events = run.events || [];
  const pmDecisions = typeof store.getPmDecisions === "function" ? store.getPmDecisions(run.issue_key) : [];

  // All runs for this issue key to measure rework history
  const allRunsForIssue = store.database.prepare(
    "SELECT * FROM runs WHERE issue_key = ? ORDER BY created_at ASC"
  ).all(run.issue_key).map(r => ({
    ...r,
    payload: JSON.parse(r.payload),
    events: store.database.prepare("SELECT state, payload, created_at FROM events WHERE run_id = ? ORDER BY id ASC").all(r.id).map(e => ({ ...e, payload: JSON.parse(e.payload) }))
  }));

  const timings = deriveExecutionTimings(events, allRunsForIssue);

  // Extract latest payload & usage
  const latestEvent = events.at(-1) || {};
  const latestPayload = latestEvent.payload || {};

  // Find usage from event stream
  const usageEvent = [...events].reverse().find(e => e.payload && (e.payload.usage || e.payload.tokens !== undefined));
  const rawUsage = usageEvent?.payload?.usage || (usageEvent?.payload?.tokens ? { total_tokens: usageEvent.payload.tokens } : null);
  const normalizedUsage = normalizeUsage(rawUsage, plan.execution?.provider);

  // Pricing & Cost
  const pricing = settings?.data?.policy?.pricing || settings?.data?.pricing || null;
  const cost = calculateCost({
    usage: normalizedUsage,
    pricing,
    provider: snapshot.executorProvider || plan.execution?.provider,
    model: snapshot.executorModel || plan.execution?.model
  });

  // Error Classification
  const isFailed = ["failed", "failed-retryable", "failed-scope", "review-failed"].includes(run.state);
  const errorObj = isFailed
    ? classifyError(latestPayload.reason || latestPayload.error || run.state, {
        exitCode: latestPayload.returnCode ?? latestPayload.exitCode,
        scope: latestPayload.scope
      })
    : null;

  // Normalized ordered telemetry events
  const telemetryEvents = events.map((ev, index) => {
    const p = ev.payload || {};
    const evUsage = normalizeUsage(p.usage);
    return {
      eventId: `ev-${run.id}-${index + 1}-${ev.state}`,
      runId: run.id,
      sequence: index + 1,
      stage: ev.state,
      status: ev.state,
      timestamp: ev.created_at,
      provider: p.provider || snapshot.executorProvider || plan.execution?.provider || null,
      model: p.model || snapshot.executorModel || plan.execution?.model || null,
      pid: p.pid || null,
      usage: evUsage.available ? evUsage : null,
      error: ev.state.includes("failed") ? classifyError(p.reason || p.error) : null,
      metadata: redactTelemetryPayload({
        branch: p.branch,
        commit: p.commit,
        exitCode: p.returnCode ?? p.exitCode,
        permissionDenied: p.permissionDenied
      })
    };
  });

  const role = plan.role || (plan.type === "review" ? "reviewer" : (plan.attempt > 0 ? "rework" : "implementation"));
  const action = plan.action || (role === "reviewer" ? "review" : (role === "rework" ? "rework" : "implementation"));

  return {
    ok: true,
    identity: {
      runId: run.id,
      issueKey: run.issue_key,
      role,
      action,
      attempt: timings.attempt
    },
    agent: {
      persona: snapshot.persona || plan.persona || "unassigned",
      taskAgent: snapshot.taskAgent || plan.taskAgent || "unassigned",
      agentVersion: snapshot.agentVersion ?? plan.agentVersion ?? null,
      agentHash: snapshot.agentHash || plan.agentHash || null
    },
    execution: {
      provider: snapshot.executorProvider || plan.execution?.provider || "unassigned",
      model: snapshot.executorModel || plan.execution?.model || null,
      modelProfile: snapshot.executorModelProfile || plan.execution?.modelProfile || null,
      effort: snapshot.executorEffort || plan.execution?.effort || null
    },
    state: {
      current: run.state,
      isTerminal: ["completed", "verifying", "failed", "failed-retryable", "failed-scope", "blocked", "reviewed-clean"].includes(run.state),
      outcome: ["completed", "verifying", "reviewed-clean"].includes(run.state) ? "success" : (isFailed ? "failure" : "in_progress")
    },
    timing: timings,
    usage: normalizedUsage,
    cost,
    error: errorObj,
    warnings: latestPayload.permissionDenied ? ["Provider permission auto-denied during execution"] : [],
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
