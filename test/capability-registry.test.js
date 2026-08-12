import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildCapabilityRegistry } from "../lib/capability-registry.js";
import { codeIntelligenceMcpEntry } from "../lib/code-intelligence.js";
import { createOrchestratorProvider } from "../lib/orchestrator.js";
import { describeExecutorProviders } from "../lib/executor.js";

function settings() {
  return {
    source: path.resolve("agent-scaffold.example.json"),
    data: {
      orchestrator: {
        defaultProvider: "builtin",
        providers: { builtin: { type: "builtin" } }
      },
      executor: {
        defaultProvider: "codex",
        providers: { codex: { command: ["codex"], defaultModel: "gpt-5.6" } }
      },
      codeIntelligence: {
        defaultProvider: "codebase-memory",
        providers: {
          "codebase-memory": {
            type: "codebase-memory-mcp",
            enabled: true,
            command: ["codebase-memory-mcp"],
            capabilities: ["architecture", "impact-analysis"],
            readOnly: true
          }
        }
      }
    }
  };
}

test("capability registry exposes Ponytail minimal-change provenance", () => {
  const registry = buildCapabilityRegistry(settings());
  const minimalChange = registry.find((capability) => capability.id === "minimal-change");
  assert.equal(minimalChange.kind, "skill");
  assert.deepEqual(minimalChange.provenance.map((source) => source.id), ["ponytail"]);
  assert.ok(registry.some((capability) => capability.id === "codebase-memory"));
});

test("codebase-memory integration returns a standard MCP stdio entry", () => {
  assert.deepEqual(codeIntelligenceMcpEntry(settings()), {
    name: "codebase-memory",
    transport: "stdio",
    command: "codebase-memory-mcp",
    args: []
  });
});

test("orchestrator planning and executor inventory are separate registries", () => {
  const configured = settings();
  const route = createOrchestratorProvider(configured).plan({
    key: "PACE-1",
    summary: "API endpoint",
    description: "Acceptance Criteria"
  });
  assert.equal(route.persona, "backend-engineer");
  assert.equal("command" in route, false);
  assert.deepEqual(describeExecutorProviders(configured).map((provider) => provider.id), ["codex"]);
});
