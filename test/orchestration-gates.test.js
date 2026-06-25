import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Antigravity orchestrator requires child issue evidence before Phase 0 completes", () => {
  const skill = fs.readFileSync(
    "adapters/antigravity/pacebuild-orchestrator/SKILL.md",
    "utf8"
  );

  assert.match(skill, /parent = <ISSUE_KEY>/);
  assert.match(skill, /Phase 0 completion gate/);
  assert.match(skill, /first executable issue identified/);
  assert.match(skill, /Phase 0 is blocked and cannot be marked complete/);
  assert.match(skill, /Narrow routing gate/);
  assert.match(skill, /Do not select `architect`/);
  assert.match(skill, /`cv-engineer`/);
  assert.match(skill, /Never silently carry tracked changes/);
  assert.match(skill, /remote default branch/);
  assert.match(skill, /Phase 2 completion gate/);
  assert.match(skill, /mock CV mode must/);
  assert.match(skill, /Temporary files such as `cv2\.py`/);
  assert.match(skill, /git diff --check/);
  assert.match(skill, /\^pace-\[0-9\]\+/);
  assert.match(skill, /Phase 3 must be a distinct state/);
  assert.match(skill, /unused imports, dead variables/);
  assert.match(skill, /ruff check <changed-python-files>/);
  assert.match(skill, /ad-hoc[\s\S]*supplemental evidence/);
  assert.match(skill, /failed `pytest`[\s\S]*cannot be replaced/);
  assert.match(skill, /timezone-aware UTC values/);
});

test("Copilot orchestrator requires a separate child issue query", () => {
  const agent = fs.readFileSync(
    "adapters/pacebuild-orchestrator.agent.md",
    "utf8"
  );

  assert.match(agent, /separate Jira child query/);
  assert.match(agent, /first executable child/);
  assert.match(agent, /do not default to `architect`/);
  assert.match(agent, /unrelated setup\/feature branch/);
});
