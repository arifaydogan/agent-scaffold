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

  #event(runId, state, payload, createdAt) {
    this.database
      .prepare(
        "INSERT INTO events(run_id, state, payload, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(runId, state, JSON.stringify(payload), createdAt);
  }
}
