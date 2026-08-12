import test from "node:test";
import assert from "node:assert/strict";
import { evaluateIssue } from "../lib/policy.js";

const policy = {
  allowedProjects: ["PACE"],
  requiredLabels: ["agent-ready"],
  humanOnlyStatuses: ["Tamam", "Done"]
};

test("agent-ready issue with acceptance criteria is eligible", () => {
  const issue = {
    key: "PACE-200",
    summary: "Add endpoint",
    description: "## Acceptance Criteria\n- [ ] Returns HTTP 200",
    issueType: "Hikaye",
    status: "Yapılacaklar",
    labels: ["agent-ready"]
  };
  assert.equal(evaluateIssue(issue, policy).allowed, true);
});

test("epics are blocked", () => {
  const issue = {
    key: "PACE-200",
    summary: "Epic",
    description: "## Kabul Kriteri\n- [ ] Defined",
    issueType: "Epik",
    status: "Yapılacaklar",
    labels: ["agent-ready"]
  };
  assert.equal(evaluateIssue(issue, policy).allowed, false);
});

test("canonical done and cancelled states remain human-only", () => {
  for (const canonicalState of ["done", "cancelled"]) {
    const issue = {
      key: "PACE-201",
      summary: "Terminal work",
      description: "Acceptance Criteria\n- [ ] Defined",
      issueType: "Story",
      status: "provider-specific",
      canonicalState,
      labels: ["agent-ready"]
    };
    assert.equal(evaluateIssue(issue, policy).allowed, false);
  }
});

test("unknown canonical state fails closed", () => {
  const issue = {
    key: "PACE-202",
    summary: "Unmapped work",
    description: "Acceptance Criteria\n- [ ] Defined",
    issueType: "Story",
    status: "Vendor Queue",
    canonicalState: "unknown",
    labels: ["agent-ready"]
  };
  const result = evaluateIssue(issue, policy);
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(" "), /canonical workflow mapping/);
});
