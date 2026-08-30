import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExecutorCommand,
  parseExecutionOutput,
  selectExecutionProfile
} from "../lib/executor.js";

function settings(directory) {
  return {
    source: path.join(directory, "agent-scaffold.json"),
    data: {
      executor: {
        defaultProvider: "codex",
        providers: {
          codex: {
            command: ["codex", "exec", "-C", "{worktree}", "{prompt}"]
          },
          antigravity: {
            command: [
              "agy",
              "--agent",
              "{agent}",
              "--model",
              "{model}",
              "--effort",
              "{effort}",
              "--mode",
              "{mode}",
              "--json-schema",
              "{resultSchema}",
              "-p",
              "{prompt}"
            ],
            defaultModel: "claude-sonnet-4-6",
            modelProfiles: {
              medium: "claude-sonnet-4-6",
              high: "claude-opus-4-6-thinking",
              mechanical: "gpt-oss-120b-medium"
            },
            resultSchema: "schema.json"
          }
        }
      }
    }
  };
}

test("Antigravity profile is selected explicitly without silent fallback", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-executor-"));
  const profile = selectExecutionProfile(
    settings(directory),
    { labels: ["provider-antigravity", "model-profile-mechanical"] },
    { persona: "frontend-engineer", risk: "normal" }
  );
  assert.equal(profile.provider, "antigravity");
  assert.equal(profile.agent, "frontend-engineer");
  assert.equal(profile.model, "gpt-oss-120b-medium");
});

test("high-risk work stays on Codex when Antigravity is the default", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-executor-"));
  const configured = settings(directory);
  configured.data.executor.defaultProvider = "antigravity";
  const normal = selectExecutionProfile(
    configured,
    { labels: [] },
    { persona: "frontend-engineer", risk: "normal" }
  );
  const highRisk = selectExecutionProfile(
    configured,
    { labels: [] },
    { persona: "backend-engineer", risk: "high" }
  );
  assert.equal(normal.provider, "antigravity");
  assert.equal(highRisk.provider, "codex");
});

test("executor command redacts the prompt from telemetry", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-executor-"));
  const profile = selectExecutionProfile(
    settings(directory),
    { labels: ["provider-antigravity"] },
    { persona: "backend-engineer", risk: "normal" }
  );
  const built = buildExecutorCommand({
    settings: settings(directory),
    profile,
    prepared: { worktree: path.join(directory, "worktree") },
    prompt: "secret task packet",
    runId: "run-1"
  });
  assert.ok(built.command.includes("secret task packet"));
  assert.ok(built.redactedCommand.includes("<redacted>"));
  assert.ok(!built.redactedCommand.includes("secret task packet"));
});

test("Codex local executor command targets Ollama with the selected model", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-executor-local-"));
  const configured = settings(directory);
  configured.data.executor.defaultProvider = "ollama";
  configured.data.executor.providers.ollama = {
    enabled: true,
    localProvider: "ollama",
    endpoint: "http://10.0.0.25:11434",
    remoteEndpointApproved: true,
    command: [
      "codex", "exec",
      "-c", "model_provider=\"agent_scaffold_ollama\"",
      "-c", "model_providers.agent_scaffold_ollama.base_url=\"{endpoint}/v1\"",
      "-m", "{model}", "-C", "{worktree}", "{prompt}"
    ],
    defaultModel: "qwen3:8b",
    modelProfiles: { medium: "qwen3:8b" }
  };
  const profile = selectExecutionProfile(configured, { labels: [] }, { persona: "backend-engineer", risk: "normal" });
  const built = buildExecutorCommand({
    settings: configured,
    profile,
    prepared: { worktree: path.join(directory, "worktree") },
    prompt: "local secret task",
    runId: "run-local"
  });
  assert.ok(built.command.includes("model_provider=\"agent_scaffold_ollama\""));
  assert.ok(built.command.includes("model_providers.agent_scaffold_ollama.base_url=\"http://10.0.0.25:11434/v1\""));
  assert.ok(built.command.includes("qwen3:8b"));
  assert.equal(built.redactedCommand.includes("local secret task"), false);
});

test("Antigravity JSON output exposes usage and permission failures", () => {
  const success = parseExecutionOutput(
    "antigravity",
    JSON.stringify({
      status: "SUCCESS",
      conversation_id: "conversation-1",
      response: JSON.stringify({
        status: "completed",
        summary: "implemented",
        changed_files: [],
        validation_commands: [],
        blockers: [],
        risks: []
      }),
      duration_seconds: 12,
      num_turns: 1,
      usage: { total_tokens: 321 }
    }),
    "",
    0
  );
  assert.equal(success.ok, true);
  assert.equal(success.conversationId, "conversation-1");
  assert.equal(success.usage.total_tokens, 321);

  const fenced = parseExecutionOutput(
    "antigravity",
    JSON.stringify({
      status: "SUCCESS",
      response:
        '```json\n{"status":"completed","summary":"ok","changed_files":[],"validation_commands":[],"blockers":[],"risks":[]}\n```\n' +
        '```json\n{"status":"completed","summary":"ok","changed_files":[],"validation_commands":[],"blockers":[],"risks":[]}\n```'
    }),
    "",
    0
  );
  assert.equal(fenced.ok, true);
  assert.equal(fenced.schemaValid, true);
  assert.equal(fenced.result.summary, "ok");

  const invalidSchema = parseExecutionOutput(
    "antigravity",
    JSON.stringify({
      status: "SUCCESS",
      response: JSON.stringify({
        status: "completed",
        changed_files: [],
        validation_commands: [],
        blockers: [],
        risks: []
      })
    }),
    "",
    0
  );
  assert.equal(invalidSchema.ok, false);
  assert.equal(invalidSchema.schemaValid, false);

  const denied = parseExecutionOutput(
    "antigravity",
    JSON.stringify({ status: "SUCCESS", response: "" }),
    "tool permission was auto-denied; no output produced",
    0
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.permissionDenied, true);
});
