import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import {
  buildHierarchyDag,
  computeGraphFingerprint,
  detectHierarchyDrift
} from "./dag.js";
import {
  createSourceControlProvider,
  selectedSourceControlProviderName
} from "./source-control.js";
import {
  createWorkSourceProvider,
  selectedWorkSourceProviderName
} from "./work-source.js";
import {
  collectReviewIntelligence,
  formatReviewIntelligencePromptSection,
  createCodeIntelligenceProvider
} from "./code-intelligence.js";
import {
  buildExecutorCommand,
  parseExecutionOutput,
  selectReviewProfile
} from "./executor.js";
import {
  authorizeRuntimeAction,
  resolveOperatingMode,
  resolveAutonomyPolicy,
  computeParentBranchFingerprint,
  computeParentReviewFingerprint
} from "./policy.js";
import {
  ALLOWED_FINDING_SEVERITIES,
  ALLOWED_FINDING_CATEGORIES,
  safeWorkSourceMutate
} from "./reconciler.js";
import { normalizeUsage, redactTelemetryPayload } from "./telemetry.js";

const REVIEW_SHA_REGEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

/**
 * Ensure a durable parent run exists in SQLite runs table.
 */
function ensureParentRun(store, parentKey, summary = "") {
  const existingRuns = store.listRunsForIssue ? store.listRunsForIssue(parentKey) : [];
  const parentRun = existingRuns.find((r) => r.role === "parent-orchestrator" || r.payload?.role === "parent-orchestrator");
  if (parentRun) return parentRun.id;

  const runId = store.createRun(parentKey, {
    role: "parent-orchestrator",
    summary: summary || `Parent Orchestration: ${parentKey}`,
    type: "orchestration",
    action: "orchestration"
  });
  return runId;
}

/**
 * Record inspectable parent telemetry event in SQLite store respecting Phase F lifecycle.
 */
export function recordParentTelemetryEvent(store, {
  parentKey,
  event,
  role = "parent-orchestrator",
  action = "orchestration",
  stage = "progress",
  status = "running",
  payload = {},
  metadata = {},
  now = new Date().toISOString()
}) {
  if (typeof store?.recordTelemetryEvent !== "function" || !store.database) return;

  try {
    const runId = ensureParentRun(store, parentKey);

    // Retrieve existing telemetry stages & max sequence for this run
    const existingEvents = store.database.prepare(
      "SELECT stage, sequence FROM telemetry_events WHERE run_id = ? ORDER BY sequence ASC, id ASC"
    ).all(runId);

    const hasTerminal = existingEvents.some((e) => e.stage === "terminal");
    if (hasTerminal) return;

    let maxSeq = existingEvents.length > 0 ? Math.max(...existingEvents.map((e) => e.sequence)) : 0;
    const hasQueued = existingEvents.some((e) => e.stage === "queued");
    const hasStarted = existingEvents.some((e) => e.stage === "started");

    // Ensure queued event exists
    if (!hasQueued && stage !== "queued") {
      maxSeq += 1;
      store.recordTelemetryEvent({
        eventId: `telem-parent-${parentKey}-queued-1`,
        runId,
        issueKey: parentKey,
        role,
        action,
        attempt: 0,
        persona: "orchestrator",
        taskAgent: "parent-orchestrator",
        provider: "scaffold",
        model: "parent-orchestrator",
        stage: "queued",
        status: "queued",
        sequence: maxSeq,
        createdAt: now
      });
    }

    // Ensure started event exists
    if (!hasStarted && stage !== "queued" && stage !== "started") {
      maxSeq += 1;
      store.recordTelemetryEvent({
        eventId: `telem-parent-${parentKey}-started-2`,
        runId,
        issueKey: parentKey,
        role,
        action,
        attempt: 0,
        persona: "orchestrator",
        taskAgent: "parent-orchestrator",
        provider: "scaffold",
        model: "parent-orchestrator",
        stage: "started",
        status: "running",
        sequence: maxSeq,
        metadata: redactTelemetryPayload({ event: "parent_lifecycle_started" }),
        createdAt: now
      });
    }

    maxSeq += 1;
    const eventId = `telem-parent-${parentKey}-${event}-${maxSeq}`;
    const mergedMetadata = { ...(metadata || {}), ...(payload || {}) };

    store.recordTelemetryEvent({
      eventId,
      runId,
      issueKey: parentKey,
      role,
      action,
      attempt: 0,
      persona: "orchestrator",
      taskAgent: "parent-orchestrator",
      provider: "scaffold",
      model: "parent-orchestrator",
      stage,
      status,
      sequence: maxSeq,
      metadata: redactTelemetryPayload({ event, ...mergedMetadata }),
      createdAt: now
    });
  } catch (err) {
    // Non-fatal telemetry recording
  }
}

/**
 * Discover parent hierarchy, validate DAG, resolve base SHA, compute and pin graph.
 */
export async function discoverAndPinParent(settings, store, parent, options = {}) {
  const workSource = options.workSource || createWorkSourceProvider(settings);
  const sc = options.sourceControl || createSourceControlProvider(settings);
  const parentKey = parent.key || parent.id || parent.parentKey;
  const summary = parent.summary || parent.title || parentKey;
  const description = parent.description || parent.body || "";
  const acceptanceCriteria = parent.acceptanceCriteria || parent.acceptance_criteria || "";
  const type = parent.issueType || parent.type || "Epic";
  const baseRef = options.baseRef || settings.data?.project?.baseBranch || "develop";
  const repoPath = settings.repoPath;
  const root = settings.worktreeRoot;
  const runtime = options.runtime || { spawnSync };

  // 1. Discover children from WorkSourceProvider (fail closed on error)
  let children = [];
  try {
    if (typeof workSource.getChildren !== "function") {
      throw new Error(`WorkSourceProvider '${workSource?.name}' does not implement getChildren`);
    }
    children = await workSource.getChildren(parentKey);
    if (!Array.isArray(children)) {
      throw new Error(`WorkSourceProvider getChildren(${parentKey}) returned non-array result`);
    }
  } catch (err) {
    const reason = `Hierarchy discovery failed for parent ${parentKey}: ${err.message}`;
    store.upsertParentExecution({
      parentKey,
      sourceProvider: parent.source?.provider || selectedWorkSourceProviderName(settings),
      sourceId: parent.source?.id || null,
      sourceUrl: parent.source?.url || null,
      summary,
      description,
      acceptanceCriteria,
      type,
      baseRef,
      baseSha: null,
      integrationBranch: "",
      graphFingerprint: "",
      dag: { valid: false, errors: [reason] },
      state: "blocked"
    });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      payload: { reason }
    });
    return { ok: false, blocked: true, reason };
  }

  // 2. Discover dependencies for each child (fail closed on error)
  const dependencyMap = {};
  for (const child of children) {
    const cKey = child.key || child.id;
    if (!cKey) continue;
    try {
      if (typeof workSource.getDependencies !== "function") {
        throw new Error(`WorkSourceProvider '${workSource?.name}' does not implement getDependencies`);
      }
      const deps = await workSource.getDependencies(cKey);
      if (!Array.isArray(deps)) {
        throw new Error(`WorkSourceProvider getDependencies(${cKey}) returned non-array result`);
      }
      dependencyMap[cKey] = deps.map((d) => (typeof d === "string" ? d : d.key || d.id));
    } catch (err) {
      const reason = `Dependency discovery failed for child ${cKey}: ${err.message}`;
      store.upsertParentExecution({
        parentKey,
        sourceProvider: parent.source?.provider || selectedWorkSourceProviderName(settings),
        sourceId: parent.source?.id || null,
        sourceUrl: parent.source?.url || null,
        summary,
        description,
        acceptanceCriteria,
        type,
        baseRef,
        baseSha: null,
        integrationBranch: "",
        graphFingerprint: "",
        dag: { valid: false, errors: [reason] },
        state: "blocked"
      });
      recordParentTelemetryEvent(store, {
        parentKey,
        event: "parent_blocked",
        stage: "terminal",
        status: "blocked",
        payload: { reason }
      });
      return { ok: false, blocked: true, reason };
    }
  }

  // 3. Build & Validate DAG
  const dag = buildHierarchyDag({
    parentKey,
    children,
    dependencyMap,
    externalDependencyChecker: options.externalDependencyChecker || ((depKey) => {
      try {
        const existingRuns = store.listRunsForIssue(depKey);
        const isClean = existingRuns.some((r) => ["completed", "reviewed-clean", "waiting_human"].includes(r.state));
        if (isClean) return { satisfied: true, evidence: { run: "completed" } };
      } catch {}
      return { satisfied: false, reason: `External dependency ${depKey} status is unresolved` };
    })
  });

  // 4. Resolve Base Revision Commit SHA (e.g. develop^{commit})
  let baseRev = { ok: false, ref: baseRef, sha: null };
  if (typeof sc.resolveRevision === "function") {
    baseRev = sc.resolveRevision({ repoPath, requestedRef: baseRef, runtime });
  } else {
    const base = sc.resolveBaseRevision({ repoPath, requestedRef: baseRef, runtime });
    const head = sc.getHead({ repoPath, runtime });
    baseRev = { ok: base.resolved && head.ok, ref: base.ref, sha: head.sha, error: base.error || head.error };
  }

  if (!baseRev.ok || !baseRev.sha) {
    const reason = `Cannot resolve commit SHA for baseRef '${baseRef}': ${baseRev.error || "unknown"}`;
    store.upsertParentExecution({
      parentKey,
      sourceProvider: parent.source?.provider || selectedWorkSourceProviderName(settings),
      sourceId: parent.source?.id || null,
      sourceUrl: parent.source?.url || null,
      summary,
      description,
      acceptanceCriteria,
      type,
      baseRef,
      baseSha: null,
      integrationBranch: "",
      graphFingerprint: "",
      dag: { valid: false, errors: [reason] },
      state: "blocked"
    });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      payload: { reason }
    });
    return { ok: false, blocked: true, reason };
  }

  const baseSha = baseRev.sha;

  // 5. Integration Branch & Fingerprint
  const integrationBranch = `epic/${parentKey.toLowerCase()}-${summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "work"}`;
  const graphFingerprint = computeGraphFingerprint({
    parentKey,
    baseSha,
    integrationBranch,
    children: dag.children,
    edges: dag.edges
  });

  // Check existing pinned generation in store (preserve state on rediscovery)
  const existing = store.getParentExecution(parentKey);
  if (existing) {
    if (existing.graphFingerprint && existing.graphFingerprint !== graphFingerprint) {
      // Hierarchy drift detected!
      const driftMessage = `Hierarchy drift detected: pinned ${existing.graphFingerprint.slice(0, 8)} vs current ${graphFingerprint.slice(0, 8)}`;
      store.updateParentExecutionState(parentKey, "blocked", { driftDetected: true });
      recordParentTelemetryEvent(store, {
        parentKey,
        event: "parent_blocked",
        stage: "terminal",
        status: "blocked",
        metadata: { reason: driftMessage }
      });
      return {
        ok: false,
        blocked: true,
        drift: true,
        reason: driftMessage,
        dag,
        graphFingerprint
      };
    }

    // Same fingerprint: If execute=true and integration worktree was never prepared or is in waiting_approval/planned state, authorize and prepare it
    if (options.execute && (!existing.integrationWorktree || ["planned", "waiting_approval"].includes(existing.state))) {
      const branchPlan = {
        parentKey,
        issueKey: parentKey,
        graphFingerprint: existing.graphFingerprint || graphFingerprint,
        baseSha: existing.baseSha || baseSha,
        integrationBranch: existing.integrationBranch || integrationBranch
      };
      const branchFingerprint = computeParentBranchFingerprint(branchPlan);
      const auth = authorizeRuntimeAction(settings, store, {
        issueKey: parentKey,
        action: "branchCreation",
        plan: branchPlan,
        planFingerprint: branchFingerprint
      });
      if (!auth.allowed) {
        if (store && typeof store.addPmDecision === "function") {
          const existingDecisions = store.getPmDecisions(parentKey) || [];
          const alreadyRequested = existingDecisions.some(
            (d) => d.type === "approval_requested" &&
                   d.payload.action === "branchCreation" &&
                   d.payload.planFingerprint === branchFingerprint
          );
          if (!alreadyRequested) {
            store.addPmDecision(parentKey, "approval_requested", {
              state: "awaiting-approval",
              action: "branchCreation",
              attempt: 0,
              planFingerprint: branchFingerprint,
              summary: summary || parent.summary,
              plan: branchPlan
            });
          }
        }
        store.updateParentExecutionState(parentKey, "waiting_approval");
        recordParentTelemetryEvent(store, {
          parentKey,
          event: "approval_waiting",
          stage: "progress",
          status: "waiting",
          payload: { action: "branchCreation", planFingerprint: branchFingerprint, reason: auth.reason }
        });
        return {
          ok: false,
          waitingApproval: true,
          reason: auth.reason,
          execution: store.getParentExecution(parentKey)
        };
      }
      try {
        const prep = sc.prepareIntegrationWorktree({
          repoPath,
          root,
          parentKey,
          summary,
          baseRef,
          execute: true,
          runtime
        });
        const updated = store.upsertParentExecution({
          ...existing,
          integrationWorktree: prep.worktree,
          state: existing.state === "waiting_approval" || existing.state === "planned" ? "active" : existing.state
        });
        return {
          ok: true,
          blocked: false,
          execution: updated,
          dag: existing.dag || dag,
          graphFingerprint: existing.graphFingerprint,
          integrationBranch: existing.integrationBranch,
          integrationWorktree: prep.worktree
        };
      } catch (err) {
        const reason = `Failed to create/verify integration worktree for ${parentKey}: ${err.message}`;
        store.updateParentExecutionState(parentKey, "blocked");
        recordParentTelemetryEvent(store, {
          parentKey,
          event: "parent_blocked",
          stage: "terminal",
          status: "blocked",
          metadata: { reason }
        });
        return { ok: false, blocked: true, reason };
      }
    }

    // Same fingerprint: PRESERVE existing state (active, integration-review-queued, blocked, waiting_human)
    return {
      ok: existing.state !== "blocked",
      blocked: existing.state === "blocked",
      execution: existing,
      dag: existing.dag || dag,
      graphFingerprint: existing.graphFingerprint,
      integrationBranch: existing.integrationBranch,
      integrationWorktree: existing.integrationWorktree
    };
  }

  if (!dag.valid) {
    // Invalid DAG fails closed
    const errorMsg = dag.errors.join("; ");
    store.upsertParentExecution({
      parentKey,
      sourceProvider: parent.source?.provider || selectedWorkSourceProviderName(settings),
      sourceId: parent.source?.id || null,
      sourceUrl: parent.source?.url || null,
      summary,
      description,
      acceptanceCriteria,
      type,
      baseRef,
      baseSha,
      integrationBranch,
      graphFingerprint,
      dag,
      state: "blocked"
    });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      metadata: { errors: dag.errors }
    });
    return {
      ok: false,
      blocked: true,
      reason: errorMsg,
      dag,
      graphFingerprint
    };
  }

  // 6. Check authorization & Prepare integration worktree
  let integrationWorktree = null;
  let parentState = options.execute ? "active" : "planned";

  if (options.execute) {
    const branchPlan = {
      parentKey,
      issueKey: parentKey,
      graphFingerprint,
      baseSha,
      integrationBranch
    };
    const branchFingerprint = computeParentBranchFingerprint(branchPlan);
    const auth = authorizeRuntimeAction(settings, store, {
      issueKey: parentKey,
      action: "branchCreation",
      plan: branchPlan,
      planFingerprint: branchFingerprint
    });
    if (!auth.allowed) {
      if (store && typeof store.addPmDecision === "function") {
        const existingDecisions = store.getPmDecisions(parentKey) || [];
        const alreadyRequested = existingDecisions.some(
          (d) => d.type === "approval_requested" &&
                 d.payload.action === "branchCreation" &&
                 d.payload.planFingerprint === branchFingerprint
        );
        if (!alreadyRequested) {
          store.addPmDecision(parentKey, "approval_requested", {
            state: "awaiting-approval",
            action: "branchCreation",
            attempt: 0,
            planFingerprint: branchFingerprint,
            summary: summary || parent.summary,
            plan: branchPlan
          });
        }
      }
      parentState = "waiting_approval";
      store.upsertParentExecution({
        parentKey,
        sourceProvider: parent.source?.provider || selectedWorkSourceProviderName(settings),
        sourceId: parent.source?.id || null,
        sourceUrl: parent.source?.url || null,
        summary,
        description,
        acceptanceCriteria,
        type,
        baseRef,
        baseSha,
        integrationBranch,
        integrationWorktree: null,
        graphFingerprint,
        dag,
        state: "waiting_approval"
      });
      recordParentTelemetryEvent(store, {
        parentKey,
        event: "approval_waiting",
        stage: "progress",
        status: "waiting",
        payload: { action: "branchCreation", planFingerprint: branchFingerprint, reason: auth.reason }
      });
      return { ok: false, waitingApproval: true, reason: auth.reason, execution: store.getParentExecution(parentKey) };
    }

    try {
      const prep = sc.prepareIntegrationWorktree({
        repoPath,
        root,
        parentKey,
        summary,
        baseRef,
        execute: true,
        runtime
      });
      integrationWorktree = prep.worktree;
    } catch (err) {
      // Do not swallow worktree creation errors
      const reason = `Failed to create/verify integration worktree for ${parentKey}: ${err.message}`;
      store.upsertParentExecution({
        parentKey,
        sourceProvider: parent.source?.provider || selectedWorkSourceProviderName(settings),
        sourceId: parent.source?.id || null,
        sourceUrl: parent.source?.url || null,
        summary,
        description,
        acceptanceCriteria,
        type,
        baseRef,
        baseSha,
        integrationBranch,
        integrationWorktree: null,
        graphFingerprint,
        dag,
        state: "blocked"
      });
      recordParentTelemetryEvent(store, {
        parentKey,
        event: "parent_blocked",
        stage: "terminal",
        status: "blocked",
        metadata: { reason }
      });
      return { ok: false, blocked: true, reason };
    }
  }

  // 7. Persist normalized parent execution snapshot
  const execution = store.upsertParentExecution({
    parentKey,
    sourceProvider: parent.source?.provider || selectedWorkSourceProviderName(settings),
    sourceId: parent.source?.id || null,
    sourceUrl: parent.source?.url || null,
    summary,
    description,
    acceptanceCriteria,
    type,
    baseRef,
    baseSha,
    integrationBranch,
    integrationWorktree,
    graphFingerprint,
    dag,
    state: parentState
  });

  // 8. Register each child in epic_tasks with its dependencies
  for (const child of dag.children) {
    const upstream = dag.internalDependencies[child.key] || [];
    store.upsertEpicTask({
      epicKey: parentKey,
      parentKey,
      issueKey: child.key,
      summary: child.summary,
      branch: `task/${child.key.toLowerCase()}-${child.summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "task"}`,
      dependencies: upstream,
      state: "planned",
      orchestrationState: upstream.length === 0 ? "planned" : "pending-dependencies"
    });
  }

  recordParentTelemetryEvent(store, {
    parentKey,
    event: "parent_discovered",
    stage: "progress",
    status: "running",
    metadata: { childrenCount: dag.children.length, edgesCount: dag.edges.length }
  });
  recordParentTelemetryEvent(store, {
    parentKey,
    event: "graph_pinned",
    stage: "progress",
    status: "running",
    metadata: { graphFingerprint, baseSha, integrationBranch }
  });

  return {
    ok: true,
    blocked: false,
    execution,
    dag,
    graphFingerprint,
    integrationBranch,
    integrationWorktree
  };
}

/**
 * Reconcile child readiness and pin childBaseSha from CURRENT integration branch HEAD.
 */
export function reconcileParentChildren(settings, store, parentKey, options = {}) {
  const sc = options.sourceControl || createSourceControlProvider(settings);
  const repoPath = settings.repoPath;
  const runtime = options.runtime || { spawnSync };

  const parent = store.getParentExecution(parentKey);
  if (!parent || parent.state === "blocked" || parent.state === "waiting_human") {
    return { updated: 0, readyChildren: [] };
  }

  const tasks = store.listEpicTasks(parentKey);
  const integrations = store.listEpicIntegrations(parentKey);
  const integratedKeys = new Set(
    integrations.filter((i) => i.state === "integrated").map((i) => i.issueKey)
  );

  const readyChildren = [];
  let updated = 0;

  for (const task of tasks) {
    const upstream = task.dependencies || [];
    const allIntegrated = upstream.every((dep) => integratedKeys.has(dep));

    if (allIntegrated && task.state !== "integrated") {
      if (task.orchestrationState === "pending-dependencies" || task.orchestrationState === "planned" || !task.orchestrationState) {
        // Resolve exact CURRENT parent integration branch HEAD commit
        let childBaseSha = null;
        try {
          const brRes = (runtime.spawnSync || spawnSync)(
            "git",
            ["-c", `safe.directory=${repoPath}`, "-C", repoPath, "rev-parse", `refs/heads/${parent.integrationBranch}^{commit}`],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
          );
          if (brRes.status === 0 && brRes.stdout) {
            const bSha = brRes.stdout.trim().toLowerCase();
            if (REVIEW_SHA_REGEX.test(bSha)) {
              childBaseSha = bSha;
            }
          }
        } catch {}

        if (!childBaseSha && parent.integrationWorktree && fs.existsSync(parent.integrationWorktree)) {
          const headRes = sc.getHead({
            repoPath: parent.integrationWorktree,
            runtime
          });
          if (headRes.ok && REVIEW_SHA_REGEX.test(headRes.sha)) childBaseSha = headRes.sha.toLowerCase();
        }

        if (!childBaseSha || !REVIEW_SHA_REGEX.test(childBaseSha)) {
          const reason = `Cannot pin childBaseSha for child ${task.issueKey}: integration branch/worktree HEAD unresolvable`;
          store.upsertEpicTask({
            ...task,
            orchestrationState: "pending-dependencies",
            blockedReasons: [reason]
          });
          recordParentTelemetryEvent(store, {
            parentKey,
            event: "child_base_unresolvable",
            stage: "progress",
            status: "running",
            payload: { issueKey: task.issueKey, reason }
          });
          continue;
        }

        store.upsertEpicTask({
          epicKey: parentKey,
          parentKey,
          issueKey: task.issueKey,
          summary: task.summary,
          branch: task.branch,
          worktree: task.worktree,
          state: task.state,
          orchestrationState: "dependency-ready",
          dependencies: upstream,
          childBaseSha,
          reviewedSha: task.reviewedSha,
          integratedSha: task.integratedSha,
          blockedReasons: []
        });

        readyChildren.push(task.issueKey);
        updated += 1;

        recordParentTelemetryEvent(store, {
          parentKey,
          event: "child_dependency_ready",
          stage: "progress",
          status: "running",
          payload: { issueKey: task.issueKey, childBaseSha, upstream }
        });
      } else if (task.orchestrationState === "dependency-ready") {
        readyChildren.push(task.issueKey);
      }
    }
  }

  return { updated, readyChildren };
}

/**
 * Execute aggregate integration review over parentBaseSha..integrationHeadSha.
 */
export async function runParentIntegrationReview(settings, store, parentKey, options = {}) {
  const parent = store.getParentExecution(parentKey);
  if (!parent) throw new Error(`Unknown parent: ${parentKey}`);
  const sc = options.sourceControl || createSourceControlProvider(settings);
  const runtime = options.runtime || { spawnSync, spawn };
  const repoPath = settings.repoPath;
  const integrationWorktree = parent.integrationWorktree || repoPath;

  const currentHeadRes = sc.getHead({ repoPath: integrationWorktree });
  const integrationHeadSha = options.reviewedSha || parent.integrationHeadSha || (currentHeadRes.ok ? currentHeadRes.sha : null);
  const parentBaseSha = parent.baseSha || "HEAD~1";

  if (!integrationHeadSha) {
    throw new Error("Cannot run integration review: integrationHeadSha is unresolved");
  }

  // Resolve Reviewer through Agent Registry
  const explicitReviewer = settings.data?.policy?.review?.taskAgent || settings.data?.policy?.review?.reviewer || "correctness-reviewer";
  const reviewerDef = typeof store.getAgentDefinition === "function" ? store.getAgentDefinition(explicitReviewer) : null;
  if (!reviewerDef || reviewerDef.status !== "enabled") {
    const reason = !reviewerDef
      ? `Reviewer agent '${explicitReviewer}' is not registered in agent registry`
      : `Reviewer agent '${explicitReviewer}' is disabled in agent registry`;
    store.updateParentExecutionState(parentKey, "blocked", { reason });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      metadata: { reason }
    });
    return { ok: false, blocked: true, parentState: "blocked", reason };
  }

  const reviewerAgentId = reviewerDef.id;
  const reviewerVersion = reviewerDef.currentVersion || reviewerDef.version;
  const reviewerHash = reviewerDef.definitionHash || reviewerDef.currentHash;

  // Select Review Profile
  const dummyIssue = { key: parentKey, summary: parent.summary, canonicalState: "review" };
  const explicitModelProfile = settings.data?.policy?.review?.modelProfile;
  const requiredModelProfile = reviewerDef?.definition?.executor?.modelProfile;
  const effectiveReviewSettings = (requiredModelProfile && !explicitModelProfile)
    ? {
        ...settings,
        data: {
          ...settings?.data,
          policy: {
            ...settings?.data?.policy,
            review: {
              ...settings?.data?.policy?.review,
              modelProfile: requiredModelProfile
            }
          }
        }
      }
    : settings;

  let profile = null;
  try {
    profile = selectReviewProfile(effectiveReviewSettings, dummyIssue, { reviewer: explicitReviewer });
  } catch (err) {
    if (!options.injectedReviewOutcome) throw err;
  }

  const provider = profile?.provider || settings.data?.policy?.review?.provider || "antigravity";
  const modelProfile = profile?.modelProfile || effectiveReviewSettings.data?.policy?.review?.modelProfile || "medium";

  // Check reviewer agent definition executor constraints
  if (reviewerDef.definition?.executor) {
    const exec = reviewerDef.definition.executor;
    if (exec.provider && exec.provider !== provider) {
      const reason = `Reviewer executor provider constraint mismatch: required '${exec.provider}', configured '${provider}'`;
      store.updateParentExecutionState(parentKey, "blocked", { reason });
      recordParentTelemetryEvent(store, { parentKey, event: "parent_blocked", stage: "terminal", status: "blocked", metadata: { reason } });
      return { ok: false, blocked: true, parentState: "blocked", reason };
    }
    if (exec.modelProfile && exec.modelProfile !== modelProfile) {
      const reason = `Reviewer executor modelProfile constraint mismatch: required '${exec.modelProfile}', configured '${modelProfile}'`;
      store.updateParentExecutionState(parentKey, "blocked", { reason });
      recordParentTelemetryEvent(store, { parentKey, event: "parent_blocked", stage: "terminal", status: "blocked", metadata: { reason } });
      return { ok: false, blocked: true, parentState: "blocked", reason };
    }
    if (exec.model && profile?.model && exec.model !== profile.model) {
      const reason = `Reviewer executor model constraint mismatch: required '${exec.model}', configured '${profile.model}'`;
      store.updateParentExecutionState(parentKey, "blocked", { reason });
      recordParentTelemetryEvent(store, { parentKey, event: "parent_blocked", stage: "terminal", status: "blocked", metadata: { reason } });
      return { ok: false, blocked: true, parentState: "blocked", reason };
    }
  }

  // Check authorization for review bound to exact parentBaseSha, integrationHeadSha, and reviewer metadata
  const reviewPlan = {
    parentKey,
    issueKey: parentKey,
    graphFingerprint: parent.graphFingerprint || "",
    parentBaseSha,
    integrationHeadSha,
    reviewerAgentId,
    reviewerVersion,
    reviewerHash
  };
  const reviewFingerprint = computeParentReviewFingerprint(reviewPlan);
  const auth = authorizeRuntimeAction(settings, store, {
    issueKey: parentKey,
    action: "review",
    plan: reviewPlan,
    planFingerprint: reviewFingerprint
  });
  if (!auth.allowed) {
    if (store && typeof store.addPmDecision === "function") {
      const existingDecisions = store.getPmDecisions(parentKey) || [];
      const alreadyRequested = existingDecisions.some(
        (d) => d.type === "approval_requested" &&
               d.payload.action === "review" &&
               d.payload.planFingerprint === reviewFingerprint
      );
      if (!alreadyRequested) {
        store.addPmDecision(parentKey, "approval_requested", {
          state: "awaiting-approval",
          action: "review",
          attempt: 0,
          planFingerprint: reviewFingerprint,
          summary: parent.summary,
          plan: reviewPlan
        });
      }
    }
    const reason = `Integration review not authorized: ${auth.reason}`;
    store.updateParentExecutionState(parentKey, "waiting_approval", { reason });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "approval_waiting",
      stage: "progress",
      status: "waiting",
      payload: { action: "review", planFingerprint: reviewFingerprint, reason }
    });
    return { ok: false, waitingApproval: true, parentState: "waiting_approval", reason };
  }

  // Update parent state to integration-review-queued
  store.updateParentExecutionState(parentKey, "integration-review-queued", { integrationHeadSha });
  recordParentTelemetryEvent(store, {
    parentKey,
    event: "integration_review_queued",
    stage: "progress",
    status: "running",
    metadata: { parentBaseSha, integrationHeadSha }
  });

  const tasks = store.listEpicTasks(parentKey);
  const integrations = store.listEpicIntegrations(parentKey);

  // Compute aggregate changed files (fail closed on error)
  let aggregateChangedFiles = [];
  try {
    const diffRes = spawnSync(
      "git",
      ["-c", `safe.directory=${integrationWorktree}`, "-C", integrationWorktree, "diff", "--name-only", `${parentBaseSha}..${integrationHeadSha}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (diffRes.status !== 0) {
      throw new Error(diffRes.stderr || diffRes.stdout || "git diff returned non-zero status");
    }
    if (diffRes.stdout) {
      aggregateChangedFiles = diffRes.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
  } catch (err) {
    const reason = `Failed to compute aggregate review diff: ${err.message}`;
    store.updateParentExecutionState(parentKey, "blocked", { reason });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      metadata: { reason }
    });
    return { ok: false, blocked: true, parentState: "blocked", reason };
  }

  // Repository verification bound to exact integrationHeadSha
  let verificationResult = { verifiedHeadSha: integrationHeadSha, repositoryCheck: "passed", verifiedAt: new Date().toISOString() };
  if (!options.skipRepoCheck && !options.injectedReviewOutcome) {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const checkRes = spawnSync(npmCmd, ["run", "check"], {
      cwd: integrationWorktree,
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (checkRes.status !== 0) {
      const reason = `Repository verification check (npm run check) failed on integration head ${integrationHeadSha.slice(0, 8)} (exit ${checkRes.status})`;
      store.updateParentExecutionState(parentKey, "blocked", { reason });
      recordParentTelemetryEvent(store, {
        parentKey,
        event: "parent_blocked",
        stage: "terminal",
        status: "blocked",
        metadata: { reason }
      });
      return { ok: false, blocked: true, parentState: "blocked", reason };
    }
  }

  // Collect fresh Code Intelligence over integrationWorktree
  let reviewIntelligence = null;
  try {
    reviewIntelligence = await collectReviewIntelligence(
      settings,
      { key: parentKey, summary: parent.summary },
      aggregateChangedFiles,
      { runtime, store, repoPath: integrationWorktree, worktree: integrationWorktree }
    );
  } catch (err) {
    reviewIntelligence = { provider: "none", status: "unavailable", warnings: [err.message] };
  }

  // Build aggregate review prompt with REAL parent acceptance context
  const childEvidence = tasks.map((t) => {
    const int = integrations.find((i) => i.issueKey === t.issueKey);
    return `- Child ${t.issueKey} (${t.summary}): reviewed SHA ${t.reviewedSha || "n/a"}, integrated SHA ${int?.commit || t.integratedSha || "n/a"}`;
  }).join("\n");

  let prompt = `Aggregate Integration Review for Parent ${parentKey}: ${parent.summary}\n`;
  if (parent.description) {
    prompt += `Parent Objective:\n${parent.description}\n\n`;
  }
  if (parent.acceptanceCriteria) {
    prompt += `Parent Acceptance Criteria:\n${parent.acceptanceCriteria}\n\n`;
  }
  prompt += `Parent Base SHA: ${parentBaseSha}\nIntegration Head SHA: ${integrationHeadSha}\n\n`;
  prompt += `Integrated Children:\n${childEvidence}\n\n`;
  prompt += `Aggregate Changed Files:\n${aggregateChangedFiles.map((f) => `- ${f}`).join("\n")}\n\n`;
  prompt += `Repository Verification: npm run check passed on integration head ${integrationHeadSha}\n\n`;
  prompt += `Perform an independent aggregate correctness and regression review over the combined changes.\n`;
  prompt += `Verdict must be either "clean" or "changes-requested". Evidence must be an array of structured findings: { id, severity, category, file, line, problem, expected, verification }.\n`;

  const intelSection = formatReviewIntelligencePromptSection(reviewIntelligence);
  if (intelSection) prompt += `\n${intelSection}\n`;

  // Create real pinned Reviewer Run in SQLite runs table and transition it
  const revRunId = store.createRun(parentKey, {
    role: "reviewer",
    action: "integration_review",
    summary: `Aggregate integration review for ${parentKey}`,
    reviewerAgentId,
    reviewerVersion,
    reviewerHash,
    provider,
    model: profile?.model || "default",
    modelProfile,
    parentBaseSha,
    integrationHeadSha
  });

  store.transition(revRunId, "queued", {
    reviewerAgentId,
    reviewerVersion,
    reviewerHash,
    provider,
    modelProfile,
    parentBaseSha,
    integrationHeadSha
  });

  store.transition(revRunId, "started", {
    reviewerAgentId,
    reviewerVersion,
    reviewerHash,
    provider,
    modelProfile,
    parentBaseSha,
    integrationHeadSha
  });

  if (typeof store.recordTelemetryEvent === "function") {
    try {
      store.recordTelemetryEvent({
        eventId: `telem-rev-${revRunId}-queued-1`,
        runId: revRunId,
        issueKey: parentKey,
        role: "reviewer",
        action: "integration_review",
        attempt: 0,
        persona: "reviewer",
        taskAgent: reviewerAgentId,
        agentVersion: reviewerVersion,
        agentHash: reviewerHash,
        provider,
        model: profile?.model || "default",
        modelProfile,
        stage: "queued",
        status: "queued",
        sequence: 1,
        createdAt: new Date().toISOString()
      });
      store.recordTelemetryEvent({
        eventId: `telem-rev-${revRunId}-started-2`,
        runId: revRunId,
        issueKey: parentKey,
        role: "reviewer",
        action: "integration_review",
        attempt: 0,
        persona: "reviewer",
        taskAgent: reviewerAgentId,
        agentVersion: reviewerVersion,
        agentHash: reviewerHash,
        provider,
        model: profile?.model || "default",
        modelProfile,
        stage: "started",
        status: "running",
        sequence: 2,
        createdAt: new Date().toISOString()
      });
    } catch {}
  }

  let reviewOutcome = null;
  let executionFailureReason = null;
  let reviewTelemetry = null;

  if (options.injectedReviewOutcome) {
    reviewOutcome = options.injectedReviewOutcome;
  } else {
    // Execute reviewer command
    try {
      const prepared = { worktree: integrationWorktree };
      const built = buildExecutorCommand({ settings, profile, prepared, prompt, runId: revRunId });
      const result = (runtime.spawnSync || spawnSync)(built.command[0], built.command.slice(1), {
        cwd: built.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: (profile?.config?.timeoutSeconds || 3600) * 1000
      });
      const returnCode = result.status ?? 1;
      const stdout = result.stdout || "";
      const stderr = result.stderr || result.error?.message || "";
      reviewTelemetry = parseExecutionOutput(profile?.provider || "antigravity", stdout, stderr, returnCode);

      if (reviewTelemetry.ok && reviewTelemetry.result?.verdict) {
        reviewOutcome = {
          verdict: reviewTelemetry.result.verdict,
          evidence: Array.isArray(reviewTelemetry.result.evidence) ? reviewTelemetry.result.evidence : []
        };
      } else {
        executionFailureReason = reviewTelemetry?.error?.safeMessage || stderr || `Reviewer process failed with return code ${returnCode}`;
      }
    } catch (execErr) {
      executionFailureReason = `Reviewer execution exception: ${execErr.message}`;
    }
  }

  if (executionFailureReason) {
    store.transition(revRunId, "failed", { error: executionFailureReason, errorCategory: "reviewer_execution_error" });
    if (typeof store.recordTelemetryEvent === "function") {
      try {
        store.recordTelemetryEvent({
          eventId: `telem-rev-${revRunId}-terminal-3`,
          runId: revRunId,
          issueKey: parentKey,
          role: "reviewer",
          action: "integration_review",
          attempt: 0,
          persona: "reviewer",
          taskAgent: reviewerAgentId,
          agentVersion: reviewerVersion,
          agentHash: reviewerHash,
          provider,
          model: profile?.model || "default",
          modelProfile,
          stage: "terminal",
          status: "failed",
          sequence: 3,
          durationMs: reviewTelemetry?.durationSeconds != null
            ? Math.round(reviewTelemetry.durationSeconds * 1000)
            : (reviewTelemetry?.durationMs != null ? Number(reviewTelemetry.durationMs) : null),
          usage: reviewTelemetry?.usage || null,
          error: {
            category: "reviewer_execution_error",
            safeMessage: executionFailureReason
          },
          createdAt: new Date().toISOString()
        });
      } catch {}
    }
    store.updateParentExecutionState(parentKey, "blocked", { reason: executionFailureReason });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      metadata: { reason: executionFailureReason }
    });
    return { ok: false, blocked: true, parentState: "blocked", reason: executionFailureReason, reviewRunId: revRunId };
  }

  // Strict schema validation of findings
  const verdict = reviewOutcome?.verdict;
  if (!["clean", "changes-requested"].includes(verdict)) {
    const reason = `Invalid reviewer verdict: '${verdict}'`;
    store.transition(revRunId, "failed", { error: reason, errorCategory: "reviewer_schema_error" });
    if (typeof store.recordTelemetryEvent === "function") {
      try {
        store.recordTelemetryEvent({
          eventId: `telem-rev-${revRunId}-terminal-3`,
          runId: revRunId,
          issueKey: parentKey,
          role: "reviewer",
          action: "integration_review",
          attempt: 0,
          persona: "reviewer",
          taskAgent: reviewerAgentId,
          agentVersion: reviewerVersion,
          agentHash: reviewerHash,
          provider,
          model: profile?.model || "default",
          modelProfile,
          stage: "terminal",
          status: "failed",
          sequence: 3,
          durationMs: reviewTelemetry?.durationSeconds != null
            ? Math.round(reviewTelemetry.durationSeconds * 1000)
            : (reviewTelemetry?.durationMs != null ? Number(reviewTelemetry.durationMs) : null),
          usage: reviewTelemetry?.usage || null,
          error: {
            category: "reviewer_schema_error",
            safeMessage: reason
          },
          createdAt: new Date().toISOString()
        });
      } catch {}
    }
    store.updateParentExecutionState(parentKey, "blocked", { reason });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      metadata: { reason }
    });
    return { ok: false, blocked: true, parentState: "blocked", reason, reviewRunId: revRunId };
  }

  const severitiesSet = new Set(ALLOWED_FINDING_SEVERITIES);
  const categoriesSet = new Set(ALLOWED_FINDING_CATEGORIES);

  let validatedFindings = [];
  try {
    const rawEvidence = Array.isArray(reviewOutcome.evidence) ? reviewOutcome.evidence : [];
    if (rawEvidence.length === 0) {
      throw new Error("Reviewer outcome requires non-empty persisted evidence");
    }
    validatedFindings = rawEvidence.map((f) => {
      if (!f || typeof f !== "object" || !f.id || !f.problem || !f.severity || !f.category) {
        throw new Error("Review finding missing required fields (id, severity, category, problem)");
      }
      const sev = String(f.severity).toLowerCase();
      const cat = String(f.category).toLowerCase();
      if (!severitiesSet.has(sev)) throw new Error(`Invalid finding severity: '${f.severity}'`);
      if (!categoriesSet.has(cat)) throw new Error(`Invalid finding category: '${f.category}'`);
      return {
        id: String(f.id),
        severity: sev,
        category: cat,
        file: f.file ? String(f.file) : null,
        line: f.line != null ? Number(f.line) : null,
        problem: String(f.problem),
        expected: f.expected ? String(f.expected) : null,
        verification: f.verification ? String(f.verification) : null
      };
    });
  } catch (valErr) {
    const reason = `Review findings failed validation: ${valErr.message}`;
    store.transition(revRunId, "failed", { error: reason, errorCategory: "reviewer_schema_error" });
    if (typeof store.recordTelemetryEvent === "function") {
      try {
        store.recordTelemetryEvent({
          eventId: `telem-rev-${revRunId}-terminal-3`,
          runId: revRunId,
          issueKey: parentKey,
          role: "reviewer",
          action: "integration_review",
          attempt: 0,
          persona: "reviewer",
          taskAgent: reviewerAgentId,
          agentVersion: reviewerVersion,
          agentHash: reviewerHash,
          provider,
          model: profile?.model || "default",
          modelProfile,
          stage: "terminal",
          status: "failed",
          sequence: 3,
          durationMs: reviewTelemetry?.durationSeconds != null
            ? Math.round(reviewTelemetry.durationSeconds * 1000)
            : (reviewTelemetry?.durationMs != null ? Number(reviewTelemetry.durationMs) : null),
          usage: reviewTelemetry?.usage || null,
          error: {
            category: "reviewer_schema_error",
            safeMessage: reason
          },
          createdAt: new Date().toISOString()
        });
      } catch {}
    }
    store.updateParentExecutionState(parentKey, "blocked", { reason });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      metadata: { reason }
    });
    return { ok: false, blocked: true, parentState: "blocked", reason, reviewRunId: revRunId };
  }

  const persistedReview = {
    reviewerAgentId,
    reviewerVersion,
    reviewerHash,
    provider,
    modelProfile,
    integrationHeadSha,
    parentBaseSha,
    verdict,
    findings: validatedFindings,
    evidence: validatedFindings,
    findingsCount: validatedFindings.length,
    reviewedHeadSha: integrationHeadSha,
    durationMs: reviewTelemetry?.durationSeconds != null
      ? Math.round(reviewTelemetry.durationSeconds * 1000)
      : (reviewTelemetry?.durationMs != null ? Number(reviewTelemetry.durationMs) : null),
    usage: reviewTelemetry?.usage || null,
    reviewIntelligence: reviewIntelligence ? {
      provider: reviewIntelligence.provider,
      status: reviewIntelligence.status
    } : null,
    reviewedAt: new Date().toISOString()
  };

  if (typeof store.recordTelemetryEvent === "function") {
    try {
      store.recordTelemetryEvent({
        eventId: `telem-rev-${revRunId}-terminal-3`,
        runId: revRunId,
        issueKey: parentKey,
        role: "reviewer",
        action: "integration_review",
        attempt: 0,
        persona: "reviewer",
        taskAgent: reviewerAgentId,
        agentVersion: reviewerVersion,
        agentHash: reviewerHash,
        provider,
        model: profile?.model || "default",
        modelProfile,
        stage: "terminal",
        status: "completed",
        sequence: 3,
        durationMs: reviewTelemetry?.durationSeconds != null
          ? Math.round(reviewTelemetry.durationSeconds * 1000)
          : (reviewTelemetry?.durationMs != null ? Number(reviewTelemetry.durationMs) : null),
        usage: reviewTelemetry?.usage || null,
        metadata: { verdict, findingsCount: validatedFindings.length },
        createdAt: new Date().toISOString()
      });
    } catch {}
  }

  recordParentTelemetryEvent(store, {
    parentKey,
    event: "integration_reviewed",
    stage: "progress",
    status: verdict === "clean" ? "completed" : "failed",
    metadata: { verdict, findingsCount: validatedFindings.length, integrationHeadSha }
  });

  if (verdict === "changes-requested") {
    store.transition(revRunId, "completed", {
      verdict: "changes-requested",
      review: persistedReview,
      findings: validatedFindings
    });
    store.updateParentExecutionState(parentKey, "blocked", {
      integrationHeadSha,
      completionPacket: { integrationReview: persistedReview }
    });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      metadata: { reason: "Integration review requested changes", findings: validatedFindings }
    });
    return {
      ok: false,
      verdict: "changes-requested",
      parentState: "blocked",
      reviewRunId: revRunId,
      review: persistedReview
    };
  }

  // Transition clean review run
  store.transition(revRunId, "completed", {
    verdict: "clean",
    review: persistedReview,
    findings: validatedFindings
  });

  // Clean review: verify integrationHeadSha is still current HEAD (not stale and sc.getHead ok)
  const verifyHeadRes = sc.getHead({ repoPath: integrationWorktree });
  if (!verifyHeadRes.ok || verifyHeadRes.sha.toLowerCase() !== integrationHeadSha.toLowerCase()) {
    const staleMsg = !verifyHeadRes.ok
      ? `Failed to verify head after review: ${verifyHeadRes.error || "unknown"}`
      : `Integration review is stale: reviewed ${integrationHeadSha.slice(0, 8)} but branch advanced to ${verifyHeadRes.sha.slice(0, 8)}`;
    store.updateParentExecutionState(parentKey, "blocked", {
      completionPacket: { integrationReview: persistedReview, staleReason: staleMsg }
    });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      metadata: { reason: staleMsg }
    });
    return {
      ok: false,
      verdict: "clean",
      stale: true,
      parentState: "blocked",
      reviewRunId: revRunId,
      reason: staleMsg
    };
  }

  // Clean & Fresh -> Transition to WAITING_HUMAN / Human Approval
  const completionPacket = {
    parentKey,
    graphFingerprint: parent.graphFingerprint,
    baseSha: parentBaseSha,
    integrationHeadSha,
    children: tasks.map((t) => t.issueKey),
    reviewedShas: Object.fromEntries(tasks.map((t) => [t.issueKey, t.reviewedSha || null])),
    integratedShas: Object.fromEntries(integrations.map((i) => [i.issueKey, i.commit || null])),
    verification: verificationResult,
    integrationReview: persistedReview,
    warnings: [],
    collectedAt: new Date().toISOString()
  };

  store.updateParentExecutionState(parentKey, "waiting_human", {
    integrationHeadSha,
    completionPacket
  });

  recordParentTelemetryEvent(store, {
    parentKey,
    event: "waiting_human",
    stage: "terminal",
    status: "completed",
    metadata: { parentKey, integrationHeadSha, completionPacket }
  });

  // If WorkSource provider writes are enabled, optionally transition external item to human_approval
  let ws = options.workSource;
  if (!ws) {
    try {
      ws = createWorkSourceProvider(settings);
    } catch {
      ws = null;
    }
  }
  if (ws && ws.writeEnabled && settings.data?.policy?.externalWritesEnabled) {
    try {
      await safeWorkSourceMutate(ws, settings, "transition", parentKey, "human_approval", {});
      await safeWorkSourceMutate(ws, settings, "addComment", parentKey, `## Parent Integration Complete\nIntegration branch \`${parent.integrationBranch}\` is reviewed and ready for human approval.`);
    } catch {}
  }

  return {
    ok: true,
    verdict: "clean",
    parentState: "waiting_human",
    reviewRunId: revRunId,
    completionPacket,
    review: persistedReview
  };
}

/**
 * Reconcile one active parent execution lifecycle step.
 */
export async function reconcileParentExecution(settings, store, parentKey, options = {}) {
  const parent = store.getParentExecution(parentKey);
  if (!parent) return { ok: false, reason: `Unknown parent: ${parentKey}` };

  if (parent.state === "blocked" || parent.state === "waiting_human" || parent.state === "human_approval") {
    return { ok: true, state: parent.state, terminal: true };
  }

  // 1. Reconcile children readiness
  const childReconcile = reconcileParentChildren(settings, store, parentKey, options);

  // 2. Check if all children are integrated
  const tasks = store.listEpicTasks(parentKey);
  const integrations = store.listEpicIntegrations(parentKey);

  const totalTasks = tasks.length;
  const integratedTasks = tasks.filter((t) => {
    const int = integrations.find((i) => i.issueKey === t.issueKey);
    return int?.state === "integrated";
  }).length;

  const hasConflict = integrations.some((i) => i.state === "conflict" || i.state === "blocked-conflict");
  if (hasConflict) {
    store.updateParentExecutionState(parentKey, "blocked", { reason: "Integration conflict in children" });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "integration_conflict",
      stage: "terminal",
      status: "blocked",
      payload: { reason: "Integration conflict in children" }
    });
    return { ok: false, blocked: true, state: "blocked", reason: "Integration conflict in children" };
  }

  const allChildrenIntegrated = totalTasks > 0 && integratedTasks === totalTasks;
  const queueClear = integrations.every((i) => i.state === "integrated");

  if (allChildrenIntegrated && queueClear) {
    // Ready for aggregate integration review!
    if (parent.state === "active" || parent.state === "integration-review-queued") {
      const reviewRes = await runParentIntegrationReview(settings, store, parentKey, options);
      return { ok: true, state: reviewRes.parentState, reviewResult: reviewRes };
    }
  }

  return {
    ok: true,
    state: parent.state,
    totalTasks,
    integratedTasks,
    readyChildren: childReconcile.readyChildren
  };
}
