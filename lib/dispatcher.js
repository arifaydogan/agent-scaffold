/**
 * lib/dispatcher.js
 *
 * Extracted dispatch logic that powers both the one-shot `dispatch` CLI command
 * and the resident supervisor's per-cycle dispatch.
 *
 * Design constraints:
 * - Plan-only (dry-run) mode polls the selected work source and computes waves,
 *   but never launches providers or writes externally.
 * - Execute mode calls runIssueImpl directly with the already-polled issue packet;
 *   it never spawns a child agentctl process or re-fetches the work item.
 * - AbortSignal is respected before each wave/new launch; if already aborted,
 *   returns immediately without polling the work source.
 * - limit and maxConcurrency are validated as positive integers.
 * - Caller-provided maxConcurrency is clamped to policy maximum (never exceeds it).
 * - All dependencies are injectable for deterministic offline tests.
 * - Never merges, pushes, writes work sources, marks Done, or changes issue locks for
 *   non-running provider runs.
 */

import { issuePlan, issuePlanWithIntelligence, getStore, runIssue } from "./runtime.js";
import { computePlanFingerprint, resolveOperatingMode } from "./policy.js";
import {
  buildDispatchWaves,
  executeDispatchWaves,
  scopesOverlap
} from "./scheduler.js";
import {
  activeProviderCooldowns,
  blockRetryRequest,
  claimRetryRequest,
  finishRetryRequest,
  safeWorkSourceMutate,
  tick
} from "./reconciler.js";
import { integrateLeafToEpic } from "./git-integration.js";
import { createWorkSourceProvider, selectedWorkSourceProviderName } from "./work-source.js";
import { selectReviewProfile } from "./executor.js";
import { discoverAndPinParent, reconcileParentExecution } from "./parent-orchestrator.js";

/**
 * @typedef {object} DispatchResult
 * @property {'dry-run'|'execute'} mode
 * @property {number} maxConcurrency
 * @property {object[][]} waves       - dispatch wave plans
 * @property {object[]|null} results  - null in dry-run mode
 * @property {number} failed          - count of non-zero exit executions (0 in dry-run)
 * @property {boolean} aborted        - true if the signal was already aborted at entry
 */

/**
 * Assert that a value is a positive integer (>= 1). Throws on invalid input.
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function assertPositiveInteger(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a positive integer >= 1, got: ${JSON.stringify(value)}`
    );
  }
  return value;
}

const RETRY_PLAN_FIELDS = [
  "summary", "epicKey", "persona", "taskAgent", "skills", "execution",
  "risk", "parallelSafe", "branch", "worktree", "allowedPaths"
];
const ACTIVE_WORKER_STATES = new Set([
  "claimed", "prepared", "queued", "started", "model_selected", "progress",
  "executing", "retry-dispatching"
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function retryPlanMatches(requested, current) {
  return RETRY_PLAN_FIELDS.every((field) => {
    if (field === "execution") {
      const rExec = requested.execution;
      const cExec = current.execution;
      if (!rExec && !cExec) return true;
      if (!rExec || !cExec) return false;
      return (
        rExec.provider === cExec.provider &&
        (rExec.model || null) === (cExec.model || null) &&
        (rExec.modelProfile || null) === (cExec.modelProfile || null) &&
        (rExec.effort || null) === (cExec.effort || null) &&
        (rExec.mode || null) === (cExec.mode || null)
      );
    }
    return JSON.stringify(stable(requested[field])) === JSON.stringify(stable(current[field]));
  });
}

/**
 * Perform one full dispatch cycle: poll the work source, plan waves, optionally execute.
 *
 * @param {object} settings - loadSettings() result
 * @param {object} [options]
 * @param {boolean} [options.execute=false]     - if false, returns plans only
 * @param {number}  [options.limit]             - max issues to poll; must be a positive integer
 * @param {number}  [options.maxConcurrency]    - clamped to policy max; must be positive integer
 * @param {AbortSignal} [options.signal]        - abort before work-source poll or later waves
 * @param {object}  [options.workSource]        - injected WorkSourceProvider
 * @param {object}  [options.jira]              - legacy injected provider alias
 * @param {object}  [options.store]             - injected RunStore (for tests)
 * @param {Function} [options.runIssueImpl]     - injected runIssue (for tests)
 * @returns {Promise<DispatchResult>}
 */
export async function dispatchOnce(settings, options = {}) {
  const {
    execute = false,
    signal = null,
    workSource: injectedWorkSource = null,
    jira: legacyInjectedJira = null,
    store: injectedStore = null,
    runIssueImpl = runIssue
  } = options;

  // ── Pre-abort check: if already aborted, return without polling the work source ───────
  if (signal?.aborted) {
    return {
      mode: execute ? "execute" : "dry-run",
      maxConcurrency: 0,
      waves: [],
      results: null,
      failed: 0,
      aborted: true
    };
  }

  // ── Validate limit ─────────────────────────────────────────────────────────
  const limit = assertPositiveInteger(
    options.limit ?? settings.data.supervisor?.issueLimit ?? 10,
    "limit"
  );

  // ── Resolve and clamp maxConcurrency ──────────────────────────────────────
  // Policy maximum is the hard ceiling; a caller override may not exceed it.
  const policyMax = assertPositiveInteger(
    settings.data.policy.maxConcurrency,
    "policy.maxConcurrency"
  );
  let maxConcurrency;
  if (options.maxConcurrency !== undefined) {
    const callerMax = assertPositiveInteger(options.maxConcurrency, "maxConcurrency");
    maxConcurrency = Math.min(callerMax, policyMax);
  } else {
    maxConcurrency = policyMax;
  }

  const providerConcurrency = settings.data.policy.providerConcurrency || {};
  // Initialize work source early for reconciler to use.
  const workSource = injectedWorkSource || legacyInjectedJira || createWorkSourceProvider(settings);

  // Reconcile durable local state before relying on work-source availability. Recovery,
  // review, and retry requests must continue to advance during a work-source outage.
  const store = injectedStore || getStore(settings);
  const integrationAdapter = execute
    ? options.integrationAdapter || ((request) => integrateLeafToEpic(settings, request))
    : null;
  const reconciliation = tick(settings, store, {
    execute,
    workSource,
    promises: [],
    ...(integrationAdapter ? { integrationAdapter } : {})
  });
  
  if (reconciliation.promises && reconciliation.promises.length > 0) {
    await Promise.allSettled(reconciliation.promises);
  }

  // Poll the selected work source.
  const issues = await workSource.poll({
    projectKey: settings.projectKey,
    limit,
    canonicalStates: ["ready", "rework", "review", "human_approval", "backlog"]
  });

  // Durably record discovered backlog items and discover parent hierarchies
  if (store) {
    for (const issue of issues) {
      if (typeof store.recordDiscoveredWorkItem === "function") {
        if (issue.canonicalState === "backlog" || issue.canonicalState === "discovered") {
          store.recordDiscoveredWorkItem({
            key: issue.key,
            issueKey: issue.key,
            summary: issue.summary,
            provider: issue.provider || (typeof selectedWorkSourceProviderName === "function" ? selectedWorkSourceProviderName(settings) : "work-source"),
            url: issue.url || null,
            raw: {
              canonicalState: issue.canonicalState,
              status: issue.status,
              labels: issue.labels || [],
              ...(issue.raw || {})
            }
          });
        }
      }
      const iType = String(issue.issueType || issue.type || "").toLowerCase();
      if (iType === "epic" || iType === "epik") {
        try {
          await discoverAndPinParent(settings, store, issue, { execute, workSource, runtime: options.runtime });
        } catch {}
      }
    }
  }

  // Build a key→issue Map for O(1) lookup during execute mode.
  const issueMap = new Map(issues.map((i) => [i.key, i]));

  // ── Build plans, marking already-locked issues ineligible ─────────────────
  const detailedRuns = store.listRunsDetailed(200);
  const lockedIssues = new Set(store.listLocks().map((lock) => lock.issue_key));
  const activeRuns = detailedRuns.filter((run) => ACTIVE_WORKER_STATES.has(run.state));
  const activeScopes = activeRuns.map((run) => ({
    runId: run.id,
    paths: run.payload?.allowedPaths || []
  }));
  const retryIssueKeys = new Set(
    detailedRuns
      .filter((run) => ["retry_requested", "retry-ready", "retry-blocked", "retry-dispatching"].includes(run.state))
      .map((run) => run.issue_key)
  );
  const currentPlans = new Map(await Promise.all(issues.map(async (issue) => {
    const action = issue.canonicalState === "review"
      ? "review"
      : issue.canonicalState === "rework"
      ? "rework"
      : "implementation";
    const retryableRun = detailedRuns.find(r => r.issue_key === issue.key && r.state === "failed-retryable");
    const attempt = retryableRun?.latest_payload?.attempt || 0;
    const originatingRun = retryableRun || detailedRuns.find(r => r.issue_key === issue.key && r.state === "review-queued") || null;

    const plan = await issuePlanWithIntelligence(settings, issue, { store, action, attempt, originatingRun, runtime: options.runtime });
    const effectiveMode = originatingRun?.payload?.configSnapshot?.operatingMode || resolveOperatingMode(settings);

    if (effectiveMode === "supervised" && (issue.canonicalState === "ready" || issue.canonicalState === "rework")) {
      const existingApproval = store.hasExecutionApproval(issue.key, { action, plan, attempt });
      if (!existingApproval) {
        const fingerprint = computePlanFingerprint(plan);
        const existing = store.getPmDecisions(issue.key);
        const alreadyRequested = existing.some(
          (d) => d.type === "approval_requested" &&
                 d.payload.action === action &&
                 d.payload.attempt === attempt &&
                 d.payload.planFingerprint === fingerprint
        );
        if (!alreadyRequested) {
          store.addPmDecision(issue.key, "approval_requested", {
            state: "awaiting-approval",
            action,
            attempt,
            planFingerprint: fingerprint,
            summary: issue.summary,
            plan: { issue: issue.key, summary: issue.summary, taskAgent: plan.taskAgent, allowedPaths: plan.allowedPaths }
          });
        }
      }
    }
    return [issue.key, plan];
  })));

  const ordinaryPlans = [];
  for (const issue of issues) {
    if (retryIssueKeys.has(issue.key)) continue;

    switch (issue.canonicalState) {
      case "ready":
      case "rework":
      case "review":
        ordinaryPlans.push(currentPlans.get(issue.key));
        break;
      case "human_approval":
      case "backlog":
      case "discovered":
        // Backlog/discovered and Human approval don't dispatch worker agents
        break;
      default:
        // Skip unknown/unhandled states
        break;
    }
  }
  const retryPlans = [];
  for (const request of reconciliation.retries.ready) {
    const current = currentPlans.get(request.issueKey);
    if (!current) {
      blockRetryRequest(store, request.runId, "Retry work-item packet was not returned by the selected work source");
      continue;
    }
    if (!current.eligible || !retryPlanMatches(request.plan, current)) {
      blockRetryRequest(
        store,
        request.runId,
        current.eligible
          ? "Retry canonical plan no longer matches the current safe plan"
          : "Retry is no longer eligible: " + current.eligibilityReasons.join(", ")
      );
      continue;
    }
    retryPlans.push({
      ...request.plan,
      issue: request.issueKey,
      eligible: true,
      eligibilityReasons: [],
      retryRequestId: request.runId
    });
  }

  const runsByIssue = new Map();
  for (const run of detailedRuns) {
    if (!runsByIssue.has(run.issue_key)) {
      runsByIssue.set(run.issue_key, []);
    }
    runsByIssue.get(run.issue_key).push(run);
  }

  const configuredProviderCapacity = {};
  for (const [provider, configuredLimit] of Object.entries(providerConcurrency)) {
    const limitForProvider = assertPositiveInteger(
      configuredLimit,
      `providerConcurrency.${provider}`
    );
    const remaining = limitForProvider - (reconciliation.workers.activeByProvider[provider] || 0);
    if (remaining > 0) configuredProviderCapacity[provider] = remaining;
  }
  const plans = [...retryPlans, ...ordinaryPlans].map((plan) => {
    const reasons = [...(plan.eligibilityReasons || [])];
    let provider = plan.dispatchProvider || plan.execution?.provider || "unconfigured";
    const issue = issueMap.get(plan.issue);
    if (issue?.canonicalState === "review") {
      try {
        const reviewProfile = selectReviewProfile(settings, issue);
        if (reviewProfile) provider = reviewProfile.provider;
      } catch {}
    }
    if (lockedIssues.has(plan.issue)) reasons.push("Issue is already locked");
    
    // Prevent duplicate builder execution if local store already has active/queued/completed runs for this issue
    const issueRuns = runsByIssue.get(plan.issue) || [];
    const activeOrQueuedRun = issueRuns.find((r) =>
      [
        "claimed", "prepared", "queued", "started", "model_selected", "progress",
        "executing", "verifying", "transitioning-review", "review-queued",
        "transitioning-rework", "transitioning-blocked", "transitioning-human-approval"
      ].includes(r.state)
    );
    if (activeOrQueuedRun && activeOrQueuedRun.id !== plan.retryRequestId) {
      if (issue?.canonicalState === "ready" && !["retry-ready", "retry_requested"].includes(activeOrQueuedRun.state)) {
        reasons.push(`Issue already has active or queued local run (${activeOrQueuedRun.state}: ${activeOrQueuedRun.id})`);
      }
    }
    const terminalRun = issueRuns.find((r) =>
      ["completed", "reviewed-clean", "blocked"].includes(r.state)
    );
    if (terminalRun && issue?.canonicalState === "ready") {
      reasons.push(`Issue already reached local state ${terminalRun.state} (${terminalRun.id})`);
    }

    // Check DAG dependency gate: if issue belongs to an epic/parent, check if its upstream dependencies are integrated
    if (store && store.database) {
      try {
        const epicTasks = store.database.prepare("SELECT * FROM epic_tasks WHERE issue_key = ?").all(plan.issue);
        for (const et of epicTasks) {
          let deps = [];
          if (et.dependencies) {
            try { deps = JSON.parse(et.dependencies); } catch {}
          }
          if (deps.length > 0) {
            const integrations = store.listEpicIntegrations(et.epic_key);
            const intMap = new Map(integrations.map(i => [i.issueKey, i.state]));
            const unintegrated = deps.filter(d => intMap.get(d) !== "integrated");
            if (unintegrated.length > 0 && (issue?.canonicalState === "ready" || issue?.canonicalState === "rework")) {
              reasons.push(`Waiting for upstream dependencies to be integrated: ${unintegrated.join(", ")}`);
            }
          }
        }
      } catch {}
    }

    if (reconciliation.cooldowns[provider]) {
      reasons.push("Provider " + provider + " is cooling down until " + reconciliation.cooldowns[provider]);
    }
    if (
      Object.prototype.hasOwnProperty.call(providerConcurrency, provider) &&
      !Object.prototype.hasOwnProperty.call(configuredProviderCapacity, provider)
    ) {
      reasons.push(
        `Provider concurrency limit reached for ${provider} (${providerConcurrency[provider]})`
      );
    }
    const collision = activeScopes.find((active) =>
      scopesOverlap(active.paths, plan.allowedPaths || [])
    );
    if (collision) reasons.push("Scope overlaps active run " + collision.runId);
    return {
      ...plan,
      dispatchProvider: provider,
      eligible: plan.eligible && reasons.length === 0,
      eligibilityReasons: reasons
    };
  });

  const configuredAgentCapacity = {};
  for (const plan of plans) {
    const agentId = plan.taskAgent || plan.persona || plan.agentId;
    if (agentId && !Object.prototype.hasOwnProperty.call(configuredAgentCapacity, agentId)) {
      const agentLimit = plan.maxConcurrency || plan.configSnapshot?.maxConcurrency || maxConcurrency;
      const activeForAgent = activeRuns.filter(
        (r) => (r.payload?.taskAgent || r.payload?.agentId || r.payload?.persona) === agentId
      ).length;
      const remaining = Math.max(0, agentLimit - activeForAgent);
      configuredAgentCapacity[agentId] = remaining;
    }
  }

  const availableWorkers = Math.max(0, maxConcurrency - (reconciliation.workers?.active || 0));
  const waves = availableWorkers > 0
    ? buildDispatchWaves(plans, {
        maxConcurrency: availableWorkers,
        providerConcurrency: configuredProviderCapacity,
        agentConcurrency: configuredAgentCapacity
      })
    : [];

  if (!execute) {
    return {
      mode: "dry-run",
      maxConcurrency,
      waves,
      results: null,
      failed: 0,
      aborted: false
    };
  }

  // ── Execute mode: call runIssueImpl for each plan ─────────────────────────
  const results = await executeDispatchWaves(waves, async (plan) => {
    const issue = issueMap.get(plan.issue);
    if (!issue) {
      throw new Error(
        `dispatchOnce: missing source issue packet for plan "${plan.issue}". ` +
        "This is an internal error."
      );
    }
    const provider = plan.dispatchProvider || plan.execution?.provider || "unconfigured";
    const liveCooldowns = activeProviderCooldowns(store);
    if (liveCooldowns[provider]) {
      return {
        exitCode: 9,
        runId: null,
        retryRequestId: plan.retryRequestId || null,
        deferred: true,
        reason: "Provider " + provider + " is cooling down until " + liveCooldowns[provider]
      };
    }
    if (plan.retryRequestId && !claimRetryRequest(store, plan.retryRequestId)) {
      return { exitCode: 8, runId: null, retryRequestId: plan.retryRequestId };
    }

    let outcome;
    try {
      if (execute && workSource && (issue.canonicalState === "ready" || issue.canonicalState === "rework")) {
        await safeWorkSourceMutate(workSource, settings, "transition", issue.key, "in_progress", {});
      }
      outcome = await Promise.resolve(runIssueImpl(settings, issue, true, options.runtime, { plan }));
    } catch (error) {
      if (plan.retryRequestId) {
        finishRetryRequest(store, plan.retryRequestId, {
          exitCode: 1,
          reason: error.message
        });
      }
      return {
        exitCode: 1,
        runId: null,
        retryRequestId: plan.retryRequestId || null,
        error: error.message
      };
    }

    const childRunId = outcome.output?.runId || null;
    if (plan.retryRequestId) {
      finishRetryRequest(store, plan.retryRequestId, {
        exitCode: outcome.exitCode,
        runId: childRunId
      });
    }
    return {
      exitCode: outcome.exitCode,
      runId: childRunId,
      retryRequestId: plan.retryRequestId || null
    };
  }, { signal });

  const failed = results.reduce(
    (count, wave) =>
      count +
      wave.executions.filter((ex) => ex.exitCode !== 0 && !ex.deferred).length,
    0
  );

  return {
    mode: "execute",
    maxConcurrency,
    waves,
    results,
    failed,
    aborted: Boolean(signal?.aborted)
  };
}
