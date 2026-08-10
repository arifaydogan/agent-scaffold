import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export class RunStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        issue_key TEXT NOT NULL,
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issue_locks (
        issue_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS supervisors (
        id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL DEFAULT '',
        pid INTEGER NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        stop_requested_at TEXT,
        stopped_at TEXT,
        cycle_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_result TEXT
      );
      CREATE TABLE IF NOT EXISTS supervisor_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supervisor_id TEXT NOT NULL,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  createRun(issueKey, payload) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const body = JSON.stringify(payload);
    this.database
      .prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, issueKey, "discovered", body, now, now);
    this.#event(id, "discovered", payload, now);
    return id;
  }

  acquireLock(issueKey, runId) {
    try {
      this.database
        .prepare("INSERT INTO issue_locks VALUES (?, ?, ?)")
        .run(issueKey, runId, new Date().toISOString());
      return true;
    } catch (error) {
      if (error.code === "ERR_SQLITE_ERROR") return false;
      throw error;
    }
  }

  transition(runId, state, payload = {}) {
    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE runs SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, now, runId);
    this.#event(runId, state, payload, now);
  }

  getRun(runId) {
    const run = this.database
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const events = this.database
      .prepare(
        "SELECT state, payload, created_at FROM events WHERE run_id = ? ORDER BY id"
      )
      .all(runId)
      .map((event) => ({ ...event, payload: JSON.parse(event.payload) }));
    return { ...run, payload: JSON.parse(run.payload), events };
  }

  listRuns(limit = 20) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
    return this.database
      .prepare(
        `SELECT id, issue_key, state, created_at, updated_at
         FROM runs ORDER BY created_at DESC LIMIT ?`
      )
      .all(boundedLimit);
  }

  listRunsDetailed(limit = 100) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
    return this.database
      .prepare(
        `SELECT r.id, r.issue_key, r.state, r.payload, r.created_at, r.updated_at,
                e.payload AS latest_payload, e.created_at AS latest_event_at,
                (SELECT created_at FROM events WHERE run_id = r.id AND state IN ('started', 'executing') ORDER BY id ASC LIMIT 1) AS worker_started_at,
                (SELECT created_at FROM events WHERE run_id = r.id AND state IN ('started', 'model_selected', 'progress', 'executing') ORDER BY id DESC LIMIT 1) AS worker_last_heartbeat_at
         FROM runs r
         LEFT JOIN events e ON e.id = (
           SELECT latest.id FROM events latest
           WHERE latest.run_id = r.id ORDER BY latest.id DESC LIMIT 1
         )
         ORDER BY r.created_at DESC LIMIT ?`
      )
      .all(boundedLimit)
      .map((run) => ({
        ...run,
        payload: JSON.parse(run.payload),
        latest_payload: run.latest_payload
          ? JSON.parse(run.latest_payload)
          : {}
      }));
  }

  listEvents(limit = 40) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 40, 200));
    return this.database
      .prepare(
        `SELECT e.id, e.run_id, r.issue_key, e.state, e.created_at
         FROM events e
         JOIN runs r ON r.id = e.run_id
         ORDER BY e.id DESC LIMIT ?`
      )
      .all(boundedLimit);
  }

  listLocks() {
    return this.database
      .prepare(
        `SELECT issue_key, run_id, acquired_at
         FROM issue_locks ORDER BY acquired_at DESC`
      )
      .all();
  }

  releaseLock(issueKey, runId) {
    const result = this.database
      .prepare("DELETE FROM issue_locks WHERE issue_key = ? AND run_id = ?")
      .run(issueKey, runId);
    return result.changes === 1;
  }

  // ── Supervisor methods ─────────────────────────────────────────────────────

  /**
   * Attempt to claim ownership of a supervisor slot.
   *
   * Rules (evaluated atomically in a BEGIN IMMEDIATE transaction):
   * - If no row exists: insert with a fresh UUID lease and return { claimed: true, leaseId }.
   * - If the existing row status is terminal (stopped/failed): reclaim.
   * - If the existing row heartbeat is older than staleAfterSeconds: reclaim.
   * - Otherwise: reject with { claimed: false, conflict: { id, pid, status, heartbeatAt } }.
   *
   * @param {string} id - supervisor slot id (typically project key)
   * @param {{ pid: number, mode: string, staleAfterSeconds: number, leaseId?: string, now?: string }} details
   * @returns {{ claimed: boolean, leaseId?: string, conflict?: object }}
   */
  claimSupervisor(id, { pid, mode, staleAfterSeconds, leaseId: injectedLeaseId, now: injectedNow }) {
    const TERMINAL_STATUSES = new Set(["stopped", "failed"]);
    let claimResult;

    // BEGIN IMMEDIATE prevents two concurrent processes from both reading
    // "no row" and then both attempting to insert.
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare("SELECT * FROM supervisors WHERE id = ?")
        .get(id);

      const now = injectedNow ?? new Date().toISOString();
      const leaseId = injectedLeaseId ?? randomUUID();

      if (!existing) {
        // Fresh claim.
        this.database
          .prepare(
            `INSERT INTO supervisors
             (id, lease_id, pid, status, mode, started_at, heartbeat_at,
              stop_requested_at, stopped_at, cycle_count, last_error, last_result)
             VALUES (?, ?, ?, 'running', ?, ?, ?, NULL, NULL, 0, NULL, NULL)`
          )
          .run(id, leaseId, pid, mode, now, now);
        this.#supervisorEvent(id, "start", { pid, mode, leaseId }, now);
        claimResult = { claimed: true, leaseId };
      } else {
        // Evaluate if the existing owner is live.
        const isTerminal = TERMINAL_STATUSES.has(existing.status);
        const heartbeatAge =
          (Date.now() - new Date(existing.heartbeat_at).getTime()) / 1000;
        const isStale = heartbeatAge > staleAfterSeconds;

        if (isTerminal || isStale) {
          // Reclaim stale or terminal supervisor with a new lease.
          this.database
            .prepare(
              `UPDATE supervisors
               SET lease_id = ?, pid = ?, status = 'running', mode = ?,
                   started_at = ?, heartbeat_at = ?,
                   stop_requested_at = NULL, stopped_at = NULL,
                   cycle_count = 0, last_error = NULL, last_result = NULL
               WHERE id = ?`
            )
            .run(leaseId, pid, mode, now, now, id);
          this.#supervisorEvent(
            id,
            "reclaim",
            { pid, mode, leaseId, previousPid: existing.pid, previousStatus: existing.status },
            now
          );
          claimResult = { claimed: true, leaseId };
        } else {
          // Live owner — reject.
          claimResult = {
            claimed: false,
            conflict: {
              id: existing.id,
              pid: existing.pid,
              status: existing.status,
              heartbeatAt: existing.heartbeat_at
            }
          };
        }
      }
      this.database.exec("COMMIT");
    } catch (err) {
      this.database.exec("ROLLBACK");
      throw err;
    }

    return claimResult;
  }

  /**
   * Update the heartbeat timestamp for a supervisor.
   * Fenced by leaseId and status='running': updates only when the caller still
   * owns the slot. Returns true if the update succeeded (lease still valid).
   * Does NOT write a supervisor_event (heartbeats are high-frequency).
   *
   * @param {string} id
   * @param {{ leaseId: string, cycleCount?: number, lastResult?: object, lastError?: null, now?: string }} details
   * @returns {boolean} true if the fenced update affected a row
   */
  heartbeatSupervisor(id, { leaseId, cycleCount, lastResult, lastError, now: injectedNow } = {}) {
    const now = injectedNow ?? new Date().toISOString();
    const resultJson =
      lastResult !== undefined ? JSON.stringify(lastResult) : null;

    // Build the SET clause dynamically based on provided fields.
    const sets = ["heartbeat_at = ?"];
    const params = [now];

    if (cycleCount !== undefined) {
      sets.push("cycle_count = ?");
      params.push(cycleCount);
    }
    if (resultJson !== null) {
      sets.push("last_result = ?");
      params.push(resultJson);
    }
    // Allow explicit null to clear last_error on success.
    if (lastError === null) {
      sets.push("last_error = NULL");
    }

    params.push(id, leaseId);
    const result = this.database
      .prepare(
        `UPDATE supervisors SET ${sets.join(", ")}
         WHERE id = ? AND lease_id = ? AND status = 'running'`
      )
      .run(...params);

    return result.changes === 1;
  }

  /**
   * Set stop_requested_at for a supervisor.
   * Operator-owned: does not require leaseId. Writes a lifecycle event.
   * @param {string} id
   */
  requestSupervisorStop(id) {
    const now = new Date().toISOString();
    this.database
      .prepare(
        "UPDATE supervisors SET stop_requested_at = ? WHERE id = ?"
      )
      .run(now, id);
    this.#supervisorEvent(id, "stop-request", {}, now);
  }

  /**
   * Get one supervisor row, shaped as camelCase.
   * @param {string} id
   * @returns {object|null}
   */
  getSupervisor(id) {
    const row = this.database
      .prepare("SELECT * FROM supervisors WHERE id = ?")
      .get(id);
    return row ? this.#shapeSupervisor(row) : null;
  }

  /**
   * List all supervisor rows, shaped as camelCase, newest heartbeat first.
   * @returns {object[]}
   */
  listSupervisors() {
    return this.database
      .prepare("SELECT * FROM supervisors ORDER BY heartbeat_at DESC")
      .all()
      .map((row) => this.#shapeSupervisor(row));
  }

  /**
   * List recent supervisor lifecycle events.
   * @param {number} limit
   * @returns {object[]}
   */
  listSupervisorEvents(limit = 40) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 40, 200));
    return this.database
      .prepare(
        `SELECT id, supervisor_id, event, payload, created_at
         FROM supervisor_events ORDER BY id DESC LIMIT ?`
      )
      .all(boundedLimit)
      .map((row) => ({
        id: row.id,
        supervisorId: row.supervisor_id,
        event: row.event,
        payload: JSON.parse(row.payload),
        createdAt: row.created_at
      }));
  }

  /**
   * Finish a supervisor run (stopped or failed).
   * Fenced by leaseId and status='running'. Returns true if the update succeeded.
   * Writes a lifecycle event only when the fenced update succeeds.
   *
   * @param {string} id
   * @param {{ leaseId: string, status: 'stopped'|'failed', lastError?: string, lastResult?: object, now?: string }} details
   * @returns {boolean}
   */
  finishSupervisor(id, { leaseId, status, lastError, lastResult, now: injectedNow } = {}) {
    const now = injectedNow ?? new Date().toISOString();
    const resolvedStatus = status === "failed" ? "failed" : "stopped";
    const errorText = lastError || null;
    const resultJson =
      lastResult !== undefined ? JSON.stringify(lastResult) : null;

    let result;
    if (resultJson !== null) {
      result = this.database
        .prepare(
          `UPDATE supervisors
           SET status = ?, stopped_at = ?, last_error = ?, last_result = ?
           WHERE id = ? AND lease_id = ? AND status = 'running'`
        )
        .run(resolvedStatus, now, errorText, resultJson, id, leaseId);
    } else {
      result = this.database
        .prepare(
          `UPDATE supervisors
           SET status = ?, stopped_at = ?, last_error = ?
           WHERE id = ? AND lease_id = ? AND status = 'running'`
        )
        .run(resolvedStatus, now, errorText, id, leaseId);
    }

    const succeeded = result.changes === 1;
    if (succeeded) {
      this.#supervisorEvent(
        id,
        resolvedStatus === "failed" ? "failure" : "finish",
        { status: resolvedStatus, lastError: errorText },
        now
      );
    }
    return succeeded;
  }

  /**
   * Record a non-terminal supervisor failure: update last_error and emit a
   * "failure" lifecycle event without changing the supervisor status.
   * Fenced by leaseId and status='running'. Returns true if the update succeeded.
   *
   * @param {string} id
   * @param {{ leaseId: string, error: string, consecutiveFailures: number, now?: string }} details
   * @returns {boolean}
   */
  recordSupervisorFailure(id, { leaseId, error, consecutiveFailures, now: injectedNow }) {
    const now = injectedNow ?? new Date().toISOString();
    const result = this.database
      .prepare(
        "UPDATE supervisors SET last_error = ? WHERE id = ? AND lease_id = ? AND status = 'running'"
      )
      .run(error, id, leaseId);

    const succeeded = result.changes === 1;
    if (succeeded) {
      this.#supervisorEvent(
        id,
        "failure",
        { consecutiveFailures, error },
        now
      );
    }
    return succeeded;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  #event(runId, state, payload, createdAt) {
    this.database
      .prepare(
        "INSERT INTO events(run_id, state, payload, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(runId, state, JSON.stringify(payload), createdAt);
  }

  #supervisorEvent(supervisorId, event, payload, createdAt) {
    this.database
      .prepare(
        `INSERT INTO supervisor_events(supervisor_id, event, payload, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(supervisorId, event, JSON.stringify(payload), createdAt);
  }

  #shapeSupervisor(row) {
    return {
      id: row.id,
      leaseId: row.lease_id || null,
      pid: row.pid,
      status: row.status,
      mode: row.mode,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      stopRequestedAt: row.stop_requested_at || null,
      stoppedAt: row.stopped_at || null,
      cycleCount: row.cycle_count,
      lastError: row.last_error || null,
      lastResult: row.last_result ? JSON.parse(row.last_result) : null
    };
  }
}
