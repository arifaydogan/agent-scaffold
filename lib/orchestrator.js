import child_process from "node:child_process";
import { routeIssue } from "./routing.js";

// ── 1. Typed Orchestrator Errors ─────────────────────────────────────────────

export class OrchestratorError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "OrchestratorError";
    this.provider = options.provider || null;
    this.cause = options.cause || null;
  }
}

export class OrchestratorUnavailableError extends OrchestratorError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "OrchestratorUnavailableError";
  }
}

export class OrchestratorTimeoutError extends OrchestratorError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "OrchestratorTimeoutError";
  }
}

export class OrchestratorProcessError extends OrchestratorError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "OrchestratorProcessError";
    this.exitCode = options.exitCode ?? 1;
    this.stderr = options.stderr || "";
  }
}

export class OrchestratorParseError extends OrchestratorError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "OrchestratorParseError";
    this.rawOutput = options.rawOutput || "";
  }
}

export class OrchestratorValidationError extends OrchestratorError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "OrchestratorValidationError";
    this.validationErrors = options.validationErrors || [];
  }
}

// ── 2. Structured Orchestrator Plan Schema Validator ──────────────────────────

export function validateOrchestratorPlan(rawPlan, context = {}) {
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
    throw new OrchestratorValidationError("Orchestrator plan must be a non-null object", {
      validationErrors: ["Plan is not an object"]
    });
  }

  const errors = [];

  // 1. issue / key
  const issueKey = rawPlan.issue || rawPlan.key || context.issue?.key;
  if (!issueKey || typeof issueKey !== "string" || !issueKey.trim()) {
    errors.push("Missing or invalid 'issue' / 'key'");
  }

  // 2. summary
  const summary = rawPlan.summary ?? context.issue?.summary;
  if (typeof summary !== "string") {
    errors.push("Missing or invalid 'summary'");
  }

  // 3. persona (judgment / decision style)
  if (!rawPlan.persona || typeof rawPlan.persona !== "string" || !rawPlan.persona.trim()) {
    errors.push("Missing or invalid 'persona'");
  }

  // 4. taskAgent (execution role)
  if (!rawPlan.taskAgent || typeof rawPlan.taskAgent !== "string" || !rawPlan.taskAgent.trim()) {
    errors.push("Missing or invalid 'taskAgent'");
  }

  // 5. skills
  if (!Array.isArray(rawPlan.skills)) {
    errors.push("'skills' must be an array of strings");
  } else if (rawPlan.skills.some(s => typeof s !== "string" || !s.trim())) {
    errors.push("'skills' array elements must be non-empty strings");
  }

  // 6. risk
  const validRisks = ["low", "normal", "medium", "high", "critical"];
  if (rawPlan.risk && !validRisks.includes(String(rawPlan.risk).toLowerCase())) {
    errors.push(`Invalid 'risk': '${rawPlan.risk}'. Allowed: ${validRisks.join(", ")}`);
  }

  // 7. parallelSafe
  if (rawPlan.parallelSafe !== undefined && typeof rawPlan.parallelSafe !== "boolean") {
    errors.push("'parallelSafe' must be a boolean");
  }

  // 8. allowedPaths / scope
  const allowedPaths = rawPlan.allowedPaths ?? rawPlan.scope;
  if (allowedPaths !== undefined) {
    if (!Array.isArray(allowedPaths) || allowedPaths.some(p => typeof p !== "string")) {
      errors.push("'allowedPaths' / 'scope' must be an array of strings");
    }
  }

  // 9. dependencies
  if (rawPlan.dependencies !== undefined) {
    if (!Array.isArray(rawPlan.dependencies) || rawPlan.dependencies.some(d => typeof d !== "string")) {
      errors.push("'dependencies' must be an array of strings");
    }
  }

  // 10. executor recommendation / model / profile
  if (rawPlan.executor !== undefined && rawPlan.executor !== null && typeof rawPlan.executor !== "string" && typeof rawPlan.executor !== "object") {
    errors.push("'executor' recommendation must be a string or object");
  }

  if (errors.length > 0) {
    throw new OrchestratorValidationError(`Orchestrator plan failed schema validation: ${errors.join("; ")}`, {
      validationErrors: errors
    });
  }

  return {
    issue: String(issueKey),
    summary: String(summary ?? ""),
    persona: String(rawPlan.persona),
    taskAgent: String(rawPlan.taskAgent),
    skills: [...rawPlan.skills],
    risk: String(rawPlan.risk || "normal").toLowerCase(),
    parallelSafe: rawPlan.parallelSafe ?? true,
    allowedPaths: Array.isArray(allowedPaths) ? [...allowedPaths] : [],
    dependencies: Array.isArray(rawPlan.dependencies) ? [...rawPlan.dependencies] : [],
    executor: rawPlan.executor || null,
    model: rawPlan.model || null,
    modelProfile: rawPlan.modelProfile || null,
    effort: rawPlan.effort || null,
    rationale: rawPlan.rationale || rawPlan.reasons || ["Orchestrator decision"],
    reasons: rawPlan.reasons || (Array.isArray(rawPlan.rationale) ? rawPlan.rationale : [rawPlan.rationale || "Orchestrator decision"]),
    metadata: rawPlan.metadata || {}
  };
}

// ── 3. Base Orchestrator Provider ────────────────────────────────────────────

export class OrchestratorProvider {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    this.type = config.type || name;
  }

  plan(issue, options = {}) {
    throw new Error("plan() must be implemented by subclass");
  }

  async createPlan(issue, options = {}) {
    return this.plan(issue, options);
  }

  async analyzeWorkItem(context) { return this.plan(context.issue || context, context); }
  async routeWork(context) { return this.plan(context.issue || context, context); }
  async decomposeParent(context) { throw new Error("Not implemented"); }
  async buildDependencyGraph(context) { throw new Error("Not implemented"); }
  async respondToHuman(context) { throw new Error("Not implemented"); }
  async handleBlocker(context) { throw new Error("Not implemented"); }
  async summarizeDecision(context) { return this.plan(context.issue || context, context); }
}

// ── 4. Builtin (Rule-Based) Orchestrator Provider ────────────────────────────

export class BuiltinOrchestratorProvider extends OrchestratorProvider {
  constructor(name = "builtin", config = {}) {
    super(name, { type: "builtin", ...config });
  }

  plan(issue, options = {}) {
    const route = routeIssue(issue);
    const persona = route.persona || "backend-engineer";
    const taskAgent = route.taskAgent || persona;
    const paths = options.settings?.data?.policy?.pathScopes?.[persona] || [];

    const plan = {
      issue: issue.key,
      summary: issue.summary || "",
      persona,
      taskAgent,
      skills: route.skills || ["minimal-change"],
      risk: route.risk || "normal",
      parallelSafe: route.parallelSafe ?? true,
      allowedPaths: paths,
      dependencies: [],
      rationale: route.reasons || ["Rule-based routing decision"],
      reasons: route.reasons || ["Rule-based routing decision"]
    };

    return validateOrchestratorPlan(plan, { issue });
  }
}

// ── 5. Generic CLI Orchestrator Provider ─────────────────────────────────────

export class CliOrchestratorProvider extends OrchestratorProvider {
  constructor(name = "generic-cli", config = {}, runtime = {}) {
    super(name, { type: "generic-cli", ...config });
    this.runtime = runtime || {};
  }

  buildPrompt(issue, options = {}) {
    const issueKey = issue.key || issue.id || "TASK-1";
    const summary = issue.summary || "";
    const description = issue.description || "";
    const labels = Array.isArray(issue.labels) ? issue.labels.join(", ") : "";

    return [
      `You are an Autonomous Delivery Orchestrator planning work item ${issueKey}: ${summary}`,
      `Description: ${description}`,
      labels ? `Labels: ${labels}` : "",
      "Analyze the requirements and produce a structured JSON orchestration plan.",
      "The response MUST be a valid JSON object matching the following schema:",
      "{",
      `  "issue": "${issueKey}",`,
      `  "summary": "${summary}",`,
      '  "persona": "<judgment-persona e.g. startup-cto, architect, backend-engineer>",',
      '  "taskAgent": "<execution-agent e.g. backend-engineer, frontend-engineer, devops-engineer>",',
      '  "skills": ["<skill1>", "<skill2>"],',
      '  "risk": "<normal|medium|high>",',
      '  "parallelSafe": <true|false>,',
      '  "allowedPaths": ["<path-glob1>", "<path-glob2>"],',
      '  "dependencies": ["<issue-key>"],',
      '  "executor": "<recommended-executor>",',
      '  "model": "<recommended-model>",',
      '  "effort": "<low|medium|high>",',
      '  "rationale": ["<reason1>", "<reason2>"]',
      "}",
      "Output ONLY the JSON object, with no markdown formatting or extra text."
    ].filter(Boolean).join("\n\n");
  }

  formatCommand(commandTemplate, replacements) {
    if (!Array.isArray(commandTemplate)) {
      throw new OrchestratorUnavailableError(`Configured command for orchestrator '${this.name}' must be an array of strings`, {
        provider: this.name
      });
    }
    return commandTemplate.map(arg => {
      let res = arg;
      for (const [k, v] of Object.entries(replacements)) {
        res = res.replaceAll(`{${k}}`, String(v ?? ""));
      }
      return res;
    });
  }

  plan(issue, options = {}) {
    if (this.config.enabled === false) {
      throw new OrchestratorUnavailableError(`Orchestrator provider '${this.name}' is disabled`, {
        provider: this.name
      });
    }

    const commandTemplate = this.config.command;
    if (!commandTemplate || !Array.isArray(commandTemplate) || commandTemplate.length === 0) {
      throw new OrchestratorUnavailableError(`No CLI command configured for orchestrator provider '${this.name}'`, {
        provider: this.name
      });
    }

    const prompt = this.buildPrompt(issue, options);
    const replacements = {
      prompt,
      issueKey: issue.key || "",
      summary: issue.summary || "",
      description: issue.description || "",
      labels: (issue.labels || []).join(",")
    };

    const cmd = this.formatCommand(commandTemplate, replacements);
    const spawnSync = this.runtime.spawnSync || options.runtime?.spawnSync || child_process.spawnSync;
    const timeoutMs = (this.config.timeoutSeconds || 30) * 1000;

    let result;
    try {
      result = spawnSync(cmd[0], cmd.slice(1), {
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new OrchestratorUnavailableError(`Orchestrator binary '${cmd[0]}' not found or not executable`, {
          provider: this.name,
          cause: err
        });
      }
      throw new OrchestratorProcessError(`Failed to spawn orchestrator process: ${err.message}`, {
        provider: this.name,
        cause: err
      });
    }

    if (result.error) {
      if (result.error.code === "ETIMEDOUT" || (result.signal === "SIGTERM" && result.status === null)) {
        throw new OrchestratorTimeoutError(`Orchestrator '${this.name}' timed out after ${timeoutMs}ms`, {
          provider: this.name,
          cause: result.error
        });
      }
      if (result.error.code === "ENOENT") {
        throw new OrchestratorUnavailableError(`Orchestrator binary '${cmd[0]}' not found or not executable`, {
          provider: this.name,
          cause: result.error
        });
      }
      throw new OrchestratorProcessError(`Orchestrator process error: ${result.error.message}`, {
        provider: this.name,
        cause: result.error
      });
    }

    if (result.status !== 0) {
      throw new OrchestratorProcessError(`Orchestrator '${this.name}' exited with non-zero status ${result.status}: ${result.stderr || result.stdout}`, {
        provider: this.name,
        exitCode: result.status,
        stderr: result.stderr || ""
      });
    }

    const stdout = (result.stdout || "").trim();
    if (!stdout) {
      throw new OrchestratorParseError(`Orchestrator '${this.name}' returned empty stdout`, {
        provider: this.name,
        rawOutput: stdout
      });
    }

    const parsed = this.parseOutput(stdout);
    return validateOrchestratorPlan(parsed, { issue });
  }

  parseOutput(stdout) {
    // 1. Direct JSON parse
    try {
      return JSON.parse(stdout);
    } catch {}

    // 2. Markdown code block extraction (```json ... ``` or ``` ...)
    const codeBlockMatch = stdout.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1]);
      } catch {}
    }

    // 3. Find first '{' and last '}'
    const firstBrace = stdout.indexOf("{");
    const lastBrace = stdout.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
      } catch {}
    }

    throw new OrchestratorParseError(`Failed to parse orchestrator '${this.name}' output as JSON`, {
      provider: this.name,
      rawOutput: stdout
    });
  }
}

// ── 6. Codex Orchestrator Adapter ────────────────────────────────────────────

export class CodexOrchestratorProvider extends CliOrchestratorProvider {
  constructor(name = "codex", config = {}, runtime = {}) {
    const defaultCommand = ["codex", "exec", "--json", "{prompt}"];
    super(name, { type: "codex", command: config.command || defaultCommand, ...config }, runtime);
  }
}

// ── 7. Antigravity Orchestrator Adapter ──────────────────────────────────────

export class AntigravityOrchestratorProvider extends CliOrchestratorProvider {
  constructor(name = "antigravity", config = {}, runtime = {}) {
    const defaultCommand = ["agy", "exec", "--json", "{prompt}"];
    super(name, { type: "antigravity", command: config.command || defaultCommand, ...config }, runtime);
  }

  parseOutput(stdout) {
    // Antigravity JSON output could be a JSON envelope with { status, ok, response }
    try {
      const topLevel = JSON.parse(stdout);
      if (topLevel && typeof topLevel === "object") {
        if (topLevel.response) {
          if (typeof topLevel.response === "object") return topLevel.response;
          if (typeof topLevel.response === "string") {
            return super.parseOutput(topLevel.response);
          }
        }
        if (topLevel.persona || topLevel.taskAgent || topLevel.skills) {
          return topLevel;
        }
      }
    } catch {}

    return super.parseOutput(stdout);
  }
}

// ── 8. Claude Code Orchestrator Adapter ──────────────────────────────────────

export class ClaudeCodeOrchestratorProvider extends CliOrchestratorProvider {
  constructor(name = "claude-code", config = {}, runtime = {}) {
    const defaultCommand = ["claude", "-p", "{prompt}", "--output-format", "json"];
    super(name, { type: "claude-code", command: config.command || defaultCommand, ...config }, runtime);
  }

  plan(issue, options = {}) {
    if (this.config.enabled === false || this.config.installed === false) {
      throw new OrchestratorUnavailableError(`Claude Code orchestrator is not configured or installed`, {
        provider: this.name
      });
    }
    return super.plan(issue, options);
  }
}

// ── 9. Factory & Discovery ───────────────────────────────────────────────────

export function configuredOrchestratorProviders(settings) {
  return settings?.data?.orchestrator?.providers || { builtin: { type: "builtin" } };
}

export function selectedOrchestratorProviderName(settings) {
  const providers = configuredOrchestratorProviders(settings);
  return settings?.data?.orchestrator?.defaultProvider || Object.keys(providers)[0] || "builtin";
}

export function createOrchestratorProvider(settings, runtime = {}) {
  const name = selectedOrchestratorProviderName(settings);
  const providers = configuredOrchestratorProviders(settings);
  const config = providers[name];

  if (!config) {
    if (name === "builtin") {
      return new BuiltinOrchestratorProvider("builtin", {});
    }
    throw new Error(`Unknown orchestrator provider: ${name}`);
  }

  const type = config.type || name;
  switch (type) {
    case "builtin":
    case "local":
      return new BuiltinOrchestratorProvider(name, config);
    case "codex":
      return new CodexOrchestratorProvider(name, config, runtime);
    case "antigravity":
      return new AntigravityOrchestratorProvider(name, config, runtime);
    case "claude-code":
    case "claude":
      return new ClaudeCodeOrchestratorProvider(name, config, runtime);
    case "generic-cli":
    case "cli":
      return new CliOrchestratorProvider(name, config, runtime);
    default:
      if (Array.isArray(config.command)) {
        return new CliOrchestratorProvider(name, config, runtime);
      }
      throw new Error(`Unsupported orchestrator provider type: ${type}`);
  }
}

export function describeOrchestratorProviders(settings) {
  const selected = selectedOrchestratorProviderName(settings);
  return Object.entries(configuredOrchestratorProviders(settings)).map(([name, config]) => ({
    id: name,
    type: config.type || name,
    selected: name === selected,
    enabled: config.enabled !== false
  }));
}
