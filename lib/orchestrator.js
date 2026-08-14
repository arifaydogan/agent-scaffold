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

  // 1. issue / key (Required explicit string from provider output, fail-closed)
  const issueKey = rawPlan.issue || rawPlan.key;
  if (!issueKey || typeof issueKey !== "string" || !issueKey.trim()) {
    errors.push("Missing or invalid required field: 'issue' / 'key'");
  } else if (context.issue?.key && String(issueKey).trim() !== String(context.issue.key).trim()) {
    errors.push(`Returned plan issue '${issueKey}' does not match requested work item '${context.issue.key}'`);
  }

  // 2. summary (Required explicit string from provider output, fail-closed)
  const summary = rawPlan.summary;
  if (summary === undefined || summary === null || typeof summary !== "string" || !summary.trim()) {
    errors.push("Missing or invalid required field: 'summary'");
  }

  // 3. persona (Required string: judgment / decision style)
  if (!rawPlan.persona || typeof rawPlan.persona !== "string" || !rawPlan.persona.trim()) {
    errors.push("Missing or invalid required field: 'persona'");
  }

  // 4. taskAgent (Required string: execution role)
  if (!rawPlan.taskAgent || typeof rawPlan.taskAgent !== "string" || !rawPlan.taskAgent.trim()) {
    errors.push("Missing or invalid required field: 'taskAgent'");
  }

  // 5. skills (Required non-empty array of strings)
  if (!Array.isArray(rawPlan.skills)) {
    errors.push("Missing or invalid required field: 'skills' must be an array");
  } else if (rawPlan.skills.length === 0) {
    errors.push("'skills' array must not be empty");
  } else if (rawPlan.skills.some((s) => typeof s !== "string" || !s.trim())) {
    errors.push("'skills' array elements must be non-empty strings");
  }

  // 6. risk (Required explicit string from allowed values, no silent defaulting!)
  const validRisks = ["low", "normal", "medium", "high", "critical"];
  if (rawPlan.risk === undefined || rawPlan.risk === null) {
    errors.push("Missing required field: 'risk' (must be one of: low, normal, medium, high, critical)");
  } else if (!validRisks.includes(String(rawPlan.risk).toLowerCase())) {
    errors.push(`Invalid 'risk': '${rawPlan.risk}'. Allowed: ${validRisks.join(", ")}`);
  }

  // 7. parallelSafe (Required explicit boolean, no silent defaulting!)
  if (rawPlan.parallelSafe === undefined || rawPlan.parallelSafe === null || typeof rawPlan.parallelSafe !== "boolean") {
    errors.push("Missing or invalid required field: 'parallelSafe' must be a boolean");
  }

  // 8. allowedPaths / scope (Required explicit array of strings, no silent defaulting!)
  const allowedPaths = rawPlan.allowedPaths !== undefined ? rawPlan.allowedPaths : rawPlan.scope;
  if (allowedPaths === undefined || allowedPaths === null || !Array.isArray(allowedPaths)) {
    errors.push("Missing required field: 'allowedPaths' (or 'scope') must be an array of strings");
  } else if (allowedPaths.some((p) => typeof p !== "string")) {
    errors.push("'allowedPaths' array elements must be strings");
  }

  // 9. dependencies (Required explicit array of strings)
  if (rawPlan.dependencies === undefined || rawPlan.dependencies === null || !Array.isArray(rawPlan.dependencies)) {
    errors.push("Missing required field: 'dependencies' must be an array of strings");
  } else if (rawPlan.dependencies.some((d) => typeof d !== "string")) {
    errors.push("'dependencies' array elements must be strings");
  }

  // 10. rationale / reasons (Required explicit non-empty array of strings or string)
  const rationale = rawPlan.rationale || rawPlan.reasons;
  if (!rationale) {
    errors.push("Missing required field: 'rationale' / 'reasons'");
  } else if (Array.isArray(rationale)) {
    if (rationale.length === 0 || rationale.some((r) => typeof r !== "string" || !r.trim())) {
      errors.push("'rationale' array elements must be non-empty strings");
    }
  } else if (typeof rationale !== "string" || !rationale.trim()) {
    errors.push("'rationale' must be a non-empty string or array of strings");
  }

  // 11. Type checks for executor / model / modelProfile / effort
  if (rawPlan.executor !== undefined && rawPlan.executor !== null && typeof rawPlan.executor !== "string" && typeof rawPlan.executor !== "object") {
    errors.push("'executor' recommendation must be a string or object");
  }
  if (rawPlan.model !== undefined && rawPlan.model !== null && typeof rawPlan.model !== "string") {
    errors.push("'model' recommendation must be a string");
  }
  if (rawPlan.modelProfile !== undefined && rawPlan.modelProfile !== null && typeof rawPlan.modelProfile !== "string") {
    errors.push("'modelProfile' recommendation must be a string");
  }
  if (rawPlan.effort !== undefined && rawPlan.effort !== null && typeof rawPlan.effort !== "string") {
    errors.push("'effort' recommendation must be a string");
  }

  if (errors.length > 0) {
    throw new OrchestratorValidationError(`Orchestrator plan failed schema validation: ${errors.join("; ")}`, {
      validationErrors: errors
    });
  }

  const cleanRationale = Array.isArray(rationale) ? [...rationale] : [String(rationale)];

  return {
    issue: String(issueKey),
    summary: String(summary),
    persona: String(rawPlan.persona),
    taskAgent: String(rawPlan.taskAgent),
    skills: [...rawPlan.skills],
    risk: String(rawPlan.risk).toLowerCase(),
    parallelSafe: rawPlan.parallelSafe,
    allowedPaths: [...allowedPaths],
    dependencies: [...rawPlan.dependencies],
    executor: rawPlan.executor || null,
    model: rawPlan.model || null,
    modelProfile: rawPlan.modelProfile || null,
    effort: rawPlan.effort || null,
    rationale: cleanRationale,
    reasons: cleanRationale,
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
    const policyScopes = options.settings?.data?.policy?.pathScopes;
    const paths = policyScopes !== undefined
      ? (policyScopes[persona] || [])
      : ["lib/**", "src/**"];

    const plan = {
      issue: issue.key || "UNKNOWN",
      summary: issue.summary || "No summary provided",
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
    return commandTemplate.map((arg) => {
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
    return extractJsonObject(stdout, this.name);
  }
}

// ── 6. Codex Orchestrator Adapter (JSONL Event Stream) ────────────────────────

export class CodexOrchestratorProvider extends CliOrchestratorProvider {
  constructor(name = "codex", config = {}, runtime = {}) {
    const defaultCommand = ["codex", "exec", "--json", "{prompt}"];
    super(name, { type: "codex", command: config.command || defaultCommand, ...config }, runtime);
  }

  parseOutput(stdout) {
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let finalMessage = null;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // Explicitly handle turn.failed or top-level fatal error events
        if (event.type === "turn.failed" || event.type === "error") {
          const errMsg = event.error?.message || event.message || event.error || line;
          throw new OrchestratorProcessError(`Codex orchestrator turn failed: ${errMsg}`, {
            provider: this.name,
            stderr: String(errMsg)
          });
        }

        // Real Codex event schema: item.completed with item.type: "agent_message" and item.text
        if (event.type === "item.completed" && event.item) {
          if (event.item.type === "agent_message" && typeof event.item.text === "string") {
            finalMessage = event.item.text;
          } else if (event.item.type === "message" && event.item.role === "assistant") {
            // Compatibility path
            const textContent = Array.isArray(event.item.content)
              ? event.item.content.map((c) => (typeof c === "string" ? c : c.text || "")).join("\n")
              : (event.item.text || event.item.content || "");
            if (textContent) finalMessage = textContent;
          }
        } else if (event.type === "agent_message" && event.message) {
          // Compatibility path
          finalMessage = typeof event.message === "string" ? event.message : JSON.stringify(event.message);
        } else if (event.type === "response" && event.response) {
          // Compatibility path
          finalMessage = typeof event.response === "string" ? event.response : JSON.stringify(event.response);
        } else if (event.persona && event.taskAgent && event.issue) {
          // Direct plan object on a single line
          return event;
        }
      } catch (err) {
        if (err instanceof OrchestratorProcessError) throw err;
        // Non-JSON line in stdout, ignore
      }
    }

    if (finalMessage) {
      return extractJsonObject(finalMessage, this.name);
    }

    // Fallback: search whole output for JSON object
    return extractJsonObject(stdout, this.name);
  }
}

// ── 7. Antigravity Orchestrator Adapter (Multi-line Stream & Envelope) ────────

export class AntigravityOrchestratorProvider extends CliOrchestratorProvider {
  constructor(name = "antigravity", config = {}, runtime = {}) {
    const defaultCommand = ["agy", "exec", "--json", "{prompt}"];
    super(name, { type: "antigravity", command: config.command || defaultCommand, ...config }, runtime);
  }

  parseOutput(stdout) {
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let lastSuccessResponse = null;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.status === "FAILED" || event.ok === false) {
          throw new OrchestratorProcessError(`Antigravity orchestrator reported failure: ${event.error || event.message || line}`, {
            provider: this.name,
            stderr: event.error || event.message || ""
          });
        }
        if (event.status === "SUCCESS" || event.ok === true || event.response) {
          lastSuccessResponse = event.response || event;
        } else if (event.persona && event.taskAgent) {
          lastSuccessResponse = event;
        }
      } catch (err) {
        if (err instanceof OrchestratorProcessError) throw err;
      }
    }

    if (lastSuccessResponse) {
      if (typeof lastSuccessResponse === "object") return lastSuccessResponse;
      return extractJsonObject(lastSuccessResponse, this.name);
    }

    return extractJsonObject(stdout, this.name);
  }
}

// ── 8. Claude Code Orchestrator Adapter (Result Envelope) ─────────────────────

export class ClaudeCodeOrchestratorProvider extends CliOrchestratorProvider {
  constructor(name = "claude-code", config = {}, runtime = {}) {
    const defaultCommand = ["claude", "-p", "{prompt}", "--output-format", "json"];
    super(name, { type: "claude-code", command: config.command || defaultCommand, ...config }, runtime);
  }

  plan(issue, options = {}) {
    if (this.config.enabled === false || this.config.installed === false) {
      throw new OrchestratorUnavailableError("Claude Code orchestrator is not configured or installed", {
        provider: this.name
      });
    }
    return super.plan(issue, options);
  }

  parseOutput(stdout) {
    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      return extractJsonObject(stdout, this.name);
    }

    if (envelope && typeof envelope === "object") {
      if (envelope.is_error === true || envelope.subtype === "error" || envelope.error) {
        throw new OrchestratorProcessError(`Claude Code returned error: ${envelope.error || envelope.result || "Unknown error"}`, {
          provider: this.name,
          stderr: String(envelope.error || "")
        });
      }

      const resultText = envelope.result ?? envelope.text ?? envelope.response;
      if (resultText !== undefined) {
        if (typeof resultText === "object" && resultText !== null) {
          return resultText;
        }
        return extractJsonObject(String(resultText), this.name);
      }
    }

    return extractJsonObject(stdout, this.name);
  }
}

// ── 9. Robust JSON Extraction Helper ──────────────────────────────────────────

function extractJsonObject(text, providerName) {
  if (typeof text !== "string") {
    throw new OrchestratorParseError(`Invalid output from orchestrator '${providerName}'`, {
      provider: providerName,
      rawOutput: String(text)
    });
  }

  const trimmed = text.trim();

  // 1. Direct parse
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}

  // 2. Markdown code block
  const blockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (blockMatch) {
    try {
      const parsed = JSON.parse(blockMatch[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }

  // 3. Substring between first { and last }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }

  throw new OrchestratorParseError(`Failed to parse orchestrator '${providerName}' output as JSON`, {
    provider: providerName,
    rawOutput: text
  });
}

// ── 10. Factory & Discovery ──────────────────────────────────────────────────

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
    throw new OrchestratorUnavailableError(`Unknown orchestrator provider: '${name}'`, {
      provider: name
    });
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
      throw new OrchestratorUnavailableError(`Unsupported orchestrator provider type: '${type}'`, {
        provider: name
      });
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
