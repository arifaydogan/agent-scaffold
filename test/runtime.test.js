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


test("worktree setup failure releases the acquired issue lock", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-worktree-failure-"));
  const settings = {
    source: path.join(directory, "agent-scaffold.json"),
    repoPath: directory,
    worktreeRoot: path.join(directory, "worktrees"),
    data: {
      policy: {
        allowedProjects: ["PACE"],
        requiredLabels: ["agent-ready"],
        humanOnlyStatuses: ["Done"],
        maxConcurrency: 1,
        pathScopes: { "backend-engineer": ["lib/**"] }
      },
      executor: {
        defaultProvider: "codex",
        providers: {
          codex: {
            command: ["codex", "exec", "{prompt}"],
            defaultModel: "gpt-5",
            defaultEffort: "medium",
            mode: "accept-edits",
            timeoutSeconds: 60
          }
        }
      }
    }
  };
  const issue = {
    key: "PACE-11",
    canonicalState: "ready",
    summary: "Add endpoint",
    description: "Acceptance Criteria: returns HTTP 200",
    issueType: "Task",
    status: "To Do",
    labels: ["agent-ready"]
  };

  const result = runIssue(settings, issue, true, {
    spawnSync: () => ({ status: 1, stdout: "", stderr: "worktree failed" }),
    spawn: () => { throw new Error("provider must not start"); }
  });

  assert.equal(result.exitCode, 7);
  const store = new RunStore(path.join(directory, ".agent-runtime", "runs.sqlite3"));
  assert.equal(store.listLocks().length, 0);
  const run = store.listRunsDetailed(1)[0];
  assert.equal(run.state, "failed-retryable");
  assert.match(run.latest_payload.reason, /worktree setup failed/i);
});
