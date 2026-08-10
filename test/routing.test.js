import test from "node:test";
import assert from "node:assert/strict";
import { routeIssue } from "../lib/routing.js";

test("CV work routes to the CV persona", () => {
  const route = routeIssue({
    summary: "Fix ByteTrack pipeline",
    description: "YOLO camera tracking"
  });
  assert.equal(route.persona, "cv-engineer");
  assert.ok(route.skills.includes("cv-pipeline-checks"));
});

test("authorization, GDPR, migration, and concurrency work is high risk", () => {
  for (const token of ["authorization", "GDPR", "migration", "concurrency"]) {
    const route = routeIssue({
      summary: `Implement ${token} control`,
      description: "Acceptance criteria"
    });
    assert.equal(route.risk, "high", token);
    assert.ok(route.skills.includes("security-review"), token);
  }
});
