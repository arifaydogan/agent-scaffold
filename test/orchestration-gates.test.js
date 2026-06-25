import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("canonical PaceBuild contract enforces orchestration gates", () => {
  const contract = fs.readFileSync("PACEBUILD_ORCHESTRATOR.md", "utf8");

  assert.match(contract, /parent = <ISSUE_KEY>/);
  assert.match(contract, /Phase 0 completion gate/);
  assert.match(contract, /first executable issue identified/);
  assert.match(contract, /Phase 0 is blocked and cannot be marked complete/);
  assert.match(contract, /Narrow routing gate/);
  assert.match(contract, /Do not select `architect`/);
  assert.match(contract, /`cv-engineer`/);
  assert.match(contract, /Never silently carry tracked changes/);
  assert.match(contract, /remote default branch/);
  assert.match(contract, /Phase 2 completion gate/);
  assert.match(contract, /mock CV mode must/);
  assert.match(contract, /Temporary files such as `cv2\.py`/);
  assert.match(contract, /git diff --check/);
  assert.match(contract, /\^pace-\[0-9\]\+/);
  assert.match(contract, /Phase 3 must be a distinct state/);
  assert.match(contract, /unused imports, dead variables/);
  assert.match(contract, /ruff check <changed-python-files>/);
  assert.match(contract, /ad-hoc[\s\S]*supplemental evidence/);
  assert.match(contract, /failed `pytest`[\s\S]*cannot be replaced/);
  assert.match(contract, /timezone-aware UTC values/);
  assert.match(contract, /Automatic review-fix loop/);
  assert.match(contract, /three review-fix iterations/);
  assert.match(contract, /do not ask the user to diagnose or approve each fix/);
  assert.match(contract, /configured review status, normally `In Review`/);
  assert.match(contract, /transition only the implemented child issue/);
});

test("every provider adapter loads the canonical PaceBuild contract", () => {
  const adapters = [
    "adapters/antigravity/pacebuild-orchestrator/SKILL.md",
    "adapters/codex/pacebuild-orchestrator/SKILL.md",
    "adapters/pacebuild-orchestrator.agent.md"
  ];

  for (const file of adapters) {
    const adapter = fs.readFileSync(file, "utf8");
    assert.match(adapter, /PACEBUILD_ORCHESTRATOR\.md/, file);
    assert.match(adapter, /provider-neutral/, file);
  }
});
