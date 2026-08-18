import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  computePlanFingerprint,
  computeIntegrationFingerprint,
  computeParentBranchFingerprint,
  computeParentReviewFingerprint
} from "./policy.js";
import { validateAgentDefinition, computeAgentDefinitionHash, BUILTIN_AGENT_SEEDS } from "./agent-registry.js";
import { redactTelemetryPayload, normalizeUsage } from "./telemetry.js";

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
        worktree TEXT,
        state TEXT NOT NULL,
        orchestration_state TEXT,
        dependencies TEXT,
        child_base_sha TEXT,
        reviewed_sha TEXT,
        integrated_sha TEXT,
        blocked_reasons TEXT,
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
        status TEXT NOT NULL DEFAULT 'enabled',
        current_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_versions (
        agent_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(agent_id, version)
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discovered_work_items (
        issue_key TEXT PRIMARY KEY,
        source_provider TEXT NOT NULL,
        source_url TEXT,
        summary TEXT NOT NULL,
        raw_payload TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telemetry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        run_id TEXT NOT NULL,
        issue_key TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'implementation',
        action TEXT NOT NULL DEFAULT 'implementation',
        attempt INTEGER NOT NULL DEFAULT 0,
        persona TEXT,
        task_agent TEXT,
        agent_version INTEGER,
        agent_hash TEXT,
        provider TEXT,
        model TEXT,
        model_profile TEXT,
        effort TEXT,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        usage_available INTEGER NOT NULL DEFAULT 0,
        error_category TEXT,
        error_message TEXT,
        raw_payload TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS parent_executions (
        parent_key TEXT PRIMARY KEY,
        source_provider TEXT NOT NULL,
        source_id TEXT,
        source_url TEXT,
        summary TEXT NOT NULL,
        description TEXT,
        acceptance_criteria TEXT,
        type TEXT NOT NULL DEFAULT 'Epic',
        base_ref TEXT NOT NULL DEFAULT 'develop',
        base_sha TEXT,
        integration_branch TEXT NOT NULL,
        integration_worktree TEXT,
        integration_head_sha TEXT,
        graph_fingerprint TEXT NOT NULL,
        dag_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        completion_packet_json TEXT,
        drift_detected INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Schema migration for parent_executions columns
    const parentExecCols = this.database.prepare("PRAGMA table_info(parent_executions)").all().map(c => c.name);
    if (parentExecCols.length > 0) {
      if (!parentExecCols.includes("description")) this.database.exec("ALTER TABLE parent_executions ADD COLUMN description TEXT;");
      if (!parentExecCols.includes("acceptance_criteria")) this.database.exec("ALTER TABLE parent_executions ADD COLUMN acceptance_criteria TEXT;");
    }

    // Schema migration for epic_tasks columns
    const epicTaskCols = this.database.prepare("PRAGMA table_info(epic_tasks)").all().map(c => c.name);
    if (epicTaskCols.length > 0) {
      if (!epicTaskCols.includes("dependencies")) this.database.exec("ALTER TABLE epic_tasks ADD COLUMN dependencies TEXT;");
      if (!epicTaskCols.includes("child_base_sha")) this.database.exec("ALTER TABLE epic_tasks ADD COLUMN child_base_sha TEXT;");
      if (!epicTaskCols.includes("worktree")) this.database.exec("ALTER TABLE epic_tasks ADD COLUMN worktree TEXT;");
      if (!epicTaskCols.includes("reviewed_sha")) this.database.exec("ALTER TABLE epic_tasks ADD COLUMN reviewed_sha TEXT;");
      if (!epicTaskCols.includes("integrated_sha")) this.database.exec("ALTER TABLE epic_tasks ADD COLUMN integrated_sha TEXT;");
      if (!epicTaskCols.includes("orchestration_state")) this.database.exec("ALTER TABLE epic_tasks ADD COLUMN orchestration_state TEXT;");
      if (!epicTaskCols.includes("blocked_reasons")) this.database.exec("ALTER TABLE epic_tasks ADD COLUMN blocked_reasons TEXT;");
    }

    // Schema migration for legacy agent_definitions table if needed
    const agentCols = this.database.prepare("PRAGMA table_info(agent_definitions)").all().map(c => c.name);
    if (agentCols.length > 0 && !agentCols.includes("current_version")) {
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        this.database.exec(`
          ALTER TABLE agent_definitions RENAME TO agent_definitions_legacy;
          CREATE TABLE agent_definitions (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'enabled',
            current_version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS agent_versions (
            agent_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            definition_json TEXT NOT NULL,
            definition_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(agent_id, version)
          );
        `);
        const legacyRows = this.database.prepare("SELECT * FROM agent_definitions_legacy").all();
        for (const row of legacyRows) {
          const defObj = JSON.parse(row.definition);
          const hash = computeAgentDefinitionHash({ ...defObj, id: row.id });
          const v = row.version || 1;
          this.database.prepare(
            "INSERT INTO agent_definitions(id, status, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
          ).run(row.id, defObj.status || "enabled", v, row.created_at || new Date().toISOString(), row.updated_at || new Date().toISOString());
          this.database.prepare(
            "INSERT INTO agent_versions(agent_id, version, definition_json, definition_hash, created_at) VALUES (?, ?, ?, ?, ?)"
          ).run(row.id, v, JSON.stringify(defObj), hash, row.created_at || new Date().toISOString());
        }
        this.database.exec("DROP TABLE agent_definitions_legacy; COMMIT;");
      } catch (err) {
        this.database.exec("ROLLBACK;");
        throw new Error(`Agent definitions migration failed: ${err.message}`);
      }
    }

    // Schema migration for usage_events nullable columns
    const usageCols = this.database.prepare("PRAGMA table_info(usage_events)").all();
    if (usageCols.length > 0) {
      const needsMigration = usageCols.some(
        (c) => ["input_tokens", "output_tokens", "duration_ms"].includes(c.name) && c.notnull === 1
      );
      if (needsMigration) {
        this.database.exec("BEGIN IMMEDIATE;");
        try {
          this.database.exec(`
            DROP TABLE IF EXISTS usage_events_dg_tmp;
            CREATE TABLE usage_events_dg_tmp (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              run_id TEXT NOT NULL,
              provider TEXT NOT NULL,
              model TEXT NOT NULL,
              input_tokens INTEGER,
              output_tokens INTEGER,
              duration_ms INTEGER,
              created_at TEXT NOT NULL
            );
            INSERT INTO usage_events_dg_tmp(id, run_id, provider, model, input_tokens, output_tokens, duration_ms, created_at)
            SELECT id, run_id, provider, model, input_tokens, output_tokens, duration_ms, created_at FROM usage_events;
            DROP TABLE usage_events;
            ALTER TABLE usage_events_dg_tmp RENAME TO usage_events;
          `);
          this.database.exec("COMMIT;");
        } catch (err) {
          this.database.exec("ROLLBACK;");
          throw new Error(`Usage events migration failed: ${err.message}`);
        }
      }
    }

    // Seed builtin agents idempotently on startup
    this.seedBuiltinAgents();
  }

  createRun(issueKey, payload) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const body = JSON.stringify(payload);
    const inTx = Boolean(this.database.inTransaction);
    if (!inTx) this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, issueKey, "discovered", body, now, now);
      this.#event(id, "discovered", payload, now);
      if (!inTx) this.database.exec("COMMIT;");
      return id;
    } catch (err) {
      if (!inTx) this.database.exec("ROLLBACK;");
      throw err;
    }
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
    const inTx = Boolean(this.database.inTransaction);
    if (!inTx) this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare("UPDATE runs SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, now, runId);
      this.#event(runId, state, payload, now);
      if (!inTx) this.database.exec("COMMIT;");
    } catch (err) {
      if (!inTx) this.database.exec("ROLLBACK;");
      throw err;
    }
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

  listRunsForIssue(issueKey) {
    return this.database
      .prepare("SELECT * FROM runs WHERE issue_key = ? ORDER BY created_at ASC")
      .all(issueKey)
      .map(r => ({
        ...r,
        payload: JSON.parse(r.payload),
        events: this.listTelemetryEvents(r.id).length > 0
          ? this.listTelemetryEvents(r.id)
          : this.database.prepare("SELECT state, payload, created_at FROM events WHERE run_id = ? ORDER BY id ASC").all(r.id).map(e => ({ ...e, payload: JSON.parse(e.payload) }))
      }));
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
        const currentTimeMs = new Date(now).getTime();
        const heartbeatAge =
          (currentTimeMs - new Date(existing.heartbeat_at).getTime()) / 1000;
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
    const inTx = Boolean(this.database.inTransaction);
    if (!inTx) this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare(
          "UPDATE supervisors SET stop_requested_at = ? WHERE id = ?"
        )
        .run(now, id);
      this.#supervisorEvent(id, "stop-request", {}, now);
      if (!inTx) this.database.exec("COMMIT;");
    } catch (err) {
      if (!inTx) this.database.exec("ROLLBACK;");
      throw err;
    }
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

    const inTx = Boolean(this.database.inTransaction);
    if (!inTx) this.database.exec("BEGIN IMMEDIATE;");
    try {
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
      if (!inTx) this.database.exec("COMMIT;");
      return succeeded;
    } catch (err) {
      if (!inTx) this.database.exec("ROLLBACK;");
      throw err;
    }
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
    const inTx = Boolean(this.database.inTransaction);
    if (!inTx) this.database.exec("BEGIN IMMEDIATE;");
    try {
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
      if (!inTx) this.database.exec("COMMIT;");
      return succeeded;
    } catch (err) {
      if (!inTx) this.database.exec("ROLLBACK;");
      throw err;
    }
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

  upsertEpicTask({
    epicKey,
    parentKey,
    issueKey,
    summary,
    branch,
    worktree = null,
    state = "planned",
    orchestrationState = null,
    dependencies = [],
    childBaseSha = null,
    reviewedSha = null,
    integratedSha = null,
    blockedReasons = [],
    model = null,
    budget = 0
  }) {
    const pKey = parentKey || epicKey;
    const now = new Date().toISOString();
    const depsJson = JSON.stringify(dependencies || []);
    const blockedJson = JSON.stringify(blockedReasons || []);
    const orchState = orchestrationState || state;
    this.database.prepare(
      `INSERT INTO epic_tasks(epic_key, issue_key, summary, branch, worktree, state, orchestration_state, dependencies, child_base_sha, reviewed_sha, integrated_sha, blocked_reasons, model, budget, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(epic_key, issue_key) DO UPDATE SET
         summary = excluded.summary, branch = excluded.branch,
         worktree = coalesce(excluded.worktree, epic_tasks.worktree),
         state = excluded.state,
         orchestration_state = excluded.orchestration_state,
         dependencies = excluded.dependencies,
         child_base_sha = coalesce(excluded.child_base_sha, epic_tasks.child_base_sha),
         reviewed_sha = coalesce(excluded.reviewed_sha, epic_tasks.reviewed_sha),
         integrated_sha = coalesce(excluded.integrated_sha, epic_tasks.integrated_sha),
         blocked_reasons = excluded.blocked_reasons,
         model = excluded.model, budget = excluded.budget, updated_at = excluded.updated_at`
    ).run(
      pKey,
      issueKey,
      summary || issueKey,
      branch,
      worktree,
      state,
      orchState,
      depsJson,
      childBaseSha,
      reviewedSha,
      integratedSha,
      blockedJson,
      model,
      Number(budget) || 0,
      now
    );
    return this.getEpicTask(pKey, issueKey);
  }

  getEpicTask(epicKey, issueKey) {
    const row = this.database.prepare(
      "SELECT * FROM epic_tasks WHERE epic_key = ? AND issue_key = ?"
    ).get(epicKey, issueKey);
    return row ? this.#shapeEpicTask(row) : null;
  }

  listEpicTasks(epicKey = null) {
    if (!epicKey) {
      return this.database.prepare(
        "SELECT * FROM epic_tasks ORDER BY issue_key"
      ).all().map((row) => this.#shapeEpicTask(row));
    }
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
    const inTx = Boolean(this.database.inTransaction);
    if (!inTx) this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = this.database.prepare(
        `UPDATE epic_integrations SET state = ?, conflict = ?, commit_sha = ?, updated_at = ?
         WHERE epic_key = ? AND issue_key = ? AND state IN ('queued', 'integrating')`
      ).run(state, conflict, commit, now, epicKey, issueKey);
      if (result.changes !== 1) {
        if (!inTx) this.database.exec("COMMIT;");
        return { completed: false, reason: "No queued integration owned by this task" };
      }
      this.database.prepare(
        "UPDATE epic_tasks SET state = ?, updated_at = ? WHERE epic_key = ? AND issue_key = ?"
      ).run(taskState, now, epicKey, issueKey);
      if (!inTx) this.database.exec("COMMIT;");
      return { completed: true, state, task: this.getEpicTask(epicKey, issueKey) };
    } catch (err) {
      if (!inTx) this.database.exec("ROLLBACK;");
      throw err;
    }
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

  // ── Parent Execution methods ───────────────────────────────────────────────

  upsertParentExecution({
    parentKey,
    sourceProvider = "work-source",
    sourceId = null,
    sourceUrl = null,
    summary = "",
    description = "",
    acceptanceCriteria = "",
    acceptance_criteria = "",
    type = "Epic",
    baseRef = "develop",
    baseSha = null,
    integrationBranch = "",
    integrationWorktree = null,
    integrationHeadSha = null,
    graphFingerprint = "",
    dag = null,
    state = "active",
    completionPacket = null,
    driftDetected = false
  }) {
    const now = new Date().toISOString();
    const dagJson = JSON.stringify(dag || {});
    const compJson = completionPacket ? JSON.stringify(completionPacket) : null;
    const finalAcceptanceCriteria = acceptanceCriteria || acceptance_criteria || null;
    this.database.prepare(
      `INSERT INTO parent_executions(
         parent_key, source_provider, source_id, source_url, summary, description, acceptance_criteria, type,
         base_ref, base_sha, integration_branch, integration_worktree, integration_head_sha,
         graph_fingerprint, dag_json, state, completion_packet_json, drift_detected, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(parent_key) DO UPDATE SET
         source_provider = excluded.source_provider,
         source_id = coalesce(excluded.source_id, parent_executions.source_id),
         source_url = coalesce(excluded.source_url, parent_executions.source_url),
         summary = excluded.summary,
         description = coalesce(excluded.description, parent_executions.description),
         acceptance_criteria = coalesce(excluded.acceptance_criteria, parent_executions.acceptance_criteria),
         type = excluded.type,
         base_ref = excluded.base_ref,
         base_sha = coalesce(excluded.base_sha, parent_executions.base_sha),
         integration_branch = excluded.integration_branch,
         integration_worktree = coalesce(excluded.integration_worktree, parent_executions.integration_worktree),
         integration_head_sha = coalesce(excluded.integration_head_sha, parent_executions.integration_head_sha),
         graph_fingerprint = excluded.graph_fingerprint,
         dag_json = excluded.dag_json,
         state = excluded.state,
         completion_packet_json = coalesce(excluded.completion_packet_json, parent_executions.completion_packet_json),
         drift_detected = excluded.drift_detected,
         updated_at = excluded.updated_at`
    ).run(
      parentKey,
      sourceProvider,
      sourceId,
      sourceUrl,
      summary || parentKey,
      description || null,
      finalAcceptanceCriteria,
      type || "Epic",
      baseRef,
      baseSha,
      integrationBranch,
      integrationWorktree,
      integrationHeadSha,
      graphFingerprint,
      dagJson,
      state,
      compJson,
      driftDetected ? 1 : 0,
      now,
      now
    );

    // Also mirror into epics table for legacy compatibility
    this.upsertEpic({
      key: parentKey,
      summary: summary || parentKey,
      branch: integrationBranch,
      baseBranch: baseRef
    });

    return this.getParentExecution(parentKey);
  }

  getParentExecution(parentKey) {
    const row = this.database.prepare("SELECT * FROM parent_executions WHERE parent_key = ?").get(parentKey);
    return row ? this.#shapeParentExecution(row) : null;
  }

  listParentExecutions(limit = 50) {
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 200));
    return this.database.prepare(
      "SELECT * FROM parent_executions ORDER BY updated_at DESC LIMIT ?"
    ).all(bounded).map((row) => this.#shapeParentExecution(row));
  }

  updateParentExecutionState(parentKey, state, payload = {}) {
    const now = new Date().toISOString();
    const updates = ["state = ?", "updated_at = ?"];
    const params = [state, now];

    if (payload.integrationHeadSha !== undefined) {
      updates.push("integration_head_sha = ?");
      params.push(payload.integrationHeadSha);
    }
    if (payload.baseSha !== undefined) {
      updates.push("base_sha = ?");
      params.push(payload.baseSha);
    }
    if (payload.completionPacket !== undefined) {
      updates.push("completion_packet_json = ?");
      params.push(payload.completionPacket ? JSON.stringify(payload.completionPacket) : null);
    }
    if (payload.driftDetected !== undefined) {
      updates.push("drift_detected = ?");
      params.push(payload.driftDetected ? 1 : 0);
    }

    params.push(parentKey);
    this.database.prepare(
      `UPDATE parent_executions SET ${updates.join(", ")} WHERE parent_key = ?`
    ).run(...params);
    return this.getParentExecution(parentKey);
  }

  getNormalizedParentDetail(parentKey) {
    const parent = this.getParentExecution(parentKey) || this.getEpic(parentKey);
    if (!parent) return null;
    const tasks = this.listEpicTasks(parentKey);
    const integrations = this.listEpicIntegrations(parentKey);
    const intMap = new Map(integrations.map((i) => [i.issueKey, i]));

    const children = tasks.map((task) => {
      const integration = intMap.get(task.issueKey);
      return {
        issueKey: task.issueKey,
        summary: task.summary,
        parentKey,
        dependencies: task.dependencies || [],
        dependencyState: (task.dependencies && task.dependencies.length > 0)
          ? (task.dependencies.every(d => intMap.get(d)?.state === "integrated") ? "satisfied" : "waiting")
          : "ready",
        runtimeState: task.state,
        orchestrationState: task.orchestrationState || task.state,
        branch: task.branch,
        worktree: task.worktree,
        childBaseSha: task.childBaseSha,
        reviewedSha: task.reviewedSha,
        integrationState: integration?.state || "not-queued",
        integratedSha: task.integratedSha || integration?.commit || null,
        blockedReasons: task.blockedReasons || []
      };
    });

    const blockedReasons = [];
    if (parent.driftDetected) blockedReasons.push("Hierarchy drift detected");
    for (const c of children) {
      if (c.blockedReasons && c.blockedReasons.length > 0) {
        blockedReasons.push(...c.blockedReasons);
      }
      if (c.runtimeState === "blocked-conflict") {
        blockedReasons.push(`Integration conflict in child ${c.issueKey}`);
      }
    }

    return {
      parent: {
        parentKey: parent.parentKey || parent.key,
        summary: parent.summary,
        description: parent.description || null,
        acceptanceCriteria: parent.acceptanceCriteria || null,
        sourceProvider: parent.sourceProvider || "work-source",
        sourceId: parent.sourceId || null,
        sourceUrl: parent.sourceUrl || null,
        type: parent.type || "Epic",
        createdAt: parent.createdAt,
        updatedAt: parent.updatedAt
      },
      state: parent.state,
      graphFingerprint: parent.graphFingerprint || null,
      baseRef: parent.baseRef || parent.baseBranch || "develop",
      baseSha: parent.baseSha || null,
      integrationBranch: parent.integrationBranch || parent.branch,
      integrationWorktree: parent.integrationWorktree || null,
      integrationHeadSha: parent.integrationHeadSha || null,
      children,
      blockedReasons: [...new Set(blockedReasons)],
      integrationReview: parent.completionPacket?.integrationReview || null,
      completion: parent.completionPacket ? {
        graphFingerprint: parent.completionPacket.graphFingerprint || null,
        baseSha: parent.completionPacket.baseSha || null,
        integrationHeadSha: parent.completionPacket.integrationHeadSha || null,
        children: parent.completionPacket.children || null,
        reviewedShas: parent.completionPacket.reviewedShas || null,
        integratedShas: parent.completionPacket.integratedShas || null,
        verification: parent.completionPacket.verification || null,
        integrationReview: parent.completionPacket.integrationReview || null,
        warnings: parent.completionPacket.warnings || null,
        collectedAt: parent.completionPacket.collectedAt || null
      } : null,
      waitingHuman: parent.state === "waiting_human" || parent.state === "human_approval"
    };
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

  #shapeParentExecution(row) {
    let dag = null;
    if (row.dag_json) {
      try { dag = JSON.parse(row.dag_json); } catch {}
    }
    let completionPacket = null;
    if (row.completion_packet_json) {
      try { completionPacket = JSON.parse(row.completion_packet_json); } catch {}
    }
    return {
      parentKey: row.parent_key,
      sourceProvider: row.source_provider,
      sourceId: row.source_id || null,
      sourceUrl: row.source_url || null,
      summary: row.summary,
      description: row.description || null,
      acceptanceCriteria: row.acceptance_criteria || null,
      type: row.type || "Epic",
      baseRef: row.base_ref,
      baseSha: row.base_sha || null,
      integrationBranch: row.integration_branch,
      integrationWorktree: row.integration_worktree || null,
      integrationHeadSha: row.integration_head_sha || null,
      graphFingerprint: row.graph_fingerprint,
      dag,
      state: row.state,
      completionPacket,
      driftDetected: Boolean(row.drift_detected),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  #shapeEpicTask(row) {
    let dependencies = [];
    if (row.dependencies) {
      try { dependencies = JSON.parse(row.dependencies); } catch {}
    }
    let blockedReasons = [];
    if (row.blocked_reasons) {
      try { blockedReasons = JSON.parse(row.blocked_reasons); } catch {}
    }
    return {
      epicKey: row.epic_key,
      parentKey: row.epic_key,
      issueKey: row.issue_key,
      summary: row.summary,
      branch: row.branch,
      worktree: row.worktree || null,
      state: row.state,
      orchestrationState: row.orchestration_state || row.state,
      dependencies,
      childBaseSha: row.child_base_sha || null,
      reviewedSha: row.reviewed_sha || null,
      integratedSha: row.integrated_sha || null,
      blockedReasons,
      model: row.model || null,
      budget: row.budget,
      updatedAt: row.updated_at
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
    action,
    approved,
    approver = "human",
    plan = null,
    planFingerprint = null,
    attempt = 0,
    reason = null
  } = {}) {
    if (!action || typeof action !== "string") {
      throw new Error("Approval decision requires an action");
    }
    const fingerprint = planFingerprint || (
      action === "childIntegration" && plan
        ? computeIntegrationFingerprint(plan)
        : (action === "branchCreation" && plan && (plan.graphFingerprint || plan.integrationBranch)
            ? computeParentBranchFingerprint(plan)
            : (action === "review" && plan && (plan.integrationHeadSha || plan.parentBaseSha || plan.graphFingerprint)
                ? computeParentReviewFingerprint(plan)
                : (plan ? computePlanFingerprint(plan) : null)))
    );
    const payload = {
      action: String(action),
      approved: Boolean(approved),
      approver: String(approver),
      planFingerprint: fingerprint || null,
      attempt: Number(attempt) || 0,
      reason: reason ? String(reason) : null,
      plan: plan ? { issue: plan.issue, summary: plan.summary, allowedPaths: plan.allowedPaths, taskAgent: plan.taskAgent } : null
    };
    this.addPmDecision(issueKey, "execution_approval", payload);
    return payload;
  }

  hasExecutionApproval(issueKey, { action, plan = null, planFingerprint = null, attempt = 0 } = {}) {
    if (!action || typeof action !== "string") return null;
    const decisions = this.getPmDecisions(issueKey);
    const approvalDecisions = decisions.filter(d => d.type === "execution_approval");
    if (approvalDecisions.length === 0) return null;

    let expectedFingerprint = planFingerprint || null;
    if (!expectedFingerprint && plan) {
      if (action === "childIntegration") {
        expectedFingerprint = computeIntegrationFingerprint(plan);
      } else if (action === "branchCreation" && (plan.graphFingerprint || plan.integrationBranch)) {
        expectedFingerprint = computeParentBranchFingerprint(plan);
      } else if (action === "review" && (plan.integrationHeadSha || plan.parentBaseSha || plan.graphFingerprint)) {
        expectedFingerprint = computeParentReviewFingerprint(plan);
      } else {
        expectedFingerprint = computePlanFingerprint(plan);
      }
    }

    const expectedAction = String(action);
    const expectedAttempt = Number(attempt) || 0;

    const matching = approvalDecisions.filter(d => {
      const p = d.payload;
      if (!p || typeof p !== "object" || !p.action || p.action !== expectedAction) {
        return false;
      }
      if (expectedAction === "rework" && Number(p.attempt || 0) !== expectedAttempt) {
        return false;
      }
      if (expectedFingerprint) {
        if (!p.planFingerprint || typeof p.planFingerprint !== "string" || p.planFingerprint !== expectedFingerprint) {
          return false;
        }
      }
      return true;
    });

    if (matching.length === 0) return null;
    const latest = matching.at(-1);
    return {
      action: latest.payload.action,
      approved: Boolean(latest.payload.approved),
      approver: latest.payload.approver,
      planFingerprint: latest.payload.planFingerprint || null,
      attempt: latest.payload.attempt || 0,
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

  recordDiscoveredWorkItem({ key, issueKey, summary, provider = "jira", url = null, raw = {} } = {}) {
    const k = String(issueKey || key || "").trim();
    if (!k) throw new Error("Discovered work item requires a key");
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO discovered_work_items(issue_key, source_provider, source_url, summary, raw_payload, discovered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_key) DO UPDATE SET
        source_provider = excluded.source_provider,
        source_url = excluded.source_url,
        summary = excluded.summary,
        raw_payload = excluded.raw_payload,
        updated_at = excluded.updated_at
    `).run(
      k,
      String(provider || "jira"),
      url ? String(url) : null,
      String(summary || k),
      JSON.stringify(raw || {}),
      now,
      now
    );
    return this.getDiscoveredWorkItem(k);
  }

  getDiscoveredWorkItem(key) {
    const k = String(key || "").trim();
    const row = this.database.prepare("SELECT * FROM discovered_work_items WHERE issue_key = ?").get(k);
    if (!row) return null;
    return {
      issueKey: row.issue_key,
      sourceProvider: row.source_provider,
      sourceUrl: row.source_url || null,
      summary: row.summary,
      raw: JSON.parse(row.raw_payload),
      discoveredAt: row.discovered_at,
      updatedAt: row.updated_at
    };
  }

  listDiscoveredWorkItems() {
    return this.database.prepare(
      "SELECT * FROM discovered_work_items ORDER BY discovered_at ASC"
    ).all().map(row => ({
      issueKey: row.issue_key,
      sourceProvider: row.source_provider,
      sourceUrl: row.source_url || null,
      summary: row.summary,
      raw: JSON.parse(row.raw_payload),
      discoveredAt: row.discovered_at,
      updatedAt: row.updated_at
    }));
  }

  addUsageEvent(
    runId,
    provider,
    model,
    inputTokens,
    outputTokens,
    durationMs,
    createdAt = null
  ) {
    const now = createdAt || new Date().toISOString();
    const inTokens = inputTokens !== null && inputTokens !== undefined && Number.isFinite(Number(inputTokens)) ? Number(inputTokens) : null;
    const outTokens = outputTokens !== null && outputTokens !== undefined && Number.isFinite(Number(outputTokens)) ? Number(outputTokens) : null;
    const durMs = durationMs !== null && durationMs !== undefined && Number.isFinite(Number(durationMs)) ? Number(durationMs) : null;
    this.database.prepare(`
      INSERT INTO usage_events(run_id, provider, model, input_tokens, output_tokens, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(runId),
      String(provider || "unknown"),
      String(model || "default"),
      inTokens,
      outTokens,
      durMs,
      now
    );
  }

  recordUsageEvent(input, ...rest) {
    if (typeof input === "object" && input !== null) {
      const { runId, provider, model, inputTokens, outputTokens, durationMs, createdAt } = input;
      return this.addUsageEvent(runId, provider, model, inputTokens, outputTokens, durationMs, createdAt);
    }
    return this.addUsageEvent(input, ...rest);
  }

  listUsageEvents(limitOrRunId = 100, opts = {}) {
    let limit = 100;
    let runId = null;

    if (typeof limitOrRunId === "string") {
      runId = limitOrRunId;
      limit = typeof opts === "number" ? opts : (opts?.limit || 100);
    } else if (typeof limitOrRunId === "number") {
      limit = limitOrRunId;
      runId = opts?.runId || null;
    } else if (typeof limitOrRunId === "object" && limitOrRunId !== null) {
      limit = limitOrRunId.limit || 100;
      runId = limitOrRunId.runId || null;
    }

    if (runId) {
      return this.database.prepare(
        "SELECT id, run_id as runId, provider, model, input_tokens as inputTokens, output_tokens as outputTokens, duration_ms as durationMs, created_at as createdAt FROM usage_events WHERE run_id = ? ORDER BY id ASC LIMIT ?"
      ).all(String(runId), limit);
    }

    return this.database.prepare(
      "SELECT id, run_id as runId, provider, model, input_tokens as inputTokens, output_tokens as outputTokens, duration_ms as durationMs, created_at as createdAt FROM usage_events ORDER BY id DESC LIMIT ?"
    ).all(limit);
  }

  recordTelemetryEvent(data = {}) {
    const eventId = data.eventId;
    if (!eventId || typeof eventId !== "string" || !eventId.trim()) {
      throw new Error("recordTelemetryEvent requires an explicit, deterministic eventId");
    }

    const runId = String(data.runId || "");
    if (!runId) {
      throw new Error("recordTelemetryEvent requires a runId");
    }

    // Telemetry must reference an existing run
    const run = this.database.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
    if (!run) {
      throw new Error(`Cannot record telemetry event: run '${runId}' does not exist`);
    }

    const now = data.createdAt || data.timestamp || new Date().toISOString();
    const stage = String(data.stage || "progress");
    const status = String(data.status || "running");
    const sequence = Number(data.sequence || 0);

    // Recursively redact metadata and error payload before persistence!
    const sanitizedError = data.error ? redactTelemetryPayload(data.error) : null;
    const sanitizedRaw = data.raw ? redactTelemetryPayload(data.raw) : (data.metadata ? redactTelemetryPayload(data.metadata) : null);
    const usage = data.usage ? normalizeUsage(data.usage) : {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      available: false
    };

    let recorded = false;

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      // 1. Check if eventId already exists (idempotency)
      const existingEvent = this.database.prepare("SELECT id FROM telemetry_events WHERE event_id = ?").get(eventId);
      if (existingEvent) {
        this.database.exec("COMMIT;");
        return { eventId, recorded: false };
      }

      // 2. Lifecycle checks for this run
      const existingStages = this.database.prepare(
        "SELECT stage, sequence FROM telemetry_events WHERE run_id = ? ORDER BY sequence ASC, id ASC"
      ).all(runId);

      const hasTerminal = existingStages.some(e => e.stage === "terminal");
      if (hasTerminal) {
        // If run is already terminal, reject any further started/progress/model_selected or duplicate terminal
        this.database.exec("COMMIT;");
        return { eventId, recorded: false };
      }

      const hasQueued = existingStages.some(e => e.stage === "queued");
      const hasStarted = existingStages.some(e => e.stage === "started");

      // Canonical lifecycle state transitions:
      if (stage === "queued") {
        if (hasQueued) {
          this.database.exec("COMMIT;");
          return { eventId, recorded: false };
        }
      } else if (stage === "started") {
        if (!hasQueued || hasStarted) {
          this.database.exec("COMMIT;");
          return { eventId, recorded: false };
        }
      } else if (stage === "progress" || stage === "model_selected") {
        if (!hasStarted) {
          this.database.exec("COMMIT;");
          return { eventId, recorded: false };
        }
      } else if (stage === "terminal") {
        if (!hasQueued || !hasStarted) {
          this.database.exec("COMMIT;");
          return { eventId, recorded: false };
        }
      }

      // Monotonicity: sequence cannot silently move backwards
      if (existingStages.length > 0) {
        const maxSeq = Math.max(...existingStages.map(e => e.sequence));
        if (sequence < maxSeq) {
          this.database.exec("COMMIT;");
          return { eventId, recorded: false };
        }
      }

      // 3. Insert telemetry event
      this.database.prepare(`
        INSERT INTO telemetry_events(
          event_id, run_id, issue_key, role, action, attempt,
          persona, task_agent, agent_version, agent_hash,
          provider, model, model_profile, effort,
          stage, status, sequence, duration_ms,
          input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, total_tokens, usage_available,
          error_category, error_message, raw_payload, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?
        )
      `).run(
        eventId,
        runId,
        String(data.issueKey || ""),
        String(data.role || "implementation"),
        String(data.action || "implementation"),
        Number(data.attempt || 0),
        data.persona ? String(data.persona) : null,
        data.taskAgent ? String(data.taskAgent) : null,
        data.agentVersion !== undefined && data.agentVersion !== null ? Number(data.agentVersion) : null,
        data.agentHash ? String(data.agentHash) : null,
        data.provider ? String(data.provider) : null,
        data.model ? String(data.model) : null,
        data.modelProfile ? String(data.modelProfile) : null,
        data.effort ? String(data.effort) : null,
        stage,
        status,
        sequence,
        data.durationMs !== undefined && data.durationMs !== null ? Number(data.durationMs) : null,
        usage.inputTokens !== undefined && usage.inputTokens !== null ? Number(usage.inputTokens) : null,
        usage.outputTokens !== undefined && usage.outputTokens !== null ? Number(usage.outputTokens) : null,
        usage.cachedInputTokens !== undefined && usage.cachedInputTokens !== null ? Number(usage.cachedInputTokens) : null,
        usage.reasoningTokens !== undefined && usage.reasoningTokens !== null ? Number(usage.reasoningTokens) : null,
        usage.totalTokens !== undefined && usage.totalTokens !== null ? Number(usage.totalTokens) : null,
        usage.available ? 1 : 0,
        sanitizedError?.category ? String(sanitizedError.category) : null,
        sanitizedError?.safeMessage ? String(sanitizedError.safeMessage) : (typeof sanitizedError === "string" ? sanitizedError : null),
        sanitizedRaw ? JSON.stringify(sanitizedRaw) : null,
        now
      );

      // 4. If usage is available and has non-zero or defined tokens, record usage event
      if (usage.available && (usage.inputTokens !== null || usage.outputTokens !== null)) {
        this.addUsageEvent(
          runId,
          String(data.provider || "unknown"),
          String(data.model || "default"),
          usage.inputTokens,
          usage.outputTokens,
          data.durationMs,
          now
        );
      }

      this.database.exec("COMMIT;");
      recorded = true;
    } catch (err) {
      this.database.exec("ROLLBACK;");
      throw err;
    }

    return { eventId, recorded };
  }

  listTelemetryEvents(runId) {
    return this.database.prepare(
      "SELECT * FROM telemetry_events WHERE run_id = ? ORDER BY sequence ASC, id ASC"
    ).all(String(runId)).map(row => ({
      eventId: row.event_id,
      runId: row.run_id,
      issueKey: row.issue_key,
      role: row.role,
      action: row.action,
      attempt: row.attempt,
      persona: row.persona,
      taskAgent: row.task_agent,
      agentVersion: row.agent_version,
      agentHash: row.agent_hash,
      provider: row.provider,
      model: row.model,
      modelProfile: row.model_profile,
      effort: row.effort,
      stage: row.stage,
      status: row.status,
      sequence: row.sequence,
      durationMs: row.duration_ms,
      usage: row.usage_available ? {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cachedInputTokens: row.cached_input_tokens,
        reasoningTokens: row.reasoning_tokens,
        totalTokens: row.total_tokens,
        available: true
      } : {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        available: false
      },
      error: row.error_category ? {
        category: row.error_category,
        safeMessage: row.error_message
      } : null,
      metadata: row.raw_payload ? JSON.parse(row.raw_payload) : {},
      timestamp: row.created_at
    }));
  }

  createAgentDefinition(definition) {
    const validated = validateAgentDefinition(definition);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.database.prepare("SELECT id FROM agent_definitions WHERE id = ?").get(validated.id);
      if (existing) {
        throw new Error(`Agent definition already exists: "${validated.id}"`);
      }
      const now = new Date().toISOString();
      const hash = computeAgentDefinitionHash(validated);
      const version = 1;
      this.database.prepare(
        "INSERT INTO agent_definitions(id, status, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(validated.id, validated.status || "enabled", version, now, now);
      this.database.prepare(
        "INSERT INTO agent_versions(agent_id, version, definition_json, definition_hash, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(validated.id, version, JSON.stringify(validated), hash, now);

      this.database.exec("COMMIT;");
      return {
        ...validated,
        version,
        definitionHash: hash,
        createdAt: now,
        updatedAt: now
      };
    } catch (err) {
      this.database.exec("ROLLBACK;");
      throw err;
    }
  }

  updateAgentDefinition(id, partialOrFullDefinition) {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.getAgentDefinition(id);
      if (!existing) {
        throw new Error(`Unknown agent: "${id}"`);
      }
      // Never allow definition update/PATCH to modify live lifecycle status
      const { status: _ignoredStatus, ...payloadWithoutStatus } = partialOrFullDefinition || {};
      const merged = { ...existing.definition, ...payloadWithoutStatus, id };
      const validated = validateAgentDefinition(merged, { isUpdate: true });
      const now = new Date().toISOString();
      const hash = computeAgentDefinitionHash(validated);
      const nextVersion = existing.currentVersion + 1;

      this.database.prepare(
        "INSERT INTO agent_versions(agent_id, version, definition_json, definition_hash, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(id, nextVersion, JSON.stringify(validated), hash, now);

      // Preserve existing live status completely
      this.database.prepare(
        "UPDATE agent_definitions SET current_version = ?, updated_at = ? WHERE id = ?"
      ).run(nextVersion, now, id);

      this.database.exec("COMMIT;");
      return {
        ...validated,
        status: existing.status,
        currentStatus: existing.status,
        version: nextVersion,
        definitionHash: hash,
        createdAt: existing.createdAt,
        updatedAt: now
      };
    } catch (err) {
      this.database.exec("ROLLBACK;");
      throw err;
    }
  }

  upsertAgentDefinition(id, definition) {
    const existing = this.getAgentDefinition(id);
    if (existing) {
      return this.updateAgentDefinition(id, { ...definition, id });
    }
    return this.createAgentDefinition({ ...definition, id });
  }

  getAgentDefinition(id, version = null) {
    const defRow = this.database.prepare("SELECT * FROM agent_definitions WHERE id = ?").get(id);
    if (!defRow) return null;

    const targetVersion = version !== null ? Number(version) : defRow.current_version;
    const versionRow = this.database.prepare(
      "SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?"
    ).get(id, targetVersion);

    if (!versionRow) return null;
    const definition = JSON.parse(versionRow.definition_json);

    return {
      id: defRow.id,
      status: defRow.status,
      currentStatus: defRow.status,
      version: versionRow.version,
      currentVersion: defRow.current_version,
      definition: { ...definition, id: defRow.id },
      definitionHash: versionRow.definition_hash,
      versionCreatedAt: versionRow.created_at,
      createdAt: defRow.created_at,
      updatedAt: defRow.updated_at
    };
  }

  getAgentVersion(id, version) {
    const row = this.database.prepare(
      "SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?"
    ).get(id, Number(version));
    if (!row) return null;
    return {
      agentId: row.agent_id,
      version: row.version,
      definition: JSON.parse(row.definition_json),
      definitionHash: row.definition_hash,
      createdAt: row.created_at
    };
  }

  listAgentVersions(id) {
    return this.database.prepare(
      "SELECT agent_id as agentId, version, definition_json as definitionJson, definition_hash as definitionHash, created_at as createdAt FROM agent_versions WHERE agent_id = ? ORDER BY version ASC"
    ).all(id).map(row => ({
      agentId: row.agentId,
      version: row.version,
      definition: JSON.parse(row.definitionJson),
      definitionHash: row.definitionHash,
      createdAt: row.createdAt
    }));
  }

  listAgentDefinitions({ includeArchived = false, status = null } = {}) {
    const defRows = this.database.prepare("SELECT * FROM agent_definitions ORDER BY id ASC").all();
    const result = [];
    for (const defRow of defRows) {
      if (!includeArchived && defRow.status === "archived" && status !== "archived") {
        continue;
      }
      if (status && defRow.status !== status) {
        continue;
      }
      const versionRow = this.database.prepare(
        "SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?"
      ).get(defRow.id, defRow.current_version);

      const definition = versionRow ? JSON.parse(versionRow.definition_json) : {};
      result.push({
        id: defRow.id,
        status: defRow.status,
        currentStatus: defRow.status,
        version: defRow.current_version,
        currentVersion: defRow.current_version,
        displayName: definition.displayName || defRow.id,
        role: definition.role || "implementation",
        defaultPersona: definition.defaultPersona || "startup-cto",
        skills: definition.skills || [],
        capabilities: definition.capabilities || [],
        executor: definition.executor || null,
        reviewer: definition.reviewer || null,
        risk: definition.risk || "normal",
        maxConcurrency: definition.maxConcurrency || 2,
        allowedPaths: definition.allowedPaths || [],
        definition: { ...definition, id: defRow.id },
        definitionHash: versionRow?.definition_hash || null,
        createdAt: defRow.created_at,
        updatedAt: defRow.updated_at
      });
    }
    return result;
  }

  setAgentStatus(id, status) {
    const normalized = String(status || "").trim().toLowerCase();
    if (!["enabled", "disabled", "archived"].includes(normalized)) {
      throw new Error(`Invalid agent status: "${status}". Allowed: enabled, disabled, archived`);
    }
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.database.prepare("SELECT id FROM agent_definitions WHERE id = ?").get(id);
      if (!existing) {
        throw new Error(`Unknown agent: "${id}"`);
      }
      const now = new Date().toISOString();
      this.database.prepare(
        "UPDATE agent_definitions SET status = ?, updated_at = ? WHERE id = ?"
      ).run(normalized, now, id);

      this.database.exec("COMMIT;");
      return this.getAgentDefinition(id);
    } catch (err) {
      this.database.exec("ROLLBACK;");
      throw err;
    }
  }

  isAgentUsed(id) {
    const target = String(id || "").trim();
    if (!target) return false;
    const row = this.database.prepare(`
      SELECT 1 FROM runs
      WHERE json_extract(payload, '$.taskAgent') = ?
         OR json_extract(payload, '$.agentId') = ?
         OR json_extract(payload, '$.agent') = ?
         OR json_extract(payload, '$.persona') = ?
         OR json_extract(payload, '$.reviewTaskAgent') = ?
         OR json_extract(payload, '$.reviewAgentId') = ?
         OR json_extract(payload, '$.reviewer') = ?
         OR json_extract(payload, '$.configSnapshot.taskAgent') = ?
         OR json_extract(payload, '$.configSnapshot.agentId') = ?
         OR json_extract(payload, '$.configSnapshot.reviewTaskAgent') = ?
         OR json_extract(payload, '$.configSnapshot.reviewAgentId') = ?
         OR json_extract(payload, '$.configSnapshot.reviewer') = ?
         OR json_extract(payload, '$.execution.taskAgent') = ?
         OR json_extract(payload, '$.execution.agent') = ?
         OR json_extract(payload, '$.reviewExecution.taskAgent') = ?
         OR json_extract(payload, '$.reviewExecution.agent') = ?
      LIMIT 1
    `).get(
      target, target, target, target,
      target, target, target,
      target, target, target, target, target,
      target, target, target, target
    );
    return Boolean(row);
  }

  deleteAgentDefinition(id) {
    const target = String(id || "").trim();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.database.prepare("SELECT id FROM agent_definitions WHERE id = ?").get(target);
      if (!existing) {
        throw new Error(`Unknown agent: "${target}"`);
      }
      if (this.isAgentUsed(target)) {
        throw new Error(`Cannot hard-delete agent '${target}' because it has been used by existing runs. Archive it instead.`);
      }
      this.database.prepare("DELETE FROM agent_versions WHERE agent_id = ?").run(target);
      this.database.prepare("DELETE FROM agent_definitions WHERE id = ?").run(target);
      this.database.exec("COMMIT;");
      return true;
    } catch (err) {
      this.database.exec("ROLLBACK;");
      throw err;
    }
  }

  seedBuiltinAgents() {
    for (const seed of BUILTIN_AGENT_SEEDS) {
      const existing = this.database.prepare("SELECT id FROM agent_definitions WHERE id = ?").get(seed.id);
      if (!existing) {
        this.createAgentDefinition(seed);
      }
    }
  }

  close() {
    try {
      this.database.close();
    } catch {}
  }
}
