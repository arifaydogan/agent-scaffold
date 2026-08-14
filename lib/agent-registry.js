import crypto from "node:crypto";

export const AGENT_STATUSES = Object.freeze(["enabled", "disabled", "archived"]);

export const AGENT_ROLES = Object.freeze([
  "implementation",
  "review",
  "orchestrator",
  "architect",
  "specialist"
]);

export class AgentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentValidationError";
  }
}

/**
 * Computes a deterministic SHA-256 hash of an agent definition payload.
 */
export function computeAgentDefinitionHash(def) {
  if (!def || typeof def !== "object") return "";
  const canonical = {
    id: String(def.id || ""),
    displayName: String(def.displayName || ""),
    role: String(def.role || "implementation"),
    defaultPersona: String(def.defaultPersona || ""),
    skills: Array.isArray(def.skills) ? [...def.skills].sort() : [],
    capabilities: Array.isArray(def.capabilities) ? [...def.capabilities].sort() : [],
    executor: def.executor && typeof def.executor === "object" ? {
      provider: def.executor.provider ? String(def.executor.provider) : null,
      modelProfile: def.executor.modelProfile ? String(def.executor.modelProfile) : null,
      model: def.executor.model ? String(def.executor.model) : null
    } : null,
    reviewer: def.reviewer ? String(def.reviewer) : null,
    risk: String(def.risk || "normal"),
    maxConcurrency: Number(def.maxConcurrency) || 1,
    allowedPaths: Array.isArray(def.allowedPaths) ? [...def.allowedPaths].sort() : []
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Strictly validates an agent definition payload against Section 21 specification.
 */
export function validateAgentDefinition(def, { isUpdate = false } = {}) {
  if (!def || typeof def !== "object" || Array.isArray(def)) {
    throw new AgentValidationError("Agent definition must be a valid JSON object");
  }

  // ID validation
  if (!isUpdate || def.id !== undefined) {
    if (typeof def.id !== "string" || !def.id.trim()) {
      throw new AgentValidationError("Agent 'id' is required and must be a non-empty string");
    }
    const idTrimmed = def.id.trim();
    if (!/^[a-z0-9-_]+$/i.test(idTrimmed)) {
      throw new AgentValidationError(`Agent 'id' "${def.id}" contains invalid characters (allowed: letters, numbers, hyphens, underscores)`);
    }
  }

  // Display Name validation
  if (!isUpdate || def.displayName !== undefined) {
    if (typeof def.displayName !== "string" || !def.displayName.trim()) {
      throw new AgentValidationError("Agent 'displayName' is required and must be a non-empty string");
    }
  }

  // Status validation
  if (def.status !== undefined) {
    if (typeof def.status !== "string" || !AGENT_STATUSES.includes(def.status.trim().toLowerCase())) {
      throw new AgentValidationError(`Invalid agent status: "${def.status}". Allowed values: ${AGENT_STATUSES.join(", ")}`);
    }
  }

  // Role validation
  if (def.role !== undefined) {
    if (typeof def.role !== "string" || !AGENT_ROLES.includes(def.role.trim().toLowerCase())) {
      throw new AgentValidationError(`Invalid agent role: "${def.role}". Allowed roles: ${AGENT_ROLES.join(", ")}`);
    }
  }

  // Default Persona validation
  if (def.defaultPersona !== undefined && def.defaultPersona !== null) {
    if (typeof def.defaultPersona !== "string" || !def.defaultPersona.trim()) {
      throw new AgentValidationError("Agent 'defaultPersona' must be a non-empty string");
    }
    if (!/^[a-z0-9-_]+$/i.test(def.defaultPersona.trim())) {
      throw new AgentValidationError(`Agent 'defaultPersona' "${def.defaultPersona}" contains invalid characters`);
    }
  }

  // Skills validation
  if (def.skills !== undefined) {
    if (!Array.isArray(def.skills) || def.skills.some((s) => typeof s !== "string" || !s.trim())) {
      throw new AgentValidationError("Agent 'skills' must be an array of non-empty strings");
    }
  }

  // Capabilities validation
  if (def.capabilities !== undefined) {
    if (!Array.isArray(def.capabilities) || def.capabilities.some((c) => typeof c !== "string" || !c.trim())) {
      throw new AgentValidationError("Agent 'capabilities' must be an array of non-empty strings");
    }
  }

  // Executor validation
  if (def.executor !== undefined && def.executor !== null) {
    if (typeof def.executor !== "object" || Array.isArray(def.executor)) {
      throw new AgentValidationError("Agent 'executor' must be an object");
    }
    if (def.executor.provider !== undefined && def.executor.provider !== null) {
      if (typeof def.executor.provider !== "string" || !def.executor.provider.trim()) {
        throw new AgentValidationError("Agent 'executor.provider' must be a non-empty string");
      }
    }
    if (def.executor.model !== undefined && def.executor.model !== null && typeof def.executor.model !== "string") {
      throw new AgentValidationError("Agent 'executor.model' must be a string or null");
    }
    if (def.executor.modelProfile !== undefined && def.executor.modelProfile !== null && typeof def.executor.modelProfile !== "string") {
      throw new AgentValidationError("Agent 'executor.modelProfile' must be a string or null");
    }
  }

  // Risk validation
  if (def.risk !== undefined) {
    if (typeof def.risk !== "string" || !["low", "normal", "high"].includes(def.risk.toLowerCase())) {
      throw new AgentValidationError(`Invalid agent risk: "${def.risk}". Allowed: low, normal, high`);
    }
  }

  // Max Concurrency validation
  if (def.maxConcurrency !== undefined) {
    const num = Number(def.maxConcurrency);
    if (!Number.isInteger(num) || num < 1) {
      throw new AgentValidationError("Agent 'maxConcurrency' must be a positive integer >= 1");
    }
  }

  // Allowed Paths validation
  if (def.allowedPaths !== undefined) {
    if (!Array.isArray(def.allowedPaths) || def.allowedPaths.some((p) => typeof p !== "string" || !p.trim())) {
      throw new AgentValidationError("Agent 'allowedPaths' must be an array of non-empty strings");
    }
  }

  return {
    id: def.id ? def.id.trim() : undefined,
    displayName: def.displayName ? def.displayName.trim() : undefined,
    status: def.status ? def.status.trim().toLowerCase() : "enabled",
    role: def.role ? def.role.trim().toLowerCase() : "implementation",
    defaultPersona: def.defaultPersona ? def.defaultPersona.trim() : "startup-cto",
    skills: Array.isArray(def.skills) ? def.skills.map((s) => s.trim()) : ["minimal-change"],
    capabilities: Array.isArray(def.capabilities) ? def.capabilities.map((c) => c.trim()) : ["code-intelligence", "git"],
    executor: def.executor ? {
      provider: def.executor.provider ? String(def.executor.provider).trim() : "codex",
      modelProfile: def.executor.modelProfile ? String(def.executor.modelProfile).trim() : "medium",
      model: def.executor.model ? String(def.executor.model).trim() : null
    } : { provider: "codex", modelProfile: "medium", model: null },
    reviewer: def.reviewer ? String(def.reviewer).trim() : "correctness-reviewer",
    risk: def.risk ? def.risk.toLowerCase() : "normal",
    maxConcurrency: Number(def.maxConcurrency) || 2,
    allowedPaths: Array.isArray(def.allowedPaths) ? def.allowedPaths.map((p) => p.trim()) : []
  };
}

export const BUILTIN_AGENT_SEEDS = Object.freeze([
  {
    id: "backend-engineer",
    displayName: "Backend Engineer",
    status: "enabled",
    role: "implementation",
    defaultPersona: "startup-cto",
    skills: ["api-design", "backend-testing", "minimal-change"],
    capabilities: ["code-intelligence", "git"],
    executor: { provider: "codex", modelProfile: "medium", model: null },
    reviewer: "correctness-reviewer",
    risk: "normal",
    maxConcurrency: 2,
    allowedPaths: ["backend/**", "lib/**", "src/**", "tests/**"]
  },
  {
    id: "frontend-engineer",
    displayName: "Frontend Engineer",
    status: "enabled",
    role: "implementation",
    defaultPersona: "startup-cto",
    skills: ["frontend-design", "ui-testing", "minimal-change"],
    capabilities: ["code-intelligence", "git"],
    executor: { provider: "codex", modelProfile: "medium", model: null },
    reviewer: "correctness-reviewer",
    risk: "normal",
    maxConcurrency: 2,
    allowedPaths: ["ui/**", "frontend/**", "src/**"]
  },
  {
    id: "cv-engineer",
    displayName: "Computer Vision Engineer",
    status: "enabled",
    role: "implementation",
    defaultPersona: "startup-cto",
    skills: ["cv-pipeline-checks", "minimal-change"],
    capabilities: ["code-intelligence", "git"],
    executor: { provider: "codex", modelProfile: "medium", model: null },
    reviewer: "correctness-reviewer",
    risk: "normal",
    maxConcurrency: 1,
    allowedPaths: ["cv/**", "engine/**", "src/**"]
  },
  {
    id: "devops-engineer",
    displayName: "DevOps Engineer",
    status: "enabled",
    role: "implementation",
    defaultPersona: "startup-cto",
    skills: ["docker-patterns", "ci-cd-patterns", "minimal-change"],
    capabilities: ["code-intelligence", "git"],
    executor: { provider: "codex", modelProfile: "medium", model: null },
    reviewer: "correctness-reviewer",
    risk: "high",
    maxConcurrency: 1,
    allowedPaths: ["docker/**", "infra/**", ".github/**"]
  },
  {
    id: "qa-engineer",
    displayName: "QA Test Engineer",
    status: "enabled",
    role: "implementation",
    defaultPersona: "startup-cto",
    skills: ["backend-testing", "e2e-testing", "minimal-change"],
    capabilities: ["code-intelligence", "git"],
    executor: { provider: "codex", modelProfile: "medium", model: null },
    reviewer: "correctness-reviewer",
    risk: "normal",
    maxConcurrency: 2,
    allowedPaths: ["test/**", "tests/**", "spec/**"]
  },
  {
    id: "security-engineer",
    displayName: "Security Engineer",
    status: "enabled",
    role: "review",
    defaultPersona: "startup-cto",
    skills: ["security-review", "minimal-change"],
    capabilities: ["code-intelligence", "git"],
    executor: { provider: "codex", modelProfile: "high", model: null },
    reviewer: "correctness-reviewer",
    risk: "high",
    maxConcurrency: 1,
    allowedPaths: []
  },
  {
    id: "correctness-reviewer",
    displayName: "Correctness Code Reviewer",
    status: "enabled",
    role: "review",
    defaultPersona: "startup-cto",
    skills: ["code-review", "minimal-change"],
    capabilities: ["code-intelligence", "git"],
    executor: { provider: "antigravity", modelProfile: "high", model: null },
    reviewer: null,
    risk: "normal",
    maxConcurrency: 2,
    allowedPaths: []
  }
]);
