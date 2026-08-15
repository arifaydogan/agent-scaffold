import path from "node:path";
import { getStore } from "./runtime.js";
import {
  computePlanFingerprint,
  computeIntegrationFingerprint,
  resolveOperatingMode,
  resolveAutonomyPolicy,
  isActionAutonomous,
  HUMAN_ONLY_ACTIONS
} from "./policy.js";
import { CANONICAL_WORKFLOW_STATES } from "./workflow.js";

/**
 * 8 Canonical PM Operational Categories
 */
export const PM_OPERATIONAL_GROUPS = Object.freeze([
  "needsPlanning",
  "awaitingApproval",
  "ready",
  "executing",
  "inReview",
  "needsRework",
  "blocked",
  "humanApproval"
]);

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

const REVIEW_STATES = new Set([
  "verifying",
  "review-queued",
  "review_queued",
  "reviewing"
]);

const REWORK_STATES = new Set([
  "review-failed",
  "review_fix_queued",
  "rework",
  "retry_requested"
]);

const HUMAN_APPROVAL_STATES = new Set([
  "reviewed-clean",
  "accepted",
  "human_approval"
]);

const BLOCKED_STATES = new Set([
  "blocked",
  "human_action_required",
  "failed-scope",
  "failed-retryable",
  "failed"
]);

function extractBlockers(run) {
  const latest = run.latest_payload || (Array.isArray(run.events) ? run.events.at(-1)?.payload : {}) || {};
  const result = latest.result || {};
  const scope = latest.scope || {};
  const state = String(run.state || "").toLowerCase();
  const isFailureOrBlockedState = BLOCKED_STATES.has(state) || state === "ineligible";

  const blockers = [
    ...(Array.isArray(result.blockers) ? result.blockers : []),
    ...(Array.isArray(scope.reasons) ? scope.reasons : []),
    ...(Array.isArray(scope.violations) ? scope.violations.map(v => `Scope violation: ${v}`) : []),
    ...(isFailureOrBlockedState && Array.isArray(latest.reasons) ? latest.reasons : []),
    ...(isFailureOrBlockedState && latest.reason ? [latest.reason] : [])
  ];
  return [...new Set(blockers.filter(Boolean))];
}

export function determineItemAction(run, settings, store) {
  const plan = run.payload || {};
  const state = String(run.state || "").toLowerCase();
  const canonicalState = String(plan.canonicalState || run.canonicalState || "").toLowerCase();
  const role = String(plan.role || "").toLowerCase();
  const type = String(plan.type || run.type || "").toLowerCase();

  if (plan.action) return plan.action;
  if (role === "reviewer" || type === "review" || REVIEW_STATES.has(state) || canonicalState === "review") {
    return "review";
  }
  if (role === "rework" || type === "rework" || REWORK_STATES.has(state) || canonicalState === "rework") {
    return "rework";
  }
  if (role === "integration" || role === "childintegration" || plan.action === "childIntegration" || type === "integration") {
    return "childIntegration";
  }
  return "implementation";
}

export function determineItemAttempt(run) {
  const plan = run.payload || {};
  const action = determineItemAction(run);
  if (action === "rework") {
    return Number(plan.attempt ?? plan.reworkAttempt ?? run.attempt ?? (Array.isArray(run.events) ? run.events.filter(e => e.state === "review-failed").length : 1));
  }
  return Number(plan.attempt || 0);
}

export function checkApprovalNeeded(run, settings, store) {
  const plan = run.payload || {};
  const action = determineItemAction(run, settings, store);
  const attempt = determineItemAttempt(run);
  const fingerprint = computePlanFingerprint(plan);

  if (HUMAN_ONLY_ACTIONS.includes(action)) {
    return { needed: true, approved: false, action, attempt, fingerprint, reason: `Action "${action}" is human-only` };
  }

  const snapshot = plan.configSnapshot || {};
  const effectiveSettings = snapshot.operatingMode
    ? {
        ...settings,
        data: {
          ...settings?.data,
          project: { ...settings?.data?.project, operatingMode: snapshot.operatingMode },
          policy: { ...settings?.data?.policy, operatingMode: snapshot.operatingMode, autonomy: snapshot.autonomy }
        }
      }
    : settings;

  const isAuto = isActionAutonomous(effectiveSettings, action);
  const approvalDecision = store.hasExecutionApproval(run.issue_key, {
    action,
    plan,
    planFingerprint: fingerprint,
    attempt
  });

  if (approvalDecision && approvalDecision.approved) {
    return { needed: false, approved: true, action, attempt, fingerprint, decision: approvalDecision };
  }

  if (approvalDecision && !approvalDecision.approved) {
    return {
      needed: true,
      approved: false,
      rejected: true,
      action,
      attempt,
      fingerprint,
      reason: approvalDecision.reason || "Action was rejected by PM"
    };
  }

  if (!isAuto) {
    return {
      needed: true,
      approved: false,
      action,
      attempt,
      fingerprint,
      reason: `Action "${action}" requires human approval under '${resolveOperatingMode(effectiveSettings)}' mode`
    };
  }

  return { needed: false, approved: false, action, attempt, fingerprint };
}

/**
 * Classify a work item/run into exactly one of the 8 canonical PM operational states.
 */
export function classifyOperationalGroup(run, settings, store) {
  const state = String(run.state || "").toLowerCase();
  const plan = run.payload || {};
  const canonicalState = String(plan.canonicalState || run.canonicalState || "").toLowerCase();
  const blockers = extractBlockers(run);
  const approvalCheck = checkApprovalNeeded(run, settings, store);

  // 1. Human Approval Gate (Final merge / Done / deployment)
  // MUST NEVER appear as executable worker work!
  if (HUMAN_APPROVAL_STATES.has(state) || canonicalState === "human_approval") {
    return "humanApproval";
  }

  // 2. Blocked / Human Attention
  // If the run failed, has scope violations, or is blocked for non-approval reasons
  if (BLOCKED_STATES.has(state) || blockers.length > 0) {
    const isStrictlyAwaitingApproval =
      (state === "human_action_required" || state === "blocked") &&
      approvalCheck.needed &&
      !approvalCheck.rejected &&
      blockers.every(b => String(b).toLowerCase().includes("approval") || String(b).toLowerCase().includes("supervised") || String(b).toLowerCase().includes("manual"));

    if (!isStrictlyAwaitingApproval) {
      return "blocked";
    }
  }

  // 3. Executing (Running worker)
  if (ACTIVE_WORKER_STATES.has(state)) {
    return "executing";
  }

  // 4. In Review
  if (REVIEW_STATES.has(state) || canonicalState === "review") {
    return "inReview";
  }

  // 5. Needs Rework
  if (REWORK_STATES.has(state) || canonicalState === "rework") {
    return "needsRework";
  }

  // 6. Awaiting Approval (Supervised / manual gate before execution or rework)
  if (approvalCheck.needed) {
    return "awaitingApproval";
  }

  // 7. Ready / Agent Ready (Autonomous or approved)
  if (["discovered", "eligible", "ready", "prepared"].includes(state) || canonicalState === "ready") {
    return "ready";
  }

  // 8. Needs Planning (Default for unstarted/unplanned work)
  return "needsPlanning";
}

function shapeWorkspaceItem(run, settings, store) {
  const plan = run.payload || {};
  const latest = run.latest_payload || {};
  const execution = plan.execution || {};
  const snapshot = plan.configSnapshot || {};
  const group = classifyOperationalGroup(run, settings, store);
  const blockers = extractBlockers(run);
  const approval = checkApprovalNeeded(run, settings, store);

  const taskAgent = snapshot.taskAgent || plan.taskAgent || execution.agent || plan.persona || "unassigned";
  const persona = snapshot.persona || plan.persona || taskAgent;
  const agentId = snapshot.agentId || plan.agentId || taskAgent;
  const agentVersion = snapshot.agentVersion ?? plan.agentVersion ?? (typeof plan.agent === "object" ? plan.agent.version : null) ?? null;
  const agentHash = snapshot.agentHash || plan.agentHash || null;

  // Live registry context
  const liveDef = agentId ? store.getAgentDefinition(agentId) : null;
  const agentLiveStatus = liveDef ? liveDef.status : "not_found";
  const agentLiveVersion = liveDef ? liveDef.version : null;
  const agentLiveHash = liveDef ? liveDef.definitionHash : null;
  const agentUpToDate = (liveDef && agentVersion != null) ? Number(liveDef.version) === Number(agentVersion) : true;

  const provider = latest.provider || snapshot.executorProvider || execution.provider || "unassigned";
  const model = latest.model || snapshot.executorModel || execution.model || null;
  const modelProfile = snapshot.executorModelProfile || execution.modelProfile || null;
  const risk = snapshot.risk || plan.risk || "normal";
  const reworkAttempt = determineItemAttempt(run);
  const maxReworkAttempts = Number(snapshot.maxReworkAttempts || settings.data?.policy?.review?.maxReworkAttempts || 3);
  const fingerprint = computePlanFingerprint(plan);

  let blockedReason = null;
  if (group === "blocked") {
    blockedReason = blockers.length > 0 ? blockers[0] : (latest.reason || run.state);
  }

  let approvalReason = null;
  if (group === "awaitingApproval") {
    approvalReason = approval.reason || "Action requires human authorization";
  }

  const humanActionRequired =
    group === "awaitingApproval" ||
    group === "blocked" ||
    group === "humanApproval" ||
    latest.humanActionRequired === true;

  let canonicalState = plan.canonicalState || null;
  if (!canonicalState) {
    const s = String(run.state || "").toLowerCase();
    if (HUMAN_APPROVAL_STATES.has(s) || group === "humanApproval") canonicalState = "human_approval";
    else if (REVIEW_STATES.has(s) || group === "inReview") canonicalState = "review";
    else if (REWORK_STATES.has(s) || group === "needsRework") canonicalState = "rework";
    else if (ACTIVE_WORKER_STATES.has(s) || group === "executing") canonicalState = "executing";
    else if (BLOCKED_STATES.has(s) || group === "blocked") canonicalState = "blocked";
    else if (["discovered", "eligible", "ready", "prepared"].includes(s) || group === "ready") canonicalState = "ready";
    else canonicalState = s || "unknown";
  }

  const planWorkSource = plan.workSource || snapshot.workSource || {};
  const sourceProvider = planWorkSource.provider || plan.sourceProvider || snapshot.sourceProvider || settings.data?.workSource?.defaultProvider || "jira";
  let sourceUrl = planWorkSource.url || plan.sourceUrl || null;
  if (!sourceUrl) {
    const jiraBase = settings.data?.jira?.baseUrl ||
      settings.data?.workSource?.providers?.jira?.baseUrl ||
      settings.data?.workSource?.providers?.[sourceProvider]?.baseUrl ||
      settings.data?.workSource?.baseUrl;
    sourceUrl = jiraBase ? `${jiraBase.replace(/\/+$/, '')}/browse/${run.issue_key}` : null;
  }

  return {
    issueKey: run.issue_key,
    summary: plan.summary || run.issue_key,
    canonicalState,
    currentRunState: run.state,
    operationalGroup: group,
    operatingMode: snapshot.operatingMode || resolveOperatingMode(settings),
    persona,
    taskAgent,
    agentId,
    agentVersion,
    agentHash,
    agentLiveStatus,
    agentLiveVersion,
    agentLiveHash,
    agentUpToDate,
    executorProvider: provider,
    executorModel: model,
    executorModelProfile: modelProfile,
    risk,
    reworkAttempt,
    maxReworkAttempts,
    humanActionRequired,
    action: approval.action || determineItemAction(run, settings, store),
    blockedReason,
    approvalReason,
    planFingerprint: fingerprint,
    allowedPaths: snapshot.allowedPaths || plan.allowedPaths || [],
    rationale: snapshot.rationale || (Array.isArray(plan.rationale) ? plan.rationale : (Array.isArray(plan.reasons) ? plan.reasons : (plan.rationale ? [plan.rationale] : []))),
    sourceProvider,
    sourceUrl,
    runId: run.id,
    createdAt: run.created_at,
    updatedAt: run.updated_at
  };
}

/**
 * Builds the complete PM Workspace aggregation read model.
 * Endpoint: GET /api/pm/workspace
 */
export function buildPmWorkspace(settings, options = {}) {
  const store = options.store || getStore(settings);
  const detailedRuns = store.listRunsDetailed(options.limit || 150);

  // Group latest run per issue_key
  const seenIssues = new Set();
  const uniqueRuns = [];
  for (const r of detailedRuns) {
    if (!seenIssues.has(r.issue_key)) {
      seenIssues.add(r.issue_key);
      uniqueRuns.push(r);
    }
  }

  const items = uniqueRuns.map((run) => shapeWorkspaceItem(run, settings, store));

  // Include discovered work items without active runs in needsPlanning
  const discovered = typeof store.listDiscoveredWorkItems === "function" ? store.listDiscoveredWorkItems() : [];
  for (const disc of discovered) {
    if (!seenIssues.has(disc.issueKey)) {
      seenIssues.add(disc.issueKey);
      items.push({
        issueKey: disc.issueKey,
        summary: disc.summary || disc.issueKey,
        canonicalState: "needs_planning",
        currentRunState: "unplanned",
        operationalGroup: "needsPlanning",
        operatingMode: resolveOperatingMode(settings),
        persona: "unassigned",
        taskAgent: "unassigned",
        agentId: null,
        agentVersion: null,
        agentHash: null,
        agentLiveStatus: "unknown",
        agentLiveVersion: null,
        agentLiveHash: null,
        agentUpToDate: true,
        executorProvider: "unassigned",
        executorModel: null,
        executorModelProfile: null,
        risk: "unknown",
        reworkAttempt: 0,
        maxReworkAttempts: 3,
        humanActionRequired: false,
        action: "planning",
        blockedReason: null,
        approvalReason: null,
        planFingerprint: null,
        allowedPaths: [],
        rationale: ["Discovered work item; awaiting orchestrator planning."],
        sourceProvider: disc.sourceProvider,
        sourceUrl: disc.sourceUrl,
        runId: null,
        createdAt: disc.discoveredAt,
        updatedAt: disc.updatedAt
      });
    }
  }

  const groups = {
    needsPlanning: items.filter((i) => i.operationalGroup === "needsPlanning"),
    awaitingApproval: items.filter((i) => i.operationalGroup === "awaitingApproval"),
    ready: items.filter((i) => i.operationalGroup === "ready"),
    executing: items.filter((i) => i.operationalGroup === "executing"),
    inReview: items.filter((i) => i.operationalGroup === "inReview"),
    needsRework: items.filter((i) => i.operationalGroup === "needsRework"),
    blocked: items.filter((i) => i.operationalGroup === "blocked"),
    humanApproval: items.filter((i) => i.operationalGroup === "humanApproval")
  };

  const counts = {
    needsPlanning: groups.needsPlanning.length,
    awaitingApproval: groups.awaitingApproval.length,
    ready: groups.ready.length,
    executing: groups.executing.length,
    inReview: groups.inReview.length,
    needsRework: groups.needsRework.length,
    blocked: groups.blocked.length,
    humanApproval: groups.humanApproval.length,
    needsAttention: groups.awaitingApproval.length + groups.blocked.length + groups.needsRework.length,
    total: items.length
  };

  return {
    ok: true,
    project: settings.projectKey,
    generatedAt: options.now || new Date().toISOString(),
    counts,
    groups,
    items
  };
}

/**
 * Extracts lossless review findings from historical events across runs for an issue.
 * Supports canonical Phase A recordReviewerOutcome shape: event.payload.reviewOutcome
 */
function extractReviewCycles(runsWithEvents) {
  const cycles = [];
  let attemptCounter = 1;

  for (const run of runsWithEvents) {
    const events = run.events || [];
    for (const ev of events) {
      if (ev.state === "reviewed-clean" || ev.state === "review-failed") {
        const payload = ev.payload || {};
        const outcome = payload.reviewOutcome || payload;
        const rawEvidence = Array.isArray(outcome.evidence) ? outcome.evidence : (Array.isArray(payload.evidence) ? payload.evidence : []);

        const structuredFindings = rawEvidence.map((item) => {
          if (!item || typeof item !== "object") {
            return {
              id: null,
              severity: null,
              category: null,
              file: null,
              line: null,
              problem: String(item),
              expected: null,
              verification: null
            };
          }
          return {
            id: item.id != null ? String(item.id) : null,
            severity: item.severity != null ? String(item.severity) : null,
            category: item.category != null ? String(item.category) : null,
            file: item.file != null ? String(item.file) : null,
            line: item.line != null ? Number(item.line) : null,
            problem: item.problem != null ? String(item.problem) : null,
            expected: item.expected != null ? String(item.expected) : null,
            verification: item.verification != null ? String(item.verification) : null
          };
        });

        cycles.push({
          attempt: attemptCounter++,
          runId: run.id,
          state: ev.state,
          verdict: outcome.verdict || (ev.state === "reviewed-clean" ? "clean" : "changes-requested"),
          reviewerId: outcome.reviewerId || payload.reviewerId || "reviewer",
          implementationSha: outcome.implementationSha || payload.implementationSha || null,
          reviewedAt: outcome.reviewedAt || payload.reviewedAt || ev.created_at,
          findingsCount: structuredFindings.length,
          findings: structuredFindings
        });
      }
    }
  }

  return cycles;
}

/**
 * Synthesizes chronological audit timeline with actor attribution.
 */
function buildAuditTimeline(runsWithEvents, pmDecisions, supervisorEvents = []) {
  const timeline = [];

  for (const decision of pmDecisions) {
    const p = decision.payload || {};
    let label = `PM Decision: ${decision.type}`;
    let stage = decision.type;
    let actorType = "human";

    if (decision.type === "execution_approval") {
      stage = p.approved ? "implementation_approved" : "implementation_rejected";
      label = p.approved
        ? `Action "${p.action || 'implementation'}" approved by ${p.approver || 'human'}`
        : `Action "${p.action || 'implementation'}" rejected by ${p.approver || 'human'}: ${p.reason || 'No reason'}`;
      actorType = "human";
    } else if (decision.type.startsWith("agent-")) {
      label = `Agent Registry: ${decision.type} (${p.agentId || ''})`;
      actorType = "human";
    }

    timeline.push({
      id: `pm-dec-${decision.id || Math.random()}`,
      timestamp: decision.createdAt || decision.created_at,
      stage,
      label,
      actor: { type: actorType, id: p.approver || "PM" },
      details: p
    });
  }

  for (const run of runsWithEvents) {
    const events = run.events || [];
    for (const ev of events) {
      const p = ev.payload || {};
      let stage = ev.state;
      let label = `Run transition to ${ev.state}`;
      let actor = { type: "task_agent", id: run.payload?.taskAgent || "agent" };

      if (ev.state === "discovered") {
        stage = "discovered";
        label = `Work item discovered (${run.payload?.persona || 'orchestrator'})`;
        actor = { type: "orchestrator", id: run.payload?.persona || "orchestrator" };
      } else if (ev.state === "prepared" || ev.state === "claimed") {
        stage = "preparation";
        label = `Workspace & worktree prepared on branch ${p.branch || 'main'}`;
        actor = { type: "runtime", id: "worktree-manager" };
      } else if (ev.state === "executing") {
        stage = "execution";
        label = `Worker executing with ${p.provider || 'executor'} · ${p.model || 'model'}`;
        actor = { type: "task_agent", id: run.payload?.taskAgent || "worker" };
      } else if (ev.state === "verifying" || ev.state === "review-queued") {
        stage = "review_queued";
        label = `Review queued for implementation ${p.implementationSha ? p.implementationSha.substring(0, 7) : ''}`;
        actor = { type: "runtime", id: "reconciler" };
      } else if (ev.state === "reviewed-clean") {
        const out = p.reviewOutcome || p;
        stage = "review_clean";
        label = `Review clean by ${out.reviewerId || 'reviewer'}`;
        actor = { type: "reviewer", id: out.reviewerId || "reviewer" };
      } else if (ev.state === "review-failed") {
        const out = p.reviewOutcome || p;
        stage = "review_failed";
        label = `Review changes requested (${out.evidence?.length || 0} findings) by ${out.reviewerId || 'reviewer'}`;
        actor = { type: "reviewer", id: out.reviewerId || "reviewer" };
      } else if (ev.state === "failed" || ev.state === "failed-scope" || ev.state === "blocked") {
        stage = "blocked";
        label = `Blocked / Human attention: ${p.reason || 'Action required'}`;
        actor = { type: "runtime", id: "policy-gate" };
      }

      timeline.push({
        id: `ev-${run.id}-${ev.state}-${ev.created_at}`,
        timestamp: ev.created_at,
        stage,
        label,
        actor,
        details: p
      });
    }
  }

  return timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

/**
 * Builds the complete Decision Trace read model for a single work item.
 * Endpoint: GET /api/pm/work-items/:key
 */
export function buildPmWorkItemDetail(settings, issueKey, options = {}) {
  const store = options.store || getStore(settings);
  const targetKey = String(issueKey || "").trim();

  // Query all runs for this issue key
  const runRows = store.database.prepare(
    "SELECT * FROM runs WHERE issue_key = ? ORDER BY created_at ASC"
  ).all(targetKey);

  if (runRows.length === 0) {
    // Check discovered work items
    const disc = typeof store.getDiscoveredWorkItem === "function" ? store.getDiscoveredWorkItem(targetKey) : null;
    if (disc) {
      return {
        ok: true,
        workItem: {
          key: disc.issueKey,
          id: null,
          summary: disc.summary,
          sourceProvider: disc.sourceProvider,
          sourceId: disc.issueKey,
          sourceUrl: disc.sourceUrl,
          canonicalState: "needs_planning",
          status: "unplanned",
          operationalGroup: "needsPlanning",
          labels: []
        },
        orchestratorDecision: {
          orchestratorProvider: "unassigned",
          persona: "unassigned",
          taskAgent: "unassigned",
          skills: [],
          capabilities: [],
          risk: "unknown",
          parallelSafe: true,
          dependencies: [],
          allowedPaths: [],
          rationale: ["Work item is discovered in backlog; awaiting orchestrator planning run."],
          stableMetadata: {},
          planFingerprint: null
        },
        agentIdentity: {
          agentId: null,
          agentVersion: null,
          agentHash: null,
          liveRegistryStatus: "unknown",
          liveRegistryVersion: null,
          liveRegistryHash: null,
          isPinnedVersionCurrent: true
        },
        execution: {
          provider: "unassigned",
          model: null,
          modelProfile: null,
          effort: null,
          branch: null,
          worktree: null,
          commit: null,
          attempt: 0,
          maxAttempts: 0,
          workerPid: null,
          workerStatus: "unplanned",
          currentRunState: "unplanned",
          durationSeconds: 0,
          tokens: 0
        },
        review: {
          reviewerTaskAgent: null,
          reviewAgentVersion: null,
          reviewAgentHash: null,
          reviewProvider: null,
          reviewModel: null,
          reviewModelProfile: null,
          verdict: null,
          latestImplementationSha: null,
          structuredFindings: [],
          reviewCycles: []
        },
        humanControl: {
          currentRequiredHumanAction: null,
          humanActionRequired: false,
          operatingMode: resolveOperatingMode(settings),
          pendingAction: "planning",
          planFingerprint: null,
          approvalState: "not_required",
          approvalHistory: []
        },
        blockedInfo: {
          isBlocked: false,
          reason: null,
          originatingAction: "planning",
          taskAgent: "unassigned",
          reviewer: null,
          attempt: 0,
          lastSuccessfulStage: "discovered",
          canRetry: false,
          canApprove: false
        },
        history: [
          {
            id: `disc-${disc.issueKey}`,
            timestamp: disc.discoveredAt,
            stage: "discovered",
            label: `Discovered from ${disc.sourceProvider} work source`,
            actor: { type: "work-source", id: disc.sourceProvider },
            details: disc.raw
          }
        ]
      };
    }
    return null;
  }

  const runsWithEvents = runRows.map((row) => {
    const events = store.database.prepare(
      "SELECT state, payload, created_at FROM events WHERE run_id = ? ORDER BY id ASC"
    ).all(row.id).map(e => ({ ...e, payload: JSON.parse(e.payload) }));
    return {
      ...row,
      payload: JSON.parse(row.payload),
      events
    };
  });

  const latestRun = runsWithEvents.at(-1);
  const plan = latestRun.payload || {};
  const latestEvent = latestRun.events.at(-1) || {};
  const latestPayload = latestEvent.payload || {};
  const execution = plan.execution || {};
  const snapshot = plan.configSnapshot || {};
  const pmDecisions = store.getPmDecisions(targetKey);
  const reviewCycles = extractReviewCycles(runsWithEvents);
  const latestReviewCycle = reviewCycles.at(-1) || null;
  const timeline = buildAuditTimeline(runsWithEvents, pmDecisions);
  const group = classifyOperationalGroup(latestRun, settings, store);
  const approvalCheck = checkApprovalNeeded(latestRun, settings, store);
  const blockers = extractBlockers(latestRun);

  // Pinned Agent vs Live Registry
  const taskAgent = snapshot.taskAgent || plan.taskAgent || execution.agent || plan.persona || "unassigned";
  const persona = snapshot.persona || plan.persona || taskAgent;
  const agentId = snapshot.agentId || plan.agentId || taskAgent;
  const agentVersion = snapshot.agentVersion ?? plan.agentVersion ?? (typeof plan.agent === "object" ? plan.agent.version : null) ?? null;
  const agentHash = snapshot.agentHash || plan.agentHash || null;

  const liveDef = agentId ? store.getAgentDefinition(agentId) : null;
  const liveRegistryStatus = liveDef ? liveDef.status : "not_found";
  const liveRegistryVersion = liveDef ? liveDef.version : null;
  const liveRegistryHash = liveDef ? liveDef.definitionHash : null;
  const isPinnedVersionCurrent = (liveDef && agentVersion != null) ? Number(liveDef.version) === Number(agentVersion) : true;

  // Review findings losslessly preserved
  const structuredFindings = latestReviewCycle?.findings || [];

  // Blocked Diagnostics
  const isBlocked = group === "blocked" || BLOCKED_STATES.has(latestRun.state);
  const blockedReason = isBlocked ? (blockers[0] || latestPayload.reason || latestRun.state) : null;
  const canRetry = isBlocked && ["failed-retryable", "failed"].includes(latestRun.state);
  const canApprove = approvalCheck.needed;

  // Work item source info: pinned/local plan workSource first
  const planWorkSource = plan.workSource || snapshot.workSource || {};
  const sourceProvider = planWorkSource.provider ||
    plan.sourceProvider ||
    snapshot.sourceProvider ||
    settings.data?.workSource?.defaultProvider ||
    "jira";
  const sourceId = planWorkSource.id ||
    planWorkSource.key ||
    plan.sourceId ||
    targetKey;

  let sourceUrl = planWorkSource.url || plan.sourceUrl || null;
  if (!sourceUrl) {
    const jiraBase = settings.data?.jira?.baseUrl ||
      settings.data?.workSource?.providers?.jira?.baseUrl ||
      settings.data?.workSource?.providers?.[sourceProvider]?.baseUrl ||
      settings.data?.workSource?.baseUrl;
    sourceUrl = jiraBase ? `${jiraBase.replace(/\/+$/, '')}/browse/${targetKey}` : null;
  }

  let canonicalState = plan.canonicalState || null;
  if (!canonicalState) {
    const s = String(latestRun.state || "").toLowerCase();
    if (HUMAN_APPROVAL_STATES.has(s) || group === "humanApproval") canonicalState = "human_approval";
    else if (REVIEW_STATES.has(s) || group === "inReview") canonicalState = "review";
    else if (REWORK_STATES.has(s) || group === "needsRework") canonicalState = "rework";
    else if (ACTIVE_WORKER_STATES.has(s) || group === "executing") canonicalState = "executing";
    else if (BLOCKED_STATES.has(s) || group === "blocked") canonicalState = "blocked";
    else if (["discovered", "eligible", "ready", "prepared"].includes(s) || group === "ready") canonicalState = "ready";
    else canonicalState = s || "unknown";
  }

  return {
    ok: true,
    workItem: {
      key: targetKey,
      id: latestRun.id,
      summary: plan.summary || targetKey,
      sourceProvider,
      sourceId,
      sourceUrl,
      canonicalState,
      status: latestRun.state,
      operationalGroup: group,
      labels: Array.isArray(plan.labels) ? plan.labels : (settings.data?.policy?.requiredLabels || [])
    },
    orchestratorDecision: {
      orchestratorProvider: snapshot.orchestratorProvider || plan.orchestratorProvider || settings.data?.orchestrator?.defaultProvider || "builtin",
      persona,
      taskAgent,
      skills: snapshot.skills || plan.skills || [],
      capabilities: snapshot.capabilities || plan.capabilities || [],
      risk: snapshot.risk || plan.risk || "normal",
      parallelSafe: snapshot.parallelSafe ?? plan.parallelSafe ?? true,
      dependencies: snapshot.dependencies || plan.dependencies || [],
      allowedPaths: snapshot.allowedPaths || plan.allowedPaths || [],
      rationale: snapshot.rationale || (Array.isArray(plan.rationale) ? plan.rationale : (Array.isArray(plan.reasons) ? plan.reasons : (plan.rationale ? [plan.rationale] : []))),
      stableMetadata: snapshot.metadata || plan.metadata || {},
      planFingerprint: computePlanFingerprint(plan)
    },
    agentIdentity: {
      agentId,
      agentVersion,
      agentHash,
      liveRegistryStatus,
      liveRegistryVersion,
      liveRegistryHash,
      isPinnedVersionCurrent
    },
    execution: {
      provider: latestPayload.provider || snapshot.executorProvider || execution.provider || "unassigned",
      model: latestPayload.model || snapshot.executorModel || execution.model || null,
      modelProfile: snapshot.executorModelProfile || execution.modelProfile || null,
      effort: snapshot.executorEffort || execution.effort || null,
      currentRunState: latestRun.state,
      attempt: determineItemAttempt(latestRun),
      maxAttempts: Number(settings.data?.policy?.maxAttempts || 3),
      workerPid: latestPayload.pid ?? null,
      workerStatus: ACTIVE_WORKER_STATES.has(latestRun.state) ? "running" : "finished",
      tokens: latestPayload.usage?.total_tokens || 0,
      durationSeconds: Math.round((new Date(latestRun.updated_at).getTime() - new Date(latestRun.created_at).getTime()) / 1000),
      branch: plan.branch || null,
      worktree: plan.worktree || null,
      commit: latestPayload.commit || null
    },
    review: {
      reviewerTaskAgent: snapshot.reviewTaskAgent || plan.reviewTaskAgent || latestReviewCycle?.reviewerId || null,
      reviewAgentVersion: snapshot.reviewAgentVersion ?? plan.reviewAgentVersion ?? null,
      reviewAgentHash: snapshot.reviewAgentHash || plan.reviewAgentHash || null,
      reviewProvider: snapshot.reviewProvider || settings.data?.policy?.review?.provider || null,
      reviewModel: snapshot.reviewModel || null,
      reviewModelProfile: snapshot.reviewModelProfile || settings.data?.policy?.review?.modelProfile || null,
      verdict: latestReviewCycle?.verdict || null,
      latestImplementationSha: latestReviewCycle?.implementationSha || null,
      structuredFindings,
      reviewCycles
    },
    humanControl: {
      currentRequiredHumanAction: approvalCheck.needed
        ? (approvalCheck.rejected ? "approval_rejected" : "approval_needed")
        : (group === "humanApproval" ? "human_approval_gate" : (isBlocked ? "investigation_needed" : null)),
      humanActionRequired: approvalCheck.needed || isBlocked || group === "humanApproval",
      operatingMode: snapshot.operatingMode || resolveOperatingMode(settings),
      pendingAction: approvalCheck.action || "implementation",
      planFingerprint: computePlanFingerprint(plan),
      approvalState: approvalCheck.approved ? "approved" : (approvalCheck.rejected ? "rejected" : (approvalCheck.needed ? "pending" : "not_required")),
      approvalHistory: pmDecisions.filter(d => d.type === "execution_approval")
    },
    blockedInfo: {
      isBlocked,
      reason: blockedReason,
      originatingAction: determineItemAction(latestRun, settings, store),
      taskAgent,
      reviewer: latestReviewCycle?.reviewerId || null,
      attempt: determineItemAttempt(latestRun),
      lastSuccessfulStage: runsWithEvents[0]?.state || "discovered",
      canRetry,
      canApprove
    },
    history: timeline
  };
}

/**
 * Handles PM Approval mutation with plan fingerprint concurrency protection.
 * Server-authoritative for action and attempt.
 */
export function handlePmApproval(settings, issueKey, {
  action = "implementation",
  planFingerprint,
  attempt = 0,
  approver = "pm-user",
  reason = null
} = {}, options = {}) {
  const store = options.store || getStore(settings);
  const targetKey = String(issueKey || "").trim();

  if (HUMAN_ONLY_ACTIONS.includes(action)) {
    throw new Error(`Action "${action}" is human-only and cannot be approved through PM execution gates.`);
  }

  // Get latest run to verify fingerprint
  const runRow = store.database.prepare(
    "SELECT * FROM runs WHERE issue_key = ? ORDER BY created_at DESC LIMIT 1"
  ).get(targetKey);

  if (!runRow) {
    const error = new Error(`Work item "${targetKey}" not found`);
    error.statusCode = 404;
    throw error;
  }

  const events = store.database.prepare(
    "SELECT state, payload, created_at FROM events WHERE run_id = ? ORDER BY id ASC"
  ).all(runRow.id).map(e => ({ ...e, payload: JSON.parse(e.payload) }));

  const latestRun = {
    ...runRow,
    payload: JSON.parse(runRow.payload),
    events
  };

  const plan = latestRun.payload || {};
  const currentFingerprint = computePlanFingerprint(plan);

  if (!planFingerprint || typeof planFingerprint !== "string") {
    const error = new Error("Approval mutation requires an expected 'planFingerprint'");
    error.statusCode = 400;
    throw error;
  }

  if (currentFingerprint !== planFingerprint) {
    const error = new Error(`Plan fingerprint mismatch (expected: ${currentFingerprint}, received: ${planFingerprint}). The plan has changed; refresh the workspace.`);
    error.statusCode = 409;
    error.currentFingerprint = currentFingerprint;
    throw error;
  }

  // Derive server-side approval state using durable policy logic
  const approvalCheck = checkApprovalNeeded(latestRun, settings, store);
  const pendingAction = approvalCheck.action;
  const pendingAttempt = approvalCheck.attempt;

  if (action && action !== pendingAction) {
    const error = new Error(`Action mismatch (expected pending action: "${pendingAction}", received: "${action}"). The action has transitioned or is not pending approval.`);
    error.statusCode = 409;
    error.expectedAction = pendingAction;
    throw error;
  }

  if (attempt !== undefined && attempt !== null) {
    const numericAttempt = Number(attempt);
    if (numericAttempt !== pendingAttempt) {
      const error = new Error(`Attempt mismatch (expected attempt: ${pendingAttempt}, received: ${numericAttempt}).`);
      error.statusCode = 409;
      error.expectedAttempt = pendingAttempt;
      throw error;
    }
  }

  // Reject duplicate/stale approvals
  if (approvalCheck.approved) {
    const error = new Error(`Action "${pendingAction}" is already approved; no approval pending.`);
    error.statusCode = 409;
    throw error;
  }

  // Ensure the action is actually awaiting approval under the active operating mode
  if (!approvalCheck.needed) {
    const error = new Error(`Action "${pendingAction}" does not require approval; no approval pending.`);
    error.statusCode = 409;
    throw error;
  }

  const decision = store.recordApprovalDecision(targetKey, {
    action: pendingAction,
    approved: true,
    approver,
    plan,
    planFingerprint: currentFingerprint,
    attempt: pendingAttempt,
    reason: reason || "Approved in PM Workspace"
  });

  return {
    ok: true,
    approved: true,
    issueKey: targetKey,
    action: pendingAction,
    attempt: pendingAttempt,
    planFingerprint: currentFingerprint,
    decision
  };
}

/**
 * Handles PM Rejection mutation with plan fingerprint concurrency protection.
 * Server-authoritative for action and attempt.
 */
export function handlePmRejection(settings, issueKey, {
  action = "implementation",
  planFingerprint,
  attempt = 0,
  approver = "pm-user",
  reason = "Rejected in PM Workspace"
} = {}, options = {}) {
  const store = options.store || getStore(settings);
  const targetKey = String(issueKey || "").trim();

  // Get latest run to verify fingerprint
  const runRow = store.database.prepare(
    "SELECT * FROM runs WHERE issue_key = ? ORDER BY created_at DESC LIMIT 1"
  ).get(targetKey);

  if (!runRow) {
    const error = new Error(`Work item "${targetKey}" not found`);
    error.statusCode = 404;
    throw error;
  }

  const events = store.database.prepare(
    "SELECT state, payload, created_at FROM events WHERE run_id = ? ORDER BY id ASC"
  ).all(runRow.id).map(e => ({ ...e, payload: JSON.parse(e.payload) }));

  const latestRun = {
    ...runRow,
    payload: JSON.parse(runRow.payload),
    events
  };

  const plan = latestRun.payload || {};
  const currentFingerprint = computePlanFingerprint(plan);

  if (!planFingerprint || typeof planFingerprint !== "string") {
    const error = new Error("Rejection mutation requires an expected 'planFingerprint'");
    error.statusCode = 400;
    throw error;
  }

  if (currentFingerprint !== planFingerprint) {
    const error = new Error(`Plan fingerprint mismatch (expected: ${currentFingerprint}, received: ${planFingerprint}). The plan has changed; refresh the workspace.`);
    error.statusCode = 409;
    error.currentFingerprint = currentFingerprint;
    throw error;
  }

  // Derive server-side approval state using durable policy logic
  const approvalCheck = checkApprovalNeeded(latestRun, settings, store);
  const pendingAction = approvalCheck.action;
  const pendingAttempt = approvalCheck.attempt;

  if (action && action !== pendingAction) {
    const error = new Error(`Action mismatch (expected pending action: "${pendingAction}", received: "${action}"). The action has transitioned or is not pending approval.`);
    error.statusCode = 409;
    error.expectedAction = pendingAction;
    throw error;
  }

  if (attempt !== undefined && attempt !== null) {
    const numericAttempt = Number(attempt);
    if (numericAttempt !== pendingAttempt) {
      const error = new Error(`Attempt mismatch (expected attempt: ${pendingAttempt}, received: ${numericAttempt}).`);
      error.statusCode = 409;
      error.expectedAttempt = pendingAttempt;
      throw error;
    }
  }

  // Reject duplicate/stale rejections
  if (approvalCheck.rejected) {
    const error = new Error(`Action "${pendingAction}" is already rejected; no approval pending.`);
    error.statusCode = 409;
    throw error;
  }

  // Ensure the action is actually awaiting approval
  if (!approvalCheck.needed) {
    const error = new Error(`Action "${pendingAction}" does not require approval; no approval pending.`);
    error.statusCode = 409;
    throw error;
  }

  const decision = store.recordApprovalDecision(targetKey, {
    action: pendingAction,
    approved: false,
    approver,
    plan,
    planFingerprint: currentFingerprint,
    attempt: pendingAttempt,
    reason: reason || "Rejected in PM Workspace"
  });

  return {
    ok: true,
    approved: false,
    issueKey: targetKey,
    action: pendingAction,
    attempt: pendingAttempt,
    planFingerprint: currentFingerprint,
    reason,
    decision
  };
}
