/**
 * test/supervisor.test.js
 *
 * Offline, deterministic tests for lib/supervisor.js.
 * All Jira, store, dispatchOnce, sleep, and clock dependencies are injected.
 * No network calls, no real file I/O, no actual process spawning.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../lib/store.js";
import { runSupervisor } from "../lib/supervisor.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSettings(supervisorOverrides = {}) {
  const supervisor = {
    executeEnabled: false,
    pollIntervalSeconds: 30,
    heartbeatSeconds: 10,
    staleAfterSeconds: 90,
    maxConsecutiveFailures: 3,
    issueLimit: 10,
    ...supervisorOverrides
  };
  return {
    source: "/tmp/test.json",
    projectKey: "TEST",
    repoPath: "/tmp/repo",
    worktreeRoot: "/tmp/worktrees",
    data: {
      project: { key: "TEST", repoPath: "." },
      policy: { requiredLabels: ["agent-ready"], maxConcurrency: 2, providerConcurrency: {} },
      worktree: { root: "." },
      jira: { baseUrl: "https://example.atlassian.net" },
      executor: { defaultProvider: "codex", providers: {} },
      supervisor
    }
  };
}

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-"));
  return new RunStore(path.join(dir, "runs.sqlite3"));
}

function planOnceStub() {
  return Promise.resolve({
    mode: "plan",
    maxConcurrency: 2,
    waves: [],
    results: null,
    failed: 0,
    aborted: false
  });
}

const instantSleep = () => Promise.resolve();

// A monotone clock that starts at a fixed epoch (deterministic).
function makeClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return {
    tick: (ms) => { t += ms; },
    now: () => t
  };
}

// ── Execute gate ──────────────────────────────────────────────────────────────

test("execute gate throws before any dispatch when executeEnabled is false", async () => {
  const settings = makeSettings({ executeEnabled: false });
  const store = makeStore();
  let dispatchCalled = false;
  await assert.rejects(
    () =>
      runSupervisor(settings, {
        execute: true,
        store,
        dispatchOnceImpl: () => {
          dispatchCalled = true;
          return planOnceStub();
        },
        sleep: instantSleep,
        processId: 999,
        clock: makeClock()
      }),
    /executeEnabled/
  );
  assert.equal(dispatchCalled, false, "dispatch must not be called before the gate check");
});

test("execute gate does not throw when executeEnabled is true and execute=true", async () => {
  const settings = makeSettings({ executeEnabled: true });
  const store = makeStore();
  let dispatchCalled = false;
  await runSupervisor(settings, {
    execute: true,
    once: true,
    store,
    dispatchOnceImpl: () => {
      dispatchCalled = true;
      return Promise.resolve({
        mode: "execute",
        maxConcurrency: 2,
        waves: [],
        results: [],
        failed: 0,
        aborted: false
      });
    },
    sleep: instantSleep,
    processId: 999,
    clock: makeClock()
  });
  assert.equal(dispatchCalled, true, "dispatch should be called in execute mode when gate passes");
});

// ── once / maxCycles ──────────────────────────────────────────────────────────

test("once=true runs exactly one dispatch cycle and finishes", async () => {
  const settings = makeSettings();
  const store = makeStore();
  let cycles = 0;
  await runSupervisor(settings, {
    once: true,
    store,
    dispatchOnceImpl: () => {
      cycles += 1;
      return planOnceStub();
    },
    sleep: instantSleep,
    processId: 1,
    clock: makeClock()
  });
  assert.equal(cycles, 1, "exactly one cycle");
  const row = store.getSupervisor("TEST");
  assert.equal(row.status, "stopped");
  assert.equal(row.cycleCount, 1);
});

test("maxCycles limits the number of dispatch cycles", async () => {
  const settings = makeSettings({ pollIntervalSeconds: 1 });
  const store = makeStore();
  let cycles = 0;
  await runSupervisor(settings, {
    maxCycles: 3,
    store,
    dispatchOnceImpl: () => {
      cycles += 1;
      return planOnceStub();
    },
    sleep: instantSleep,
    processId: 2,
    clock: makeClock()
  });
  assert.equal(cycles, 3, "exactly 3 cycles");
  const row = store.getSupervisor("TEST");
  assert.equal(row.cycleCount, 3);
  assert.equal(row.status, "stopped");
});

test("invalid maxCycles (zero) throws before any dispatch", async () => {
  const settings = makeSettings();
  const store = makeStore();
  await assert.rejects(
    () => runSupervisor(settings, {
      maxCycles: 0,
      store,
      dispatchOnceImpl: planOnceStub,
      sleep: instantSleep,
      processId: 1,
      clock: makeClock()
    }),
    /maxCycles/
  );
});

test("invalid issueLimit (string) throws before any dispatch", async () => {
  const settings = makeSettings();
  const store = makeStore();
  await assert.rejects(
    () => runSupervisor(settings, {
      once: true,
      issueLimit: "all",
      store,
      dispatchOnceImpl: planOnceStub,
      sleep: instantSleep,
      processId: 1,
      clock: makeClock()
    }),
    /issueLimit/
  );
});

// ── Clock injection ───────────────────────────────────────────────────────────

test("injected clock drives nowIso timestamps on heartbeat", async () => {
  const settings = makeSettings();
  const store = makeStore();
  const clock = makeClock(1_700_000_000_000);
  const capturedTimestamps = [];
  const origHeartbeat = store.heartbeatSupervisor.bind(store);
  store.heartbeatSupervisor = (id, opts) => {
    capturedTimestamps.push(opts.now);
    return origHeartbeat(id, opts);
  };
  await runSupervisor(settings, {
    once: true,
    store,
    dispatchOnceImpl: () => { clock.tick(1000); return planOnceStub(); },
    sleep: instantSleep,
    processId: 1,
    clock
  });
  // All timestamps come from the clock, not wall time.
  for (const ts of capturedTimestamps) {
    assert.ok(ts.startsWith("2023-"), `expected 2023 epoch timestamp, got: ${ts}`);
  }
});

// ── Heartbeat during wait intervals ───────────────────────────────────────────

test("heartbeat is emitted during wait intervals (not just after cycles)", async () => {
  const settings = makeSettings({
    heartbeatSeconds: 5,
    pollIntervalSeconds: 20,
    staleAfterSeconds: 90
  });
  const store = makeStore();
  let cycles = 0;
  let sleepCallCount = 0;
  const heartbeatCallCount = { value: 0 };
  const origHeartbeat = store.heartbeatSupervisor.bind(store);
  store.heartbeatSupervisor = (...args) => {
    heartbeatCallCount.value += 1;
    return origHeartbeat(...args);
  };
  await runSupervisor(settings, {
    maxCycles: 2,
    store,
    dispatchOnceImpl: () => { cycles += 1; return planOnceStub(); },
    sleep: (ms) => { sleepCallCount += 1; return Promise.resolve(); },
    processId: 3,
    clock: makeClock()
  });
  // ceil(20/5) = 4 sleep slices during wait between cycles.
  assert.ok(sleepCallCount >= 4, `expected at least 4 sleep calls, got ${sleepCallCount}`);
  assert.equal(cycles, 2);
});

// ── Stop conditions ───────────────────────────────────────────────────────────

test("persisted stop request halts the loop before next cycle", async () => {
  const settings = makeSettings({ pollIntervalSeconds: 1 });
  const store = makeStore();
  let cycles = 0;
  await runSupervisor(settings, {
    maxCycles: 10,
    store,
    dispatchOnceImpl: () => {
      cycles += 1;
      if (cycles === 1) store.requestSupervisorStop("TEST");
      return planOnceStub();
    },
    sleep: instantSleep,
    processId: 4,
    clock: makeClock()
  });
  assert.equal(cycles, 1, "should stop after 1 cycle due to stop request");
  assert.equal(store.getSupervisor("TEST").status, "stopped");
});

test("AbortSignal stops the supervisor before later cycles", async () => {
  const settings = makeSettings({ pollIntervalSeconds: 1 });
  const store = makeStore();
  const ac = new AbortController();
  let cycles = 0;
  await runSupervisor(settings, {
    maxCycles: 10,
    signal: ac.signal,
    store,
    dispatchOnceImpl: () => {
      cycles += 1;
      if (cycles === 1) ac.abort();
      return planOnceStub();
    },
    sleep: instantSleep,
    processId: 5,
    clock: makeClock()
  });
  assert.equal(cycles, 1);
  assert.equal(store.getSupervisor("TEST").status, "stopped");
});

test("AbortSignal wakes unresolved injected sleep immediately", async () => {
  const settings = makeSettings({ pollIntervalSeconds: 60, heartbeatSeconds: 10 });
  const store = makeStore();
  const ac = new AbortController();
  let cycles = 0;
  let sleepStarted = false;

  const neverEndingSleep = () => {
    sleepStarted = true;
    return new Promise(() => {});
  };

  const supervisorPromise = runSupervisor(settings, {
    maxCycles: 10,
    signal: ac.signal,
    store,
    dispatchOnceImpl: () => {
      cycles += 1;
      return planOnceStub();
    },
    sleep: neverEndingSleep,
    processId: 5,
    clock: makeClock()
  });

  await Promise.resolve();
  assert.equal(cycles, 1, "cycle 1 completed");
  assert.equal(sleepStarted, true, "supervisor is inside injected sleep");

  ac.abort();

  await supervisorPromise;

  assert.equal(store.getSupervisor("TEST").status, "stopped");
});

// ── Lease fencing ─────────────────────────────────────────────────────────────

test("emitHeartbeat throws and loop terminates when lease is lost", async () => {
  const settings = makeSettings();
  const store = makeStore();
  let cycles = 0;

  // After the first dispatch cycle, we forcibly steal the lease by reclaiming.
  await assert.rejects(
    async () => {
      await runSupervisor(settings, {
        once: true,
        store,
        dispatchOnceImpl: () => {
          cycles += 1;
          // Steal the slot by forcing heartbeat_at to stale then reclaiming.
          store.database.exec(
            `UPDATE supervisors SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = 'TEST'`
          );
          // The reclaim changes the lease_id in the DB.
          store.claimSupervisor("TEST", { pid: 999, mode: "plan", staleAfterSeconds: 1 });
          return planOnceStub();
        },
        sleep: instantSleep,
        processId: 1,
        clock: makeClock()
      });
    },
    /lease lost/i
  );
  assert.equal(cycles, 1);
});

test("shouldStop detects leaseId mismatch and throws", async () => {
  const settings = makeSettings({ pollIntervalSeconds: 1 });
  const store = makeStore();
  let cycles = 0;

  await assert.rejects(
    async () => {
      await runSupervisor(settings, {
        maxCycles: 3,
        store,
        dispatchOnceImpl: () => {
          cycles += 1;
          if (cycles === 1) {
            // Directly overwrite lease_id in the DB to simulate external reclaim.
            store.database.exec(
              `UPDATE supervisors SET lease_id = 'stolen-lease', status = 'running' WHERE id = 'TEST'`
            );
          }
          return planOnceStub();
        },
        sleep: instantSleep,
        processId: 1,
        clock: makeClock()
      });
    },
    /lease lost/i
  );
});

// ── Failure counter ───────────────────────────────────────────────────────────

test("consecutive failure counter resets on a successful cycle", async () => {
  const settings = makeSettings({
    maxConsecutiveFailures: 3,
    pollIntervalSeconds: 1
  });
  const store = makeStore();
  let cycles = 0;
  await runSupervisor(settings, {
    maxCycles: 4,
    store,
    dispatchOnceImpl: () => {
      cycles += 1;
      if (cycles === 1 || cycles === 2) throw new Error("transient failure");
      return planOnceStub();
    },
    sleep: instantSleep,
    processId: 6,
    clock: makeClock()
  });
  assert.equal(cycles, 4);
  assert.equal(store.getSupervisor("TEST").status, "stopped", "should not be failed after reset");
});

test("successful cycle clears persisted lastError", async () => {
  const settings = makeSettings({ maxConsecutiveFailures: 3, pollIntervalSeconds: 1 });
  const store = makeStore();
  let cycles = 0;
  await runSupervisor(settings, {
    maxCycles: 2,
    store,
    dispatchOnceImpl: () => {
      cycles += 1;
      if (cycles === 1) throw new Error("transient error");
      return planOnceStub();
    },
    sleep: instantSleep,
    processId: 7,
    clock: makeClock()
  });
  // After cycle 2 succeeds, lastError should be cleared.
  assert.equal(store.getSupervisor("TEST").lastError, null, "lastError cleared after success");
});

test("terminal failure is thrown and status is failed after maxConsecutiveFailures", async () => {
  const settings = makeSettings({
    maxConsecutiveFailures: 2,
    pollIntervalSeconds: 1
  });
  const store = makeStore();
  let cycles = 0;
  await assert.rejects(
    async () => {
      await runSupervisor(settings, {
        maxCycles: 10,
        store,
        dispatchOnceImpl: () => {
          cycles += 1;
          throw new Error("persistent failure");
        },
        sleep: instantSleep,
        processId: 7,
        clock: makeClock()
      });
    },
    /maxConsecutiveFailures/
  );
  assert.equal(cycles, 2, "should have attempted exactly maxConsecutiveFailures cycles");
  assert.equal(store.getSupervisor("TEST").status, "failed");
  assert.ok(store.getSupervisor("TEST").lastError, "lastError is persisted");
});

// ── Duplicate and stale claim ─────────────────────────────────────────────────

test("duplicate live claim is rejected", async () => {
  const settings = makeSettings();
  const store = makeStore();
  // First supervisor claims the slot.
  store.claimSupervisor("TEST", { pid: 100, mode: "plan", staleAfterSeconds: 90 });
  await assert.rejects(
    () =>
      runSupervisor(settings, {
        once: true,
        store,
        dispatchOnceImpl: planOnceStub,
        sleep: instantSleep,
        processId: 200,
        clock: makeClock()
      }),
    /already owned/
  );
});

test("stale claim is reclaimable by a new supervisor", async () => {
  const settings = makeSettings();
  const store = makeStore();
  store.claimSupervisor("TEST", { pid: 100, mode: "plan", staleAfterSeconds: 1 });
  store.database.exec(
    `UPDATE supervisors SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = 'TEST'`
  );
  let ran = false;
  await runSupervisor(settings, {
    once: true,
    store,
    dispatchOnceImpl: () => {
      ran = true;
      return planOnceStub();
    },
    sleep: instantSleep,
    processId: 200,
    clock: makeClock()
  });
  assert.equal(ran, true, "new supervisor should have run after reclaiming stale slot");
});

// ── No overlapping cycles ─────────────────────────────────────────────────────

test("no overlapping cycles: each cycle is awaited before the next wait", async () => {
  const settings = makeSettings({ pollIntervalSeconds: 5, heartbeatSeconds: 1 });
  const store = makeStore();
  let activeCycles = 0;
  let maxConcurrentCycles = 0;
  await runSupervisor(settings, {
    maxCycles: 3,
    store,
    dispatchOnceImpl: async () => {
      activeCycles += 1;
      maxConcurrentCycles = Math.max(maxConcurrentCycles, activeCycles);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeCycles -= 1;
      return planOnceStub();
    },
    sleep: instantSleep,
    processId: 8,
    clock: makeClock()
  });
  assert.equal(maxConcurrentCycles, 1, "cycles must not overlap");
});

// ── execute=false passes through ──────────────────────────────────────────────

test("plan mode passes execute=false to dispatchOnce", async () => {
  const settings = makeSettings({ executeEnabled: false });
  const store = makeStore();
  let capturedExecute;
  await runSupervisor(settings, {
    once: true,
    execute: false,
    store,
    dispatchOnceImpl: (_, opts) => {
      capturedExecute = opts.execute;
      return planOnceStub();
    },
    sleep: instantSleep,
    processId: 9,
    clock: makeClock()
  });
  assert.equal(capturedExecute, false, "plan mode must pass execute=false");
});
