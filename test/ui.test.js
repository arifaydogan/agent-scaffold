import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function setupMockDOM() {
  const elements = {};
  function createElement(tag) {
    const listeners = {};
    const el = {
      tag, className: "", textContent: "", children: [], style: {}, attributes: {},
      hidden: false, dataset: {}, value: "",
      append: (...nodes) => nodes.forEach(node => el.appendChild(node)),
      appendChild: (node) => { el.children.push(typeof node === "string" ? { textNode: true, text: node } : node); return node; },
      replaceChildren: (...nodes) => { el.children = []; el.append(...nodes); },
      setAttribute: (key, value) => { el.attributes[key] = String(value); },
      addEventListener: (type, listener) => { listeners[type] = listener; },
      listeners,
      focus: () => { el.focused = true; },
      classList: {
        add: (name) => { if (!el.className.split(" ").includes(name)) el.className = (el.className + " " + name).trim(); },
        remove: (name) => { el.className = el.className.split(" ").filter(item => item && item !== name).join(" "); },
        toggle: (name, force) => { const enabled = force === undefined ? !el.className.split(" ").includes(name) : force; if (enabled) el.classList.add(name); else el.classList.remove(name); },
        contains: (name) => el.className.split(" ").includes(name)
      },
      querySelector: () => null
    };
    let markup = "";
    Object.defineProperty(el, "innerHTML", {
      get: () => markup,
      set: (value) => { markup = String(value); el.children = []; }
    });
    return el;
  }
  const document = {
    querySelector: (selector) => { if (!elements[selector]) elements[selector] = createElement("div"); return elements[selector]; },
    querySelectorAll: () => [],
    getElementById: (id) => document.querySelector("#" + id),
    createElement, createTextNode: (text) => ({ textNode: true, text }),
    activeElement: null, hidden: false, documentElement: { lang: "tr" }
  };
  return { elements, globalScope: { document, fetch: async () => ({ ok: true, json: async () => ({}) }), setInterval: () => {}, Intl: global.Intl, console: global.console, Math: global.Math, Date: global.Date, String: global.String, JSON: global.JSON, confirm: () => true, navigator: { clipboard: { writeText: async () => {} } } } };
}

function loadUi({ fetchImpl, windowImpl } = {}) {
  const code = fs.readFileSync(path.resolve("ui/dashboard.js"), "utf8");
  const { elements, globalScope } = setupMockDOM();
  if (fetchImpl) globalScope.fetch = fetchImpl;
  if (windowImpl) globalScope.window = windowImpl;
  const runUI = new Function(...Object.keys(globalScope), code + "\nreturn { state, STATUS_LABELS, translateUiText, applyLanguage, syncUrlState, openDecisionTrace, fetchParentDetail, renderRuns, renderOverview, renderPmWorkspace, renderPmInbox, renderProviderConnections, setProviderConnectionCategory, buildExecutionStages, renderChildDag, renderPlanPreview, renderProjectSelection, switchView, openModal, closeModal };");
  return { ...runUI(...Object.values(globalScope)), elements };
}

test("Cockpit renders visible active work, attention, and table-based approvals", () => {
  const ui = loadUi();
  ui.state.snapshot = {
    runs: [
      { id: 1, issue: "PACE-1", summary: "Build review", stateKind: "active", state: "verifying", taskAgent: "builder", provider: "codex", model: "terra", durationSeconds: 0, createdAt: "2026-08-11T10:00:00Z" },
      { id: 2, issue: "PACE-2", summary: "Queue review", stateKind: "review", state: "review_queued", taskAgent: "reviewer", provider: "codex", model: "terra", durationSeconds: 12, createdAt: "2026-08-11T10:01:00Z" }
    ],
    capacity: { active: 1, queued: 1 },
    pmWorkspace: {
      counts: { awaitingApproval: 1, blocked: 1 },
      groups: {
        awaitingApproval: [{ issueKey: "PACE-3", summary: "Approve a plan", canonicalState: "awaiting_approval", currentRunState: "awaiting_approval", taskAgent: "builder", operationalGroup: "awaitingApproval", action: "implementation", attempt: 1, planFingerprint: "fp-1", createdAt: "2026-08-11T10:02:00Z" }],
        blocked: [{ issueKey: "PACE-4", canonicalState: "blocked", blockedReason: "Needs operator" }]
      }
    }
  };
  ui.renderOverview(ui.state.snapshot);
  assert.equal(ui.elements["#active-work-tbody"].children.length, 2, "visible Active Work uses table rows");
  assert.equal(ui.elements["#attention-list"].children.length, 2, "Needs Attention renders visible items");
  ui.renderPmWorkspace();
  const queueRow = ui.elements["#pm-queue-container"].children[0];
  const actions = queueRow.children.at(-1);
  assert.ok(actions.children.some(button => button.textContent === "Onayla"));
  const reject = actions.children.find(button => button.textContent === "Reddet");
  assert.ok(reject, "approval rows expose Reject alongside Approve");
  reject.listeners.click({ stopPropagation() {} });
  assert.equal(ui.elements["#rejection-modal"].hidden, false, "Reject uses the existing rejection modal path");
  ui.state.currentPmFilter = "attention";
  ui.renderPmWorkspace();
  assert.equal(ui.elements["#pm-queue-container"].children.length, 1, "PM filters update the table body");
  ui.state.currentPmFilter = "journal";
  ui.renderPmWorkspace();
  assert.equal(ui.elements["#pm-inbox-section"].hidden, true);
  assert.equal(ui.elements["#pm-journal-section"].hidden, false, "Journal remains reachable from Work");
});

test("Work catalog searches summary/key, filters canonical state, and paginates results", () => {
  const ui = loadUi();
  const ready = Array.from({ length: 30 }, (_, index) => ({
    issueKey: `PACE-${index + 1}`, summary: `Camera task ${index + 1}`, canonicalState: "ready"
  }));
  const review = Array.from({ length: 3 }, (_, index) => ({
    issueKey: `PACE-R${index + 1}`, summary: `Review task ${index + 1}`, canonicalState: "review"
  }));
  const groups = { ready, inReview: review };

  ui.state.workItemQuery = "camera";
  ui.state.workItemState = "ready";
  ui.state.workItemPageSize = 25;
  ui.renderPmInbox(groups, "inbox");
  assert.equal(ui.elements["#pm-queue-container"].children.length, 25);
  assert.equal(ui.elements["#work-pagination-summary"].textContent, "30 işten 1-25 gösteriliyor");
  assert.equal(ui.elements["#work-page-next"].disabled, false);

  ui.state.workItemPage = 2;
  ui.renderPmInbox(groups, "inbox");
  assert.equal(ui.elements["#pm-queue-container"].children.length, 5);

  ui.state.workItemQuery = "PACE-R";
  ui.state.workItemState = "review";
  ui.state.workItemPage = 1;
  ui.renderPmInbox(groups, "inbox");
  assert.equal(ui.elements["#pm-queue-container"].children.length, 3);
});

test("Cockpit navigation and drawers preserve practical keyboard focus behavior", () => {
  const ui = loadUi();
  ui.switchView("pm-view", true);
  assert.equal(ui.elements["#pm-view"].hidden, false);
  assert.equal(ui.elements["#overview-view"].hidden, true);
  const trigger = { focused: false, focus() { this.focused = true; } };
  ui.openModal("rejection-modal", trigger);
  assert.equal(ui.elements["#rejection-modal"].hidden, false);
  ui.closeModal("rejection-modal");
  assert.equal(ui.elements["#rejection-modal"].hidden, true);
  assert.equal(trigger.focused, true, "closing a drawer or modal restores focus to its trigger");
});

test("Provider connections render clear status cards without exposing credentials", () => {
  const ui = loadUi();
  ui.renderProviderConnections({
    mutationEnabled: true,
    secureStore: { supported: true },
    connections: [
      { id: "jira", displayName: "Jira", category: "work-tools", kind: "work-source", status: "configured", installed: true, configured: true, credentialSource: "vault", site: "https://example.atlassian.net", guidance: "Bağlantıyı test edin." },
      { id: "codex", displayName: "Codex", category: "ai-tools", kind: "executor", status: "connected", installed: true, connected: true, selected: true, guidance: "Codex güvenli giriş kullanır." }
    ]
  });
  let cards = ui.elements["#provider-connections-grid"].children;
  assert.equal(cards.length, 1, "work tools tab does not mix AI executors into the grid");
  assert.equal(cards[0].children[0].children[1].textContent, "Yapılandırıldı");
  ui.setProviderConnectionCategory("ai-tools");
  cards = ui.elements["#provider-connections-grid"].children;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].children[0].children[1].textContent, "Bağlı");
  assert.equal(JSON.stringify(cards).includes("token"), false);
});

test("Cockpit markup keeps four Overview KPIs and table-first provider/work surfaces", () => {
  const html = fs.readFileSync(path.resolve("ui/index.html"), "utf8");
  const css = fs.readFileSync(path.resolve("ui/dashboard.css"), "utf8");
  assert.equal((html.match(/class="kpi-card/g) || []).length, 4, "Overview has exactly four primary KPI cards");
  assert.match(html, /id="active-work-tbody"/);
  assert.match(html, /id="attention-list"/);
  assert.match(html, /data-pm-filter="journal"/);
  assert.match(fs.readFileSync(path.resolve("ui/dashboard.js"), "utf8"), /provider-table-wrap/);
  assert.match(html, /id="provider-connections-grid"/);
  assert.match(html, /data-provider-category="work-tools"/);
  assert.match(html, /data-provider-category="ai-tools"/);
  assert.match(html, /data-provider-category="local-ai"/);
  assert.match(html, /data-language="tr"/);
  assert.match(html, /data-language="en"/);
  assert.match(css, /\.language-switcher/);
  assert.match(html, /id="jira-token-input" class="form-input" type="password" autocomplete="new-password"/);
  assert.match(html, /id="provider-token-input" class="form-input" type="password" autocomplete="new-password"/);
  assert.match(html, /id="local-model-select" class="form-input"/);
  assert.match(html, /id="local-endpoint-input" class="form-input" type="url"/);
  assert.match(html, /id="local-endpoint-trust-input" type="checkbox"/);
  assert.doesNotMatch(html, /\sstyle="/, "strict CSP markup contains no inline style attributes");
  assert.doesNotMatch(css, /\.pm-queue-container\s*\{[^}]*display:\s*(grid|flex)/, "table tbody never becomes a grid or flex container");
  assert.match(css, /@media \(max-width: 1100px\)[\s\S]*?\.main-content \{ grid-column: 1; grid-row: 2; min-width: 0; \}/);
});

test("Parent child flow uses dependency stages and plain-language cards", () => {
  const ui = loadUi();
  const children = [
    { issueKey: "PACE-1", summary: "Foundation", dependencies: [], runtimeState: "executing" },
    { issueKey: "PACE-2", summary: "API", dependencies: ["PACE-1"], runtimeState: "ready" },
    { issueKey: "PACE-3", summary: "UI", dependencies: ["PACE-2"], integrationState: "integrated", integratedSha: "abc12345" }
  ];

  const stages = ui.buildExecutionStages(children);
  assert.deepEqual(stages.map(stage => stage.children.map(child => child.issueKey)), [
    ["PACE-1"],
    ["PACE-2"],
    ["PACE-3"]
  ]);

  ui.renderChildDag(children);
  const collectText = node => {
    if (!node) return "";
    let value = node.textContent || node.text || "";
    for (const child of node.children || []) value += " " + collectText(child);
    return value;
  };
  const text = collectText(ui.elements["#parent-dag-container"]);
  assert.match(text, /Hemen başlayabilir/);
  assert.match(text, /Önceki işler tamamlanınca/);
  assert.match(text, /PACE-1/);
  assert.match(text, /PACE-2 tamamlanmalı/);
  assert.doesNotMatch(text, /Dalga 1|Dalga 2/);
  assert.equal(ui.elements["#parent-dag-container"].children[1].children.length, 3);
});


test("Work details render provider-backed data and never remain stuck on loading", async () => {
  const ui = loadUi({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        workItem: { key: "PACE-73", summary: "Live Jira summary", description: "Provider description", canonicalState: "ready", sourceProvider: "jira", autonomousEligible: true },
        orchestratorDecision: {}, agentIdentity: {}, execution: {}, review: {}, humanControl: {}, blockedInfo: {}, history: []
      })
    })
  });
  await ui.openDecisionTrace("PACE-73");
  assert.equal(ui.elements["#trace-issue-summary"].textContent, "Live Jira summary");
  assert.notEqual(ui.elements["#trace-issue-summary"].textContent, "Detaylar yükleniyor...");
  assert.equal(ui.elements["#trace-drawer-body"].children.length > 0, true);
});

test("Work detail failures clear the loading state and show a useful error", async () => {
  const ui = loadUi({ fetchImpl: async () => ({ ok: false, status: 503, statusText: "Unavailable" }) });
  await ui.openDecisionTrace("PACE-404");
  assert.equal(ui.elements["#trace-issue-summary"].textContent, "İş detayı yüklenemedi");
  assert.match(JSON.stringify(ui.elements["#trace-drawer-body"].children), /HTTP 503/);
});

test("Blocked work details expose the bounded technical failure cause", async () => {
  const ui = loadUi({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        workItem: { key: "PACE-323", summary: "FastAPI app factory", canonicalState: "blocked" },
        orchestratorDecision: {},
        agentIdentity: {},
        execution: {},
        review: {},
        humanControl: {},
        blockedInfo: {
          isBlocked: true,
          reason: "Worktree setup failed",
          detail: "fatal: branch is already used by another worktree",
          failureCategory: "tool_host_unavailable",
          autoFailoverEligible: true,
          canRetry: true,
          canApprove: false
        },
        history: []
      })
    })
  });

  await ui.openDecisionTrace("PACE-323");
  assert.match(JSON.stringify(ui.elements["#trace-drawer-body"].children), /branch is already used by another worktree/);
  assert.match(JSON.stringify(ui.elements["#trace-drawer-body"].children), /tool_host_unavailable/);
});

test("Plan preview exposes the approved automatic provider route", () => {
  const ui = loadUi();
  const host = ui.elements["#empty-state"];
  const status = ui.elements["#connection-label"];
  const collectText = node => {
    let value = node?.textContent || node?.text || "";
    for (const child of node?.children || []) value += " " + collectText(child);
    return value;
  };
  ui.renderPlanPreview({
    issue: "PACE-323",
    eligible: true,
    taskAgent: "backend-engineer",
    risk: "high",
    allowedPaths: ["backend/app/**"],
    execution: { provider: "codex", model: "gpt-5.6-sol" },
    executionCandidates: [
      { provider: "codex", model: "gpt-5.6-sol" },
      { provider: "antigravity", model: "claude-opus-4-6-thinking" }
    ]
  }, host, status);
  assert.match(collectText(host), /Yedek rota/);
  assert.match(collectText(host), /antigravity \/ claude-opus-4-6-thinking/);
});

test("Dashboard language can switch between Turkish and English", () => {
  const ui = loadUi();
  ui.applyLanguage("en", { rerender: false });
  assert.equal(ui.state.language, "en");
  assert.equal(ui.STATUS_LABELS.eligible, "Ready");
  assert.equal(ui.translateUiText("Detay"), "Details");
  ui.applyLanguage("tr", { rerender: false });
  assert.equal(ui.state.language, "tr");
  assert.equal(ui.STATUS_LABELS.eligible, "Hazır");
  assert.equal(ui.translateUiText("Details"), "Detay");
});

test("Ineligible plans render a categorized compatibility action in both languages", () => {
  const ui = loadUi();
  const host = ui.elements["#empty-state"];
  const status = ui.elements["#connection-label"];
  const plan = {
    issue: "PACE-257",
    taskAgent: "backend-engineer",
    execution: { provider: "codex" },
    allowedPaths: [],
    eligible: false,
    eligibilityReasons: ["Missing required labels: agent-ready"],
    compatibility: {
      status: "needs_attention",
      items: [{
        id: "labels:agent-ready",
        category: "work_source",
        current: "agent-ready",
        proposed: "agent-ready",
        automatic: false
      }]
    }
  };
  const collectText = node => {
    let value = node?.textContent || node?.text || "";
    for (const child of node?.children || []) value += " " + collectText(child);
    return value;
  };

  ui.renderPlanPreview(plan, host, status, { showCompatibility: true });
  assert.match(collectText(host), /Uyumluluk gerekiyor/);
  assert.match(collectText(host), /İşi uyumlu hale getir/);
  assert.match(collectText(host), /Gerekli iş kaynağı etiketleri eksik/);

  ui.applyLanguage("en", { rerender: false });
  ui.renderPlanPreview(plan, host, status, { showCompatibility: true });
  assert.match(collectText(host), /Compatibility required/);
  assert.match(collectText(host), /Make work item compatible/);
  assert.match(collectText(host), /Required work-source labels are missing/);
});

test("Unmatched work renders a required local project selector in both languages", () => {
  const ui = loadUi();
  const host = ui.elements["#empty-state"];
  const status = ui.elements["#connection-label"];
  const resolution = {
    reason: "no_match",
    profiles: [
      { id: "agent-scaffold", name: "AgentScaffold", repository: "agent-scaffold", baseBranch: "epic/provider-neutral-control-plane" },
      { id: "houndvision", name: "Houndvision", repository: "houndvision", baseBranch: "develop" }
    ]
  };
  const collectText = node => {
    let value = node?.textContent || node?.text || "";
    for (const child of node?.children || []) value += " " + collectText(child);
    return value;
  };

  ui.renderProjectSelection("PACE-257", resolution, host, status);
  assert.match(collectText(host), /Proje seçimi gerekli/);
  assert.match(collectText(host), /Houndvision · houndvision · develop/);
  const panel = host.children[0];
  const select = panel.children.find(child => child.tag === "label").children[0];
  const submit = panel.children.find(child => child.className.includes("project-selection-submit"));
  assert.equal(submit.disabled, true);
  select.value = "houndvision";
  select.listeners.change();
  assert.equal(submit.disabled, false);

  ui.applyLanguage("en", { rerender: false });
  ui.renderProjectSelection("PACE-257", resolution, host, status);
  assert.match(collectText(host), /Project selection required/);
  assert.match(collectText(host), /No repository match was found/);
});

test("Missing parent branch renders a selector populated only with existing Git refs", () => {
  const ui = loadUi();
  const host = ui.elements["#empty-state"];
  const status = ui.elements["#connection-label"];
  const plan = {
    issue: "PACE-323",
    projectProfileId: "houndvision",
    projectProfile: { name: "Houndvision", repository: "houndvision" },
    taskAgent: "backend-engineer",
    execution: { provider: "codex" },
    allowedPaths: ["backend/app/**", "backend/tests/**"],
    eligible: false,
    eligibilityReasons: ["Git base ref does not exist: epic/pace-254"],
    compatibility: {
      status: "needs_attention",
      items: [{ id: "base-ref:epic/pace-254", category: "source_control" }]
    },
    availableBaseRefs: [
      { ref: "develop", sha: "a".repeat(40) },
      { ref: "master", sha: "b".repeat(40) }
    ]
  };
  const collectText = node => {
    let value = node?.textContent || node?.text || "";
    for (const child of node?.children || []) value += " " + collectText(child);
    return value;
  };

  ui.renderPlanPreview(plan, host, status);
  assert.match(collectText(host), /Git tabanı seç/);
  assert.match(collectText(host), /develop · aaaaaaaaaa/);
  assert.doesNotMatch(collectText(host), /epic\/pace-254 ·/);
  const panel = host.children.find(child => child.className.includes("base-ref-selection-panel"));
  const select = panel.children.find(child => child.tag === "label").children[0];
  const submit = panel.children.find(child => child.className.includes("base-ref-selection-submit"));
  assert.equal(submit.disabled, true);
  select.value = "develop";
  select.listeners.change();
  assert.equal(submit.disabled, false);
});


test("Parent details clear loading state on both success and failure", async () => {
  const success = loadUi({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        parent: {
          parent: { key: "PACE-6", summary: "Live parent epic" },
          state: "active",
          children: []
        }
      })
    })
  });
  await success.fetchParentDetail("PACE-6");
  assert.equal(success.elements["#parent-summary-text"].textContent, "Live parent epic");
  assert.equal(success.elements["#parent-select"].disabled, false);

  const failure = loadUi({
    fetchImpl: async () => ({ ok: false, status: 502, statusText: "Bad Gateway" })
  });
  await failure.fetchParentDetail("PACE-6");
  assert.match(failure.elements["#parent-summary-text"].textContent, /Parent detayı yüklenemedi/);
  assert.doesNotMatch(failure.elements["#parent-summary-text"].textContent, /yükleniyor/i);
  assert.equal(failure.elements["#parent-select"].disabled, false);
});


test("History state excludes DOM elements and remains structured-clone safe", () => {
  const calls = [];
  const windowImpl = {
    location: { pathname: "/", search: "" },
    history: {
      pushState(value, _title, url) { structuredClone(value); calls.push({ value, url }); },
      replaceState(value, _title, url) { structuredClone(value); calls.push({ value, url }); }
    },
    addEventListener() {}
  };
  const ui = loadUi({ windowImpl });
  ui.state.currentView = "pm-view";
  ui.state.selectedWorkItemKey = "PACE-73";
  ui.state.lastFocusedElement = ui.elements["#trace-trigger-row"];
  ui.syncUrlState(false);
  assert.deepEqual(calls[0].value, { view: "pm-view", parent: null, issue: "PACE-73", run: null });
  assert.equal(calls[0].url, "/?view=pm&issue=PACE-73");
  assert.equal("lastFocusedElement" in calls[0].value, false);
});
