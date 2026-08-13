import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { computePlanFingerprint } from "./policy.js";

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
      CREATE TABLE IF NOT EXISTS epics (
        epic_key TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        model_budget INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS epic_tasks (
        epic_key TEXT NOT NULL,
        issue_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        branch TEXT NOT NULL,
        state TEXT NOT NULL,
        model TEXT,
        budget INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (epic_key, issue_key)
      );
      CREATE TABLE IF NOT EXISTS epic_integrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epic_key TEXT NOT NULL,
        issue_key TEXT NOT NULL,
        leaf_branch TEXT NOT NULL,
        state TEXT NOT NULL,
        conflict TEXT,
        commit_sha TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (epic_key, issue_key)
      );
      CREATE TABLE IF NOT EXISTS epic_notifications (
        epic_key TEXT NOT NULL,
        event TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        PRIMARY KEY (epic_key, event)
      );
      CREATE TABLE IF NOT EXISTS pm_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pm_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_key TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_definitions (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        definition TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
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
                (SELECT payload FROM events usage_event
                 WHERE usage_event.run_id = r.id
                   AND json_type(usage_event.payload, '$.usage') = 'object'
                 ORDER BY usage_event.id DESC LIMIT 1) AS latest_usage_payload,
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
          : {},
        latest_usage_payload: run.latest_usage_payload
          ? JSON.parse(run.latest_usage_payload)
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

  //%   Epic context and serialized integration %% %% %% %% %% %% %% %% %%  

  upsertEpic({ key, summary, branch, baseBranch = "develop", modelBudget = 0 }) {
    const now = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO epics(epic_key, summary, branch, base_branch, state, model_budget, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT(epic_key) DO UPDATE SET
         summary = excluded.summary, branch = excluded.branch,
         base_branch = excluded.base_branch, model_budget = excluded.model_budget,
         updated_at = excluded.updated_at`
    ).run(key, summary || key, branch, baseBranch, Number(modelBudget) || 0, now, now);
    return this.getEpic(key);
  }

  getEpic(epicKey) {
    const epic = this.database.prepare("SELECT * FROM epics WHERE epic_key = ?").get(epicKey);
    if (!epic) return null;
    return {
      key: epic.epic_key, summary: epic.summary, branch: epic.branch,
      baseBranch: epic.base_branch, state: epic.state, modelBudget: epic.model_budget,
      createdAt: epic.created_at, updatedAt: epic.updated_at,
      tasks: this.listEpicTasks(epicKey),
      integrations: this.listEpicIntegrations(epicKey)
    };
  }

  listEpics(limit = 50) {
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 200));
    return this.database.prepare(
      "SELECT epic_key FROM epics ORDER BY updated_at DESC LIMIT ?"
    ).all(bounded).map((row) => this.getEpic(row.epic_key));
  }

  upsertEpicTask({ epicKey, issueKey, summary, branch, state = "planned", model = null, budget = 0 }) {
    const now = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO epic_tasks(epic_key, issue_key, summary, branch, state, model, budget, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(epic_key, issue_key) DO UPDATE SET
         summary = excluded.summary, branch = excluded.branch, state = excluded.state,
         model = excluded.model, budget = excluded.budget, updated_at = excluded.updated_at`
    ).run(epicKey, issueKey, summary || issueKey, branch, state, model, Number(budget) || 0, now);
    return this.getEpicTask(epicKey, issueKey);
  }

  getEpicTask(epicKey, issueKey) {
    const row = this.database.prepare(
      "SELECT * FROM epic_tasks WHERE epic_key = ? AND issue_key = ?"
    ).get(epicKey, issueKey);
    return row ? this.#shapeEpicTask(row) : null;
  }

  listEpicTasks(epicKey) {
    return this.database.prepare(
      "SELECT * FROM epic_tasks WHERE epic_key = ? ORDER BY issue_key"
    ).all(epicKey).map((row) => this.#shapeEpicTask(row));
  }

  listEpicIntegrations(epicKey) {
    return this.database.prepare(
      "SELECT * FROM epic_integrations WHERE epic_key = ? ORDER BY id"
    ).all(epicKey).map((row) => this.#shapeIntegration(row));
  }

  /**
   * Single-writer queue for epic integration. The unique owner is the task
   * row in state integrating; any active owner blocks a second request.
   */
  queueEpicIntegration({ epicKey, issueKey, leafBranch }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const active = this.database.prepare(
        "SELECT issue_key FROM epic_integrations WHERE epic_key = ? AND state IN ('queued', 'integrating') LIMIT 1"
      ).get(epicKey);
      if (active && active.issue_key !== issueKey) {
        this.database.exec("COMMIT");
        return { queued: false, blocked: true, reason: `Integration in progress for ${active.issue_key}` };
      }
      const task = this.getEpicTask(epicKey, issueKey);
      if (!task) throw new Error(`Unknown epic task: ${epicKey}/${issueKey}`);
      if (task.state === "blocked-conflict") {
        this.database.exec("COMMIT");
        return { queued: false, blocked: true, reason: "Task has an unresolved integration conflict" };
      }
      const now = new Date().toISOString();
      this.database.prepare(
        `INSERT INTO epic_integrations(epic_key, issue_key, leaf_branch, state, conflict, commit_sha, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', NULL, NULL, ?, ?)
         ON CONFLICT(epic_key, issue_key) DO UPDATE SET
           leaf_branch = excluded.leaf_branch, state = 'queued', conflict = NULL,
           updated_at = excluded.updated_at`
      ).run(epicKey, issueKey, leafBranch, now, now);
      this.database.prepare(
        "UPDATE epic_tasks SET state = 'integration-queued', updated_at = ? WHERE epic_key = ? AND issue_key = ?"
      ).run(now, epicKey, issueKey);
      this.database.exec("COMMIT");
      return { queued: true, blocked: false, integration: this.listEpicIntegrations(epicKey).find((row) => row.issueKey === issueKey) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimEpicIntegration({ epicKey, issueKey }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const competing = this.database.prepare(
        "SELECT issue_key FROM epic_integrations WHERE epic_key = ? AND state = 'integrating' AND issue_key <> ? LIMIT 1"
      ).get(epicKey, issueKey);
      if (competing) {
        this.database.exec("COMMIT");
        return { claimed: false, reason: `Integration owned by ${competing.issue_key}` };
      }
      const now = new Date().toISOString();
      const result = this.database.prepare(
        `UPDATE epic_integrations SET state = 'integrating', updated_at = ?
         WHERE epic_key = ? AND issue_key = ? AND state = 'queued'`
      ).run(now, epicKey, issueKey);
      this.database.exec("COMMIT");
      return result.changes === 1
        ? { claimed: true }
        : { claimed: false, reason: "Integration is not queued" };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  finishEpicIntegration({ epicKey, issueKey, conflict = null, commit = null }) {
    const now = new Date().toISOString();
    const state = conflict ? "conflict" : "integrated";
    const taskState = conflict ? "blocked-conflict" : "integrated";
    const result = this.database.prepare(
      `UPDATE epic_integrations SET state = ?, conflict = ?, commit_sha = ?, updated_at = ?
       WHERE epic_key = ? AND issue_key = ? AND state IN ('queued', 'integrating')`
    ).run(state, conflict, commit, now, epicKey, issueKey);
    if (result.changes !== 1) {
      return { completed: false, reason: "No queued integration owned by this task" };
    }
    this.database.prepare(
      "UPDATE epic_tasks SET state = ?, updated_at = ? WHERE epic_key = ? AND issue_key = ?"
    ).run(taskState, now, epicKey, issueKey);
    return { completed: true, state, task: this.getEpicTask(epicKey, issueKey) };
  }

  getEpicReadyGate(epicKey) {
    const epic = this.getEpic(epicKey);
    if (!epic) return { ready: false, reasons: ["Unknown epic"], epic: null };
    const tasks = epic.tasks;
    const integrations = epic.integrations;
    const unresolved = integrations.filter((item) => ["queued", "integrating", "conflict"].includes(item.state));
    const missing = tasks.filter((task) => task.state !== "integrated");
    const reasons = [];
    if (tasks.length === 0) reasons.push("Epic has no registered leaf tasks");
    if (missing.length) reasons.push(`Leaves not integrated: ${missing.map((task) => task.issueKey).join(", ")}`);
    if (unresolved.length) reasons.push(`Integration queue not clear: ${unresolved.map((item) => item.issueKey).join(", ")}`);
    return { ready: reasons.length === 0, reasons, epic, completedLeaves: tasks.length - missing.length, totalLeaves: tasks.length };
  }

  /**
   * The insert is the idempotency fence. It reserves local completion delivery;
   * no external side effect is performed here.
   */
  reserveEpicNotification(epicKey, event) {
    const now = new Date().toISOString();
    try {
      this.database.prepare(
        "INSERT INTO epic_notifications(epic_key, event, state, created_at, sent_at) VALUES (?, ?, 'pending', ?, NULL)"
      ).run(epicKey, event, now);
      return { reserved: true, notification: { epicKey, event, state: "pending", createdAt: now } };
    } catch (error) {
      if (error.code === "ERR_SQLITE_ERROR") {
        const row = this.database.prepare(
          "SELECT * FROM epic_notifications WHERE epic_key = ? AND event = ?"
        ).get(epicKey, event);
        return { reserved: false, notification: row ? this.#shapeNotification(row) : null };
      }
      throw error;
    }
  }

  markEpicNotificationSent(epicKey, event) {
    const now = new Date().toISOString();
    const result = this.database.prepare(
      "UPDATE epic_notifications SET state = 'sent', sent_at = ? WHERE epic_key = ? AND event = ? AND state = 'pending'"
    ).run(now, epicKey, event);
    return result.changes === 1;
  }

  listEpicNotifications(epicKey) {
    return this.database.prepare(
      "SELECT * FROM epic_notifications WHERE epic_key = ? ORDER BY created_at DESC"
    ).all(epicKey).map((row) => this.#shapeNotification(row));
  }

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

  #shapeEpicTask(row) {
    return {
      epicKey: row.epic_key, issueKey: row.issue_key, summary: row.summary,
      branch: row.branch, state: row.state, model: row.model || null,
      budget: row.budget, updatedAt: row.updated_at
    };
  }

  #shapeIntegration(row) {
    return {
      id: row.id, epicKey: row.epic_key, issueKey: row.issue_key,
      leafBranch: row.leaf_branch, state: row.state, conflict: row.conflict || null,
      commit: row.commit_sha || null, createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  #shapeNotification(row) {
    return {
      epicKey: row.epic_key, event: row.event, state: row.state,
      createdAt: row.created_at, sentAt: row.sent_at || null
    };
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
  addPmMessage(issueKey, role, content) {
    const now = new Date().toISOString();
    this.database.prepare(
      "INSERT INTO pm_messages(issue_key, role, content, created_at) VALUES (?, ?, ?, ?)"
    ).run(issueKey, role, content, now);
  }

  getPmMessages(issueKey) {
    return this.database.prepare(
      "SELECT role, content, created_at as createdAt FROM pm_messages WHERE issue_key = ? ORDER BY id ASC"
    ).all(issueKey);
  }

  listPmMessages(limit = 100) {
    return this.database.prepare(
      "SELECT issue_key as issueKey, role, content, created_at as createdAt FROM pm_messages ORDER BY id DESC LIMIT ?"
    ).all(limit).reverse();
  }

  addPmDecision(issueKey, type, payload) {
    const now = new Date().toISOString();
    this.database.prepare(
      "INSERT INTO pm_decisions(issue_key, type, payload, created_at) VALUES (?, ?, ?, ?)"
    ).run(issueKey, type, JSON.stringify(payload), now);
  }

  recordApprovalDecision(issueKey, {
    action = "implementation",
    approved,
    approver = "human",
    plan = null,
    planFingerprint = null,
    attempt = 0,
    reason = null
  }) {
    const fingerprint = planFingerprint || (plan?.configSnapshot ? computePlanFingerprint(plan) : null);
    const payload = {
      action: String(action),
      approved: Boolean(approved),
      approver: String(approver),
      planFingerprint: fingerprint,
      attempt: Number(attempt) || 0,
      reason: reason ? String(reason) : null,
      plan: plan ? { issue: plan.issue, summary: plan.summary, allowedPaths: plan.allowedPaths, taskAgent: plan.taskAgent } : null
    };
    this.addPmDecision(issueKey, "execution_approval", payload);
    return payload;
  }

  hasExecutionApproval(issueKey, { action = "implementation", plan = null, planFingerprint = null, attempt = 0 } = {}) {
    const decisions = this.getPmDecisions(issueKey);
    const approvalDecisions = decisions.filter(d => d.type === "execution_approval");
    if (approvalDecisions.length === 0) return null;

    const expectedFingerprint = planFingerprint || (plan?.configSnapshot ? computePlanFingerprint(plan) : null);
    const expectedAction = String(action);
    const expectedAttempt = Number(attempt) || 0;

    const matching = approvalDecisions.filter(d => {
      const p = d.payload;
      if (p.action && p.action !== expectedAction) return false;
      if (expectedAction === "rework" && p.attempt !== undefined && p.attempt !== expectedAttempt) return false;
      if (expectedFingerprint && p.planFingerprint && p.planFingerprint !== expectedFingerprint) {
        return false;
      }
      return true;
    });

    if (matching.length === 0) return null;
    const latest = matching.at(-1);
    return {
      action: latest.payload.action,
      approved: Boolean(latest.payload.approved),
      approver: latest.payload.approver,
      planFingerprint: latest.payload.planFingerprint,
      attempt: latest.payload.attempt,
      reason: latest.payload.reason,
      createdAt: latest.createdAt
    };
  }

  getPmDecisions(issueKey) {
    return this.database.prepare(
      "SELECT type, payload, created_at as createdAt FROM pm_decisions WHERE issue_key = ? ORDER BY id ASC"
    ).all(issueKey).map(row => ({
      ...row,
      payload: JSON.parse(row.payload)
    }));
  }

  listPmDecisions(limit = 100) {
    return this.database.prepare(
      "SELECT issue_key as issueKey, type, payload, created_at as createdAt FROM pm_decisions ORDER BY id DESC LIMIT ?"
    ).all(limit).map(row => ({
      ...row,
      payload: JSON.parse(row.payload)
    }));
  }

  upsertAgentDefinition(id, definition) {
    const now = new Date().toISOString();
    const existing = this.getAgentDefinition(id);
    const version = existing ? existing.version + 1 : 1;
    if (existing) {
      this.database.prepare(
        "UPDATE agent_definitions SET version = ?, definition = ?, updated_at = ? WHERE id = ?"
      ).run(version, JSON.stringify(definition), now, id);
    } else {
      this.database.prepare(
        "INSERT INTO agent_definitions(id, version, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(id, version, JSON.stringify(definition), now, now);
    }
  }

  getAgentDefinition(id) {
    const row = this.database.prepare("SELECT * FROM agent_definitions WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      definition: JSON.parse(row.definition),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listAgentDefinitions() {
    return this.database.prepare("SELECT * FROM agent_definitions ORDER BY id ASC").all().map(row => ({
      id: row.id,
      version: row.version,
      definition: JSON.parse(row.definition),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  addUsageEvent(runId, provider, model, inputTokens, outputTokens, durationMs) {
    const now = new Date().toISOString();
    this.database.prepare(
      "INSERT INTO usage_events(run_id, provider, model, input_tokens, output_tokens, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(runId, provider, model, inputTokens || 0, outputTokens || 0, durationMs || 0, now);
  }

  listUsageEvents(limit = 100) {
    return this.database.prepare(
      "SELECT run_id as runId, provider, model, input_tokens as inputTokens, output_tokens as outputTokens, duration_ms as durationMs, created_at as createdAt FROM usage_events ORDER BY id DESC LIMIT ?"
    ).all(limit);
  }
}
