import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadSettings } from "../lib/config.js";
import { buildDashboardSnapshot, startDashboardServer } from "../lib/dashboard.js";
import { RunStore } from "../lib/store.js";
import { writeProviderConfig } from "../test-support/provider-config-fixture.js";

test("snapshot exposes project, provider, workflow, capability, and safety metadata", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-"));
  const { file } = writeProviderConfig(directory, false);
  fs.copyFileSync(path.resolve("sources.lock.json"), path.join(directory, "sources.lock.json"));
  const settings = loadSettings(file);
  const store = new RunStore(path.join(directory, "runs.sqlite3"));
  const snapshot = buildDashboardSnapshot(settings, { store });

  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.projectInfo.name, "Test Project");
  assert.equal(snapshot.config.selections.workSource, "jira");
  assert.ok(snapshot.providers.workSources.some((provider) => provider.id === "github-issues"));
  assert.ok(snapshot.workflow.canonicalStates.includes("review"));
  assert.ok(snapshot.capabilities.registry.some((capability) => capability.id === "minimal-change"));
  assert.equal(snapshot.config.safety.mergeHumanOnly, true);
  assert.equal(JSON.stringify(snapshot).includes("TOKEN"), false);
  assert.equal(JSON.stringify(snapshot).includes("secret-tools"), false);
});

test("local config API is fail-closed and only mutates provider selection", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-"));
  const disabledConfig = writeProviderConfig(directory, false);
  let settings = loadSettings(disabledConfig.file);
  const store = new RunStore(path.join(directory, "runs.sqlite3"));
  let dashboard = await startDashboardServer(settings, { port: 0, store });
  try {
    const denied = await fetch(`${dashboard.url}/api/config/providers`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workSource: "github-issues" })
    });
    assert.equal(denied.status, 403);
  } finally {
    await new Promise((resolve) => dashboard.server.close(resolve));
  }

  writeProviderConfig(directory, true);
  settings = loadSettings(disabledConfig.file);
  dashboard = await startDashboardServer(settings, { port: 0, store });
  try {
    const wrongType = await fetch(`${dashboard.url}/api/config/providers`, {
      method: "PATCH",
      body: JSON.stringify({ workSource: "github-issues" })
    });
    assert.equal(wrongType.status, 415);

    const hostileOrigin = await fetch(`${dashboard.url}/api/config/providers`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ workSource: "github-issues" })
    });
    assert.equal(hostileOrigin.status, 403);

    const changed = await fetch(`${dashboard.url}/api/config/providers`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workSource: "github-issues" })
    });
    assert.equal(changed.status, 200);
    const body = await changed.json();
    assert.equal(body.config.selections.workSource, "github-issues");
    const raw = JSON.parse(fs.readFileSync(disabledConfig.file, "utf8"));
    assert.equal(raw.workSource.defaultProvider, "github-issues");
    assert.equal(raw.workSource.providers["github-issues"].writeEnabled, false);
  } finally {
    await new Promise((resolve) => dashboard.server.close(resolve));
  }
});
