import test from "node:test";
import assert from "node:assert/strict";
import { integrateLeafToEpic } from "../lib/git-integration.js";

const REVIEWED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INTEGRATED = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const settings = { repoPath: "C:/repo/epic" };
const request = {
  epicKey: "PACE-124",
  issueKey: "PACE-362",
  sourceBranch: "task/pace-362-reconciler",
  targetBranch: "epic/pace-124-agent-orchestration",
  reviewedSha: REVIEWED
};

function result(status = 0, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

test("git integration verifies the reviewed tip and check before committing the epic merge", () => {
  const calls = [];
  const runtime = {
    spawnSync(command, args) {
      calls.push([command, ...args]);
      const text = args.join(" ");
      if (text.includes("branch --show-current")) return result(0, `${request.targetBranch}\n`);
      if (text.includes("status --porcelain")) return result();
      if (text.includes("rev-parse task/pace-362-reconciler^{commit}")) return result(0, `${REVIEWED}\n`);
      if (text.includes("merge --no-ff --no-commit")) return result();
      if (command === "npm" || command === "npm.cmd") return result();
      if (text.includes("commit -m")) return result();
      if (text.includes("rev-parse HEAD")) return result(0, `${INTEGRATED}\n`);
      if (text.includes("merge-base --is-ancestor")) return result();
      throw new Error(`Unexpected command: ${command} ${text}`);
    }
  };

  const integrated = integrateLeafToEpic(settings, request, { runtime });

  assert.equal(integrated.completed, true);
  assert.equal(integrated.reviewedSha, REVIEWED);
  assert.equal(integrated.integratedSha, INTEGRATED);
  const mergeIndex = calls.findIndex((call) => call.includes("--no-commit"));
  const checkIndex = calls.findIndex((call) => call[0] === "npm" || call[0] === "npm.cmd");
  const commitIndex = calls.findIndex((call) => call.includes("commit"));
  assert.ok(mergeIndex < checkIndex && checkIndex < commitIndex);
});

test("git integration aborts a conflicted merge and returns durable blocker evidence", () => {
  const calls = [];
  const runtime = {
    spawnSync(command, args) {
      calls.push([command, ...args]);
      const text = args.join(" ");
      if (text.includes("branch --show-current")) return result(0, `${request.targetBranch}\n`);
      if (text.includes("status --porcelain")) return result();
      if (text.includes("rev-parse task/pace-362-reconciler^{commit}")) return result(0, `${REVIEWED}\n`);
      if (text.includes("merge --no-ff --no-commit")) return result(1, "", "conflict");
      if (text.includes("diff --name-only --diff-filter=U")) return result(0, "lib/runtime.js\n");
      if (text.includes("merge --abort")) return result();
      throw new Error(`Unexpected command: ${command} ${text}`);
    }
  };

  const blocked = integrateLeafToEpic(settings, request, { runtime });

  assert.equal(blocked.completed, false);
  assert.match(blocked.conflict, /lib\/runtime\.js/);
  assert.ok(calls.some((call) => call.includes("--abort")));
  assert.ok(!calls.some((call) => call[0] === "npm" || call[0] === "npm.cmd"));
});
