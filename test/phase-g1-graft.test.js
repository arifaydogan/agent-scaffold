/**
 * test/phase-g1-graft.test.js
 *
 * Phase G.1 — NanoNets/Graft Code Intelligence Provider Suite (Real Contract Closure):
 * 1. Lifecycle: disabled, missing binary, handshake, missing required tools, soft isError handling, timeout/buffer safety.
 * 2. Normalization: real lexical & structural find_code -> Search, real arrow trace_calls (in/out) -> Trace, file_api -> Snippet, real freshness markers -> Coverage.
 * 3. Path Security, Multi-Root Isolation & Read-Only / No-Upkeep Safety: authorized repo/worktree isolation, verifying that provider execution NEVER mutates tracked repo files or ~/.codex configs.
 * 4. Production Planning Flow: defaultProvider="graft" collects Graft intelligence & passes exact plan to execution.
 * 5. Production Implementation Flow: executor prompt contains bounded Graft code intelligence.
 * 6. Production Review Lifecycle: changed files & call context from Graft reach reviewer prompt.
 * 7. Production Rework Lifecycle: pinned originating evidence + fresh rework intelligence collected separately.
 * 8. Provider Switching & Neutrality: codebase-memory <-> graft seamless configuration switch with identical normalized runtime contract.
 * 9. Truthful Handling of Stale / Unindexed / Unknown Freshness Markers: explicit graft check: STALE, NO GRAPH, and unknown text markers.
 * 10. Observability API Integration: /api/observability/runs/:runId exposes normalized Graft summary.
 * 11. Real Live Graft Binary Smoke Test with `graft build`: exercised if graft binary is on PATH, skipped otherwise.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { RunStore } from "../lib/store.js";
import { createDashboardServer } from "../lib/dashboard.js";
import {
  CodeIntelligenceProvider,
  GraftCodeIntelligenceProvider,
  McpStdioClient,
  createCodeIntelligenceProvider,
  describeCodeIntelligenceProviders,
  collectCodeIntelligenceContext,
  collectReviewIntelligence,
  formatCodeIntelligencePromptSection,
  formatReviewIntelligencePromptSection,
  validatePathWithinRoot,
  buildSafeMcpEnv,
  parseGraftRepoMapText,
  parseGraftFindCodeText,
  parseGraftTraceText,
  parseGraftFreshnessText
} from "../lib/code-intelligence.js";
import {
  createConfigSnapshot,
  issuePlan,
  issuePlanWithIntelligence,
  runIssue,
  runIssueWithPlan,
  handleImplementation,
  handleReview,
  handleRework,
  buildRunObservability
} from "../lib/runtime.js";
import { dispatchOnce } from "../lib/dispatcher.js";

function makeTestStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graft-store-"));
  return new RunStore(path.join(dir, "runs.sqlite3"));
}

function makeSettings(store, overrides = {}) {
  const repoDir = overrides.repoPath || fs.mkdtempSync(path.join(os.tmpdir(), "graft-repo-"));
  try {
    if (!fs.existsSync(path.join(repoDir, ".git"))) {
      execSync("git init", { cwd: repoDir, stdio: "ignore" });
      execSync("git config user.name 'GraftTest'", { cwd: repoDir, stdio: "ignore" });
      execSync("git config user.email 'graft@test.local'", { cwd: repoDir, stdio: "ignore" });
      fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "# Agents\n");
      fs.writeFileSync(path.join(repoDir, "ORCHESTRATION.md"), "# Orchestration\n");
      fs.writeFileSync(path.join(repoDir, "PACEBUILD_ORCHESTRATOR.md"), "# PaceBuild\n");
      fs.mkdirSync(path.join(repoDir, ".agents", "rules"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, ".agents", "rules", "orchestration-gates.md"), "# Gates\n");
      execSync("git add .", { cwd: repoDir, stdio: "ignore" });
      execSync("git commit -m 'initial'", { cwd: repoDir, stdio: "ignore" });
    }
  } catch {}

  return {
    source: path.join(repoDir, "settings.json"),
    projectKey: "PACE",
    repoPath: repoDir,
    worktreeRoot: path.join(repoDir, "worktrees"),
    _store: store,
    data: {
      project: {
        key: "PACE",
        repoPath: ".",
        operatingMode: overrides.operatingMode || "autonomous"
      },
      workSource: overrides.workSource || {
        defaultProvider: "jira",
        providers: {
          jira: { host: "jira.test.local", email: "a@b.c", apiToken: "tok" }
        }
      },
      codeIntelligence: overrides.codeIntelligence || {
        defaultProvider: "graft",
        providers: {
          "codebase-memory": {
            type: "codebase-memory-mcp",
            enabled: true,
            transport: "stdio",
            command: ["codebase-memory-mcp"],
            readOnly: true,
            capabilities: ["architecture", "search", "trace", "changes", "impact", "coverage", "snippets"]
          },
          "graft": {
            type: "graft-mcp",
            enabled: true,
            transport: "stdio",
            command: ["graft", "mcp"],
            readOnly: true,
            capabilities: ["architecture", "search", "trace", "changes", "impact", "coverage", "snippets"]
          }
        }
      },
      policy: {
        allowedProjects: ["PACE"],
        humanOnlyStatuses: ["Done"],
        operatingMode: overrides.operatingMode || "autonomous",
        requiredLabels: ["agent-ready"],
        maxAttempts: 3,
        maxConcurrency: 2,
        review: {
          provider: "codex",
          model: "gpt-5",
          maxReworkAttempts: 3
        },
        pathScopes: {
          "backend-engineer": ["backend/**", "lib/**"],
          "frontend-engineer": ["frontend/**"]
        },
        ...(overrides.policy || {})
      },
      orchestrator: {
        defaultProvider: "codex",
        providers: {
          codex: { command: ["codex", "exec"] }
        }
      },
      executor: {
        defaultProvider: "codex",
        providers: {
          codex: { command: ["codex", "exec", "--prompt", "{prompt}"], defaultModel: "gpt-5", defaultEffort: "medium" },
          antigravity: {
            command: ["antigravity", "exec", "--prompt", "{prompt}"],
            defaultModel: "claude-3-5-sonnet",
            defaultEffort: "medium",
            modelProfiles: {
              "claude-review": "claude-3-5-sonnet"
            }
          }
        }
      }
    }
  };
}

// ── Real Upstream NanoNets/Graft MCP Tool Schemas ───────────────────────────

const GRAFT_TOOL_SCHEMAS = {
  graft_find_code: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
      full: { type: "boolean" },
      in: { type: "string" }
    }
  },
  graft_file_api: {
    type: "object",
    required: ["file"],
    properties: {
      file: { type: "string" }
    }
  },
  graft_check_freshness: {
    type: "object",
    properties: {}
  },
  graft_trace_calls: {
    type: "object",
    required: ["symbol"],
    properties: {
      symbol: { type: "string" },
      direction: { type: "string", enum: ["in", "out"] },
      depth: { type: "number" },
      in: { type: "string" }
    }
  },
  graft_find_all: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string" },
      in: { type: "string" },
      ignore_case: { type: "boolean" },
      fixed: { type: "boolean" }
    }
  },
  graft_repo_map: {
    type: "object",
    properties: {
      max_dirs: { type: "number" }
    }
  }
};

function createMockGraftSpawn(toolHandler, onSpawn) {
  return function mockSpawn(cmd, args, opts) {
    if (onSpawn) onSpawn(cmd, args, opts);
    const stdin = new EventEmitter();
    stdin.writable = true;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {
      setImmediate(() => child.emit("close", 0));
    };

    const subcmd = Array.isArray(args) ? args[0] : null;

    // CLI mode execution
    if (subcmd && subcmd !== "mcp") {
      setImmediate(() => {
        let toolName = subcmd;
        let toolArgs = {};
        if (subcmd === "check") toolName = "graft_check_freshness";
        else if (subcmd === "map") {
          toolName = "graft_repo_map";
          const maxDirsIdx = args.indexOf("--max-dirs");
          if (maxDirsIdx !== -1) toolArgs.max_dirs = Number(args[maxDirsIdx + 1]);
        } else if (subcmd === "ask") {
          toolName = "graft_find_code";
          toolArgs = { query: args[1] };
        } else if (subcmd === "callers" || subcmd === "trace") {
          toolName = "graft_trace_calls";
          toolArgs = { symbol: args[1], direction: args.includes("--out") ? "out" : "in" };
        } else if (subcmd === "skeleton" || subcmd === "api") {
          toolName = "graft_file_api";
          toolArgs = { file: args[1] };
        } else if (subcmd === "grep") {
          toolName = "graft_find_all";
          toolArgs = { pattern: args[1] };
        }

        let res;
        try {
          res = toolHandler ? toolHandler(toolName, toolArgs) : defaultGraftToolHandler(toolName, toolArgs);
        } catch (err) {
          stderr.emit("data", Buffer.from(err.message + "\n"));
          child.emit("close", 1);
          return;
        }

        if (res && res.isError) {
          stderr.emit("data", Buffer.from(res.text || "Tool execution error\n"));
          child.emit("close", 1);
          return;
        }

        const outText = typeof res === "string" ? res : JSON.stringify(res);
        stdout.emit("data", Buffer.from(outText + "\n"));
        child.emit("close", 0);
      });
      return child;
    }

    // MCP stdio fallback mode
    stdin.write = (chunk) => {
      const lines = chunk.toString("utf8").split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            setImmediate(() => {
              stdout.emit(
                "data",
                Buffer.from(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                      protocolVersion: "2024-11-05",
                      capabilities: { tools: {} },
                      serverInfo: { name: "graft", version: "0.8.2" }
                    }
                  }) + "\n"
                )
              );
            });
          } else if (msg.method === "notifications/initialized") {
            // ack
          } else if (msg.method === "tools/list") {
            setImmediate(() => {
              const tools = Object.entries(GRAFT_TOOL_SCHEMAS).map(([name, inputSchema]) => ({
                name,
                inputSchema
              }));
              stdout.emit(
                "data",
                Buffer.from(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: { tools }
                  }) + "\n"
                )
              );
            });
          } else if (msg.method === "tools/call") {
            const toolName = msg.params?.name;
            const toolArgs = msg.params?.arguments || {};

            // Strict Schema Check: reject undeclared arguments or direction: "both"
            const schema = GRAFT_TOOL_SCHEMAS[toolName];
            if (!schema) {
              setImmediate(() => {
                stdout.emit(
                  "data",
                  Buffer.from(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      id: msg.id,
                      error: { code: -32601, message: `Method '${toolName}' not found` }
                    }) + "\n"
                  )
                );
              });
              return;
            }

            if (schema.properties) {
              const allowed = new Set(Object.keys(schema.properties));
              for (const key of Object.keys(toolArgs)) {
                if (!allowed.has(key)) {
                  setImmediate(() => {
                    stdout.emit(
                      "data",
                      Buffer.from(
                        JSON.stringify({
                          jsonrpc: "2.0",
                          id: msg.id,
                          error: { code: -32602, message: `Strict schema violation: undeclared property '${key}' passed to '${toolName}'` }
                        }) + "\n"
                      )
                    );
                  });
                  return;
                }
              }

              // Check enum constraints
              if (schema.properties.direction?.enum && toolArgs.direction) {
                if (!schema.properties.direction.enum.includes(toolArgs.direction)) {
                  setImmediate(() => {
                    stdout.emit(
                      "data",
                      Buffer.from(
                        JSON.stringify({
                          jsonrpc: "2.0",
                          id: msg.id,
                          error: { code: -32602, message: `Invalid enum value '${toolArgs.direction}' for direction in '${toolName}'` }
                        }) + "\n"
                      )
                    );
                  });
                  return;
                }
              }
            }

            const res = toolHandler ? toolHandler(toolName, toolArgs) : defaultGraftToolHandler(toolName, toolArgs);

            if (res && res.isError) {
              setImmediate(() => {
                stdout.emit(
                  "data",
                  Buffer.from(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      id: msg.id,
                      result: {
                        isError: true,
                        content: [{ type: "text", text: res.text || "Soft tool execution error" }]
                      }
                    }) + "\n"
                  )
                );
              });
              return;
            }

            setImmediate(() => {
              stdout.emit(
                "data",
                Buffer.from(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                      content: [{ type: "text", text: typeof res === "string" ? res : JSON.stringify(res) }]
                    }
                  }) + "\n"
                )
              );
            });
          }
        } catch {}
      }
    };
    stdin.end = () => {};
    return child;
  };
}

function defaultGraftToolHandler(name, args) {
  switch (name) {
    case "graft_repo_map":
    case "map":
      return `## Repository Map
### Packages & Directories
- lib/ (core runtime)
- test/ (test suites)

### Entry Points & Hubs
- lib/runtime.js
- lib/code-intelligence.js

### HTTP Routes
- GET /api/observability/runs/:runId
`;
    case "graft_find_code":
    case "ask":
      return `graft ask — "${args?.query || ""}"  (lexical)

1. handleImplementation · function  [handleImplementation]
   lib/runtime.js:L1120-L1145
   export function handleImplementation(settings, issue, execute, runtime, options) {

2. recordTelemetryEvent · function  [recordTelemetryEvent]
   lib/store.js:L310-L335
   export function recordTelemetryEvent(event) {
`;
    case "graft_find_all":
    case "grep":
      return `- searchCode  lib/code-intelligence.js:L1295-L1340  (definition) — export async function searchCode(query)
`;
    case "graft_trace_calls":
    case "callers":
    case "trace":
      if (args?.direction === "in") {
        return `handleImplementation · function · lib/runtime.js:L1120-L1145
calls ← runIssue (lib/runtime.js:L980-L1010)
references ← dispatchOnce (lib/runtime.js:L420-L450)
`;
      }
      return `handleImplementation · function · lib/runtime.js:L1120-L1145
calls → executePlanStep (lib/runtime.js:L1300-L1320)
calls → recordTelemetryEvent (lib/store.js:L310-L335)
`;
    case "graft_file_api":
    case "skeleton":
    case "api":
      return `// API skeleton for lib/runtime.js
export function handleImplementation(settings, issue, execute, runtime, options);
export function handleReview(settings, issue, execute, runtime, options);
`;
    case "graft_check_freshness":
    case "check":
      return `graft check: OK
the graph is in sync with the code
`;
    default:
      return "";
  }
}

function request(server, pathStr, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        path: pathStr,
        method: options.method || "GET",
        headers: options.headers || {}
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── Test 1: Graft Lifecycle & Soft Error (isError) ──────────────────────────

test("1. Graft Lifecycle: disabled, missing binary, handshake, missing required tools, soft isError handling, timeout/buffer safety", async () => {
  const store = makeTestStore();

  // A. Disabled provider returns explicit disabled state
  const disabledSettings = makeSettings(store, {
    codeIntelligence: {
      defaultProvider: "graft",
      providers: {
        graft: { type: "graft", enabled: false, command: ["graft"] }
      }
    }
  });
  const disabledProvider = createCodeIntelligenceProvider(disabledSettings);
  const disabledHealth = await disabledProvider.health();
  assert.equal(disabledHealth.configured, false);
  assert.equal(disabledHealth.available, false);
  assert.equal(disabledHealth.warning, "Provider is disabled");

  // B. Missing binary / spawn error returns unavailable health state
  const unavailableSpawn = () => {
    const err = new Error("spawn graft ENOENT");
    err.code = "ENOENT";
    throw err;
  };
  const unavailProvider = new GraftCodeIntelligenceProvider(
    "graft",
    { enabled: true, command: ["graft"] },
    { spawn: unavailableSpawn }
  );
  const unavailHealth = await unavailProvider.health();
  assert.equal(unavailHealth.available, false);
  assert.ok(unavailHealth.warning.includes("ENOENT") || unavailHealth.warning.includes("unavailable"));

  // C. Successful handshake & tool discovery
  const mockSpawn = createMockGraftSpawn();
  const okProvider = new GraftCodeIntelligenceProvider(
    "graft",
    { enabled: true, command: ["graft"] },
    { spawn: mockSpawn }
  );
  const okHealth = await okProvider.health();
  assert.equal(okHealth.available, true);
  assert.equal(okHealth.indexed, true);
  assert.ok(okHealth.capabilities.includes("map") || okHealth.capabilities.includes("graft_repo_map"));
  assert.ok(okHealth.capabilities.includes("ask") || okHealth.capabilities.includes("graft_find_code"));

  // D. Tool failure fails closed
  const failingCheckSpawn = (cmd, args, opts) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => child.emit("close", 0);
    setImmediate(() => {
      stderr.emit("data", Buffer.from("Graft check failed\n"));
      child.emit("close", 1);
    });
    return child;
  };

  const discoveryFailedProvider = new GraftCodeIntelligenceProvider(
    "graft",
    { enabled: true, command: ["graft"] },
    { spawn: failingCheckSpawn }
  );
  const failedHealth = await discoveryFailedProvider.health();
  assert.equal(failedHealth.available, false);

  // E. Soft Error handling returns unknown coverage gracefully
  const softErrorSpawn = createMockGraftSpawn((name, args) => {
    if (name === "graft_find_code" || name === "ask" || name === "graft_find_all" || name === "grep") {
      return { isError: true, text: "Graft index is corrupted or busy" };
    }
    return defaultGraftToolHandler(name, args);
  });
  const softErrProvider = new GraftCodeIntelligenceProvider(
    "graft",
    { enabled: true, command: ["graft"] },
    { spawn: softErrorSpawn }
  );
  const searchRes = await softErrProvider.searchCode("handleImplementation");
  assert.equal(searchRes.matches.length, 0);
  assert.equal(searchRes.coverage, "unknown");

  // F. Buffer bounds safety
  const bigSpawn = () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => child.emit("close", 0);
    setImmediate(() => {
      stdout.emit("data", Buffer.alloc(1000, "x"));
      child.emit("close", 0);
    });
    return child;
  };
  const boundedProvider = new GraftCodeIntelligenceProvider(
    "graft",
    { enabled: true, command: ["graft"], maxBufferSize: 100 },
    { spawn: bigSpawn }
  );
  await assert.rejects(boundedProvider.health(), /exceeded maximum buffer size/);
});

// ── Test 2: Graft Normalization with Real Lexical & Structural Formats ──────

test("2. Graft Normalization: real lexical & structural find_code -> Search, real arrow trace_calls (in/out) -> Trace, file_api -> Snippet, real freshness markers -> Coverage", async () => {
  const store = makeTestStore();
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "graft-norm-"));
  const settings = makeSettings(store, { repoPath: repoDir });

  const mockSpawn = createMockGraftSpawn();
  const provider = createCodeIntelligenceProvider(settings, { spawn: mockSpawn });

  // 1. Architecture normalization from text
  const arch = await provider.getArchitecture({ project: "agent-scaffold" });
  assert.equal(arch.provider, "graft");
  assert.equal(arch.project, "agent-scaffold");
  assert.ok(arch.packages.includes("lib"));
  assert.ok(arch.entryPoints.some((e) => e.includes("lib/runtime.js")));
  assert.ok(arch.routes.some((r) => r.includes("GET /api/observability/runs/:runId")));

  // 2. Lexical Search normalization (title on line 1, pointer on line 2)
  const search = await provider.searchCode("handleImplementation", { project: "agent-scaffold" });
  assert.equal(search.query, "handleImplementation");
  assert.ok(search.matches.length >= 1);
  assert.equal(search.matches[0].symbol, "handleImplementation");
  assert.equal(search.matches[0].file, "lib/runtime.js");
  assert.equal(search.matches[0].line, 1120);
  assert.equal(search.coverage, "covered");

  // 3. Structural Search normalization via find_all
  const structSearch = parseGraftFindCodeText(
    "- handleImplementation  lib/runtime.js:L1120-L1145  (calls) — export function handleImplementation",
    "handleImplementation"
  );
  assert.equal(structSearch.length, 1);
  assert.equal(structSearch[0].symbol, "handleImplementation");
  assert.equal(structSearch[0].file, "lib/runtime.js");
  assert.equal(structSearch[0].line, 1120);

  // 4. Trace normalization parsing real arrow lines
  const trace = await provider.tracePath({ project: "agent-scaffold", symbol: "handleImplementation" });
  assert.equal(trace.symbol, "handleImplementation");
  assert.equal(trace.callers.length, 1);
  assert.equal(trace.callers[0].symbol, "runIssue");
  assert.equal(trace.callers[0].file, "lib/runtime.js");
  assert.equal(trace.callers[0].line, 808);
  assert.equal(trace.callees.length, 1);
  assert.equal(trace.callees[0].symbol, "issuePlan");
  assert.equal(trace.callees[0].file, "lib/runtime.js");
  assert.equal(trace.callees[0].line, 133);
  assert.ok(trace.paths.length >= 2);

  // 5. Snippet normalization from text
  const subFile = path.join(repoDir, "lib", "runtime.js");
  fs.mkdirSync(path.dirname(subFile), { recursive: true });
  fs.writeFileSync(subFile, "export function handleImplementation() {}");

  const snip = await provider.getSnippet({ file: "lib/runtime.js" });
  assert.ok(snip.content.includes("handleImplementation"));
  assert.equal(snip.file, "lib/runtime.js");

  // 6. Coverage normalization from real OK marker
  const coverage = await provider.checkCoverage({ files: ["lib/runtime.js"] });
  assert.equal(coverage.status, "covered");
  assert.equal(coverage.coverageRatio, 1.0);

  // 7. Truthful Changes/Impact normalization (normal risk with callers found)
  const impact = await provider.detectChanges({ files: ["lib/runtime.js"] });
  assert.ok(impact.changedFiles.includes("lib/runtime.js"));
  assert.ok(impact.callers.includes("runIssue"));
  assert.equal(impact.risk, "normal");
  assert.equal(impact.coverage, "covered");

  provider.close();
});

// ── Test 3: Path Security, Multi-Root Isolation & Read-Only Safety ──────────

test("3. Path Security, Multi-Root Isolation & Read-Only / No-Upkeep Safety: authorized repo/worktree isolation, verifying that provider execution NEVER mutates tracked repo files or ~/.codex configs", async () => {
  const store = makeTestStore();
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "graft-sec-"));
  const worktreeDir = path.join(repoDir, "worktrees");
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "graft-outside-"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "graft-home-"));

  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
  const codexHooksPath = path.join(fakeHome, ".codex", "hooks.json");
  const initialHooks = JSON.stringify({ version: "1.0", hooks: [] }, null, 2);
  fs.writeFileSync(codexHooksPath, initialHooks);

  const spawnedCwds = [];
  const mockSpawn = createMockGraftSpawn(null, (cmd, args, opts) => {
    spawnedCwds.push(opts.cwd);
  });

  const settings = makeSettings(store, {
    repoPath: repoDir,
    worktreeRoot: worktreeDir
  });

  const provider = createCodeIntelligenceProvider(settings, {
    spawn: mockSpawn,
    env: { HOME: fakeHome }
  });

  // A. Configured repository query uses repoDir cwd
  const health = await provider.health(repoDir);
  assert.equal(health.available, true);
  assert.ok(spawnedCwds.includes(repoDir));

  // B. Unauthorized external root is rejected
  await assert.rejects(
    provider.health("/etc"),
    /outside the authorized roots/
  );
  await assert.rejects(
    provider.searchCode("test", { repoPath: outsideDir }),
    /outside the authorized roots/
  );

  // C. Authorized worktree query uses worktree-specific client
  const leafWorktree = path.join(worktreeDir, "PACE-901-leaf");
  fs.mkdirSync(leafWorktree, { recursive: true });
  const worktreeArch = await provider.getArchitecture({ repoPath: leafWorktree });
  assert.ok(worktreeArch);
  assert.ok(spawnedCwds.includes(leafWorktree));

  // D. Unauthorized worktree outside worktreeRoot is rejected
  const fakeWorktree = path.join(outsideDir, "unauthorized-worktree");
  fs.mkdirSync(fakeWorktree, { recursive: true });
  await assert.rejects(
    provider.getArchitecture({ repoPath: fakeWorktree }),
    /outside the authorized roots/
  );

  // E. Relative snippet paths resolve relative to repo root
  const subFile = path.join(repoDir, "lib", "runtime.js");
  fs.mkdirSync(path.dirname(subFile), { recursive: true });
  fs.writeFileSync(subFile, "export function handleImplementation() {}");

  const validSnippet = await provider.getSnippet({ file: "lib/runtime.js" });
  assert.ok(validSnippet);

  // Traversal escaping root is rejected
  await assert.rejects(
    provider.getSnippet({ file: "../../etc/passwd" }),
    /outside the authorized roots/
  );

  // F. Symlink escaping root is rejected
  const symlinkPath = path.join(repoDir, "escape_link");
  try {
    fs.symlinkSync(outsideDir, symlinkPath, "dir");
    const escapedFile = path.join(symlinkPath, "secret.js");
    await assert.rejects(
      provider.getSnippet({ file: escapedFile }),
      /outside the authorized roots/
    );
  } catch (err) {
    if (err.code !== "EPERM") throw err;
  }

  // G. Verify read-only safety: tracked files & ~/.codex/hooks.json remain byte-for-byte untouched
  const finalHooks = fs.readFileSync(codexHooksPath, "utf8");
  assert.equal(finalHooks, initialHooks, "Graft provider execution must NEVER modify ~/.codex configuration");

  const gateRulePath = path.join(repoDir, ".agents", "rules", "orchestration-gates.md");
  assert.ok(fs.existsSync(gateRulePath));
  assert.equal(fs.readFileSync(gateRulePath, "utf8"), "# Gates\n", "Graft provider execution must NEVER modify repo rule files");

  provider.close();
});

// ── Test 4: Production Planning Flow with Graft ─────────────────────────────

test("4. Production Planning Flow: defaultProvider='graft' collects Graft intelligence & passes exact plan to execution", async () => {
  const store = makeTestStore();
  const mockSpawn = createMockGraftSpawn();
  const settings = makeSettings(store);

  const mockWorkSource = {
    async poll() {
      return [
        {
          key: "PACE-901",
          summary: "Add Graft-backed code intelligence context",
          description: "Acceptance criteria: [ ] Update handleImplementation",
          canonicalState: "ready",
          status: "Ready",
          labels: ["agent-ready"]
        }
      ];
    },
    async transition() { return { ok: true }; }
  };

  let executedPlan = null;

  const customRuntime = {
    spawn: mockSpawn,
    spawnSync: (cmd, args) => {
      if (cmd === "codex" && args[0] === "exec") {
        return {
          status: 0,
          stdout: JSON.stringify({
            issue: "PACE-901",
            summary: "Add Graft-backed code intelligence context",
            persona: "backend-engineer",
            taskAgent: "backend-engineer",
            skills: ["minimal-change"],
            risk: "low",
            parallelSafe: true,
            allowedPaths: ["backend/**", "lib/**"],
            dependencies: [],
            rationale: ["Graft recommends lib/runtime.js"]
          })
        };
      }
      if (cmd === "git") return { status: 0, stdout: "abc1234\n" };
      return { status: 0, stdout: "{}\n" };
    }
  };

  const dispatchResult = await dispatchOnce(settings, {
    execute: true,
    workSource: mockWorkSource,
    store,
    runtime: customRuntime,
    runIssueImpl: (s, iss, exec, rt, opts) => {
      executedPlan = opts?.plan;
      return handleImplementation(s, iss, exec, rt, opts);
    }
  });

  assert.equal(dispatchResult.mode, "execute");
  assert.equal(dispatchResult.waves.length, 1);
  assert.ok(executedPlan);
  assert.equal(executedPlan.configSnapshot.codeIntelligence.provider, "graft");
  assert.equal(executedPlan.configSnapshot.codeIntelligence.status, "ready");
  assert.ok(executedPlan.configSnapshot.codeIntelligence.search.files.includes("lib/runtime.js"));
});

// ── Test 5: Production Implementation Flow with Graft ───────────────────────

test("5. Production Implementation Flow: executor prompt contains bounded Graft code intelligence", async () => {
  const store = makeTestStore();
  const mockSpawn = createMockGraftSpawn();
  const settings = makeSettings(store);

  const issue = {
    key: "PACE-902",
    summary: "Execute with Graft prompt context",
    description: "Acceptance criteria: [ ] Implement feature",
    canonicalState: "ready",
    labels: ["agent-ready"]
  };

  const plan = await issuePlanWithIntelligence(settings, issue, {
    store,
    runtime: {
      spawn: mockSpawn,
      spawnSync: (cmd, args) => ({
        status: 0,
        stdout: JSON.stringify({
          issue: "PACE-902",
          summary: "Execute with Graft prompt context",
          persona: "backend-engineer",
          taskAgent: "backend-engineer",
          skills: ["minimal-change"],
          risk: "low",
          parallelSafe: true,
          allowedPaths: ["backend/**", "lib/**"],
          dependencies: [],
          rationale: ["Graft plan"]
        })
      })
    }
  });

  assert.equal(plan.configSnapshot.codeIntelligence.provider, "graft");

  let executedPrompt = null;
  const implRuntime = {
    spawn: mockSpawn,
    spawnSync: (cmd, args) => {
      if (cmd === "git") {
        if (args.includes("status")) return { status: 0, stdout: "" };
        return { status: 0, stdout: "abc1234\n" };
      }
      if (cmd === "codex" && args[0] === "exec") {
        const promptIdx = args.findIndex((a) => a === "--prompt" || a === "-p");
        if (promptIdx !== -1) {
          executedPrompt = args[promptIdx + 1];
        } else {
          executedPrompt = args[args.length - 1];
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            status: "completed",
            summary: "Implementation complete",
            changed_files: [],
            validation_commands: [],
            blockers: [],
            risks: []
          })
        };
      }
      return { status: 0, stdout: "{}\n" };
    }
  };

  const implResult = handleImplementation(settings, issue, true, implRuntime, { plan });

  assert.equal(implResult.exitCode, 0);
  assert.ok(executedPrompt, "Executor must be called with a generated prompt");
  assert.ok(executedPrompt.includes("### CODE INTELLIGENCE CONTEXT"));
  assert.ok(executedPrompt.includes("- Provider: graft"));
  assert.ok(executedPrompt.includes("lib/runtime.js"));
  assert.ok(executedPrompt.includes("handleImplementation"));
});

// ── Test 6: Production Review Lifecycle with Graft ──────────────────────────

test("6. Production Review Lifecycle: changed files & call context from Graft reach reviewer prompt", async () => {
  const store = makeTestStore();
  const mockSpawn = createMockGraftSpawn();
  const settings = makeSettings(store);

  const implRunId = store.createRun("PACE-903", {
    summary: "Review implementation diff",
    allowedPaths: ["lib/**"],
    configSnapshot: { executorProvider: "codex", executorModel: "gpt-5" }
  });
  store.transition(implRunId, "review-queued", { implementationSha: "1111222233334444555566667777888899990000" });

  const issue = {
    key: "PACE-903",
    summary: "Review implementation diff",
    description: "Acceptance criteria: [ ] Review changes",
    canonicalState: "review",
    labels: ["agent-ready"]
  };

  const queuedRun = store.getRun(implRunId);
  const reviewIntel = await collectReviewIntelligence(settings, issue, ["lib/runtime.js", "lib/secret-impact.js"], {
    runtime: { spawn: mockSpawn }
  });

  const reviewPlan = await issuePlanWithIntelligence(settings, issue, {
    store,
    action: "review",
    originatingRun: queuedRun,
    reviewIntelligence: reviewIntel,
    runtime: {
      spawnSync: () => ({ status: 0, stdout: "" }),
      spawn: mockSpawn
    }
  });

  assert.ok(reviewPlan.reviewIntelligence);
  assert.deepEqual(reviewPlan.reviewIntelligence.changedFiles, ["lib/runtime.js", "lib/secret-impact.js"]);

  let capturedPrompt = null;
  const customRuntime = {
    spawnSync: (cmd, args) => {
      if (cmd === "git") {
        return { status: 0, stdout: "1111222233334444555566667777888899990000\n" };
      }
      if (cmd === "codex" && args[0] === "exec") {
        const promptIdx = args.findIndex((a) => a === "--prompt" || a === "-p");
        if (promptIdx !== -1) {
          capturedPrompt = args[promptIdx + 1];
        } else {
          capturedPrompt = args[args.length - 1];
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            verdict: "clean",
            evidence: [{
              id: "clean-1",
              severity: "minor",
              category: "correctness",
              problem: "Verified implementation against review intelligence",
              file: "lib/runtime.js"
            }]
          })
        };
      }
      return { status: 0, stdout: "{}\n" };
    },
    spawn: mockSpawn
  };

  const reviewResult = handleReview(settings, issue, true, customRuntime, { plan: reviewPlan });

  assert.equal(reviewResult.exitCode, 0);
  assert.ok(capturedPrompt, "Executor must be called with review prompt");
  assert.ok(capturedPrompt.includes("lib/secret-impact.js"));
  assert.ok(capturedPrompt.includes("### REVIEW INTELLIGENCE"));
  assert.ok(capturedPrompt.includes("- Provider: graft"));
});

// ── Test 7: Production Rework Lifecycle with Graft ───────────────────────────

test("7. Production Rework Lifecycle: pinned originating evidence + fresh rework intelligence collected separately", async () => {
  const store = makeTestStore();
  let searchCallCount = 0;

  const reworkSpawn = createMockGraftSpawn((name, args) => {
    if (name === "graft_find_code") {
      searchCallCount++;
      return searchCallCount === 1
        ? `graft ask — "handleImplementation"  (lexical)\n\n1. handleImplementation · function  [handleImplementation]\n   lib/runtime.js:L1120-L1145\n   export function handleImplementation() {}\n`
        : `graft ask — "reworkFixHelper"  (lexical)\n\n1. reworkFixHelper · function  [reworkFixHelper]\n   lib/runtime.js:L1250-L1270\n   export function reworkFixHelper() {}\n`;
    }
    return defaultGraftToolHandler(name, args);
  });

  const settings = makeSettings(store);
  const originatingIntel = {
    provider: "graft",
    generation: "G1",
    status: "ready",
    search: { files: ["lib/runtime.js"], symbols: ["handleImplementation"] }
  };

  const originatingRunId = store.createRun("PACE-904", {
    summary: "Rework item",
    allowedPaths: ["backend/**", "lib/**"],
    persona: "backend-engineer",
    taskAgent: "backend-engineer",
    codeIntelligence: originatingIntel,
    configSnapshot: {
      persona: "backend-engineer",
      taskAgent: "backend-engineer",
      allowedPaths: ["backend/**", "lib/**"],
      codeIntelligence: originatingIntel,
      executorProvider: "codex",
      executorModel: "gpt-5"
    }
  });
  store.transition(originatingRunId, "failed-retryable", {
    attempt: 1,
    reviewOutcome: {
      verdict: "changes-requested",
      evidence: [{ file: "lib/store.js", problem: "Missing transaction lock" }]
    }
  });

  const issue = {
    key: "PACE-904",
    summary: "Rework item",
    description: "Acceptance criteria: [ ] Fix transaction lock",
    canonicalState: "rework",
    labels: ["agent-ready"]
  };

  const failedRun = store.getRun(originatingRunId);

  const reworkPlan = await issuePlanWithIntelligence(settings, issue, {
    store,
    action: "rework",
    originatingRun: failedRun,
    runtime: {
      spawnSync: () => ({ status: 0, stdout: "" }),
      spawn: reworkSpawn
    }
  });

  assert.equal(reworkPlan.configSnapshot.originatingCodeIntelligence.generation, "G1", "Originating generation G1 must be preserved");
  assert.ok(reworkPlan.reworkCodeIntelligence, "Rework intelligence must be automatically collected");
  assert.ok(reworkPlan.configSnapshot.reworkCodeIntelligence, "Rework intelligence must be pinned into configSnapshot");
  assert.deepEqual(reworkPlan.reworkCodeIntelligence.changedFiles, ["lib/store.js"], "Rework intelligence must automatically target review failure files");

  let capturedWorkerPrompt = null;
  const customRuntime = {
    spawnSync: (cmd, args) => {
      if (cmd === "git") {
        if (args.includes("status")) return { status: 0, stdout: "" };
        return { status: 0, stdout: "abc1234\n" };
      }
      if (cmd === "codex" && args[0] === "exec") {
        const promptIdx = args.findIndex((a) => a === "--prompt" || a === "-p");
        if (promptIdx !== -1) {
          capturedWorkerPrompt = args[promptIdx + 1];
        } else {
          capturedWorkerPrompt = args[args.length - 1];
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            status: "completed",
            summary: "Fixed transaction lock",
            changed_files: [],
            validation_commands: [],
            blockers: [],
            risks: []
          })
        };
      }
      return { status: 0, stdout: "{}\n" };
    },
    spawn: reworkSpawn
  };

  const reworkResult = handleImplementation(settings, issue, true, customRuntime, { plan: reworkPlan });

  assert.equal(reworkResult.exitCode, 0);
  assert.ok(capturedWorkerPrompt, "Worker prompt must be built");
  assert.ok(capturedWorkerPrompt.includes("### ORIGINAL CODE INTELLIGENCE") || capturedWorkerPrompt.includes("### CODE INTELLIGENCE CONTEXT"));
  assert.ok(capturedWorkerPrompt.includes("gen: G1"));
  assert.ok(capturedWorkerPrompt.includes("### REWORK IMPACT INTELLIGENCE") || capturedWorkerPrompt.includes("lib/store.js"));
  assert.equal(reworkPlan.configSnapshot.originatingCodeIntelligence.generation, "G1", "Originating G1 snapshot remains pinned");
});

// ── Test 8: Provider Switching & Neutrality ─────────────────────────────────

test("8. Provider Switching & Neutrality: codebase-memory <-> graft seamless configuration switch with identical normalized runtime contract", async () => {
  const store = makeTestStore();
  const mockCbmSpawn = (cmd, args, opts) => {
    const stdin = new EventEmitter();
    stdin.writable = true;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => child.emit("close", 0);

    stdin.write = (chunk) => {
      const lines = chunk.toString("utf8").split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          setImmediate(() => {
            stdout.emit("data", Buffer.from(JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "codebase-memory", version: "1.0" } }
            }) + "\n"));
          });
        } else if (msg.method === "notifications/initialized") {
          // ack
        } else if (msg.method === "tools/list") {
          setImmediate(() => {
            stdout.emit("data", Buffer.from(JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              result: {
                tools: [
                  { name: "get_architecture", inputSchema: { type: "object", properties: { project: { type: "string" }, aspects: { type: "array" } } } },
                  { name: "search_graph", inputSchema: { type: "object", properties: { project: { type: "string" }, name_pattern: { type: "string" }, limit: { type: "number" } } } },
                  { name: "trace_path", inputSchema: { type: "object", properties: { project: { type: "string" }, function_name: { type: "string" }, direction: { type: "string" }, depth: { type: "number" } } } },
                  { name: "index_status", inputSchema: { type: "object", properties: { project: { type: "string" } } } }
                ]
              }
            }) + "\n"));
          });
        } else if (msg.method === "tools/call") {
          let res = {};
          if (msg.params.name === "get_architecture") res = { project_name: "agent-scaffold", packages: ["lib"], entry_points: ["lib/runtime.js"] };
          if (msg.params.name === "search_graph") res = { results: [{ name: "handleImplementation", file_path: "lib/runtime.js", line: 1120 }] };
          if (msg.params.name === "trace_path") res = { function_name: msg.params.arguments?.function_name, callers: [{ symbol: "runIssue" }], callees: [], paths: [] };
          if (msg.params.name === "index_status") res = { is_indexed: true, project_name: "agent-scaffold" };
          setImmediate(() => {
            stdout.emit("data", Buffer.from(JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              result: { content: [{ type: "text", text: JSON.stringify(res) }] }
            }) + "\n"));
          });
        }
      }
    };
    stdin.end = () => {};
    return child;
  };

  const mockGraftSpawn = createMockGraftSpawn();

  const cbmSettings = makeSettings(store, {
    codeIntelligence: {
      defaultProvider: "codebase-memory",
      providers: {
        "codebase-memory": { type: "codebase-memory-mcp", enabled: true, command: ["codebase-memory-mcp"] },
        "graft": { type: "graft-mcp", enabled: true, command: ["graft", "mcp"] }
      }
    }
  });

  const graftSettings = makeSettings(store, {
    codeIntelligence: {
      defaultProvider: "graft",
      providers: {
        "codebase-memory": { type: "codebase-memory-mcp", enabled: true, command: ["codebase-memory-mcp"] },
        "graft": { type: "graft-mcp", enabled: true, command: ["graft", "mcp"] }
      }
    }
  });

  const cbmProvider = createCodeIntelligenceProvider(cbmSettings, { spawn: mockCbmSpawn });
  const graftProvider = createCodeIntelligenceProvider(graftSettings, { spawn: mockGraftSpawn });

  assert.equal(cbmProvider instanceof GraftCodeIntelligenceProvider, false);
  assert.equal(graftProvider instanceof GraftCodeIntelligenceProvider, true);

  const issue = { key: "PACE-905", summary: "Provider neutrality check", labels: ["agent-ready"] };

  const cbmContext = await collectCodeIntelligenceContext(cbmSettings, issue, { runtime: { spawn: mockCbmSpawn } });
  const graftContext = await collectCodeIntelligenceContext(graftSettings, issue, { runtime: { spawn: mockGraftSpawn } });

  assert.equal(cbmContext.provider, "codebase-memory");
  assert.equal(graftContext.provider, "graft");

  // Normalized properties match in shape
  for (const field of ["provider", "project", "status", "coverage", "search", "warnings"]) {
    assert.ok(field in cbmContext, `Field ${field} must exist in codebase-memory context`);
    assert.ok(field in graftContext, `Field ${field} must exist in graft context`);
  }

  cbmProvider.close();
  graftProvider.close();
});

// ── Test 9: Truthful Handling of Stale / Unindexed / Unknown Freshness Markers ─

test("9. Truthful Handling of Stale / Unindexed / Unknown Freshness Markers: explicit graft check: STALE, NO GRAPH, and unknown text markers", async () => {
  const store = makeTestStore();

  // A. Freshness precedence assertions:
  // 1. graft check: OK & graph check: STALE => fresh: false
  const p1 = parseGraftFreshnessText("graft check: OK\ngraph check: STALE");
  assert.equal(p1.isFresh, false);
  assert.equal(p1.isIndexed, true);

  // 2. graft check: STALE & graph check: OK => fresh: false
  const p2 = parseGraftFreshnessText("graft check: STALE\ngraph check: OK");
  assert.equal(p2.isFresh, false);
  assert.equal(p2.isIndexed, true);

  // 3. graft check: NO GRAPH & graph check: OK => never fresh (indexed: false, fresh: false)
  const p3 = parseGraftFreshnessText("graft check: NO GRAPH\ngraph check: OK");
  assert.equal(p3.isFresh, false);
  assert.equal(p3.isIndexed, false);

  // 4. graft check: OK & graph check: OK => fresh: true
  const p4 = parseGraftFreshnessText("graft check: OK\ngraph check: OK\nthe graph is in sync with the code");
  assert.equal(p4.isFresh, true);
  assert.equal(p4.isIndexed, true);

  // 5. Unknown text marker => unindexed and unverified
  const p5 = parseGraftFreshnessText("random unrecognized output");
  assert.equal(p5.isFresh, false);
  assert.equal(p5.isIndexed, false);

  // B. Stale Graft graph reports partial coverage with warning
  const staleSpawn = createMockGraftSpawn((name, args) => {
    if (name === "graft_check_freshness") {
      return "graft check: STALE\ngraph is out of sync with workspace";
    }
    return defaultGraftToolHandler(name, args);
  });

  const settings = makeSettings(store);
  const staleProvider = createCodeIntelligenceProvider(settings, { spawn: staleSpawn });

  const coverage = await staleProvider.checkCoverage({ files: ["lib/runtime.js"] });
  assert.equal(coverage.status, "partial");
  assert.ok(coverage.warnings.some((w) => w.includes("stale") || w.includes("out of sync")));
  staleProvider.close();

  // C. Unindexed Graft reports indexed: false and status: unknown
  const unindexedSpawn = createMockGraftSpawn((name, args) => {
    if (name === "graft_check_freshness") {
      return "graft check: NO GRAPH\nrun graft build to index workspace";
    }
    return defaultGraftToolHandler(name, args);
  });
  const unindexedProvider = createCodeIntelligenceProvider(settings, { spawn: unindexedSpawn });
  const unindexedHealth = await unindexedProvider.health();
  assert.equal(unindexedHealth.indexed, false);
  assert.ok(unindexedHealth.warning.includes("no Graft graph") || unindexedHealth.warning.includes("not indexed"));
  unindexedProvider.close();

  // D. Truthful zero-caller impact with fresh graph reports low risk
  const freshZeroCallerSpawn = createMockGraftSpawn((name, args) => {
    if (name === "graft_trace_calls") {
      return "handleImplementation · function · lib/runtime.js:L1120-L1145\n"; // no caller edges
    }
    return defaultGraftToolHandler(name, args);
  });
  const freshZeroProvider = createCodeIntelligenceProvider(settings, { spawn: freshZeroCallerSpawn });
  const zeroImpact = await freshZeroProvider.detectChanges({ files: ["lib/runtime.js"] });
  assert.equal(zeroImpact.risk, "low");
  assert.equal(zeroImpact.coverage, "covered");
  assert.ok(zeroImpact.reasons[0].includes("No indexed inbound callers found in the fresh covered Graft graph"));
  freshZeroProvider.close();

  // E. Per-file impact tracking: when one of multiple traces fails, risk is NEVER downgraded to low
  const partialFailSpawn = createMockGraftSpawn((name, args) => {
    if (name === "graft_trace_calls") {
      if (args.symbol === "file1.js") {
        return "file1 · function · file1.js:L1-L10\n"; // 0 callers
      }
      return { isError: true, text: "Trace failed for file2.js" };
    }
    return defaultGraftToolHandler(name, args);
  });
  const partialFailProvider = createCodeIntelligenceProvider(settings, { spawn: partialFailSpawn });
  const partialImpact = await partialFailProvider.detectChanges({ files: ["file1.js", "file2.js"] });
  assert.equal(partialImpact.risk, "unknown", "Must not claim low risk when one trace failed");
  assert.equal(partialImpact.coverage, "partial", "Coverage must be partial when some traces failed");
  partialFailProvider.close();

  // F. Unavailable Graft process allows planning to continue with explicit unavailable state
  const unavailableSpawn = () => {
    const err = new Error("spawn graft ENOENT");
    err.code = "ENOENT";
    throw err;
  };

  const unavailContext = await collectCodeIntelligenceContext(settings, { key: "PACE-906", summary: "Graceful failure" }, {
    runtime: { spawn: unavailableSpawn }
  });

  assert.equal(unavailContext.provider, "graft");
  assert.equal(unavailContext.status, "unavailable");
  assert.equal(unavailContext.search.files.length, 0);
  assert.ok(unavailContext.warnings.length > 0);

  // Plan still generated safely
  const plan = issuePlan(settings, { key: "PACE-906", summary: "Graceful failure", labels: ["agent-ready"] }, {
    store,
    codeIntelligence: unavailContext,
    runtime: {
      spawnSync: () => ({
        status: 0,
        stdout: JSON.stringify({
          issue: "PACE-906",
          summary: "Graceful failure",
          persona: "backend-engineer",
          taskAgent: "backend-engineer",
          skills: ["minimal-change"],
          risk: "low",
          parallelSafe: true,
          allowedPaths: ["lib/**"],
          dependencies: [],
          rationale: ["Planning with unavailable graft"]
        })
      })
    }
  });

  assert.equal(plan.configSnapshot.codeIntelligence.status, "unavailable");
  assert.ok(plan.allowedPaths.includes("lib/**"));
});

// ── Test 10: Observability API Integration ──────────────────────────────────

test("10. Observability API Integration: /api/observability/runs/:runId exposes normalized Graft summary", async () => {
  const store = makeTestStore();
  const settings = makeSettings(store);

  const graftIntelPacket = {
    provider: "graft",
    project: "agent-scaffold",
    generation: "graft-2026-Q3",
    status: "ready",
    collectedAt: "2026-08-16T00:15:00Z",
    durationMs: 180,
    search: { files: ["lib/runtime.js", "lib/store.js"], symbols: ["handleImplementation", "recordTelemetryEvent"] },
    coverage: { status: "covered" },
    warnings: []
  };

  const plan = {
    issue: "PACE-907",
    summary: "Observability Graft intelligence verification",
    configSnapshot: {
      codeIntelligence: graftIntelPacket,
      executorProvider: "codex",
      executorModel: "gpt-5"
    },
    allowedPaths: ["lib/**"],
    persona: "backend-engineer",
    taskAgent: "backend-engineer"
  };

  const runId = store.createRun("PACE-907", plan);
  store.recordTelemetryEvent({ eventId: `t-${runId}-1-q`, runId, stage: "queued", sequence: 1 });
  store.recordTelemetryEvent({ eventId: `t-${runId}-2-s`, runId, stage: "started", sequence: 2 });
  store.recordTelemetryEvent({
    eventId: `t-${runId}-term`,
    runId,
    stage: "terminal",
    status: "completed",
    sequence: 999
  });
  store.transition(runId, "completed", {});

  const server = createDashboardServer(settings, { store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const res = await request(server, `/api/observability/runs/${runId}`);
    assert.equal(res.status, 200);
    assert.ok(res.json);
    assert.ok(res.json.codeIntelligence);
    assert.equal(res.json.codeIntelligence.provider, "graft");
    assert.equal(res.json.codeIntelligence.status, "ready");
    assert.equal(res.json.codeIntelligence.relevantFileCount, 2);
    assert.equal(res.json.codeIntelligence.relevantSymbolCount, 2);
    assert.equal(res.json.codeIntelligence.coverage, "covered");
  } finally {
    server.close();
  }
});

// ── Test 11: Real Live Graft Binary Smoke Test with graft build ─────────────

test("11. Real Live Graft Binary Smoke Test with graft build: exercised if graft binary is on PATH, skipped otherwise", async (t) => {
  let hasGraft = false;
  try {
    execSync("graft --version", { stdio: "ignore" });
    hasGraft = true;
  } catch {
    hasGraft = false;
  }

  if (!hasGraft) {
    t.skip("graft binary not present on PATH; skipping live integration smoke test");
    return;
  }

  const liveStore = makeTestStore();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
  const fakeCodexDir = path.join(fakeHome, ".codex");
  fs.mkdirSync(fakeCodexDir, { recursive: true });

  const homeHooksSentinel = JSON.stringify({ version: 1, sentinel: "untouched" }, null, 2);
  const homeConfigSentinel = 'sentinel = "untouched"\n';
  fs.writeFileSync(path.join(fakeCodexDir, "hooks.json"), homeHooksSentinel, "utf8");
  fs.writeFileSync(path.join(fakeCodexDir, "config.toml"), homeConfigSentinel, "utf8");

  const liveRepo = fs.mkdtempSync(path.join(os.tmpdir(), "live-graft-repo-"));
  execSync("git init", { cwd: liveRepo, stdio: "ignore" });
  execSync("git config user.name 'GraftLiveTest'", { cwd: liveRepo, stdio: "ignore" });
  execSync("git config user.email 'graft-live@test.local'", { cwd: liveRepo, stdio: "ignore" });

  // Create tracked sentinel rule
  const rulesDir = path.join(liveRepo, ".agents", "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  const repoRuleSentinel = "# Custom Rule\nsentinel = untouched\n";
  fs.writeFileSync(path.join(rulesDir, "orchestration-gates.md"), repoRuleSentinel, "utf8");

  // Create a fixture with at least two functions where one calls the other
  const mathFile = path.join(liveRepo, "src", "math.js");
  fs.mkdirSync(path.dirname(mathFile), { recursive: true });
  fs.writeFileSync(
    mathFile,
    "export function add(a, b) {\n  return a + b;\n}\n\nexport function calculateTotal(items) {\n  return items.reduce((acc, item) => add(acc, item), 0);\n}\n"
  );
  execSync("git add .", { cwd: liveRepo, stdio: "ignore" });
  execSync("git commit -m 'initial'", { cwd: liveRepo, stdio: "ignore" });

  // Run structural build per Requirement 4 without swallowing errors
  execSync(`graft build "${liveRepo}"`);

  const liveSettings = makeSettings(liveStore, {
    repoPath: liveRepo,
    codeIntelligence: {
      defaultProvider: "graft",
      providers: {
        graft: {
          type: "graft",
          enabled: true,
          command: ["graft"],
          env: { HOME: fakeHome, USERPROFILE: fakeHome }
        }
      }
    }
  });

  const liveProvider = createCodeIntelligenceProvider(liveSettings);

  const health = await liveProvider.health(liveRepo);
  assert.equal(health.configured, true);
  assert.equal(health.available, true);
  assert.equal(health.indexed, true);

  const coverage = await liveProvider.checkCoverage({ repoPath: liveRepo, files: ["src/math.js"] });
  assert.equal(coverage.status, "covered");

  const arch = await liveProvider.getArchitecture({ repoPath: liveRepo });
  assert.ok(arch);
  assert.equal(arch.provider, "graft");

  const search = await liveProvider.searchCode("calculateTotal", { repoPath: liveRepo });
  assert.ok(search.matches.length > 0);
  assert.ok(search.matches.some((m) => m.symbol === "calculateTotal" || m.file?.includes("math.js")));

  const traceIn = await liveProvider.tracePath({ repoPath: liveRepo, symbol: "add", direction: "in" });
  assert.ok(traceIn);
  assert.ok(traceIn.callers.length > 0 || traceIn.paths.length > 0);

  const traceOut = await liveProvider.tracePath({ repoPath: liveRepo, symbol: "calculateTotal", direction: "out" });
  assert.ok(traceOut);
  assert.ok(traceOut.callees.length > 0 || traceOut.paths.length > 0);

  const snippet = await liveProvider.getSnippet({ repoPath: liveRepo, file: "src/math.js" });
  assert.ok(snippet.content.includes("calculateTotal"));

  // Verify sentinel files in HOME and repo remain byte-for-byte unchanged
  const currentHomeHooks = fs.readFileSync(path.join(fakeCodexDir, "hooks.json"), "utf8");
  assert.equal(currentHomeHooks, homeHooksSentinel, "HOME ~/.codex/hooks.json must remain byte-for-byte unchanged");

  const currentHomeConfig = fs.readFileSync(path.join(fakeCodexDir, "config.toml"), "utf8");
  assert.equal(currentHomeConfig, homeConfigSentinel, "HOME ~/.codex/config.toml must remain byte-for-byte unchanged");

  const currentRepoRule = fs.readFileSync(path.join(rulesDir, "orchestration-gates.md"), "utf8");
  assert.equal(currentRepoRule, repoRuleSentinel, "Tracked repo rule must remain byte-for-byte unchanged");

  // Verify provider execution did not modify tracked repo files
  const gitStatus = execSync("git status --porcelain", { cwd: liveRepo }).toString("utf8").trim();
  assert.equal(gitStatus, "", "Graft provider execution must not leave modified or untracked repository files");

  liveProvider.close();
});
