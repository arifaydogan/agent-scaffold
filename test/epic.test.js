import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../lib/store.js";
import {
  epicBranchName,
  leafBranchName,
  prepareEpicWorktree,
  prepareLeafWorktree,
  registerEpicContext,
  requestEpicIntegration,
  completeEpicIntegration,
  evaluateEpicReady,
  reserveEpicReadyNotification
} from "../lib/epic.js";

function store() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-epic-"));
  return new RunStore(path.join(directory, "runs.sqlite3"));
}

test("epic and leaf worktree plans preserve develop -> epic -> leaf hierarchy", () => {
  const epic = prepareEpicWorktree({
    repoPath: "C:/repo", root: "C:/worktrees", epicKey: "PACE-124",
    summary: "Agent orchestration", baseRef: "develop"
  });
  assert.equal(epic.branch, "epic/pace-124-agent-orchestration");
  assert.equal(epic.command.at(-1), "develop");

  const leaf = prepareLeafWorktree({
    repoPath: "C:/repo", root: "C:/worktrees", epicKey: "PACE-124",
    epicBranch: epic.branch, issueKey: "PACE-359", summary: "Epic runtime"
  });
  assert.equal(leaf.branch, "task/pace-359-epic-runtime");
  assert.equal(leaf.command.at(-1), epic.branch);
  assert.equal(epicBranchName("PACE-1", "A!"), "epic/pace-1-a");
  assert.equal(leafBranchName("PACE-2", "B!"), "task/pace-2-b");
});

test("serialized integration blocks conflicts and epic-ready notification is idempotent", () => {
  const db = store();
  registerEpicContext(db, {
    key: "PACE-124", summary: "Agent orchestration", modelBudget: 1000,
    tasks: [
      { key: "PACE-359", summary: "Epic runtime", budget: 500 },
      { key: "PACE-360", summary: "Notification dossier", budget: 500 }
    ]
  });

  assert.equal(requestEpicIntegration(db, { epicKey: "PACE-124", issueKey: "PACE-359" }).queued, true);
  const blocked = requestEpicIntegration(db, { epicKey: "PACE-124", issueKey: "PACE-360" });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /PACE-359/);

  assert.equal(completeEpicIntegration(db, {
    epicKey: "PACE-124", issueKey: "PACE-359", conflict: "merge conflict"
  }).state, "conflict");
  assert.equal(evaluateEpicReady(db, "PACE-124").ready, false);
  assert.match(evaluateEpicReady(db, "PACE-124").reasons.join(" "), /PACE-359/);

  const readyDb = store();
  registerEpicContext(readyDb, {
    key: "PACE-200", summary: "Ready epic", tasks: ["PACE-201", "PACE-202"]
  });
  for (const key of ["PACE-201", "PACE-202"]) {
    assert.equal(requestEpicIntegration(readyDb, { epicKey: "PACE-200", issueKey: key }).queued, true);
    assert.equal(completeEpicIntegration(readyDb, { epicKey: "PACE-200", issueKey: key, commit: key }).state, "integrated");
  }
  assert.equal(evaluateEpicReady(readyDb, "PACE-200").ready, true);
  assert.equal(reserveEpicReadyNotification(readyDb, "PACE-200").reserved, true);
  assert.equal(reserveEpicReadyNotification(readyDb, "PACE-200").reserved, false);
  assert.equal(readyDb.markEpicNotificationSent("PACE-200", "epic-ready"), true);
  assert.equal(readyDb.markEpicNotificationSent("PACE-200", "epic-ready"), false);
});


test("leaf worktree resolves the actual slugged epic branch", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-epic-ref-"));
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "config", "user.email", "test@example.com"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "config", "user.name", "Test User"]).status, 0);
  fs.writeFileSync(path.join(repo, "README.md"), "test\n", "utf8");
  assert.equal(spawnSync("git", ["-C", repo, "add", "README.md"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "commit", "-qm", "init"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "branch", "-M", "develop"]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", repo, "branch", "epic/pace-124-agent-orchestration"]).status,
    0
  );

  const epic = prepareEpicWorktree({
    repoPath: repo,
    root: path.join(repo, "worktrees"),
    epicKey: "PACE-999",
    summary: "New epic",
    baseRef: "develop"
  });
  assert.equal(epic.baseRef, "develop");
  assert.equal(epic.baseRefResolved, true);

  const leaf = prepareLeafWorktree({
    repoPath: repo,
    root: path.join(repo, "worktrees"),
    epicKey: "PACE-124",
    epicBranch: "epic/pace-124",
    issueKey: "PACE-362",
    summary: "Recovery"
  });
  assert.equal(leaf.baseRef, "epic/pace-124-agent-orchestration");
  assert.equal(leaf.baseRefResolved, true);
  assert.equal(leaf.command.at(-1), "epic/pace-124-agent-orchestration");
});
