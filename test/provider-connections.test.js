import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  ProviderCredentialVault,
  createProviderConnectionService,
  resolveJiraProviderConnection,
  resolveTokenProviderConnection
} from "../lib/provider-connections.js";

function testSettings(directory) {
  return {
    source: path.join(directory, "agent-scaffold.json"),
    data: {
      controlPlane: { providerConnectionMutationEnabled: true },
      workSource: {
        defaultProvider: "jira",
        providers: {
          jira: {
            type: "jira",
            baseUrl: "https://example.atlassian.net",
            emailEnv: "JIRA_EMAIL",
            tokenEnv: "JIRA_TOKEN"
          },
          "github-issues": {
            type: "github-issues",
            baseUrl: "https://api.github.com",
            tokenEnv: "GITHUB_TOKEN"
          }
        }
      },
      executor: {
        defaultProvider: "codex",
        providers: {
          codex: {},
          antigravity: {},
          ollama: { enabled: false, localProvider: "ollama", endpoint: "http://127.0.0.1:11434", remoteEndpointApproved: false, modelProfiles: {} },
          lmstudio: { enabled: false, localProvider: "lmstudio", endpoint: "http://127.0.0.1:1234", remoteEndpointApproved: false, modelProfiles: {} }
        }
      }
    }
  };
}

test("provider credential vault encrypts payload and never persists Jira secrets as plaintext", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-vault-"));
  const settings = testSettings(directory);
  const vault = new ProviderCredentialVault(settings, {
    platform: "test",
    protect: value => Buffer.from(value, "utf8").toString("base64"),
    unprotect: value => Buffer.from(value, "base64").toString("utf8")
  });
  vault.save("jira", {
    baseUrl: "https://example.atlassian.net",
    email: "agent@example.com",
    token: "jira-super-secret-token"
  });

  const raw = fs.readFileSync(vault.file, "utf8");
  assert.equal(raw.includes("agent@example.com"), false);
  assert.equal(raw.includes("jira-super-secret-token"), false);
  assert.equal(vault.read("jira").email, "agent@example.com");
  assert.equal(vault.delete("jira"), true);
  assert.equal(vault.has("jira"), false);
});

test("provider credential vault prefers PowerShell 7 and falls back to Windows PowerShell", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-vault-powershell-"));
  const settings = testSettings(directory);
  const commands = [];
  let operation = "protect";
  const vault = new ProviderCredentialVault(settings, {
    platform: "win32",
    spawnSync: (command, _args, options) => {
      commands.push(command);
      if (command === "pwsh.exe" && operation === "protect") {
        return { status: 0, stdout: Buffer.from(options.input, "utf8").toString("base64") };
      }
      if (command === "pwsh.exe" && operation === "unprotect") {
        return { status: 1, stdout: "", stderr: "module unavailable" };
      }
      return { status: 0, stdout: Buffer.from(options.input, "base64").toString("utf8") };
    }
  });

  vault.save("jira", { baseUrl: "https://example.atlassian.net", email: "dummy@example.com", token: "dummy-token" });
  operation = "unprotect";
  assert.equal(vault.read("jira").token, "dummy-token");
  assert.deepEqual(commands, ["pwsh.exe", "pwsh.exe", "powershell.exe"]);
});
test("Jira connection resolution prefers environment and falls back to the secure vault", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-resolution-"));
  const settings = testSettings(directory);
  const config = settings.data.workSource.providers.jira;
  const vault = {
    read: () => ({ baseUrl: "https://vault.atlassian.net", email: "vault@example.com", token: "vault-token" })
  };

  const environment = resolveJiraProviderConnection(settings, "jira", config, {
    JIRA_EMAIL: "env@example.com", JIRA_TOKEN: "env-token"
  }, { vault });
  assert.equal(environment.source, "environment");
  assert.equal(environment.config.baseUrl, "https://example.atlassian.net");

  const stored = resolveJiraProviderConnection(settings, "jira", config, {}, { vault });
  assert.equal(stored.source, "vault");
  assert.equal(stored.config.baseUrl, "https://vault.atlassian.net");
  assert.equal(stored.environment.JIRA_EMAIL, "vault@example.com");
  assert.equal(stored.environment.JIRA_TOKEN, "vault-token");
});

test("token connection resolution prefers environment and falls back to the secure vault", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-token-resolution-"));
  const settings = testSettings(directory);
  const config = settings.data.workSource.providers["github-issues"];
  const vault = { read: id => id === "github" ? { token: "vault-token" } : null };
  const environment = resolveTokenProviderConnection(settings, "github", config, { GITHUB_TOKEN: "env-token" }, { vault });
  assert.equal(environment.source, "environment");
  const stored = resolveTokenProviderConnection(settings, "github", config, {}, { vault });
  assert.equal(stored.source, "vault");
  assert.equal(stored.environment.GITHUB_TOKEN, "vault-token");
});

test("provider connection service validates Jira before saving and uses native CLI auth checks", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-service-"));
  const settings = testSettings(directory);
  const entries = new Map();
  const vault = {
    supported: true,
    has: id => entries.has(id),
    read: id => entries.get(id) || null,
    save: (id, value) => entries.set(id, value),
    delete: id => entries.delete(id)
  };
  const cliCalls = [];
  const spawned = [];
  const spawnSync = (command, args) => {
    cliCalls.push([command, args]);
    if (command === "where") return { status: args[0] === "claude" ? 1 : 0, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const service = createProviderConnectionService(settings, {
    environment: {},
    platform: "win32",
    vault,
    spawnSync,
    spawn: (command, args) => {
      spawned.push([command, args]);
      return { unref() {} };
    },
    fetch: async () => ({ ok: false, status: 503, async json() { return {}; } }),
    jiraClientFactory: (config, environment) => ({
      async request(method, route) {
        assert.equal(method, "GET");
        assert.equal(route, "/rest/api/3/myself");
        assert.equal(config.baseUrl, "https://example.atlassian.net");
        assert.equal(environment.JIRA_EMAIL, "agent@example.com");
        assert.equal(environment.JIRA_TOKEN, "jira-test-token");
      }
    })
  });

  const initial = await service.list();
  assert.equal(initial.connections.find(item => item.id === "codex").connected, true);
  assert.equal(initial.connections.find(item => item.id === "claude").installed, false);
  assert.equal(initial.connections.find(item => item.id === "antigravity").connected, true);

  const jira = await service.connect("jira", {
    baseUrl: "https://example.atlassian.net",
    email: "agent@example.com",
    token: "jira-test-token"
  });
  assert.equal(jira.status, "connected");
  assert.equal(entries.get("jira").token, "jira-test-token");

  await service.test("codex");
  const login = await service.connect("codex", {});
  assert.equal(login.status, "login_started");
  assert.deepEqual(spawned, [["codex", ["login"]]]);
  assert.ok(cliCalls.some(([command, args]) => command === "agy" && args[0] === "models"));
});

test("environment-managed Jira credentials cannot be overwritten from the dashboard", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-env-managed-"));
  const settings = testSettings(directory);
  let saved = false;
  const service = createProviderConnectionService(settings, {
    environment: { JIRA_EMAIL: "env@example.com", JIRA_TOKEN: "env-token" },
    vault: {
      supported: true,
      has: () => false,
      read: () => null,
      save: () => { saved = true; },
      delete: () => false
    },
    spawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
    fetch: async () => ({ ok: false, status: 503, async json() { return {}; } })
  });

  const listed = await service.list();
  const jira = listed.connections.find(item => item.id === "jira");
  assert.equal(jira.credentialSource, "environment");
  assert.equal(jira.canConnect, false);
  await assert.rejects(
    () => service.connect("jira", {
      baseUrl: "https://other.atlassian.net", email: "other@example.com", token: "other-token"
    }),
    /managed by environment variables/
  );
  assert.equal(saved, false);
});

test("GitHub, Notion, and Linear tokens are validated before secure storage and never listed", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-token-connect-"));
  const settings = testSettings(directory);
  const entries = new Map();
  const vault = {
    supported: true,
    has: id => entries.has(id),
    read: id => entries.get(id) || null,
    save: (id, value) => entries.set(id, value),
    delete: id => entries.delete(id)
  };
  const fetch = async (url, options = {}) => {
    if (url.endsWith("/user")) return { ok: true, status: 200, async json() { return { login: "agent-user" }; } };
    if (url.includes("api.notion.com")) return { ok: true, status: 200, async json() { return { bot: { workspace_name: "Workspace" } }; } };
    if (url.includes("api.linear.app")) {
      assert.match(options.body, /viewer/);
      return { ok: true, status: 200, async json() { return { data: { viewer: { name: "Agent User" } } }; } };
    }
    return { ok: false, status: 503, async json() { return {}; } };
  };
  const service = createProviderConnectionService(settings, {
    environment: {}, vault, fetch,
    spawnSync: () => ({ status: 1, stdout: "", stderr: "" })
  });
  await service.connect("github", { token: "github-secret-token" });
  await service.connect("notion", { token: "notion-secret-token" });
  await service.connect("linear", { token: "linear-secret-token" });
  assert.equal(entries.get("github").token, "github-secret-token");
  assert.equal(entries.get("notion").token, "notion-secret-token");
  assert.equal(entries.get("linear").token, "linear-secret-token");
  const listed = await service.list();
  const serialized = JSON.stringify(listed);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(listed.connections.find(item => item.id === "github").runtimeAvailable, true);
  assert.equal(listed.connections.find(item => item.id === "notion").runtimeAvailable, false);
});

test("local model discovery configures and explicitly selects the Codex local executor", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-local-model-"));
  const settings = testSettings(directory);
  const configured = [];
  const selected = [];
  const service = createProviderConnectionService(settings, {
    environment: {},
    vault: { supported: true, has: () => false, read: () => null },
    spawnSync: (command, args) => ({ status: command === "where" && ["ollama", "lms"].includes(args[0]) ? 0 : 1, stdout: "", stderr: "" }),
    fetch: async (url, options) => {
      assert.equal(options.redirect, "error");
      if (url.includes("11434")) return { ok: true, status: 200, async json() { return { models: [{ name: "qwen3:8b" }] }; } };
      if (url.includes("1234")) return { ok: true, status: 200, async json() { return { data: [{ id: "gemma-3", type: "llm" }] }; } };
      return { ok: false, status: 404, async json() { return {}; } };
    },
    configureLocalExecutor: (id, model, endpoint, remoteApproved) => {
      configured.push([id, model, endpoint, remoteApproved]);
      settings.data.executor.providers[id] = {
        ...settings.data.executor.providers[id], enabled: true, defaultModel: model,
        endpoint, remoteEndpointApproved: remoteApproved
      };
    },
    selectLocalExecutor: id => {
      selected.push(id);
      settings.data.executor.defaultProvider = id;
    }
  });
  const listed = await service.list();
  assert.deepEqual(listed.connections.find(item => item.id === "ollama").models, ["qwen3:8b"]);
  assert.deepEqual(listed.connections.find(item => item.id === "lmstudio").models, ["gemma-3"]);
  const remoteEndpoint = "http://10.10.0.25:11434";
  await assert.rejects(
    () => service.test("ollama", { endpoint: remoteEndpoint, trustRemoteEndpoint: false }),
    /Confirm that task and code context/
  );
  const remoteModels = await service.test("ollama", { endpoint: remoteEndpoint, trustRemoteEndpoint: true });
  assert.deepEqual(remoteModels.models, ["qwen3:8b"]);
  await service.connect("ollama", { endpoint: remoteEndpoint, model: "qwen3:8b", trustRemoteEndpoint: true });
  await service.select("ollama");
  assert.deepEqual(configured, [["ollama", "qwen3:8b", remoteEndpoint, true]]);
  assert.deepEqual(selected, ["ollama"]);
  await assert.rejects(
    () => service.test("ollama", { endpoint: "https://models.example.com", trustRemoteEndpoint: true }),
    /private network\/VPN/
  );
});
