import fs from "node:fs";
import path from "node:path";
import { validateOperatingMode, resolveAutonomyPolicy } from "./policy.js";

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
  const sourceControl = normalizeProviderGroup(
    data.sourceControl,
    { defaultProvider: "local-git", providers: { "local-git": { type: "local-git" } } },
    "sourceControl",
    { allowEmpty: true }
  );
  return { workSource, orchestrator, executor, codeIntelligence, sourceControl };
}

function normalizePolicyConfig(policy, executor, project) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("policy config must be an object");
  }

  // Operating mode validation & conflict check
  const projMode = project?.operatingMode;
  const polMode = policy?.operatingMode;
  if (projMode !== undefined && polMode !== undefined && projMode !== polMode) {
    throw new Error(
      `Conflicting operatingMode definitions: project.operatingMode is '${projMode}' but policy.operatingMode is '${polMode}'`
    );
  }
  if (projMode !== undefined) {
    validateOperatingMode(projMode);
  }
  if (polMode !== undefined) {
    validateOperatingMode(polMode);
  }

  // Autonomy validation
  if (policy.autonomy !== undefined) {
    resolveAutonomyPolicy({ data: { project, policy } });
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
  normalizePolicyConfig(data.policy, providers.executor, data.project);
  if (
    data.controlPlane?.configMutationEnabled !== undefined &&
    typeof data.controlPlane.configMutationEnabled !== "boolean"
  ) {
    throw new Error("controlPlane.configMutationEnabled must be a boolean");
  }
  if (
    data.controlPlane?.providerConnectionMutationEnabled !== undefined &&
    typeof data.controlPlane.providerConnectionMutationEnabled !== "boolean"
  ) {
    throw new Error("controlPlane.providerConnectionMutationEnabled must be a boolean");
  }
  for (const field of ["executionMutationEnabled", "operatorInteractionMutationEnabled"]) {
    if (
      data.controlPlane?.[field] !== undefined &&
      typeof data.controlPlane[field] !== "boolean"
    ) {
      throw new Error(`controlPlane.${field} must be a boolean`);
    }
  }
  if (
    data.controlPlane?.trustedModelEndpoints !== undefined &&
    (!Array.isArray(data.controlPlane.trustedModelEndpoints) ||
      data.controlPlane.trustedModelEndpoints.some(value => typeof value !== "string"))
  ) {
    throw new Error("controlPlane.trustedModelEndpoints must be an array of exact URL origins");
  }
  const trustedModelEndpoints = (data.controlPlane?.trustedModelEndpoints || [])
    .map(parseLocalExecutorEndpointOrigin);
  const controlPlane = {
    configMutationEnabled: false,
    providerConnectionMutationEnabled: false,
    executionMutationEnabled: false,
    operatorInteractionMutationEnabled: false,
    trustedModelEndpoints,
    ...(data.controlPlane || {})
  };
  controlPlane.trustedModelEndpoints = trustedModelEndpoints;
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
  "codeIntelligence",
  "sourceControl"
]);

function writeSettingsData(source, raw) {
  const temporary = `${source}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.renameSync(temporary, source);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

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

  writeSettingsData(settings.source, raw);
  return loadSettings(settings.source);
}

function localEndpointHostKind(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)) {
    return "loopback";
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some(value => value > 255)) return null;
    if (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    ) return "private";
    return null;
  }
  if (host.endsWith(".local") || /^(?:fc|fd|fe[89ab])[0-9a-f:]*$/i.test(host)) return "private";
  return null;
}

function parseLocalExecutorEndpointOrigin(endpoint) {
  const raw = String(endpoint || "").trim().replace(/\/+$/, "");
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("Valid local model server URL is required"); }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Local model server URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Local model server URL cannot contain credentials");
  }
  if (parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("Enter only the local model server origin, without a path, query, or fragment");
  }
  return parsed.origin;
}

export function normalizeLocalExecutorEndpoint(endpoint, trustedModelEndpoints = []) {
  const origin = parseLocalExecutorEndpointOrigin(endpoint);
  const parsed = new URL(origin);
  const trusted = trustedModelEndpoints.map(parseLocalExecutorEndpointOrigin).includes(origin);
  if (!localEndpointHostKind(parsed.hostname) && !trusted) {
    throw new Error("Local model server must use localhost, a private network/VPN address, or an exact controlPlane.trustedModelEndpoints entry");
  }
  return origin;
}

export function isRemoteLocalExecutorEndpoint(endpoint, trustedModelEndpoints = []) {
  const parsed = new URL(normalizeLocalExecutorEndpoint(endpoint, trustedModelEndpoints));
  return localEndpointHostKind(parsed.hostname) !== "loopback";
}

export function updateLocalExecutorModel(settings, providerId, model, endpoint, remoteEndpointApproved = false) {
  if (!settings.data.controlPlane?.providerConnectionMutationEnabled) {
    throw new Error("Provider connection mutation is disabled");
  }
  const value = String(model || "").trim();
  if (!/^[A-Za-z0-9._:/-]{1,160}$/.test(value)) {
    throw new Error("Local model name is invalid");
  }
  const trustedModelEndpoints = settings.data.controlPlane?.trustedModelEndpoints || [];
  const normalizedEndpoint = normalizeLocalExecutorEndpoint(endpoint, trustedModelEndpoints);
  const remote = isRemoteLocalExecutorEndpoint(normalizedEndpoint, trustedModelEndpoints);
  if (remote && remoteEndpointApproved !== true) {
    throw new Error("Explicit approval is required before sending task data to a remote model server");
  }
  const provider = settings.data.executor?.providers?.[providerId];
  if (!provider || !["ollama", "lmstudio"].includes(provider.localProvider)) {
    throw new Error(`Unknown local executor provider: ${providerId}`);
  }
  const raw = JSON.parse(fs.readFileSync(settings.source, "utf8"));
  if (!raw.executor?.providers?.[providerId]) {
    throw new Error(`Local executor provider is missing from config: ${providerId}`);
  }
  raw.executor.providers[providerId] = {
    ...raw.executor.providers[providerId],
    enabled: true,
    endpoint: normalizedEndpoint,
    remoteEndpointApproved: remote,
    defaultModel: value,
    modelProfiles: {
      ...(raw.executor.providers[providerId].modelProfiles || {}),
      low: value,
      medium: value,
      high: value
    }
  };
  writeSettingsData(settings.source, raw);
  return loadSettings(settings.source);
}

export function selectLocalExecutor(settings, providerId) {
  if (!settings.data.controlPlane?.providerConnectionMutationEnabled) {
    throw new Error("Provider connection mutation is disabled");
  }
  const provider = settings.data.executor?.providers?.[providerId];
  if (
    !provider ||
    !["ollama", "lmstudio"].includes(provider.localProvider) ||
    provider.enabled === false ||
    !provider.defaultModel ||
    !provider.endpoint
  ) {
    throw new Error(`Local executor provider is not ready: ${providerId}`);
  }
  const trustedModelEndpoints = settings.data.controlPlane?.trustedModelEndpoints || [];
  if (isRemoteLocalExecutorEndpoint(provider.endpoint, trustedModelEndpoints) && provider.remoteEndpointApproved !== true) {
    throw new Error(`Remote local executor endpoint is not approved: ${providerId}`);
  }
  const raw = JSON.parse(fs.readFileSync(settings.source, "utf8"));
  if (!raw.executor?.providers?.[providerId]) {
    throw new Error(`Local executor provider is missing from config: ${providerId}`);
  }
  raw.executor.defaultProvider = providerId;
  writeSettingsData(settings.source, raw);
  return loadSettings(settings.source);
}
