/**
 * lib/supervisor.js
 *
 * Resident supervisor: long-running poll/dispatch loop with:
 * - One active owner enforced via database claim with UUID lease fencing.
 * - Persisted heartbeat visible to external observers at heartbeatSeconds interval.
 * - No overlapping poll cycles (each cycle is awaited before the next wait begins).
 * - Graceful stop via AbortSignal or persisted stop_requested_at flag.
 * - Bounded consecutive failures; resets on success; terminates after maxConsecutiveFailures.
 * - Execute mode is opt-in and requires BOTH options.execute AND config.executeEnabled.
 * - Never merges, pushes, writes Jira, marks Done, or releases live issue locks.
 *
 * All external dependencies are injectable for deterministic offline tests.
 */

import { getStore } from "./runtime.js";
import { dispatchOnce } from "./dispatcher.js";

/**
 * @typedef {object} SupervisorOptions
 * @property {boolean} [execute=false]          - enable execute mode (must also have config flag)
 * @property {boolean} [once=false]             - run exactly one cycle then stop
 * @property {number}  [maxCycles]              - positive integer; stop after this many cycles
 * @property {number}  [maxConcurrency]         - positive integer; override policy.maxConcurrency
 * @property {number}  [issueLimit]             - positive integer; override supervisor.issueLimit
 * @property {AbortSignal} [signal]             - external abort signal
 * @property {object}  [jira]                   - injected JiraClient for tests
 * @property {object}  [store]                  - injected RunStore for tests
 * @property {Function} [dispatchOnceImpl]      - injected dispatchOnce for tests
 * @property {{ now(): number }} [clock]        - injected clock for tests
 * @property {Function} [sleep]                 - injected sleep(ms) => Promise for tests
 * @property {number}  [processId]              - injected process ID (default: process.pid)
 */

/**
 * Assert that a value is a positive integer (>= 1), or throw.
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function requirePositiveInteger(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Run the resident supervisor loop.
 *
 * @param {object} settings - loadSettings() result
 * @param {SupervisorOptions} [options]
 * @returns {Promise<void>} - resolves when the supervisor stops cleanly
 * @throws {Error} - when maxConsecutiveFailures is exceeded or lease is lost
 */
export async function runSupervisor(settings, options = {}) {
  const cfg = settings.data.supervisor;

  // ── Execute-mode gate (fail-closed) ────────────────────────────────────────
  const execute = Boolean(options.execute);
  if (execute && !cfg.executeEnabled) {
    throw new Error(
      "Supervisor execute mode requires supervisor.executeEnabled = true in config. " +
      "Set it explicitly to opt in. This is a safety gate."
    );
  }
  const mode = execute ? "execute" : "plan";

  // ── Resolve and validate options ────────────────────────────────────────────
  const once = Boolean(options.once);

  // maxCycles: positive integer, or Infinity for continuous operation.
  // once=true implies maxCycles=1 when not explicitly provided.
  let maxCycles;
  if (options.maxCycles !== undefined) {
    maxCycles = requirePositiveInteger(options.maxCycles, "maxCycles");
  } else {
    maxCycles = once ? 1 : Infinity;
  }

  // issueLimit: positive integer override, or use config value.
  const effectiveIssueLimit =
    options.issueLimit !== undefined
      ? requirePositiveInteger(options.issueLimit, "issueLimit")
      : cfg.issueLimit;

  const {
    maxConcurrency,
    signal: externalSignal = null,
    jira: injectedJira = null,
    store: injectedStore = null,
    dispatchOnceImpl = dispatchOnce,
    clock = { now: () => Date.now() },
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    processId = process.pid
  } = options;

  /** Return the current time as an ISO string using the injected clock. */
  const nowIso = () => new Date(clock.now()).toISOString();

  const store = injectedStore || getStore(settings);
  const supervisorId = settings.projectKey;

  // ── Claim supervisor slot ───────────────────────────────────────────────────
  const claimResult = store.claimSupervisor(supervisorId, {
    pid: processId,
    mode,
    staleAfterSeconds: cfg.staleAfterSeconds,
    now: nowIso()
  });

  if (!claimResult.claimed) {
    const { pid, status, heartbeatAt } = claimResult.conflict;
    throw new Error(
      `Supervisor slot "${supervisorId}" is already owned by pid ${pid} ` +
      `(status=${status}, heartbeat=${heartbeatAt}). ` +
      "Use supervisor-stop to request a graceful shutdown, or wait for stale timeout."
    );
  }

  // Retain the lease token for all subsequent fenced operations.
  const leaseId = claimResult.leaseId;

  // ── Loop state ─────────────────────────────────────────────────────────────
  let cycleCount = 0;
  let consecutiveFailures = 0;
  let lastResult = null;
  let terminalError = null;

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Emit a heartbeat with current cycle count, last result, and optionally
   * clear last_error. Throws if the fenced update fails (lease lost).
   * @param {{ clearLastError?: boolean }} [opts]
   */
  function emitHeartbeat({ clearLastError = false } = {}) {
    const ok = store.heartbeatSupervisor(supervisorId, {
      leaseId,
      cycleCount,
      ...(lastResult !== null ? { lastResult } : {}),
      ...(clearLastError ? { lastError: null } : {}),
      now: nowIso()
    });
    if (!ok) {
      throw new Error(
        `Supervisor lease lost for "${supervisorId}" (leaseId=${leaseId}). ` +
        "Another process may have reclaimed the slot."
      );
    }
  }

  /**
   * Check stop conditions:
   * - External abort signal is set.
   * - Persisted stop_requested_at flag.
   * - Row missing or leaseId mismatch (lease stolen): treated as lease loss, throws.
   * @returns {boolean} true if the loop should stop gracefully
   */
  function shouldStop() {
    if (externalSignal?.aborted) return true;
    const row = store.getSupervisor(supervisorId);
    // Missing row or leaseId mismatch means another process has reclaimed our slot.
    if (!row || row.leaseId !== leaseId) {
      throw new Error(
        `Supervisor lease lost for "${supervisorId}" (leaseId=${leaseId}). ` +
        "Another process reclaimed the slot."
      );
    }
    return Boolean(row.stopRequestedAt);
  }

  /**
   * Sleep for `ms` milliseconds, waking early if externalSignal aborts.
   * Cleans up abort listener if sleep completes first.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function interruptibleSleep(ms) {
    if (ms <= 0 || externalSignal?.aborted) {
      return Promise.resolve();
    }
    if (!externalSignal) {
      return sleep(ms);
    }
    return new Promise((resolve) => {
      let onAbort;
      const cleanup = () => {
        if (onAbort) {
          externalSignal.removeEventListener("abort", onAbort);
          onAbort = null;
        }
      };
      onAbort = () => {
        cleanup();
        resolve();
      };
      externalSignal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(sleep(ms)).then(
        () => {
          cleanup();
          resolve();
        },
        () => {
          cleanup();
          resolve();
        }
      );
    });
  }

  /**
   * Wait for `totalMs` milliseconds using heartbeat-sized slices so the
   * heartbeat stays fresh during long poll intervals.
   * Stops early if shouldStop() returns true.
   */
  async function waitWithHeartbeat(totalMs) {
    const sliceMs = cfg.heartbeatSeconds * 1000;
    let remaining = totalMs;
    while (remaining > 0) {
      if (shouldStop()) break;
      const step = Math.min(remaining, sliceMs);
      await interruptibleSleep(step);
      if (shouldStop()) break;
      remaining -= step;
      emitHeartbeat();
    }
  }

  // ── Main loop ───────────────────────────────────────────────────────────────
  try {
    // Initial heartbeat to confirm we're alive immediately after claiming.
    emitHeartbeat();

    while (cycleCount < maxCycles) {
      // Check stop conditions before each cycle.
      if (shouldStop()) break;

      // Run one dispatch cycle.
      let cycleResult = null;

      try {
        cycleResult = await dispatchOnceImpl(settings, {
          execute,
          limit: effectiveIssueLimit,
          maxConcurrency,
          signal: externalSignal,
          jira: injectedJira,
          store,
          runIssueImpl: options.runIssueImpl
        });
        consecutiveFailures = 0;
        lastResult = {
          mode: cycleResult.mode,
          waves: cycleResult.waves?.length ?? 0,
          failed: cycleResult.failed ?? 0
        };
      } catch (err) {
        consecutiveFailures += 1;

        if (consecutiveFailures >= cfg.maxConsecutiveFailures) {
          // Terminal failure: record and re-throw; finishSupervisor is
          // called in the finally block.
          terminalError =
            `Supervisor "${supervisorId}" exceeded maxConsecutiveFailures ` +
            `(${cfg.maxConsecutiveFailures}). Last error: ${err.message}`;
          throw new Error(terminalError);
        }

        // Non-terminal: emit a failure lifecycle event without changing status.
        // If this also fails (lease lost), the error propagates out of the loop.
        const failureOk = store.recordSupervisorFailure(supervisorId, {
          leaseId,
          error: err.message,
          consecutiveFailures,
          now: nowIso()
        });
        if (!failureOk) {
          throw new Error(
            `Supervisor lease lost for "${supervisorId}" during failure recording.`
          );
        }
      }

      cycleCount += 1;
      // On success, clear any persisted lastError.
      emitHeartbeat({ clearLastError: consecutiveFailures === 0 });

      // Stop after exactly maxCycles.
      if (cycleCount >= maxCycles) break;

      // Check stop conditions before waiting.
      if (shouldStop()) break;

      // Wait poll interval using heartbeat slices.
      await waitWithHeartbeat(cfg.pollIntervalSeconds * 1000);
    }
  } finally {
    // Attempt graceful finish. If the lease was already lost, finishSupervisor
    // returns false (no-op) — we do not try to mutate the new owner's row.
    const currentRow = store.getSupervisor(supervisorId);
    if (currentRow && currentRow.leaseId === leaseId && currentRow.status === "running") {
      // Determine final status based on whether we're in a terminal failure path.
      // We detect this by checking if an uncaught error propagated: at this
      // point in finally, if consecutiveFailures >= cfg.maxConsecutiveFailures,
      // use "failed"; otherwise "stopped".
      const finalStatus =
        consecutiveFailures >= cfg.maxConsecutiveFailures ? "failed" : "stopped";
      store.finishSupervisor(supervisorId, {
        leaseId,
        status: finalStatus,
        lastError: terminalError,
        lastResult,
        now: nowIso()
      });
    }
  }
}
