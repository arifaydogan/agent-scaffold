import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkItemCompatibility } from "../lib/work-item-compatibility.js";

test("compatibility groups required labels, scope, agent, and base-ref blockers without auto-widening", () => {
  const result = buildWorkItemCompatibility({
    issue: "PACE-257",
    eligible: false,
    planFingerprint: "plan-257",
    allowedPaths: [],
    requestedAllowedPaths: [".agents/**", "bin/**", "lib/**"],
    eligibilityReasons: [
      "Missing required labels: agent-ready",
      "Agent 'pm-analyst' is not registered",
      "No authorized write scope for taskAgent 'backend-engineer'",
      "Git base ref does not exist: epic/pace-244"
    ]
  });

  assert.equal(result.status, "needs_attention");
  assert.deepEqual(result.items.map(entry => entry.category), [
    "work_source",
    "agent",
    "scope",
    "source_control"
  ]);
  assert.equal(result.items.every(entry => entry.automatic === false), true);
  assert.ok(result.items[2].proposed.includes(".agents/**"));
  assert.match(result.items[2].resolution, /never widened automatically/i);
  assert.ok(result.fingerprint);
});

test("eligible plans expose a stable compatible state with no actions", () => {
  const result = buildWorkItemCompatibility({
    issue: "PACE-364",
    eligible: true,
    planFingerprint: "plan-364",
    eligibilityReasons: []
  });
  assert.equal(result.status, "compatible");
  assert.deepEqual(result.items, []);
  assert.ok(result.fingerprint);
});
