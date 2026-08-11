/**
 * lib/dispatcher.js
 *
 * Extracted dispatch logic that powers both the one-shot `dispatch` CLI command
 * and the resident supervisor's per-cycle dispatch.
 *
 * Design constraints:
 * - Plan-only (dry-run) mode DOES poll Jira and computes waves, but never launches providers or writes externally.
 * - Execute mode calls runIssueImpl directly with the already-polled issue packet;
 *   it never spawns a child agentctl process and never re-fetches from Jira.
 * - AbortSignal is respected before each wave/new launch; if already aborted,
 *   returns immediately without polling Jira.
 * - limit and maxConcurrency are validated as positive integers.
 * - Caller-provided maxConcurrency is clamped to policy maximum (never exceeds it).
 * - All dependencies are injectable for deterministic offline tests.
 * - Never merges, pushes, writes Jira, marks Done, or changes issue locks for
 *   non-running provider runs.
 */

import { issuePlan, getStore, runIssue } from "./runtime.js";
import { buildDispatchWaves, executeDispatchWaves } from "./scheduler.js";
import { JiraClient } from "./jira.js";
import { tick } from "./reconciler.js";

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

/**
 * Perform one full dispatch cycle: poll Jira, plan waves, optionally execute.
 *
 * @param {object} settings - loadSettings() result
 * @param {object} [options]
 * @param {boolean} [options.execute=false]     - if false, returns plans only
 * @param {number}  [options.limit]             - max issues to poll; must be a positive integer
 * @param {number}  [options.maxConcurrency]    - clamped to policy max; must be positive integer
 * @param {AbortSignal} [options.signal]        - abort before Jira poll or later waves
 * @param {object}  [options.jira]              - injected JiraClient (for tests)
 * @param {object}  [options.store]             - injected RunStore (for tests)
 * @param {Function} [options.runIssueImpl]     - injected runIssue (for tests)
 * @returns {Promise<DispatchResult>}
 */
export async function dispatchOnce(settings, options = {}) {
  const {
    execute = false,
    signal = null,
    jira: injectedJira = null,
    store: injectedStore = null,
    runIssueImpl = runIssue
  } = options;

  // ── Pre-abort check: if already aborted, return without polling Jira ───────
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
  const label = settings.data.policy.requiredLabels[0];

  // ── Poll Jira ──────────────────────────────────────────────────────────────
  const jira = injectedJira || new JiraClient(settings.data.jira);
  const issues = await jira.poll(settings.projectKey, label, limit);

  // Build a key→issue Map for O(1) lookup during execute mode.
  const issueMap = new Map(issues.map((i) => [i.key, i]));

  // ── Build plans, marking already-locked issues ineligible ─────────────────
  const store = injectedStore || getStore(settings);
  
  // Reconcile states before dispatching new work
  tick(settings, store);

  const lockedIssues = new Set(
    store.listLocks().map((lock) => lock.issue_key)
  );
  const plans = issues.map((issue) => {
    const plan = issuePlan(settings, issue);
    if (!lockedIssues.has(issue.key)) return plan;
    return {
      ...plan,
      eligible: false,
      eligibilityReasons: [...plan.eligibilityReasons, "Issue is already locked"]
    };
  });

  const waves = buildDispatchWaves(plans, { maxConcurrency, providerConcurrency });

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
      // Should be unreachable, but fail explicitly rather than silently.
      throw new Error(
        `dispatchOnce: missing source issue packet for plan "${plan.issue}". ` +
        "This is an internal error."
      );
    }
    const outcome = await Promise.resolve(
      runIssueImpl(settings, issue, true)
    );
    return {
      exitCode: outcome.exitCode,
      runId: outcome.output?.runId || null
    };
  }, { signal });

  const failed = results.reduce(
    (count, wave) =>
      count +
      wave.executions.filter((ex) => ex.exitCode !== 0).length,
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
