import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../lib/store.js";
import { runIssue } from "../lib/runtime.js";

test("dry-run does not claim the issue lock", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-"));
  const settings = {
    source: path.join(directory, "agent-scaffold.json"),
    repoPath: directory,
    worktreeRoot: path.join(directory, "worktrees"),
    data: {
      policy: {
        allowedProjects: ["PACE"],
        requiredLabels: ["agent-ready"],
        humanOnlyStatuses: ["Tamam"]
      }
    }
  };
  const issue = {
    key: "PACE-10",
    summary: "Add health endpoint",
    description: "## Acceptance Criteria\n- [ ] Returns HTTP 200",
    issueType: "Hikaye",
    status: "Yapılacaklar",
    labels: ["agent-ready"]
  };
  const result = runIssue(settings, issue, false);
  assert.equal(result.exitCode, 0);

  const store = new RunStore(path.join(directory, ".agent-runtime", "runs.sqlite3"));
  const secondRun = store.createRun(issue.key, {});
  assert.equal(store.acquireLock(issue.key, secondRun), true);
});
