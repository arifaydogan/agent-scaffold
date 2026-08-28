import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { JiraClient } from "./jira.js";

const CONNECTION_IDS = Object.freeze(["jira", "codex", "claude", "antigravity"]);
const STATUS_CACHE_MS = 30_000;

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
  const result = runtime.spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script)],
    {
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    }
  );
  if (result.status !== 0) {
    throw new Error("Windows credential protection failed");
  }
  return String(result.stdout || "").trim();
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
    let site = config.baseUrl || null;
    if (source === "vault") {
      try { site = vault.read("jira")?.baseUrl || site; } catch {}
    }
    return { configured: Boolean(source), source, site };
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

  return {
    async list() {
      const jira = jiraStatus();
      const codex = cliStatus("codex", "codex", ["login", "status"]);
      const claude = cliStatus("claude", "claude", ["auth", "status"]);
      const antigravity = cliStatus("antigravity", "agy", ["models"]);
      return {
        mutationEnabled: Boolean(settings.data.controlPlane?.providerConnectionMutationEnabled),
        secureStore: { supported: vault.supported, type: vault.supported ? "windows-dpapi" : "environment-only" },
        connections: [
          {
            id: "jira", displayName: "Jira", kind: "work-source",
            installed: true, configured: jira.configured,
            connected: lastTests.get("jira")?.ok === true,
            status: lastTests.get("jira")?.ok ? "connected" : (jira.configured ? "configured" : "not_configured"),
            credentialSource: jira.source, site: jira.site,
            canConnect: vault.supported && jira.source !== "environment",
            guidance: jira.source === "environment"
              ? "Jira bağlantısı ortam değişkenleri tarafından yönetiliyor."
              : (jira.configured ? "Bağlantıyı test edin." : "Jira site, e-posta ve API token bilgilerini girin.")
          },
          {
            id: "codex", displayName: "Codex", kind: "executor",
            installed: codex.installed, configured: executorConfigured(settings, "codex"), connected: codex.connected,
            status: !codex.installed ? "not_installed" : (codex.connected ? "connected" : "not_authenticated"),
            selected: settings.data.executor?.defaultProvider === "codex",
            canConnect: codex.installed, loginSupported: codex.installed,
            guidance: codex.installed ? "Codex kendi güvenli login ve OS credential store akışını kullanır." : "Codex CLI kurulumu gerekli."
          },
          {
            id: "claude", displayName: "Claude Code", kind: "executor",
            installed: claude.installed, configured: executorConfigured(settings, "claude"), connected: claude.connected,
            status: !claude.installed ? "not_installed" : (claude.connected ? "connected" : "not_authenticated"),
            selected: settings.data.executor?.defaultProvider === "claude",
            canConnect: false, loginSupported: false,
            guidance: claude.installed ? "Claude Code oturumunu CLI içinden tamamlayın." : "Claude Code CLI kurulu değil."
          },
          {
            id: "antigravity", displayName: "Antigravity", kind: "executor",
            installed: antigravity.installed, configured: executorConfigured(settings, "antigravity"), connected: antigravity.connected,
            status: !antigravity.installed ? "not_installed" : (antigravity.connected ? "connected" : "not_authenticated"),
            selected: settings.data.executor?.defaultProvider === "antigravity",
            canConnect: false, loginSupported: false,
            guidance: "Antigravity oturumu agy/Antigravity uygulaması tarafından yönetilir."
          }
        ]
      };
    },

    async test(id) {
      if (!CONNECTION_IDS.includes(id)) throw new Error(`Unknown provider connection: ${id}`);
      if (id === "jira") return testJira();
      const command = id === "codex" ? "codex" : id === "claude" ? "claude" : "agy";
      const args = id === "codex" ? ["login", "status"] : id === "claude" ? ["auth", "status"] : ["models"];
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

    async disconnect(id) {
      if (id !== "jira") throw new Error(`${id} credentials are managed by its own CLI`);
      const status = jiraStatus();
      if (status.source === "environment") throw new Error("Jira credentials are managed by environment variables");
      const removed = vault.delete("jira");
      lastTests.delete("jira");
      return { ok: true, removed };
    },

    safeError
  };
}
