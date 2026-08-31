import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadSettings } from "../lib/config.js";
import {
  listProjectBaseRefs,
  resolveProjectProfile,
  settingsForProjectProfile
} from "../lib/project-profiles.js";

function settingsFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "project-profiles-"));
  const config = {
    project: { key: "PACE", repoPath: ".", baseBranch: "develop" },
    projectProfiles: {
      "agent-scaffold": {
        name: "AgentScaffold",
        repoPath: ".",
        worktreeRoot: "../agent-worktrees",
        baseBranch: "epic/provider-neutral-control-plane",
        match: { labels: ["agent-scaffold"], components: ["AgentScaffold"] }
      },
      houndvision: {
        name: "Houndvision",
        repoPath: "../houndvision",
        worktreeRoot: "../houndvision-worktrees",
        baseBranch: "develop",
        match: { labels: ["houndvision"], components: ["Houndvision"] }
      }
    },
    policy: { requiredLabels: ["agent-ready"], humanOnlyStatuses: ["Done"] },
    worktree: { root: "../agent-worktrees" },
    jira: { baseUrl: "https://example.atlassian.net", writeEnabled: false },
    executor: { defaultProvider: "codex", providers: {} }
  };
  const source = path.join(directory, "agent-scaffold.json");
  fs.writeFileSync(source, JSON.stringify(config), "utf8");
  return loadSettings(source);
}

test("project profiles resolve labels, components, and parent metadata in precedence order", () => {
  const settings = settingsFixture();
  assert.equal(
    resolveProjectProfile(settings, { labels: ["houndvision"], components: [] }).profile.id,
    "houndvision"
  );
  assert.equal(
    resolveProjectProfile(settings, { labels: [], components: ["AgentScaffold"] }).profile.id,
    "agent-scaffold"
  );
  const inherited = resolveProjectProfile(
    settings,
    { labels: [], components: [], parentKey: "PACE-254" },
    { parentIssue: { labels: ["houndvision"], components: [] } }
  );
  assert.equal(inherited.profile.id, "houndvision");
  assert.equal(inherited.source, "parent-label");
});

test("unmatched work requires manual selection and selected settings use the chosen repo", () => {
  const settings = settingsFixture();
  const required = resolveProjectProfile(settings, { labels: [], components: [] });
  assert.equal(required.status, "required");
  assert.equal(required.reason, "no_match");
  assert.deepEqual(required.profiles.map(profile => profile.id), ["agent-scaffold", "houndvision"]);

  const selected = resolveProjectProfile(
    settings,
    { labels: [], components: [] },
    { requestedProfileId: "houndvision" }
  );
  const scoped = settingsForProjectProfile(settings, selected.profile.id);
  assert.equal(path.basename(scoped.repoPath), "houndvision");
  assert.equal(path.basename(scoped.worktreeRoot), "houndvision-worktrees");
  assert.equal(scoped.data.project.baseBranch, "develop");

  const saved = resolveProjectProfile(
    settings,
    { labels: [], components: [] },
    { savedProfileId: "houndvision" }
  );
  assert.equal(saved.profile.id, "houndvision");
  assert.equal(saved.source, "saved-manual");

  const staleSaved = resolveProjectProfile(
    settings,
    { labels: [], components: [] },
    { savedProfileId: "removed-profile" }
  );
  assert.equal(staleSaved.status, "required", "removed local mappings fail closed to a fresh selection");
});

test("manual selection cannot override an unambiguous ticket mapping", () => {
  const settings = settingsFixture();
  const result = resolveProjectProfile(
    settings,
    { labels: ["agent-scaffold"], components: [] },
    { requestedProfileId: "houndvision" }
  );
  assert.equal(result.status, "required");
  assert.equal(result.reason, "selection_conflicts_with_work_item");
  assert.equal(result.detectedProfileId, "agent-scaffold");
});

test("Git base refs are listed from the chosen repository with stable ordering", () => {
  const settings = settingsForProjectProfile(settingsFixture(), "houndvision");
  const refs = listProjectBaseRefs(settings, {
    spawnSync: (_command, args) => {
      assert.ok(args.includes(settings.repoPath));
      return {
        status: 0,
        stdout: [
          `epic/pace-244\t${"c".repeat(40)}`,
          `master\t${"b".repeat(40)}`,
          `develop\t${"a".repeat(40)}`,
          `origin/HEAD\t${"d".repeat(40)}`
        ].join("\n")
      };
    }
  });
  assert.deepEqual(refs.map(candidate => candidate.ref), ["develop", "master", "epic/pace-244"]);
});
