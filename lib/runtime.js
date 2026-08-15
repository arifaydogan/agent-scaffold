import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { evaluateIssue, resolveOperatingMode, resolveAutonomyPolicy } from "./policy.js";
import {
  buildExecutorCommand,
  parseExecutionOutput,
  selectExecutionProfile,
  selectReviewProfile,
  configuredExecutors
} from "./executor.js";
import {
  createOrchestratorProvider,
  selectedOrchestratorProviderName
} from "./orchestrator.js";
import { parseGitStatus, validateChangedFiles, intersectPathScopes } from "./scope.js";
import { RunStore } from "./store.js";
import { prepareWorktree } from "./worktree.js";
import { discoverWorkItems, createWorkSourceProvider, WorkSourceProvider } from "./work-source.js";
import {
  normalizeUsage,
  calculateCost,
  classifyError,
  deriveExecutionTimings,
  buildProviderHealth,
  buildRunObservability,
  buildObservabilitySummary,
  redactTelemetryPayload
} from "./telemetry.js";
import {
  collectCodeIntelligenceContext,
  collectReviewIntelligence,
  formatCodeIntelligencePromptSection,
  formatReviewIntelligencePromptSection,
  createCodeIntelligenceProvider
} from "./code-intelligence.js";

export {
  discoverWorkItems,
  createWorkSourceProvider,
  WorkSourceProvider,
  normalizeUsage,
  calculateCost,
  classifyError,
  deriveExecutionTimings,
  buildProviderHealth,
  buildRunObservability,
  buildObservabilitySummary,
  redactTelemetryPayload,
  collectCodeIntelligenceContext,
  collectReviewIntelligence,
  formatCodeIntelligencePromptSection,
  formatReviewIntelligencePromptSection,
  createCodeIntelligenceProvider
};

export function createConfigSnapshot(settings, issue, plan = {}, options = {}) {
  const operatingMode = resolveOperatingMode(settings);
  const autonomy = resolveAutonomyPolicy(settings);
  const orchestratorProvider = plan?.orchestratorProvider || selectedOrchestratorProviderName(settings);

  const persona = plan?.persona || "backend-engineer";
  const taskAgent = plan?.taskAgent || plan?.persona || "backend-engineer";

  let agentRecord = null;
  let reviewAgentRecord = null;
  try {
    const store = options?.store || (settings?.data && getStore(settings));
    if (store && typeof store.getAgentDefinition === "function") {
      if (taskAgent) agentRecord = store.getAgentDefinition(taskAgent);
    }
  } catch {}

  const executionProfile = settings?.data?.executor
    ? (plan?.execution || selectExecutionProfile(settings, issue, {
        ...plan,
        agentExecutor: agentRecord?.definition?.executor || null,
        taskAgent
      }))
    : null;

  const explicitPolicyReviewer = settings?.data?.policy?.review?.taskAgent || settings?.data?.policy?.review?.reviewer || null;
  const builderReviewer = agentRecord?.definition?.reviewer || plan?.reviewer || null;
  const reviewTaskAgent = explicitPolicyReviewer || builderReviewer || "correctness-reviewer";
  const reviewPersona = settings?.data?.policy?.review?.persona || reviewTaskAgent;

  try {
    const store = options?.store || (settings?.data && getStore(settings));
    if (store && typeof store.getAgentDefinition === "function") {
      if (reviewTaskAgent) reviewAgentRecord = store.getAgentDefinition(reviewTaskAgent);
    }
  } catch {}

  const reviewProfile = selectReviewProfile(settings, issue, { ...plan, reviewer: reviewTaskAgent });
  const reviewEffort = reviewProfile?.effort || "medium";

  const recommendedExecutor = plan?.executor || executionProfile?.recommendedExecutor || null;
  const recommendedModel = plan?.model || executionProfile?.recommendedModel || null;
  const recommendedProfile = plan?.modelProfile || executionProfile?.recommendedProfile || null;
  const recommendedEffort = plan?.effort || executionProfile?.recommendedEffort || null;

  return {
    operatingMode,
    orchestratorProvider,
    executorProvider: executionProfile?.provider || settings?.data?.executor?.defaultProvider || "codex",
    executorModel: executionProfile?.model || null,
    executorModelProfile: executionProfile?.modelProfile || null,
    executorEffort: executionProfile?.effort || "medium",
    recommendedExecutor,
    recommendedModel,
    recommendedProfile,
    recommendedEffort,
    reviewProvider: reviewProfile?.provider || settings?.data?.policy?.review?.provider || "antigravity",
    reviewModel: reviewProfile?.model || null,
    reviewModelProfile: reviewProfile?.modelProfile || null,
    reviewPersona,
    reviewTaskAgent,
    reviewEffort,
    reviewAgentId: reviewTaskAgent,
    reviewAgentVersion: plan?.reviewAgentVersion || reviewAgentRecord?.version || null,
    reviewAgentHash: plan?.reviewAgentHash || reviewAgentRecord?.definitionHash || null,
    policyVersion: settings?.data?.policy?.version || 1,
    autonomy,
    agentId: taskAgent,
    agentVersion: plan?.agentVersion || agentRecord?.version || null,
    agentHash: plan?.agentHash || agentRecord?.definitionHash || null,
    persona,
    taskAgent,
    skills: plan?.skills || agentRecord?.definition?.skills || [],
    capabilities: plan?.capabilities || agentRecord?.definition?.capabilities || ["code-intelligence", "git"],
    reviewer: plan?.reviewer || builderReviewer || "correctness-reviewer",
    risk: plan?.risk || agentRecord?.definition?.risk || "normal",
    parallelSafe: plan?.parallelSafe ?? true,
    allowedPaths: plan?.allowedPaths || agentRecord?.definition?.allowedPaths || [],
    dependencies: plan?.dependencies || [],
    rationale: plan?.rationale || plan?.reasons || [],
    metadata: plan?.metadata || {},
    maxConcurrency: plan?.maxConcurrency || agentRecord?.definition?.maxConcurrency || settings?.data?.policy?.maxConcurrency || 1,
    maxReworkAttempts: settings?.data?.policy?.review?.maxReworkAttempts ?? 3,
    pricing: settings?.data?.policy?.pricing ? JSON.parse(JSON.stringify(settings.data.policy.pricing)) : (settings?.data?.pricing ? JSON.parse(JSON.stringify(settings.data.pricing)) : null),
    codeIntelligence: plan?.codeIntelligence ? JSON.parse(JSON.stringify(plan.codeIntelligence)) : (options?.codeIntelligence ? JSON.parse(JSON.stringify(options.codeIntelligence)) : null),
    createdAt: new Date().toISOString()
  };
}

export function issuePlan(settings, issue, options = {}) {
  const snapshot = options.originatingRun?.payload?.configSnapshot || options.originatingRun?.configSnapshot || null;

  const route = snapshot
    ? {
        persona: snapshot.persona,
        taskAgent: snapshot.taskAgent || snapshot.persona,
        skills: snapshot.skills || [],
        risk: snapshot.risk || "normal",
        parallelSafe: snapshot.parallelSafe ?? true,
        allowedPaths: snapshot.allowedPaths || [],
        dependencies: snapshot.dependencies || [],
        rationale: snapshot.rationale || snapshot.reasons || ["Pinned from snapshot"],
        reasons: snapshot.reasons || snapshot.rationale || ["Pinned from snapshot"],
        executor: snapshot.recommendedExecutor || snapshot.executorProvider,
        model: snapshot.recommendedModel || snapshot.executorModel,
        modelProfile: snapshot.recommendedProfile || snapshot.executorModelProfile,
        effort: snapshot.recommendedEffort || snapshot.executorEffort,
        metadata: snapshot.metadata || {}
      }
    : createOrchestratorProvider(settings, options.runtime).plan(issue, { settings, ...options });

  const taskAgent = route.taskAgent || route.persona;
  const store = options.store || getStore(settings);
  let agentRecord = null;
  if (store && typeof store.getAgentDefinition === "function" && taskAgent) {
    try {
      agentRecord = store.getAgentDefinition(taskAgent);
    } catch {}
  }

  // 1. Path scopes: 3-way fail-closed intersection (orchestratorAllowedPaths, agentDefinition.allowedPaths, hardPolicyTaskAgentScope)
  const configuredPathScopes = settings.data?.policy?.pathScopes;
  let allowedPaths;
  if (snapshot?.allowedPaths !== undefined) {
    allowedPaths = snapshot.allowedPaths;
  } else {
    let basePaths = Array.isArray(route.allowedPaths) ? route.allowedPaths : [];
    if (agentRecord && Array.isArray(agentRecord.definition?.allowedPaths)) {
      const agentPaths = agentRecord.definition.allowedPaths;
      if (agentPaths.length === 0 || basePaths.length === 0) {
        basePaths = [];
      } else {
        basePaths = intersectPathScopes(basePaths, agentPaths);
      }
    }
    if (configuredPathScopes !== undefined && configuredPathScopes !== null) {
      const agentHardScope = configuredPathScopes[taskAgent];
      if (!Array.isArray(agentHardScope) || agentHardScope.length === 0 || basePaths.length === 0) {
        basePaths = [];
      } else {
        basePaths = intersectPathScopes(basePaths, agentHardScope);
      }
    }
    allowedPaths = basePaths;
  }

  // 2. Skills containment: orchestrator must not assign skills outside registered agent definition
  let skills;
  if (snapshot?.skills !== undefined) {
    skills = snapshot.skills;
  } else if (agentRecord && Array.isArray(agentRecord.definition?.skills)) {
    const regSkills = agentRecord.definition.skills;
    if (Array.isArray(route.skills) && route.skills.length > 0) {
      skills = route.skills.filter(s => regSkills.includes(s));
      if (skills.length === 0 && regSkills.length > 0) skills = [...regSkills];
    } else {
      skills = [...regSkills];
    }
  } else {
    skills = Array.isArray(route.skills) ? route.skills : [];
  }

  // 3. Capabilities containment:
  let capabilities;
  if (snapshot?.capabilities !== undefined) {
    capabilities = snapshot.capabilities;
  } else if (agentRecord && Array.isArray(agentRecord.definition?.capabilities)) {
    const regCaps = agentRecord.definition.capabilities;
    if (Array.isArray(route.capabilities) && route.capabilities.length > 0) {
      capabilities = route.capabilities.filter(c => regCaps.includes(c));
      if (capabilities.length === 0 && regCaps.length > 0) capabilities = [...regCaps];
    } else {
      capabilities = [...regCaps];
    }
  } else {
    capabilities = Array.isArray(route.capabilities) ? route.capabilities : ["code-intelligence", "git"];
  }

  // 4. Risk floor: agent definition risk is a floor (high risk agent cannot execute as low)
  let risk;
  if (snapshot?.risk !== undefined) {
    risk = snapshot.risk;
  } else if (agentRecord?.definition?.risk === "high" || route.risk === "high") {
    risk = "high";
  } else if (agentRecord?.definition?.risk === "normal" || route.risk === "normal") {
    risk = "normal";
  } else {
    risk = "low";
  }

  const reviewer = snapshot?.reviewer || agentRecord?.definition?.reviewer || "correctness-reviewer";
  const maxConcurrency = snapshot?.maxConcurrency || agentRecord?.definition?.maxConcurrency || settings.data?.policy?.maxConcurrency || 2;

  let execution = null;
  if (settings.data?.executor) {
    if (snapshot?.executorProvider) {
      const config = configuredExecutors(settings)[snapshot.executorProvider];
      const model = snapshot.executorModel || config?.modelProfiles?.[snapshot.executorModelProfile] || config?.defaultModel || null;
      execution = {
        provider: snapshot.executorProvider,
        config,
        persona: snapshot.persona,
        taskAgent: snapshot.taskAgent || snapshot.persona,
        agent: snapshot.taskAgent || snapshot.persona,
        model,
        modelProfile: snapshot.executorModelProfile || "medium",
        effort: snapshot.executorEffort || "medium",
        mode: config?.mode || "accept-edits"
      };
    } else {
      execution = selectExecutionProfile(settings, issue, {
        ...route,
        agentExecutor: agentRecord?.definition?.executor || null,
        taskAgent,
        executor: route.executor || null,
        model: route.model !== undefined ? route.model : null,
        modelProfile: route.modelProfile !== undefined ? route.modelProfile : null
      });
    }
  }

  const issueType = issue.issueType || issue.fields?.issuetype?.name || "Task";
  const epicKey = issue.epicKey || issue.parentKey || issue.fields?.parent?.key || null;
  const epicBranch = issue.epicBranch || (epicKey ? `epic/${epicKey.toLowerCase()}` : "HEAD");

  const worktree = prepareWorktree({
    repoPath: settings.repoPath,
    root: settings.worktreeRoot,
    issueKey: issue.key,
    summary: issue.summary,
    issueType,
    epicBranch,
    epicKey
  });
  const branchReasons = epicKey && worktree.baseRefError ? [worktree.baseRefError] : [];

  const rawPlan = {
    issue: issue.key,
    summary: issue.summary,
    epicKey,
    labels: issue.labels || [],
    ...route,
    persona: route.persona,
    taskAgent: route.taskAgent || route.persona,
    agentId: taskAgent,
    agentVersion: snapshot?.agentVersion || agentRecord?.version || null,
    agentHash: snapshot?.agentHash || agentRecord?.definitionHash || null,
    skills,
    capabilities,
    risk,
    reviewer,
    maxConcurrency,
    workSource: issue.source || { provider: "local", id: issue.key, url: null },
    orchestratorProvider: snapshot?.orchestratorProvider || selectedOrchestratorProviderName(settings),
    codeIntelligence: options.codeIntelligence || snapshot?.codeIntelligence || route.codeIntelligence || null,
    allowedPaths,
    execution,
    metadata: snapshot?.metadata || route.metadata || {},
    ...worktree
  };

  const configSnapshot = snapshot || createConfigSnapshot(settings, issue, rawPlan, { store, codeIntelligence: rawPlan.codeIntelligence });
  const planWithSnapshot = { ...rawPlan, configSnapshot };

  const action = options.action || (
    issue.canonicalState === "review"
      ? "review"
      : issue.canonicalState === "rework"
      ? "rework"
      : "implementation"
  );

  const eligibility = evaluateIssue(issue, settings.data?.policy, {
    settings,
    store: options.store,
    approved: options.approved,
    action,
    attempt: options.attempt || 0,
    plan: planWithSnapshot,
    originatingRun: options.originatingRun
  });

  return {
    ...planWithSnapshot,
    eligible: eligibility.allowed && branchReasons.length === 0,
    eligibilityReasons: [...eligibility.reasons, ...branchReasons]
  };
}

export function getStore(settings) {
  if (settings?._store) return settings._store;
  return new RunStore(
    path.join(path.dirname(settings.source), ".agent-runtime", "runs.sqlite3")
  );
}

export function materializeWorkspaceInstructions(settings, worktree) {
  const relativePaths = [
    "AGENTS.md",
    "ORCHESTRATION.md",
    "PACEBUILD_ORCHESTRATOR.md",
    ".agents"
  ];
  if (worktree) {
    fs.mkdirSync(worktree, { recursive: true });
  }
  for (const relativePath of relativePaths) {
    const source = path.join(settings.repoPath, relativePath);
    const target = path.join(worktree, relativePath);
    if (fs.existsSync(source) && !fs.existsSync(target)) {
      fs.cpSync(source, target, { recursive: true });
    }
  }
  const instructionFiles = [
    path.join(worktree, "AGENTS.md"),
    path.join(worktree, "ORCHESTRATION.md"),
    path.join(worktree, "PACEBUILD_ORCHESTRATOR.md"),
    path.join(worktree, ".agents", "rules", "orchestration-gates.md")
  ];
  return {
    instructionFiles,
    missing: instructionFiles.filter((file) => !fs.existsSync(file))
  };
}

// Maximum number of progress events to persist per run (bounded).
const MAX_PROGRESS_EVENTS = 20;

// Redact values that look like secrets or long tokens from progress text.
// Covers: long base64 strings, Bearer auth headers, JWT segments (dot-separated base64),
// and plain long alphanumeric API-key patterns.
function redactProgressText(text) {
  if (!text || typeof text !== "string") return text;
  return text
    // Bearer <token> and Authorization headers
    .replace(/\bBearer\s+[A-Za-z0-9+/_.~-]{10,}/gi, "Bearer [redacted]")
    // JWT-like three-part dotted tokens (header.payload.signature)
    .replace(/\b[A-Za-z0-9+/_-]{10,}\.[A-Za-z0-9+/_-]{10,}\.[A-Za-z0-9+/_-]{10,}\b/g, "[redacted]")
    // Long base64 or alphanumeric secrets (20+ chars)
    .replace(/\b[A-Za-z0-9+/]{20,}={0,2}\b/g, "[redacted]");
}

/**
 * Stream an antigravity provider run asynchronously.
 * - Persists "queued" BEFORE spawning.
 * - Spawns the process (non-blocking).
 * - Streams structured JSON lines from stdout into bounded, redacted progress events.
 * - Persists started/model_selected/progress/terminal outcome.
 * - Resolves when the process exits.
 *
 * @param {object} params
 * @param {RunStore} params.store
 * @param {string} params.runId
 * @param {object} params.built  - result of buildExecutorCommand
 * @param {object} params.profile
 * @param {object} params.plan
 * @param {object} params.prepared
 * @param {number} params.timeoutMs
 * @returns {Promise<{exitCode: number, telemetry: object, scope: object}>}
 */
export function spawnProviderAsync(params, runtime = { spawn }) {
  const {
    store,
    runId,
    built,
    profile,
    plan,
    prepared,
    timeoutMs,
    issueKey = "",
    workerLeaseSeconds = 90,
    heartbeatMs = 0,
    successState = "verifying"
  } = params;
  const workerLeaseId = runId + ":" + Date.now();
  const leaseExpiry = () =>
    new Date(Date.now() + Math.max(1, workerLeaseSeconds) * 1000).toISOString();

  // CRITICAL: persist queued BEFORE spawning so the control plane is aware.
  store.transition(runId, "queued", {
    provider: profile.provider,
    agent: profile.agent,
    model: profile.model,
    modelProfile: profile.modelProfile,
    command: built.redactedCommand,
    cwd: built.cwd,
    logFile: built.logFile,
    workerLeaseId,
    workerLeaseExpiresAt: leaseExpiry()
  });

  // Record durable canonical telemetry queued event BEFORE spawn
  if (typeof store.recordTelemetryEvent === "function") {
    store.recordTelemetryEvent({
      eventId: `telem-${runId}-1-queued`,
      runId,
      issueKey: issueKey || plan?.issue || "",
      role: plan?.role || (plan?.type === "review" ? "reviewer" : (plan?.attempt > 0 ? "rework" : "implementation")),
      action: plan?.action || (plan?.type === "review" ? "review" : (plan?.attempt > 0 ? "rework" : "implementation")),
      attempt: plan?.attempt || 0,
      persona: plan?.persona || profile?.persona || null,
      taskAgent: plan?.taskAgent || profile?.taskAgent || null,
      agentVersion: plan?.agentVersion ?? null,
      agentHash: plan?.agentHash || null,
      provider: profile?.provider,
      model: profile?.model,
      modelProfile: profile?.modelProfile,
      effort: profile?.effort,
      stage: "queued",
      status: "queued",
      sequence: 1
    });
  }

  return new Promise((resolve) => {
    let progressCount = 0;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let modelSelectedEmitted = false;
    let killed = false;
    const collectedStdout = [];
    const spawnFn = runtime?.spawn || spawn;
    const child = spawnFn(built.command[0], built.command.slice(1), {
      cwd: built.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const pid = typeof child?.pid === "number" ? child.pid : null;

    // Immediately persist "started" state after spawn returns with child PID.
    store.transition(runId, "started", {
      provider: profile.provider,
      model: profile.model,
      pid,
      workerLeaseId,
      workerLeaseExpiresAt: leaseExpiry()
    });

    let timeoutHandle = null;
    let heartbeatHandle = null;

    const finishTimeout = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (heartbeatHandle) clearInterval(heartbeatHandle);
    };

    if (timeoutMs && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        killed = true;
        finishTimeout();
        try {
          if (child && !child.killed) child.kill("SIGTERM");
        } catch {
          // Process may have already exited.
        }
        store.transition(runId, "failed", {
          reason: `Provider timed out after ${timeoutMs}ms`,
          provider: profile.provider,
          model: profile.model,
          pid
        });
        if (typeof store.recordTelemetryEvent === "function") {
          store.recordTelemetryEvent({
            eventId: `telem-${runId}-term-timeout`,
            runId,
            issueKey: issueKey || plan?.issue || "",
            role: plan?.role || (plan?.type === "review" ? "reviewer" : (plan?.attempt > 0 ? "rework" : "implementation")),
            action: plan?.action || (plan?.type === "review" ? "review" : (plan?.attempt > 0 ? "rework" : "implementation")),
            attempt: plan?.attempt || 0,
            provider: profile?.provider,
            model: profile?.model,
            stage: "terminal",
            status: "failed",
            sequence: 999,
            error: { category: "provider_timeout", safeMessage: `Provider timed out after ${timeoutMs}ms` }
          });
        }
        store.releaseLock(issueKey, runId);
        resolve({
          exitCode: 2,
          telemetry: { ok: false, error: "timeout" },
          scope: buildScopeResult(prepared, plan, 2, runtime)
        });
      }, timeoutMs);
    }

    if (heartbeatMs && heartbeatMs > 0) {
      heartbeatHandle = setInterval(() => {
        store.heartbeatWorker(runId, {
          workerLeaseId,
          workerLeaseExpiresAt: leaseExpiry()
        });
      }, heartbeatMs);
    }

    // Record started telemetry event
    if (typeof store.recordTelemetryEvent === "function") {
      store.recordTelemetryEvent({
        eventId: `telem-${runId}-2-started`,
        runId,
        issueKey: issueKey || plan?.issue || "",
        role: plan?.role || (plan?.type === "review" ? "reviewer" : (plan?.attempt > 0 ? "rework" : "implementation")),
        action: plan?.action || (plan?.type === "review" ? "review" : (plan?.attempt > 0 ? "rework" : "implementation")),
        attempt: plan?.attempt || 0,
        persona: plan?.persona || profile?.persona || null,
        taskAgent: plan?.taskAgent || profile?.taskAgent || null,
        agentVersion: plan?.agentVersion ?? null,
        agentHash: plan?.agentHash || null,
        provider: profile?.provider,
        model: profile?.model,
        modelProfile: profile?.modelProfile,
        effort: profile?.effort,
        stage: "started",
        status: "running",
        sequence: 2,
        raw: { pid }
      });
    }

    child.stdout?.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop(); // Retain incomplete trailing line.

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        collectedStdout.push(trimmed);

        // Try to parse model info as early as possible.
        if (!modelSelectedEmitted) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.model || parsed.selected_model) {
              modelSelectedEmitted = true;
              const selectedModel = parsed.model || parsed.selected_model || profile.model;
              store.transition(runId, "model_selected", {
                provider: profile.provider,
                model: selectedModel,
                pid,
                workerLeaseId,
                workerLeaseExpiresAt: leaseExpiry()
              });
              if (typeof store.recordTelemetryEvent === "function") {
                store.recordTelemetryEvent({
                  eventId: `telem-${runId}-3-model_selected`,
                  runId,
                  issueKey: issueKey || plan?.issue || "",
                  role: plan?.role || (plan?.type === "review" ? "reviewer" : (plan?.attempt > 0 ? "rework" : "implementation")),
                  action: plan?.action || (plan?.type === "review" ? "review" : (plan?.attempt > 0 ? "rework" : "implementation")),
                  attempt: plan?.attempt || 0,
                  provider: profile?.provider,
                  model: selectedModel,
                  stage: "model_selected",
                  status: "running",
                  sequence: 3
                });
              }
            }
          } catch {
            // Non-JSON stdout lines are normal human-readable output.
          }
        }

        // Emit bounded, redacted progress events.
        if (progressCount < MAX_PROGRESS_EVENTS) {
          progressCount++;
          store.transition(runId, "progress", {
            provider: profile.provider,
            model: profile.model,
            pid,
            workerLeaseId,
            workerLeaseExpiresAt: leaseExpiry(),
            text: redactProgressText(trimmed)
          });
          if (typeof store.recordTelemetryEvent === "function") {
            store.recordTelemetryEvent({
              eventId: `telem-${runId}-prog-${progressCount}`,
              runId,
              issueKey: issueKey || plan?.issue || "",
              role: plan?.role || (plan?.type === "review" ? "reviewer" : (plan?.attempt > 0 ? "rework" : "implementation")),
              action: plan?.action || (plan?.type === "review" ? "review" : (plan?.attempt > 0 ? "rework" : "implementation")),
              attempt: plan?.attempt || 0,
              provider: profile?.provider,
              model: profile?.model,
              stage: "progress",
              status: "running",
              sequence: 10 + progressCount,
              raw: { text: redactProgressText(trimmed) }
            });
          }
        }
      }
    });

    child.stderr?.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.once("error", (error) => {
      finishTimeout();
      if (killed) return;
      store.transition(runId, "failed", {
        reason: error.message,
        provider: profile.provider,
        model: profile.model,
        pid
      });
      if (typeof store.recordTelemetryEvent === "function") {
        store.recordTelemetryEvent({
          eventId: `telem-${runId}-term-error`,
          runId,
          issueKey: issueKey || plan?.issue || "",
          role: plan?.role || (plan?.type === "review" ? "reviewer" : (plan?.attempt > 0 ? "rework" : "implementation")),
          action: plan?.action || (plan?.type === "review" ? "review" : (plan?.attempt > 0 ? "rework" : "implementation")),
          attempt: plan?.attempt || 0,
          provider: profile?.provider,
          model: profile?.model,
          stage: "terminal",
          status: "failed",
          sequence: 999,
          error: { category: "provider_process_error", safeMessage: error.message }
        });
      }
      store.releaseLock(issueKey, runId);
      resolve({
        exitCode: 1,
        telemetry: { ok: false, error: error.message },
        scope: buildScopeResult(prepared, plan, 0, runtime)
      });
    });

    child.once("close", (code) => {
      finishTimeout();
      if (killed) return;
      // Flush any remaining stdout.
      if (stdoutBuffer.trim()) {
        collectedStdout.push(stdoutBuffer.trim());
      }
      const stdout = collectedStdout.join("\n");
      const returnCode = code ?? 1;
      fs.writeFileSync(
        built.logFile + ".stdio",
        "STDOUT\n" + stdout + "\n\nSTDERR\n" + stderrBuffer + "\n",
        "utf8"
      );
      const telemetry = parseExecutionOutput(
        profile.provider,
        stdout,
        stderrBuffer,
        returnCode
      );
      const scope = buildScopeResult(prepared, plan, returnCode, runtime);
      const accepted = telemetry.ok && scope.allowed;
      store.transition(
        runId,
        accepted ? successState : scope.allowed ? "failed-retryable" : "failed-scope",
        {
          returnCode,
          provider: profile.provider,
          model: profile.model,
          pid,
          conversationId: telemetry.conversationId || null,
          durationSeconds: telemetry.durationSeconds || null,
          turns: telemetry.turns || null,
          usage: telemetry.usage || null,
          permissionDenied: telemetry.permissionDenied || false,
          result: telemetry.result || null,
          scope,
          commit: committedRevision(prepared, scope, runtime),
          logFile: built.logFile
        }
      );

      const normUsage = normalizeUsage(telemetry.usage);
      if (typeof store.recordTelemetryEvent === "function") {
        store.recordTelemetryEvent({
          eventId: `telem-${runId}-term-close`,
          runId,
          issueKey: issueKey || plan?.issue || "",
          role: plan?.role || (plan?.type === "review" ? "reviewer" : (plan?.attempt > 0 ? "rework" : "implementation")),
          action: plan?.action || (plan?.type === "review" ? "review" : (plan?.attempt > 0 ? "rework" : "implementation")),
          attempt: plan?.attempt || 0,
          provider: profile?.provider,
          model: profile?.model,
          stage: "terminal",
          status: accepted ? "completed" : "failed",
          sequence: 999,
          durationMs: telemetry.durationSeconds ? Math.round(telemetry.durationSeconds * 1000) : null,
          usage: normUsage,
          error: accepted ? null : { category: scope.allowed ? "provider_process_error" : "scope_violation", safeMessage: `Process exited with code ${returnCode}` }
        });
      }

      resolve({ exitCode: accepted ? 0 : scope.allowed ? returnCode || 4 : 5, telemetry, scope });
    });
  });
}

function committedRevision(prepared, scope, runtime = { spawnSync }) {
  if ((scope.changedFiles || []).length > 0) return null;
  const spawnSyncFn = runtime?.spawnSync || spawnSync;
  const result = spawnSyncFn(
    "git",
    [
      "-c",
      `safe.directory=${prepared.worktree}`,
      "-C",
      prepared.worktree,
      "rev-parse",
      "HEAD"
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const sha = String(result.stdout || "").trim();
  return result.status === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(sha)
    ? sha.toLowerCase()
    : null;
}

function buildScopeResult(prepared, plan, returnCode, runtime = { spawnSync }) {
  const spawnSyncFn = runtime?.spawnSync || spawnSync;
  const gitStatus = spawnSyncFn(
    "git",
    ["-c", `safe.directory=${prepared.worktree}`, "-C", prepared.worktree, "status", "--porcelain=v1"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  if (gitStatus.status !== 0) {
    return {
      allowed: false,
      changedFiles: [],
      violations: [],
      reasons: ["Unable to inspect worktree changes"]
    };
  }
  const allowedPatterns = (plan?.allowedPaths && plan.allowedPaths.length > 0)
    ? plan.allowedPaths
    : (plan?.type === "review" || plan?.action === "review" || plan?.role === "reviewer" ? ["**"] : []);

  return validateChangedFiles({
    changedFiles: parseGitStatus(gitStatus.stdout),
    allowedPatterns,
    maxChangedFiles: plan?.maxChangedFiles || 30
  });
}

/**
 * Run a work item that has already been resolved locally (no work-source access required).
 * The caller supplies a canonical work-item packet from any WorkSourceProvider.
 * This is the local-run path for control-plane use without provider credentials.
 */
export function runIssueLocal(settings, issuePacket, execute, runtime = { spawnSync, spawn }) {
  return runIssue(settings, issuePacket, execute, runtime);
}

/**
 * Main run entry point. For the antigravity provider, execution is asynchronous
 * (spawn + streaming). For all other providers, execution remains synchronous
 * (spawnSync) for backward compatibility.
 *
 * Returns { exitCode, output } for synchronous paths.
 * Returns a Promise<{ exitCode, output }> for the async (antigravity) path.
 */
import { recordReviewerOutcome } from "./reconciler.js";

export function runIssue(settings, issue, execute, runtime = { spawnSync, spawn }) {
  switch (issue.canonicalState) {
    case "ready":
      return handleImplementation(settings, issue, execute, runtime);
    case "review":
      return handleReview(settings, issue, execute, runtime);
    case "rework":
      return handleRework(settings, issue, execute, runtime);
    case "human_approval":
      return handleHumanApprovalObservation(settings, issue, execute, runtime);
    default:
      return { exitCode: 0, output: { runId: null, mode: "skipped" } };
  }
}

export function handleHumanApprovalObservation(settings, issue, execute, runtime) {
  return { exitCode: 0, output: { runId: null, mode: "human_approval_observation", issue: issue.key } };
}

export function handleRework(settings, issue, execute, runtime) {
  const store = getStore(settings);
  const runs = store.listRunsDetailed(100);
  const retryableRun = runs.find(r => r.issue_key === issue.key && r.state === "failed-retryable" && r.latest_payload?.reviewOutcome);
  
  if (!retryableRun) {
    return { exitCode: 1, output: { runId: null, error: "No review findings found for rework" } };
  }
  
  const attempt = (retryableRun.latest_payload?.attempt || 0);
  const outcome = retryableRun.latest_payload.reviewOutcome;
  const originatingSnapshot = retryableRun.payload?.configSnapshot || null;
  
  return handleImplementation(settings, issue, execute, runtime, { 
    role: "rework", 
    attempt, 
    previousOutcome: outcome,
    originatingRun: retryableRun,
    configSnapshot: originatingSnapshot
  });
}

export function handleReview(settings, issue, execute, runtime = { spawnSync, spawn }) {
  const store = getStore(settings);
  const runs = store.listRunsDetailed(100);
  const queuedRun = runs.find(r => r.issue_key === issue.key && r.state === "review-queued");
  
  if (!queuedRun) {
    return { exitCode: 1, output: { runId: null, error: "No review-queued run found" } };
  }
  
  const implementationSha = queuedRun.latest_payload?.implementationSha;
  if (!implementationSha) {
    return { exitCode: 1, output: { runId: null, error: "No implementation SHA found to review" } };
  }
  
  const originatingSnapshot = queuedRun.payload?.configSnapshot || null;
  const plan = issuePlan(settings, issue, { store, action: "review", originatingRun: queuedRun, runtime });
  const runId = store.createRun(issue.key, { ...plan, type: "review", implementationSha, configSnapshot: originatingSnapshot || plan.configSnapshot });
  
  if (!plan.eligible) {
    store.transition(runId, "blocked", { reasons: plan.eligibilityReasons });
    return { exitCode: 2, output: { runId, type: "review", ...plan } };
  }
  store.transition(runId, "eligible", plan);

  if (!execute) {
    return { exitCode: 0, output: { runId, mode: "dry-run", type: "review", implementationSha } };
  }
  
  if (!store.acquireLock(issue.key, runId)) {
    store.transition(runId, "blocked", { reason: "issue already locked" });
    return { exitCode: 3, output: { runId, error: "issue already locked" } };
  }
  store.transition(runId, "claimed");
  
  let profile;
  try {
    profile = selectReviewProfile(settings, issue, plan, originatingSnapshot);
  } catch (err) {
    console.error("selectReviewProfile error:", err);
  }
  
  if (!profile) {
    store.transition(runId, "failed", { reason: "Reviewer configuration missing or invalid" });
    store.releaseLock(issue.key, runId);
    return { exitCode: 1, output: { runId, error: "Reviewer configuration missing or invalid" } };
  }
  
  let prepared;
  try {
    prepared = prepareWorktree({
      repoPath: settings.repoPath,
      root: settings.worktreeRoot,
      issueKey: issue.key,
      summary: issue.summary,
      issueType: issue.issueType || "Task",
      epicBranch: issue.epicBranch || "HEAD",
      epicKey: issue.epicKey || null,
      execute: true,
      runtime: { spawnSync: runtime.spawnSync },
      settings,
      store,
      plan,
      originatingRun: queuedRun
    });
    // checkout the exact implementation SHA to review!
    const checkout = runtime.spawnSync("git", ["-c", `safe.directory=${prepared.worktree}`, "-C", prepared.worktree, "checkout", implementationSha], { stdio: "ignore" });
    if (checkout.status !== 0) throw new Error("git checkout failed for SHA " + implementationSha);
  } catch (error) {
    store.transition(runId, "failed", { reason: "Worktree setup failed", error: error.message });
    store.releaseLock(issue.key, runId);
    return { exitCode: 7, output: { runId, error: "Worktree setup failed" } };
  }
  store.transition(runId, "prepared", prepared);
  
  let prompt = `Review implementation for ${issue.key}: ${issue.summary}\nImplementation SHA: ${implementationSha}\nPerform a correctness review and output structured review findings.\nVerdict must be either "clean" or "changes-requested". Evidence should contain an array of findings, each matching: { id, severity, category, file, line, problem, expected, verification }.`;
  
  const reviewIntel = plan.reviewIntelligence || plan.codeIntelligence || originatingSnapshot?.codeIntelligence;
  const reviewIntelSection = formatReviewIntelligencePromptSection(reviewIntel);
  if (reviewIntelSection) {
    prompt += `\n\n${reviewIntelSection}`;
  }

  const built = buildExecutorCommand({ settings, profile, prepared, prompt, runId });
  
  const handleReviewCompletion = ({ exitCode, telemetry, scope }) => {
    try {
      const isOk = (exitCode === 0 || telemetry?.ok) && Boolean(telemetry?.result);
      const verdict = telemetry?.result?.verdict;
      const evidence = telemetry?.result?.evidence;

      const isValidVerdict = verdict === "clean" || verdict === "changes-requested";
      const isValidEvidence = Array.isArray(evidence) && (verdict === "clean" || evidence.length > 0);

      if (!isOk || !isValidVerdict || !isValidEvidence) {
        store.transition(runId, "failed-retryable", {
          reason: "Reviewer execution failed or returned invalid response",
          exitCode: exitCode || 4,
          telemetry
        });
        return {
          exitCode: exitCode || 4,
          output: {
            runId,
            returnCode: exitCode || 4,
            provider: profile.provider,
            model: profile.model,
            telemetry,
            scope,
            error: "Reviewer execution failed or returned invalid structured review"
          }
        };
      }

      try {
        recordReviewerOutcome(store, {
          runId: queuedRun.id,
          implementationSha,
          reviewerId: profile.taskAgent || "reviewer",
          verdict,
          evidence
        });
      } catch (recordError) {
        store.transition(runId, "failed-retryable", {
          reason: "Reviewer findings failed schema validation: " + recordError.message,
          exitCode: exitCode || 4,
          telemetry
        });
        return {
          exitCode: exitCode || 4,
          output: {
            runId,
            returnCode: exitCode || 4,
            provider: profile.provider,
            model: profile.model,
            telemetry,
            scope,
            error: recordError.message
          }
        };
      }

      return {
        exitCode: 0,
        output: {
          runId,
          returnCode: 0,
          provider: profile.provider,
          model: profile.model,
          telemetry,
          scope
        }
      };
    } finally {
      store.releaseLock(issue.key, runId);
    }
  };

  if (profile.provider === "antigravity") {
    return spawnProviderAsync(
      {
        store,
        runId,
        built,
        profile,
        plan: { ...plan, role: "reviewer", action: "review", type: "review" },
        prepared,
        issueKey: issue.key,
        timeoutMs: (profile.config?.timeoutSeconds || 3600) * 1000,
        workerLeaseSeconds: settings.data.supervisor?.staleAfterSeconds || 90,
        heartbeatMs: (settings.data.supervisor?.heartbeatSeconds || 10) * 1000,
        successState: "completed"
      },
      runtime
    ).then(handleReviewCompletion);
  }
  
  // Synchronous reviewer path
  store.transition(runId, "queued", {
    provider: profile.provider,
    agent: profile.agent || "reviewer",
    model: profile.model,
    modelProfile: profile.modelProfile,
    command: built.redactedCommand,
    cwd: built.cwd,
    logFile: built.logFile,
    workerLeaseId: runId + ":sync",
    workerLeaseExpiresAt: new Date(Date.now() + 3600000).toISOString()
  });

  if (typeof store.recordTelemetryEvent === "function") {
    store.recordTelemetryEvent({
      eventId: `telem-${runId}-1-queued`,
      runId,
      issueKey: issue.key,
      role: "reviewer",
      action: "review",
      attempt: plan?.attempt || 0,
      persona: profile.persona || "reviewer",
      taskAgent: profile.taskAgent || "reviewer",
      provider: profile.provider,
      model: profile.model,
      modelProfile: profile.modelProfile,
      effort: profile.effort,
      stage: "queued",
      status: "queued",
      sequence: 1
    });
  }

  store.transition(runId, "executing", {
    provider: profile.provider,
    workerLeaseId: runId + ":sync",
    workerLeaseExpiresAt: new Date(Date.now() + 3600000).toISOString()
  });

  if (typeof store.recordTelemetryEvent === "function") {
    store.recordTelemetryEvent({
      eventId: `telem-${runId}-2-started`,
      runId,
      issueKey: issue.key,
      role: "reviewer",
      action: "review",
      attempt: plan?.attempt || 0,
      persona: profile.persona || "reviewer",
      taskAgent: profile.taskAgent || "reviewer",
      provider: profile.provider,
      model: profile.model,
      modelProfile: profile.modelProfile,
      effort: profile.effort,
      stage: "started",
      status: "running",
      sequence: 2
    });
  }

  const result = runtime.spawnSync(built.command[0], built.command.slice(1), {
    cwd: built.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: (profile.config?.timeoutSeconds || 3600) * 1000
  });
  const returnCode = result.status ?? 1;
  const stdout = result.stdout || "";
  const stderr = result.stderr || result.error?.message || "";
  const telemetry = parseExecutionOutput(profile.provider, stdout, stderr, returnCode);
  const scope = { allowed: true, changedFiles: [], violations: [], reasons: [] };
  
  const isOk = (telemetry.ok && returnCode === 0);
  if (isOk) {
    store.transition(runId, "completed", { returnCode, provider: profile.provider, scope });
  }

  const normUsage = normalizeUsage(telemetry.usage);
  if (typeof store.recordTelemetryEvent === "function") {
    store.recordTelemetryEvent({
      eventId: `telem-${runId}-term-close`,
      runId,
      issueKey: issue.key,
      role: "reviewer",
      action: "review",
      attempt: plan?.attempt || 0,
      persona: profile.persona || "reviewer",
      taskAgent: profile.taskAgent || "reviewer",
      provider: profile.provider,
      model: profile.model,
      stage: "terminal",
      status: isOk ? "completed" : "failed",
      sequence: 999,
      durationMs: telemetry.durationSeconds ? Math.round(telemetry.durationSeconds * 1000) : null,
      usage: normUsage,
      error: isOk ? null : { category: "review_failure", safeMessage: `Reviewer exited with return code ${returnCode}` }
    });
  }

  return handleReviewCompletion({ exitCode: isOk ? 0 : returnCode || 4, telemetry, scope });
}

export function handleImplementation(settings, issue, execute, runtime = { spawnSync, spawn }, planOverrides = {}) {
  const store = getStore(settings);
  const action = planOverrides.role === "rework" || issue.canonicalState === "rework"
    ? "rework"
    : (planOverrides.action || "implementation");
  const attempt = planOverrides.attempt || 0;
  const originatingRun = planOverrides.originatingRun || null;

  const basePlan = issuePlan(settings, issue, {
    store,
    approved: planOverrides.approved,
    action,
    attempt,
    originatingRun,
    runtime
  });
  const plan = { ...basePlan, ...planOverrides };
  if (action === "implementation" || action === "rework") {
    if (!Array.isArray(plan.allowedPaths) || plan.allowedPaths.length === 0) {
      const agent = plan.taskAgent || plan.persona || "unknown";
      const noScopeReason = `No authorized write scope for taskAgent '${agent}'`;
      if (!plan.eligibilityReasons?.includes(noScopeReason)) {
        plan.eligibilityReasons = [...(plan.eligibilityReasons || []), noScopeReason];
      }
      plan.eligible = false;
    }
  }
  const runId = store.createRun(issue.key, plan);
  if (!plan.eligible) {
    store.transition(runId, "blocked", { reasons: plan.eligibilityReasons });
    return { exitCode: 2, output: { runId, ...plan } };
  }
  store.transition(runId, "eligible", plan);
  if (!execute) {
    return { exitCode: 0, output: { runId, mode: "dry-run", ...plan } };
  }
  if (!store.acquireLock(issue.key, runId)) {
    store.transition(runId, "blocked", { reason: "issue already locked" });
    return { exitCode: 3, output: { runId, error: "issue already locked" } };
  }
  store.transition(runId, "claimed");
  const profile = (plan.execution?.provider && plan.execution?.model)
    ? {
        ...plan.execution,
        config: configuredExecutors(settings)[plan.execution.provider] || plan.execution.config || { command: [plan.execution.provider] }
      }
    : selectExecutionProfile(settings, issue, plan);
  const issueType = issue.issueType || issue.fields?.issuetype?.name || "Task";
  const epicKey = issue.epicKey || issue.parentKey || issue.fields?.parent?.key || null;
  const epicBranch = issue.epicBranch || (epicKey ? `epic/${epicKey.toLowerCase()}` : "HEAD");

  let prepared;
  let instructionContext;
  try {
    prepared = prepareWorktree({
      repoPath: settings.repoPath,
      root: settings.worktreeRoot,
      issueKey: issue.key,
      summary: issue.summary,
      issueType,
      epicBranch,
      epicKey,
      execute: true,
      runtime: { spawnSync: runtime.spawnSync },
      settings,
      store,
      plan,
      originatingRun
    });
    instructionContext = materializeWorkspaceInstructions(settings, prepared.worktree);
  } catch (error) {
    store.transition(runId, "failed-retryable", {
      reason: "Worktree setup failed",
      error: error.message
    });
    store.releaseLock(issue.key, runId);
    return {
      exitCode: 7,
      output: { runId, error: "Worktree setup failed", detail: error.message }
    };
  }
  if (instructionContext.missing.length) {
    store.transition(runId, "blocked", {
      reason: "Workspace instructions are missing",
      missing: instructionContext.missing
    });
    store.releaseLock(issue.key, runId);
    return {
      exitCode: 6,
      output: {
        runId,
        error: "Workspace instructions are missing",
        missing: instructionContext.missing
      }
    };
  }
  store.transition(runId, "prepared", prepared);
  const providerInstruction =
    profile.provider === "antigravity"
      ? "Edit only this worktree. Do not run shell commands; return required validation commands to the scheduler."
      : "Run the relevant tests and report their results.";
  const instructionFiles = instructionContext.instructionFiles;
  const promptLines = [
    "Implement work item " + issue.key + ": " + issue.summary,
    "Workspace root: " + prepared.worktree,
    "Read these exact instruction files without listing parent directories: " +
      instructionFiles.join(" ; "),
    issue.description,
    "Assigned judgment persona: " + profile.persona,
    "Assigned task agent: " + profile.taskAgent,
    "Risk: " + plan.risk + "; parallel safe: " + plan.parallelSafe,
    "Allowed changed paths: " + plan.allowedPaths.join(", "),
    providerInstruction,
    "Follow the canonical PaceBuild approval gates. Do not push, merge, write externally, or transition the issue to Done."
  ];

  if (plan.role === "rework" && plan.previousOutcome) {
    const outcome = plan.previousOutcome;
    promptLines.push(
      `REWORK REQUIRED (Attempt ${plan.attempt + 1}):`,
      `The previous review failed. Reviewer ID: ${outcome.reviewerId}`,
      `Verdict: ${outcome.verdict}`,
      `Structured Findings:`
    );
    const evidence = outcome.evidence || [];
    for (const f of evidence) {
      if (typeof f === 'object') {
        promptLines.push(`- [${f.severity || 'info'}] ${f.file || 'unknown'}:${f.line || 'unknown'} - ${f.problem || ''} (Expected: ${f.expected || ''})`);
      } else {
        promptLines.push(`- ${f}`);
      }
    }
  }

  const codeIntel = plan.codeIntelligence || plan.configSnapshot?.codeIntelligence;
  const codeIntelSection = formatCodeIntelligencePromptSection(codeIntel);
  if (codeIntelSection) {
    promptLines.push(codeIntelSection);
  }

  const prompt = promptLines.join("\n\n");
  const built = buildExecutorCommand({
    settings,
    profile,
    prepared,
    prompt,
    runId
  });

  // Antigravity provider: async streaming path.
  // spawnProviderAsync handles all state transitions starting with "queued" (before spawn).
  // Do NOT emit "executing" here — that would appear before "queued" and break lifecycle ordering.
  if (profile.provider === "antigravity") {
    return spawnProviderAsync(
      {
        store,
        runId,
        built,
        profile,
        plan,
        prepared,
        issueKey: issue.key,
        timeoutMs: (profile.config.timeoutSeconds || 3600) * 1000,
        workerLeaseSeconds: settings.data.supervisor?.staleAfterSeconds || 90,
        heartbeatMs: (settings.data.supervisor?.heartbeatSeconds || 10) * 1000
      },
      runtime
    ).then(({ exitCode, telemetry, scope }) => ({
      exitCode,
      output: {
        runId,
        returnCode: exitCode,
        provider: profile.provider,
        model: profile.model,
        telemetry,
        scope
      }
    }));
  }

  // Non-antigravity providers: synchronous spawnSync path (backward-compatible).
  store.transition(runId, "queued", {
    provider: profile.provider,
    agent: profile.agent,
    model: profile.model,
    modelProfile: profile.modelProfile,
    command: built.redactedCommand,
    cwd: built.cwd,
    logFile: built.logFile,
    workerLeaseId: runId + ":sync",
    workerLeaseExpiresAt: new Date(
      Date.now() + (profile.config?.timeoutSeconds || 3600) * 1000
    ).toISOString()
  });

  if (typeof store.recordTelemetryEvent === "function") {
    store.recordTelemetryEvent({
      eventId: `telem-${runId}-1-queued`,
      runId,
      issueKey: issue.key || plan?.issue || "",
      role: plan?.role || (plan?.type === "review" ? "reviewer" : (plan?.attempt > 0 ? "rework" : "implementation")),
      action: plan?.action || (plan?.type === "review" ? "review" : (plan?.attempt > 0 ? "rework" : "implementation")),
      attempt: plan?.attempt || 0,
      persona: plan?.persona || profile?.persona || null,
      taskAgent: plan?.taskAgent || profile?.taskAgent || null,
      agentVersion: plan?.agentVersion ?? null,
      agentHash: plan?.agentHash || null,
      provider: profile?.provider,
      model: profile?.model,
      modelProfile: profile?.modelProfile,
      effort: profile?.effort,
      stage: "queued",
      status: "queued",
      sequence: 1
    });
  }

  store.transition(runId, "executing", {
    provider: profile.provider,
    agent: profile.agent,
    model: profile.model,
    modelProfile: profile.modelProfile,
    effort: profile.effort,
    command: built.redactedCommand,
    cwd: built.cwd,
    logFile: built.logFile,
    workerLeaseId: runId + ":sync",
    workerLeaseExpiresAt: new Date(
      Date.now() + (profile.config?.timeoutSeconds || 3600) * 1000
    ).toISOString()
  });

  if (typeof store.recordTelemetryEvent === "function") {
    store.recordTelemetryEvent({
      eventId: `telem-${runId}-2-started`,
      runId,
      issueKey: issue.key || plan?.issue || "",
      role: plan?.role || (plan?.type === "review" ? "reviewer" : (plan?.attempt > 0 ? "rework" : "implementation")),
      action: plan?.action || (plan?.type === "review" ? "review" : (plan?.attempt > 0 ? "rework" : "implementation")),
      attempt: plan?.attempt || 0,
      persona: plan?.persona || profile?.persona || null,
      taskAgent: plan?.taskAgent || profile?.taskAgent || null,
      agentVersion: plan?.agentVersion ?? null,
      agentHash: plan?.agentHash || null,
      provider: profile?.provider,
      model: profile?.model,
      modelProfile: profile?.modelProfile,
      effort: profile?.effort,
      stage: "started",
      status: "running",
      sequence: 2
    });
  }

  const result = runtime.spawnSync(built.command[0], built.command.slice(1), {
    cwd: built.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: (profile.config?.timeoutSeconds || 3600) * 1000
  });
  const returnCode = result.status ?? 1;
  const stdout = result.stdout || "";
  const stderr = result.stderr || result.error?.message || "";
  fs.writeFileSync(
    built.logFile + ".stdio",
    "STDOUT\n" + stdout + "\n\nSTDERR\n" + stderr + "\n",
    "utf8"
  );
  const telemetry = parseExecutionOutput(
    profile.provider,
    stdout,
    stderr,
    returnCode
  );
  const gitStatus = runtime.spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${prepared.worktree}`,
      "-C",
      prepared.worktree,
      "status",
      "--porcelain=v1"
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const scope =
    gitStatus.status === 0
      ? validateChangedFiles({
          changedFiles: parseGitStatus(gitStatus.stdout),
          allowedPatterns: plan.allowedPaths,
          maxChangedFiles: settings.data.policy.maxChangedFiles || 30
        })
      : {
          allowed: false,
          changedFiles: [],
          violations: [],
          reasons: ["Unable to inspect worktree changes"]
        };
  const accepted = telemetry.ok && scope.allowed;
  store.transition(
    runId,
    accepted ? "verifying" : scope.allowed ? "failed-retryable" : "failed-scope",
    {
      returnCode,
      provider: profile.provider,
      model: profile.model,
      conversationId: telemetry.conversationId || null,
      durationSeconds: telemetry.durationSeconds || null,
      turns: telemetry.turns || null,
      usage: telemetry.usage || null,
      permissionDenied: telemetry.permissionDenied || false,
      result: telemetry.result || null,
      scope,
      commit: committedRevision(prepared, scope, runtime),
      logFile: built.logFile
    }
  );

  const normUsage = normalizeUsage(telemetry.usage);
  if (typeof store.recordTelemetryEvent === "function") {
    store.recordTelemetryEvent({
      eventId: `telem-${runId}-term-close`,
      runId,
      issueKey: issue.key || plan?.issue || "",
      role: plan?.role || (plan?.type === "review" ? "reviewer" : (plan?.attempt > 0 ? "rework" : "implementation")),
      action: plan?.action || (plan?.type === "review" ? "review" : (plan?.attempt > 0 ? "rework" : "implementation")),
      attempt: plan?.attempt || 0,
      provider: profile?.provider,
      model: profile?.model,
      stage: "terminal",
      status: accepted ? "completed" : "failed",
      sequence: 999,
      durationMs: telemetry.durationSeconds ? Math.round(telemetry.durationSeconds * 1000) : null,
      usage: normUsage,
      error: accepted ? null : { category: scope.allowed ? "provider_process_error" : "scope_violation", safeMessage: `Process exited with code ${returnCode}` }
    });
  }
  return {
    exitCode: accepted ? 0 : scope.allowed ? returnCode || 4 : 5,
    output: {
      runId,
      returnCode,
      provider: profile.provider,
      model: profile.model,
      telemetry,
      scope
    }
  };
}
