import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateUpstreamSources } from "../lib/upstream-sources.js";

const validLock = JSON.parse(fs.readFileSync("sources.lock.json", "utf8"));
const validManifest = JSON.parse(fs.readFileSync("scaffold-manifest.json", "utf8"));

test("valid sources.lock.json and manifest pass validation", () => {
  const errors = validateUpstreamSources(validLock, validManifest, ".");
  assert.deepEqual(errors, []);
});

test("locks exact four capability provenance mappings in sources.lock.json", () => {
  const capMap = Object.fromEntries(
    validLock.capabilities.map((c) => [c.id, c.source_ids])
  );
  assert.deepEqual(capMap["minimal-change"], ["ponytail"]);
  assert.deepEqual(capMap["multi-agent-reliability"], ["agency-agents", "prime-agent"]);
  assert.deepEqual(capMap["bounded-autonomy"], ["agent-skills", "prime-agent"]);
  assert.deepEqual(capMap["upstream-capability-selection"], ["agency-agents", "agent-skills"]);
});

test("locks literal $skill-name in agents/openai.yaml default_prompt files", () => {
  const skills = [
    "minimal-change",
    "multi-agent-reliability",
    "bounded-autonomy",
    "upstream-capability-selection"
  ];

  for (const skill of skills) {
    const yamlPath = `core/agents/orchestrator/skills/${skill}/agents/openai.yaml`;
    assert.ok(fs.existsSync(yamlPath), `Missing openai.yaml for ${skill}`);
    const content = fs.readFileSync(yamlPath, "utf8");
    assert.ok(
      content.includes(`$${skill}`),
      `Expected literal \$${skill} in ${yamlPath}`
    );
  }
});

test("rejects invalid lockfile version", () => {
  const invalidLock = { ...validLock, version: 2 };
  const errors = validateUpstreamSources(invalidLock, validManifest, ".");
  assert.ok(errors.some((e) => e.includes("Invalid version")));
});

test("rejects invalid precedence order", () => {
  const invalidLock = {
    ...validLock,
    precedence: ["local_override", "canonical_policy", "upstream_capability", "persona_voice"]
  };
  const errors = validateUpstreamSources(invalidLock, validManifest, ".");
  assert.ok(errors.some((e) => e.includes("Invalid precedence")));
});

test("rejects uppercase or non-40-hex commit SHAs", () => {
  const invalidLock = {
    ...validLock,
    sources: [
      {
        ...validLock.sources[0],
        commit: "EBE9C99ACB5C96F9468DE368D8BEAD775387D1A7"
      },
      ...validLock.sources.slice(1)
    ]
  };
  const errors = validateUpstreamSources(invalidLock, validManifest, ".");
  assert.ok(errors.some((e) => e.includes("invalid commit SHA")));
});

test("rejects non-MIT license", () => {
  const invalidLock = {
    ...validLock,
    sources: [
      {
        ...validLock.sources[0],
        license: "Apache-2.0"
      },
      ...validLock.sources.slice(1)
    ]
  };
  const errors = validateUpstreamSources(invalidLock, validManifest, ".");
  assert.ok(errors.some((e) => e.includes("license must be 'MIT'")));
});

test("rejects duplicate source IDs and repo URLs in sources list", () => {
  const invalidLock = {
    ...validLock,
    sources: [...validLock.sources, validLock.sources[0]]
  };
  const errors = validateUpstreamSources(invalidLock, validManifest, ".");
  assert.ok(errors.some((e) => e.includes("Duplicate source ID")));
  assert.ok(errors.some((e) => e.includes("Duplicate repo URL")));
});

test("rejects duplicate source IDs within a single capability", () => {
  const invalidLock = {
    ...validLock,
    capabilities: [
      {
        ...validLock.capabilities[0],
        source_ids: ["ponytail", "ponytail"]
      },
      ...validLock.capabilities.slice(1)
    ]
  };
  const errors = validateUpstreamSources(invalidLock, validManifest, ".");
  assert.ok(errors.some((e) => e.includes("contains duplicate source ID")));
});

test("rejects capability with vendored_code: true", () => {
  const invalidLock = {
    ...validLock,
    capabilities: [
      {
        ...validLock.capabilities[0],
        vendored_code: true
      },
      ...validLock.capabilities.slice(1)
    ]
  };
  const errors = validateUpstreamSources(invalidLock, validManifest, ".");
  assert.ok(errors.some((e) => e.includes("vendored_code must be boolean false")));
});

test("rejects capability referencing undeclared source_id", () => {
  const invalidLock = {
    ...validLock,
    capabilities: [
      {
        ...validLock.capabilities[0],
        source_ids: ["non-existent-source"]
      },
      ...validLock.capabilities.slice(1)
    ]
  };
  const errors = validateUpstreamSources(invalidLock, validManifest, ".");
  assert.ok(errors.some((e) => e.includes("references undeclared source ID")));
});

test("rejects capability skill_path path escape and absolute paths", () => {
  const invalidLockPath = {
    ...validLock,
    capabilities: [
      {
        ...validLock.capabilities[0],
        skill_path: "core/agents/orchestrator/skills/routing/SKILL.md"
      },
      ...validLock.capabilities.slice(1)
    ]
  };
  const errorsNotManifest = validateUpstreamSources(invalidLockPath, validManifest, ".");
  assert.ok(errorsNotManifest.some((e) => e.includes("not listed in manifest upstream skills")));

  const invalidLockEscape = {
    ...validLock,
    capabilities: [
      {
        ...validLock.capabilities[0],
        skill_path: "../outside/SKILL.md"
      },
      ...validLock.capabilities.slice(1)
    ]
  };
  const errorsEscape = validateUpstreamSources(invalidLockEscape, validManifest, ".");
  assert.ok(errorsEscape.some((e) => e.includes("path escape detected")));

  const absPath = path.resolve("core/agents/orchestrator/skills/minimal-change/SKILL.md");
  const invalidLockAbs = {
    ...validLock,
    capabilities: [
      {
        ...validLock.capabilities[0],
        skill_path: absPath
      },
      ...validLock.capabilities.slice(1)
    ]
  };
  const errorsAbs = validateUpstreamSources(invalidLockAbs, validManifest, ".");
  assert.ok(errorsAbs.some((e) => e.includes("path escape detected")));
});

test("allows contained path segments beginning with two dots", () => {
  const containedPath = "..contained/SKILL.md";
  const containedLock = {
    ...validLock,
    capabilities: [
      {
        ...validLock.capabilities[0],
        skill_path: containedPath
      },
      ...validLock.capabilities.slice(1)
    ]
  };

  const errors = validateUpstreamSources(containedLock, validManifest, ".");
  assert.ok(errors.some((e) => e.includes(`file does not exist: ${containedPath}`)));
  assert.equal(
    errors.some((e) => e.includes(containedPath) && e.includes("path escape detected")),
    false
  );
});
