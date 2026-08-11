import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../lib/store.js";

function makeStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-store-"));
  return new RunStore(path.join(directory, "runs.sqlite3"));
}

// ── Existing run/lock tests (preserved) ───────────────────────────────────────

test("issue locks are exclusive", () => {
  const store = makeStore();
  const first = store.createRun("PACE-1", {});
  const second = store.createRun("PACE-1", {});
  assert.equal(store.acquireLock("PACE-1", first), true);
  assert.equal(store.acquireLock("PACE-1", second), false);
});

test("existing run schema is unaffected by supervisor migration", () => {
  const store = makeStore();
  const runId = store.createRun("PACE-99", { test: true });
  assert.ok(store.acquireLock("PACE-99", runId));
  store.transition(runId, "eligible", { ok: true });
  const run = store.getRun(runId);
  assert.equal(run.issue_key, "PACE-99");
  assert.equal(run.events.length, 2); // discovered + eligible
});

// ── Supervisor claim tests ─────────────────────────────────────────────────────

test("claimSupervisor inserts a new row and returns claimed=true with leaseId", () => {
  const store = makeStore();
  const result = store.claimSupervisor("PACE", { pid: 1001, mode: "plan", staleAfterSeconds: 90 });
  assert.equal(result.claimed, true);
  assert.ok(result.leaseId, "leaseId is returned");
  assert.equal(typeof result.leaseId, "string");
  const row = store.getSupervisor("PACE");
  assert.ok(row, "supervisor row exists");
  assert.equal(row.pid, 1001);
  assert.equal(row.status, "running");
  assert.equal(row.mode, "plan");
  assert.equal(row.cycleCount, 0);
  assert.equal(row.leaseId, result.leaseId, "leaseId persisted and exposed in shaped row");
});

test("claimSupervisor accepts injected leaseId for tests", () => {
  const store = makeStore();
  const fixedLease = "fixed-lease-for-test";
  const result = store.claimSupervisor("PACE", {
    pid: 1,
    mode: "plan",
    staleAfterSeconds: 90,
    leaseId: fixedLease
  });
  assert.equal(result.claimed, true);
  assert.equal(result.leaseId, fixedLease);
  const row = store.getSupervisor("PACE");
  assert.equal(row.leaseId, fixedLease);
});

test("claimSupervisor rejects a live owner with fresh heartbeat", () => {
  const store = makeStore();
  const first = store.claimSupervisor("PACE", { pid: 1001, mode: "plan", staleAfterSeconds: 90 });
  assert.equal(first.claimed, true);
  // Attempt to claim with a different pid — heartbeat is fresh.
  const result = store.claimSupervisor("PACE", { pid: 1002, mode: "plan", staleAfterSeconds: 90 });
  assert.equal(result.claimed, false);
  assert.ok(result.conflict, "conflict info is returned");
  assert.equal(result.conflict.pid, 1001);
  assert.equal(result.leaseId, undefined, "no leaseId on rejection");
});

test("claimSupervisor allows reclaim of terminal (stopped) owner", () => {
  const store = makeStore();
  const first = store.claimSupervisor("PACE", { pid: 1001, mode: "plan", staleAfterSeconds: 90 });
  store.finishSupervisor("PACE", { leaseId: first.leaseId, status: "stopped" });
  const result = store.claimSupervisor("PACE", { pid: 1002, mode: "execute", staleAfterSeconds: 90 });
  assert.equal(result.claimed, true);
  assert.ok(result.leaseId);
  assert.notEqual(result.leaseId, first.leaseId, "new lease issued on reclaim");
  const row = store.getSupervisor("PACE");
  assert.equal(row.pid, 1002);
  assert.equal(row.status, "running");
  assert.equal(row.leaseId, result.leaseId);
});

test("claimSupervisor allows reclaim of stale owner", () => {
  const store = makeStore();
  store.claimSupervisor("PACE", { pid: 1001, mode: "plan", staleAfterSeconds: 10 });
  // Force heartbeat to far in the past.
  store.database.exec(
    `UPDATE supervisors SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = 'PACE'`
  );
  const result = store.claimSupervisor("PACE", { pid: 1003, mode: "plan", staleAfterSeconds: 10 });
  assert.equal(result.claimed, true);
  assert.ok(result.leaseId, "new leaseId on stale reclaim");
});

// ── Heartbeat fencing tests ────────────────────────────────────────────────────

test("heartbeatSupervisor returns true and updates row when leaseId matches", () => {
  const store = makeStore();
  const { leaseId } = store.claimSupervisor("PACE", { pid: 1, mode: "plan", staleAfterSeconds: 90 });
  const ok = store.heartbeatSupervisor("PACE", { leaseId, cycleCount: 3 });
  assert.equal(ok, true);
  const row = store.getSupervisor("PACE");
  assert.equal(row.cycleCount, 3);
});

test("heartbeatSupervisor returns false when leaseId does not match (stale lease)", () => {
  const store = makeStore();
  store.claimSupervisor("PACE", { pid: 1, mode: "plan", staleAfterSeconds: 90 });
  const ok = store.heartbeatSupervisor("PACE", { leaseId: "wrong-lease", cycleCount: 1 });
  assert.equal(ok, false, "fenced update must fail with wrong leaseId");
});

test("heartbeatSupervisor persists lastResult JSON when leaseId matches", () => {
  const store = makeStore();
  const { leaseId } = store.claimSupervisor("PACE", { pid: 1, mode: "plan", staleAfterSeconds: 90 });
  const result = { mode: "plan", waves: 2, failed: 0 };
  store.heartbeatSupervisor("PACE", { leaseId, cycleCount: 1, lastResult: result });
  const row = store.getSupervisor("PACE");
  assert.deepEqual(row.lastResult, result);
});

test("heartbeatSupervisor can clear lastError via lastError: null", () => {
  const store = makeStore();
  const { leaseId } = store.claimSupervisor("PACE", { pid: 1, mode: "plan", staleAfterSeconds: 90 });
  // Write an error first.
  store.recordSupervisorFailure("PACE", { leaseId, error: "boom", consecutiveFailures: 1 });
  assert.equal(store.getSupervisor("PACE").lastError, "boom");
  // Clear it via heartbeat.
  store.heartbeatSupervisor("PACE", { leaseId, lastError: null });
  assert.equal(store.getSupervisor("PACE").lastError, null);
});

test("heartbeat does not write supervisor_events", () => {
  const store = makeStore();
  const { leaseId } = store.claimSupervisor("PACE", { pid: 1, mode: "plan", staleAfterSeconds: 90 });
  const before = store.listSupervisorEvents(100).length;
  store.heartbeatSupervisor("PACE", { leaseId, cycleCount: 1 });
  store.heartbeatSupervisor("PACE", { leaseId, cycleCount: 2 });
  store.heartbeatSupervisor("PACE", { leaseId, cycleCount: 3 });
  const after = store.listSupervisorEvents(100).length;
  assert.equal(after, before, "heartbeats must not append supervisor_events");
});

// ── recordSupervisorFailure fencing ───────────────────────────────────────────

test("recordSupervisorFailure returns true and emits event when leaseId matches", () => {
  const store = makeStore();
  const { leaseId } = store.claimSupervisor("PACE", { pid: 1, mode: "plan", staleAfterSeconds: 90 });
  const ok = store.recordSupervisorFailure("PACE", { leaseId, error: "boom", consecutiveFailures: 1 });
  assert.equal(ok, true);
  const row = store.getSupervisor("PACE");
  assert.equal(row.lastError, "boom");
  const events = store.listSupervisorEvents(10);
  assert.ok(events.some((e) => e.event === "failure"), "failure event emitted");
});

test("recordSupervisorFailure returns false and emits no event when leaseId is wrong", () => {
  const store = makeStore();
  store.claimSupervisor("PACE", { pid: 1, mode: "plan", staleAfterSeconds: 90 });
  const eventsBefore = store.listSupervisorEvents(100).length;
  const ok = store.recordSupervisorFailure("PACE", {
    leaseId: "wrong-lease",
    error: "boom",
    consecutiveFailures: 1
  });
  assert.equal(ok, false);
  assert.equal(store.listSupervisorEvents(100).length, eventsBefore, "no new event on failed fence");
});

// ── finishSupervisor fencing ─────────────────────────────────────────────────

test("finishSupervisor sets status=stopped and writes finish event when leaseId matches", () => {
  const store = makeStore();
  const { leaseId } = store.claimSupervisor("PACE", { pid: 1, mode: "plan", staleAfterSeconds: 90 });
  const ok = store.finishSupervisor("PACE", { leaseId, status: "stopped", lastResult: { waves: 1 } });
  assert.equal(ok, true);
  const row = store.getSupervisor("PACE");
  assert.equal(row.status, "stopped");
  assert.ok(row.stoppedAt, "stoppedAt is set");
  assert.deepEqual(row.lastResult, { waves: 1 });
  const events = store.listSupervisorEvents(10);
  assert.ok(events.some((e) => e.event === "finish"));
});

test("finishSupervisor with status=failed writes failure event", () => {
  const store = makeStore();
  const { leaseId } = store.claimSupervisor("PACE", { pid: 1, mode: "plan", staleAfterSeconds: 90 });
  const ok = store.finishSupervisor("PACE", { leaseId, status: "failed", lastError: "boom" });
  assert.equal(ok, true);
  const row = store.getSupervisor("PACE");
  assert.equal(row.status, "failed");
  assert.equal(row.lastError, "boom");
  const events = store.listSupervisorEvents(10);
  assert.ok(events.some((e) => e.event === "failure"));
});

test("finishSupervisor returns false and emits no event when leaseId is wrong", () => {
  const store = makeStore();
  store.claimSupervisor("PACE", { pid: 1, mode: "plan", staleAfterSeconds: 90 });
  const eventsBefore = store.listSupervisorEvents(100).length;
  const ok = store.finishSupervisor("PACE", {
    leaseId: "wrong-lease",
    status: "stopped"
  });
  assert.equal(ok, false, "fenced update must fail with wrong leaseId");
  // Status must remain running.
  assert.equal(store.getSupervisor("PACE").status, "running");
  assert.equal(store.listSupervisorEvents(100).length, eventsBefore, "no new event on failed fence");
});

// ── Stale reclaim fencing regression ─────────────────────────────────────────

test("old lease cannot heartbeat, record failure, or finish after stale reclaim", () => {
  const store = makeStore();

  // Old owner claims and gets its lease.
  const old = store.claimSupervisor("PACE", { pid: 10, mode: "plan", staleAfterSeconds: 1 });
  assert.equal(old.claimed, true);
  const oldLeaseId = old.leaseId;

  // Force heartbeat to ancient past so it appears stale.
  store.database.exec(
    `UPDATE supervisors SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = 'PACE'`
  );

  // New owner reclaims the slot.
  const newOwner = store.claimSupervisor("PACE", { pid: 20, mode: "plan", staleAfterSeconds: 1 });
  assert.equal(newOwner.claimed, true);
  const newLeaseId = newOwner.leaseId;
  assert.notEqual(newLeaseId, oldLeaseId, "new lease must differ from old lease");

  // Old lease heartbeat must be rejected.
  const hbOk = store.heartbeatSupervisor("PACE", { leaseId: oldLeaseId, cycleCount: 99 });
  assert.equal(hbOk, false, "old lease heartbeat must be rejected after reclaim");

  // Row must not have been mutated by the old owner.
  assert.equal(store.getSupervisor("PACE").cycleCount, 0);

  // Old lease recordSupervisorFailure must be rejected.
  const failOk = store.recordSupervisorFailure("PACE", {
    leaseId: oldLeaseId,
    error: "old owner error",
    consecutiveFailures: 1
  });
  assert.equal(failOk, false, "old lease failure record must be rejected");
  assert.equal(store.getSupervisor("PACE").lastError, null);

  // Old lease finishSupervisor must be rejected.
  const finishOk = store.finishSupervisor("PACE", {
    leaseId: oldLeaseId,
    status: "stopped"
  });
  assert.equal(finishOk, false, "old lease finish must be rejected");
  assert.equal(store.getSupervisor("PACE").status, "running");
  assert.equal(store.getSupervisor("PACE").leaseId, newLeaseId, "new lease is still held");
});

// ── requestSupervisorStop (operator-owned, no lease) ─────────────────────────

test("requestSupervisorStop sets stop_requested_at and writes an event (no leaseId required)", () => {
  const store = makeStore();
  store.claimSupervisor("PACE", { pid: 1, mode: "plan", staleAfterSeconds: 90 });
  store.requestSupervisorStop("PACE");
  const row = store.getSupervisor("PACE");
  assert.ok(row.stopRequestedAt, "stopRequestedAt is set");
  const events = store.listSupervisorEvents(10);
  assert.ok(events.some((e) => e.event === "stop-request"), "stop-request event exists");
});

// ── List methods ──────────────────────────────────────────────────────────────

test("listSupervisors returns shaped camelCase rows including leaseId", () => {
  const store = makeStore();
  store.claimSupervisor("PACE", { pid: 42, mode: "plan", staleAfterSeconds: 90 });
  const list = store.listSupervisors();
  assert.equal(list.length, 1);
  assert.ok("leaseId" in list[0], "leaseId in shaped row");
  assert.ok("pid" in list[0]);
  assert.ok("startedAt" in list[0]);
  assert.ok("heartbeatAt" in list[0]);
  assert.ok("cycleCount" in list[0]);
  assert.ok("lastResult" in list[0]);
});

test("listSupervisorEvents returns shaped events with camelCase", () => {
  const store = makeStore();
  store.claimSupervisor("PACE", { pid: 1, mode: "plan", staleAfterSeconds: 90 });
  const events = store.listSupervisorEvents(5);
  assert.ok(events.length >= 1);
  const evt = events[0];
  assert.ok("supervisorId" in evt);
  assert.ok("event" in evt);
  assert.ok("payload" in evt);
  assert.ok("createdAt" in evt);
});
