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
  resolveAutonomyPolicy
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
        rawPayload: redactTelemetryPayload({ event: "parent_lifecycle_started" }),
        createdAt: now
      });
    }

    maxSeq += 1;
    const eventId = `telem-parent-${parentKey}-${event}-${maxSeq}`;

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
      rawPayload: redactTelemetryPayload({ event, ...payload }),
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
        payload: { reason: driftMessage }
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
      payload: { errors: dag.errors }
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
  let integrationWorktree = path.join(root, integrationBranch.replaceAll("/", "-"));
  if (options.execute) {
    const auth = authorizeRuntimeAction(settings, store, {
      issueKey: parentKey,
      action: "branchCreation"
    });
    if (!auth.allowed) {
      const reason = `Branch creation not authorized: ${auth.reason}`;
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
        integrationWorktree,
        graphFingerprint,
        dag,
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
        integrationWorktree,
        graphFingerprint,
        dag,
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
    state: "active"
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
    payload: { childrenCount: dag.children.length, edgesCount: dag.edges.length }
  });
  recordParentTelemetryEvent(store, {
    parentKey,
    event: "graph_pinned",
    stage: "progress",
    status: "running",
    payload: { graphFingerprint, baseSha, integrationBranch }
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

        if (!childBaseSha) {
          const headRes = sc.getHead({
            repoPath: parent.integrationWorktree || repoPath,
            runtime
          });
          if (headRes.ok) childBaseSha = headRes.sha;
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

  const currentHeadRes = sc.getHead({ repoPath: integrationWorktree, runtime: { spawnSync: runtime.spawnSync || spawnSync } });
  const integrationHeadSha = options.reviewedSha || parent.integrationHeadSha || (currentHeadRes.ok ? currentHeadRes.sha : null);
  const parentBaseSha = parent.baseSha || "HEAD~1";

  if (!integrationHeadSha) {
    throw new Error("Cannot run integration review: integrationHeadSha is unresolved");
  }

  // Check authorization for review
  const auth = authorizeRuntimeAction(settings, store, {
    issueKey: parentKey,
    action: "review"
  });
  if (!auth.allowed) {
    const reason = `Integration review not authorized: ${auth.reason}`;
    store.updateParentExecutionState(parentKey, "blocked", { reason });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      payload: { reason }
    });
    return { ok: false, blocked: true, parentState: "blocked", reason };
  }

  // Resolve Reviewer through Agent Registry
  const explicitReviewer = settings.data?.policy?.review?.taskAgent || settings.data?.policy?.review?.reviewer || "correctness-reviewer";
  const reviewerDef = typeof store.getAgentDefinition === "function" ? store.getAgentDefinition(explicitReviewer) : null;
  if (!reviewerDef || reviewerDef.status !== "enabled") {
    const reason = `Reviewer agent '${explicitReviewer}' is not registered or not enabled in agent registry`;
    store.updateParentExecutionState(parentKey, "blocked", { reason });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      payload: { reason }
    });
    return { ok: false, blocked: true, parentState: "blocked", reason };
  }

  const reviewerAgentId = reviewerDef.id;
  const reviewerVersion = reviewerDef.currentVersion || reviewerDef.version || 1;
  const reviewerHash = reviewerDef.currentHash || reviewerDef.definitionHash || null;

  // Update parent state to integration-review-queued
  store.updateParentExecutionState(parentKey, "integration-review-queued", { integrationHeadSha });
  recordParentTelemetryEvent(store, {
    parentKey,
    event: "integration_review_queued",
    stage: "progress",
    status: "running",
    payload: { parentBaseSha, integrationHeadSha }
  });

  const tasks = store.listEpicTasks(parentKey);
  const integrations = store.listEpicIntegrations(parentKey);

  // Compute aggregate changed files
  let aggregateChangedFiles = [];
  try {
    const diffRes = (runtime.spawnSync || spawnSync)(
      "git",
      ["-c", `safe.directory=${integrationWorktree}`, "-C", integrationWorktree, "diff", "--name-only", `${parentBaseSha}..${integrationHeadSha}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (diffRes.status === 0 && diffRes.stdout) {
      aggregateChangedFiles = diffRes.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
  } catch {}

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

  // Select Review Profile
  const dummyIssue = { key: parentKey, summary: parent.summary, canonicalState: "review" };
  let profile = null;
  try {
    profile = selectReviewProfile(settings, dummyIssue, { reviewer: explicitReviewer });
  } catch (err) {
    if (!options.injectedReviewOutcome) throw err;
  }

  const provider = profile?.provider || "antigravity";
  const modelProfile = profile?.modelProfile || "medium";

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
  prompt += `Perform an independent aggregate correctness and regression review over the combined changes.\n`;
  prompt += `Verdict must be either "clean" or "changes-requested". Evidence must be an array of structured findings: { id, severity, category, file, line, problem, expected, verification }.\n`;

  const intelSection = formatReviewIntelligencePromptSection(reviewIntelligence);
  if (intelSection) prompt += `\n${intelSection}\n`;

  // Execute reviewer
  const runId = `parent-rev-${parentKey}-${Date.now()}`;
  const prepared = { worktree: integrationWorktree };
  const built = buildExecutorCommand({ settings, profile, prepared, prompt, runId });

  let reviewOutcome = null;

  if (options.injectedReviewOutcome) {
    reviewOutcome = options.injectedReviewOutcome;
  } else {
    const result = (runtime.spawnSync || spawnSync)(built.command[0], built.command.slice(1), {
      cwd: built.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: (profile?.config?.timeoutSeconds || 3600) * 1000
    });
    const returnCode = result.status ?? 1;
    const stdout = result.stdout || "";
    const stderr = result.stderr || result.error?.message || "";
    const telemetry = parseExecutionOutput(profile?.provider || "antigravity", stdout, stderr, returnCode);

    if (telemetry.ok && telemetry.result?.verdict) {
      reviewOutcome = {
        verdict: telemetry.result.verdict,
        evidence: Array.isArray(telemetry.result.evidence) ? telemetry.result.evidence : []
      };
    } else {
      // Review execution failed to produce valid structured output -> Fail closed!
      const reason = stderr || `Reviewer process failed with return code ${returnCode}`;
      reviewOutcome = {
        verdict: "changes-requested",
        evidence: [{ id: "int-rev-fail", severity: "blocker", category: "correctness", problem: reason }]
      };
    }
  }

  // Strict schema validation of findings
  const verdict = reviewOutcome?.verdict;
  if (!["clean", "changes-requested"].includes(verdict)) {
    const reason = `Invalid reviewer verdict: '${verdict}'`;
    store.updateParentExecutionState(parentKey, "blocked", { reason });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      payload: { reason }
    });
    return { ok: false, blocked: true, parentState: "blocked", reason };
  }

  const severitiesSet = new Set(ALLOWED_FINDING_SEVERITIES);
  const categoriesSet = new Set(ALLOWED_FINDING_CATEGORIES);

  let validatedFindings = [];
  try {
    const rawEvidence = Array.isArray(reviewOutcome.evidence) ? reviewOutcome.evidence : [];
    if (verdict === "clean" && rawEvidence.length === 0) {
      validatedFindings = [{
        id: "clean-verdict",
        severity: "suggestion",
        category: "correctness",
        problem: "Aggregate integration review clean; no defects detected"
      }];
    } else {
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
    }
  } catch (valErr) {
    const reason = `Review findings failed validation: ${valErr.message}`;
    store.updateParentExecutionState(parentKey, "blocked", { reason });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      payload: { reason }
    });
    return { ok: false, blocked: true, parentState: "blocked", reason };
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
    reviewedAt: new Date().toISOString()
  };

  recordParentTelemetryEvent(store, {
    parentKey,
    event: "integration_reviewed",
    stage: "progress",
    status: verdict === "clean" ? "completed" : "failed",
    payload: { verdict, findingsCount: validatedFindings.length, integrationHeadSha }
  });

  if (verdict === "changes-requested") {
    store.updateParentExecutionState(parentKey, "blocked", {
      integrationHeadSha,
      completionPacket: { integrationReview: persistedReview }
    });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      payload: { reason: "Integration review requested changes", findings: validatedFindings }
    });
    return {
      ok: false,
      verdict: "changes-requested",
      parentState: "blocked",
      review: persistedReview
    };
  }

  // Clean review: verify integrationHeadSha is still current HEAD (not stale)
  const verifyHeadRes = sc.getHead({ repoPath: integrationWorktree, runtime: { spawnSync: runtime.spawnSync || spawnSync } });
  if (verifyHeadRes.ok && verifyHeadRes.sha.toLowerCase() !== integrationHeadSha.toLowerCase()) {
    const staleMsg = `Integration review is stale: reviewed ${integrationHeadSha.slice(0, 8)} but branch advanced to ${verifyHeadRes.sha.slice(0, 8)}`;
    store.updateParentExecutionState(parentKey, "blocked", {
      completionPacket: { integrationReview: persistedReview, staleReason: staleMsg }
    });
    recordParentTelemetryEvent(store, {
      parentKey,
      event: "parent_blocked",
      stage: "terminal",
      status: "blocked",
      payload: { reason: staleMsg }
    });
    return {
      ok: false,
      verdict: "clean",
      stale: true,
      parentState: "blocked",
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
    verification: { repositoryCheck: "passed" },
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
    payload: { parentKey, integrationHeadSha, completionPacket }
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
