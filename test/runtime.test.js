import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../lib/store.js";
import { runIssue, issuePlan } from "../lib/runtime.js";
import { pathMatchesScope, validateChangedFiles } from "../lib/scope.js";
import { prepareWorktree } from "../lib/worktree.js";

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

test("Regression: frontend-engineer canonical scope obtains ui/** and test/ui.test.js while excluding backend paths", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fe-scope-"));
  const dbPath = path.join(directory, ".agent-runtime", "runs.sqlite3");
  const store = new RunStore(dbPath);

  const settings = {
    source: path.join(directory, "agent-scaffold.json"),
    repoPath: directory,
    worktreeRoot: path.join(directory, "worktrees"),
    data: {
      project: {
        key: "PACE",
        repoPath: ".",
        baseBranch: "epic/provider-neutral-control-plane"
      },
      policy: {
        allowedProjects: ["PACE"],
        requiredLabels: ["agent-ready"],
        humanOnlyStatuses: ["Done"],
        maxConcurrency: 2,
        pathScopes: {
          "frontend-engineer": ["frontend/**", "ui/**", "test/ui.test.js"],
          "backend-engineer": ["backend/**", "lib/**"]
        }
      },
      executor: {
        defaultProvider: "codex",
        providers: {
          codex: {
            command: ["codex", "exec", "-C", "{worktree}", "{prompt}"],
            timeoutSeconds: 3600
          }
        }
      }
    }
  };

  const uiIssue = {
    key: "PACE-364",
    summary: "Refactor Control Plane UI cockpit components and drawers",
    description: "## Acceptance Criteria\n- [ ] Polish ui/dashboard.css\n- [ ] Update ui/index.html\n- [ ] Pass test/ui.test.js",
    issueType: "Task",
    status: "Yapılacaklar",
    labels: ["agent-ready"]
  };

  const plan = issuePlan(settings, uiIssue, { store });

  assert.equal(plan.persona, "frontend-engineer");
  assert.equal(plan.taskAgent, "frontend-engineer");
  assert.ok(plan.allowedPaths.includes("ui/**"), "allowedPaths must include ui/**");
  assert.ok(plan.allowedPaths.includes("test/ui.test.js"), "allowedPaths must include test/ui.test.js");
  assert.ok(plan.allowedPaths.includes("frontend/**"), "allowedPaths must include frontend/**");
  assert.equal(plan.allowedPaths.includes("backend/**"), false, "allowedPaths must exclude backend/**");
  assert.equal(plan.allowedPaths.includes("lib/**"), false, "allowedPaths must exclude lib/**");
  assert.equal(plan.allowedPaths.includes("test/**"), false, "allowedPaths must not widen to unrestricted test/**");

  // Verify path matching: ui and test/ui.test.js allowed, backend rejected
  const validFiles = ["ui/index.html", "ui/dashboard.css", "ui/dashboard.js", "test/ui.test.js"];
  const validCheck = validateChangedFiles({
    changedFiles: validFiles,
    allowedPatterns: plan.allowedPaths,
    maxChangedFiles: 30
  });
  assert.equal(validCheck.allowed, true, "UI files and test/ui.test.js must be valid within allowedPaths");
  assert.equal(validCheck.violations.length, 0);

  const invalidFiles = ["backend/server.py", "lib/runtime.js", "test/runtime.test.js"];
  const invalidCheck = validateChangedFiles({
    changedFiles: invalidFiles,
    allowedPatterns: plan.allowedPaths,
    maxChangedFiles: 30
  });
  assert.equal(invalidCheck.allowed, false, "Backend files must fail scope validation");
  assert.equal(invalidCheck.violations.length, 3);
});

test("Regression: standalone issue uses configured baseRef and resolves baseSha, while parent childBaseSha still wins", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-base-ref-repo-"));
  const worktreesDir = path.join(repo, "worktrees");

  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "config", "user.email", "test@example.com"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "config", "user.name", "Test User"]).status, 0);

  fs.writeFileSync(path.join(repo, "README.md"), "initial develop\n", "utf8");
  assert.equal(spawnSync("git", ["-C", repo, "add", "README.md"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "commit", "-qm", "initial commit"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "branch", "-M", "develop"]).status, 0);

  const developSha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim().toLowerCase();

  // Create active delivery branch with additional commit
  assert.equal(spawnSync("git", ["-C", repo, "checkout", "-b", "epic/provider-neutral-control-plane"]).status, 0);
  fs.writeFileSync(path.join(repo, "feature.txt"), "control plane feature\n", "utf8");
  assert.equal(spawnSync("git", ["-C", repo, "add", "feature.txt"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "commit", "-qm", "feat: control plane"]).status, 0);

  const epicControlPlaneSha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim().toLowerCase();
  assert.notEqual(developSha, epicControlPlaneSha, "epic branch must be ahead of develop");

  // Switch back to develop to prove resolution finds the configured branch
  assert.equal(spawnSync("git", ["-C", repo, "checkout", "develop"]).status, 0);

  const dbPath = path.join(repo, ".agent-runtime", "runs.sqlite3");
  const store = new RunStore(dbPath);

  const settings = {
    source: path.join(repo, "agent-scaffold.json"),
    repoPath: repo,
    worktreeRoot: worktreesDir,
    data: {
      project: {
        key: "PACE",
        repoPath: ".",
        baseBranch: "epic/provider-neutral-control-plane"
      },
      policy: {
        allowedProjects: ["PACE"],
        requiredLabels: ["agent-ready"],
        humanOnlyStatuses: ["Done"],
        maxConcurrency: 2,
        pathScopes: {
          "frontend-engineer": ["frontend/**", "ui/**", "test/ui.test.js"]
        }
      }
    }
  };

  // 1. Standalone issue without parent
  const standaloneIssue = {
    key: "PACE-364",
    summary: "Standalone UI task",
    description: "## Acceptance Criteria\n- [ ] UI task",
    issueType: "Task",
    status: "Yapılacaklar",
    labels: ["agent-ready"]
  };

  const standalonePlan = issuePlan(settings, standaloneIssue, { store });
  assert.equal(standalonePlan.baseRef, "epic/provider-neutral-control-plane");
  assert.equal(standalonePlan.baseSha, epicControlPlaneSha);

  const standaloneWt = prepareWorktree({
    repoPath: repo,
    root: worktreesDir,
    issueKey: standaloneIssue.key,
    summary: standaloneIssue.summary,
    settings,
    store
  });
  assert.equal(standaloneWt.baseRef, "epic/provider-neutral-control-plane");
  assert.equal(standaloneWt.baseSha, epicControlPlaneSha);
  assert.equal(standaloneWt.command.at(-1), "epic/provider-neutral-control-plane");

  // 2. Parent child issue with pinned childBaseSha
  const parentKey = "PACE-500";
  const childKey = "PACE-501";
  store.upsertEpic({
    key: parentKey,
    summary: "Parent Epic",
    branch: "epic/pace-500",
    baseBranch: "develop"
  });
  store.upsertEpicTask({
    epicKey: parentKey,
    issueKey: childKey,
    summary: "Child Task",
    branch: "task/pace-501-child-task",
    childBaseSha: developSha,
    state: "planned"
  });

  const childIssue = {
    key: childKey,
    epicKey: parentKey,
    parentKey: parentKey,
    summary: "Child Task",
    description: "## Acceptance Criteria\n- [ ] Child task",
    issueType: "Subtask",
    status: "Yapılacaklar",
    labels: ["agent-ready"]
  };

  const childPlan = issuePlan(settings, childIssue, { store });
  assert.equal(childPlan.baseSha, developSha, "Pinned childBaseSha must take precedence over configured baseBranch");

  const childWt = prepareWorktree({
    repoPath: repo,
    root: worktreesDir,
    issueKey: childKey,
    epicKey: parentKey,
    summary: "Child Task",
    settings,
    store
  });
  assert.equal(childWt.baseSha, developSha, "prepareWorktree must use pinned childBaseSha");
});
