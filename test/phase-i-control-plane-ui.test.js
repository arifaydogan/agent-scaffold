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

function createMockEnvironment(initialUrl = "http://localhost:4319/") {
  const elements = {};
  const listeners = {};
  const historyStack = [initialUrl];
  let historyIndex = 0;
  let pushStateCount = 0;
  let replaceStateCount = 0;

  const urlObj = new URL(initialUrl);

  const window = {
    location: {
      get href() { return urlObj.href; },
      set href(v) { urlObj.href = v; },
      get search() { return urlObj.search; },
      set search(v) { urlObj.search = v; },
      get pathname() { return urlObj.pathname; },
      set pathname(v) { urlObj.pathname = v; }
    },
    history: {
      pushState(st, title, url) {
        pushStateCount++;
        const target = new URL(url, urlObj.origin);
        urlObj.pathname = target.pathname;
        urlObj.search = target.search;
        historyStack.push(urlObj.href);
        historyIndex = historyStack.length - 1;
      },
      replaceState(st, title, url) {
        replaceStateCount++;
        const target = new URL(url, urlObj.origin);
        urlObj.pathname = target.pathname;
        urlObj.search = target.search;
        historyStack[historyIndex] = urlObj.href;
      }
    },
    addEventListener(evt, fn) {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(fn);
    },
    dispatchEvent(evt) {
      const fns = listeners[evt.type] || [];
      for (const fn of fns) fn(evt);
    }
  };

  function createElement(tag, className = "", textContent = "") {
    const el = {
      tag,
      className,
      textContent,
      children: [],
      dataset: {},
      attributes: {},
      style: {},
      hidden: false,
      value: "",
      disabled: false,
      appendChild(child) {
        el.children.push(child);
        return child;
      },
      append(...nodes) {
        for (const n of nodes) {
          if (typeof n === "string") el.children.push({ tag: "#text", textContent: n, children: [] });
          else if (n) el.children.push(n);
        }
      },
      replaceChildren(...nodes) {
        el.children = [];
        el.append(...nodes);
      },
      setAttribute(k, v) { el.attributes[k] = v; },
      getAttribute(k) { return el.attributes[k]; },
      querySelector(sel) {
        return findInTree(el, sel);
      },
      querySelectorAll(sel) {
        return findAllInTree(el, sel);
      },
      classList: {
        add(c) {
          const parts = (el.className || "").split(" ").filter(Boolean);
          if (!parts.includes(c)) parts.push(c);
          el.className = parts.join(" ");
        },
        remove(c) {
          const parts = (el.className || "").split(" ").filter(Boolean);
          el.className = parts.filter(p => p !== c).join(" ");
        },
        contains(c) {
          return (el.className || "").split(" ").filter(Boolean).includes(c);
        }
      },
      addEventListener() {}
    };
    return el;
  }

  function findInTree(node, sel) {
    if (!node || !node.children) return null;
    for (const child of node.children) {
      if (matches(child, sel)) return child;
      const found = findInTree(child, sel);
      if (found) return found;
    }
    return null;
  }

  function findAllInTree(node, sel, acc = []) {
    if (!node || !node.children) return acc;
    for (const child of node.children) {
      if (matches(child, sel)) acc.push(child);
      findAllInTree(child, sel, acc);
    }
    return acc;
  }

  function matches(node, sel) {
    if (!node || typeof node !== "object") return false;
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      return (node.className || "").split(" ").includes(cls);
    }
    if (sel.startsWith("#")) {
      const id = sel.slice(1);
      return node.id === id || node.attributes?.id === id;
    }
    return node.tag === sel.toLowerCase();
  }

  const document = {
    createElement,
    createTextNode(txt) { return { tag: "#text", textContent: txt, children: [] }; },
    getElementById(id) {
      if (!elements[id]) {
        elements[id] = createElement("div");
        elements[id].id = id;
      }
      return elements[id];
    },
    querySelector(sel) {
      if (sel.startsWith("#")) {
        return document.getElementById(sel.slice(1));
      }
      if (!elements[sel]) {
        elements[sel] = createElement("div");
      }
      return elements[sel];
    },
    querySelectorAll(sel) {
      const results = [];
      for (const k of Object.keys(elements)) {
        if (matches(elements[k], sel)) results.push(elements[k]);
        findAllInTree(elements[k], sel, results);
      }
      return results;
    },
    addEventListener() {}
  };

  const code = fs.readFileSync(path.join(rootDir, "ui", "dashboard.js"), "utf8");
  const fn = new Function(
    "window", "document", "Intl", "console", "Math", "Date", "String", "JSON", "setInterval", "module", "fetch",
    `${code}; return { state, elements, createPmItemCard, renderProviderSection, renderDecisionTraceDetail, renderParentDetail, clearParentDetail, populateParentSelector, renderParentReviewFindings, switchView, openDecisionTrace, openTelemetryDrawer, readUrlState, syncUrlState, getElem, renderAgentRegistry, createAgentCard, submitApproval, submitRejection, openRejectionModal, openApprovalModal, fetchSnapshot, fetchParentDetail };`
  );

  let mockFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  window.fetch = (url, opts) => mockFetch(url, opts);

  const exports = fn(
    window, document, global.Intl, global.console, global.Math, global.Date, global.String, global.JSON,
    () => {}, { exports: {} }, (url, opts) => window.fetch(url, opts)
  );

  return {
    window,
    document,
    elements,
    exports,
    urlObj,
    setMockFetch(fn) { mockFetch = fn; },
    get pushStateCount() { return pushStateCount; },
    get replaceStateCount() { return replaceStateCount; },
    triggerPopstate() {
      window.dispatchEvent({ type: "popstate" });
    }
  };
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
// Test C: PM Workspace Contract & Execution Approval Buttons Boundary (Fix 1)
// -----------------------------------------------------------------------------
test("Phase I — C. PM Workspace Contract & Execution Approval Buttons Boundary", async () => {
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

  // UI Contract Regression: createPmItemCard renders Approve/Reject buttons ONLY for awaitingApproval
  const env = createMockEnvironment();

  // 1. humanApproval + action=finalMerge + humanActionRequired=true => NO approval/rejection buttons
  const humanApprovalCard = env.exports.createPmItemCard({
    issueKey: "PACE-500",
    summary: "Parent Epic Waiting Human",
    operationalGroup: "humanApproval",
    action: "finalMerge",
    humanActionRequired: true
  }, "human");
  assert.equal(humanApprovalCard.querySelector(".pm-btn-approve"), null, "humanApproval item must NOT have approve button");
  assert.equal(humanApprovalCard.querySelector(".pm-btn-reject"), null, "humanApproval item must NOT have reject button");

  // 2. awaitingApproval + branchCreation/review/implementation => buttons MUST exist
  const awaitingCard1 = env.exports.createPmItemCard({
    issueKey: "PACE-102",
    summary: "Supervised implementation step",
    operationalGroup: "awaitingApproval",
    action: "implementation",
    humanActionRequired: true,
    planFingerprint: "fp-123"
  }, "approval");
  assert.ok(awaitingCard1.querySelector(".pm-btn-approve"), "awaitingApproval + implementation MUST have approve button");
  assert.ok(awaitingCard1.querySelector(".pm-btn-reject"), "awaitingApproval + implementation MUST have reject button");

  const awaitingCard2 = env.exports.createPmItemCard({
    issueKey: "PACE-103",
    summary: "Supervised branch creation",
    operationalGroup: "awaitingApproval",
    action: "branchCreation",
    humanActionRequired: true
  }, "approval");
  assert.ok(awaitingCard2.querySelector(".pm-btn-approve"), "awaitingApproval + branchCreation MUST have approve button");
  assert.ok(awaitingCard2.querySelector(".pm-btn-reject"), "awaitingApproval + branchCreation MUST have reject button");

  // 3. blocked, executing, ready, inReview, needsRework => NO approval/rejection buttons
  for (const group of ["blocked", "executing", "ready", "inReview", "needsRework"]) {
    const card = env.exports.createPmItemCard({
      issueKey: `PACE-${group}`,
      summary: `Test for ${group}`,
      operationalGroup: group,
      action: "implementation",
      humanActionRequired: false
    }, "state");
    assert.equal(card.querySelector(".pm-btn-approve"), null, `${group} item must NOT have approve button`);
    assert.equal(card.querySelector(".pm-btn-reject"), null, `${group} item must NOT have reject button`);
  }

  cleanup();
});

// -----------------------------------------------------------------------------
// Test D: Decision Trace Contract & Trace Rendering (Real Actor & Parent Review Identity)
// -----------------------------------------------------------------------------
test("Phase I — D. Decision Trace Contract & Complete Trace Rendering (Real Actor & Parent Review Identity)", async () => {
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
  store.transition(runId, "reviewed-clean", { reviewerId: "qa-engineer", findings: [] });
  store.addPmDecision("PACE-201", "execution_approval", { approved: true, action: "implementation", approver: "pm-operator" });

  const detail = buildPmWorkItemDetail(settings, "PACE-201", { store });

  assert.ok(detail.workItem, "workItem required");
  assert.equal(detail.workItem.key, "PACE-201");
  assert.equal(detail.workItem.summary, "Refactor cache layer");
  assert.ok(Array.isArray(detail.history), "history timeline required");
  assert.ok(detail.history.length >= 3, "history must contain transitions and pm decisions");

  // Verify real actor objects from buildPmWorkItemDetail
  const revEvent = detail.history.find(h => h.actor && h.actor.type === "reviewer");
  assert.ok(revEvent, "Must have reviewer actor event");
  assert.equal(revEvent.actor.id, "qa-engineer");

  const pmEvent = detail.history.find(h => h.actor && h.actor.type === "human");
  assert.ok(pmEvent, "Must have human pm actor event");
  assert.equal(pmEvent.actor.id, "pm-operator");

  // UI Renderer Regression: renderDecisionTraceDetail renders real detail
  const env = createMockEnvironment();
  const traceBody = env.document.getElementById("trace-drawer-body");

  env.exports.renderDecisionTraceDetail(detail);

  function collectText(node) {
    let t = node.textContent || "";
    for (const c of (node.children || [])) {
      t += " " + collectText(c);
    }
    return t;
  }
  const renderedText = collectText(traceBody);

  // Assert NO [object Object] rendered anywhere
  assert.ok(!renderedText.includes("[object Object]"), "Must NOT render [object Object] for history actor");
  assert.ok(renderedText.includes("[reviewer · qa-engineer]"), "Must render [reviewer · qa-engineer]");
  assert.ok(renderedText.includes("[human · pm-operator]"), "Must render [human · pm-operator]");

  // Parent Decision Trace test with real integrationReview
  const completionPacket = {
    parentKey: "PACE-1000",
    graphFingerprint: "gfp-998877",
    baseSha: "base-sha-12345",
    integrationHeadSha: "head-sha-67890",
    children: ["PACE-1001"],
    integrationReview: {
      reviewerAgentId: "lead-reviewer",
      reviewerVersion: 3,
      reviewerHash: "revhash-999",
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      modelProfile: "claude-3-7-sonnet",
      verdict: "APPROVED",
      findings: ["Zero regressions", "Clean architecture"]
    }
  };

  store.upsertParentExecution({
    parentKey: "PACE-1000",
    summary: "Autonomous Delivery Epic",
    state: "waiting_human",
    baseRef: "develop",
    baseSha: "base-sha-12345",
    integrationBranch: "epic/pace-1000",
    integrationHeadSha: "head-sha-67890",
    graphFingerprint: "gfp-998877",
    completionPacket
  });

  const parentDetail = buildPmWorkItemDetail(settings, "PACE-1000", { store });
  assert.equal(parentDetail.review.reviewerTaskAgent, "lead-reviewer", "Must extract real reviewerAgentId");
  assert.equal(parentDetail.review.reviewAgentVersion, 3, "Must extract real reviewerVersion");
  assert.equal(parentDetail.review.reviewAgentHash, "revhash-999", "Must extract real reviewerHash");
  assert.equal(parentDetail.review.reviewProvider, "anthropic", "Must extract real review provider");
  assert.equal(parentDetail.review.verdict, "APPROVED", "Must extract real verdict");
  assert.deepEqual(parentDetail.review.structuredFindings, ["Zero regressions", "Clean architecture"]);

  // Render parent trace detail in UI
  env.exports.renderDecisionTraceDetail(parentDetail);
  const parentTraceText = collectText(traceBody);
  assert.ok(parentTraceText.includes("lead-reviewer"), "Must render real parent reviewer agent");
  assert.ok(parentTraceText.includes("APPROVED"), "Must render real parent review verdict");

  cleanup();
});

// -----------------------------------------------------------------------------
// Test E: Provider Configuration Contract & Descriptor Rendering (Fix 2)
// -----------------------------------------------------------------------------
test("Phase I — E. Provider Configuration Contract & Descriptor Rendering", async () => {
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

  // Renderer-level regression using ACTUAL buildDashboardSnapshot() provider arrays
  const env = createMockEnvironment();

  function collectText(node) {
    let t = node.textContent || "";
    for (const c of (node.children || [])) {
      t += " " + collectText(c);
    }
    return t;
  }

  // 1. Work Source
  env.exports.renderProviderSection("ws", "workSource", snapshot.providers.workSources, snapshot.config.selections.workSource, true);
  const wsList = env.document.getElementById("cfg-ws-list");
  const wsText = collectText(wsList);
  assert.ok(wsText.includes("jira"), "workSource name 'jira' must render");
  assert.ok(!wsText.includes("undefined"), "workSource must NOT render 'undefined'");

  // 2. Orchestrator
  env.exports.renderProviderSection("orch", "orchestrator", snapshot.providers.orchestrators, snapshot.config.selections.orchestrator, true);
  const orchList = env.document.getElementById("cfg-orch-list");
  const orchText = collectText(orchList);
  assert.ok(orchText.includes("builtin"), "orchestrator name 'builtin' must render");
  assert.ok(!orchText.includes("undefined"), "orchestrator must NOT render 'undefined'");

  // 3. Executor
  env.exports.renderProviderSection("exec", "executor", snapshot.providers.executors, snapshot.config.selections.executor, true);
  const execList = env.document.getElementById("cfg-exec-list");
  const execText = collectText(execList);
  assert.ok(execText.includes("codex"), "executor name 'codex' must render");
  assert.ok(execText.includes("local"), "executor name 'local' must render");
  assert.ok(!execText.includes("undefined"), "executor must NOT render 'undefined'");

  // 4. Code Intelligence
  env.exports.renderProviderSection("ci", "codeIntelligence", snapshot.providers.codeIntelligence, snapshot.config.selections.codeIntelligence, true);
  const ciList = env.document.getElementById("cfg-ci-list");
  const ciText = collectText(ciList);
  assert.ok(ciText.includes("builtin"), "codeIntelligence name 'builtin' must render");
  assert.ok(!ciText.includes("undefined"), "codeIntelligence must NOT render 'undefined'");

  // 5. Source Control ("local-git" read-only)
  env.exports.renderProviderSection("sc", "sourceControl", snapshot.providers.sourceControl, snapshot.config.selections.sourceControl, false);
  const scList = env.document.getElementById("cfg-sc-list");
  const scText = collectText(scList);
  assert.ok(scText.includes("local-git"), "sourceControl name 'local-git' must render");
  assert.ok(!scText.includes("undefined"), "sourceControl must NOT render 'undefined'");
  assert.equal(scList.querySelector(".pm-btn-view"), null, "sourceControl must NOT have mutation button (read-only)");

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
// Test I: Agent Registry Mutations & Usage Shapes (Real Registry + Usage Events)
// -----------------------------------------------------------------------------
test("Phase I — I. Agent Registry Mutations & Usage Shapes (Real Registry + Usage Events)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("agent-mutations");
  const settings = makeSettings(tmpDir);
  const server = createDashboardServer(settings, { store, port: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    // 1. Create Agent using real API / store
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
        maxConcurrency: 2,
        executor: {
          provider: "codex",
          model: "gpt-5",
          modelProfile: "reasoning-high"
        },
        reviewer: "sec-reviewer"
      }
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.agent.id, "qa-specialist");
    assert.equal(createRes.data.agent.version, 1);
    assert.equal(createRes.data.agent.status, "enabled");

    // Check store.listAgentDefinitions returns real executor and reviewer
    const defs = store.listAgentDefinitions();
    const qaAgent = defs.find(a => a.id === "qa-specialist");
    assert.ok(qaAgent, "qa-specialist must be in store");
    assert.equal(qaAgent.executor?.provider, "codex");
    assert.equal(qaAgent.executor?.model, "gpt-5");
    assert.equal(qaAgent.executor?.modelProfile, "reasoning-high");
    assert.equal(qaAgent.reviewer, "sec-reviewer");

    // Record Usage events using store.recordUsageEvent
    store.recordUsageEvent({
      runId: "run-agent-1",
      provider: "codex",
      model: "gpt-5",
      inputTokens: 1250,
      outputTokens: 350,
      durationMs: 2400
    });
    store.recordUsageEvent({
      runId: "run-agent-2",
      provider: "local",
      model: "qwen",
      inputTokens: null,
      outputTokens: null,
      durationMs: 0
    });

    const usageList = store.listUsageEvents();
    assert.equal(usageList.length, 2);

    // UI Renderer Regression: renderAgentRegistry & createAgentCard
    const env = createMockEnvironment();
    env.exports.state.snapshot = {
      agentDefinitions: defs,
      usageEvents: usageList
    };

    env.exports.renderAgentRegistry();

    function collectText(node) {
      let t = node.textContent || "";
      for (const c of (node.children || [])) {
        t += " " + collectText(c);
      }
      return t;
    }

    const agentList = env.document.getElementById("agent-definitions");
    const agentListText = collectText(agentList);
    assert.ok(agentListText.includes("codex"), "Agent card must render executor.provider");
    assert.ok(agentListText.includes("gpt-5"), "Agent card must render executor.model");
    assert.ok(agentListText.includes("reasoning-high"), "Agent card must render executor.modelProfile");
    assert.ok(agentListText.includes("sec-reviewer"), "Agent card must render reviewer");

    const usageEl = env.document.getElementById("usage-events");
    const usageText = collectText(usageEl);
    assert.ok(usageText.includes("in") && usageText.includes("out") && usageText.includes("tot"), "Must render truthful token counts for known usage");
    assert.ok(usageText.includes("sn") || usageText.includes("s"), "Must render durationMs formatted");
    assert.ok(usageText.includes("usage unavailable"), "Must render 'usage unavailable' when tokens unknown without fabricating fake totals");

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
// Test J: Parent DAG & Real Parent API Response to UI Renderer (Unwrapped API response)
// -----------------------------------------------------------------------------
test("Phase I — J. Parent DAG & Real Parent API Response to UI Renderer (Unwrapped API response)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("parent-dag");
  const settings = makeSettings(tmpDir);

  const completionPacket = {
    parentKey: "PACE-1000",
    graphFingerprint: "gfp-998877",
    baseSha: "base-sha-12345",
    integrationHeadSha: "head-sha-67890",
    children: ["PACE-1001", "PACE-1002"],
    reviewedShas: { "PACE-1001": "rev-sha-1", "PACE-1002": "rev-sha-2" },
    integratedShas: { "PACE-1001": "int-sha-1", "PACE-1002": "int-sha-2" },
    verification: {
      command: "npm run check",
      passed: true,
      evidence: "All 350 test assertions passed"
    },
    integrationReview: {
      reviewerAgentId: "lead-reviewer",
      reviewerVersion: 2,
      reviewerHash: "revhash-777",
      provider: "anthropic",
      modelProfile: "claude-3-7-sonnet",
      verdict: "APPROVED",
      findings: ["Clean integration", "Zero security issues"]
    },
    warnings: ["Non-blocking dependency advisory"],
    collectedAt: "2026-08-18T08:30:00.000Z"
  };

  store.upsertParentExecution({
    parentKey: "PACE-1000",
    summary: "Autonomous Delivery Epic",
    state: "waiting_human",
    baseRef: "develop",
    baseSha: "base-sha-12345",
    integrationBranch: "epic/pace-1000",
    integrationHeadSha: "head-sha-67890",
    graphFingerprint: "gfp-998877",
    completionPacket
  });

  store.upsertEpicTask({
    epicKey: "PACE-1000",
    issueKey: "PACE-1001",
    summary: "Module A",
    branch: "feat/1001",
    state: "integrated",
    dependencies: [],
    reviewedSha: "rev-sha-1",
    integratedSha: "int-sha-1"
  });

  store.upsertEpicTask({
    epicKey: "PACE-1000",
    issueKey: "PACE-1002",
    summary: "Module B",
    branch: "feat/1002",
    state: "integrated",
    dependencies: ["PACE-1001"],
    reviewedSha: "rev-sha-2",
    integratedSha: "int-sha-2"
  });

  // Start real dashboard server to test GET /api/pm/parents/:key endpoint unwrapping
  const server = createDashboardServer(settings, { store, port: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const res = await request(server, "/api/pm/parents/PACE-1000");
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.parent, "Server returns { ok: true, parent: ... } envelope");
    assert.equal(res.data.parent.parent.parentKey, "PACE-1000");

    // Pass the actual HTTP response envelope { ok: true, parent: detail } to renderParentDetail
    const env = createMockEnvironment();
    env.exports.renderParentDetail(res.data);

    function collectText(node) {
      let t = node.textContent || "";
      for (const c of (node.children || [])) {
        t += " " + collectText(c);
      }
      return t;
    }

    // 1. State pill
    const statePill = env.document.getElementById("parent-state-pill");
    assert.ok(statePill.textContent.includes("İnsan Onayında") || statePill.textContent.includes("WAITING_HUMAN"), "Must render waiting_human state");

    // 2. Human approval card
    const humanApprovalCard = env.document.getElementById("parent-human-approval-card");
    assert.equal(humanApprovalCard.hidden, false, "Human approval card must be visible for waiting_human");

    // 3. Children in DAG
    const dagContainer = env.document.getElementById("parent-dag-container");
    const dagText = collectText(dagContainer);
    assert.ok(dagText.includes("PACE-1001"), "DAG must render PACE-1001");
    assert.ok(dagText.includes("PACE-1002"), "DAG must render PACE-1002");

    // 4. Integration lane with reviewed and integrated SHAs
    const laneContainer = env.document.getElementById("parent-integration-lane");
    const laneText = collectText(laneContainer);
    assert.ok(laneText.includes("rev-sha-1".slice(0, 8)) || laneText.includes("int-sha-1".slice(0, 8)), "Integration lane must render reviewed/integrated SHA for PACE-1001");
    assert.ok(laneText.includes("rev-sha-2".slice(0, 8)) || laneText.includes("int-sha-2".slice(0, 8)), "Integration lane must render reviewed/integrated SHA for PACE-1002");

    // 5. Findings & verification
    const findingsContainer = env.document.getElementById("parent-review-findings");
    const findingsText = collectText(findingsContainer);
    assert.ok(findingsText.includes("npm run check"), "Must render verification command");
    assert.ok(findingsText.includes("Başarılı"), "Must render verification passed status");
    assert.ok(findingsText.includes("lead-reviewer"), "Must render aggregate reviewerAgentId");
    assert.ok(findingsText.includes("APPROVED"), "Must render review verdict");
  } finally {
    server.close();
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Test K: Real Popstate Navigation State Reconciliation
// -----------------------------------------------------------------------------
test("Phase I — K. Real Popstate Navigation State Reconciliation (/ -> ?view=parents -> ?view=parents&parent=PACE-500 -> back -> ?view=parents -> back -> /)", () => {
  const env = createMockEnvironment("http://localhost:4319/");

  env.exports.state.snapshot = {
    parentExecutions: [
      { parentKey: "PACE-500", summary: "Parent 500 Summary" },
      { parentKey: "PACE-600", summary: "Parent 600 Summary" }
    ]
  };

  // Step 1: Initial state is overview, no selection
  assert.equal(env.exports.state.currentView, "overview-view");
  assert.equal(env.exports.state.selectedParentKey, null);
  assert.equal(env.exports.state.selectedWorkItemKey, null);
  assert.equal(env.exports.state.selectedRunId, null);

  // Step 2: Navigate to ?view=parents (intermediate view step)
  env.exports.switchView("parents-view", false);
  assert.equal(env.exports.state.currentView, "parents-view");
  assert.equal(env.exports.state.selectedParentKey, null, "Navigating to parents view must not auto-select parent");
  assert.ok(env.urlObj.search.includes("view=parents"));

  // Step 3: Select parent -> ?view=parents&parent=PACE-500
  env.exports.state.selectedParentKey = "PACE-500";
  env.exports.syncUrlState(false);
  assert.ok(env.urlObj.search.includes("parent=PACE-500"));

  const pushCountBeforePop = env.pushStateCount;

  // Step 4: Back to ?view=parents (absence of &parent)
  env.urlObj.search = "?view=parents";
  env.exports.readUrlState();
  assert.equal(env.exports.state.currentView, "parents-view", "Must be on parents-view");
  assert.equal(env.exports.state.selectedParentKey, null, "Must clear selectedParentKey when ?parent is absent");
  assert.equal(env.document.getElementById("parent-select").value, "", "Parent selector value must be empty");
  assert.equal(env.document.getElementById("parent-key-badge").textContent, "—", "Parent detail key badge must be cleared");
  assert.equal(env.document.getElementById("parent-summary-text").textContent, "Lütfen bir parent epik seçin", "Parent summary must prompt selection");
  assert.equal(env.pushStateCount, pushCountBeforePop, "popstate must never call pushState");

  // Step 5: Back again to / (absence of ?view and ?parent)
  env.urlObj.search = "";
  env.exports.readUrlState();
  assert.equal(env.exports.state.selectedParentKey, null, "selectedParentKey must remain null");
  assert.equal(env.exports.state.currentView, "overview-view", "Absence of ?view must restore overview-view");
  assert.equal(env.elements["overview-view"].hidden, false, "Overview view must be visible");
  assert.equal(env.elements["parents-view"].hidden, true, "Parents view must be hidden");
  assert.equal(env.pushStateCount, pushCountBeforePop, "popstate must never call pushState");
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

// -----------------------------------------------------------------------------
// Test M: Symmetrical Stale Rejection (HTTP 409 Concurrency Handling)
// -----------------------------------------------------------------------------
test("Phase I — M. Symmetrical Stale Rejection (HTTP 409 Concurrency Handling)", async () => {
  const { store, tmpDir, cleanup } = makeTempDb("stale-rejection");
  const settings = makeSettings(tmpDir);

  const plan = {
    issue: "PACE-401",
    summary: "Refactor API routing",
    role: "implementation",
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    risk: "high",
    configSnapshot: { operatingMode: "supervised" }
  };
  const runId = store.createRun("PACE-401", plan);

  const server = createDashboardServer(settings, { store, port: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const env = createMockEnvironment();

    // Set up mock fetch to point to server
    env.setMockFetch(async (url, opts) => {
      const res = await request(server, url, {
        method: opts?.method || "GET",
        headers: opts?.headers || {},
        body: opts?.body ? JSON.parse(opts.body) : undefined
      });
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        statusText: res.status === 409 ? "Conflict" : "OK",
        json: async () => res.data
      };
    });

    // 1. Open rejection modal with stale plan fingerprint "fp-stale-x"
    env.exports.openRejectionModal({
      issueKey: "PACE-401",
      action: "implementation",
      planFingerprint: "fp-stale-x"
    });

    assert.equal(env.elements["rejection-modal"].hidden, false);
    env.document.getElementById("rejection-reason-input").value = "Architecture needs revision";

    // 2. Submit rejection with stale fingerprint
    await env.exports.submitRejection();

    // 3. Status must display 409 stale conflict message
    const statusEl = env.document.getElementById("rejection-modal-status");
    assert.equal(statusEl.hidden, false);
    assert.ok(statusEl.textContent.includes("409"), "Status message must indicate 409 Conflict");
    assert.ok(statusEl.textContent.includes("Plan parmak izi değişmiş") || statusEl.textContent.includes("güncellendi"), "Status message must explain plan fingerprint mismatch");

    // 4. Modal buttons must be re-enabled and modal NOT automatically closed/resubmitted
    assert.equal(env.document.getElementById("rejection-modal-confirm-btn").disabled, false, "Confirm button must be re-enabled");
    assert.equal(env.document.getElementById("rejection-modal-cancel-btn").disabled, false, "Cancel button must be re-enabled");

    // 5. Server state verification: NO rejection recorded for current run, run remains in active state
    const decisions = store.getPmDecisions("PACE-401");
    const rejectionDecisions = decisions.filter(d => d.type === "execution_approval" && d.payload?.approved === false);
    assert.equal(rejectionDecisions.length, 0, "No rejection decision must be recorded on server for stale fingerprint");

    const currentRun = store.getRun(runId);
    assert.equal(currentRun.state, "discovered", "Run state must remain unchanged");
  } finally {
    server.close();
    cleanup();
  }
});
