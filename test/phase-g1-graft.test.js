/**
 * test/phase-g1-graft.test.js
 *
 * Phase G.1 — NanoNets/Graft Code Intelligence Provider Suite:
 * 1. Lifecycle: disabled, missing binary, handshake, missing required tools, timeout/buffer safety.
 * 2. Normalization: repo map -> Architecture, find_code/find_all -> Search, trace_calls -> Trace, file_api -> Snippet, check_freshness -> Coverage.
 * 3. Path Security: authorized repo & worktree accepted, unauthorized root rejected, symlink escape rejected, relative snippet paths.
 * 4. Production Planning Flow: defaultProvider="graft" collects Graft intelligence & passes exact plan to execution.
 * 5. Production Implementation Flow: executor prompt contains bounded Graft code intelligence.
 * 6. Production Review Lifecycle: changed files & call context from Graft reach reviewer prompt.
 * 7. Production Rework Lifecycle: pinned originating evidence + fresh rework intelligence collected separately.
 * 8. Provider Switching & Neutrality: codebase-memory <-> graft seamless configuration switch with identical normalized runtime contract.
 * 9. Truthful Handling of Stale / Unavailable Graft: degraded freshness attached as warning, unavailable Graft continues without fabricated data.
 * 10. Observability API Integration: /api/observability/runs/:runId exposes normalized Graft summary.
 * 11. Optional Live Graft Binary Smoke Test: exercised if graft binary is on PATH, skipped otherwise.
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
  buildSafeMcpEnv
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

const GRAFT_TOOL_SCHEMAS = {
  graft_repo_map: {
    type: "object",
    properties: { path: { type: "string" }, project: { type: "string" } }
  },
  graft_find_code: {
    type: "object",
    required: ["question"],
    properties: { question: { type: "string" }, path: { type: "string" }, limit: { type: "number" }, project: { type: "string" } }
  },
  graft_find_all: {
    type: "object",
    required: ["regex"],
    properties: { regex: { type: "string" }, path: { type: "string" }, limit: { type: "number" } }
  },
  graft_trace_calls: {
    type: "object",
    required: ["symbol"],
    properties: { symbol: { type: "string" }, direction: { type: "string" }, depth: { type: "number" }, path: { type: "string" } }
  },
  graft_file_api: {
    type: "object",
    required: ["file"],
    properties: { file: { type: "string" }, symbol: { type: "string" }, path: { type: "string" } }
  },
  graft_check_freshness: {
    type: "object",
    properties: { path: { type: "string" }, paths: { type: "array" } }
  },
  graft_detect_changes: {
    type: "object",
    properties: { path: { type: "string" }, git_diff: { type: "string" }, files: { type: "array" }, scope: { type: "string" } }
  }
};

function createMockGraftSpawn(toolHandler) {
  return function mockSpawn(cmd, args, opts) {
    const stdin = new EventEmitter();
    stdin.writable = true;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {
      child.emit("close", 0);
    };

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

            // Strict Schema Check: reject undeclared arguments
            const schema = GRAFT_TOOL_SCHEMAS[toolName];
            if (schema && schema.properties) {
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
            }

            const res = toolHandler ? toolHandler(toolName, toolArgs) : defaultGraftToolHandler(toolName, toolArgs);
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
      return {
        project: "agent-scaffold",
        generation: "graft-gen-1",
        languages: ["JavaScript"],
        packages: ["lib", "ui", "test"],
        entry_points: ["lib/runtime.js", "lib/orchestrator.js"],
        routes: ["GET /api/observability/runs/:runId"],
        hotspots: ["lib/runtime.js"],
        boundaries: ["lib/store.js"],
        summary: "Agent Scaffold codebase mapped by Graft"
      };
    case "graft_find_code":
      assert.ok(args.question, "graft_find_code requires question per Graft schema");
      return {
        nodes: [
          {
            name: "handleImplementation",
            symbol: "handleImplementation",
            kind: "function",
            file: "lib/runtime.js",
            line: 1120,
            qualified_name: "lib/runtime.js:handleImplementation",
            score: 0.95,
            evidence: "export function handleImplementation(settings, issue..."
          }
        ],
        coverage: "covered"
      };
    case "graft_find_all":
      assert.ok(args.regex, "graft_find_all requires regex per Graft schema");
      return {
        results: [
          {
            symbol: "handleImplementation",
            file: "lib/runtime.js",
            line: 1120
          }
        ]
      };
    case "graft_trace_calls":
      assert.ok(args.symbol, "graft_trace_calls requires symbol per Graft schema");
      return {
        symbol: args.symbol,
        direction: args.direction || "both",
        callers: [{ symbol: "runIssue", file: "lib/runtime.js", line: 808 }],
        callees: [{ symbol: "issuePlan", file: "lib/runtime.js", line: 133 }],
        paths: [["runIssue", args.symbol, "issuePlan"]],
        coverage: "covered"
      };
    case "graft_file_api":
      assert.ok(args.file, "graft_file_api requires file per Graft schema");
      return {
        file: args.file,
        start_line: 1,
        end_line: 25,
        content: "export function handleImplementation(settings, issue) { ... }",
        truncated: false
      };
    case "graft_check_freshness":
      return {
        fresh: true,
        synced: true,
        status: "fresh",
        generation: "graft-gen-1",
        last_indexed_at: "2026-08-16T00:00:00Z"
      };
    case "graft_detect_changes":
      return {
        changed_files: Array.isArray(args.files) && args.files.length > 0 ? args.files : ["lib/runtime.js"],
        affected_symbols: ["handleImplementation"],
        callers: ["runIssue"],
        dependents: ["test/phase-g1-graft.test.js"],
        risk: "low",
        reasons: ["Graft analyzed modified files"],
        coverage: "covered"
      };
    default:
      return {};
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

// ── Test 1: Graft Lifecycle & Fail-Closed Discovery ─────────────────────────

test("1. Graft Lifecycle: disabled, missing binary, handshake, missing required tools, timeout/buffer safety", async () => {
  const store = makeTestStore();

  // A. Disabled provider returns explicit disabled state
  const disabledSettings = makeSettings(store, {
    codeIntelligence: {
      defaultProvider: "graft",
      providers: {
        graft: { type: "graft-mcp", enabled: false, command: ["graft", "mcp"] }
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
    { enabled: true, command: ["graft", "mcp"] },
    { spawn: unavailableSpawn }
  );
  const unavailHealth = await unavailProvider.health();
  assert.equal(unavailHealth.available, false);
  assert.ok(unavailHealth.warning.includes("ENOENT") || unavailHealth.warning.includes("unavailable"));

  // C. Successful handshake & tool discovery
  const mockSpawn = createMockGraftSpawn();
  const okProvider = new GraftCodeIntelligenceProvider(
    "graft",
    { enabled: true, command: ["graft", "mcp"] },
    { spawn: mockSpawn }
  );
  const okHealth = await okProvider.health();
  assert.equal(okHealth.available, true);
  assert.equal(okHealth.indexed, true);
  assert.ok(okHealth.capabilities.includes("graft_repo_map"));
  assert.ok(okHealth.capabilities.includes("graft_find_code"));

  // D. Tool discovery failure fails closed
  let toolsCallAttempted = false;
  const failingListSpawn = (cmd, args, opts) => {
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
              result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "graft", version: "0.8" } }
            }) + "\n"));
          });
        } else if (msg.method === "tools/list") {
          setImmediate(() => {
            stdout.emit("data", Buffer.from(JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              error: { code: -32000, message: "Tools discovery error" }
            }) + "\n"));
          });
        } else if (msg.method === "tools/call") {
          toolsCallAttempted = true;
        }
      }
    };
    stdin.end = () => {};
    return child;
  };

  const discoveryFailedProvider = new GraftCodeIntelligenceProvider(
    "graft",
    { enabled: true, command: ["graft", "mcp"] },
    { spawn: failingListSpawn }
  );
  const failedHealth = await discoveryFailedProvider.health();
  assert.equal(failedHealth.available, false);
  assert.equal(toolsCallAttempted, false, "No tools/call must be attempted when discovery fails");

  // E. Buffer bounds safety
  const bigSpawn = () => {
    const stdin = new EventEmitter();
    stdin.writable = true;
    stdin.write = () => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.alloc(1024 * 1024 * 6, "x"));
      });
    };
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => child.emit("close", 0);
    return child;
  };
  const boundedClient = new McpStdioClient("graft", ["mcp"], { maxBufferSize: 1024 * 1024 * 5, runtime: { spawn: bigSpawn } });
  await assert.rejects(boundedClient.connect(), /exceeded maximum buffer size/);
  boundedClient.close();
});

// ── Test 2: Graft Normalization ─────────────────────────────────────────────

test("2. Graft Normalization: repo map -> Architecture, find_code -> Search, trace_calls -> Trace, file_api -> Snippet, check_freshness -> Coverage", async () => {
  const store = makeTestStore();
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "graft-norm-"));
  const settings = makeSettings(store, { repoPath: repoDir });

  const mockSpawn = createMockGraftSpawn();
  const provider = createCodeIntelligenceProvider(settings, { spawn: mockSpawn });

  // 1. Architecture normalization
  const arch = await provider.getArchitecture({ project: "agent-scaffold" });
  assert.equal(arch.provider, "graft");
  assert.equal(arch.project, "agent-scaffold");
  assert.ok(arch.packages.includes("lib"));
  assert.ok(arch.entryPoints.includes("lib/runtime.js"));
  assert.ok(arch.hotspots.includes("lib/runtime.js"));

  // 2. Search normalization
  const search = await provider.searchCode("handleImplementation", { project: "agent-scaffold" });
  assert.equal(search.query, "handleImplementation");
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].symbol, "handleImplementation");
  assert.equal(search.matches[0].file, "lib/runtime.js");
  assert.equal(search.coverage, "covered");

  // 3. Trace normalization
  const trace = await provider.tracePath({ project: "agent-scaffold", symbol: "handleImplementation" });
  assert.equal(trace.symbol, "handleImplementation");
  assert.equal(trace.callers.length, 1);
  assert.deepEqual(trace.paths, [["runIssue", "handleImplementation", "issuePlan"]]);

  // 4. Snippet normalization
  const snip = await provider.getSnippet({ file: "lib/runtime.js", symbol: "handleImplementation" });
  assert.ok(snip.content.includes("handleImplementation"));
  assert.equal(snip.file, "lib/runtime.js");

  // 5. Coverage normalization
  const coverage = await provider.checkCoverage({ files: ["lib/runtime.js"] });
  assert.equal(coverage.status, "covered");
  assert.equal(coverage.coverageRatio, 1.0);

  // 6. Changes/Impact normalization
  const impact = await provider.detectChanges({ files: ["lib/runtime.js"] });
  assert.ok(impact.changedFiles.includes("lib/runtime.js"));
  assert.ok(impact.affectedSymbols.includes("handleImplementation"));

  provider.close();
});

// ── Test 3: Graft Path Security ─────────────────────────────────────────────

test("3. Graft Path Security: authorized repo & worktree accepted, unauthorized root rejected, symlink escape rejected, relative snippet paths", async () => {
  const store = makeTestStore();
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "graft-sec-"));
  const worktreeDir = path.join(repoDir, "worktrees");
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "graft-outside-"));
  fs.mkdirSync(worktreeDir, { recursive: true });

  const settings = makeSettings(store, {
    repoPath: repoDir,
    worktreeRoot: worktreeDir
  });

  const provider = createCodeIntelligenceProvider(settings, { spawn: createMockGraftSpawn() });

  // A. Configured repository is accepted
  const health = await provider.health(repoDir);
  assert.equal(health.available, true);

  // B. Unauthorized external root is rejected
  await assert.rejects(
    provider.health("/etc"),
    /outside the authorized roots/
  );
  await assert.rejects(
    provider.searchCode("test", { repoPath: outsideDir }),
    /outside the authorized roots/
  );

  // C. Authorized worktree is accepted
  const leafWorktree = path.join(worktreeDir, "PACE-901-leaf");
  fs.mkdirSync(leafWorktree, { recursive: true });
  const worktreeArch = await provider.getArchitecture({ repoPath: leafWorktree });
  assert.ok(worktreeArch);

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

  const validSnippet = await provider.getSnippet({ file: "lib/runtime.js", symbol: "handleImplementation" });
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
      return {
        nodes: [
          {
            name: searchCallCount === 1 ? "handleImplementation" : "reworkFixHelper",
            file: "lib/runtime.js",
            line: searchCallCount === 1 ? 1120 : 1250,
            qualified_name: searchCallCount === 1 ? "lib/runtime.js:handleImplementation" : "lib/runtime.js:reworkFixHelper"
          }
        ],
        coverage: "covered"
      };
    }
    return defaultGraftToolHandler(name, args);
  });

  const settings = makeSettings(store);
  const originatingIntel = {
    provider: "graft",
    generation: "G1",
    status: "ready",
    search: { files: ["lib/runtime.js"] }
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
  const mockCbmSpawn = createMockGraftSpawn((name, args) => {
    if (name === "get_architecture") return { project_name: "agent-scaffold", packages: ["lib"], entry_points: ["lib/runtime.js"] };
    if (name === "search_graph") return { results: [{ name: "handleImplementation", file_path: "lib/runtime.js", line: 1120 }] };
    if (name === "trace_path") return { function_name: args.function_name, callers: [{ symbol: "runIssue" }], callees: [], paths: [] };
    if (name === "index_status") return { is_indexed: true, project_name: "agent-scaffold" };
    return defaultGraftToolHandler(name, args);
  });
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

// ── Test 9: Truthful Handling of Stale / Unavailable Graft ──────────────────

test("9. Truthful Handling of Stale / Unavailable Graft: degraded freshness attached as warning, unavailable Graft continues without fabricated data", async () => {
  const store = makeTestStore();

  // A. Stale Graft graph reports partial coverage with warning
  const staleSpawn = createMockGraftSpawn((name, args) => {
    if (name === "graft_check_freshness") {
      return {
        fresh: false,
        synced: false,
        status: "stale",
        generation: "graft-stale-0"
      };
    }
    return defaultGraftToolHandler(name, args);
  });

  const settings = makeSettings(store);
  const provider = createCodeIntelligenceProvider(settings, { spawn: staleSpawn });

  const coverage = await provider.checkCoverage({ files: ["lib/runtime.js"] });
  assert.equal(coverage.status, "partial");
  assert.ok(coverage.warnings.some((w) => w.includes("stale") || w.includes("out of sync")));
  provider.close();

  // B. Unavailable Graft process allows planning to continue with explicit unavailable state
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

// ── Test 11: Optional Live Graft Binary Smoke Test ──────────────────────────

test("11. Optional Live Graft Binary Smoke Test: exercised if graft binary is on PATH, skipped otherwise", async (t) => {
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
  const liveRepo = fs.mkdtempSync(path.join(os.tmpdir(), "live-graft-repo-"));
  execSync("git init", { cwd: liveRepo, stdio: "ignore" });
  fs.writeFileSync(path.join(liveRepo, "index.js"), "export function greet(name) { return `Hello, ${name}`; }\n");
  execSync("git add .", { cwd: liveRepo, stdio: "ignore" });
  execSync("git commit -m 'initial'", { cwd: liveRepo, stdio: "ignore" });

  const liveSettings = makeSettings(liveStore, {
    repoPath: liveRepo,
    codeIntelligence: {
      defaultProvider: "graft",
      providers: {
        graft: { type: "graft-mcp", enabled: true, command: ["graft", "mcp"] }
      }
    }
  });

  const liveProvider = createCodeIntelligenceProvider(liveSettings);
  const health = await liveProvider.health(liveRepo);
  assert.equal(health.configured, true);
  liveProvider.close();
});
