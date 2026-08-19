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
    activeElement: null, hidden: false
  };
  return { elements, globalScope: { document, fetch: async () => ({ ok: true, json: async () => ({}) }), setInterval: () => {}, Intl: global.Intl, console: global.console, Math: global.Math, Date: global.Date, String: global.String, JSON: global.JSON, confirm: () => true, navigator: { clipboard: { writeText: async () => {} } } } };
}

function loadUi() {
  const code = fs.readFileSync(path.resolve("ui/dashboard.js"), "utf8");
  const { elements, globalScope } = setupMockDOM();
  const runUI = new Function(...Object.keys(globalScope), code + "\nreturn { state, renderRuns, renderOverview, renderPmWorkspace, switchView, openModal, closeModal };");
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

test("Cockpit markup keeps four Overview KPIs and table-first provider/work surfaces", () => {
  const html = fs.readFileSync(path.resolve("ui/index.html"), "utf8");
  const css = fs.readFileSync(path.resolve("ui/dashboard.css"), "utf8");
  assert.equal((html.match(/class="kpi-card/g) || []).length, 4, "Overview has exactly four primary KPI cards");
  assert.match(html, /id="active-work-tbody"/);
  assert.match(html, /id="attention-list"/);
  assert.match(html, /data-pm-filter="journal"/);
  assert.match(fs.readFileSync(path.resolve("ui/dashboard.js"), "utf8"), /provider-table-wrap/);
  assert.doesNotMatch(html, /\sstyle="/, "strict CSP markup contains no inline style attributes");
  assert.doesNotMatch(css, /\.pm-queue-container\s*\{[^}]*display:\s*(grid|flex)/, "table tbody never becomes a grid or flex container");
  assert.match(css, /@media \(max-width: 1100px\)[\s\S]*?\.main-content \{ grid-column: 1; grid-row: 2; min-width: 0; \}/);
});
