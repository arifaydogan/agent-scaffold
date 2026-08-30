import { randomUUID } from "node:crypto";

const MAX_QUESTION_LENGTH = 2_000;
const MAX_ANSWER_LENGTH = 4_000;

function boundedText(value, field, maxLength) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${field} is required`);
  if (text.length > maxLength) throw new Error(`${field} is too long`);
  return text;
}

function decisionEvents(store, limit = 400) {
  return store.listPmDecisions(Math.max(1, Math.min(Number(limit) || 400, 1_000)));
}

export function listOperatorRequests(store, limit = 100) {
  const requests = new Map();
  const events = [...decisionEvents(store)].reverse();

  for (const event of events) {
    const payload = event.payload || {};
    const requestId = String(payload.requestId || "");
    if (!requestId) continue;

    if (event.type === "operator_request") {
      requests.set(requestId, {
        requestId,
        issueKey: event.issueKey,
        runId: payload.runId || null,
        kind: payload.kind || "question",
        question: payload.question || "",
        options: Array.isArray(payload.options) ? payload.options : [],
        blocking: payload.blocking !== false,
        planFingerprint: payload.planFingerprint || null,
        taskAgent: payload.taskAgent || null,
        status: "open",
        answer: null,
        createdAt: event.createdAt,
        answeredAt: null,
        resume: null
      });
      continue;
    }

    const current = requests.get(requestId);
    if (!current) continue;
    if (event.type === "operator_response") {
      current.status = "answered";
      current.answer = payload.answer || "";
      current.answeredAt = event.createdAt;
      current.answeredBy = payload.operator || "dashboard-operator";
    } else if (event.type === "operator_resume_started") {
      current.status = "resuming";
      current.resume = { pid: payload.pid || null, startedAt: event.createdAt };
    } else if (event.type === "operator_resume_failed") {
      current.status = "resume_failed";
      current.resume = { error: payload.error || "Resume failed", failedAt: event.createdAt };
    }
  }

  return [...requests.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, Math.max(1, Math.min(Number(limit) || 100, 200)));
}

export function captureOperatorRequest(store, {
  issueKey,
  runId,
  result,
  planFingerprint = null,
  taskAgent = null,
  requestId = randomUUID()
}) {
  if (result?.status !== "blocked" || !Array.isArray(result.blockers) || !result.blockers.length) {
    return null;
  }

  const existing = listOperatorRequests(store, 200).find(item => item.runId === runId);
  if (existing) return existing;

  const question = boundedText(result.blockers[0], "Operator question", MAX_QUESTION_LENGTH);
  const payload = {
    requestId,
    runId,
    kind: "question",
    question,
    options: [],
    blocking: true,
    planFingerprint,
    taskAgent
  };
  store.addPmMessage(issueKey, "agent", question);
  store.addPmDecision(issueKey, "operator_request", payload);
  return {
    ...payload,
    issueKey,
    status: "open",
    answer: null
  };
}

export function respondToOperatorRequest(store, requestId, answer, operator = "dashboard-operator") {
  const normalizedId = boundedText(requestId, "Request id", 100);
  const normalizedAnswer = boundedText(answer, "Answer", MAX_ANSWER_LENGTH);
  const request = listOperatorRequests(store, 200).find(item => item.requestId === normalizedId);
  if (!request) throw new Error("Operator request not found");
  if (request.status !== "open") throw new Error("Operator request has already been answered");

  store.addPmMessage(request.issueKey, "operator", normalizedAnswer);
  store.addPmDecision(request.issueKey, "operator_response", {
    requestId: normalizedId,
    runId: request.runId,
    answer: normalizedAnswer,
    operator: String(operator || "dashboard-operator")
  });

  return {
    ...request,
    status: "answered",
    answer: normalizedAnswer,
    answeredBy: String(operator || "dashboard-operator")
  };
}

export function getAnsweredOperatorContext(store, requestId) {
  const request = listOperatorRequests(store, 200).find(item => item.requestId === String(requestId || ""));
  if (!request) throw new Error("Operator request not found");
  if (!request.answer || !["answered", "resuming", "resume_failed"].includes(request.status)) {
    throw new Error("Operator request has not been answered");
  }
  return {
    requestId: request.requestId,
    issueKey: request.issueKey,
    runId: request.runId,
    question: request.question,
    answer: request.answer,
    planFingerprint: request.planFingerprint
  };
}

export function recordOperatorResume(store, request, result) {
  const ok = result?.accepted !== false && !result?.error;
  store.addPmDecision(request.issueKey, ok ? "operator_resume_started" : "operator_resume_failed", {
    requestId: request.requestId,
    runId: request.runId,
    pid: result?.pid || null,
    error: result?.error || null
  });
}
