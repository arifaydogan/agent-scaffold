import { getStore } from "./runtime.js";
import { validateChangedFiles, parseGitStatus } from "./scope.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

export function sanitizePayload(payload) {
  if (payload === null || payload === undefined) return payload;

  const sanitizeString = (str) => {
    if (typeof str !== 'string') return str;
    return str
      .replace(/\bBearer\s+[A-Za-z0-9+/_.~-]{10,}/gi, "Bearer [redacted]")
      .replace(/\b[A-Za-z0-9+/_-]{10,}\.[A-Za-z0-9+/_-]{10,}\.[A-Za-z0-9+/_-]{10,}\b/g, "[redacted]")
      .replace(/\b[A-Za-z0-9+/]{20,}={0,2}\b/g, "[redacted]");
  };

  const cloneAndRedact = (val) => {
    if (typeof val === 'string') {
      return sanitizeString(val);
    } else if (Array.isArray(val)) {
      return val.map(item => cloneAndRedact(item));
    } else if (typeof val === 'object' && val !== null) {
      const clonedObj = {};
      for (const key of Object.keys(val)) {
        const lower = key.toLowerCase();
        if (lower.includes('secret') || lower.includes('prompt') || lower.includes('token') || lower.includes('credential') || lower === 'env' || lower === 'raw_response') {
          continue; // omit key
        }
        clonedObj[key] = cloneAndRedact(val[key]);
      }
      return clonedObj;
    }
    return val;
  };

  return cloneAndRedact(payload);
}

export function persistPreSpawn(settings, issueKey, payload) {
  const store = getStore(settings);
  try {
    const sanitizedPayload = sanitizePayload(payload);
    const runId = store.createRun(issueKey, sanitizedPayload);
    store.transition(runId, "queued", sanitizedPayload);
    return runId;
  } finally {
    store.database.close();
  }
}

export function streamProgress(settings, runId, progressData) {
  const store = getStore(settings);
  try {
    store.transition(runId, "progress", sanitizePayload(progressData));
  } finally {
    store.database.close();
  }
}

export function heartbeat(settings, runId, data) {
  const store = getStore(settings);
  try {
    store.transition(runId, "progress", sanitizePayload(data));
  } finally {
    store.database.close();
  }
}

const SAFE_RETRY_PLAN_FIELDS = [
  "summary", "epicKey", "persona", "taskAgent", "skills", "risk",
  "parallelSafe", "branch", "worktree", "allowedPaths"
];

export function requestExternalRetry(settings, request, options = {}) {
  const store = options.store || getStore(settings);
  const ownsStore = !options.store;
  try {
    const issueKey = String(request?.issueKey || "");
    const requestedRunId = String(request?.runId || "");
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey) || !/^[0-9a-f-]{36}$/i.test(requestedRunId)) {
      throw new Error("Invalid retry request");
    }

    const runs = store.listRunsDetailed(200).filter((run) => run.issue_key === issueKey);
    const requested = runs.find((run) => run.id === requestedRunId);
    const existing = runs.find((run) => run.payload?.retryOfRunId === requestedRunId);
    if (existing) {
      return { runId: existing.id, state: existing.state, duplicate: true };
    }

    if (!requested || runs[0]?.id !== requestedRunId) {
      throw new Error("Retry is only allowed for the latest task state");
    }
    if (!["blocked", "failed-retryable", "human_action_required"].includes(requested.state)) {
      throw new Error("Latest task state is not retryable");
    }

    const workerRuns = runs.filter((run) => !run.payload?.role || run.payload.role === "worker");
    const currentAttempt = Math.max(1, ...workerRuns.map((run) => Number(run.payload?.attempt) || 1));
    const maxAttempts = Number(settings.data.policy?.maxAttempts) || 3;
    if (currentAttempt >= maxAttempts) {
      throw new Error("Automatic retry limit reached");
    }

    const parentId = requested.payload?.parentRunId || requestedRunId;
    const source = runs.find((run) => run.id === parentId) || requested;
    const plan = source.payload || {};
    const safePlan = {};
    for (const key of SAFE_RETRY_PLAN_FIELDS) safePlan[key] = plan[key];
    safePlan.execution = plan.execution ? sanitizePayload(plan.execution) : {};
    safePlan.role = "worker";
    safePlan.retryOfRunId = requestedRunId;
    safePlan.parentRunId = requestedRunId;
    safePlan.attempt = currentAttempt + 1;
    safePlan.blockerResolution = "User confirmed blocker resolved from control plane";

    const retryRunId = store.createRun(issueKey, sanitizePayload(safePlan));
    store.transition(retryRunId, "retry_requested", {
      retryOfRunId: requestedRunId,
      attempt: safePlan.attempt,
      blockerResolved: true,
      humanActionRequired: false,
      resolution: "Retry queued; supervisor will claim it when capacity is available"
    });
    return { runId: retryRunId, state: "retry_requested", duplicate: false };
  } finally {
    if (ownsStore) store.database.close();
  }
}

export function gateTerminalSuccess(settings, runId, worktree, allowedPaths, telemetryOk = true) {
  const store = getStore(settings);
  try {
    if (!fs.existsSync(worktree)) {
      store.transition(runId, "failed", { reasons: ["Worktree does not exist"] });
      return false;
    }

    const gitStatus = spawnSync(
      "git",
      ["-c", "safe.directory=*", "-C", worktree, "status", "--porcelain=v1"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );

    let scope;
    if (gitStatus.status !== 0) {
      scope = {
        allowed: false,
        changedFiles: [],
        violations: [],
        reasons: ["Unable to inspect worktree changes"]
      };
    } else {
      scope = validateChangedFiles({
        changedFiles: parseGitStatus(gitStatus.stdout),
        allowedPatterns: allowedPaths || [],
        maxChangedFiles: settings?.data?.policy?.maxChangedFiles || 30
      });
    }

    const accepted = telemetryOk && scope.allowed && scope.changedFiles.length > 0;

    if (accepted) {
      store.transition(runId, "verifying", { scope });
      return true;
    } else if (!scope.allowed) {
      store.transition(runId, "failed-scope", { scope, reasons: scope.reasons });
      return false;
    } else if (scope.changedFiles.length === 0) {
      store.transition(runId, "blocked", { scope, reasons: ["No changed files or commit"] });
      return false;
    } else {
      store.transition(runId, "failed", { scope, reasons: ["Validation evidence missing"] });
      return false;
    }
  } finally {
    store.database.close();
  }
}

export function backfillExternalRun(settings, { issueKey, pid, provider, model, branch, blocker }) {
  const store = getStore(settings);
  try {
    let runs = store.listRunsDetailed(100).filter(r => r.issue_key === issueKey);

    let targetRun = runs.find(r => r.payload.branch === branch || (r.payload.worktree && r.payload.worktree.endsWith(branch)));

    let runId;
    let payload = { branch, worktree: branch, execution: { provider, model } };

    if (!targetRun) {
       runId = store.createRun(issueKey, payload);
    } else {
       runId = targetRun.id;
       payload = targetRun.payload;
    }

    const fullRun = store.getRun(runId);
    const events = fullRun.events || [];
    const hasEvent = (state) => events.some(e => e.state === state);

    if (!hasEvent("queued")) {
      store.transition(runId, "queued", sanitizePayload({ ...payload, provider, model }));
    }
    if (!hasEvent("started")) {
      store.transition(runId, "started", sanitizePayload({ ...payload, provider, model, pid }));
    }
    if (!hasEvent("progress")) {
      store.transition(runId, "progress", sanitizePayload({ ...payload, provider, model, pid, text: "External worker recovered" }));
    }

    if (blocker && !hasEvent("blocked")) {
      store.transition(runId, "blocked", sanitizePayload({
        ...payload,
        provider,
        model,
        pid,
        reasons: [blocker],
        result: { blockers: [blocker] }
      }));
    }

    return runId;
  } finally {
    store.database.close();
  }
}
