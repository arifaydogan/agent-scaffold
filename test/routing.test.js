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
