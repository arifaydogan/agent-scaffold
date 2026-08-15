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
import { spawn as defaultSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

// ── Path Safety ─────────────────────────────────────────────────────────────

/**
 * Validates that a target path resides within an allowed repository or worktree root.
 * Throws an Error if path escapes the allowed boundary.
 */
export function validatePathWithinRoot(targetPath, allowedRoots = []) {
  if (!targetPath || typeof targetPath !== "string") {
    throw new Error("Invalid target path");
  }
  const resolvedTarget = path.resolve(targetPath);
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots]).filter(Boolean);

  if (roots.length === 0) {
    return resolvedTarget;
  }

  const isContained = roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const rel = path.relative(resolvedRoot, resolvedTarget);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });

  if (!isContained) {
    throw new Error(`Path '${targetPath}' is outside the authorized roots: ${roots.join(", ")}`);
  }

  return resolvedTarget;
}

// ── Lightweight MCP stdio Client ────────────────────────────────────────────

export class McpStdioClient {
  constructor(command, args = [], options = {}) {
    this.command = command;
    this.args = args;
    this.options = options;
    this.spawnFn = options.runtime?.spawn || defaultSpawn;
    this.timeoutMs = options.timeoutMs || 10000;
    this.child = null;
    this.seq = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.initialized = false;
    this.capabilities = [];
  }

  async connect() {
    if (this.child) return;

    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.child = this.spawnFn(this.command, this.args, {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: this.options.cwd || process.cwd(),
          env: { ...process.env, ...(this.options.env || {}) }
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

      this.child.stderr.on("data", (chunk) => {
        // Human progress or logs retained in debug
      });

      // Execute MCP initialize handshake
      this._request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-scaffold", version: "1.0.0" }
      })
        .then((initResult) => {
          this.initialized = true;
          // Send initialized notification
          this._notify("notifications/initialized", {});
          settled = true;
          resolve(initResult);
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
    this.stdoutBuffer += chunk.toString("utf8");
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop(); // Keep unfinished line in buffer

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
        // Ignore non-JSON lines or commentary
      }
    }
  }

  _request(method, params = {}) {
    if (!this.child || !this.child.stdin.writable) {
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
    if (!this.child || !this.child.stdin.writable) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    try {
      this.child.stdin.write(payload);
    } catch {}
  }

  async listTools() {
    const res = await this._request("tools/list", {});
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(name, args = {}) {
    const res = await this._request("tools/call", { name, arguments: args });
    // MCP tool calls return { content: [ { type: "text", text: "..." } ] }
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

// ── Base Code Intelligence Provider ─────────────────────────────────────────

export class CodeIntelligenceProvider {
  constructor(name, config) {
    this.name = name;
    this.config = config;
  }

  async health() { throw new Error("Not implemented"); }
  async getArchitecture(scope) { throw new Error("Not implemented"); }
  async searchCode(query, options) { throw new Error("Not implemented"); }
  async tracePath(request) { throw new Error("Not implemented"); }
  async detectChanges(request) { throw new Error("Not implemented"); }
  async impactAnalysis(request) { throw new Error("Not implemented"); }
  async checkCoverage(request) { throw new Error("Not implemented"); }
  async getSnippet(request) { throw new Error("Not implemented"); }
}

// ── MCP Code Intelligence Provider (codebase-memory-mcp) ─────────────────────

export class McpCodeIntelligenceProvider extends CodeIntelligenceProvider {
  constructor(name, config, runtime = {}) {
    super(name, config);
    this.runtime = runtime;
    this.client = null;
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
    if (this.client && this.client.initialized) return this.client;
    const cmd = Array.isArray(this.config.command) ? this.config.command : ["codebase-memory-mcp"];
    this.client = new McpStdioClient(cmd[0], cmd.slice(1), {
      cwd: projectPath || this.config.cwd || process.cwd(),
      timeoutMs: this.config.timeoutMs || 10000,
      runtime: this.runtime
    });
    return this.client;
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

    const client = this._getClient(repoPath);
    try {
      await client.connect();
      const tools = await client.listTools();
      const toolNames = tools.map((t) => t.name);

      let statusResult = null;
      if (toolNames.includes("index_status")) {
        statusResult = await client.callTool("index_status", { path: repoPath });
      } else if (toolNames.includes("list_projects")) {
        statusResult = await client.callTool("list_projects", {});
      }

      const isIndexed = Boolean(
        statusResult?.indexed ||
        statusResult?.status === "indexed" ||
        statusResult?.status === "ready" ||
        (Array.isArray(statusResult?.projects) && statusResult.projects.length > 0)
      );

      const project = statusResult?.project || statusResult?.projectName || (repoPath ? path.basename(repoPath) : null);
      const generation = statusResult?.generation || statusResult?.indexVersion || null;
      const lastIndexedAt = statusResult?.lastIndexedAt || statusResult?.updatedAt || null;

      return {
        provider: this.name,
        configured: true,
        available: true,
        indexed: isIndexed,
        project,
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
    const client = this._getClient(options.repoPath);
    await client.connect();
    const raw = await client.callTool("get_architecture", {
      project: options.project,
      scope: options.scope || "all"
    });

    if (!raw || typeof raw !== "object") {
      return {
        provider: this.name,
        project: options.project || null,
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
      project: raw.project || options.project || null,
      generation: raw.generation || null,
      languages: Array.isArray(raw.languages) ? raw.languages : [],
      packages: Array.isArray(raw.packages) ? raw.packages : [],
      entryPoints: Array.isArray(raw.entryPoints || raw.entry_points) ? (raw.entryPoints || raw.entry_points) : [],
      routes: Array.isArray(raw.routes) ? raw.routes : [],
      hotspots: Array.isArray(raw.hotspots) ? raw.hotspots : [],
      boundaries: Array.isArray(raw.boundaries) ? raw.boundaries : [],
      clusters: Array.isArray(raw.clusters) ? raw.clusters : [],
      evidence: Array.isArray(raw.evidence) ? raw.evidence : []
    };
  }

  async searchCode(query, options = {}) {
    if (!query || typeof query !== "string" || !query.trim()) {
      return { query: query || "", matches: [], coverage: "unindexed" };
    }

    const client = this._getClient(options.repoPath);
    await client.connect();
    const limit = Math.max(1, Math.min(Number(options.limit) || 10, 25));

    let raw;
    try {
      raw = await client.callTool("semantic_query", {
        project: options.project,
        query: query.trim(),
        limit
      });
    } catch {
      raw = await client.callTool("search_graph", {
        project: options.project,
        query: query.trim(),
        limit
      });
    }

    const items = Array.isArray(raw?.matches)
      ? raw.matches
      : (Array.isArray(raw?.results) ? raw.results : (Array.isArray(raw) ? raw : []));

    const matches = items.slice(0, limit).map((m) => ({
      symbol: m.symbol || m.name || m.identifier || null,
      kind: m.kind || m.type || "symbol",
      file: m.file || m.path || m.filePath || null,
      line: Number(m.line || m.lineNumber || m.startLine || 1),
      qualifiedName: m.qualifiedName || m.qualified_name || (m.file && m.symbol ? `${m.file}:${m.symbol}` : null),
      score: typeof m.score === "number" ? Number(m.score.toFixed(4)) : 1.0,
      evidence: typeof m.evidence === "string" ? m.evidence.slice(0, 300) : (m.snippet ? String(m.snippet).slice(0, 300) : null)
    })).filter((m) => m.file || m.symbol);

    return {
      query,
      matches,
      coverage: raw?.coverage || (matches.length > 0 ? "covered" : "unindexed")
    };
  }

  async tracePath(request = {}) {
    const symbol = request.symbol || request.identifier;
    if (!symbol) throw new Error("Symbol is required for tracePath");

    const client = this._getClient(request.repoPath);
    await client.connect();
    const raw = await client.callTool("trace_path", {
      project: request.project,
      symbol,
      direction: request.direction || "both",
      depth: Math.min(Number(request.depth) || 2, 5)
    });

    const callers = Array.isArray(raw?.callers) ? raw.callers : [];
    const callees = Array.isArray(raw?.callees) ? raw.callees : [];
    const paths = Array.isArray(raw?.paths) ? raw.paths : [];

    return {
      symbol,
      direction: request.direction || "both",
      callers,
      callees,
      paths,
      coverage: raw?.coverage || "covered"
    };
  }

  async detectChanges(request = {}) {
    const client = this._getClient(request.repoPath);
    await client.connect();
    const raw = await client.callTool("detect_changes", {
      project: request.project,
      files: Array.isArray(request.files) ? request.files : [],
      diff: request.diff || null
    });

    const changedFiles = Array.isArray(raw?.changedFiles || raw?.changed_files) ? (raw.changedFiles || raw.changed_files) : (request.files || []);
    const affectedSymbols = Array.isArray(raw?.affectedSymbols || raw?.affected_symbols) ? (raw.affectedSymbols || raw.affected_symbols) : [];
    const callers = Array.isArray(raw?.callers) ? raw.callers : [];
    const dependents = Array.isArray(raw?.dependents) ? raw.dependents : [];

    let risk = raw?.risk || "normal";
    if (!["low", "normal", "high"].includes(risk)) risk = "normal";

    const reasons = Array.isArray(raw?.reasons) ? raw.reasons : [];

    return {
      changedFiles,
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
    const client = this._getClient(request.repoPath);
    await client.connect();
    const files = Array.isArray(request.files) ? request.files : [];
    const raw = await client.callTool("check_index_coverage", {
      project: request.project,
      files
    });

    const status = raw?.status || (raw?.coverageRatio === 1 ? "covered" : (raw?.coverageRatio > 0 ? "partial" : "unindexed"));
    const checkedPaths = Array.isArray(raw?.checkedPaths || raw?.checked_paths) ? (raw.checkedPaths || raw.checked_paths) : files;
    const gaps = Array.isArray(raw?.gaps) ? raw.gaps : [];
    const coverageRatio = typeof raw?.coverageRatio === "number" ? raw.coverageRatio : (status === "covered" ? 1.0 : (status === "partial" ? 0.5 : 0.0));
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
    const file = request.file || request.path;
    if (!file) throw new Error("File path is required for getSnippet");

    const client = this._getClient(request.repoPath);
    await client.connect();
    const raw = await client.callTool("get_code_snippet", {
      project: request.project,
      file,
      start_line: Number(request.startLine || 1),
      end_line: Number(request.endLine || 50)
    });

    return {
      file,
      startLine: Number(raw?.startLine || raw?.start_line || request.startLine || 1),
      endLine: Number(raw?.endLine || raw?.end_line || request.endLine || 50),
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
  if (!["mcp", "codebase-memory-mcp"].includes(config.type || "mcp")) {
    throw new Error(`Unsupported code intelligence provider type: ${config.type}`);
  }
  return new McpCodeIntelligenceProvider(selected, config, runtime);
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
      relevantRoutes: (arch.routes || []).slice(0, 10)
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
export function formatCodeIntelligencePromptSection(context) {
  if (!context || context.status === "disabled" || context.status === "unavailable") {
    return "";
  }

  const lines = [
    "### CODE INTELLIGENCE CONTEXT",
    `- Provider: ${context.provider || "codebase-memory"}${context.generation ? ` (gen: ${context.generation})` : ""}`,
    `- Coverage status: ${context.coverage?.status || "covered"}`
  ];

  if (context.architecture?.relevantPackages?.length > 0) {
    lines.push(`- Relevant packages: ${context.architecture.relevantPackages.join(", ")}`);
  }

  if (context.search?.files?.length > 0) {
    lines.push(`- Relevant files: ${context.search.files.join(", ")}`);
  }

  if (context.search?.symbols?.length > 0) {
    lines.push(`- Relevant symbols: ${context.search.symbols.join(", ")}`);
  }

  if (context.impact?.blastRadius) {
    lines.push(`- Likely blast radius: ${context.impact.blastRadius}`);
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
  if (!reviewContext || reviewContext.status === "disabled" || reviewContext.status === "unavailable") {
    return "";
  }

  const lines = [
    "### REVIEW INTELLIGENCE",
    `- Provider: ${reviewContext.provider || "codebase-memory"}${reviewContext.generation ? ` (gen: ${reviewContext.generation})` : ""}`,
    `- Coverage: ${reviewContext.coverage || "covered"}`
  ];

  if (reviewContext.changedFiles?.length > 0) {
    lines.push(`- Changed files: ${reviewContext.changedFiles.join(", ")}`);
  }

  if (reviewContext.affectedSymbols?.length > 0) {
    lines.push(`- Affected symbols: ${reviewContext.affectedSymbols.join(", ")}`);
  }

  if (reviewContext.callers?.length > 0) {
    const callerNames = reviewContext.callers.map((c) => (typeof c === "string" ? c : c.symbol || c.name)).filter(Boolean);
    if (callerNames.length > 0) lines.push(`- Direct callers: ${callerNames.join(", ")}`);
  }

  if (reviewContext.dependents?.length > 0) {
    lines.push(`- Downstream dependents: ${reviewContext.dependents.join(", ")}`);
  }

  if (reviewContext.blastRadius) {
    lines.push(`- Estimated blast radius: ${reviewContext.blastRadius}`);
  }

  if (reviewContext.warnings?.length > 0) {
    lines.push(`- Warnings: ${reviewContext.warnings.join("; ")}`);
  }

  lines.push("");
  return lines.join("\n");
}
