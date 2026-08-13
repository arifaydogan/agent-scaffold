import fs from "node:fs";
import path from "node:path";

function requirePositiveInteger(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`supervisor.${name} must be a positive integer, got: ${JSON.stringify(value)}`);
  }
  return n;
}

function requireBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new Error(`supervisor.${name} must be a boolean, got: ${JSON.stringify(value)}`);
  }
  return value;
}

const SUPERVISOR_DEFAULTS = {
  executeEnabled: false,
  pollIntervalSeconds: 30,
  heartbeatSeconds: 10,
  staleAfterSeconds: 90,
  maxConsecutiveFailures: 3,
  issueLimit: 10
};

function normalizeSupervisorConfig(raw) {
  if (raw === undefined || raw === null) return { ...SUPERVISOR_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("supervisor config must be an object");
  }

  const result = { ...SUPERVISOR_DEFAULTS };
  if ("executeEnabled" in raw) {
    result.executeEnabled = requireBoolean(raw.executeEnabled, "executeEnabled");
  }
  for (const name of [
    "pollIntervalSeconds",
    "heartbeatSeconds",
    "staleAfterSeconds",
    "maxConsecutiveFailures",
    "issueLimit"
  ]) {
    if (name in raw) result[name] = requirePositiveInteger(raw[name], name);
  }
  if (result.heartbeatSeconds >= result.staleAfterSeconds) {
    throw new Error(
      `supervisor.heartbeatSeconds (${result.heartbeatSeconds}) must be less than ` +
      `supervisor.staleAfterSeconds (${result.staleAfterSeconds})`
    );
  }
  return result;
}

function normalizeProviderGroup(raw, fallback, name, { allowEmpty = false } = {}) {
  const value = raw || fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} config must be an object`);
  }
  const providers = value.providers || {};
  if (typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error(`${name}.providers must be an object`);
  }
  const providerNames = Object.keys(providers);
  if (!allowEmpty && providerNames.length === 0) {
    throw new Error(`${name}.providers must define at least one provider`);
  }
  const defaultProvider = value.defaultProvider ?? providerNames[0] ?? null;
  if (providerNames.length > 0 && defaultProvider !== null && !providers[defaultProvider]) {
    throw new Error(`${name}.defaultProvider references unknown provider: ${defaultProvider}`);
  }
  return { ...value, defaultProvider, providers };
}

function normalizeProviderConfig(data) {
  if (!data.workSource && !data.jira) {
    throw new Error("Missing config section: workSource (or legacy jira)");
  }
  const workSource = normalizeProviderGroup(
    data.workSource,
    data.jira
      ? { defaultProvider: "jira", providers: { jira: { type: "jira", ...data.jira } } }
      : null,
    "workSource"
  );
  const orchestrator = normalizeProviderGroup(
    data.orchestrator,
    { defaultProvider: "builtin", providers: { builtin: { type: "builtin" } } },
    "orchestrator"
  );
  const executorSource = data.executor.providers
    ? data.executor
    : {
        defaultProvider: data.executor.defaultProvider,
        providers: Object.fromEntries(
          Object.entries(data.executor).filter(([, value]) => Array.isArray(value?.command))
        )
      };
  const executor = normalizeProviderGroup(executorSource, null, "executor", { allowEmpty: true });
  const codeIntelligence = normalizeProviderGroup(
    data.codeIntelligence,
    { defaultProvider: null, providers: {} },
    "codeIntelligence",
    { allowEmpty: true }
  );
  return { workSource, orchestrator, executor, codeIntelligence };
}

function normalizePolicyConfig(policy, executor) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("policy config must be an object");
  }
  if (
    policy.externalWritesEnabled !== undefined &&
    typeof policy.externalWritesEnabled !== "boolean"
  ) {
    throw new Error("policy.externalWritesEnabled must be a boolean");
  }
  if (
    policy.gitIntegrationEnabled !== undefined &&
    typeof policy.gitIntegrationEnabled !== "boolean"
  ) {
    throw new Error("policy.gitIntegrationEnabled must be a boolean");
  }
  if (
    policy.autonomyEnabled !== undefined &&
    typeof policy.autonomyEnabled !== "boolean"
  ) {
    throw new Error("policy.autonomyEnabled must be a boolean");
  }
  if (policy.review !== undefined) {
    if (!policy.review || typeof policy.review !== "object" || Array.isArray(policy.review)) {
      throw new Error("policy.review must be an object");
    }
    if (policy.review.maxReworkAttempts !== undefined) {
      const n = Number(policy.review.maxReworkAttempts);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(
          `policy.review.maxReworkAttempts must be a non-negative integer, got: ${JSON.stringify(
            policy.review.maxReworkAttempts
          )}`
        );
      }
    }
    if (policy.review.provider) {
      const providerConfig = executor?.providers?.[policy.review.provider];
      if (!providerConfig) {
        throw new Error(
          `Configured review provider '${policy.review.provider}' does not exist in executor.providers`
        );
      }
      const modelProfile = policy.review.modelProfile || "medium";
      const model = providerConfig.modelProfiles?.[modelProfile] || providerConfig.defaultModel;
      if (!model) {
        throw new Error(
          `Configured review model profile '${modelProfile}' does not exist for provider '${policy.review.provider}'`
        );
      }
    }
  }
}

export function loadSettings(configPath) {
  const source = path.resolve(configPath);
  const data = JSON.parse(fs.readFileSync(source, "utf8"));
  for (const section of ["project", "policy", "worktree", "executor"]) {
    if (!data[section]) throw new Error(`Missing config section: ${section}`);
  }
  const base = path.dirname(source);
  const supervisor = normalizeSupervisorConfig(data.supervisor);
  const providers = normalizeProviderConfig(data);
  normalizePolicyConfig(data.policy, providers.executor);
  if (
    data.controlPlane?.configMutationEnabled !== undefined &&
    typeof data.controlPlane.configMutationEnabled !== "boolean"
  ) {
    throw new Error("controlPlane.configMutationEnabled must be a boolean");
  }
  const controlPlane = {
    configMutationEnabled: false,
    ...(data.controlPlane || {})
  };
  return {
    source,
    data: { ...data, ...providers, supervisor, controlPlane },
    projectKey: data.project.key,
    repoPath: path.resolve(base, data.project.repoPath),
    worktreeRoot: path.resolve(base, data.worktree.root)
  };
}

const PROVIDER_SELECTION_SECTIONS = Object.freeze([
  "workSource",
  "orchestrator",
  "executor",
  "codeIntelligence"
]);

export function updateProviderSelections(settings, selections) {
  if (!settings.data.controlPlane?.configMutationEnabled) {
    throw new Error("Control Plane config mutation is disabled");
  }
  if (!selections || typeof selections !== "object" || Array.isArray(selections)) {
    throw new Error("Provider selections must be an object");
  }
  const unknown = Object.keys(selections).filter(
    (key) => !PROVIDER_SELECTION_SECTIONS.includes(key)
  );
  if (unknown.length) throw new Error(`Unsupported config fields: ${unknown.join(", ")}`);

  const raw = JSON.parse(fs.readFileSync(settings.source, "utf8"));
  for (const section of PROVIDER_SELECTION_SECTIONS) {
    if (!(section in selections)) continue;
    const provider = selections[section];
    const providerConfig = settings.data[section].providers[provider];
    if (typeof provider !== "string" || !providerConfig) {
      throw new Error(`Unknown ${section} provider: ${provider}`);
    }
    if (providerConfig.enabled === false) {
      throw new Error(`Disabled ${section} provider cannot be selected: ${provider}`);
    }
    if (!raw[section]) raw[section] = structuredClone(settings.data[section]);
    raw[section].defaultProvider = provider;
  }

  const temporary = `${settings.source}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.renameSync(temporary, settings.source);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return loadSettings(settings.source);
}
