import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function setupMockDOM() {
  const elements = {};
  const clipboardWrites = [];
  const document = {
    querySelector: (sel) => {
      if (!elements[sel]) elements[sel] = createElement("div");
      return elements[sel];
    },
    getElementById: (id) => {
      const sel = "#" + id;
      if (!elements[sel]) elements[sel] = createElement("div");
      return elements[sel];
    },
    querySelectorAll: () => [],
    createElement: createElement,
    createTextNode: (text) => ({ textNode: true, text }),
    hidden: false
  };

  function createElement(tag) {
    const el = {
      tag,
      className: "",
      textContent: "",
      children: [],
      style: {},
      attributes: {},
      href: "",
      target: "",
      rel: "",
      disabled: false,
      title: "",
      onclick: null,
      append: (...nodes) => {
        for (const n of nodes) {
          if (typeof n === 'string') el.children.push({ textNode: true, text: n });
          else el.children.push(n);
        }
      },
      replaceChildren: (...nodes) => {
        el.children = [];
        el.append(...nodes);
      },
      setAttribute: (k, v) => { el.attributes[k] = v; },
      classList: {
        toggle: (c, force) => {
          let cls = el.className.split(" ").filter(Boolean);
          if (force) { if (!cls.includes(c)) cls.push(c); }
          else { cls = cls.filter(x => x !== c); }
          el.className = cls.join(" ");
        }
      },
      addEventListener: () => {}
    };
    return el;
  }

  const globalScope = {
    document,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setInterval: () => {},
    Intl: global.Intl,
    console: global.console,
    Math: global.Math,
    Date: global.Date,
    String: global.String,
    JSON: global.JSON,
    confirm: () => true,
    navigator: { clipboard: { writeText: async (value) => clipboardWrites.push(value) } }
  };

  return { globalScope, elements, clipboardWrites };
}

test("Dashboard UI grouping, Jira links, blockers, tokens, quotas", async () => {
  const code = fs.readFileSync(path.resolve("ui/dashboard.js"), "utf8");
  const { globalScope, elements, clipboardWrites } = setupMockDOM();

  // Inject the code into a function that acts as the global scope
  const runUI = new Function(...Object.keys(globalScope), code + "\nreturn { state, renderRuns, renderCapacity };");
  const ui = runUI(...Object.values(globalScope));

  // Set up test data
  ui.state.snapshot = {
    runs: [
      { id: 2, issue: "PACE-1", summary: "First task", role: "worker", retryOfRunId: 1, stateKind: "blocked", state: "blocked", tokens: 25, usageAvailable: true, attempt: 2, createdAt: "2026-08-11T10:01:00Z", workerStatus: "finished", blockers: ["Needs review"], resolution: "Retry worker", humanActionRequired: false },
      { id: 4, issue: "PACE-1", summary: "First task", role: "integration", stateKind: "blocked", state: "human_action_required", tokens: 0, usageAvailable: false, attempt: 3, createdAt: "2026-08-11T10:03:00Z", workerStatus: "finished", blockers: ["Explicit approval required"], resolution: "Send approval in main chat", humanActionRequired: true, userExpectation: "APPROVE TASK TO EPIC" },
      { id: 5, issue: "PACE-1", summary: "First task", role: "reviewer", stateKind: "review", state: "review_queued", tokens: 0, usageAvailable: false, attempt: 1, createdAt: "2026-08-11T10:03:00Z", workerStatus: "queued" },
      { id: 3, issue: "PACE-2", summary: "Second task", stateKind: "active", state: "verifying", tokens: 0, usageAvailable: false, attempt: 1, createdAt: "2026-08-11T10:02:00Z", workerStatus: "running" },
      { id: 1, issue: "PACE-1", summary: "First task", role: "worker", stateKind: "active", state: "failed", tokens: 10, usageAvailable: true, attempt: 1, createdAt: "2026-08-11T10:00:00Z", workerStatus: "finished" }
    ],
    capacity: {
      active: 1,
      total: 3,
      providers: [
        { name: "antigravity", active: 1, limit: 3, quota: 4000 },
        { name: "codex", active: 0, limit: 1 } // no quota
      ]
    },
    policy: { maxAttempts: 3 },
    capabilities: { retryHandler: true }
  };

  ui.renderRuns();

  const grid = elements["#agent-grid"];
  const cards = grid.children;

  // Test 1: Grouping - should group 3 runs into 2 task cards
  assert.equal(cards.length, 2);

  const task1Card = cards[0];
  // Test 2: Jira links
  // We need to find the link element
  const topline = task1Card.children.find(c => c.className === "card-topline");
  const leftGroup = topline.children.find(c => c.className === "topline-left");
  const issueLink = leftGroup.children.find(c => c.className === "issue-key-link");
  assert.equal(issueLink.href, "https://houndvision.atlassian.net/browse/PACE-1");
  const taskTitle = task1Card.children.find(c => c.className === "task-title");
  const taskTitleLink = taskTitle.children.find(c => c.className === "task-title-link");
  assert.equal(taskTitleLink.href, "https://houndvision.atlassian.net/browse/PACE-1");
  assert.equal(taskTitleLink.target, "_blank");

  assert.equal(issueLink.target, "_blank");
  assert.equal(issueLink.rel, "noopener noreferrer");

  const roleLanes = task1Card.children.find(c => c.className === "role-lanes");
  assert.equal(roleLanes.children.length, 3, "worker, reviewer and integration must stay in independent lanes");
  const workerLane = roleLanes.children.find(c => c.className.includes("role-lane-worker"));
  const reviewerLane = roleLanes.children.find(c => c.className.includes("role-lane-reviewer"));
  assert.ok(workerLane);
  assert.ok(reviewerLane);
  const integrationLane = roleLanes.children.find(c => c.className.includes("role-lane-integration"));
  assert.ok(integrationLane);

  // Test 3: Blocker resolution / user expectation
  const blockerNote = workerLane.children.find(c => c.className.includes("blocker-note"));
  assert.ok(blockerNote, "Blocker note should be rendered for blocked task");
  const blockerTitle = blockerNote.children.find(c => c.className === "blocker-title");
  assert.equal(blockerTitle.textContent, "Otomatik çözüm bekliyor");
  const blockerCause = blockerNote.children.find(c => c.className === "blocker-cause");
  assert.equal(blockerCause.textContent, "Neden durdu: Needs review");
  const blockerAction = blockerNote.children.find(c => c.className === "blocker-action");
  assert.equal(blockerAction.textContent, "Sonraki adım: Retry worker");

  // Test 4: Retry eligibility/disabled state
  const blockerExpectation = blockerNote.children.find(c => c.className === "blocker-expectation");
  assert.match(blockerExpectation.textContent, /Senden beklenen: Bir işlem yok/);
  const retryPanel = workerLane.children.find(c => c.className === "retry-panel");
  const retryBtn = retryPanel.children.find(c => c.className === "retry-button");
  assert.ok(retryBtn, "Retry button should be present for blocked task");
  assert.equal(retryBtn.disabled, false); // 2 attempts < 3 maxAttempts

  // Test 5: Token unavailable vs used
  const footer1 = task1Card.children.find(c => c.className === "agent-card-footer");
  const tokenText1 = footer1.children[0].textContent;
  assert.match(tokenText1, /35 token toplam/); // 10 + 25
  assert.match(tokenText1, /son deneme usage unavailable/);

  const task2Card = cards[1];
  const footer2 = task2Card.children.find(c => c.className === "agent-card-footer");
  const tokenText2 = footer2.children[0].textContent;
  assert.equal(tokenText2, "Usage unavailable"); // 0 tokens

  // Test 6: Provider quota unavailable
  ui.renderCapacity();
  const providerList = elements["#provider-list"];
  const antProv = providerList.children[0];
  const antLabel = antProv.children[0];
  const antStats = antLabel.children[1];
  const antQuota = antStats.children[1];
  assert.match(antQuota.textContent, /Remaining quota: 4\.000/);

  const cxProv = providerList.children[1];
  const cxLabel = cxProv.children[0];
  const cxStats = cxLabel.children[1];
  const cxQuota = cxStats.children[1];
  assert.equal(cxQuota.textContent, "Provider does not expose remaining quota");
});
