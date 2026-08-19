import { spawnSync } from "node:child_process";
import { scopesOverlap } from "./scheduler.js";
import { authorizeRuntimeAction } from "./policy.js";
import { createSourceControlProvider } from "./source-control.js";
import { reconcileParentExecution, recordParentTelemetryEvent } from "./parent-orchestrator.js";
import { classifyError } from "./telemetry.js";

const ACTIVE_WORKER_STATES = new Set([
  "claimed",
  "prepared",
  "queued",
  "started",
  "model_selected",
  "progress",
  "executing",
  "retry-dispatching"
]);
const RETRY_PLAN_FIELDS = [
  "summary",
  "epicKey",
  "persona",
  "taskAgent",
  "skills",
  "execution",
  "risk",
  "parallelSafe",
  "branch",
  "worktree",
  "allowedPaths"
];
const RETRY_OPTIONAL_PLAN_FIELDS = [
  "issue",
  "labels",
  "dependencies",
  "executor",
  "model",
  "modelProfile",
  "effort",
  "rationale",
  "reasons",
  "metadata",
  "workSource",
  "orchestratorProvider",
  "baseRef",
  "baseRefResolved",
  "baseRefError",
  "configSnapshot",
  "eligible",
  "eligibilityReasons"
];
const RETRY_META_FIELDS = [
  "role",
  "retryOfRunId",
  "parentRunId",
  "attempt",
  "blockerResolution"
];
const RETRY_OPTIONAL_META_FIELDS = [
  "originatingRunId"
];
const RETRYABLE_PARENT_STATES = new Set([
  "blocked",
  "failed",
  "failed-retryable",
  "failed-scope",
  "review-failed",
  "retry-blocked"
]);
const REVIEW_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const RETRY_RESOLUTION = "User confirmed blocker resolved from control plane";

function nowMs(options = {}) {
  if (typeof options.now === "number") return options.now;
  if (options.now instanceof Date) return options.now.getTime();
  if (typeof options.now === "string") return new Date(options.now).getTime();
  return Date.now();
}

export async function safeWorkSourceMutate(workSource, settings, action, ...args) {
  if (typeof workSource !== "object" || workSource === null) {
    return { performed: false, reason: "no-work-source" };
  }
  const policy = settings?.data?.policy || {};
  if (workSource.writeEnabled !== true) {
    return { performed: false, reason: "provider-write-disabled" };
  }
  if (!policy.externalWritesEnabled) {
    return { performed: false, reason: "external-writes-disabled" };
  }
  if (policy.autonomyEnabled !== true) {
    return { performed: false, reason: "autonomy-disabled" };
  }
  if (typeof workSource[action] !== "function") {
    throw new Error(`Work source provider does not implement ${action}`);
  }
  const result = await workSource[action](...args);
  return { performed: true, result };
}

function compareAndSet(store, runId, expectedState, newState, payload = {}, atMs = Date.now()) {
  if (!store.database) {
    const run = store.getRun(runId);
    if (run.state !== expectedState) return false;
    store.transition(runId, newState, payload);
    return true;
  }

  const at = new Date(atMs).toISOString();
  const executeCas = () => {
    const result = store.database
      .prepare("UPDATE runs SET state = ?, updated_at = ? WHERE id = ? AND state = ?")
      .run(newState, at, runId, expectedState);
    if (result.changes === 1) {
      store.database
        .prepare("INSERT INTO events(run_id, state, payload, created_at) VALUES (?, ?, ?, ?)")
        .run(runId, newState, JSON.stringify(payload), at);
    }
    return result.changes === 1;
  };

  if (typeof store.withTransaction === "function") {
    return store.withTransaction(executeCas);
  }

  store.database.exec("BEGIN IMMEDIATE");
  try {
    const changes = executeCas();
    store.database.exec("COMMIT");
    return changes;
  } catch (error) {
    store.database.exec("ROLLBACK");
    throw error;
  }
}

function parseTime(value) {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function workerProvider(run) {
  return run.latest_payload?.provider || run.payload?.execution?.provider || null;
}

function workerLeaseDeadline(run, staleAfterSeconds) {
  const explicit = parseTime(run.latest_payload?.workerLeaseExpiresAt);
  if (explicit !== null) return explicit;
  const evidence = parseTime(
    run.worker_last_heartbeat_at || run.latest_event_at || run.updated_at || run.created_at
  );
  return evidence === null ? null : evidence + staleAfterSeconds * 1000;
}

function activeSnapshot(runs) {
  const activeRuns = runs.filter((run) => ACTIVE_WORKER_STATES.has(run.state));
  const byProvider = {};
  for (const run of activeRuns) {
    const provider = workerProvider(run);
    if (provider) byProvider[provider] = (byProvider[provider] || 0) + 1;
  }
  return { runs: activeRuns, total: activeRuns.length, byProvider };
}

export function reconcileWorkers(settings, store, options = {}) {
  const atMs = nowMs(options);
  const staleAfterSeconds = Math.max(
    1,
    Number(settings?.data?.supervisor?.staleAfterSeconds) || 90
  );
  const runs = store.listRunsDetailed(200);
  const recovered = [];

  for (const run of runs) {
    if (!ACTIVE_WORKER_STATES.has(run.state)) continue;
    const deadline = workerLeaseDeadline(run, staleAfterSeconds);
    if (deadline === null || deadline > atMs) continue;

    const success = compareAndSet(
      store,
      run.id,
      run.state,
      "failed-retryable",
      {
        reason: "Worker lease expired without a persisted heartbeat",
        previousState: run.state,
        workerLeaseId: run.latest_payload?.workerLeaseId || null,
        leaseExpiredAt: new Date(deadline).toISOString()
      },
      atMs
    );
    if (success) {
      store.releaseLock(run.issue_key, run.id);
      recovered.push(run.id);
    }
  }

  const snapshot = activeSnapshot(store.listRunsDetailed(200));
  return {
    updated: recovered.length,
    recovered,
    active: snapshot.total,
    activeByProvider: snapshot.byProvider
  };
}

function implementationSha(run) {
  const payload = run.latest_payload || {};
  const value = payload.commit || payload.implementationSha || payload.result?.commit || null;
  return typeof value === "string" && REVIEW_SHA.test(value) ? value.toLowerCase() : null;
}

export const ALLOWED_FINDING_SEVERITIES = Object.freeze([
  "critical",
  "major",
  "minor",
  "suggestion"
]);

export const ALLOWED_FINDING_CATEGORIES = Object.freeze([
  "correctness",
  "security",
  "scope",
  "tests",
  "regression",
  "api-contract",
  "data-integrity",
  "simplicity"
]);

export function recordReviewerOutcome(
  store,
  { runId, implementationSha: reviewedSha, reviewerId, verdict, evidence },
  options = {}
) {
  if (!REVIEW_SHA.test(String(reviewedSha || ""))) {
    throw new Error("Reviewer outcome requires a full Git implementation SHA");
  }
  if (!String(reviewerId || "").trim()) {
    throw new Error("Reviewer outcome requires an independent reviewer id");
  }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error("Reviewer outcome requires non-empty persisted evidence");
  }

  const severitiesSet = new Set(ALLOWED_FINDING_SEVERITIES);
  const categoriesSet = new Set(ALLOWED_FINDING_CATEGORIES);

  const validatedEvidence = evidence.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Reviewer outcome evidence must be an array of objects");
    }
    if (!item.id || !item.problem || !item.severity) {
      throw new Error("Reviewer outcome evidence must contain at least id, severity, and problem fields");
    }
    const severity = String(item.severity).toLowerCase();
    if (!severitiesSet.has(severity)) {
      throw new Error(`Invalid reviewer finding severity: "${item.severity}". Allowed: ${ALLOWED_FINDING_SEVERITIES.join(", ")}`);
    }
    if (!item.category) {
      throw new Error(`Reviewer finding category is required. Allowed: ${ALLOWED_FINDING_CATEGORIES.join(", ")}`);
    }
    const category = String(item.category).toLowerCase();
    if (!categoriesSet.has(category)) {
      throw new Error(`Invalid reviewer finding category: "${item.category}". Allowed: ${ALLOWED_FINDING_CATEGORIES.join(", ")}`);
    }
    return {
      id: String(item.id),
      severity,
      category,
      file: item.file ? String(item.file) : null,
      line: item.line != null ? Number(item.line) : null,
      problem: String(item.problem),
      expected: item.expected ? String(item.expected) : null,
      verification: item.verification ? String(item.verification) : null
    };
  });

  if (!["clean", "changes-requested"].includes(verdict)) {
    throw new Error("Reviewer verdict must be clean or changes-requested");
  }

  const run = store.getRun(runId);
  if (run.state !== "review-queued") {
    return { recorded: false, reason: `Run is ${run.state}, not review-queued` };
  }
  const request = run.events.at(-1)?.payload || {};
  if (String(request.implementationSha || "").toLowerCase() !== reviewedSha.toLowerCase()) {
    return { recorded: false, reason: "Reviewer SHA does not match the queued implementation revision" };
  }

  const reviewOutcome = {
    implementationSha: reviewedSha.toLowerCase(),
    reviewerId: String(reviewerId),
    verdict,
    evidence: validatedEvidence,
    reviewedAt: new Date(nowMs(options)).toISOString()
  };
  const state = verdict === "clean" ? "reviewed-clean" : "review-failed";
  const recorded = compareAndSet(
    store,
    runId,
    "review-queued",
    state,
    { reviewOutcome },
    nowMs(options)
  );
  return { recorded, state: recorded ? state : null, reviewOutcome };
}

export function reconcileReviewers(settings, store, options = {}) {
  const atMs = nowMs(options);
  const runs = store.listRunsDetailed(200);
  let reviewsRequested = 0;
  let fixAttemptsRequested = 0;
  const blocked = [];

  for (const run of runs) {
    if (run.state === "verifying") {
      const sha = implementationSha(run);
      if (!sha) {
        blocked.push({
          runId: run.id,
          issueKey: run.issue_key,
          reason: "Verification has no full Git implementation SHA"
        });
        continue;
      }
      
      const nextState = "transitioning-review";
      const payload = {
        implementationSha: sha,
        reviewRequestId: `${run.id}:${sha}`,
        requestedAt: new Date(atMs).toISOString()
      };

      const success = compareAndSet(
        store,
        run.id,
        "verifying",
        nextState,
        payload,
        atMs
      );
      if (success) {
        reviewsRequested += 1;
      }
    } else if (run.state === "transitioning-review") {
      if (options.execute && options.workSource) {
        const p = (async () => {
          try {
            const mutRes = await safeWorkSourceMutate(options.workSource, settings, "transition", run.issue_key, "review", {});
            if (mutRes?.performed === true || mutRes?.skipped === true || mutRes?.ok === true) {
              const success = compareAndSet(store, run.id, "transitioning-review", "review-queued", run.latest_payload, nowMs(options));
              if (success) {
                store.releaseLock(run.issue_key, run.id);
              }
            }
          } catch (err) {
            // Will retry on next tick
          }
        })();
        if (options.promises) options.promises.push(p);
      } else {
        const success = compareAndSet(store, run.id, "transitioning-review", "review-queued", run.latest_payload, nowMs(options));
        if (success) {
          store.releaseLock(run.issue_key, run.id);
        }
      }
    } else if (run.state === "review-failed") {
      const outcome = run.latest_payload?.reviewOutcome || null;
      // We look at the actual attempt count from the initial payload to survive state transitions
      const attempt = run.payload?.attempt || 0;
      const maxReworkAttempts = Math.max(
        0,
        Number(
          run.payload?.configSnapshot?.maxReworkAttempts ??
          settings?.data?.policy?.review?.maxReworkAttempts ??
          3
        )
      );
      
      if (attempt >= maxReworkAttempts) {
        const success = compareAndSet(
          store,
          run.id,
          "review-failed",
          "transitioning-blocked",
          {
            reason: "Rework limit exhausted",
            reviewOutcome: outcome
          },
          atMs
        );
        if (success) store.releaseLock(run.issue_key, run.id);
      } else {
        const success = compareAndSet(
          store,
          run.id,
          "review-failed",
          "transitioning-rework",
          {
            reason: "Independent review requested a fix attempt",
            reviewOutcome: outcome,
            attempt: attempt + 1
          },
          atMs
        );
        if (success) {
          store.releaseLock(run.issue_key, run.id);
          fixAttemptsRequested += 1;
        }
      }
    } else if (run.state === "transitioning-blocked") {
      blocked.push({
        runId: run.id,
        issueKey: run.issue_key,
        reason: "Rework limit exhausted"
      });
      if (options.execute && options.workSource) {
        const outcome = run.latest_payload?.reviewOutcome || null;
        const attempt = run.payload?.attempt || 0;
        const maxReworkAttempts = Math.max(0, Number(settings?.data?.policy?.review?.maxReworkAttempts ?? 3));
        const formattedFindings = (outcome?.evidence || []).map(f => {
          if (typeof f === 'object') {
            return `[${f.severity || 'info'}] ${f.file || 'unknown'}:${f.line || 'unknown'} - ${f.problem || ''} (Expected: ${f.expected || ''})`;
          }
          return String(f);
        }).join('\n');
        const comment = `## Human Attention Required\nAgent rework limit exhausted (${attempt}/${maxReworkAttempts} attempts).\n*Latest Implementation SHA*: ${outcome?.implementationSha || 'Unknown'}\n*Latest Finding*: ${outcome?.verdict}\n*Evidence*:\n${formattedFindings}`;
        const p = (async () => {
          try {
            await safeWorkSourceMutate(options.workSource, settings, "addComment", run.issue_key, comment);
            const transRes = await safeWorkSourceMutate(options.workSource, settings, "transition", run.issue_key, "blocked", {});
            if (transRes?.performed === true) {
              compareAndSet(store, run.id, "transitioning-blocked", "blocked", { reason: "Rework limit exhausted", reviewOutcome: outcome }, nowMs(options));
            }
          } catch (err) {
            // Will retry on next tick
          }
        })();
        if (options.promises) options.promises.push(p);
      }
    } else if (run.state === "transitioning-rework") {
      if (options.execute && options.workSource) {
        const outcome = run.latest_payload?.reviewOutcome || null;
        const attempt = run.latest_payload?.attempt || (run.payload?.attempt || 0) + 1;
        const formattedFindings = (outcome?.evidence || []).map(f => {
          if (typeof f === 'object') {
            return `[${f.severity || 'info'}] ${f.file || 'unknown'}:${f.line || 'unknown'} - ${f.problem || ''} (Expected: ${f.expected || ''})`;
          }
          return String(f);
        }).join('\n');
        const comment = `## Agent Review Failed\n*Reviewer*: ${outcome?.reviewerId || 'Unknown'}\n*Finding*: ${outcome?.verdict}\n*Suggested Fix*:\n${formattedFindings}`;
        const p = (async () => {
          try {
            await safeWorkSourceMutate(options.workSource, settings, "addComment", run.issue_key, comment);
            const transRes = await safeWorkSourceMutate(options.workSource, settings, "transition", run.issue_key, "rework", {});
            if (transRes?.performed === true) {
              compareAndSet(store, run.id, "transitioning-rework", "failed-retryable", { reason: "Independent review requested a fix attempt", reviewOutcome: outcome, attempt }, nowMs(options));
            }
          } catch (err) {
            // Will retry on next tick
          }
        })();
        if (options.promises) options.promises.push(p);
      }
    }
  }
  return {
    reviewsRequested,
    reviewsAccepted: 0,
    fixAttemptsRequested,
    blocked
  };
}

function acceptedReviews(runs) {
  const accepted = new Map();
  for (const run of runs) {
    if ((run.state !== "reviewed-clean" && run.state !== "transitioning-human-approval") || accepted.has(run.issue_key)) continue;
    const outcome = run.latest_payload?.reviewOutcome;
    if (
      outcome?.verdict === "clean" &&
      REVIEW_SHA.test(String(outcome.implementationSha || "")) &&
      String(outcome.reviewerId || "").trim() &&
      Array.isArray(outcome.evidence) &&
      outcome.evidence.length > 0
    ) {
      accepted.set(run.issue_key, {
        runId: run.id,
        state: run.state,
        sha: outcome.implementationSha.toLowerCase(),
        outcome
      });
    }
  }
  return accepted;
}

export function reconcileIntegrations(settings, store, options = {}) {
  const accepted = acceptedReviews(store.listRunsDetailed(200));
  const integrationAdapter = options.integrationAdapter || (options.execute ? ((req) => {
    const sc = createSourceControlProvider(settings);
    return sc.integrateReviewedRevision(settings, req, { store });
  }) : null);
  let integrationsQueued = 0;
  let integrationsCompleted = 0;
  const blocked = [];

  // 1. Auto-queue clean reviewed children for active pinned parent generations
  if (typeof store.listParentExecutions === "function" && typeof store.listEpicTasks === "function") {
    const parentExecutions = store.listParentExecutions(50) || [];
    for (const parent of parentExecutions) {
      if (parent.state !== "active") continue;
      const tasks = store.listEpicTasks(parent.parentKey) || [];
      const existingIntegrations = store.listEpicIntegrations ? (store.listEpicIntegrations(parent.parentKey) || []) : [];
      for (const task of tasks) {
        if (task.state === "integrated" || task.orchestrationState === "integrated") continue;
        const review = accepted.get(task.issueKey);
        if (!review || review.outcome?.verdict !== "clean" || !REVIEW_SHA.test(review.sha)) continue;

        // Check if already queued, integrating, or integrated
        const alreadyQueued = existingIntegrations.some(
          (i) => i.issueKey === task.issueKey && ["queued", "integrating", "integrated"].includes(i.state)
        );
        if (alreadyQueued) continue;

        // Check policy authorization for child integration
        const originatingRun = review.runId ? store.getRun(review.runId) : null;
        const integrationPlan = {
          childIssueKey: task.issueKey,
          leafBranch: task.branch,
          targetBranch: parent.integrationBranch,
          reviewedSha: review.sha
        };
        const auth = authorizeRuntimeAction(settings, store, {
          issueKey: task.issueKey,
          action: "childIntegration",
          plan: integrationPlan,
          originatingRun
        });
        if (!auth.allowed) {
          blocked.push({ epicKey: parent.parentKey, issueKey: task.issueKey, reason: auth.reason });
          continue;
        }

        // Auto-queue integration
        const qResult = store.queueEpicIntegration({
          epicKey: parent.parentKey,
          issueKey: task.issueKey,
          leafBranch: task.branch
        });
        if (qResult && qResult.queued) {
          store.upsertEpicTask({
            ...task,
            reviewedSha: review.sha,
            orchestrationState: "reviewed-clean"
          });
          recordParentTelemetryEvent(store, {
            parentKey: parent.parentKey,
            event: "child_reviewed",
            stage: "progress",
            status: "running",
            metadata: { issueKey: task.issueKey, reviewedSha: review.sha }
          });
          recordParentTelemetryEvent(store, {
            parentKey: parent.parentKey,
            event: "child_integration_queued",
            stage: "progress",
            status: "running",
            metadata: { issueKey: task.issueKey, leafBranch: task.branch, targetBranch: parent.integrationBranch }
          });
        }
      }
    }
  }

  const epicsToProcess = [];
  const seenEpicKeys = new Set();
  if (typeof store.listEpics === "function") {
    for (const epic of store.listEpics(50)) {
      epicsToProcess.push(epic);
      seenEpicKeys.add(epic.key);
    }
  }
  if (typeof store.listParentExecutions === "function") {
    for (const parent of store.listParentExecutions(50)) {
      if (!seenEpicKeys.has(parent.parentKey)) {
        seenEpicKeys.add(parent.parentKey);
        const integrations = typeof store.listEpicIntegrations === "function"
          ? store.listEpicIntegrations(parent.parentKey)
          : [];
        epicsToProcess.push({
          key: parent.parentKey,
          summary: parent.summary,
          branch: parent.integrationBranch,
          baseBranch: parent.baseRef,
          state: parent.state,
          integrations
        });
      }
    }
  }

  for (const epic of epicsToProcess) {
    const parentExec = typeof store.getParentExecution === "function" ? store.getParentExecution(epic.key) : null;
    const integrationWorktree = parentExec?.integrationWorktree || settings.repoPath;
    const sc = createSourceControlProvider(settings);

    for (const integration of epic.integrations) {
      if (integration.state !== "queued" && integration.state !== "integrating") continue;
      const review = accepted.get(integration.issueKey);

      // Crash recovery: If lane was 'integrating', check if git commit was already created before crash
      if (integration.state === "integrating" && review) {
        const headRes = sc.getHead({ repoPath: integrationWorktree });
        const isAnc = headRes.ok ? sc.isAncestor(review.sha, headRes.sha, { repoPath: integrationWorktree }) : false;
        if (headRes.ok && (isAnc === true || isAnc?.isAncestor === true)) {
          const integratedSha = headRes.sha.toLowerCase();
          store.finishEpicIntegration({
            epicKey: epic.key,
            issueKey: integration.issueKey,
            commit: integratedSha
          });
          const existingTask = store.getEpicTask(epic.key, integration.issueKey);
          if (existingTask) {
            store.upsertEpicTask({
              ...existingTask,
              state: "integrated",
              orchestrationState: "integrated",
              reviewedSha: review.sha,
              integratedSha
            });
          }
          recordParentTelemetryEvent(store, {
            parentKey: epic.key,
            event: "child_integrated",
            stage: "progress",
            status: "running",
            metadata: { issueKey: integration.issueKey, reviewedSha: review.sha, integratedSha }
          });
          // Also recover matching unfinished integration-worker run
          const issueRuns = store.listRunsForIssue(integration.issueKey) || [];
          const unfinishedIntRun = issueRuns.findLast(
            (r) => r.payload?.role === "integration-worker" &&
                   ["queued", "started"].includes(r.state) &&
                   String(r.payload?.parentKey) === String(epic.key) &&
                   String(r.payload?.reviewedSha || "").toLowerCase() === String(review.sha || "").toLowerCase()
          );
          if (unfinishedIntRun) {
            store.transition(unfinishedIntRun.id, "completed", { reviewedSha: review.sha, integratedSha });
            if (typeof store.recordTelemetryEvent === "function") {
              try {
                const existingTelem = store.database ? store.database.prepare(
                  "SELECT stage, sequence FROM telemetry_events WHERE run_id = ? ORDER BY sequence ASC, id ASC"
                ).all(unfinishedIntRun.id) : [];
                const hasQueued = existingTelem.some(e => e.stage === "queued");
                const hasStarted = existingTelem.some(e => e.stage === "started");
                const hasTerminal = existingTelem.some(e => e.stage === "terminal");
                if (!hasTerminal) {
                  if (!hasQueued) {
                    store.recordTelemetryEvent({
                      eventId: `telem-int-${unfinishedIntRun.id}-queued-1`,
                      runId: unfinishedIntRun.id,
                      issueKey: integration.issueKey,
                      role: "integration-worker",
                      action: "childIntegration",
                      attempt: 0,
                      stage: "queued",
                      status: "queued",
                      sequence: 1,
                      metadata: { parentKey: epic.key, issueKey: integration.issueKey, reviewedSha: review.sha },
                      createdAt: new Date().toISOString()
                    });
                  }
                  if (!hasStarted) {
                    store.recordTelemetryEvent({
                      eventId: `telem-int-${unfinishedIntRun.id}-started-2`,
                      runId: unfinishedIntRun.id,
                      issueKey: integration.issueKey,
                      role: "integration-worker",
                      action: "childIntegration",
                      attempt: 0,
                      stage: "started",
                      status: "running",
                      sequence: 2,
                      metadata: { parentKey: epic.key, issueKey: integration.issueKey, reviewedSha: review.sha },
                      createdAt: new Date().toISOString()
                    });
                  }
                  store.recordTelemetryEvent({
                    eventId: `telem-int-${unfinishedIntRun.id}-terminal-3`,
                    runId: unfinishedIntRun.id,
                    issueKey: integration.issueKey,
                    role: "integration-worker",
                    action: "childIntegration",
                    attempt: 0,
                    stage: "terminal",
                    status: "completed",
                    sequence: 3,
                    metadata: { parentKey: epic.key, issueKey: integration.issueKey, reviewedSha: review.sha, integratedSha },
                    createdAt: new Date().toISOString()
                  });
                }
              } catch {}
            }
          }
          integrationsCompleted += 1;
          continue;
        }
      }

      if (integration.state !== "queued") continue;
      integrationsQueued += 1;
      if (!review) {
        blocked.push({ epicKey: epic.key, issueKey: integration.issueKey, reason: "No independently accepted reviewed SHA" });
        continue;
      }
      if (typeof integrationAdapter !== "function") {
        blocked.push({ epicKey: epic.key, issueKey: integration.issueKey, reason: "No real integration adapter is configured; lane remains queued" });
        continue;
      }
      if (!settings?.data?.policy?.gitIntegrationEnabled) {
        blocked.push({ epicKey: epic.key, issueKey: integration.issueKey, reason: "Git integrations disabled by policy" });
        continue;
      }
      const originatingRun = review.runId ? store.getRun(review.runId) : null;
      const integrationPlan = {
        childIssueKey: integration.issueKey,
        leafBranch: integration.leafBranch,
        targetBranch: epic.branch,
        reviewedSha: review.sha
      };
      const auth = authorizeRuntimeAction(settings, store, {
        issueKey: integration.issueKey,
        action: "childIntegration",
        plan: integrationPlan,
        originatingRun
      });
      if (!auth.allowed) {
        blocked.push({ epicKey: epic.key, issueKey: integration.issueKey, reason: auth.reason });
        continue;
      }
      const claim = store.claimEpicIntegration({ epicKey: epic.key, issueKey: integration.issueKey });
      if (!claim.claimed) continue;

      recordParentTelemetryEvent(store, {
        parentKey: epic.key,
        event: "child_integrating",
        stage: "progress",
        status: "running",
        payload: { issueKey: integration.issueKey, reviewedSha: review.sha, targetBranch: epic.branch }
      });

      const intRunId = store.createRun(integration.issueKey, {
        role: "integration-worker",
        action: "childIntegration",
        summary: `Integration of ${integration.issueKey} into ${epic.key}`,
        parentKey: epic.key,
        reviewedSha: review.sha,
        targetBranch: epic.branch
      });
      store.transition(intRunId, "queued", { reviewedSha: review.sha });
      if (typeof store.recordTelemetryEvent === "function") {
        try {
          store.recordTelemetryEvent({
            eventId: `telem-int-${intRunId}-queued-1`,
            runId: intRunId,
            issueKey: integration.issueKey,
            role: "integration-worker",
            action: "childIntegration",
            attempt: 0,
            stage: "queued",
            status: "queued",
            sequence: 1,
            metadata: { parentKey: epic.key, issueKey: integration.issueKey, reviewedSha: review.sha, targetBranch: epic.branch },
            createdAt: new Date().toISOString()
          });
        } catch {}
      }

      store.transition(intRunId, "started", { reviewedSha: review.sha });
      if (typeof store.recordTelemetryEvent === "function") {
        try {
          store.recordTelemetryEvent({
            eventId: `telem-int-${intRunId}-started-2`,
            runId: intRunId,
            issueKey: integration.issueKey,
            role: "integration-worker",
            action: "childIntegration",
            attempt: 0,
            stage: "started",
            status: "running",
            sequence: 2,
            metadata: { parentKey: epic.key, issueKey: integration.issueKey, reviewedSha: review.sha, targetBranch: epic.branch },
            createdAt: new Date().toISOString()
          });
        } catch {}
      }

      let evidence;
      try {
        evidence = integrationAdapter({
          epicKey: epic.key,
          issueKey: integration.issueKey,
          sourceBranch: integration.leafBranch,
          targetBranch: epic.branch,
          worktree: integrationWorktree,
          repoPath: integrationWorktree,
          reviewedSha: review.sha,
          runtime: options.runtime || { spawnSync }
        }, { runtime: options.runtime || { spawnSync } });
      } catch (adapterError) {
        const normalized = classifyError(adapterError) || {};
        const safeMessage = String(normalized.safeMessage || "Integration provider failed").slice(0, 300);
        evidence = {
          completed: false,
          conflict: `Integration adapter failed: ${safeMessage}`,
          errorCategory: normalized.category || "provider_process_error"
        };
      }

      if (
        !evidence?.completed ||
        evidence.reviewedSha?.toLowerCase() !== review.sha ||
        !REVIEW_SHA.test(String(evidence.integratedSha || ""))
      ) {
        const reason = evidence?.conflict || "Integration adapter returned incomplete or mismatched evidence";
        store.finishEpicIntegration({ epicKey: epic.key, issueKey: integration.issueKey, conflict: reason });
        store.transition(intRunId, "failed", { reason });
        const existingTask = store.getEpicTask(epic.key, integration.issueKey);
        if (existingTask) {
          store.upsertEpicTask({
            ...existingTask,
            state: "blocked-conflict",
            orchestrationState: "blocked-conflict",
            blockedReasons: [reason]
          });
        }
        if (typeof store.recordTelemetryEvent === "function") {
          try {
            store.recordTelemetryEvent({
              eventId: `telem-int-${intRunId}-terminal-3`,
              runId: intRunId,
              issueKey: integration.issueKey,
              role: "integration-worker",
              action: "childIntegration",
              attempt: 0,
              stage: "terminal",
              status: "failed",
              sequence: 3,
              error: {
                category: "integration_conflict",
                safeMessage: reason
              },
              metadata: { parentKey: epic.key, issueKey: integration.issueKey, reviewedSha: review.sha },
              createdAt: new Date().toISOString()
            });
          } catch {}
        }
        blocked.push({ epicKey: epic.key, issueKey: integration.issueKey, reason });
        continue;
      }

      // Narrow deterministic failure seam (outside normal provider error normalization):
      // Allows testing post-merge crash recovery where Git merge succeeds, but crash happens before SQLite finish bookkeeping
      if (typeof options.afterIntegrationEvidence === "function") {
        options.afterIntegrationEvidence(evidence, integration, epic);
      }

      const integratedSha = evidence.integratedSha.toLowerCase();
      const result = store.finishEpicIntegration({
        epicKey: epic.key,
        issueKey: integration.issueKey,
        commit: integratedSha
      });
      store.transition(intRunId, "completed", { reviewedSha: review.sha, integratedSha });
      const existingTask = store.getEpicTask(epic.key, integration.issueKey);
      if (existingTask) {
        store.upsertEpicTask({
          ...existingTask,
          state: "integrated",
          orchestrationState: "integrated",
          reviewedSha: review.sha,
          integratedSha
        });
      }
      if (typeof store.recordTelemetryEvent === "function") {
        try {
          store.recordTelemetryEvent({
            eventId: `telem-int-${intRunId}-terminal-3`,
            runId: intRunId,
            issueKey: integration.issueKey,
            role: "integration-worker",
            action: "childIntegration",
            attempt: 0,
            stage: "terminal",
            status: "completed",
            sequence: 3,
            metadata: { parentKey: epic.key, issueKey: integration.issueKey, reviewedSha: review.sha, integratedSha },
            createdAt: new Date().toISOString()
          });
        } catch {}
      }
      recordParentTelemetryEvent(store, {
        parentKey: epic.key,
        event: "child_integrated",
        stage: "progress",
        status: "running",
        payload: { issueKey: integration.issueKey, reviewedSha: review.sha, integratedSha }
      });
      if (result.completed) integrationsCompleted += 1;
    }
  }
  return { integrationsQueued, integrationsCompleted, blocked };
}

export function reconcileStandaloneReviews(settings, store, options = {}) {
  const atMs = nowMs(options);
  const accepted = acceptedReviews(store.listRunsDetailed(200));
  const inEpic = new Set();
  
  if (typeof store.listEpicTasks === "function") {
    const tasks = store.listEpicTasks() || [];
    for (const t of tasks) inEpic.add(t.issueKey);
  }
  if (typeof store.listEpics === "function") {
    for (const epic of store.listEpics(50)) {
      for (const integration of epic.integrations || []) {
        inEpic.add(integration.issueKey);
      }
      for (const t of epic.tasks || []) {
        inEpic.add(t.issueKey);
      }
    }
  }
  if (store.database) {
    try {
      const rows = store.database.prepare("SELECT issue_key FROM epic_tasks").all();
      for (const r of rows) inEpic.add(r.issue_key);
    } catch {}
  }

  let transitioned = 0;
  for (const [issueKey, review] of accepted.entries()) {
    if (inEpic.has(issueKey)) continue;

    if (review.state === "reviewed-clean") {
      const success = compareAndSet(store, review.runId, "reviewed-clean", "transitioning-human-approval", { reason: "Standalone review completed", reviewOutcome: review.outcome }, atMs);
      if (success) transitioned += 1;
    } else if (review.state === "transitioning-human-approval") {
      if (options.execute && options.workSource) {
        const comment = "## Review Completed\nClean review verdict reached for standalone issue.";
        const p = (async () => {
          try {
            await safeWorkSourceMutate(options.workSource, settings, "addComment", issueKey, comment);
            const transRes = await safeWorkSourceMutate(options.workSource, settings, "transition", issueKey, "human_approval", {});
            if (transRes?.performed === true) {
              compareAndSet(store, review.runId, "transitioning-human-approval", "completed", { reason: "Standalone review completed", reviewOutcome: review.outcome }, nowMs(options));
            }
          } catch (err) {
            // Will retry on next tick
          }
        })();
        if (options.promises) options.promises.push(p);
      }
    }
  }
  return { transitioned };
}

function cooldownDeadline(payload, eventAt) {
  const direct =
    payload?.cooldownUntil ||
    payload?.result?.cooldownUntil ||
    payload?.result?.providerCooldownUntil;
  const directTime = parseTime(direct);
  if (directTime !== null) return directTime;
  const seconds = Number(payload?.retryAfterSeconds || payload?.result?.retryAfterSeconds);
  const base = parseTime(eventAt);
  return Number.isFinite(seconds) && seconds > 0 && base !== null
    ? base + seconds * 1000
    : null;
}

export function activeProviderCooldowns(store, options = {}) {
  const atMs = nowMs(options);
  const cooldowns = {};
  for (const run of store.listRunsDetailed(200)) {
    const provider = workerProvider(run);
    const deadline = cooldownDeadline(run.latest_payload, run.latest_event_at);
    if (!provider || deadline === null || deadline <= atMs) continue;
    const current = parseTime(cooldowns[provider]);
    if (current === null || deadline > current) {
      cooldowns[provider] = new Date(deadline).toISOString();
    }
  }
  return cooldowns;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function retryPlan(payload) {
  return Object.fromEntries(RETRY_PLAN_FIELDS.map((field) => [field, payload[field]]));
}

function validateRetryRequest(store, run, settings) {
  const payload = run.payload || {};
  const allowedFields = new Set([
    ...RETRY_PLAN_FIELDS,
    ...RETRY_OPTIONAL_PLAN_FIELDS,
    ...RETRY_META_FIELDS,
    ...RETRY_OPTIONAL_META_FIELDS
  ]);
  const unexpected = Object.keys(payload).filter((field) => !allowedFields.has(field));
  if (unexpected.length) return `Retry payload contains unsafe fields: ${unexpected.join(", ")}`;
  const missing = [...RETRY_PLAN_FIELDS, ...RETRY_META_FIELDS].filter(
    (field) => !Object.prototype.hasOwnProperty.call(payload, field)
  );
  if (missing.length) return `Retry payload is missing canonical fields: ${missing.join(", ")}`;
  if (payload.role !== "worker") return "Retry role must be worker";
  if (!payload.retryOfRunId || payload.parentRunId !== payload.retryOfRunId) {
    return "Retry parentRunId must equal retryOfRunId";
  }
  if (payload.blockerResolution !== RETRY_RESOLUTION) {
    return "Retry blocker resolution was not explicitly confirmed";
  }

  let parent;
  try {
    parent = store.getRun(payload.retryOfRunId);
  } catch {
    return `Retry parent run does not exist: ${payload.retryOfRunId}`;
  }
  if (parent.issue_key !== run.issue_key) return "Retry issue does not match its parent run";
  if (!RETRYABLE_PARENT_STATES.has(parent.state)) {
    return `Parent run state is not retryable: ${parent.state}`;
  }

  const parentAttempt = Number(parent.payload?.attempt) || 0;
  const maxAttempts = Math.max(
    1,
    Number(settings?.data?.policy?.maxRetryAttempts) || 3
  );
  if (!Number.isInteger(payload.attempt) || payload.attempt !== parentAttempt + 1) {
    return `Retry attempt must be ${parentAttempt + 1}`;
  }
  if (payload.attempt > maxAttempts) return `Retry attempt exceeds maximum ${maxAttempts}`;

  for (const field of RETRY_PLAN_FIELDS) {
    if (field === "execution") {
      const rExec = payload.execution;
      const pExec = parent.payload?.execution;
      if (!rExec && !pExec) continue;
      if (
        !rExec ||
        !pExec ||
        rExec.provider !== pExec.provider ||
        (rExec.model || null) !== (pExec.model || null) ||
        (rExec.modelProfile || null) !== (pExec.modelProfile || null) ||
        (rExec.effort || null) !== (pExec.effort || null)
      ) {
        return `Retry canonical plan field differs from parent: ${field}`;
      }
      continue;
    }
    if (!sameValue(payload[field], parent.payload?.[field])) {
      return `Retry canonical plan field differs from parent: ${field}`;
    }
  }
  if (!payload.execution?.provider || !Array.isArray(payload.allowedPaths)) {
    return "Retry canonical plan is missing provider or scope evidence";
  }
  return null;
}

function retryDeferral(issueKey, payload, active, cooldowns, locks, settings) {
  const provider = payload.execution.provider;
  if (cooldowns[provider]) return `Provider ${provider} is cooling down until ${cooldowns[provider]}`;
  if (locks.has(issueKey)) return `Issue ${issueKey} is already locked`;
  const maxConcurrency = Math.max(1, Number(settings?.data?.policy?.maxConcurrency) || 1);
  if (active.total >= maxConcurrency) return "Global worker capacity is full";
  const providerLimit = Math.max(
    1,
    Number(settings?.data?.policy?.providerConcurrency?.[provider]) || maxConcurrency
  );
  if ((active.byProvider[provider] || 0) >= providerLimit) {
    return `Provider ${provider} capacity is full`;
  }
  const collision = active.runs.find((candidate) =>
    scopesOverlap(candidate.payload?.allowedPaths || [], payload.allowedPaths)
  );
  return collision ? `Scope overlaps active run ${collision.id}` : null;
}

export function reconcileRetries(settings, store, options = {}) {
  const atMs = nowMs(options);
  const cooldowns = options.cooldowns || activeProviderCooldowns(store, { now: atMs });
  const active = activeSnapshot(store.listRunsDetailed(200));
  const locks = new Set(store.listLocks().map((lock) => lock.issue_key));
  const ready = [];
  const deferred = [];
  const blocked = [];
  let queued = 0;

  for (const run of store.listRunsDetailed(200)) {
    if (!["retry_requested", "retry-ready"].includes(run.state)) continue;
    const invalid = validateRetryRequest(store, run, settings);
    if (invalid) {
      if (compareAndSet(store, run.id, run.state, "retry-blocked", { reason: invalid }, atMs)) {
        blocked.push({ runId: run.id, issueKey: run.issue_key, reason: invalid });
      }
      continue;
    }

    const waitReason = retryDeferral(run.issue_key, run.payload, active, cooldowns, locks, settings);
    if (waitReason) {
      deferred.push({ runId: run.id, issueKey: run.issue_key, reason: waitReason });
      continue;
    }

    if (run.state === "retry_requested") {
      const moved = compareAndSet(
        store,
        run.id,
        "retry_requested",
        "retry-ready",
        {
          retryOfRunId: run.payload.retryOfRunId,
          attempt: run.payload.attempt,
          provider: run.payload.execution.provider
        },
        atMs
      );
      if (!moved) continue;
      queued += 1;
    }
    ready.push({
      runId: run.id,
      issueKey: run.issue_key,
      retryOfRunId: run.payload.retryOfRunId,
      attempt: run.payload.attempt,
      plan: retryPlan(run.payload)
    });
  }
  return { queued, ready, deferred, blocked };
}

export function claimRetryRequest(store, runId, options = {}) {
  const atMs = nowMs(options);
  const run = store.getRun(runId);
  return compareAndSet(
    store,
    runId,
    "retry-ready",
    "retry-dispatching",
    {
      retryOfRunId: run.payload.retryOfRunId,
      attempt: run.payload.attempt,
      claimedAt: new Date(atMs).toISOString()
    },
    atMs
  );
}

export function blockRetryRequest(store, runId, reason, options = {}) {
  const run = store.getRun(runId);
  if (!["retry_requested", "retry-ready"].includes(run.state)) return false;
  return compareAndSet(
    store,
    runId,
    run.state,
    "retry-blocked",
    { reason: String(reason || "Retry could not be dispatched safely") },
    nowMs(options)
  );
}

export function finishRetryRequest(store, runId, outcome, options = {}) {
  const succeeded = Number(outcome?.exitCode) === 0;
  const state = succeeded ? "retry-dispatched" : "retry-dispatch-failed";
  const recorded = compareAndSet(
    store,
    runId,
    "retry-dispatching",
    state,
    {
      childRunId: outcome?.runId || null,
      exitCode: Number(outcome?.exitCode) || 0,
      reason: outcome?.reason || null
    },
    nowMs(options)
  );
  return { recorded, state: recorded ? state : null };
}

export function tick(settings, store, options = {}) {
  const atMs = nowMs(options);
  const workers = reconcileWorkers(settings, store, { ...options, now: atMs });
  const reviewers = reconcileReviewers(settings, store, { ...options, now: atMs });
  const integrations = reconcileIntegrations(settings, store, options);
  const standalone = reconcileStandaloneReviews(settings, store, options);
  const cooldowns = activeProviderCooldowns(store, { now: atMs });
  const retries = reconcileRetries(settings, store, { ...options, now: atMs, cooldowns });

  const parents = [];
  if (typeof store.listParentExecutions === "function") {
    const parentExecutions = store.listParentExecutions(50) || [];
    for (const parent of parentExecutions) {
      if (["active", "integration-review-queued"].includes(parent.state)) {
        const pRes = reconcileParentExecution(settings, store, parent.parentKey, options);
        if (pRes && typeof pRes.then === "function") {
          if (options.promises) options.promises.push(pRes);
        }
        parents.push({ parentKey: parent.parentKey, state: parent.state });
      }
    }
  }

  return {
    reconciled: true,
    promises: options.promises || [],
    workers,
    reviewers,
    integrations,
    standalone,
    cooldowns,
    retries,
    parents
  };
}
