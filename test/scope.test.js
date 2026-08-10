import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGitStatus,
  pathMatchesScope,
  validateChangedFiles
} from "../lib/scope.js";

test("path scopes support recursive and top-level patterns", () => {
  assert.equal(pathMatchesScope("frontend/src/page.tsx", "frontend/**"), true);
  assert.equal(pathMatchesScope("backend/main.py", "frontend/**"), false);
  assert.equal(pathMatchesScope("README.md", "*.md"), true);
});

test("changed files outside agent scope are blocked", () => {
  const result = validateChangedFiles({
    changedFiles: ["frontend/src/page.tsx", "backend/main.py"],
    allowedPatterns: ["frontend/**"],
    maxChangedFiles: 10
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.violations, ["backend/main.py"]);
});

test("git status parsing keeps untracked files and rename destinations", () => {
  assert.deepEqual(
    parseGitStatus(" M frontend/a.tsx\n?? frontend/new.tsx\nR  old.ts -> frontend/newer.ts\n"),
    ["frontend/a.tsx", "frontend/new.tsx", "frontend/newer.ts"]
  );
});
