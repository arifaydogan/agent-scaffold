import fs from "node:fs";
import path from "node:path";

/**
 * Validate that a value is a positive integer (>= 1).
 * @param {unknown} value
 * @param {string} name - field name for error messages
 * @returns {number}
 */
function requirePositiveInteger(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`supervisor.${name} must be a positive integer, got: ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * Validate that a value is a boolean.
 * @param {unknown} value
 * @param {string} name
 * @returns {boolean}
 */
function requireBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new Error(`supervisor.${name} must be a boolean, got: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Default supervisor configuration. executeEnabled is intentionally false (fail-closed). */
const SUPERVISOR_DEFAULTS = {
  executeEnabled: false,
  pollIntervalSeconds: 30,
  heartbeatSeconds: 10,
  staleAfterSeconds: 90,
  maxConsecutiveFailures: 3,
  issueLimit: 10
};

/**
 * Parse and validate the optional `supervisor` config section.
 * Returns a normalized object with all fields present. Never mutates `raw`.
 * @param {object|undefined} raw
 * @returns {typeof SUPERVISOR_DEFAULTS}
 */
function normalizeSupervisorConfig(raw) {
  if (raw === undefined || raw === null) {
    return { ...SUPERVISOR_DEFAULTS };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("supervisor config must be an object");
  }

  const result = { ...SUPERVISOR_DEFAULTS };

  if ("executeEnabled" in raw) {
    result.executeEnabled = requireBoolean(raw.executeEnabled, "executeEnabled");
  }
  if ("pollIntervalSeconds" in raw) {
    result.pollIntervalSeconds = requirePositiveInteger(raw.pollIntervalSeconds, "pollIntervalSeconds");
  }
  if ("heartbeatSeconds" in raw) {
    result.heartbeatSeconds = requirePositiveInteger(raw.heartbeatSeconds, "heartbeatSeconds");
  }
  if ("staleAfterSeconds" in raw) {
    result.staleAfterSeconds = requirePositiveInteger(raw.staleAfterSeconds, "staleAfterSeconds");
  }
  if ("maxConsecutiveFailures" in raw) {
    result.maxConsecutiveFailures = requirePositiveInteger(raw.maxConsecutiveFailures, "maxConsecutiveFailures");
  }
  if ("issueLimit" in raw) {
    result.issueLimit = requirePositiveInteger(raw.issueLimit, "issueLimit");
  }

  if (result.heartbeatSeconds >= result.staleAfterSeconds) {
    throw new Error(
      `supervisor.heartbeatSeconds (${result.heartbeatSeconds}) must be less than ` +
      `supervisor.staleAfterSeconds (${result.staleAfterSeconds})`
    );
  }

  return result;
}

export function loadSettings(configPath) {
  const source = path.resolve(configPath);
  const data = JSON.parse(fs.readFileSync(source, "utf8"));
  for (const section of ["project", "policy", "worktree", "jira", "executor"]) {
    if (!data[section]) throw new Error(`Missing config section: ${section}`);
  }
  const base = path.dirname(source);
  // Normalize supervisor config and attach it without mutating `data` itself.
  const supervisor = normalizeSupervisorConfig(data.supervisor);
  return {
    source,
    data: { ...data, supervisor },
    projectKey: data.project.key,
    repoPath: path.resolve(base, data.project.repoPath),
    worktreeRoot: path.resolve(base, data.worktree.root)
  };
}
