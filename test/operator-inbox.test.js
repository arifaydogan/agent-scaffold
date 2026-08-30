import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../lib/store.js";
import {
  captureOperatorRequest,
  getAnsweredOperatorContext,
  listOperatorRequests,
  recordOperatorResume,
  respondToOperatorRequest
} from "../lib/operator-inbox.js";

function storeFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "operator-inbox-"));
  return new RunStore(path.join(directory, "runs.sqlite3"));
}

test("blocked execution result becomes one durable operator question", () => {
  const store = storeFixture();
  const first = captureOperatorRequest(store, {
    issueKey: "PACE-364",
    runId: "00000000-0000-4000-8000-000000000001",
    requestId: "00000000-0000-4000-8000-000000000002",
    result: {
      status: "blocked",
      blockers: ["Which onboarding copy should be used?"],
      changed_files: [],
      validation_commands: [],
      risks: [],
      summary: "Waiting for operator input"
    },
    planFingerprint: "fp-364",
    taskAgent: "frontend-engineer"
  });
  const duplicate = captureOperatorRequest(store, {
    issueKey: "PACE-364",
    runId: first.runId,
    result: { status: "blocked", blockers: ["Duplicate question"] }
  });

  assert.equal(duplicate.requestId, first.requestId);
  assert.deepEqual(listOperatorRequests(store), [{
    requestId: first.requestId,
    issueKey: "PACE-364",
    runId: first.runId,
    kind: "question",
    question: "Which onboarding copy should be used?",
    options: [],
    blocking: true,
    planFingerprint: "fp-364",
    taskAgent: "frontend-engineer",
    status: "open",
    answer: null,
    createdAt: store.listPmDecisions(10).find(item => item.type === "operator_request").createdAt,
    answeredAt: null,
    resume: null
  }]);
  assert.equal(store.listPmMessages(10)[0].role, "agent");
  store.database.close();
});

test("operator response is append-only, resumable, and cannot be answered twice", () => {
  const store = storeFixture();
  const request = captureOperatorRequest(store, {
    issueKey: "PACE-364",
    runId: "00000000-0000-4000-8000-000000000011",
    requestId: "00000000-0000-4000-8000-000000000012",
    result: { status: "blocked", blockers: ["Use compact or spacious layout?"] },
    planFingerprint: "fp-answer"
  });
  const answered = respondToOperatorRequest(store, request.requestId, "Use the compact layout.");
  const context = getAnsweredOperatorContext(store, request.requestId);
  recordOperatorResume(store, answered, { accepted: true, pid: 43210 });

  assert.equal(context.question, "Use compact or spacious layout?");
  assert.equal(context.answer, "Use the compact layout.");
  assert.equal(context.planFingerprint, "fp-answer");
  assert.equal(listOperatorRequests(store)[0].status, "resuming");
  assert.equal(listOperatorRequests(store)[0].resume.pid, 43210);
  assert.throws(
    () => respondToOperatorRequest(store, request.requestId, "A second answer"),
    /already been answered/
  );
  store.database.close();
});

test("completed results do not create operator questions", () => {
  const store = storeFixture();
  const request = captureOperatorRequest(store, {
    issueKey: "PACE-364",
    runId: "00000000-0000-4000-8000-000000000021",
    result: { status: "completed", blockers: [] }
  });
  assert.equal(request, null);
  assert.deepEqual(listOperatorRequests(store), []);
  store.database.close();
});
