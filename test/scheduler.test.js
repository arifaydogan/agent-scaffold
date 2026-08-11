import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDispatchWaves,
  executeDispatchWaves,
  scopesOverlap,
  selectDispatchBatch
} from "../lib/scheduler.js";

function plan(issue, scope, provider = "antigravity", parallelSafe = true) {
  return {
    issue,
    eligible: true,
    parallelSafe,
    allowedPaths: [scope],
    execution: { provider }
  };
}

// ── Scope overlap ──────────────────────────────────────────────────────────────

test("scope overlap detects nested ownership", () => {
  assert.equal(scopesOverlap(["backend/**"], ["backend/api/**"]), true);
  assert.equal(scopesOverlap(["backend/**"], ["frontend/**"]), false);
});

// ── Wave planning ─────────────────────────────────────────────────────────────

test("dispatcher serializes colliding scopes and runs disjoint scopes together", () => {
  const waves = buildDispatchWaves(
    [
      plan("PACE-1", "frontend/**"),
      plan("PACE-2", "frontend/**"),
      plan("PACE-3", "backend/**")
    ],
    { maxConcurrency: 2, providerConcurrency: { antigravity: 2 } }
  );
  assert.deepEqual(
    waves.map((wave) => wave.map((item) => item.issue)),
    [["PACE-1", "PACE-3"], ["PACE-2"]]
  );
});

test("provider concurrency is enforced independently", () => {
  const batch = selectDispatchBatch(
    [
      plan("PACE-1", "frontend/**", "antigravity"),
      plan("PACE-2", "backend/**", "antigravity"),
      plan("PACE-3", "cv-engine/**", "codex")
    ],
    {
      maxConcurrency: 3,
      providerConcurrency: { antigravity: 1, codex: 1 }
    }
  );
  assert.deepEqual(
    batch.map((item) => item.issue),
    ["PACE-1", "PACE-3"]
  );
});

test("cross-service work gets an exclusive wave", () => {
  const waves = buildDispatchWaves(
    [
      plan("PACE-X", "backend/**", "codex", false),
      plan("PACE-UI", "frontend/**")
    ],
    { maxConcurrency: 2 }
  );
  assert.deepEqual(
    waves.map((wave) => wave.map((item) => item.issue)),
    [["PACE-UI"], ["PACE-X"]]
  );
});

// ── Execution: parallel within wave, sequential between ───────────────────────

test("execution is parallel within a wave and sequential between waves", async () => {
  let active = 0;
  let maximum = 0;
  const finished = [];
  const waves = [
    [plan("PACE-1", "frontend/**"), plan("PACE-2", "backend/**")],
    [plan("PACE-3", "cv-engine/**")]
  ];
  const results = await executeDispatchWaves(waves, async (item) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    finished.push(item.issue);
    active -= 1;
    return { exitCode: 0 };
  });
  assert.equal(maximum, 2);
  assert.equal(finished.at(-1), "PACE-3");
  assert.equal(results.length, 2);
});

// ── AbortSignal: before every wave including wave 0 ──────────────────────────

test("executeDispatchWaves aborts before later waves when signal is aborted mid-run", async () => {
  const launched = [];
  const ac = new AbortController();
  const waves = [
    [plan("PACE-1", "frontend/**")],
    [plan("PACE-2", "backend/**")],
    [plan("PACE-3", "cv-engine/**")]
  ];
  const results = await executeDispatchWaves(
    waves,
    async (item) => {
      launched.push(item.issue);
      // Abort after the first item in wave 0 runs.
      if (launched.length === 1) ac.abort();
      return { exitCode: 0 };
    },
    { signal: ac.signal }
  );
  // Wave 0 completed (abort happened inside it), waves 1 and 2 skipped.
  assert.deepEqual(launched, ["PACE-1"]);
  assert.equal(results.length, 1);
});

test("executeDispatchWaves launches nothing when signal is already aborted before call", async () => {
  const launched = [];
  const ac = new AbortController();
  ac.abort(); // already aborted
  const waves = [
    [plan("PACE-1", "frontend/**")],
    [plan("PACE-2", "backend/**")]
  ];
  const results = await executeDispatchWaves(
    waves,
    async (item) => {
      launched.push(item.issue);
      return { exitCode: 0 };
    },
    { signal: ac.signal }
  );
  assert.deepEqual(launched, [], "no wave should be launched when pre-aborted");
  assert.equal(results.length, 0);
});

// ── Concurrency validation: throws on invalid values ─────────────────────────

test("selectDispatchBatch throws on maxConcurrency=0", () => {
  assert.throws(
    () =>
      selectDispatchBatch([plan("PACE-1", "frontend/**")], { maxConcurrency: 0 }),
    /maxConcurrency.*positive integer/i
  );
});

test("selectDispatchBatch throws on maxConcurrency negative", () => {
  assert.throws(
    () =>
      selectDispatchBatch([plan("PACE-1", "frontend/**")], { maxConcurrency: -1 }),
    /maxConcurrency.*positive integer/i
  );
});

test("selectDispatchBatch throws on maxConcurrency NaN", () => {
  assert.throws(
    () =>
      selectDispatchBatch([plan("PACE-1", "frontend/**")], { maxConcurrency: NaN }),
    /maxConcurrency.*positive integer/i
  );
});

test("selectDispatchBatch throws on maxConcurrency float", () => {
  assert.throws(
    () =>
      selectDispatchBatch([plan("PACE-1", "frontend/**")], { maxConcurrency: 1.5 }),
    /maxConcurrency.*positive integer/i
  );
});

test("selectDispatchBatch throws on maxConcurrency numeric string", () => {
  assert.throws(
    () =>
      selectDispatchBatch([plan("PACE-1", "frontend/**")], { maxConcurrency: "2" }),
    /maxConcurrency.*positive integer/i
  );
});

test("selectDispatchBatch throws on configured providerConcurrency=0", () => {
  assert.throws(
    () =>
      selectDispatchBatch(
        [plan("PACE-1", "frontend/**", "antigravity")],
        { maxConcurrency: 2, providerConcurrency: { antigravity: 0 } }
      ),
    /providerConcurrency\.antigravity.*positive integer/i
  );
});

test("selectDispatchBatch throws on configured providerConcurrency negative", () => {
  assert.throws(
    () =>
      selectDispatchBatch(
        [plan("PACE-1", "frontend/**", "codex")],
        { maxConcurrency: 2, providerConcurrency: { codex: -1 } }
      ),
    /providerConcurrency\.codex.*positive integer/i
  );
});

test("selectDispatchBatch does NOT throw for unconfigured providers (no providerConcurrency entry)", () => {
  // Provider not in providerConcurrency -> defaults to effectiveMax, no throw.
  assert.doesNotThrow(() => {
    const batch = selectDispatchBatch(
      [plan("PACE-1", "frontend/**", "antigravity")],
      { maxConcurrency: 2, providerConcurrency: {} }
    );
    assert.equal(batch.length, 1);
  });
});
