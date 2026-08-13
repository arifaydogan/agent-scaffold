import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStore } from "./runtime.js";
import { updateProviderSelections } from "./config.js";
import { buildCapabilityRegistry } from "./capability-registry.js";
import { describeCodeIntelligenceProviders, selectedCodeIntelligenceProviderName } from "./code-intelligence.js";
import { describeExecutorProviders } from "./executor.js";
import { describeOrchestratorProviders, selectedOrchestratorProviderName } from "./orchestrator.js";
import { describeWorkSourceProviders, selectedWorkSourceProviderName } from "./work-source.js";
import { CANONICAL_WORKFLOW_STATES } from "./workflow.js";

const ACTIVE_STATES = new Set(["claimed", "prepared", "queued", "retry_requested", "started", "model_selected", "progress", "executing"]);
const REVIEW_STATES = new Set(["verifying", "review_queued", "reviewing", "review_fix_queued", "accepted"]);
const BLOCKED_STATES = new Set([
  "blocked",
  "human_action_required",
  "failed-retryable",
  "failed-scope",
  "failed"
]);

function stateKind(state) {
  if (ACTIVE_STATES.has(state)) return "active";
  if (REVIEW_STATES.has(state)) return "review";
  if (BLOCKED_STATES.has(state)) return "blocked";
  return "idle";
}

function tokenCount(usage = {}) {
  if (!usage || typeof usage !== "object") return 0;
  const direct = usage.total_tokens ?? usage.totalTokens;
  if (Number.isFinite(Number(direct))) return Number(direct);
  const input = Number(usage.input_tokens ?? usage.inputTokens);
  const output = Number(usage.output_tokens ?? usage.outputTokens);
  if (Number.isFinite(input) || Number.isFinite(output)) {
    return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
  }
  return 0;
}

function secondsBetween(start, end) {
  const value = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function shapeRun(run, locks, now) {
  const plan = run.payload || {};
  const latest = run.latest_payload || {};
  const execution = plan.execution || {};
  const kind = stateKind(run.state);
  const end = kind === "active" ? now : run.updated_at;
  const result = latest.result || {};
  const scope = latest.scope || {};
  const blockers = [
    ...(Array.isArray(result.blockers) ? result.blockers : []),
    ...(Array.isArray(latest.reasons) ? latest.reasons : []),
    ...(latest.reason ? [latest.reason] : []),
    ...(Array.isArray(scope.reasons) ? scope.reasons : [])
  ];
  // persona is the orchestration role (e.g. startup-cto); taskAgent is the executor role
  // (e.g. backend-engineer). For local runs the issue packet may only carry taskAgent.
  const persona = plan.persona || null;
  const taskAgent = plan.taskAgent || execution.agent || plan.persona || "unassigned";
  // progress text from the most recent progress event, redacted of secrets
  const progressText = latest.text
    ? String(latest.text).replace(/\b[A-Za-z0-9+/]{20,}={0,2}\b/g, "[redacted]")
    : null;
  let workerStatus = "finished";
  if (["claimed", "prepared", "queued", "retry_requested"].includes(run.state)) {
    workerStatus = "queued";
  } else if (["started", "model_selected", "progress", "executing"].includes(run.state)) {
    workerStatus = "running";
  }

  const workerPid = latest.pid !== undefined ? latest.pid : null;
  const usage = run.latest_usage_payload?.usage || latest.usage;

  return {
    id: run.id,
    issue: run.issue_key,
    summary: plan.summary || run.issue_key,
    state: run.state,
    stateKind: kind,
    workerStatus,
    workerPid,
    workerStartedAt: run.worker_started_at || null,
    workerLastHeartbeatAt: run.worker_last_heartbeat_at || null,
    persona,
    taskAgent,
    skills: Array.isArray(plan.skills) ? plan.skills : [],
    provider: latest.provider || execution.provider || "unassigned",
    model: latest.model || execution.model || null,
    modelProfile: execution.modelProfile || null,
    risk: plan.risk || "normal",
    parallelSafe: plan.parallelSafe !== false,
    branch: plan.branch || null,
    worktree: plan.worktree || null,
    allowedPaths: Array.isArray(plan.allowedPaths) ? plan.allowedPaths : [],
    changedFiles: Array.isArray(scope.changedFiles) ? scope.changedFiles : [],
    evidence: {
      allowed: !!scope.allowed,
      changedFiles: Array.isArray(scope.changedFiles) ? scope.changedFiles : [],
      violations: Array.isArray(scope.violations) ? scope.violations : []
    },
    resultSummary: result.summary || null,
    progressText,
    blockers: [...new Set(blockers.filter(Boolean))],
    attempt: Number(plan.attempt) || 1,
    retryOfRunId: plan.retryOfRunId || null,
    role: plan.role || "worker",
    resolution: latest.resolution || latest.blockerResolution || plan.blockerResolution || null,
    userExpectation: latest.userExpectation || null,
    blockerClass: latest.blockerClass || null,
    blockerResolved: latest.blockerResolved === true,
    humanActionRequired: latest.humanActionRequired === true,
    commit: latest.commit || null,
    testStatus: latest.testStatus || null,
    pr: latest.pr || latest.prUrl || null,
    locked: locks.has(run.issue_key),
    tokens: tokenCount(usage),
    usageAvailable: !!usage,
    turns: Number(latest.turns) || 0,
    durationSeconds: secondsBetween(run.created_at, end),
    createdAt: run.created_at,
    updatedAt: run.updated_at
  };
}

function capacity(settings, runs) {
  const providerLimits = settings.data.policy.providerConcurrency || {};
  const active = runs.filter((run) => run.workerStatus === "running");
  const queued = runs.filter((run) => run.workerStatus === "queued");
  const names = new Set([
    ...Object.keys(providerLimits),
    ...runs.map((run) => run.provider).filter((name) => name !== "unassigned")
  ]);
  return {
    total: settings.data.policy.maxConcurrency || 2,
    active: active.length,
    queued: queued.length,
    providers: [...names].sort().map((name) => ({
      name,
      limit: providerLimits[name] || settings.data.policy.maxConcurrency || 2,
      active: active.filter((run) => run.provider === name).length,
      queued: queued.filter((run) => run.provider === name).length
    }))
  };
}

function totals(runs) {
  return {
    active: runs.filter((run) => run.stateKind === "active").length,
    review: runs.filter((run) => run.stateKind === "review").length,
    blocked: runs.filter((run) => run.stateKind === "blocked").length,
    total: runs.length,
    tokens: runs.reduce((total, run) => total + run.tokens, 0)
  };
}

function epicProgress(store, runs) {
  return store.listEpics(100).map((epic) => {
    const taskRuns = runs.filter((run) => epic.tasks.some((task) => task.issueKey === run.issue));
    const usedTokens = taskRuns.reduce((total, run) => total + run.tokens, 0);
    const taskBudget = epic.tasks.reduce((total, task) => total + (Number(task.budget) || 0), 0);
    const budget = Number(epic.modelBudget) || taskBudget;
    const integrated = epic.tasks.filter((task) => task.state === "integrated").length;
    const queue = epic.integrations.filter((item) => ["queued", "integrating", "conflict"].includes(item.state));
    const ready = epic.tasks.length > 0 && integrated === epic.tasks.length && queue.length === 0;
    return {
      key: epic.key, summary: epic.summary, branch: epic.branch, baseBranch: epic.baseBranch,
      completedLeaves: integrated, totalLeaves: epic.tasks.length, ready,
      integrationQueue: queue.map((item) => ({ issue: item.issueKey, state: item.state, conflict: item.conflict })),
      modelBudget: { limit: budget, used: usedTokens, remaining: budget > 0 ? Math.max(0, budget - usedTokens) : null }
    };
  });
}

export function buildControlPlaneMetadata(settings) {
  const project = settings.data.project || {};
  return {
    projectInfo: {
      key: settings.projectKey,
      name: project.name || settings.projectKey,
      repository: settings.repoPath ? path.basename(settings.repoPath) : null
    },
    providers: {
      workSources: describeWorkSourceProviders(settings),
      orchestrators: describeOrchestratorProviders(settings),
      executors: describeExecutorProviders(settings),
      codeIntelligence: describeCodeIntelligenceProviders(settings)
    },
    capabilities: { registry: buildCapabilityRegistry(settings) },
    workflow: { canonicalStates: CANONICAL_WORKFLOW_STATES },
    config: {
      mutationEnabled: Boolean(settings.data.controlPlane?.configMutationEnabled),
      selections: {
        workSource: selectedWorkSourceProviderName(settings) || null,
        orchestrator: selectedOrchestratorProviderName(settings) || null,
        executor: settings.data.executor?.defaultProvider || null,
        codeIntelligence: selectedCodeIntelligenceProviderName(settings)
      },
      mutableFields: ["workSource", "orchestrator", "executor", "codeIntelligence"],
      safety: {
        localOnly: true,
        externalWritesEnabled: false,
        mergeHumanOnly: true,
        doneTransitionHumanOnly: true
      }
    }
  };
}

export function buildDashboardSnapshot(settings, options = {}) {
  const store = options.store || getStore(settings);
  const now = options.now || new Date().toISOString();
  const locks = new Set(store.listLocks().map((lock) => lock.issue_key));
  const runs = store
    .listRunsDetailed(options.limit || 100)
    .map((run) => shapeRun(run, locks, now));
  let supervisor = store.getSupervisor(settings.projectKey);
  if (supervisor) {
    const { leaseId, ...safeSupervisor } = supervisor;
    if (safeSupervisor.status === "running" && safeSupervisor.heartbeatAt) {
      const hbMs = new Date(safeSupervisor.heartbeatAt).getTime();
      const nowMs = new Date(now).getTime();
      const staleAfter = settings.data.supervisor?.staleAfterSeconds || 90;
      if ((nowMs - hbMs) / 1000 > staleAfter) {
        safeSupervisor.status = "stale";
      }
    }
    safeSupervisor.lastHeartbeatAt = safeSupervisor.heartbeatAt;
    delete safeSupervisor.heartbeatAt;
    delete safeSupervisor.stopRequestedAt;
    delete safeSupervisor.stoppedAt;
    supervisor = safeSupervisor;
  }

  const activity = store.listEvents(options.activityLimit || 40).map((event) => ({
    id: event.id,
    runId: event.run_id,
    issue: event.issue_key,
    state: event.state,
    stateKind: stateKind(event.state),
    createdAt: event.created_at
  }));

  const supervisorActivity = store.listSupervisorEvents(options.activityLimit || 40).map((event) => ({
    id: `sup-${event.id}`,
    category: "supervisor",
    type: event.event,
    status: event.payload.status || event.event,
    createdAt: event.createdAt
  }));

  const mergedActivity = [...activity, ...supervisorActivity]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, options.activityLimit || 40);

  return {
    version: 2,
    mode: "live",
    project: settings.projectKey,
    ...buildControlPlaneMetadata(settings),
    generatedAt: now,
    policy: { maxAttempts: Number(settings.data.policy?.maxAttempts) || 3 },
    capabilities: {
      registry: buildCapabilityRegistry(settings),
      retryHandler: options.retryHandlerAvailable === true
    },
    supervisor,
    capacity: capacity(settings, runs),
    totals: totals(runs),
    runs,
    epics: epicProgress(store, runs),
    activity: mergedActivity,
    pmMessages: store.listPmMessages(options.activityLimit || 40),
    pmDecisions: store.listPmDecisions(options.activityLimit || 40),
    agentDefinitions: store.listAgentDefinitions(),
    usageEvents: store.listUsageEvents(options.activityLimit || 40)
  };
}

export function buildDemoSnapshot(settings, now = new Date().toISOString()) {
  const baseTime = new Date(now).getTime();
  const runs = [
    {
      id: "demo-frontend",
      issue: "PACE-214",
      summary: "Çoklu kamera grid ve odak görünümü",
      state: "executing",
      stateKind: "active",
      persona: "frontend-engineer",
      skills: ["component-design", "stream-integration", "frontend-testing"],
      provider: "antigravity",
      model: "claude-sonnet-4-6",
      modelProfile: "medium",
      risk: "normal",
      parallelSafe: true,
      branch: "pace-214-multi-camera-grid",
      worktree: "agent-worktrees/pace-214-multi-camera-grid",
      allowedPaths: ["frontend/**"],
      changedFiles: ["frontend/src/components/CameraGrid.tsx"],
      resultSummary: null,
      blockers: [],
      locked: true,
      tokens: 18240,
      turns: 7,
      durationSeconds: 782,
      createdAt: new Date(baseTime - 782000).toISOString(),
      updatedAt: now
    },
    {
      id: "demo-cv",
      issue: "PACE-218",
      summary: "Kamera bağlantı sağlık sinyalleri",
      state: "executing",
      stateKind: "active",
      persona: "cv-engineer",
      skills: ["cv-pipeline-checks", "opencv-patterns", "backend-testing"],
      provider: "antigravity",
      model: "gpt-oss-120b-medium",
      modelProfile: "mechanical",
      risk: "normal",
      parallelSafe: true,
      branch: "pace-218-camera-health",
      worktree: "agent-worktrees/pace-218-camera-health",
      allowedPaths: ["cv-engine/**"],
      changedFiles: [],
      resultSummary: null,
      blockers: [],
      locked: true,
      tokens: 7310,
      turns: 3,
      durationSeconds: 314,
      createdAt: new Date(baseTime - 314000).toISOString(),
      updatedAt: now
    },
    {
      id: "demo-review",
      issue: "PACE-205",
      summary: "Tenant bazlı authorization guard’ları",
      state: "verifying",
      stateKind: "review",
      persona: "backend-engineer",
      skills: ["api-design", "backend-testing", "security-review"],
      provider: "codex",
      model: "gpt-5.6",
      modelProfile: "high",
      risk: "high",
      parallelSafe: false,
      branch: "pace-205-authorization-guards",
      worktree: "agent-worktrees/pace-205-authorization-guards",
      allowedPaths: ["backend/**"],
      changedFiles: ["backend/auth.py", "backend/tests/test_auth.py"],
      resultSummary: "Authorization guard ve testleri hazır; insan incelemesi bekleniyor.",
      blockers: [],
      locked: true,
      tokens: 29480,
      turns: 11,
      durationSeconds: 1240,
      createdAt: new Date(baseTime - 1240000).toISOString(),
      updatedAt: new Date(baseTime - 180000).toISOString()
    },
    {
      id: "demo-blocked",
      issue: "PACE-221",
      summary: "İç mekan ilerleme veri modeli",
      state: "failed-scope",
      stateKind: "blocked",
      persona: "data-engineer",
      skills: ["database-patterns", "data-pipeline", "tsdb-patterns"],
      provider: "antigravity",
      model: "claude-opus-4-6-thinking",
      modelProfile: "high",
      risk: "normal",
      parallelSafe: true,
      branch: "pace-221-interior-progress-model",
      worktree: "agent-worktrees/pace-221-interior-progress-model",
      allowedPaths: ["backend/**"],
      changedFiles: ["frontend/src/types/progress.ts"],
      resultSummary: null,
      blockers: ["Değişiklik izin verilen backend/** kapsamının dışına çıktı."],
      locked: true,
      tokens: 11320,
      turns: 5,
      durationSeconds: 642,
      createdAt: new Date(baseTime - 642000).toISOString(),
      updatedAt: new Date(baseTime - 42000).toISOString(),
      workerStatus: "finished",
      workerPid: null
    }
  ];
  return {
    version: 2,
    mode: "demo",
    project: settings.projectKey,
    ...buildControlPlaneMetadata(settings),
    generatedAt: now,
    capacity: capacity(settings, runs),
    totals: totals(runs),
    runs,
    activity: runs.flatMap((run, index) => [
      {
        id: index * 2 + 2,
        runId: run.id,
        issue: run.issue,
        state: run.state,
        stateKind: run.stateKind,
        createdAt: run.updatedAt
      },
      {
        id: index * 2 + 1,
        runId: run.id,
        issue: run.issue,
        state: "claimed",
        stateKind: "active",
        createdAt: run.createdAt
      }
    ]).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  };
}

const UI_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "ui"
);

const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/assets/dashboard.css", ["dashboard.css", "text/css; charset=utf-8"]],
  ["/assets/dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8"]]
]);

function headers(contentType, cacheControl = "no-store") {
  return {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  };
}

function send(response, status, body, contentType, method, cacheControl) {
  response.writeHead(status, headers(contentType, cacheControl));
  response.end(method === "HEAD" ? undefined : body);
}

function isLoopbackHostname(hostname) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    String(hostname || "").toLowerCase()
  );
}

function isLoopbackMutationRequest(request) {
  try {
    const host = new URL(`http://${String(request.headers.host || "")}`).hostname;
    if (!isLoopbackHostname(host)) return false;
    const origin = request.headers.origin;
    return !origin || isLoopbackHostname(new URL(String(origin)).hostname);
  } catch {
    return false;
  }
}

function readJsonBody(request, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (body.length > limit) {
        settled = true;
        reject(new Error("Request body too large"));
      }
    });
    request.on("end", () => {
      if (settled) return;
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    request.on("error", reject);
  });
}

export function createDashboardServer(settings, options = {}) {
  const store = options.store || getStore(settings);
  let activeSettings = settings;
  return http.createServer(async (request, response) => {
    const method = request.method || "GET";
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/retry") {
      if (method !== "POST") {
        send(response, 405, "Method not allowed", "text/plain; charset=utf-8", method);
        return;
      }
      if (typeof options.retryHandler !== "function") {
        send(response, 503, JSON.stringify({ error: "Retry handler unavailable" }), "application/json; charset=utf-8", method);
        return;
      }
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        send(response, 415, JSON.stringify({ error: "JSON required" }), "application/json; charset=utf-8", method);
        return;
      }
      try {
        const body = await readJsonBody(request);
        if (Object.keys(body).some((key) => !["runId", "issueKey"].includes(key))) {
          throw new Error("Unsupported retry field");
        }
        const result = await options.retryHandler({ runId: body.runId, issueKey: body.issueKey });
        send(response, 202, JSON.stringify(result), "application/json; charset=utf-8", method);
      } catch (error) {
        send(response, 409, JSON.stringify({ error: error.message }), "application/json; charset=utf-8", method);
      }
      return;
    }
    if (url.pathname === "/api/config/providers") {
      if (method !== "PATCH") {
        send(response, 405, "Method not allowed", "text/plain; charset=utf-8", method);
        return;
      }
      if (!isLoopbackMutationRequest(request)) {
        send(response, 403, "Loopback request required", "text/plain; charset=utf-8", method);
        return;
      }
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        send(response, 415, JSON.stringify({ error: "JSON required" }), "application/json; charset=utf-8", method);
        return;
      }
      if (!activeSettings.data.controlPlane?.configMutationEnabled) {
        send(response, 403, "Config mutation is disabled", "text/plain; charset=utf-8", method);
        return;
      }
      try {
        const selections = await readJsonBody(request);
        activeSettings = updateProviderSelections(activeSettings, selections);
        send(
          response,
          200,
          JSON.stringify({ ok: true, ...buildControlPlaneMetadata(activeSettings) }),
          "application/json; charset=utf-8",
          method
        );
      } catch (error) {
        send(response, 400, JSON.stringify({ error: error.message }), "application/json; charset=utf-8", method);
      }
      return;
    }
    if (!["GET", "HEAD"].includes(method)) {
      send(response, 405, "Method not allowed", "text/plain; charset=utf-8", method);
      return;
    }
    if (url.pathname === "/api/snapshot") {
      const snapshot = options.demo
        ? buildDemoSnapshot(activeSettings)
        : buildDashboardSnapshot(activeSettings, {
            store,
            retryHandlerAvailable: typeof options.retryHandler === "function"
          });
      send(response, 200, JSON.stringify(snapshot), "application/json; charset=utf-8", method);
      return;
    }
    if (url.pathname === "/health") {
      send(response, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8", method);
      return;
    }
    const asset = ASSETS.get(url.pathname);
    if (!asset) {
      send(response, 404, "Not found", "text/plain; charset=utf-8", method);
      return;
    }
    const [file, contentType] = asset;
    send(
      response,
      200,
      fs.readFileSync(path.join(UI_ROOT, file)),
      contentType,
      method,
      "no-cache"
    );
  });
}

export async function startDashboardServer(settings, options = {}) {
  const host = "127.0.0.1";
  const port = options.port ?? 4317;
  const server = createDashboardServer(settings, options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return { server, url: `http://${host}:${address.port}` };
}
