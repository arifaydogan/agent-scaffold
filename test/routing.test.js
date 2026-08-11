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

test("autonomous control plane work routes to devops-engineer with bounded-autonomy and multi-agent-reliability", () => {
  for (const keyword of [
    "autonomous",
    "supervisor",
    "resident worker",
    "heartbeat",
    "orchestration",
    "control plane"
  ]) {
    const route = routeIssue({
      summary: `Setup ${keyword} service`,
      description: "Control plane pipeline"
    });
    assert.equal(route.persona, "devops-engineer", keyword);
    assert.ok(route.skills.includes("bounded-autonomy"), keyword);
    assert.ok(route.skills.includes("multi-agent-reliability"), keyword);
    assert.ok(route.skills.includes("monitoring"), keyword);
    assert.ok(route.skills.includes("minimal-change"), keyword);
  }
});

test("all routes include minimal-change exactly once", () => {
  const testIssues = [
    { summary: "Backlog requirement", description: "Jira PRD" },
    { summary: "Next.js UI component", description: "React dashboard" },
    { summary: "YOLO camera", description: "ByteTrack stream" },
    { summary: "Database migration", description: "SQL query" },
    { summary: "Autonomous supervisor", description: "Heartbeat control plane" },
    { summary: "Docker deployment", description: "CI/CD pipeline" },
    { summary: "Generic bug fix", description: "Unmatched issue" },
    { summary: "Credential auth security", description: "Secret token" }
  ];

  for (const issue of testIssues) {
    const route = routeIssue(issue);
    const count = route.skills.filter((s) => s === "minimal-change").length;
    assert.equal(count, 1, `Expected minimal-change exactly once for issue ${issue.summary}, got ${count}`);
  }
});
