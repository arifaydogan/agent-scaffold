import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadSettings } from "../lib/config.js";

/** Writes a minimal valid config to a temp file and returns the path. */
function writeConfig(directory, overrides = {}) {
  const base = {
    project: { key: "TEST", repoPath: "." },
    policy: {
      requiredLabels: ["agent-ready"],
      humanOnlyStatuses: ["Done"],
      maxConcurrency: 2,
      providerConcurrency: {}
    },
    worktree: { root: "." },
    jira: { baseUrl: "https://example.atlassian.net", writeEnabled: false },
    executor: { defaultProvider: "codex", providers: {} },
    ...overrides
  };
  const filePath = path.join(directory, "agent-scaffold.json");
  fs.writeFileSync(filePath, JSON.stringify(base), "utf8");
  return filePath;
}

test("supervisor defaults are applied when section is absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir);
  const settings = loadSettings(configPath);
  const s = settings.data.supervisor;
  assert.equal(s.executeEnabled, false, "executeEnabled defaults to false");
  assert.equal(s.pollIntervalSeconds, 30);
  assert.equal(s.heartbeatSeconds, 10);
  assert.equal(s.staleAfterSeconds, 90);
  assert.equal(s.maxConsecutiveFailures, 3);
  assert.equal(s.issueLimit, 10);
});

test("supervisor config merges partial overrides", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    supervisor: { pollIntervalSeconds: 60, issueLimit: 5 }
  });
  const settings = loadSettings(configPath);
  const s = settings.data.supervisor;
  assert.equal(s.pollIntervalSeconds, 60, "pollIntervalSeconds overridden");
  assert.equal(s.issueLimit, 5, "issueLimit overridden");
  // Other defaults unchanged
  assert.equal(s.executeEnabled, false);
  assert.equal(s.heartbeatSeconds, 10);
});

test("supervisor config: executeEnabled can be set to true", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    supervisor: { executeEnabled: true }
  });
  const settings = loadSettings(configPath);
  assert.equal(settings.data.supervisor.executeEnabled, true);
});

test("supervisor config: rejects non-boolean executeEnabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    supervisor: { executeEnabled: "yes" }
  });
  assert.throws(
    () => loadSettings(configPath),
    /executeEnabled must be a boolean/
  );
});

test("supervisor config: rejects zero pollIntervalSeconds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    supervisor: { pollIntervalSeconds: 0 }
  });
  assert.throws(
    () => loadSettings(configPath),
    /pollIntervalSeconds must be a positive integer/
  );
});

test("supervisor config: rejects negative heartbeatSeconds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    supervisor: { heartbeatSeconds: -5 }
  });
  assert.throws(
    () => loadSettings(configPath),
    /heartbeatSeconds must be a positive integer/
  );
});

test("supervisor config: rejects heartbeatSeconds >= staleAfterSeconds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    supervisor: { heartbeatSeconds: 90, staleAfterSeconds: 90 }
  });
  assert.throws(
    () => loadSettings(configPath),
    /heartbeatSeconds.*must be less than.*staleAfterSeconds/
  );
});

test("supervisor config: heartbeatSeconds < staleAfterSeconds is valid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    supervisor: { heartbeatSeconds: 5, staleAfterSeconds: 30 }
  });
  const settings = loadSettings(configPath);
  assert.equal(settings.data.supervisor.heartbeatSeconds, 5);
  assert.equal(settings.data.supervisor.staleAfterSeconds, 30);
});

test("supervisor config: does not mutate the raw parsed data object", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    supervisor: { pollIntervalSeconds: 45 }
  });
  // Read the file ourselves to get the raw value.
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const settings = loadSettings(configPath);
  // The normalized value should be the same in settings.data.supervisor.
  assert.equal(settings.data.supervisor.pollIntervalSeconds, 45);
  // The raw file object is unaffected.
  assert.equal(raw.supervisor.pollIntervalSeconds, 45);
  // Verify supervisor defaults (not in raw) didn't bleed into raw.
  assert.equal("executeEnabled" in raw.supervisor, false);
});

test("policy safety flags: rejects non-boolean externalWritesEnabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    policy: { externalWritesEnabled: "true" }
  });
  assert.throws(() => loadSettings(configPath), /policy\.externalWritesEnabled must be a boolean/);
});

test("policy safety flags: rejects non-boolean gitIntegrationEnabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    policy: { gitIntegrationEnabled: 1 }
  });
  assert.throws(() => loadSettings(configPath), /policy\.gitIntegrationEnabled must be a boolean/);
});

test("policy safety flags: rejects non-boolean autonomyEnabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    policy: { autonomyEnabled: "yes" }
  });
  assert.throws(() => loadSettings(configPath), /policy\.autonomyEnabled must be a boolean/);
});

test("policy review: rejects negative maxReworkAttempts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    policy: { review: { maxReworkAttempts: -1 } }
  });
  assert.throws(() => loadSettings(configPath), /policy\.review\.maxReworkAttempts must be a non-negative integer/);
});

test("policy review: rejects unknown review provider", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    policy: { review: { provider: "nonexistent" } }
  });
  assert.throws(() => loadSettings(configPath), /Configured review provider 'nonexistent' does not exist/);
});

test("policy review: rejects unknown model profile for configured review provider", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    executor: {
      defaultProvider: "antigravity",
      providers: {
        antigravity: {
          command: ["agy"],
          modelProfiles: { medium: "claude-3-5-sonnet" }
        }
      }
    },
    policy: {
      review: {
        provider: "antigravity",
        modelProfile: "unknown-profile"
      }
    }
  });
  assert.throws(() => loadSettings(configPath), /Configured review model profile 'unknown-profile' does not exist/);
});

test("policy review: accepts valid review provider and model profile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
  const configPath = writeConfig(dir, {
    executor: {
      defaultProvider: "antigravity",
      providers: {
        antigravity: {
          command: ["agy"],
          modelProfiles: { "claude-review": "claude-3-5-sonnet" }
        }
      }
    },
    policy: {
      externalWritesEnabled: true,
      gitIntegrationEnabled: true,
      autonomyEnabled: true,
      review: {
        provider: "antigravity",
        modelProfile: "claude-review",
        maxReworkAttempts: 3
      }
    }
  });
  const settings = loadSettings(configPath);
  assert.equal(settings.data.policy.review.provider, "antigravity");
  assert.equal(settings.data.policy.review.maxReworkAttempts, 3);
});
