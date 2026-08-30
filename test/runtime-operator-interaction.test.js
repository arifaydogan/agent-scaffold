import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../lib/store.js";
import { spawnProviderAsync } from "../lib/runtime.js";
import { listOperatorRequests } from "../lib/operator-inbox.js";

test("blocked provider result transitions to human_action_required and releases its issue lock", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-operator-"));
  const store = new RunStore(path.join(directory, "runs.sqlite3"));
  const runId = store.createRun("PACE-364", {
    issue: "PACE-364",
    summary: "Help drawer",
    taskAgent: "frontend-engineer",
    allowedPaths: ["ui/**"],
    planFingerprint: "fp-runtime-question"
  });
  store.acquireLock("PACE-364", runId);
  store.transition(runId, "claimed");
  store.transition(runId, "prepared", {});

  const logDirectory = path.join(directory, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const runtime = {
    spawn() {
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({
          status: "SUCCESS",
          response: JSON.stringify({
            status: "blocked",
            summary: "Waiting for a product decision",
            changed_files: [],
            validation_commands: [],
            blockers: ["Should the drawer open automatically on first visit?"],
            risks: []
          })
        }) + "\n"));
        child.emit("close", 0);
      });
      return child;
    },
    spawnSync() {
      return { status: 0, stdout: "", stderr: "" };
    }
  };

  const result = await spawnProviderAsync({
    store,
    runId,
    issueKey: "PACE-364",
    built: {
      command: ["agent", "run"],
      redactedCommand: ["agent", "run"],
      cwd: directory,
      logFile: path.join(logDirectory, "run.log")
    },
    profile: {
      provider: "antigravity",
      agent: "frontend-engineer",
      model: "model",
      modelProfile: "medium"
    },
    plan: {
      issue: "PACE-364",
      taskAgent: "frontend-engineer",
      allowedPaths: ["ui/**"],
      maxChangedFiles: 30,
      planFingerprint: "fp-runtime-question"
    },
    prepared: { worktree: directory },
    timeoutMs: 10_000
  }, runtime);

  assert.equal(result.exitCode, 2);
  assert.equal(result.operatorRequest.question, "Should the drawer open automatically on first visit?");
  assert.equal(store.getRun(runId).state, "human_action_required");
  assert.equal(store.listLocks().some(lock => lock.issue_key === "PACE-364"), false);
  assert.equal(listOperatorRequests(store)[0].planFingerprint, "fp-runtime-question");
  store.database.close();
});
