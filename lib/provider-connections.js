import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { isRemoteLocalExecutorEndpoint, normalizeLocalExecutorEndpoint } from "./config.js";
import { JiraClient } from "./jira.js";

const CONNECTION_IDS = Object.freeze([
  "jira", "github", "notion", "linear",
  "codex", "claude", "gemini", "antigravity",
  "ollama", "lmstudio"
]);
const STATUS_CACHE_MS = 30_000;
const NOTION_API_VERSION = "2026-03-11";
const TOKEN_CONNECTIONS = Object.freeze({
  github: {
    displayName: "GitHub Issues",
    envNames: ["GITHUB_TOKEN"],
    guidance: "Fine-grained veya classic GitHub token ile bağlanın."
  },
  notion: {
    displayName: "Notion",
    envNames: ["NOTION_API_TOKEN", "NOTION_TOKEN"],
    guidance: "Notion internal integration veya personal access token ile bağlanın."
  },
  linear: {
    displayName: "Linear",
    envNames: ["LINEAR_API_KEY"],
    guidance: "Linear personal API key ile bağlanın."
  }
});
const LOCAL_PROVIDERS = Object.freeze({
  ollama: {
    displayName: "Ollama",
    command: "ollama",
    defaultEndpoint: "http://127.0.0.1:11434",
    discoveryPath: "/api/tags"
  },
  lmstudio: {
    displayName: "LM Studio",
    command: "lms",
    defaultEndpoint: "http://127.0.0.1:1234",
    discoveryPath: "/api/v0/models"
  }
});

function safeError(error, fallback = "Provider connection failed") {
  return String(error?.message || fallback)
    .replace(/\b(Bearer\s+)[A-Za-z0-9_.-]{8,}\b/gi, "$1[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/gi, "[redacted]")
    .slice(0, 300);
}

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShell(script, input, runtime) {
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script)];
  const options = {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  };
  for (const command of ["pwsh.exe", "powershell.exe"]) {
    let result;
    try {
      result = runtime.spawnSync(command, args, options);
    } catch {
      continue;
    }
    if (result?.status === 0) {
      return String(result.stdout || "").trim();
    }
  }
  throw new Error("Windows credential protection failed");
}

function windowsProtect(value, runtime) {
  return runPowerShell(
    "$plain=[Console]::In.ReadToEnd();$secure=ConvertTo-SecureString -String $plain -AsPlainText -Force;[Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))",
    value,
    runtime
  );
}

function windowsUnprotect(value, runtime) {
  return runPowerShell(
    "$cipher=[Console]::In.ReadToEnd();$secure=ConvertTo-SecureString -String $cipher;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}",
    value,
    runtime
  );
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

export class ProviderCredentialVault {
  constructor(settings, options = {}) {
    this.file = options.file || path.join(path.dirname(settings.source), ".agent-runtime", "provider-credentials.json");
    this.platform = options.platform || process.platform;
    this.runtime = { spawnSync: options.spawnSync || spawnSync };
    this.protect = options.protect || ((value) => windowsProtect(value, this.runtime));
    this.unprotect = options.unprotect || ((value) => windowsUnprotect(value, this.runtime));
    this.supported = Boolean(options.protect && options.unprotect) || this.platform === "win32";
  }

  readDocument() {
    if (!fs.existsSync(this.file)) return { version: 1, entries: {} };
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      throw new Error("Provider credential vault format is invalid");
    }
    return parsed;
  }

  has(providerId) {
    return Boolean(this.readDocument().entries[providerId]);
  }

  read(providerId) {
    const entry = this.readDocument().entries[providerId];
    if (!entry) return null;
    if (!this.supported || entry.protection !== "windows-dpapi") {
      throw new Error("Stored provider credentials are not supported on this platform");
    }
    try {
      return JSON.parse(this.unprotect(entry.ciphertext));
    } catch {
      throw new Error("Stored provider credentials could not be decrypted");
    }
  }

  save(providerId, payload) {
    if (!this.supported) {
      throw new Error("Secure provider credential storage is unavailable on this platform; use environment variables instead");
    }
    const document = this.readDocument();
    document.entries[providerId] = {
      protection: "windows-dpapi",
      ciphertext: this.protect(JSON.stringify(payload)),
      updatedAt: new Date().toISOString()
    };
    atomicWriteJson(this.file, document);
  }

  delete(providerId) {
    const document = this.readDocument();
    if (!document.entries[providerId]) return false;
    delete document.entries[providerId];
    atomicWriteJson(this.file, document);
    return true;
  }
}

function jiraConfig(settings, providerId = "jira") {
  return settings.data.workSource?.providers?.[providerId]
    || (providerId === "jira" ? settings.data.jira : null)
    || null;
}

export function resolveJiraProviderConnection(settings, providerId, config, environment = process.env, options = {}) {
  const emailEnv = config.emailEnv || "ATLASSIAN_EMAIL";
  const tokenEnv = config.tokenEnv || "ATLASSIAN_API_TOKEN";
  const normalizedConfig = { ...config, emailEnv, tokenEnv };
  if (environment[emailEnv] && environment[tokenEnv]) {
    return { config: normalizedConfig, environment, source: "environment" };
  }
  const vault = options.vault || new ProviderCredentialVault(settings, options.vaultOptions);
  const stored = vault.read(providerId);
  if (!stored) return { config: normalizedConfig, environment, source: null };
  return {
    config: { ...normalizedConfig, baseUrl: stored.baseUrl || config.baseUrl },
    environment: { ...environment, [emailEnv]: stored.email, [tokenEnv]: stored.token },
    source: "vault"
  };
}

export function resolveTokenProviderConnection(settings, vaultId, config, environment = process.env, options = {}) {
  const tokenEnv = config.tokenEnv || options.defaultTokenEnv;
  if (!tokenEnv) return { config, environment, source: null };
  if (environment[tokenEnv]) return { config, environment, source: "environment" };
  if (!options.vault && !settings?.source) return { config: { ...config, tokenEnv }, environment, source: null };
  const vault = options.vault || new ProviderCredentialVault(settings, options.vaultOptions);
  const stored = vault.read(vaultId);
  if (!stored?.token) return { config, environment, source: null };
  return {
    config: { ...config, tokenEnv },
    environment: { ...environment, [tokenEnv]: stored.token },
    source: "vault"
  };
}

function commandExists(command, runtime, platform) {
  const finder = platform === "win32" ? "where" : "which";
  return runtime.spawnSync(finder, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

function commandReady(command, args, runtime) {
  const result = runtime.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024
  });
  return result.status === 0;
}

function normalizeJiraInput(input) {
  const baseUrl = String(input?.baseUrl || "").trim().replace(/\/$/, "");
  const email = String(input?.email || "").trim();
  const token = String(input?.token || "").trim();
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error("Valid Jira site URL is required"); }
  if (parsed.protocol !== "https:") throw new Error("Jira site URL must use HTTPS");
  if (!email.includes("@")) throw new Error("Valid Jira account email is required");
  if (token.length < 8) throw new Error("Jira API token is required");
  return { baseUrl, email, token };
}

function normalizeTokenInput(input, displayName) {
  const token = String(input?.token || "").trim();
  if (token.length < 8 || token.length > 4096) {
    throw new Error(`${displayName} token is required`);
  }
  return { token };
}

function firstEnvironmentValue(environment, names) {
  for (const name of names) {
    if (environment[name]) return { name, value: environment[name] };
  }
  return null;
}

function configuredWorkSource(settings, id) {
  return Boolean(settings.data.workSource?.providers?.[id]);
}

function executorConfigured(settings, id) {
  return Boolean(settings.data.executor?.providers?.[id] || settings.data.executor?.[id]);
}

export function createProviderConnectionService(settings, options = {}) {
  const environment = options.environment || process.env;
  const platform = options.platform || process.platform;
  const runtime = {
    spawnSync: options.spawnSync || spawnSync,
    spawn: options.spawn || spawn
  };
  const fetchFn = options.fetch || globalThis.fetch;
  const configureLocalExecutor = options.configureLocalExecutor;
  const selectLocalExecutor = options.selectLocalExecutor;
  const vault = options.vault || new ProviderCredentialVault(settings, {
    platform,
    spawnSync: runtime.spawnSync,
    ...options.vaultOptions
  });
  const jiraClientFactory = options.jiraClientFactory || ((config, env) => new JiraClient(config, env));
  const cache = new Map();
  const lastTests = new Map();

  function cliStatus(id, command, args) {
    const cached = cache.get(id);
    if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.value;
    const installed = commandExists(command, runtime, platform);
    const connected = installed ? commandReady(command, args, runtime) : false;
    const value = { installed, connected };
    cache.set(id, { at: Date.now(), value });
    return value;
  }

  function jiraStatus() {
    const config = jiraConfig(settings);
    if (!config) return { configured: false, source: null, site: null };
    const emailEnv = config.emailEnv || "ATLASSIAN_EMAIL";
    const tokenEnv = config.tokenEnv || "ATLASSIAN_API_TOKEN";
    const source = environment[emailEnv] && environment[tokenEnv]
      ? "environment"
      : (vault.has("jira") ? "vault" : null);
    return { configured: Boolean(source), source, site: config.baseUrl || null };
  }

  async function testJira(input = null) {
    const config = jiraConfig(settings);
    if (!config) throw new Error("Jira provider is not configured");
    let effectiveConfig = config;
    let effectiveEnvironment = environment;
    if (input) {
      const credentials = normalizeJiraInput(input);
      const emailEnv = config.emailEnv || "ATLASSIAN_EMAIL";
      const tokenEnv = config.tokenEnv || "ATLASSIAN_API_TOKEN";
      effectiveConfig = { ...config, baseUrl: credentials.baseUrl };
      effectiveEnvironment = { ...environment, [emailEnv]: credentials.email, [tokenEnv]: credentials.token };
    } else {
      const resolved = resolveJiraProviderConnection(settings, "jira", config, environment, { vault });
      effectiveConfig = resolved.config;
      effectiveEnvironment = resolved.environment;
    }
    const client = jiraClientFactory(effectiveConfig, effectiveEnvironment);
    await client.request("GET", "/rest/api/3/myself");
    const result = { ok: true, status: "connected", site: effectiveConfig.baseUrl };
    lastTests.set("jira", result);
    return result;
  }

  function tokenStatus(id) {
    const spec = TOKEN_CONNECTIONS[id];
    const githubEnv = id === "github"
      ? settings.data.workSource?.providers?.["github-issues"]?.tokenEnv
      : null;
    const envNames = [githubEnv, ...spec.envNames].filter(Boolean);
    const environmentCredential = firstEnvironmentValue(environment, envNames);
    const source = environmentCredential ? "environment" : (vault.has(id) ? "vault" : null);
    return { configured: Boolean(source), source, envNames, environmentCredential };
  }

  async function requestJson(url, requestOptions, label) {
    if (typeof fetchFn !== "function") throw new Error(`${label} connection testing is unavailable`);
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(5000)
      : undefined;
    let response;
    try {
      response = await fetchFn(url, { ...requestOptions, redirect: "error", signal });
    } catch {
      throw new Error(`${label} connection could not be reached`);
    }
    if (!response.ok) throw new Error(`${label} connection failed: ${response.status}`);
    return response.json();
  }

  async function testTokenConnection(id, input = null) {
    const spec = TOKEN_CONNECTIONS[id];
    if (!spec) throw new Error(`Unknown token provider: ${id}`);
    const status = tokenStatus(id);
    const token = input
      ? normalizeTokenInput(input, spec.displayName).token
      : (status.environmentCredential?.value || vault.read(id)?.token);
    if (!token) throw new Error(`${spec.displayName} credentials are not configured`);
    let identity = null;
    if (id === "github") {
      const config = settings.data.workSource?.providers?.["github-issues"] || {};
      const result = await requestJson(`${config.baseUrl || "https://api.github.com"}/user`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": config.apiVersion || "2022-11-28",
          "User-Agent": "agent-scaffold"
        }
      }, spec.displayName);
      identity = result.login || null;
    } else if (id === "notion") {
      const result = await requestJson("https://api.notion.com/v1/users/me", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_API_VERSION
        }
      }, spec.displayName);
      identity = result.bot?.workspace_name || result.name || null;
    } else {
      const result = await requestJson("https://api.linear.app/graphql", {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query Me { viewer { id name } }" })
      }, spec.displayName);
      if (Array.isArray(result.errors) && result.errors.length) {
        throw new Error("Linear connection failed");
      }
      identity = result.data?.viewer?.name || null;
    }
    const result = { ok: true, status: "connected", identity };
    lastTests.set(id, result);
    return result;
  }

  function localEndpoint(id, value = null, remoteApproved = null) {
    const config = settings.data.executor?.providers?.[id] || {};
    const trustedModelEndpoints = settings.data.controlPlane?.trustedModelEndpoints || [];
    const endpoint = normalizeLocalExecutorEndpoint(
      value || config.endpoint || LOCAL_PROVIDERS[id].defaultEndpoint,
      trustedModelEndpoints
    );
    const approved = remoteApproved === true || (endpoint === config.endpoint && config.remoteEndpointApproved === true);
    if (isRemoteLocalExecutorEndpoint(endpoint, trustedModelEndpoints) && !approved) {
      throw new Error("Confirm that task and code context may be sent to this trusted private model server");
    }
    return endpoint;
  }

  async function localStatus(id, endpoint, force = false) {
    const normalizedEndpoint = normalizeLocalExecutorEndpoint(
      endpoint,
      settings.data.controlPlane?.trustedModelEndpoints || []
    );
    const key = `local:${id}:${normalizedEndpoint}`;
    const cached = cache.get(key);
    if (!force && cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.value;
    const spec = LOCAL_PROVIDERS[id];
    const installed = commandExists(spec.command, runtime, platform);
    let connected = false;
    let models = [];
    try {
      const result = await requestJson(`${normalizedEndpoint}${spec.discoveryPath}`, {}, spec.displayName);
      models = id === "ollama"
        ? (result.models || []).map(item => item.name || item.model).filter(Boolean)
        : (result.data || []).filter(item => !item.type || item.type === "llm").map(item => item.id).filter(Boolean);
      connected = true;
    } catch {
      connected = false;
    }
    const value = { installed, connected, models: [...new Set(models)].sort(), endpoint: normalizedEndpoint };
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  function tokenConnectionEntry(id) {
    const spec = TOKEN_CONNECTIONS[id];
    const status = tokenStatus(id);
    const tested = lastTests.get(id);
    const runtimeAvailable = id === "github" && configuredWorkSource(settings, "github-issues");
    return {
      id,
      displayName: spec.displayName,
      category: "work-tools",
      kind: id === "github" ? "work-source" : "integration",
      installed: true,
      configured: status.configured,
      connected: tested?.ok === true,
      status: tested?.ok ? "connected" : (status.configured ? "configured" : "not_configured"),
      credentialSource: status.source,
      identity: tested?.identity || null,
      canConnect: vault.supported && status.source !== "environment",
      runtimeAvailable,
      guidance: status.source === "environment"
        ? `${spec.displayName} bağlantısı ortam değişkenleri tarafından yönetiliyor.`
        : (status.configured ? "Bağlantıyı test edin." : spec.guidance)
    };
  }

  return {
    async list() {
      const jira = jiraStatus();
      const codex = cliStatus("codex", "codex", ["login", "status"]);
      const claude = cliStatus("claude", "claude", ["auth", "status"]);
      const gemini = cliStatus("gemini", "gemini", ["--version"]);
      const antigravity = cliStatus("antigravity", "agy", ["models"]);
      const ollamaEndpoint = localEndpoint("ollama");
      const lmstudioEndpoint = localEndpoint("lmstudio");
      const [ollama, lmstudio] = await Promise.all([
        localStatus("ollama", ollamaEndpoint),
        localStatus("lmstudio", lmstudioEndpoint)
      ]);
      const localEntry = (id, local) => {
        const config = settings.data.executor?.providers?.[id] || {};
        const configured = config.enabled !== false && Boolean(config.defaultModel);
        return {
          id,
          displayName: LOCAL_PROVIDERS[id].displayName,
          category: "local-ai",
          kind: "executor",
          installed: local.installed,
          configured,
          connected: local.connected,
          status: local.connected ? (local.models.length ? "connected" : "no_models") : (local.installed ? "not_running" : "not_installed"),
          selected: settings.data.executor?.defaultProvider === id,
          canConnect: Boolean(settings.data.executor?.providers?.[id]),
          canSelect: local.connected && configured,
          loginSupported: false,
          models: local.models,
          selectedModel: config.defaultModel || null,
          endpoint: local.endpoint,
          remote: isRemoteLocalExecutorEndpoint(local.endpoint, settings.data.controlPlane?.trustedModelEndpoints || []),
          remoteEndpointApproved: config.remoteEndpointApproved === true,
          guidance: local.connected
            ? (local.models.length ? "Bu makinedeki veya özel ağdaki modeli seçip Codex agent executor olarak kaydedin." : "Sunucu açık fakat kullanılabilir model bulunamadı.")
            : `${LOCAL_PROVIDERS[id].displayName} sunucu adresini girin ve model listesini yenileyin.`
        };
      };
      return {
        mutationEnabled: Boolean(settings.data.controlPlane?.providerConnectionMutationEnabled),
        secureStore: { supported: vault.supported, type: vault.supported ? "windows-dpapi" : "environment-only" },
        connections: [
          {
            id: "jira", displayName: "Jira", category: "work-tools", kind: "work-source",
            installed: true, configured: jira.configured,
            connected: lastTests.get("jira")?.ok === true,
            status: lastTests.get("jira")?.ok ? "connected" : (jira.configured ? "configured" : "not_configured"),
            credentialSource: jira.source, site: jira.site,
            canConnect: vault.supported && jira.source !== "environment",
            runtimeAvailable: Boolean(jiraConfig(settings)),
            guidance: jira.source === "environment"
              ? "Jira bağlantısı ortam değişkenleri tarafından yönetiliyor."
              : (jira.configured ? "Bağlantıyı test edin." : "Jira site, e-posta ve API token bilgilerini girin.")
          },
          tokenConnectionEntry("github"),
          tokenConnectionEntry("notion"),
          tokenConnectionEntry("linear"),
          {
            id: "codex", displayName: "Codex", category: "ai-tools", kind: "executor",
            installed: codex.installed, configured: executorConfigured(settings, "codex"), connected: codex.connected,
            status: !codex.installed ? "not_installed" : (codex.connected ? "connected" : "not_authenticated"),
            selected: settings.data.executor?.defaultProvider === "codex",
            canConnect: codex.installed, loginSupported: codex.installed,
            guidance: codex.installed ? "Codex kendi güvenli login ve OS credential store akışını kullanır." : "Codex CLI kurulumu gerekli."
          },
          {
            id: "claude", displayName: "Claude Code", category: "ai-tools", kind: "executor",
            installed: claude.installed, configured: executorConfigured(settings, "claude"), connected: claude.connected,
            status: !claude.installed ? "not_installed" : (claude.connected ? "connected" : "not_authenticated"),
            selected: settings.data.executor?.defaultProvider === "claude",
            canConnect: false, loginSupported: false,
            guidance: claude.installed ? "Claude Code oturumunu CLI içinden tamamlayın." : "Claude Code CLI kurulu değil."
          },
          {
            id: "gemini", displayName: "Gemini CLI", category: "ai-tools", kind: "executor",
            installed: gemini.installed, configured: executorConfigured(settings, "gemini"), connected: false,
            status: gemini.installed ? "installed" : "not_installed",
            selected: settings.data.executor?.defaultProvider === "gemini",
            canConnect: false, loginSupported: false,
            guidance: gemini.installed ? "Gemini CLI oturumunu terminalde gemini komutuyla yönetin." : "Gemini CLI kurulu değil."
          },
          {
            id: "antigravity", displayName: "Antigravity", category: "ai-tools", kind: "executor",
            installed: antigravity.installed, configured: executorConfigured(settings, "antigravity"), connected: antigravity.connected,
            status: !antigravity.installed ? "not_installed" : (antigravity.connected ? "connected" : "not_authenticated"),
            selected: settings.data.executor?.defaultProvider === "antigravity",
            canConnect: false, loginSupported: false,
            guidance: "Antigravity oturumu agy/Antigravity uygulaması tarafından yönetilir."
          },
          localEntry("ollama", ollama),
          localEntry("lmstudio", lmstudio)
        ]
      };
    },

    async test(id, input = null) {
      if (!CONNECTION_IDS.includes(id)) throw new Error(`Unknown provider connection: ${id}`);
      if (id === "jira") return testJira();
      if (TOKEN_CONNECTIONS[id]) return testTokenConnection(id);
      if (LOCAL_PROVIDERS[id]) {
        const endpoint = localEndpoint(id, input?.endpoint, input?.trustRemoteEndpoint);
        const local = await localStatus(id, endpoint, true);
        if (!local.connected) throw new Error(`${LOCAL_PROVIDERS[id].displayName} server is not running`);
        if (!local.models.length) throw new Error(`${LOCAL_PROVIDERS[id].displayName} has no local models`);
        return { ok: true, status: "connected", models: local.models, endpoint };
      }
      if (id === "gemini") {
        if (!commandExists("gemini", runtime, platform)) throw new Error("gemini CLI is not installed");
        if (!commandReady("gemini", ["--version"], runtime)) throw new Error("gemini CLI is not ready");
        cache.set(id, { at: Date.now(), value: { installed: true, connected: false } });
        return {
          ok: true,
          status: "installed",
          guidance: "Gemini CLI kurulu. Oturum açmayı terminalde gemini komutuyla tamamlayın."
        };
      }
      const command = id === "codex" ? "codex" : id === "claude" ? "claude" : id === "gemini" ? "gemini" : "agy";
      const args = id === "codex" ? ["login", "status"] : id === "claude" ? ["auth", "status"] : id === "gemini" ? ["--version"] : ["models"];
      if (!commandExists(command, runtime, platform)) throw new Error(`${id} CLI is not installed`);
      const connected = commandReady(command, args, runtime);
      cache.set(id, { at: Date.now(), value: { installed: true, connected } });
      if (!connected) throw new Error(`${id} authentication is not ready`);
      return { ok: true, status: "connected" };
    },

    async connect(id, input) {
      if (id === "jira") {
        if (jiraStatus().source === "environment") {
          throw new Error("Jira credentials are managed by environment variables");
        }
        const credentials = normalizeJiraInput(input);
        await testJira(credentials);
        vault.save("jira", credentials);
        return { ok: true, status: "connected", site: credentials.baseUrl, credentialSource: "vault" };
      }
      if (TOKEN_CONNECTIONS[id]) {
        const status = tokenStatus(id);
        if (status.source === "environment") {
          throw new Error(`${TOKEN_CONNECTIONS[id].displayName} credentials are managed by environment variables`);
        }
        const credentials = normalizeTokenInput(input, TOKEN_CONNECTIONS[id].displayName);
        const tested = await testTokenConnection(id, credentials);
        vault.save(id, credentials);
        return { ...tested, credentialSource: "vault" };
      }
      if (LOCAL_PROVIDERS[id]) {
        const model = String(input?.model || "").trim();
        const endpoint = localEndpoint(id, input?.endpoint, input?.trustRemoteEndpoint);
        const remoteApproved = !isRemoteLocalExecutorEndpoint(
          endpoint,
          settings.data.controlPlane?.trustedModelEndpoints || []
        ) || input?.trustRemoteEndpoint === true;
        const local = await localStatus(id, endpoint, true);
        if (!local.connected) throw new Error(`${LOCAL_PROVIDERS[id].displayName} server is not running`);
        if (!local.models.includes(model)) throw new Error("Select an available local model");
        if (typeof configureLocalExecutor !== "function") throw new Error("Local executor configuration is unavailable");
        await configureLocalExecutor(id, model, endpoint, remoteApproved);
        cache.delete(`local:${id}:${endpoint}`);
        return { ok: true, status: "connected", model, endpoint };
      }
      if (id === "codex") {
        if (!commandExists("codex", runtime, platform)) throw new Error("Codex CLI is not installed");
        const child = runtime.spawn("codex", ["login"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
        if (typeof child.once === "function") {
          await new Promise((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", () => reject(new Error("Codex login could not be started")));
          });
        }
        child.unref?.();
        cache.delete("codex");
        return { ok: true, status: "login_started", guidance: "Tarayıcıdaki Codex girişini tamamlayın, sonra Test Et seçeneğini kullanın." };
      }
      throw new Error(`${id} login must be completed in its own CLI or desktop application`);
    },

    async select(id) {
      if (!LOCAL_PROVIDERS[id]) throw new Error(`Provider cannot be selected as a local executor: ${id}`);
      const config = settings.data.executor?.providers?.[id];
      const endpoint = localEndpoint(id, config?.endpoint, config?.remoteEndpointApproved);
      const local = await localStatus(id, endpoint, true);
      if (!local.connected) throw new Error(`${LOCAL_PROVIDERS[id].displayName} server is not running`);
      if (!config?.defaultModel || !local.models.includes(config.defaultModel)) {
        throw new Error("Configure an available local model before selecting this executor");
      }
      if (typeof selectLocalExecutor !== "function") throw new Error("Local executor selection is unavailable");
      await selectLocalExecutor(id);
      return { ok: true, status: "selected", provider: id, model: config.defaultModel };
    },

    async disconnect(id) {
      if (id !== "jira" && !TOKEN_CONNECTIONS[id]) throw new Error(`${id} credentials are managed by its own CLI or local server`);
      const status = id === "jira" ? jiraStatus() : tokenStatus(id);
      if (status.source === "environment") throw new Error(`${id} credentials are managed by environment variables`);
      const removed = vault.delete(id);
      lastTests.delete(id);
      return { ok: true, removed };
    },

    safeError
  };
}
