import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadSettings } from "../lib/config.js";

const examplePath = path.resolve(import.meta.dirname, "..", "agent-scaffold.example.json");

function writeConfig(mutator) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "control-exec-config-"));
  const config = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  config.project.repoPath = ".";
  config.worktree.root = "worktrees";
  mutator(config);
  const file = path.join(directory, "agent-scaffold.json");
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

test("dashboard execution and operator interaction default to disabled", () => {
  const file = writeConfig(config => {
    delete config.controlPlane.executionMutationEnabled;
    delete config.controlPlane.operatorInteractionMutationEnabled;
  });
  const settings = loadSettings(file);
  assert.equal(settings.data.controlPlane.executionMutationEnabled, false);
  assert.equal(settings.data.controlPlane.operatorInteractionMutationEnabled, false);
});

test("dashboard execution mutation flags reject non-boolean values", () => {
  const executionFile = writeConfig(config => {
    config.controlPlane.executionMutationEnabled = "yes";
  });
  assert.throws(() => loadSettings(executionFile), /executionMutationEnabled must be a boolean/);

  const interactionFile = writeConfig(config => {
    config.controlPlane.operatorInteractionMutationEnabled = 1;
  });
  assert.throws(() => loadSettings(interactionFile), /operatorInteractionMutationEnabled must be a boolean/);
});
