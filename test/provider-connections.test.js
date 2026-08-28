import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  ProviderCredentialVault,
  createProviderConnectionService,
  resolveJiraProviderConnection
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
          }
        }
      },
      executor: {
        defaultProvider: "codex",
        providers: { codex: {}, antigravity: {} }
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
    spawnSync: () => ({ status: 1, stdout: "", stderr: "" })
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
