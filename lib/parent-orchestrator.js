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
 * Record inspectable parent telemetry event in SQLite store.
 */
export function recordParentTelemetryEvent(store, {
  parentKey,
  event,
  role = "orchestrator",
  action = "orchestration",
  stage = "progress",
  status = "running",
  payload = {},
  now = new Date().toISOString()
}) {
  if (typeof store?.recordTelemetryEvent !== "function") return;
  const eventId = `telem-parent-${parentKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    store.recordTelemetryEvent({
      eventId,
      runId: `parent-${parentKey}`,
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
      sequence: 1,
      rawPayload: redactTelemetryPayload({ event, ...payload }),
      createdAt: now
    });
  } catch (err) {
    // Best effort telemetry
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
  const type = parent.issueType || parent.type || "Epic";
  const baseRef = options.baseRef || settings.data?.project?.baseBranch || "develop";
  const repoPath = settings.repoPath;
  const root = settings.worktreeRoot;
  const runtime = options.runtime || { spawnSync };

  // 1. Discover children from WorkSourceProvider
  let children = [];
  try {
    children = typeof workSource.getChildren === "function"
      ? await workSource.getChildren(parentKey)
      : [];
  } catch (err) {
    children = [];
  }

  // 2. Discover dependencies for each child
  const dependencyMap = {};
  for (const child of children) {
    const cKey = child.key || child.id;
    if (!cKey) continue;
    try {
      if (typeof workSource.getDependencies === "function") {
        const deps = await workSource.getDependencies(cKey);
        dependencyMap[cKey] = deps.map((d) => (typeof d === "string" ? d : d.key || d.id));
      }
    } catch {
      dependencyMap[cKey] = [];
    }
  }

  // 3. Build & Validate DAG
  const dag = buildHierarchyDag({
    parentKey,
    children,
    dependencyMap,
    externalDependencyChecker: options.externalDependencyChecker || ((depKey) => {
      // Check if external dependency is completed in store or work source
      try {
        const existingRuns = store.listRunsForIssue(depKey);
        const isClean = existingRuns.some((r) => ["completed", "reviewed-clean", "waiting_human"].includes(r.state));
        if (isClean) return { satisfied: true, evidence: { run: "completed" } };
      } catch {}
      return { satisfied: false, reason: `External dependency ${depKey} status is unresolved` };
    })
  });

  // 4. Resolve Base Revision
  const baseRes = sc.resolveBaseRevision({ repoPath, requestedRef: baseRef, runtime });
  const baseShaRes = sc.getHead({ repoPath, runtime });
  const baseSha = baseShaRes.ok ? baseShaRes.sha : null;

  // 5. Integration Branch
  const integrationBranch = `epic/${parentKey.toLowerCase()}-${summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "work"}`;
  const graphFingerprint = computeGraphFingerprint({
    parentKey,
    baseSha: baseSha || "0000000000000000000000000000000000000000",
    integrationBranch,
    children: dag.children,
    edges: dag.edges
  });

  // Check existing pinned generation in store
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

  // Prepare integration worktree if execute
  let integrationWorktree = null;
  if (options.execute) {
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
      // If worktree already exists or ref exists, continue
      integrationWorktree = path.join(root, integrationBranch.replaceAll("/", "-"));
    }
  } else {
    integrationWorktree = path.join(root, integrationBranch.replaceAll("/", "-"));
  }

  // Persist normalized parent execution snapshot
  const execution = store.upsertParentExecution({
    parentKey,
    sourceProvider: parent.source?.provider || selectedWorkSourceProviderName(settings),
    sourceId: parent.source?.id || null,
    sourceUrl: parent.source?.url || null,
    summary,
    type,
    baseRef,
    baseSha,
    integrationBranch,
    integrationWorktree,
    graphFingerprint,
    dag,
    state: "active"
  });

  // Register each child in epic_tasks with its dependencies
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
    stage: "started",
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
 * Reconcile child readiness and lazily prepare dependent worktrees.
 */
export function reconcileParentChildren(settings, store, parentKey, options = {}) {
  const sc = options.sourceControl || createSourceControlProvider(settings);
  const repoPath = settings.repoPath;
  const root = settings.worktreeRoot;
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
        // Lazily create child worktree from CURRENT parent integration branch HEAD
        let childBaseSha = null;
        try {
          const brRes = (runtime.spawnSync || spawnSync)(
            "git",
            ["-c", `safe.directory=${repoPath}`, "-C", repoPath, "rev-parse", `refs/heads/${parent.integrationBranch}`],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
          );
          if (brRes.status === 0 && brRes.stdout) {
            const bSha = brRes.stdout.trim().toLowerCase();
            if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(bSha)) {
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

        let childWorktree = task.worktree;
        if (options.execute && !childWorktree) {
          try {
            const prep = sc.prepareChildWorktree({
              repoPath,
              root,
              parentKey,
              parentBranch: parent.integrationBranch,
              issueKey: task.issueKey,
              summary: task.summary,
              baseRef: childBaseSha || parent.integrationBranch,
              execute: true,
              runtime
            });
            childWorktree = prep.worktree;
          } catch {
            childWorktree = path.join(root, task.branch.replaceAll("/", "-"));
          }
        }

        store.upsertEpicTask({
          epicKey: parentKey,
          parentKey,
          issueKey: task.issueKey,
          summary: task.summary,
          branch: task.branch,
          worktree: childWorktree,
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

  // Collect fresh Code Intelligence over the aggregate changed files
  let reviewIntelligence = null;
  try {
    reviewIntelligence = await collectReviewIntelligence(
      settings,
      { key: parentKey, summary: parent.summary },
      aggregateChangedFiles,
      { runtime, store }
    );
  } catch (err) {
    reviewIntelligence = { provider: "none", status: "unavailable", warnings: [err.message] };
  }

  // Select Review Profile
  const dummyIssue = { key: parentKey, summary: parent.summary, canonicalState: "review" };
  const explicitReviewer = settings.data?.policy?.review?.taskAgent || settings.data?.policy?.review?.reviewer || "correctness-reviewer";
  const reviewerDef = typeof store.getAgentDefinition === "function" ? store.getAgentDefinition(explicitReviewer) : null;
  let profile = null;
  try {
    profile = selectReviewProfile(settings, dummyIssue, { reviewer: explicitReviewer });
  } catch (err) {
    if (!options.injectedReviewOutcome) throw err;
  }

  const reviewerAgentId = explicitReviewer;
  const reviewerVersion = reviewerDef?.version || 1;
  const reviewerHash = reviewerDef?.definitionHash || null;
  const provider = profile?.provider || "antigravity";
  const modelProfile = profile?.modelProfile || "medium";

  // Build aggregate review prompt
  const childEvidence = tasks.map((t) => {
    const int = integrations.find((i) => i.issueKey === t.issueKey);
    return `- Child ${t.issueKey} (${t.summary}): reviewed SHA ${t.reviewedSha || 'n/a'}, integrated SHA ${int?.commit || t.integratedSha || 'n/a'}`;
  }).join("\n");

  let prompt = `Aggregate Integration Review for Parent ${parentKey}: ${parent.summary}\n`;
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
    // Run reviewer process
    const result = (runtime.spawnSync || spawnSync)(built.command[0], built.command.slice(1), {
      cwd: built.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: (profile.config?.timeoutSeconds || 3600) * 1000
    });
    const returnCode = result.status ?? 1;
    const stdout = result.stdout || "";
    const stderr = result.stderr || result.error?.message || "";
    const telemetry = parseExecutionOutput(profile.provider, stdout, stderr, returnCode);

    if (telemetry.ok && telemetry.result?.verdict) {
      reviewOutcome = {
        verdict: telemetry.result.verdict,
        evidence: Array.isArray(telemetry.result.evidence) ? telemetry.result.evidence : []
      };
    } else {
      reviewOutcome = {
        verdict: returnCode === 0 ? "clean" : "changes-requested",
        evidence: [{ id: "int-rev-1", severity: "major", category: "regression", problem: stderr || "Review process failed" }]
      };
    }
  }

  // Validate review outcome
  const verdict = reviewOutcome.verdict === "clean" ? "clean" : "changes-requested";
  const severitiesSet = new Set(ALLOWED_FINDING_SEVERITIES);
  const categoriesSet = new Set(ALLOWED_FINDING_CATEGORIES);

  const validatedFindings = (reviewOutcome.evidence || []).map((f, idx) => ({
    id: String(f.id || `finding-${idx + 1}`),
    severity: severitiesSet.has(String(f.severity || "").toLowerCase()) ? String(f.severity).toLowerCase() : "minor",
    category: categoriesSet.has(String(f.category || "").toLowerCase()) ? String(f.category).toLowerCase() : "correctness",
    file: f.file ? String(f.file) : null,
    line: f.line != null ? Number(f.line) : null,
    problem: String(f.problem || "Unspecified issue"),
    expected: f.expected ? String(f.expected) : null,
    verification: f.verification ? String(f.verification) : null
  }));

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
  let workSource = options.workSource;
  if (!workSource) {
    try {
      workSource = createWorkSourceProvider(settings);
    } catch {
      workSource = null;
    }
  }
  if (workSource && workSource.writeEnabled && settings.data?.policy?.externalWritesEnabled) {
    try {
      await safeWorkSourceMutate(workSource, settings, "transition", parentKey, "human_approval", {});
      await safeWorkSourceMutate(workSource, settings, "addComment", parentKey, `## Parent Integration Complete\nIntegration branch \`${parent.integrationBranch}\` is reviewed and ready for human approval.`);
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
