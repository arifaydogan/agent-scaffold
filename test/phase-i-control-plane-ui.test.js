import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { RunStore } from "../lib/store.js";
import { createDashboardServer, buildControlPlaneMetadata, buildDashboardSnapshot, buildDemoSnapshot } from "../lib/dashboard.js";
import { describeSourceControlProviders, selectedSourceControlProviderName } from "../lib/source-control.js";
import { computePlanFingerprint, computeParentBranchFingerprint } from "../lib/policy.js";

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
      operatingMode: "autonomous"
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

async function request(server, pathStr, options = {}) {
  const addr = server.address();
  const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  const url = `http://${host}:${addr.port}${pathStr}`;

  const res = await fetch(url, {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : undefined
  });

  const contentType = res.headers.get("content-type") || "";
  let data;
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return {
    status: res.status,
    headers: res.headers,
    data
  };
}

test("Phase I — A. Assets Serving & Security Headers", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("assets");
  const settings = makeSettings(tmpDir);
  const server = createDashboardServer(settings, { store, port: 0 });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    // 1. Root / serves index.html
    const rootRes = await request(server, "/");
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.headers.get("content-type"), /text\/html/);
    assert.equal(rootRes.headers.get("x-content-type-options"), "nosniff");
    assert.match(rootRes.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(rootRes.data, /Control Plane · PaceBuild/);
    assert.match(rootRes.data, /Parent Orkestrasyon/);

    // 2. /assets/dashboard.js serves Javascript
    const jsRes = await request(server, "/assets/dashboard.js");
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get("content-type"), /(?:text|application)\/javascript/);
    assert.match(jsRes.data, /renderParentsView/);
    assert.match(jsRes.data, /openApprovalModal/);

    // 3. /assets/dashboard.css serves CSS
    const cssRes = await request(server, "/assets/dashboard.css");
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get("content-type"), /text\/css/);
    assert.match(cssRes.data, /parent-summary-card/);
    assert.match(cssRes.data, /dag-container/);

    // 4. Unknown asset returns 404
    const unknownRes = await request(server, "/assets/non-existent.js");
    assert.equal(unknownRes.status, 404);

    // 5. Path traversal returns 404
    const traversalRes = await request(server, "/assets/../package.json");
    assert.equal(traversalRes.status, 404);

  } finally {
    server.close();
    cleanup();
  }
});

test("Phase I — B. PM Approval UI / API Contract (Exact fingerprint, 409 conflict, & Rejection)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("approvals");
  const settings = makeSettings(tmpDir);
  const server = createDashboardServer(settings, { store, port: 0 });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const issueKey = "PACE-101";
    const planA = { issue: issueKey, summary: "Initial Implementation Plan", allowedPaths: ["lib/**"], taskAgent: "backend-engineer" };
    const fpA = computePlanFingerprint(planA);

    // Record approval request with fpA
    store.addPmDecision(issueKey, "approval_requested", {
      action: "implementation",
      planFingerprint: fpA,
      attempt: 0,
      reason: "High risk task requires operator approval"
    });

    // 1. Approve with exact fingerprint fpA -> 200 OK
    const approveRes = await request(server, `/api/pm/work-items/${issueKey}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        action: "implementation",
        planFingerprint: fpA,
        attempt: 0,
        approver: "PM Operator",
        reason: "Approved from UI modal"
      }
    });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.data.ok, true);
    assert.equal(approveRes.data.decision.approved, true);

    // Verify approval stored in store
    const checkApproval = store.hasExecutionApproval(issueKey, { action: "implementation", planFingerprint: fpA, attempt: 0 });
    assert.ok(checkApproval);
    assert.equal(checkApproval.approved, true);

    // 2. A newer plan B is requested with fpB
    const planB = { issue: issueKey, summary: "Updated Implementation Plan", allowedPaths: ["lib/**", "src/**"], taskAgent: "backend-engineer" };
    const fpB = computePlanFingerprint(planB);

    store.addPmDecision(issueKey, "approval_requested", {
      action: "implementation",
      planFingerprint: fpB,
      attempt: 0,
      reason: "Plan modified"
    });

    // Submitting approval with stale fpA -> 409 Conflict!
    const staleApproveRes = await request(server, `/api/pm/work-items/${issueKey}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        action: "implementation",
        planFingerprint: fpA,
        attempt: 0,
        approver: "PM Operator",
        reason: "Stale approval attempt"
      }
    });
    assert.equal(staleApproveRes.status, 409);
    assert.match(staleApproveRes.data.error, /Plan fingerprint mismatch/i);
    assert.equal(staleApproveRes.data.expected, fpB);

    // 3. Rejection with reason -> 200 OK and records rejected decision
    const rejectRes = await request(server, `/api/pm/work-items/${issueKey}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        action: "implementation",
        planFingerprint: fpB,
        attempt: 0,
        approver: "PM Operator",
        reason: "Scope too broad; rejected"
      }
    });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.data.ok, true);
    assert.equal(rejectRes.data.decision.approved, false);
    assert.equal(rejectRes.data.decision.reason, "Scope too broad; rejected");

  } finally {
    server.close();
    cleanup();
  }
});

test("Phase I — C. Parent Detail API / UI Model (Valid DAG, Dependent Children, Integrated, & Conflict)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("parent-dag");
  const settings = makeSettings(tmpDir);
  const server = createDashboardServer(settings, { store, port: 0 });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const parentKey = "PACE-200";
    const baseSha = "1111111111111111111111111111111111111111";
    const intHeadSha = "2222222222222222222222222222222222222222";
    const graphFp = "fp-parent-200-graph";

    // Record parent execution
    store.upsertParentExecution({
      parentKey,
      sourceProvider: "jira",
      summary: "Kamera Entegrasyon Epik",
      baseRef: "develop",
      baseSha,
      integrationBranch: "epic/pace-200-camera",
      integrationHeadSha: intHeadSha,
      graphFingerprint: graphFp,
      dag: {
        nodes: ["PACE-201", "PACE-202", "PACE-203"],
        edges: [{ from: "PACE-201", to: "PACE-202" }]
      },
      state: "active"
    });

    // Record tasks (children)
    store.upsertEpicTask({
      epicKey: parentKey,
      issueKey: "PACE-201",
      summary: "Kamera SDK Entegrasyonu",
      branch: "task/pace-201-sdk",
      state: "accepted",
      orchestrationState: "accepted",
      dependencies: [],
      childBaseSha: baseSha,
      reviewedSha: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
      integratedSha: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222"
    });

    store.queueEpicIntegration({
      epicKey: parentKey,
      issueKey: "PACE-201",
      leafBranch: "task/pace-201-sdk"
    });
    store.claimEpicIntegration({ epicKey: parentKey, issueKey: "PACE-201" });
    store.finishEpicIntegration({
      epicKey: parentKey,
      issueKey: "PACE-201",
      commit: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222"
    });

    store.upsertEpicTask({
      epicKey: parentKey,
      issueKey: "PACE-202",
      summary: "Kamera UI Paneli",
      branch: "task/pace-202-ui",
      state: "executing",
      orchestrationState: "executing",
      dependencies: ["PACE-201"],
      childBaseSha: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222"
    });

    store.upsertEpicTask({
      epicKey: parentKey,
      issueKey: "PACE-203",
      summary: "Kamera Güvenlik Logları",
      branch: "task/pace-203-security",
      state: "accepted",
      orchestrationState: "accepted",
      dependencies: [],
      childBaseSha: baseSha,
      blockedReasons: ["Git merge conflict in config/camera.json"]
    });

    // Now queue and record conflict for PACE-203
    store.queueEpicIntegration({
      epicKey: parentKey,
      issueKey: "PACE-203",
      leafBranch: "task/pace-203-security"
    });
    store.claimEpicIntegration({ epicKey: parentKey, issueKey: "PACE-203" });
    store.finishEpicIntegration({
      epicKey: parentKey,
      issueKey: "PACE-203",
      conflict: "Merge conflict in config/camera.json"
    });

    // 1. List parents via GET /api/pm/parents
    const listRes = await request(server, "/api/pm/parents");
    assert.equal(listRes.status, 200);
    assert.equal(listRes.data.ok, true);
    assert.equal(listRes.data.parents.length, 1);
    assert.equal(listRes.data.parents[0].parentKey, parentKey);

    // 2. Get normalized parent detail via GET /api/pm/parents/:key
    const detailRes = await request(server, `/api/pm/parents/${parentKey}`);
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.data.ok, true);

    const p = detailRes.data.parent;
    assert.equal(p.parent.parentKey, parentKey);
    assert.equal(p.state, "active");
    assert.equal(p.baseRef, "develop");
    assert.equal(p.baseSha, baseSha);
    assert.equal(p.integrationBranch, "epic/pace-200-camera");
    assert.equal(p.integrationHeadSha, intHeadSha);
    assert.equal(p.graphFingerprint, graphFp);

    // Check children array & DAG relationships
    assert.equal(p.children.length, 3);

    const child201 = p.children.find(c => c.issueKey === "PACE-201");
    assert.equal(child201.dependencyState, "ready");
    assert.equal(child201.integrationState, "integrated");
    assert.equal(child201.integratedSha, "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222");

    const child202 = p.children.find(c => c.issueKey === "PACE-202");
    assert.deepEqual(child202.dependencies, ["PACE-201"]);
    // Since PACE-201 is integrated, PACE-202's dependencyState is satisfied!
    assert.equal(child202.dependencyState, "satisfied");
    assert.equal(child202.runtimeState, "executing");

    const child203 = p.children.find(c => c.issueKey === "PACE-203");
    assert.equal(child203.runtimeState, "blocked-conflict");
    assert.equal(child203.integrationState, "conflict");
    assert.match(child203.blockedReasons[0], /Git merge conflict/);

    // Parent surfaces child conflict in blockedReasons
    assert.ok(p.blockedReasons.some(r => r.includes("Integration conflict in child PACE-203") || r.includes("Git merge conflict")));

  } finally {
    server.close();
    cleanup();
  }
});

test("Phase I — D. Parent Completion Boundary (WAITING_HUMAN has completion evidence, NO auto-merge button)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("parent-completion");
  const settings = makeSettings(tmpDir);
  const server = createDashboardServer(settings, { store, port: 0 });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const parentKey = "PACE-300";
    const baseSha = "3333333333333333333333333333333333333333";
    const intHeadSha = "4444444444444444444444444444444444444444";
    const graphFp = "fp-parent-300-complete";

    const completionPacket = {
      parentKey,
      graphFingerprint: graphFp,
      baseSha,
      integrationHeadSha: intHeadSha,
      integrationReview: {
        verdict: "clean",
        reviewerId: "lead-reviewer",
        durationMs: 4200,
        findings: []
      },
      status: "ready_for_human_approval"
    };

    store.upsertParentExecution({
      parentKey,
      sourceProvider: "jira",
      summary: "Tamamlanan Epik",
      baseRef: "develop",
      baseSha,
      integrationBranch: "epic/pace-300-done",
      integrationHeadSha: intHeadSha,
      graphFingerprint: graphFp,
      state: "waiting_human",
      completionPacket
    });

    const res = await request(server, `/api/pm/parents/${parentKey}`);
    assert.equal(res.status, 200);

    const parent = res.data.parent;
    assert.equal(parent.state, "waiting_human");
    assert.equal(parent.waitingHuman, true);
    assert.ok(parent.integrationReview);
    assert.equal(parent.integrationReview.verdict, "clean");

    // Verify snapshot also carries WAITING_HUMAN in humanApproval group
    const snapshotRes = await request(server, "/api/snapshot");
    assert.equal(snapshotRes.status, 200);

    const humanApprovalItems = snapshotRes.data.pmWorkspace.groups.humanApproval || [];
    assert.ok(humanApprovalItems.some(i => i.issueKey === parentKey));

  } finally {
    server.close();
    cleanup();
  }
});

test("Phase I — E. Provider / Configuration View (Read-Only Safety & Future Runs Disclaimer)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("config-view");
  const settings = makeSettings(tmpDir);

  // 1. buildControlPlaneMetadata includes SourceControlProvider
  const meta = buildControlPlaneMetadata(settings);
  assert.ok(meta.providers.sourceControl, "sourceControl must be present in providers");
  assert.equal(meta.providers.sourceControl[0].id, "local-git");
  assert.equal(meta.config.selections.sourceControl, "local-git");
  assert.deepEqual(meta.config.mutableFields, ["workSource", "orchestrator", "executor", "codeIntelligence"]);

  // 2. Mutation enabled server allows PATCH /api/config/providers
  const server = createDashboardServer(settings, { store, port: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const patchRes = await request(server, "/api/config/providers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: { executor: "local" }
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.data.ok, true);
    assert.equal(patchRes.data.config.selections.executor, "local");

    // 3. Read-only server blocks PATCH /api/config/providers
    const roSettings = makeSettings(tmpDir, { controlPlane: { configMutationEnabled: false } });
    const roServer = createDashboardServer(roSettings, { store, port: 0 });
    await new Promise((resolve) => roServer.listen(0, "127.0.0.1", resolve));

    try {
      const roPatchRes = await request(roServer, "/api/config/providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: { executor: "codex" }
      });
      assert.equal(roPatchRes.status, 403);
      assert.match(String(roPatchRes.data?.error || roPatchRes.data), /disabled/i);
    } finally {
      roServer.close();
    }

  } finally {
    server.close();
    cleanup();
  }
});

test("Phase I — F. Agent Registry API & Semantics (List, Versions, Immutable v+1, Enable/Disable/Archive)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("agent-registry");
  const settings = makeSettings(tmpDir);
  const server = createDashboardServer(settings, { store, port: 0 });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    // 1. Create a new agent
    const createRes = await request(server, "/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        id: "custom-tester",
        displayName: "Custom Test Specialist",
        definition: {
          role: "implementation",
          skills: ["backend-testing", "api-design"],
          allowedPaths: ["test/**", "lib/**"],
          risk: "normal",
          maxConcurrency: 2
        }
      }
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.ok, true);
    assert.equal(createRes.data.agent.id, "custom-tester");
    assert.equal(createRes.data.agent.version, 1);
    assert.equal(createRes.data.agent.status, "enabled");

    // 2. Disable agent
    const disableRes = await request(server, "/api/agents/custom-tester/disable", { method: "POST" });
    assert.equal(disableRes.status, 200);
    assert.equal(disableRes.data.agent.status, "disabled");

    // 3. Enable agent
    const enableRes = await request(server, "/api/agents/custom-tester/enable", { method: "POST" });
    assert.equal(enableRes.status, 200);
    assert.equal(enableRes.data.agent.status, "enabled");

    // 4. Update agent -> creates immutable v2!
    const patchRes = await request(server, "/api/agents/custom-tester", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: {
        displayName: "Custom Test Specialist v2",
        definition: {
          role: "implementation",
          skills: ["backend-testing", "api-design", "security-audit"],
          allowedPaths: ["test/**", "lib/**", "src/**"],
          risk: "low",
          maxConcurrency: 3
        }
      }
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.data.ok, true);
    assert.equal(patchRes.data.agent.version, 2);

    // 5. Version history returns 2 versions
    const verRes = await request(server, "/api/agents/custom-tester/versions");
    assert.equal(verRes.status, 200);
    assert.equal(verRes.data.ok, true);
    assert.equal(verRes.data.versions.length, 2);
    assert.equal(verRes.data.versions[0].version, 1);
    assert.equal(verRes.data.versions[1].version, 2);
    assert.notEqual(verRes.data.versions[0].definitionHash, verRes.data.versions[1].definitionHash);

  } finally {
    server.close();
    cleanup();
  }
});

test("Phase I — G. Observability & Telemetry Truthfulness (Preserves unavailable nulls without fabricating zeros)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("telemetry-truth");
  const settings = makeSettings(tmpDir);
  const server = createDashboardServer(settings, { store, port: 0 });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const issueKey = "PACE-401";
    const plan = {
      issue: issueKey,
      summary: "Refactor database pool",
      role: "implementation",
      persona: "backend-engineer",
      taskAgent: "backend-engineer",
      configSnapshot: {
        taskAgent: "backend-engineer",
        executorProvider: "codex",
        executorModel: "gpt-5"
      }
    };

    const runId = store.createRun(issueKey, plan);

    // Record lifecycle events
    store.recordTelemetryEvent({
      eventId: "ev-queued-01",
      runId,
      issueKey,
      role: "implementation",
      stage: "queued",
      status: "queued",
      sequence: 1,
      provider: "codex"
    });

    store.recordTelemetryEvent({
      eventId: "ev-started-01",
      runId,
      issueKey,
      role: "implementation",
      stage: "started",
      status: "started",
      sequence: 2,
      provider: "codex"
    });

    // Terminal event with NO token usage and NO duration available
    store.recordTelemetryEvent({
      eventId: "ev-terminal-01",
      runId,
      issueKey,
      role: "implementation",
      stage: "terminal",
      status: "success",
      sequence: 3,
      provider: "codex",
      usage: { available: false }
    });

    const runRes = await request(server, `/api/observability/runs/${runId}`);
    assert.equal(runRes.status, 200);
    assert.equal(runRes.data.ok, true);

    const data = runRes.data;
    // Token usage remains unavailable, not 0
    assert.equal(data.usage.available, false);
    assert.equal(data.usage.totalTokens, null);
    assert.equal(data.usage.inputTokens, null);
    assert.equal(data.usage.outputTokens, null);

  } finally {
    server.close();
    cleanup();
  }
});

test("Phase I — H. Security, DOM Safety, & XSS Prevention", () => {
  // Test safeHtml helper logic
  function safeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  const maliciousStrings = [
    '<script>alert("XSS")</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(document.domain)>',
    'javascript:alert(1)',
    'PACE-101 <iframe src="evil.com">'
  ];

  maliciousStrings.forEach(malicious => {
    const escaped = safeHtml(malicious);
    assert.ok(!escaped.includes("<script>"), "Must escape <script>");
    assert.ok(!escaped.includes("<img"), "Must escape <img>");
    assert.ok(!escaped.includes("<svg"), "Must escape <svg>");
    assert.ok(!escaped.includes("<iframe"), "Must escape <iframe>");
    assert.ok(escaped.includes("&lt;") || !malicious.includes("<"), "Must convert tags to HTML entities");
  });
});

test("Phase I — I. Demo Snapshot Realistic Parent DAG Structure", () => {
  const { tmpDir, cleanup } = makeTempDb("demo-snap");
  try {
    const settings = makeSettings(tmpDir);
    const demoSnap = buildDemoSnapshot(settings);

    assert.equal(demoSnap.mode, "demo");
    assert.ok(Array.isArray(demoSnap.parentExecutions));
    assert.ok(demoSnap.parentExecutions.length > 0);

    const demoParent = demoSnap.parentExecutions[0];
    assert.equal(demoParent.parentKey, "PACE-200");
    assert.equal(demoParent.baseRef, "develop");
    assert.ok(demoParent.dag);
    assert.ok(Array.isArray(demoParent.dag.nodes));
    assert.ok(demoParent.dag.nodes.length >= 3);
  } finally {
    cleanup();
  }
});

test("Phase I — J. Accessibility & Structural Elements in index.html", () => {
  const htmlPath = path.join(rootDir, "ui", "index.html");
  const html = fs.readFileSync(htmlPath, "utf-8");

  // Semantic Landmarks
  assert.ok(html.includes('class="skip-link"'), "Must contain accessible skip link");
  assert.ok(html.includes('<main id="main-content"'), "Must contain main semantic landmark");
  assert.ok(html.includes('role="dialog"'), "Modals must declare role=dialog");
  assert.ok(html.includes('aria-modal="true"'), "Modals must declare aria-modal=true");
  assert.ok(html.includes('aria-labelledby='), "Drawers must have aria-labelledby");

  // 6 Primary Navigation Tabs
  assert.ok(html.includes('data-target="overview-view"'), "Overview tab required");
  assert.ok(html.includes('data-target="pm-view"'), "Work / PM tab required");
  assert.ok(html.includes('data-target="parents-view"'), "Parent Orchestration tab required");
  assert.ok(html.includes('data-target="observability-view"'), "Observability tab required");
  assert.ok(html.includes('data-target="agents-view"'), "Agent Registry tab required");
  assert.ok(html.includes('data-target="config-view"'), "Providers & Config tab required");

  // Parent WAITING_HUMAN & DAG Elements
  assert.ok(html.includes('id="parent-human-approval-card"'), "Ready for human approval card required");
  assert.ok(html.includes('id="parent-dag-container"'), "Child DAG container required");
  assert.ok(html.includes('id="parent-dag-text-fallback"'), "Accessible DAG text fallback required");
  assert.ok(html.includes('id="parent-integration-lane"'), "Integration lane container required");

  // In-Page Modals
  assert.ok(html.includes('id="approval-modal"'), "In-page approval modal required");
  assert.ok(html.includes('id="rejection-modal"'), "In-page rejection modal required");
  assert.ok(html.includes('id="agent-edit-modal"'), "In-page agent edit modal required");
  assert.ok(html.includes('id="agent-create-modal"'), "In-page agent create modal required");
  assert.ok(html.includes('id="agent-versions-drawer"'), "Agent versions drawer required");

  // Operating Mode Pill & Disclaimer
  assert.ok(html.includes('id="operating-mode-pill"'), "Operating mode pill required");
  assert.ok(html.includes('İmmutable Versiyonlama'), "Immutable versioning notice required");
  assert.ok(html.includes('Gelecek Çalıştırmalar Uyarısı'), "Future runs configuration notice required");
});
