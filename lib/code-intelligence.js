/**
 * lib/code-intelligence.js
 *
 * Phase G — Shared Code Intelligence Layer.
 * Provides a provider-neutral code understanding abstraction and a real
 * codebase-memory-mcp stdio adapter for control-plane planning, implementation
 * context preparation, review, and rework.
 */

import path from "node:path";
import fs from "node:fs";
import { spawn as defaultSpawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";

// ── Real Path Safety & Symlink Containment ──────────────────────────────────

/**
 * Validates that a target path resides within an allowed repository or worktree root.
 * Resolves real filesystem paths (following symlinks) and throws an Error if the target
 * or any symlink escapes the authorized root boundaries.
 */
export function validatePathWithinRoot(targetPath, allowedRoots = []) {
  if (!targetPath || typeof targetPath !== "string") {
    throw new Error("Invalid target path");
  }

  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots]).filter(Boolean);
  if (roots.length === 0) {
    throw new Error(`Path '${targetPath}' is outside authorized roots: no authorized roots configured`);
  }

  // If targetPath is relative, resolve it against the first allowed root, NOT process.cwd()
  const baseForRelative = roots[0] ? (path.isAbsolute(roots[0]) ? roots[0] : path.resolve(roots[0])) : process.cwd();
  const absoluteTarget = path.isAbsolute(targetPath) ? targetPath : path.resolve(baseForRelative, targetPath);

  // Resolve canonical real path for targetPath
  let realTarget;
  try {
    realTarget = fs.realpathSync(absoluteTarget);
  } catch {
    // If target doesn't exist yet, resolve parent directory
    const dir = path.dirname(absoluteTarget);
    try {
      const realDir = fs.realpathSync(dir);
      realTarget = path.join(realDir, path.basename(absoluteTarget));
    } catch {
      realTarget = absoluteTarget;
    }
  }

  const isContained = roots.some((root) => {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      realRoot = path.resolve(root);
    }
    const rel = path.relative(realRoot, realTarget);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });

  if (!isContained) {
    throw new Error(`Path '${targetPath}' is outside the authorized roots: ${roots.join(", ")}`);
  }

  return realTarget;
}

// ── Safe Minimal Subprocess Environment ─────────────────────────────────────

export function buildSafeMcpEnv(customEnv = {}, allowedRoot = null) {
  const SAFE_VARS = [
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
    "HOME", "USERPROFILE", "LANG", "LC_ALL", "LC_CTYPE",
    "NODE_ENV", "NODE_PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"
  ];
  const env = {};
  for (const key of SAFE_VARS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  // Apply custom non-secret environment first
  if (customEnv && typeof customEnv === "object") {
    for (const [k, v] of Object.entries(customEnv)) {
      if (!/(SECRET|TOKEN|KEY|PASSWORD|AUTH|CREDENTIAL)/i.test(k)) {
        env[k] = String(v);
      }
    }
  }

  // Authoritative CBM_ALLOWED_ROOT must override any customEnv override attempts
  if (allowedRoot) {
    try {
      env.CBM_ALLOWED_ROOT = fs.realpathSync(allowedRoot);
    } catch {
      env.CBM_ALLOWED_ROOT = path.resolve(allowedRoot);
    }
  }

  return env;
}

// ── Schema-Aware Parameter Filtering ────────────────────────────────────────

/**
 * Validates and filters candidate arguments against an MCP tool's inputSchema.
 * Discards undeclared properties, maps common schema aliases, and enforces required fields.
 */
export function filterArgsAgainstSchema(toolName, schema, candidateArgs = {}) {
  if (!schema || typeof schema !== "object" || !schema.properties) {
    return { ...candidateArgs };
  }

  const allowedProps = Object.keys(schema.properties);
  const filtered = {};

  for (const prop of allowedProps) {
    if (candidateArgs[prop] !== undefined) {
      filtered[prop] = candidateArgs[prop];
      continue;
    }

    // Property aliases based on common provider schema variations:
    if (prop === "project" && (candidateArgs.projectName !== undefined || candidateArgs.project_name !== undefined)) {
      filtered[prop] = candidateArgs.projectName ?? candidateArgs.project_name;
    } else if (prop === "project_name" && (candidateArgs.project !== undefined || candidateArgs.projectName !== undefined)) {
      filtered[prop] = candidateArgs.project ?? candidateArgs.projectName;
    } else if (prop === "git_diff" && (candidateArgs.diff !== undefined || candidateArgs.gitDiff !== undefined)) {
      filtered[prop] = candidateArgs.diff ?? candidateArgs.gitDiff;
    } else if (prop === "diff" && (candidateArgs.git_diff !== undefined || candidateArgs.gitDiff !== undefined)) {
      filtered[prop] = candidateArgs.git_diff ?? candidateArgs.gitDiff;
    } else if (prop === "paths" && (candidateArgs.files !== undefined || candidateArgs.changed_files !== undefined || candidateArgs.changedFiles !== undefined)) {
      filtered[prop] = candidateArgs.files ?? candidateArgs.changed_files ?? candidateArgs.changedFiles;
    } else if (prop === "files" && (candidateArgs.paths !== undefined || candidateArgs.changed_files !== undefined || candidateArgs.changedFiles !== undefined)) {
      filtered[prop] = candidateArgs.paths ?? candidateArgs.changed_files ?? candidateArgs.changedFiles;
    } else if (prop === "changed_files" && (candidateArgs.files !== undefined || candidateArgs.paths !== undefined || candidateArgs.changedFiles !== undefined)) {
      filtered[prop] = candidateArgs.files ?? candidateArgs.paths ?? candidateArgs.changedFiles;
    } else if (prop === "function_name" && (candidateArgs.symbol !== undefined || candidateArgs.symbol_name !== undefined || candidateArgs.functionName !== undefined)) {
      filtered[prop] = candidateArgs.symbol ?? candidateArgs.symbol_name ?? candidateArgs.functionName;
    } else if (prop === "name_pattern" && candidateArgs.query !== undefined) {
      filtered[prop] = candidateArgs.query;
    } else if (prop === "query" && candidateArgs.name_pattern !== undefined) {
      filtered[prop] = candidateArgs.name_pattern;
    } else if (prop === "repo_path" && candidateArgs.repoPath !== undefined) {
      filtered[prop] = candidateArgs.repoPath;
    } else if (prop === "qualified_name") {
      if (candidateArgs.qualifiedName !== undefined) {
        filtered[prop] = candidateArgs.qualifiedName;
      } else if (candidateArgs.file && candidateArgs.symbol) {
        filtered[prop] = `${candidateArgs.file}:${candidateArgs.symbol}`;
      } else if (candidateArgs.file_path && candidateArgs.symbol_name) {
        filtered[prop] = `${candidateArgs.file_path}:${candidateArgs.symbol_name}`;
      } else if (candidateArgs.file || candidateArgs.file_path) {
        filtered[prop] = candidateArgs.file ?? candidateArgs.file_path;
      }
    }
  }

  if (Array.isArray(schema.required)) {
    for (const req of schema.required) {
      if (filtered[req] === undefined || filtered[req] === null) {
        throw new Error(`Missing required MCP tool parameter '${req}' for tool '${toolName}'`);
      }
    }
  }

  return filtered;
}

// ── Lightweight MCP stdio Client ────────────────────────────────────────────

export class McpStdioClient {
  constructor(command, args = [], options = {}) {
    this.command = command;
    this.args = args;
    this.options = options;
    this.spawnFn = options.runtime?.spawn || defaultSpawn;
    this.timeoutMs = options.timeoutMs || 10000;
    this.maxBufferSize = options.maxBufferSize || (5 * 1024 * 1024); // 5MB limit
    this.child = null;
    this.seq = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.initialized = false;
    this.toolDiscoveryComplete = false;
    this.toolSchemas = new Map();
  }

  async connect() {
    if (this.child && this.initialized && this.toolDiscoveryComplete) return;

    return new Promise((resolve, reject) => {
      let settled = false;
      const safeEnv = buildSafeMcpEnv(this.options.env, this.options.cwd);

      try {
        this.child = this.spawnFn(this.command, this.args, {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: this.options.cwd || process.cwd(),
          env: safeEnv
        });
      } catch (err) {
        return reject(new Error(`Failed to spawn MCP process '${this.command}': ${err.message}`));
      }

      this.child.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`MCP process error for '${this.command}': ${err.message}`));
        }
        this._cleanup(err);
      });

      this.child.on("close", (code) => {
        if (!settled && code !== 0) {
          settled = true;
          reject(new Error(`MCP process exited with code ${code}`));
        }
        this._cleanup(new Error(`MCP process closed with code ${code}`));
      });

      this.child.stdout.on("data", (chunk) => {
        this._handleData(chunk);
      });

      this.child.stderr.on("data", () => {
        // Stderr logging isolated from protocol stdout
      });

      // Execute MCP initialize handshake
      this._request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-scaffold", version: "1.0.0" }
      })
        .then(async (initResult) => {
          this.initialized = true;
          this._notify("notifications/initialized", {});
          try {
            await this.listTools();
            settled = true;
            resolve(initResult);
          } catch (listErr) {
            this.toolDiscoveryComplete = false;
            if (!settled) {
              settled = true;
              this.close();
              reject(new Error(`MCP tool discovery failed: ${listErr.message}`));
            }
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            this.close();
            reject(err);
          }
        });
    });
  }

  _handleData(chunk) {
    if (this.stdoutBuffer.length + chunk.length > this.maxBufferSize) {
      const err = new Error(`MCP process exceeded maximum buffer size of ${this.maxBufferSize} bytes`);
      this._cleanup(err);
      this.close();
      return;
    }

    this.stdoutBuffer += chunk.toString("utf8");
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop(); // Keep partial line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || `MCP error ${msg.error.code}`));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  }

  _request(method, params = {}) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      return Promise.reject(new Error("MCP client is not connected"));
    }

    const id = this.seq++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request '${method}' timed out after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  _notify(method, params = {}) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    try {
      this.child.stdin.write(payload);
    } catch {}
  }

  async listTools() {
    this.toolSchemas.clear();
    const res = await this._request("tools/list", {});
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    for (const tool of tools) {
      if (tool?.name) {
        this.toolSchemas.set(tool.name, tool.inputSchema || {});
      }
    }
    this.toolDiscoveryComplete = true;
    return tools;
  }

  async callTool(name, rawArgs = {}) {
    if (!this.toolDiscoveryComplete) {
      throw new Error(`MCP tool discovery has not completed successfully for provider '${this.command}'`);
    }

    if (!this.toolSchemas.has(name)) {
      throw new Error(`MCP tool '${name}' is not supported by the provider`);
    }

    const schema = this.toolSchemas.get(name);
    const validArgs = filterArgsAgainstSchema(name, schema, rawArgs);

    const res = await this._request("tools/call", { name, arguments: validArgs });
    if (res?.isError) {
      let errMsg = `MCP tool '${name}' reported an error`;
      if (Array.isArray(res?.content)) {
        const textItem = res.content.find((c) => c.type === "text");
        if (textItem && typeof textItem.text === "string") {
          errMsg = textItem.text;
        }
      }
      throw new Error(errMsg);
    }

    // MCP tools return { content: [ { type: "text", text: "..." } ] }
    if (Array.isArray(res?.content)) {
      const textItem = res.content.find((c) => c.type === "text");
      if (textItem && typeof textItem.text === "string") {
        try {
          return JSON.parse(textItem.text);
        } catch {
          return textItem.text;
        }
      }
    }
    return res;
  }

  _cleanup(err) {
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(err || new Error("MCP client disconnected"));
    }
    this.pending.clear();
    this.child = null;
    this.initialized = false;
    this.toolDiscoveryComplete = false;
  }

  close() {
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch {}
      try {
        this.child.kill();
      } catch {}
      this._cleanup(new Error("MCP client closed"));
    }
  }
}

// ── Base Code Intelligence Provider (Provider-Neutral Interface) ────────────

export class CodeIntelligenceProvider {
  constructor(name, config) {
    this.name = name;
    this.config = config;
  }

  async health(repoPath) { throw new Error("Not implemented"); }
  async getArchitecture(options) { throw new Error("Not implemented"); }
  async searchCode(query, options) { throw new Error("Not implemented"); }
  async tracePath(request) { throw new Error("Not implemented"); }
  async detectChanges(request) { throw new Error("Not implemented"); }
  async impactAnalysis(request) { throw new Error("Not implemented"); }
  async checkCoverage(request) { throw new Error("Not implemented"); }
  async getSnippet(request) { throw new Error("Not implemented"); }
}

// ── Real MCP Code Intelligence Provider (codebase-memory-mcp) ────────────────

export class McpCodeIntelligenceProvider extends CodeIntelligenceProvider {
  constructor(name, config, runtime = {}) {
    super(name, config);
    this.runtime = runtime;
    this.client = null;
    const configuredRoots = Array.isArray(config?.authorizedRoots)
      ? config.authorizedRoots
      : [config?.repoPath, config?.worktreeRoot, config?.cwd].filter(Boolean);
    this.authorizedRoots = configuredRoots.length > 0 ? configuredRoots : [];
  }

  mcpEntry() {
    if (this.config.enabled === false || !Array.isArray(this.config.command)) return null;
    return {
      name: this.name,
      transport: this.config.transport || "stdio",
      command: this.config.command[0],
      args: this.config.command.slice(1)
    };
  }

  _getClient(projectPath) {
    if (this.client && this.client.initialized && this.client.toolDiscoveryComplete) return this.client;
    const cmd = Array.isArray(this.config.command) ? this.config.command : ["codebase-memory-mcp"];
    this.client = new McpStdioClient(cmd[0], cmd.slice(1), {
      cwd: projectPath || this.config.cwd || process.cwd(),
      timeoutMs: this.config.timeoutMs || 10000,
      maxBufferSize: this.config.maxBufferSize,
      env: this.config.env,
      runtime: this.runtime
    });
    return this.client;
  }

  _canonicalRepo(repoPath) {
    const roots = this.authorizedRoots.length > 0 ? this.authorizedRoots : [this.config.cwd || process.cwd()];
    const targetRepo = repoPath || roots[0];
    return validatePathWithinRoot(targetRepo, roots);
  }

  async health(repoPath = null) {
    if (this.config.enabled === false) {
      return {
        provider: this.name,
        configured: false,
        available: false,
        indexed: false,
        project: null,
        generation: null,
        lastIndexedAt: null,
        capabilities: [],
        warning: "Provider is disabled"
      };
    }

    if (!Array.isArray(this.config.command) || this.config.command.length === 0) {
      return {
        provider: this.name,
        configured: false,
        available: false,
        indexed: false,
        project: null,
        generation: null,
        lastIndexedAt: null,
        capabilities: [],
        warning: "Command is not configured"
      };
    }

    const canonicalRepo = this._canonicalRepo(repoPath);
    const client = this._getClient(canonicalRepo);

    try {
      await client.connect();
      if (!client.toolDiscoveryComplete) {
        return {
          provider: this.name,
          configured: true,
          available: false,
          indexed: false,
          project: null,
          generation: null,
          lastIndexedAt: null,
          capabilities: [],
          warning: "Provider tool discovery failed"
        };
      }

      const toolNames = Array.from(client.toolSchemas.keys());

      let statusResult = null;
      let projectName = path.basename(canonicalRepo);

      if (toolNames.includes("index_status")) {
        statusResult = await client.callTool("index_status", { repo_path: canonicalRepo, project: projectName });
      } else if (toolNames.includes("list_projects")) {
        statusResult = await client.callTool("list_projects", {});
      }

      let isIndexed = Boolean(
        statusResult?.is_indexed ||
        statusResult?.indexed ||
        statusResult?.status === "indexed" ||
        statusResult?.status === "ready"
      );

      if (!isIndexed && Array.isArray(statusResult?.projects)) {
        const match = statusResult.projects.find((p) => {
          if (typeof p === "string") return p === projectName;
          if (p && typeof p === "object") {
            return (p.name === projectName || (p.path && path.resolve(p.path) === canonicalRepo));
          }
          return false;
        });
        if (match) {
          isIndexed = true;
          projectName = typeof match === "string" ? match : (match.name || projectName);
        }
      }

      // Real Index Lifecycle: if unindexed and index_repository tool is available, index repository
      if (!isIndexed && toolNames.includes("index_repository")) {
        try {
          const indexRes = await client.callTool("index_repository", {
            repo_path: canonicalRepo,
            project: projectName
          });
          if (indexRes?.is_indexed || indexRes?.indexed || indexRes?.status === "indexed" || indexRes?.status === "ready" || indexRes?.project_name) {
            isIndexed = true;
            if (indexRes.project_name) projectName = indexRes.project_name;
          }
        } catch {
          // Indexing failure reports unindexed warning
        }
      }

      const generation = statusResult?.generation || statusResult?.index_version || statusResult?.indexVersion || null;
      const lastIndexedAt = statusResult?.last_indexed_at || statusResult?.lastIndexedAt || statusResult?.updated_at || statusResult?.updatedAt || null;

      return {
        provider: this.name,
        configured: true,
        available: true,
        indexed: isIndexed,
        project: projectName,
        generation,
        lastIndexedAt,
        capabilities: toolNames,
        warning: isIndexed ? null : "Repository is not yet indexed"
      };
    } catch (err) {
      return {
        provider: this.name,
        configured: true,
        available: false,
        indexed: false,
        project: null,
        generation: null,
        lastIndexedAt: null,
        capabilities: [],
        warning: `Provider unavailable: ${err.message}`
      };
    }
  }

  async getArchitecture(options = {}) {
    const canonicalRepo = this._canonicalRepo(options.repoPath);
    const client = this._getClient(canonicalRepo);
    await client.connect();
    const projectName = options.projectName || options.project;
    const raw = await client.callTool("get_architecture", {
      project: projectName,
      aspects: options.aspects || ["packages", "entry_points", "routes", "hotspots", "boundaries"]
    });

    if (!raw || typeof raw !== "object") {
      return {
        provider: this.name,
        project: projectName || null,
        generation: null,
        languages: [],
        packages: [],
        entryPoints: [],
        routes: [],
        hotspots: [],
        boundaries: [],
        clusters: [],
        evidence: []
      };
    }

    return {
      provider: this.name,
      project: raw.project_name || raw.project || projectName || null,
      generation: raw.generation || null,
      languages: Array.isArray(raw.languages) ? raw.languages : [],
      packages: Array.isArray(raw.packages) ? raw.packages : [],
      entryPoints: Array.isArray(raw.entry_points || raw.entryPoints) ? (raw.entry_points || raw.entryPoints) : [],
      routes: Array.isArray(raw.routes) ? raw.routes : [],
      hotspots: Array.isArray(raw.hotspots) ? raw.hotspots : [],
      boundaries: Array.isArray(raw.boundaries) ? raw.boundaries : [],
      clusters: Array.isArray(raw.clusters) ? raw.clusters : [],
      evidence: Array.isArray(raw.evidence) ? raw.evidence : []
    };
  }

  async searchCode(query, options = {}) {
    const canonicalRepo = this._canonicalRepo(options.repoPath);
    if (!query || typeof query !== "string" || !query.trim()) {
      return { query: query || "", matches: [], coverage: "unindexed" };
    }

    const client = this._getClient(canonicalRepo);
    await client.connect();
    const limit = Math.max(1, Math.min(Number(options.limit) || 10, 25));
    const projectName = options.projectName || options.project;

    const toolName = client.toolSchemas.has("semantic_query") && !client.toolSchemas.has("search_graph")
      ? "semantic_query"
      : "search_graph";

    const raw = await client.callTool(toolName, toolName === "semantic_query" ? {
      project: projectName,
      query: query.trim(),
      limit
    } : {
      project: projectName,
      name_pattern: query.trim(),
      limit
    });

    const items = Array.isArray(raw?.matches)
      ? raw.matches
      : (Array.isArray(raw?.results) ? raw.results : (Array.isArray(raw) ? raw : []));

    const matches = items.slice(0, limit).map((m) => {
      const symbol = m.symbol || m.name || m.symbol_name || m.identifier || null;
      const file = m.file_path || m.filePath || m.file || m.path || null;
      const line = Number(m.line || m.line_number || m.lineNumber || m.start_line || m.startLine || 1);
      return {
        symbol,
        kind: m.kind || m.label || m.type || "symbol",
        file,
        line,
        qualifiedName: m.qualified_name || m.qualifiedName || (file && symbol ? `${file}:${symbol}` : null),
        score: typeof m.score === "number" ? Number(m.score.toFixed(4)) : 1.0,
        evidence: typeof m.evidence === "string" ? m.evidence.slice(0, 300) : (m.snippet ? String(m.snippet).slice(0, 300) : null)
      };
    }).filter((m) => m.file || m.symbol);

    return {
      query,
      matches,
      coverage: raw?.coverage || (matches.length > 0 ? "covered" : "unindexed")
    };
  }

  async tracePath(request = {}) {
    const functionName = request.function_name || request.functionName || request.symbol || request.identifier;
    if (!functionName) throw new Error("Function name or symbol is required for tracePath");

    const canonicalRepo = this._canonicalRepo(request.repoPath);
    const client = this._getClient(canonicalRepo);
    await client.connect();
    const raw = await client.callTool("trace_path", {
      project: request.projectName || request.project,
      function_name: functionName,
      direction: request.direction || "both",
      depth: Math.min(Number(request.depth) || 2, 5)
    });

    const callers = Array.isArray(raw?.callers) ? raw.callers : [];
    const callees = Array.isArray(raw?.callees) ? raw.callees : [];
    const paths = Array.isArray(raw?.paths) ? raw.paths : [];

    return {
      symbol: functionName,
      direction: request.direction || "both",
      callers,
      callees,
      paths,
      coverage: raw?.coverage || "covered"
    };
  }

  async detectChanges(request = {}) {
    const canonicalRepo = this._canonicalRepo(request.repoPath);
    const client = this._getClient(canonicalRepo);
    await client.connect();
    const changedFiles = Array.isArray(request.files) ? request.files : (request.changedFiles || request.changed_files || []);
    const diff = request.diff || request.gitDiff || (changedFiles.length > 0 ? changedFiles.map((f) => `diff --git a/${f} b/${f}`).join("\n") : null);

    const raw = await client.callTool("detect_changes", {
      project: request.projectName || request.project,
      git_diff: diff,
      scope: request.scope || "all",
      changed_files: changedFiles
    });

    const finalChangedFiles = Array.isArray(raw?.changed_files || raw?.changedFiles) && (raw.changed_files || raw.changedFiles).length > 0
      ? (raw.changed_files || raw.changedFiles)
      : changedFiles;
    const affectedSymbols = Array.isArray(raw?.affected_symbols || raw?.affectedSymbols) ? (raw.affected_symbols || raw.affectedSymbols) : [];
    const callers = Array.isArray(raw?.callers) ? raw.callers : [];
    const dependents = Array.isArray(raw?.dependents) ? raw.dependents : [];

    let risk = raw?.risk || "normal";
    if (!["low", "normal", "high"].includes(risk)) risk = "normal";

    const reasons = Array.isArray(raw?.reasons) ? raw.reasons : [];

    return {
      changedFiles: finalChangedFiles,
      affectedSymbols,
      callers,
      dependents,
      risk,
      reasons,
      coverage: raw?.coverage || "covered"
    };
  }

  async impactAnalysis(request = {}) {
    return this.detectChanges(request);
  }

  async checkCoverage(request = {}) {
    const canonicalRepo = this._canonicalRepo(request.repoPath);
    const client = this._getClient(canonicalRepo);
    await client.connect();
    const files = Array.isArray(request.files) ? request.files : [];
    const raw = await client.callTool("check_index_coverage", {
      project: request.projectName || request.project,
      paths: files
    });

    const status = raw?.status || (raw?.coverage_ratio === 1 || raw?.coverageRatio === 1 ? "covered" : ((raw?.coverage_ratio || raw?.coverageRatio || 0) > 0 ? "partial" : "unindexed"));
    const checkedPaths = Array.isArray(raw?.checked_paths || raw?.checkedPaths) ? (raw.checked_paths || raw.checkedPaths) : files;
    const gaps = Array.isArray(raw?.gaps) ? raw.gaps : [];
    const coverageRatio = typeof (raw?.coverage_ratio ?? raw?.coverageRatio) === "number" ? (raw.coverage_ratio ?? raw.coverageRatio) : (status === "covered" ? 1.0 : (status === "partial" ? 0.5 : 0.0));
    const warnings = Array.isArray(raw?.warnings) ? raw.warnings : [];

    return {
      status,
      checkedPaths,
      gaps,
      coverageRatio,
      warnings
    };
  }

  async getSnippet(request = {}) {
    const canonicalRepo = this._canonicalRepo(request.repoPath);
    const targetFile = request.file || request.filePath || request.file_path;
    if (targetFile) {
      const resolvedFile = path.isAbsolute(targetFile)
        ? targetFile
        : path.resolve(canonicalRepo, targetFile);
      validatePathWithinRoot(resolvedFile, [canonicalRepo]);
    }

    const qualifiedName = request.qualified_name || request.qualifiedName || (
      request.file && request.symbol ? `${request.file}:${request.symbol}` : (request.file || request.filePath || request.file_path)
    );
    if (!qualifiedName) throw new Error("Qualified name or file path is required for getSnippet");

    const client = this._getClient(canonicalRepo);
    await client.connect();
    const raw = await client.callTool("get_code_snippet", {
      project: request.projectName || request.project,
      qualified_name: qualifiedName,
      file: request.file || request.filePath || request.file_path,
      symbol: request.symbol || request.symbolName
    });

    return {
      file: request.file || request.filePath || request.file_path || qualifiedName,
      startLine: Number(raw?.start_line || raw?.startLine || request.startLine || 1),
      endLine: Number(raw?.end_line || raw?.endLine || request.endLine || 50),
      content: typeof raw?.content === "string" ? raw.content : (typeof raw === "string" ? raw : ""),
      truncated: Boolean(raw?.truncated)
    };
  }

  close() {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }
}

// ── Real Graft Code Intelligence Provider (NanoNets/Graft) ──────────────────

export function parseGraftRepoMapText(text, defaultProject) {
  if (typeof text !== "string") {
    return {
      project: defaultProject,
      generation: null,
      languages: [],
      packages: [],
      entryPoints: [],
      routes: [],
      hotspots: [],
      boundaries: [],
      clusters: [],
      evidence: []
    };
  }

  const rawLines = text.split(/\r?\n/);
  const packages = new Set();
  const entryPoints = new Set();
  const routes = new Set();
  const hotspots = new Set();
  const languages = new Set();

  let currentDir = "";

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Route matching (e.g. GET /api/...)
    const routeMatch = line.match(/(GET|POST|PUT|DELETE|PATCH)\s+[\/\w:-]+/i);
    if (routeMatch) routes.add(routeMatch[0]);

    // Top-level directory header / item (e.g. - lib/ or lib:)
    const dirMatch = line.match(/^[#-*\s]*([\w.-]+)\/[:\s]*$/);
    if (dirMatch) {
      currentDir = dirMatch[1];
      packages.add(currentDir);
    }

    // Direct path match with slash (e.g. lib/runtime.js)
    const directFileMatches = line.matchAll(/([\w.-]+\/[\w./-]+\.(?:js|ts|mjs|cjs|py|go|rs|json))/g);
    for (const df of directFileMatches) {
      const p = df[1];
      const parts = p.split("/");
      if (parts[0]) packages.add(parts[0]);
      if (p.endsWith(".js") || p.endsWith(".ts") || p.endsWith(".mjs")) languages.add("JavaScript");
      if (p.endsWith(".py")) languages.add("Python");
      entryPoints.add(p);
      if (line.toLowerCase().includes("hub") || line.toLowerCase().includes("hotspot") || line.toLowerCase().includes("central")) {
        hotspots.add(p);
      }
    }

    // Nested file match (e.g. (runtime.js: ...) or - runtime.js)
    const nestedFileMatches = line.matchAll(/([\w.-]+\.(?:js|ts|mjs|cjs|py|go|rs))/g);
    for (const nf of nestedFileMatches) {
      const fn = nf[1];
      if (fn.includes("/")) continue;
      const fullPath = currentDir ? `${currentDir}/${fn}` : (line.includes("lib") ? `lib/${fn}` : fn);
      if (currentDir) packages.add(currentDir);
      if (fn.endsWith(".js") || fn.endsWith(".ts") || fn.endsWith(".mjs")) languages.add("JavaScript");
      if (fn.endsWith(".py")) languages.add("Python");
      entryPoints.add(fullPath);
      if (line.toLowerCase().includes("hub") || line.toLowerCase().includes("hotspot")) {
        hotspots.add(fullPath);
      }
    }

    // Generic directory parts
    const dirParts = line.matchAll(/([\w.-]+)\//g);
    for (const dp of dirParts) {
      if (dp[1] && !dp[1].includes(".")) packages.add(dp[1]);
    }
  }

  return {
    project: defaultProject,
    generation: null,
    languages: Array.from(languages),
    packages: Array.from(packages),
    entryPoints: Array.from(entryPoints),
    routes: Array.from(routes),
    hotspots: Array.from(hotspots.size > 0 ? hotspots : entryPoints),
    boundaries: [],
    clusters: [],
    evidence: rawLines.map((l) => l.trim()).filter(Boolean).slice(0, 15)
  };
}

export function parseGraftFindCodeText(text, query, limit = 10) {
  if (!text || typeof text !== "string") return [];
  const matches = [];
  const lines = text.split(/\r?\n/);
  let currentMatch = null;

  for (let i = 0; i < lines.length && matches.length < limit; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;
    if (/^graft\s+(ask|find)\s*—/i.test(line)) continue;

    // Format 1: Structural single line: "- <title>  <file>:Lx-Ly  (<relation>) — <snippet>"
    const structMatch = line.match(/^(?:-\s*)?([a-zA-Z0-9_$]+)\s+([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+):(?:L)?(\d+)(?:-L?(\d+))?(?:\s*\(([^)]+)\))?(?:\s*—\s*(.*))?$/);

    // Format 2: Title line of multi-line hit: "1. <title> · <kind>  [symbol]" or "1. <title> · <kind>" or "1. <title>"
    const titleMatch = line.match(/^(?:\d+\.\s*|-+\s*)([a-zA-Z0-9_$]+)(?:\s*·\s*([a-zA-Z0-9_$]+))?(?:\s*\[([^\]]+)\])?$/);

    // Format 3: Pointer line of multi-line hit: "<file>:L<start>-L<end>" or "<file>:<line>"
    const pointerMatch = line.match(/^([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+):(?:L)?(\d+)(?:-L?(\d+))?$/);

    // Format 4: Flat legacy: "1. lib/runtime.js:1120 `handleImplementation`" or "lib/runtime.js:1120: handleImplementation"
    const flatMatch = line.match(/^(?:\d+\.\s*)?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+):(?:L)?(\d+)(?:-L?(\d+))?(?::\s*|\s+`?([a-zA-Z0-9_$]+)`?)?(?:\s*\(score:\s*([\d.]+)\))?/);

    if (structMatch && structMatch[2].includes(".")) {
      if (currentMatch && (currentMatch.file || currentMatch.symbol)) {
        matches.push(currentMatch);
        if (matches.length >= limit) break;
      }
      const symbol = structMatch[1];
      const file = structMatch[2];
      const startLine = Number(structMatch[3]);
      currentMatch = {
        symbol: symbol || (query && query.match(/^[a-zA-Z0-9_$]+$/) ? query : null),
        kind: "symbol",
        file,
        line: startLine,
        qualifiedName: file && symbol ? `${file}:${symbol}` : `${file}:${startLine}`,
        score: 0.95,
        evidence: structMatch[6] || line
      };
    } else if (titleMatch && !line.includes(":") && !line.includes("/")) {
      if (currentMatch && (currentMatch.file || currentMatch.symbol)) {
        matches.push(currentMatch);
        if (matches.length >= limit) break;
      }
      const symbol = titleMatch[3] || titleMatch[1];
      const kind = titleMatch[2] || "symbol";
      currentMatch = {
        symbol: symbol || (query && query.match(/^[a-zA-Z0-9_$]+$/) ? query : null),
        kind,
        file: null,
        line: 1,
        qualifiedName: null,
        score: 0.95,
        evidence: line
      };
    } else if (pointerMatch && currentMatch && !currentMatch.file) {
      currentMatch.file = pointerMatch[1];
      currentMatch.line = Number(pointerMatch[2]);
      currentMatch.qualifiedName = currentMatch.symbol ? `${currentMatch.file}:${currentMatch.symbol}` : `${currentMatch.file}:${currentMatch.line}`;
    } else if (flatMatch && flatMatch[1].includes(".") && (flatMatch[4] || line.includes(":"))) {
      if (currentMatch && (currentMatch.file || currentMatch.symbol)) {
        matches.push(currentMatch);
        if (matches.length >= limit) break;
      }
      const file = flatMatch[1];
      const startLine = Number(flatMatch[2]);
      const symbol = flatMatch[4] || (query && query.match(/^[a-zA-Z0-9_$]+$/) ? query : null);
      currentMatch = {
        symbol,
        kind: "symbol",
        file,
        line: startLine,
        qualifiedName: file && symbol ? `${file}:${symbol}` : `${file}:${startLine}`,
        score: flatMatch[5] ? Number(flatMatch[5]) : 0.9,
        evidence: line
      };
    } else if (currentMatch) {
      if (!currentMatch.evidence || currentMatch.evidence.length < 300) {
        currentMatch.evidence = (currentMatch.evidence ? `${currentMatch.evidence}\n${line}` : line).slice(0, 300);
      }
    }
  }

  if (currentMatch && (currentMatch.file || currentMatch.symbol) && matches.length < limit) {
    matches.push(currentMatch);
  }

  return matches.filter((m) => m.file || m.symbol);
}

export function parseGraftTraceText(text, direction) {
  if (!text || typeof text !== "string") {
    return { callers: [], callees: [] };
  }

  const callers = [];
  const callees = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (line.includes("·") && !line.includes("←") && !line.includes("<-") && !line.includes("→") && !line.includes("->")) {
      continue;
    }

    const arrowMatch = line.match(/(?:([a-zA-Z0-9_$]+)\s*)?(←|<-|→|->)\s*([a-zA-Z0-9_$]+)(?:\s*\(([^:\s)]+):(?:L)?(\d+)(?:-L?(\d+))?\))?/);
    if (arrowMatch) {
      const relation = arrowMatch[1] || "calls";
      const arrow = arrowMatch[2];
      const sym = arrowMatch[3];
      const file = arrowMatch[4] || null;
      const lineNum = arrowMatch[5] ? Number(arrowMatch[5]) : null;

      if (arrow === "←" || arrow === "<-") {
        callers.push({ symbol: sym, file, line: lineNum, relation });
      } else if (arrow === "→" || arrow === "->") {
        callees.push({ symbol: sym, file, line: lineNum, relation });
      }
      continue;
    }

    const legacyMatch = line.match(/^([a-zA-Z0-9_$]+)(?:\s*\(([^:\s)]+):(?:L)?(\d+)?\))?/);
    if (legacyMatch && legacyMatch[1] && !["Inbound", "Outbound", "Calls", "Depth", "No"].includes(legacyMatch[1])) {
      const sym = legacyMatch[1];
      const file = legacyMatch[2] || null;
      const lineNum = legacyMatch[3] ? Number(legacyMatch[3]) : null;
      if (direction === "in") {
        callers.push({ symbol: sym, file, line: lineNum });
      } else if (direction === "out") {
        callees.push({ symbol: sym, file, line: lineNum });
      }
    }
  }

  return { callers, callees };
}

export function parseGraftFreshnessText(text) {
  if (typeof text !== "string") {
    return { isIndexed: false, isFresh: false, warning: "Graft freshness response was not text" };
  }

  const normalized = text.trim();
  const lower = normalized.toLowerCase();

  // 1. Fail-closed: NO GRAPH takes top precedence over anything else
  if (
    /graft\s+check:\s*no\s+graph/i.test(normalized) ||
    /graph\s+check:\s*no\s+graph/i.test(normalized) ||
    lower.includes("no graph") ||
    lower.includes("not indexed") ||
    lower.includes("unindexed") ||
    lower.includes("run graft index") ||
    lower.includes("run graft build") ||
    lower.includes("no .graft")
  ) {
    return { isIndexed: false, isFresh: false, warning: "Repository has no Graft graph or is not indexed" };
  }

  // 2. Fail-closed: STALE takes second precedence over any OK marker
  if (
    /graft\s+check:\s*stale/i.test(normalized) ||
    /graph\s+check:\s*stale/i.test(normalized) ||
    lower.includes("stale") ||
    lower.includes("out of sync")
  ) {
    return { isIndexed: true, isFresh: false, warning: "Graft graph is stale or out of sync with repository" };
  }

  // 3. OK only if explicit OK / in sync AND neither STALE nor NO GRAPH was present
  if (
    /graft\s+check:\s*ok/i.test(normalized) ||
    /graph\s+check:\s*ok/i.test(normalized) ||
    lower.includes("the graph is in sync with the code")
  ) {
    return { isIndexed: true, isFresh: true, warning: null };
  }

  // 4. Inconclusive unknown text marker - never default to ready/fresh
  return { isIndexed: false, isFresh: false, warning: `Graft freshness output could not be verified: ${normalized.slice(0, 100)}` };
}

export class GraftCodeIntelligenceProvider extends CodeIntelligenceProvider {
  constructor(name, config, runtime = {}) {
    super(name, config);
    this.runtime = runtime;
    const configuredRoots = Array.isArray(config?.authorizedRoots)
      ? config.authorizedRoots
      : [config?.repoPath, config?.worktreeRoot, config?.cwd].filter(Boolean);
    this.authorizedRoots = configuredRoots.length > 0 ? configuredRoots : [];
  }

  mcpEntry() {
    return null;
  }

  _canonicalRepo(repoPath) {
    const roots = this.authorizedRoots.length > 0 ? this.authorizedRoots : [this.config.cwd || process.cwd()];
    const targetRepo = repoPath || roots[0];
    return validatePathWithinRoot(targetRepo, roots);
  }

  async _execGraft(canonicalRepo, subcmd, args = []) {
    const rawCmd = Array.isArray(this.config.command) && this.config.command.length > 0
      ? this.config.command[0]
      : "graft";
    const fullArgs = [subcmd, ...args];
    const timeout = Number(this.config.timeoutMs) || 10000;
    const maxBuffer = Number(this.config.maxBufferSize) || 10 * 1024 * 1024;
    const env = buildSafeMcpEnv(this.config.env, canonicalRepo);

    if (this.runtime?.spawn) {
      return new Promise((resolve, reject) => {
        try {
          const child = this.runtime.spawn(rawCmd, fullArgs, {
            cwd: canonicalRepo,
            env
          });
          let stdout = "";
          let stderr = "";
          let killed = false;
          const timer = setTimeout(() => {
            killed = true;
            try { child.kill(); } catch {}
            reject(new Error(`Graft command '${subcmd}' timed out after ${timeout}ms`));
          }, timeout);

          child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
            if (stdout.length > maxBuffer) {
              killed = true;
              clearTimeout(timer);
              try { child.kill(); } catch {}
              reject(new Error(`Graft command '${subcmd}' exceeded maximum buffer size`));
            }
          });
          child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
          });
          child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (killed) return;
            if (code !== 0 && !stdout) {
              const err = new Error(stderr || `graft ${subcmd} exited with code ${code}`);
              err.code = code;
              return reject(err);
            }
            resolve(stdout || "");
          });
        } catch (err) {
          reject(err);
        }
      });
    }

    if (this.runtime?.spawnSync) {
      const res = this.runtime.spawnSync(rawCmd, fullArgs, {
        cwd: canonicalRepo,
        timeout,
        maxBuffer,
        env,
        encoding: "utf8"
      });
      if (res?.error) throw res.error;
      if (res?.status !== 0 && !res?.stdout) {
        const err = new Error(res?.stderr || `graft ${subcmd} exited with code ${res?.status}`);
        err.code = res?.status;
        throw err;
      }
      return typeof res?.stdout === "string" ? res.stdout : (res?.stdout ? res.stdout.toString("utf8") : "");
    }

    const res = spawnSync(rawCmd, fullArgs, {
      cwd: canonicalRepo,
      timeout,
      maxBuffer,
      env,
      encoding: "utf8"
    });
    if (res.error) throw res.error;
    if (res.status !== 0 && !res.stdout) {
      const err = new Error(res.stderr ? res.stderr.toString("utf8") : `graft ${subcmd} exited with code ${res.status}`);
      err.code = res.status;
      throw err;
    }
    return typeof res.stdout === "string" ? res.stdout : (res.stdout ? res.stdout.toString("utf8") : "");
  }

  async health(repoPath = null) {
    if (this.config.enabled === false) {
      return {
        provider: this.name,
        configured: false,
        available: false,
        indexed: false,
        project: null,
        generation: null,
        lastIndexedAt: null,
        capabilities: [],
        warning: "Provider is disabled"
      };
    }

    if (!Array.isArray(this.config.command) || this.config.command.length === 0) {
      return {
        provider: this.name,
        configured: false,
        available: false,
        indexed: false,
        project: null,
        generation: null,
        lastIndexedAt: null,
        capabilities: [],
        warning: "Command is not configured"
      };
    }

    const canonicalRepo = this._canonicalRepo(repoPath);

    try {
      const raw = await this._execGraft(canonicalRepo, "check", []);
      const parsed = parseGraftFreshnessText(raw);
      const projectName = path.basename(canonicalRepo);

      return {
        provider: this.name,
        configured: true,
        available: true,
        indexed: parsed.isIndexed,
        project: projectName,
        generation: null,
        lastIndexedAt: null,
        capabilities: ["map", "ask", "callers", "skeleton", "check", "grep"],
        warning: parsed.warning || (parsed.isIndexed ? null : "Repository has no Graft graph or is not indexed")
      };
    } catch (err) {
      return {
        provider: this.name,
        configured: true,
        available: false,
        indexed: false,
        project: null,
        generation: null,
        lastIndexedAt: null,
        capabilities: [],
        warning: `Provider unavailable: ${err.message}`
      };
    }
  }

  async getArchitecture(options = {}) {
    const canonicalRepo = this._canonicalRepo(options.repoPath);
    const projectName = options.projectName || options.project || path.basename(canonicalRepo);
    const args = options.maxDirs ? ["--max-dirs", String(options.maxDirs)] : [];
    const raw = await this._execGraft(canonicalRepo, "map", args);
    const parsed = parseGraftRepoMapText(raw, projectName);
    return { ...parsed, provider: this.name };
  }

  async searchCode(query, options = {}) {
    const canonicalRepo = this._canonicalRepo(options.repoPath);
    if (!query || typeof query !== "string" || !query.trim()) {
      return { query: query || "", matches: [], coverage: "unknown" };
    }

    const limit = Math.max(1, Math.min(Number(options.limit) || 10, 25));
    let matches = [];

    try {
      const raw = await this._execGraft(canonicalRepo, "ask", [query.trim()]);
      matches = parseGraftFindCodeText(raw, query.trim(), limit);
    } catch {}

    if (matches.length === 0) {
      try {
        const rawAll = await this._execGraft(canonicalRepo, "grep", [query.trim()]);
        matches = parseGraftFindCodeText(rawAll, query.trim(), limit);
      } catch {}
    }

    return {
      query,
      matches,
      coverage: matches.length > 0 ? "covered" : "unknown"
    };
  }

  async tracePath(request = {}) {
    const symbol = request.symbol || request.function_name || request.functionName || request.identifier;
    if (!symbol) throw new Error("Function name or symbol is required for tracePath");

    const canonicalRepo = this._canonicalRepo(request.repoPath);
    const depth = Math.min(Number(request.depth) || 2, 5);
    const direction = request.direction || "both";
    let callers = [];
    let callees = [];

    if (direction === "both" || direction === "in") {
      try {
        const inRaw = await this._execGraft(canonicalRepo, "callers", [symbol, "--in", "--depth", String(depth)]);
        const parsed = parseGraftTraceText(inRaw, "in");
        callers = parsed.callers;
      } catch {}
    }

    if (direction === "both" || direction === "out") {
      try {
        const outRaw = await this._execGraft(canonicalRepo, "callers", [symbol, "--out", "--depth", String(depth)]);
        const parsed = parseGraftTraceText(outRaw, "out");
        callees = parsed.callees;
      } catch {}
    }

    const paths = callers.map((c) => [c.symbol, symbol]).concat(callees.map((c) => [symbol, c.symbol]));
    if (callers.length > 0 && callees.length > 0) {
      paths.push([callers[0].symbol, symbol, callees[0].symbol]);
    }

    return {
      symbol,
      direction,
      callers,
      callees,
      paths,
      coverage: (callers.length > 0 || callees.length > 0) ? "covered" : "unknown"
    };
  }

  async detectChanges(request = {}) {
    const canonicalRepo = this._canonicalRepo(request.repoPath);
    const changedFiles = Array.isArray(request.files) ? request.files : (request.changedFiles || request.changed_files || []);
    const boundedFiles = changedFiles.slice(0, 3);
    const callers = [];
    const dependents = [];
    const affectedSymbols = [];
    const reasons = [];
    const fileTraceResults = [];

    let graphIsFresh = false;

    try {
      const freshRaw = await this._execGraft(canonicalRepo, "check", []);
      const freshParsed = parseGraftFreshnessText(freshRaw);
      graphIsFresh = Boolean(freshParsed.isFresh);
    } catch {}

    if (boundedFiles.length === 0) {
      return {
        changedFiles: [],
        affectedSymbols: [],
        callers: [],
        dependents: [],
        risk: "low",
        reasons: ["No changed files specified"],
        coverage: graphIsFresh ? "covered" : "unknown"
      };
    }

    for (const file of boundedFiles) {
      try {
        const traceRaw = await this._execGraft(canonicalRepo, "callers", [file, "--in", "--depth", "2"]);
        const parsed = parseGraftTraceText(traceRaw, "in");
        const fileCallers = Array.isArray(parsed?.callers) ? parsed.callers : [];
        if (fileCallers.length > 0) {
          fileTraceResults.push("success_with_edges");
          for (const c of fileCallers) {
            if (!callers.includes(c.symbol)) callers.push(c.symbol);
            if (c.file && !dependents.includes(c.file)) dependents.push(c.file);
          }
        } else {
          fileTraceResults.push("success_zero_edges");
        }
      } catch {
        fileTraceResults.push("failed");
      }
    }

    const allSucceeded = fileTraceResults.length === boundedFiles.length && fileTraceResults.every((r) => r !== "failed");
    const anySuccessWithEdges = fileTraceResults.some((r) => r === "success_with_edges");

    let risk = "unknown";
    let coverage = "unknown";

    if (callers.length > 5) {
      risk = "high";
      coverage = allSucceeded && graphIsFresh ? "covered" : "partial";
      reasons.push(`Discovered ${callers.length} inbound caller(s) through Graft call graph`);
    } else if (callers.length > 0) {
      risk = "normal";
      coverage = allSucceeded && graphIsFresh ? "covered" : "partial";
      reasons.push(`Discovered ${callers.length} inbound caller(s) through Graft call graph`);
    } else if (allSucceeded && graphIsFresh) {
      risk = "low";
      coverage = "covered";
      reasons.push("No indexed inbound callers found in the fresh covered Graft graph");
    } else {
      risk = "unknown";
      coverage = anySuccessWithEdges || (fileTraceResults.some((r) => r === "success_zero_edges") && !allSucceeded) ? "partial" : "unknown";
      reasons.push("Impact analysis inconclusive: Graft call graph evidence unavailable or graph not in sync");
    }

    return {
      changedFiles,
      affectedSymbols,
      callers,
      dependents,
      risk,
      reasons,
      coverage
    };
  }

  async impactAnalysis(request = {}) {
    return this.detectChanges(request);
  }

  async checkCoverage(request = {}) {
    const canonicalRepo = this._canonicalRepo(request.repoPath);
    const files = Array.isArray(request.files) ? request.files : [];

    try {
      const raw = await this._execGraft(canonicalRepo, "check", []);
      const parsed = parseGraftFreshnessText(raw);

      if (parsed.isIndexed && parsed.isFresh) {
        return {
          status: "covered",
          checkedPaths: files,
          gaps: [],
          coverageRatio: 1.0,
          warnings: []
        };
      }

      if (parsed.isIndexed && !parsed.isFresh) {
        return {
          status: "partial",
          checkedPaths: files,
          gaps: files,
          coverageRatio: 0.5,
          warnings: [parsed.warning || "Graft graph is stale or out of sync"]
        };
      }

      return {
        status: "unknown",
        checkedPaths: files,
        gaps: files,
        coverageRatio: 0.0,
        warnings: [parsed.warning || "Repository has no Graft graph or is not indexed"]
      };
    } catch (err) {
      return {
        status: "unknown",
        checkedPaths: files,
        gaps: files,
        coverageRatio: 0.0,
        warnings: [`Graft check failed: ${err.message}`]
      };
    }
  }

  async getSnippet(request = {}) {
    const canonicalRepo = this._canonicalRepo(request.repoPath);
    const targetFile = request.file || request.filePath || request.file_path;
    if (!targetFile) throw new Error("File path is required for getSnippet");

    const resolvedFile = path.isAbsolute(targetFile)
      ? targetFile
      : path.resolve(canonicalRepo, targetFile);
    validatePathWithinRoot(resolvedFile, [canonicalRepo]);

    const relFile = path.relative(canonicalRepo, resolvedFile).replace(/\\/g, "/");
    const content = await this._execGraft(canonicalRepo, "skeleton", [relFile]);
    const lines = content.split("\n");

    return {
      file: relFile,
      startLine: 1,
      endLine: Math.max(1, lines.length),
      content,
      truncated: false
    };
  }

  close() {
    if (this.clients) {
      for (const client of this.clients.values()) {
        try {
          client.close();
        } catch {}
      }
      this.clients.clear();
    }
  }
}

// ── Registry & Factory ──────────────────────────────────────────────────────

export function configuredCodeIntelligenceProviders(settings) {
  return settings?.data?.codeIntelligence?.providers || {};
}

export function selectedCodeIntelligenceProviderName(settings) {
  const providers = configuredCodeIntelligenceProviders(settings);
  return settings?.data?.codeIntelligence?.defaultProvider || Object.keys(providers)[0] || null;
}

export function createCodeIntelligenceProvider(settings, runtime = {}) {
  const selected = selectedCodeIntelligenceProviderName(settings);
  if (!selected) return null;
  const config = configuredCodeIntelligenceProviders(settings)[selected];
  if (!config) throw new Error(`Unknown code intelligence provider: ${selected}`);

  const providerType = config.type || selected;

  const authorizedRoots = [
    settings?.repoPath,
    settings?.worktreeRoot,
    config?.cwd
  ].filter(Boolean);

  const mergedConfig = {
    ...config,
    authorizedRoots: config.authorizedRoots || (authorizedRoots.length > 0 ? authorizedRoots : [process.cwd()])
  };

  if (["graft", "graft-mcp"].includes(providerType)) {
    return new GraftCodeIntelligenceProvider(selected, mergedConfig, runtime);
  }

  if (["mcp", "codebase-memory-mcp", "codebase-memory"].includes(providerType)) {
    return new McpCodeIntelligenceProvider(selected, mergedConfig, runtime);
  }

  throw new Error(`Unsupported code intelligence provider type: ${config.type}`);
}

export function describeCodeIntelligenceProviders(settings) {
  const selected = selectedCodeIntelligenceProviderName(settings);
  return Object.entries(configuredCodeIntelligenceProviders(settings)).map(([name, config]) => ({
    id: name,
    type: config.type || name,
    selected: name === selected,
    enabled: config.enabled !== false,
    transport: config.transport || "stdio",
    commandConfigured: Array.isArray(config.command) && config.command.length > 0,
    readOnly: config.readOnly !== false,
    capabilities: Array.isArray(config.capabilities) ? config.capabilities : []
  }));
}

export function codeIntelligenceMcpEntry(settings) {
  return createCodeIntelligenceProvider(settings)?.mcpEntry() || null;
}

// ── Control Plane Context Collection ────────────────────────────────────────

/**
 * Collects bounded, task-directed code intelligence context for orchestrator planning
 * and implementation agent context.
 */
export async function collectCodeIntelligenceContext(settings, issue, options = {}) {
  const provider = createCodeIntelligenceProvider(settings, options.runtime);
  const now = options.now || new Date().toISOString();

  if (!provider || provider.config.enabled === false) {
    return {
      provider: provider?.name || "none",
      project: null,
      generation: null,
      status: "disabled",
      collectedAt: now,
      architecture: null,
      search: { symbols: [], files: [] },
      impact: null,
      coverage: { status: "unindexed", checkedPaths: [], gaps: [] },
      warnings: ["Code intelligence provider is disabled"]
    };
  }

  const repoPath = settings.repoPath || process.cwd();
  let health;
  try {
    health = await provider.health(repoPath);
  } catch (err) {
    health = { available: false, warning: err.message };
  }

  if (!health.available) {
    return {
      provider: provider.name,
      project: null,
      generation: null,
      status: "unavailable",
      collectedAt: now,
      architecture: null,
      search: { symbols: [], files: [] },
      impact: null,
      coverage: { status: "unindexed", checkedPaths: [], gaps: [] },
      warnings: [health.warning || "Provider is unavailable"]
    };
  }

  const project = health.project || path.basename(repoPath);
  const generation = health.generation || null;

  // 1. Architecture discovery
  let architecture = null;
  try {
    const arch = await provider.getArchitecture({ project, repoPath, scope: "summary" });
    architecture = {
      relevantPackages: (arch.packages || []).slice(0, 10),
      relevantEntryPoints: (arch.entryPoints || []).slice(0, 10),
      routes: (arch.routes || []).slice(0, 10)
    };
  } catch {}

  // 2. Keyword/Semantic Search from Issue summary & description
  const queryTerms = [
    issue.summary,
    issue.key,
    ...(Array.isArray(issue.labels) ? issue.labels.filter((l) => l !== "agent-ready") : [])
  ].filter(Boolean).join(" ");

  let searchResults = { symbols: [], files: [] };
  if (queryTerms.trim()) {
    try {
      const search = await provider.searchCode(queryTerms, { project, repoPath, limit: 10 });
      const symbols = [...new Set((search.matches || []).map((m) => m.symbol).filter(Boolean))].slice(0, 10);
      const files = [...new Set((search.matches || []).map((m) => m.file).filter(Boolean))].slice(0, 10);
      searchResults = { symbols, files };
    } catch {}
  }

  // 3. Index Coverage
  let coverage = { status: health.indexed ? "covered" : "unindexed", checkedPaths: searchResults.files, gaps: [] };
  if (searchResults.files.length > 0) {
    try {
      const cov = await provider.checkCoverage({ project, repoPath, files: searchResults.files });
      coverage = {
        status: cov.status,
        checkedPaths: cov.checkedPaths,
        gaps: cov.gaps
      };
    } catch {}
  }

  // 4. Initial Impact analysis if specific files were found
  let impact = null;
  if (searchResults.files.length > 0) {
    try {
      const imp = await provider.impactAnalysis({ project, repoPath, files: searchResults.files });
      impact = {
        likelyAffectedFiles: (imp.changedFiles || []).slice(0, 10),
        affectedSymbols: (imp.affectedSymbols || []).slice(0, 10),
        blastRadius: imp.risk || "normal",
        risk: imp.risk || "normal"
      };
    } catch {}
  }

  const warnings = [];
  if (coverage.status === "partial") {
    warnings.push("Graph index coverage is partial; verify skipped files directly");
  } else if (coverage.status === "unindexed") {
    warnings.push("Repository is unindexed; code intelligence claims are unverified");
  }

  return {
    provider: provider.name,
    project,
    generation,
    status: health.indexed ? "ready" : "not_indexed",
    collectedAt: now,
    architecture,
    search: searchResults,
    impact,
    coverage,
    warnings
  };
}

/**
 * Collects review intelligence against an implementation diff/changed files.
 */
export async function collectReviewIntelligence(settings, issue, changedFiles = [], options = {}) {
  const provider = createCodeIntelligenceProvider(settings, options.runtime);
  const now = options.now || new Date().toISOString();

  if (!provider || provider.config.enabled === false) {
    return {
      provider: provider?.name || "none",
      status: "disabled",
      collectedAt: now,
      changedFiles: Array.isArray(changedFiles) ? changedFiles : [],
      affectedSymbols: [],
      callers: [],
      dependents: [],
      blastRadius: "unknown",
      coverage: "unindexed",
      warnings: ["Code intelligence provider is disabled"]
    };
  }

  const repoPath = settings.repoPath || process.cwd();
  try {
    const health = await provider.health(repoPath);
    if (!health.available) {
      return {
        provider: provider.name,
        status: "unavailable",
        collectedAt: now,
        changedFiles,
        affectedSymbols: [],
        callers: [],
        dependents: [],
        blastRadius: "unknown",
        coverage: "unindexed",
        warnings: [health.warning || "Provider unavailable"]
      };
    }

    const project = health.project || path.basename(repoPath);
    const impact = await provider.impactAnalysis({ project, repoPath, files: changedFiles });

    return {
      provider: provider.name,
      project,
      generation: health.generation,
      status: "ready",
      collectedAt: now,
      changedFiles: impact.changedFiles || changedFiles,
      affectedSymbols: (impact.affectedSymbols || []).slice(0, 15),
      callers: (impact.callers || []).slice(0, 15),
      dependents: (impact.dependents || []).slice(0, 15),
      blastRadius: impact.risk || "normal",
      coverage: impact.coverage || "covered",
      warnings: []
    };
  } catch (err) {
    return {
      provider: provider.name,
      status: "degraded",
      collectedAt: now,
      changedFiles,
      affectedSymbols: [],
      callers: [],
      dependents: [],
      blastRadius: "unknown",
      coverage: "unindexed",
      warnings: [err.message]
    };
  }
}

// ── Prompt Formatting ───────────────────────────────────────────────────────

/**
 * Formats a bounded code intelligence section for worker prompts.
 */
export function formatCodeIntelligencePromptSection(context, title = "CODE INTELLIGENCE CONTEXT") {
  if (!context || context.status === "disabled" || context.status === "unavailable") {
    return "";
  }

  const lines = [
    `### ${title}`,
    `- Provider: ${context.provider || "codebase-memory"}${context.generation ? ` (gen: ${context.generation})` : ""}`,
    `- Coverage status: ${context.coverage?.status || context.coverage || "covered"}`
  ];

  if (context.changedFiles?.length > 0) {
    lines.push(`- Changed files: ${context.changedFiles.join(", ")}`);
  }

  if (context.architecture?.relevantPackages?.length > 0) {
    lines.push(`- Relevant packages: ${context.architecture.relevantPackages.join(", ")}`);
  }

  if (context.search?.files?.length > 0) {
    lines.push(`- Relevant files: ${context.search.files.join(", ")}`);
  }

  if (context.search?.symbols?.length > 0) {
    lines.push(`- Relevant symbols: ${context.search.symbols.join(", ")}`);
  }

  if (context.affectedSymbols?.length > 0) {
    lines.push(`- Affected symbols: ${context.affectedSymbols.join(", ")}`);
  }

  if (context.callers?.length > 0) {
    const callerNames = context.callers.map((c) => (typeof c === "string" ? c : c.symbol || c.name || c.function_name)).filter(Boolean);
    if (callerNames.length > 0) lines.push(`- Direct callers: ${callerNames.join(", ")}`);
  }

  if (context.dependents?.length > 0) {
    lines.push(`- Downstream dependents: ${context.dependents.join(", ")}`);
  }

  if (context.impact?.blastRadius || context.blastRadius) {
    lines.push(`- Likely blast radius: ${context.impact?.blastRadius || context.blastRadius}`);
  }

  if (context.warnings?.length > 0) {
    lines.push(`- Warnings: ${context.warnings.join("; ")}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Formats a bounded review intelligence section for reviewer prompts.
 */
export function formatReviewIntelligencePromptSection(reviewContext) {
  return formatCodeIntelligencePromptSection(reviewContext, "REVIEW INTELLIGENCE");
}
