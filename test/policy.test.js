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
