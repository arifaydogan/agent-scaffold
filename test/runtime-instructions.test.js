import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { materializeWorkspaceInstructions } from "../lib/runtime.js";

test("git-ignored orchestration context is copied into a worktree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-instructions-"));
  const repoPath = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(path.join(repoPath, ".agents", "rules"), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  for (const file of [
    "AGENTS.md",
    "ORCHESTRATION.md",
    "PACEBUILD_ORCHESTRATOR.md"
  ]) {
    fs.writeFileSync(path.join(repoPath, file), file, "utf8");
  }
  fs.writeFileSync(
    path.join(repoPath, ".agents", "rules", "orchestration-gates.md"),
    "gates",
    "utf8"
  );

  const result = materializeWorkspaceInstructions({ repoPath }, worktree);

  assert.deepEqual(result.missing, []);
  assert.equal(
    fs.readFileSync(path.join(worktree, "PACEBUILD_ORCHESTRATOR.md"), "utf8"),
    "PACEBUILD_ORCHESTRATOR.md"
  );
  assert.equal(
    fs.readFileSync(
      path.join(worktree, ".agents", "rules", "orchestration-gates.md"),
      "utf8"
    ),
    "gates"
  );
});

test("missing canonical instructions are reported", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-instructions-"));
  const result = materializeWorkspaceInstructions(
    { repoPath: path.join(root, "repo") },
    path.join(root, "worktree")
  );
  assert.equal(result.missing.length, 4);
});
