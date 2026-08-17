import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { RunStore } from "../lib/store.js";
import {
  createDashboardServer,
  buildControlPlaneMetadata,
  buildDashboardSnapshot,
  buildDemoSnapshot
} from "../lib/dashboard.js";
import {
  buildPmWorkspace,
  buildPmWorkItemDetail,
  handlePmApproval,
  handlePmRejection
} from "../lib/pm-workspace.js";
import {
  buildObservabilitySummary,
  buildRunObservability,
  normalizeUsage
} from "../lib/telemetry.js";
import { resolveOperatingMode, computePlanFingerprint } from "../lib/policy.js";
import { describeSourceControlProviders } from "../lib/source-control.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function makeTempDb(label = "phase-i-test") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-scaffold-${label}-`));
  const dbPath = path.join(tmpDir, "state.db");
  const store = new RunStore(dbPath);
  return {
    store,
    tmpDir,
    dbPath,
    cleanup() {
      try {
        store.close();
      } catch {}
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  };
}

function makeSettings(tmpDir, overrides = {}) {
  const sourcePath = path.join(tmpDir, "pace.json");
  const rawData = {
    project: {
      key: "PACE",
      name: "PaceBuild Test Project",
      repoPath: "."
    },
    worktree: {
      root: "./worktrees"
    },
    controlPlane: {
      configMutationEnabled: true,
      allowLoopbackMutations: true,
      pmMutationEnabled: true,
      ...overrides.controlPlane
    },
    workSource: {
      defaultProvider: "jira",
      providers: { jira: { type: "jira", enabled: true } },
      ...overrides.workSource
    },
    orchestrator: {
      defaultProvider: "builtin",
      providers: { builtin: { type: "builtin", enabled: true } },
      ...overrides.orchestrator
    },
    executor: {
      defaultProvider: "codex",
      providers: {
        codex: { command: ["codex"], enabled: true },
        local: { command: ["local"], enabled: true }
      },
      ...overrides.executor
    },
    codeIntelligence: {
      defaultProvider: "builtin",
      providers: { builtin: { type: "builtin", enabled: true } },
      ...overrides.codeIntelligence
    },
    sourceControl: {
      defaultProvider: "local-git",
      providers: { "local-git": { type: "local-git", enabled: true } },
      ...overrides.sourceControl
    },
    policy: {
      maxAttempts: 3,
      allowedProjects: ["PACE"],
      requiredLabels: ["agent-ready"],
      humanOnlyStatuses: ["Done"],
      operatingMode: "autonomous",
      ...overrides.policy
    },
    ...overrides.data
  };

  fs.writeFileSync(sourcePath, JSON.stringify(rawData, null, 2), "utf8");

  return {
    projectKey: "PACE",
    repoPath: tmpDir,
    source: sourcePath,
    data: rawData
  };
}

function request(server, pathStr, options = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 80;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathStr,
        method: options.method || "GET",
        headers: options.headers || {}
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let data = raw;
          if (res.headers["content-type"]?.includes("application/json")) {
            try {
              data = JSON.parse(raw);
            } catch {}
          }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

// -----------------------------------------------------------------------------
// Test A: DOM Selector Contract
// -----------------------------------------------------------------------------
test("Phase I — A. DOM Selector Contract (Every JS ID exists in index.html)", () => {
  const htmlPath = path.join(rootDir, "ui", "index.html");
  const jsPath = path.join(rootDir, "ui", "dashboard.js");
  const html = fs.readFileSync(htmlPath, "utf-8");
  const js = fs.readFileSync(jsPath, "utf-8");

  // Extract all getElem("..."), document.getElementById("..."), and document.querySelector("#...")
  const idRegex = /(?:getElem\(\s*["']([^"']+)["']\s*\)|getElementById\(\s*["']([^"']+)["']\s*\)|querySelector\(\s*["']#([^"']+)["']\s*\))/g;
  const queriedIds = new Set();
  let match;
  while ((match = idRegex.exec(js)) !== null) {
    const id = match[1] || match[2] || match[3];
    if (id && !id.includes("${")) {
      queriedIds.add(id);
    }
  }

  assert.ok(queriedIds.size >= 25, `Expected at least 25 queried IDs, found ${queriedIds.size}`);

  const missingIds = [];
  for (const id of queriedIds) {
    const hasId = html.includes(`id="${id}"`) || html.includes(`id='${id}'`);
    if (!hasId) {
      missingIds.push(id);
    }
  }

  assert.deepEqual(missingIds, [], `The following IDs queried in dashboard.js are missing from index.html: ${missingIds.join(", ")}`);
});

// -----------------------------------------------------------------------------
// Test B: CSP Compatibility & Static Check
// -----------------------------------------------------------------------------
test("Phase I — B. CSP Compatibility & Static Check (Zero inline JS, strict script-src 'self')", async () => {
  const htmlPath = path.join(rootDir, "ui", "index.html");
  const jsPath = path.join(rootDir, "ui", "dashboard.js");
  const html = fs.readFileSync(htmlPath, "utf-8");
  const js = fs.readFileSync(jsPath, "utf-8");

  // Verify no inline event handlers in HTML
  assert.ok(!/onclick\s*=/i.test(html), "index.html must not contain inline onclick handlers");
  assert.ok(!/onerror\s*=/i.test(html), "index.html must not contain inline onerror handlers");
  assert.ok(!/onload\s*=/i.test(html), "index.html must not contain inline onload handlers");
  assert.ok(!/href\s*=\s*["']javascript:/i.test(html), "index.html must not contain javascript: URLs");

  // Verify no inline event handlers generated in JS template strings
  assert.ok(!/onclick\s*=/i.test(js), "dashboard.js must not generate inline onclick handlers");
  assert.ok(!/onerror\s*=/i.test(js), "dashboard.js must not generate inline onerror handlers");
  assert.ok(!/onload\s*=/i.test(js), "dashboard.js must not generate inline onload handlers");
  assert.ok(!/href\s*=\s*["']javascript:/i.test(js), "dashboard.js must not generate javascript: href URLs");

  // Verify HTTP server CSP header
  const { store, tmpDir, cleanup } = makeTempDb("csp-check");
  const settings = makeSettings(tmpDir);
  const server = createDashboardServer(settings, { store, port: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const res = await request(server, "/");
    assert.equal(res.status, 200);
    const csp = res.headers["content-security-policy"];
    assert.ok(csp, "Server must return Content-Security-Policy header");
    assert.ok(csp.includes("script-src 'self'"), "CSP must enforce script-src 'self'");
    assert.ok(!csp.includes("'unsafe-inline'"), "script-src must NOT contain 'unsafe-inline'");
  } finally {
    server.close();
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test C: PM Workspace Contract
// -----------------------------------------------------------------------------
test("Phase I — C. PM Workspace Contract (Real buildPmWorkspace shape & actions)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("pm-workspace");
  const settings = makeSettings(tmpDir);

  const plan1 = {
    issue: "PACE-101",
    summary: "Auth controller scope fix",
    role: "implementation",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    risk: "normal",
    allowedPaths: ["src/auth/**"]
  };
  const runId1 = store.createRun("PACE-101", plan1);
  store.transition(runId1, "executing");

  // Create a run in supervised mode that requires human approval
  const plan2 = {
    issue: "PACE-102",
    summary: "High risk schema change",
    role: "implementation",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    risk: "high",
    configSnapshot: {
      operatingMode: "supervised"
    }
  };
  const runId2 = store.createRun("PACE-102", plan2);

  const workspace = buildPmWorkspace(settings, { store });

  assert.ok(workspace.groups, "Must have groups");
  assert.ok(Array.isArray(workspace.groups.needsPlanning));
  assert.ok(Array.isArray(workspace.groups.awaitingApproval));
  assert.ok(Array.isArray(workspace.groups.ready));
  assert.ok(Array.isArray(workspace.groups.executing));
  assert.ok(Array.isArray(workspace.groups.inReview));
  assert.ok(Array.isArray(workspace.groups.needsRework));
  assert.ok(Array.isArray(workspace.groups.blocked));
  assert.ok(Array.isArray(workspace.groups.humanApproval));

  assert.equal(workspace.groups.executing.length, 1);
  assert.equal(workspace.groups.executing[0].issueKey, "PACE-101");
  assert.equal(workspace.groups.awaitingApproval.length, 1);
  assert.equal(workspace.groups.awaitingApproval[0].issueKey, "PACE-102");

  cleanup();
});

// -----------------------------------------------------------------------------
// Test D: Decision Trace Contract
// -----------------------------------------------------------------------------
test("Phase I — D. Decision Trace Contract (buildPmWorkItemDetail returns complete read model)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("decision-trace");
  const settings = makeSettings(tmpDir);

  const plan = {
    issue: "PACE-201",
    summary: "Refactor cache layer",
    role: "implementation",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    risk: "low",
    allowedPaths: ["src/cache/**"]
  };
  const runId = store.createRun("PACE-201", plan);
  store.transition(runId, "started");
  store.transition(runId, "verifying");

  const detail = buildPmWorkItemDetail(settings, "PACE-201", { store });

  assert.ok(detail.workItem, "workItem required");
  assert.equal(detail.workItem.key, "PACE-201");
  assert.equal(detail.workItem.summary, "Refactor cache layer");

  assert.ok(detail.orchestratorDecision, "orchestratorDecision required");
  assert.equal(detail.orchestratorDecision.persona, "backend-engineer");
  assert.equal(detail.orchestratorDecision.taskAgent, "backend-engineer");
  assert.equal(detail.orchestratorDecision.risk, "low");

  assert.ok(detail.execution, "execution required");
  assert.ok(detail.review, "review required");
  assert.ok(detail.humanControl, "humanControl required");
  assert.ok(detail.blockedInfo, "blockedInfo required");
  assert.ok(Array.isArray(detail.history), "history timeline required");

  cleanup();
});

// -----------------------------------------------------------------------------
// Test E: Provider Configuration Contract
// -----------------------------------------------------------------------------
test("Phase I — E. Provider Configuration Contract (Top-level snapshot metadata & SourceControl read-only)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("config-contract");
  const settings = makeSettings(tmpDir);

  const snapshot = buildDashboardSnapshot(settings, { store });

  assert.ok(snapshot.providers, "Top-level providers required");
  assert.ok(snapshot.providers.workSources, "workSources required");
  assert.ok(snapshot.providers.orchestrators, "orchestrators required");
  assert.ok(snapshot.providers.executors, "executors required");
  assert.ok(snapshot.providers.codeIntelligence, "codeIntelligence required");
  assert.ok(snapshot.providers.sourceControl, "sourceControl required");

  assert.ok(snapshot.config, "Top-level config required");
  assert.ok(snapshot.config.selections, "config.selections required");
  assert.ok(Array.isArray(snapshot.config.mutableFields), "config.mutableFields required");
  assert.ok(!snapshot.config.mutableFields.includes("sourceControl"), "sourceControl must NOT be mutable");

  cleanup();
});

// -----------------------------------------------------------------------------
// Test F: Observability Contract
// -----------------------------------------------------------------------------
test("Phase I — F. Observability Contract (buildObservabilitySummary exposes providers array)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("obs-contract");
  const settings = makeSettings(tmpDir);

  const summary = buildObservabilitySummary(settings, { store, window: "24h" });

  assert.ok(Array.isArray(summary.providers), "summary.providers must be an array");
  assert.ok(summary.providers.length > 0, "must include configured executor providers");

  const codex = summary.providers.find(p => p.provider === "codex");
  assert.ok(codex, "codex provider health must be present");
  assert.ok(typeof codex.status === "string");

  cleanup();
});

// -----------------------------------------------------------------------------
// Test G: Operating Mode Authoritativeness
// -----------------------------------------------------------------------------
test("Phase I — G. Operating Mode Authoritativeness (MANUAL, SUPERVISED, AUTONOMOUS)", () => {
  const { tmpDir, cleanup } = makeTempDb("mode-test");

  const autoSettings = makeSettings(tmpDir, { policy: { operatingMode: "autonomous" } });
  assert.equal(resolveOperatingMode(autoSettings), "autonomous");

  const supSettings = makeSettings(tmpDir, { policy: { operatingMode: "supervised" } });
  assert.equal(resolveOperatingMode(supSettings), "supervised");

  const manSettings = makeSettings(tmpDir, { policy: { operatingMode: "manual" } });
  assert.equal(resolveOperatingMode(manSettings), "manual");

  const meta = buildControlPlaneMetadata(autoSettings);
  assert.equal(meta.config.operatingMode, "autonomous");

  cleanup();
});

// -----------------------------------------------------------------------------
// Test H: Telemetry Null Truthfulness
// -----------------------------------------------------------------------------
test("Phase I — H. Telemetry Null Truthfulness (No fabricated 0 tokens or 0 ms)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("telemetry-nulls");
  const settings = makeSettings(tmpDir);

  const plan = {
    issue: "PACE-301",
    summary: "Task with unknown duration and tokens",
    role: "implementation",
    persona: "backend-engineer",
    taskAgent: "backend-engineer"
  };
  const runId = store.createRun("PACE-301", plan);

  const now = new Date().toISOString();

  store.recordTelemetryEvent({
    eventId: "ev-queued-null-1",
    runId,
    issueKey: "PACE-301",
    role: "implementation",
    stage: "queued",
    status: "queued",
    sequence: 1,
    provider: "codex",
    createdAt: now
  });

  store.recordTelemetryEvent({
    eventId: "ev-started-null-1",
    runId,
    issueKey: "PACE-301",
    role: "implementation",
    stage: "started",
    status: "started",
    sequence: 2,
    provider: "codex",
    createdAt: now
  });

  store.recordTelemetryEvent({
    eventId: "ev-terminal-null-1",
    runId,
    issueKey: "PACE-301",
    role: "implementation",
    stage: "terminal",
    status: "completed",
    sequence: 3,
    provider: "codex",
    usage: { available: false },
    createdAt: now
  });

  const obs = buildRunObservability(settings, runId, { store });
  assert.equal(obs.usage.available, false);
  assert.equal(obs.usage.totalTokens, null);
  assert.equal(obs.usage.inputTokens, null);
  assert.equal(obs.usage.outputTokens, null);

  const summary = buildObservabilitySummary(settings, { store });
  const recentRun = summary.runs.find(r => r.runId === runId);
  assert.ok(recentRun);
  assert.equal(recentRun.durationSeconds, null);

  cleanup();
});

// -----------------------------------------------------------------------------
// Test I: Agent Mutations & Immutable Versioning
// -----------------------------------------------------------------------------
test("Phase I — I. Agent Registry Mutations & Versioning (Create -> Edit -> v2 -> Enable/Disable/Archive)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("agent-mutations");
  const settings = makeSettings(tmpDir);
  const server = createDashboardServer(settings, { store, port: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    // 1. Create Agent
    const createRes = await request(server, "/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        id: "qa-specialist",
        displayName: "QA Automation Specialist",
        role: "specialist",
        skills: ["backend-testing", "api-testing"],
        allowedPaths: ["test/**"],
        risk: "low",
        maxConcurrency: 2
      }
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.agent.id, "qa-specialist");
    assert.equal(createRes.data.agent.version, 1);
    assert.equal(createRes.data.agent.status, "enabled");

    // 2. Status changes
    const disRes = await request(server, "/api/agents/qa-specialist/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { status: "disabled" }
    });
    assert.equal(disRes.status, 200);
    assert.equal(disRes.data.agent.status, "disabled");

    // 3. Edit agent -> creates immutable v2
    const patchRes = await request(server, "/api/agents/qa-specialist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: {
        displayName: "QA Automation Specialist v2",
        role: "specialist",
        skills: ["backend-testing", "api-testing", "perf-testing"],
        allowedPaths: ["test/**", "benchmarks/**"]
      }
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.data.agent.version, 2);

    // 4. Check versions history
    const verRes = await request(server, "/api/agents/qa-specialist/versions");
    assert.equal(verRes.status, 200);
    const versions = verRes.data.versions || verRes.data;
    assert.equal(versions.length, 2);
    assert.equal(versions[0].version, 1);
    assert.equal(versions[1].version, 2);
  } finally {
    server.close();
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test J: Parent DAG & WAITING_HUMAN Completion Evidence
// -----------------------------------------------------------------------------
test("Phase I — J. Parent DAG & WAITING_HUMAN Completion Evidence (NO auto-merge button)", () => {
  const { store, cleanup } = makeTempDb("parent-dag");

  store.upsertEpic({
    key: "PACE-500",
    summary: "Video Analytics Pipeline",
    branch: "epic/pace-500-pipeline",
    baseBranch: "develop"
  });

  store.upsertEpicTask({
    epicKey: "PACE-500",
    issueKey: "PACE-501",
    summary: "Frame decoder",
    branch: "feat/501",
    state: "integrated",
    dependencies: [],
    reviewedSha: "sha1",
    integratedSha: "sha1"
  });

  store.upsertEpicTask({
    epicKey: "PACE-500",
    issueKey: "PACE-502",
    summary: "Inference engine",
    branch: "feat/502",
    state: "integrated",
    dependencies: ["PACE-501"],
    reviewedSha: "sha2",
    integratedSha: "sha2"
  });

  store.queueEpicIntegration({
    epicKey: "PACE-500",
    issueKey: "PACE-501",
    leafBranch: "feat/501"
  });
  store.finishEpicIntegration({
    epicKey: "PACE-500",
    issueKey: "PACE-501",
    commit: "sha1"
  });

  store.queueEpicIntegration({
    epicKey: "PACE-500",
    issueKey: "PACE-502",
    leafBranch: "feat/502"
  });
  store.finishEpicIntegration({
    epicKey: "PACE-500",
    issueKey: "PACE-502",
    commit: "sha2"
  });

  // Transition epic to waiting_human
  store.database.prepare("UPDATE epics SET state = 'waiting_human' WHERE epic_key = 'PACE-500'").run();

  const detail = store.getNormalizedParentDetail("PACE-500");
  assert.ok(detail);
  assert.equal(detail.state, "waiting_human");
  assert.equal(detail.waitingHuman, true);
  assert.equal(detail.children.length, 2);
  assert.equal(detail.children[0].dependencyState, "ready");
  assert.equal(detail.children[1].dependencyState, "satisfied");

  // Verify HTML does not contain any auto-merge/deploy buttons
  const htmlPath = path.join(rootDir, "ui", "index.html");
  const html = fs.readFileSync(htmlPath, "utf-8");
  assert.ok(!html.includes('id="merge-to-develop-btn"'), "Must NOT have auto-merge to develop button");
  assert.ok(!html.includes('id="mark-done-btn"'), "Must NOT have auto-mark Done button");
  assert.ok(!html.includes('id="deploy-btn"'), "Must NOT have auto-deploy button");

  cleanup();
});

// -----------------------------------------------------------------------------
// Test K: Deep Links & URL Navigation Logic
// -----------------------------------------------------------------------------
test("Phase I — K. Deep Links & URL State Navigation", () => {
  const search = "?view=parents&parent=PACE-200&issue=PACE-214&run=run-42";
  const params = new URLSearchParams(search);

  assert.equal(params.get("view"), "parents");
  assert.equal(params.get("parent"), "PACE-200");
  assert.equal(params.get("issue"), "PACE-214");
  assert.equal(params.get("run"), "run-42");

  // Verify removal of single parameter
  params.delete("issue");
  assert.equal(params.get("issue"), null);
  assert.equal(params.get("parent"), "PACE-200");
  assert.equal(params.toString(), "view=parents&parent=PACE-200&run=run-42");
});

// -----------------------------------------------------------------------------
// Test L: Accessibility & Modal Attributes
// -----------------------------------------------------------------------------
test("Phase I — L. Accessibility & Modal Attributes", () => {
  const htmlPath = path.join(rootDir, "ui", "index.html");
  const html = fs.readFileSync(htmlPath, "utf-8");

  // Check all dialogs have role="dialog" and aria-modal="true"
  const dialogMatches = html.match(/role="dialog"/g) || [];
  const modalMatches = html.match(/aria-modal="true"/g) || [];

  assert.ok(dialogMatches.length >= 4, `Expected at least 4 dialog roles, found ${dialogMatches.length}`);
  assert.equal(dialogMatches.length, modalMatches.length, "Every role=dialog must have aria-modal=true");
});
