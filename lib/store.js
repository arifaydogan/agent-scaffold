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
                e.payload AS latest_payload, e.created_at AS latest_event_at
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

  #event(runId, state, payload, createdAt) {
    this.database
      .prepare(
        "INSERT INTO events(run_id, state, payload, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(runId, state, JSON.stringify(payload), createdAt);
  }
}
