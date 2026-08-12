import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadSettings, updateProviderSelections } from "../lib/config.js";
import { writeProviderConfig } from "../test-support/provider-config-fixture.js";

test("legacy Jira config normalizes into a WorkSourceProvider", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-"));
  const legacy = {
    project: { key: "TEST", repoPath: "." },
    policy: { requiredLabels: [], humanOnlyStatuses: [], maxConcurrency: 1 },
    worktree: { root: "." },
    jira: { baseUrl: "https://example.atlassian.net" },
    executor: { defaultProvider: "codex", providers: {} }
  };
  const file = path.join(directory, "legacy.json");
  fs.writeFileSync(file, JSON.stringify(legacy), "utf8");
  const settings = loadSettings(file);
  assert.equal(settings.data.workSource.defaultProvider, "jira");
  assert.equal(settings.data.workSource.providers.jira.type, "jira");
  assert.equal(settings.data.orchestrator.defaultProvider, "builtin");
});

test("safe config mutation changes only allowlisted provider selections", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-"));
  const { file, config } = writeProviderConfig(directory, true);
  const settings = loadSettings(file);
  const updated = updateProviderSelections(settings, {
    workSource: "github-issues",
    executor: "antigravity"
  });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));

  assert.equal(updated.data.workSource.defaultProvider, "github-issues");
  assert.equal(updated.data.executor.defaultProvider, "antigravity");
  assert.deepEqual(raw.policy, config.policy);
  assert.deepEqual(raw.executor.providers, config.executor.providers);
  assert.equal(raw.workSource.providers.jira.writeEnabled, false);
  assert.throws(
    () => updateProviderSelections(updated, { supervisor: "unsafe" }),
    /Unsupported config fields/
  );
});


test("provider selection mutation is fail-closed when disabled", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-"));
  const { file } = writeProviderConfig(directory, false);
  const settings = loadSettings(file);
  assert.throws(
    () => updateProviderSelections(settings, { workSource: "github-issues" }),
    /mutation is disabled/i
  );
});
