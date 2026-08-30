import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { startDashboardServer } from "../lib/dashboard.js";
import {
  buildDashboardParentDetail,
  buildDashboardWorkItemDetail,
  loadDashboardWorkSourceCatalog
} from "../lib/dashboard-work-source.js";
import { RunStore } from "../lib/store.js";

function dashboardSettings(directory) {
  return {
    source: path.join(directory, "agent-scaffold.json"),
    projectKey: "PACE",
    data: {
      project: { operatingMode: "AUTONOMOUS" },
      policy: { maxConcurrency: 2, providerConcurrency: {}, maxAttempts: 3 },
      workSource: { defaultProvider: "jira", providers: { jira: { type: "jira" } } },
      controlPlane: {}
    }
  };
}

function providerFixture() {
  const parent = {
    key: "PACE-100",
    summary: "Control Plane Epic",
    description: "Parent description",
    issueType: "Epic",
    status: "To Do",
    canonicalState: "ready",
    labels: [],
    source: { provider: "jira", id: "100", url: "https://example.atlassian.net/browse/PACE-100" }
  };
  const child = {
    key: "PACE-101",
    summary: "Dashboard catalog",
    description: "Child description from Jira",
    issueType: "Story",
    status: "In Progress",
    canonicalState: "in_progress",
    labels: ["agent-ready"],
    parentKey: "PACE-100",
    assignee: "Arif",
    source: { provider: "jira", id: "101", url: "https://example.atlassian.net/browse/PACE-101" }
  };
  const provider = {
    name: "jira",
    listQueries: [],
    async listWorkItems(query) { this.listQueries.push(query); return [parent, child]; },
    async getWorkItem(key) { return key === parent.key ? parent : child; },
    async getChildren(key) { return key === parent.key ? [child] : []; }
  };
  return provider;
}

test("dashboard work-source catalog normalizes items, details, and parent children without raw payloads", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-work-source-"));
  const settings = dashboardSettings(directory);
  const provider = providerFixture();
  const catalog = await loadDashboardWorkSourceCatalog(settings, provider);

  assert.equal(catalog.provider, "jira");
  assert.equal(catalog.items.length, 2);
  assert.equal(catalog.parents.length, 1);
  assert.equal(catalog.items[1].description, "Child description from Jira");
  assert.equal("raw" in catalog.items[1], false);
  assert.equal(provider.listQueries[0].includeDescription, false);

  const detail = buildDashboardWorkItemDetail(catalog.items[1], settings);
  assert.equal(detail.providerOnly, true);
  assert.equal(detail.workItem.parentKey, "PACE-100");
  assert.equal(detail.workItem.description, "Child description from Jira");

  const parentDetail = await buildDashboardParentDetail(catalog.parents[0], provider);
  assert.equal(parentDetail.readOnly, true);
  assert.equal(parentDetail.children[0].issueKey, "PACE-101");
  assert.equal(parentDetail.children[0].runtimeState, "In Progress");
});

test("live dashboard exposes connected work-source items and provider-only parent/detail fallbacks", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-work-source-api-"));
  const settings = dashboardSettings(directory);
  const store = new RunStore(path.join(directory, "runs.sqlite3"));
  const provider = providerFixture();
  const providerConnections = {
    safeError(error) { return error.message; },
    async list() { return { connections: [] }; }
  };
  const dashboard = await startDashboardServer(settings, {
    port: 0,
    store,
    workSource: provider,
    providerConnections,
    workSourceCatalogTtlMs: 60_000
  });
  try {
    const catalog = await fetch(`${dashboard.url}/api/work-source/catalog`).then(response => response.json());
    assert.equal(catalog.items.length, 2);
    assert.equal(catalog.parents[0].key, "PACE-100");

    const itemDetail = await fetch(`${dashboard.url}/api/pm/work-items/PACE-101`).then(response => response.json());
    assert.equal(itemDetail.providerOnly, true);
    assert.equal(itemDetail.workItem.description, "Child description from Jira");

    const parents = await fetch(`${dashboard.url}/api/pm/parents`).then(response => response.json());
    assert.equal(parents.parents[0].key, "PACE-100");

    const parentDetail = await fetch(`${dashboard.url}/api/pm/parents/PACE-100`).then(response => response.json());
    assert.equal(parentDetail.parent.providerOnly, true);
    assert.equal(parentDetail.parent.children[0].issueKey, "PACE-101");
  } finally {
    dashboard.server.closeAllConnections?.();
    await new Promise(resolve => dashboard.server.close(resolve));
  }
});

test("demo dashboard catalog is explicit and never calls the connected work source", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-work-source-demo-"));
  const settings = dashboardSettings(directory);
  const store = new RunStore(path.join(directory, "runs.sqlite3"));
  let calls = 0;
  const dashboard = await startDashboardServer(settings, {
    port: 0,
    demo: true,
    store,
    workSource: { async listWorkItems() { calls += 1; return []; } },
    providerConnections: { safeError: error => error.message, async list() { return { connections: [] }; } }
  });
  try {
    const catalog = await fetch(`${dashboard.url}/api/work-source/catalog`).then(response => response.json());
    assert.equal(catalog.demo, true);
    assert.deepEqual(catalog.items, []);
    assert.equal(calls, 0);
  } finally {
    dashboard.server.closeAllConnections?.();
    await new Promise(resolve => dashboard.server.close(resolve));
  }
});
