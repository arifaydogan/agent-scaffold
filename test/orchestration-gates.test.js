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
  assert.match(contract, /Confluence validation page/);
  assert.match(contract, /manual test cases with preconditions, steps/);
  assert.match(contract, /user-visible change log/);
  assert.match(contract, /lowest-cost model and reasoning effort/);
  assert.match(contract, /Adapters own concrete model names/);
  assert.match(contract, /`PACE-43 REVIEW` is a distinct read-only command/);
  assert.match(contract, /It must not infer a branch from the current checkout/);
});

test("product discovery separates conversational refinement from backlog writes", () => {
  const discovery = fs.readFileSync("PACEBUILD_DISCOVERY.md", "utf8");

  assert.match(discovery, /DISCOVERY:/);
  assert.match(discovery, /Persona: `product-manager`/);
  assert.match(discovery, /Task agent: `pm-analyst`/);
  assert.match(discovery, /completed and in-review work/);
  assert.match(discovery, /APPROVE BACKLOG WRITES/);
  assert.match(discovery, /Do not create or edit Jira issues, epics, or Confluence pages during discovery/);
});

test("Codex review agents are read-only and use risk-based model routing", () => {
  const lite = fs.readFileSync(
    "adapters/codex/agents/pacebuild-review-lite.toml",
    "utf8"
  );
  const deep = fs.readFileSync(
    "adapters/codex/agents/pacebuild-review-deep.toml",
    "utf8"
  );

  assert.match(lite, /model = "gpt-5.4-mini"/);
  assert.match(lite, /sandbox_mode = "read-only"/);
  assert.match(deep, /model = "gpt-5.5"/);
  assert.match(deep, /model_reasoning_effort = "high"/);
  assert.match(deep, /sandbox_mode = "read-only"/);
});

test("Antigravity receives adapter-specific model routing", () => {
  const routing = fs.readFileSync(
    "adapters/antigravity/model-routing.md",
    "utf8"
  );

  assert.match(routing, /lowest-cost\ncapable option/);
  assert.match(routing, /fresh read-only agent/);
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
