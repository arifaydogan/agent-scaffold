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

test("scope overlap detects nested ownership", () => {
  assert.equal(scopesOverlap(["backend/**"], ["backend/api/**"]), true);
  assert.equal(scopesOverlap(["backend/**"], ["frontend/**"]), false);
});

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
