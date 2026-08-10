/**
 * test/dispatcher.test.js
 *
 * Offline, deterministic tests for lib/dispatcher.js.
 * All Jira, RunStore, and runIssueImpl dependencies are injected.
 * No network calls, no real SQLite files needed beyond RunStore in-memory temp.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../lib/store.js";
import { dispatchOnce } from "../lib/dispatcher.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSettings(policyOverrides = {}) {
  return {
    source: "/tmp/test.json",
    projectKey: "TEST",
    repoPath: "/tmp/repo",
    worktreeRoot: "/tmp/worktrees",
    data: {
      project: { key: "TEST", repoPath: "." },
      policy: {
        allowedProjects: ["TEST"],
        humanOnlyStatuses: ["Done"],
        requiredLabels: ["agent-ready"],
        maxConcurrency: 2,
        providerConcurrency: {},
        pathScopes: {
          "backend-engineer": ["lib/**"]
        },
        ...policyOverrides
      },
      worktree: { root: "." },
      jira: { baseUrl: "https://example.atlassian.net" },
      supervisor: { issueLimit: 10 }
    }
  };
}

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-test-"));
  return new RunStore(path.join(dir, "runs.sqlite3"));
}

/**
 * Build a minimal valid issue payload.
 * issuePlan() is NOT called here (that would require a full settings.policy.rules tree).
 * We inject both `jira` and a no-op `issuePlan` route by providing an injected store +
 * a stub that returns pre-built plans directly.
 *
 * Since dispatchOnce calls issuePlan() internally from runtime.js and we cannot cleanly
 * inject it, we test the observable surface: what Jira sees, what the store sees, and
 * what is returned. We stub `jira.poll` to return minimal issue objects, rely on the
 * actual issuePlan() to produce eligible/ineligible plans, and inject runIssueImpl.
 */
function makeJira(issues = []) {
  return {
    poll: async () => issues
  };
}

/**
 * Build a minimal issue that issuePlan() can consume.
 * The routing layer requires fields; we provide the minimum that produces an
 * eligible or ineligible plan based on labels and status.
 */
function makeIssue(key, { eligible = true } = {}) {
  return {
    key,
    summary: `Test issue ${key}`,
    description: "Implement feature with Acceptance Criteria fulfilled.",
    status: "In Progress",
    labels: eligible ? ["agent-ready"] : [],
    issueType: "Story"
  };
}

// ── Dry-run (plan-only) tests ─────────────────────────────────────────────────

test("dry-run returns mode=dry-run, results=null, aborted=false", async () => {
  const settings = makeSettings();
  const store = makeStore();
  const result = await dispatchOnce(settings, {
    execute: false,
    limit: 5,
    jira: makeJira([makeIssue("TEST-1")]),
    store
  });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.results, null);
  assert.equal(result.failed, 0);
  assert.equal(result.aborted, false);
  assert.ok(typeof result.maxConcurrency === "number");
});

// ── Locked issue exclusion ────────────────────────────────────────────────────

test("locked issues are marked ineligible in plans", async () => {
  const settings = makeSettings();
  const store = makeStore();

  // Lock TEST-1 via the store.
  const runId = store.createRun("TEST-1", {});
  store.acquireLock("TEST-1", runId);

  const result = await dispatchOnce(settings, {
    execute: false,
    limit: 5,
    jira: makeJira([makeIssue("TEST-1"), makeIssue("TEST-2")]),
    store
  });

  // Find all plans for TEST-1 (may appear across waves as ineligible).
  const allPlans = result.waves.flat();
  // TEST-1 should not be in any wave (ineligible plans are excluded from waves).
  const test1InWave = allPlans.some((p) => p.issue === "TEST-1");
  assert.equal(test1InWave, false, "locked issue must not appear in any wave");
});

// ── Execute mode: no Jira re-fetch, uses Map ──────────────────────────────────

test("execute mode calls runIssueImpl with the already-polled issue, not re-fetched", async () => {
  const settings = makeSettings();
  const store = makeStore();
  const polledIssue = makeIssue("TEST-1");
  let calledWithIssue = null;
  let jiraPollCount = 0;

  const jira = {
    poll: async () => {
      jiraPollCount += 1;
      return [polledIssue];
    }
  };

  const runIssueImpl = async (_settings, issue, _execute) => {
    calledWithIssue = issue;
    return { exitCode: 0, output: { runId: "run-abc" } };
  };

  await dispatchOnce(settings, {
    execute: true,
    limit: 5,
    jira,
    store,
    runIssueImpl
  });

  assert.equal(jiraPollCount, 1, "Jira polled exactly once — not re-fetched during execution");
  assert.ok(calledWithIssue, "runIssueImpl was called with an issue");
  assert.equal(calledWithIssue.key, "TEST-1", "correct issue passed");
});

// ── maxConcurrency clamping ───────────────────────────────────────────────────

test("caller maxConcurrency is clamped to policy maximum", async () => {
  // Policy max is 2; caller requests 10.
  const settings = makeSettings({ maxConcurrency: 2 });
  const store = makeStore();
  const result = await dispatchOnce(settings, {
    execute: false,
    limit: 5,
    maxConcurrency: 10,
    jira: makeJira([]),
    store
  });
  // Must be clamped to policy max (2), not the caller's 10.
  assert.equal(result.maxConcurrency, 2, "maxConcurrency must be clamped to policy max");
});

test("caller maxConcurrency below policy max is respected", async () => {
  const settings = makeSettings({ maxConcurrency: 4 });
  const store = makeStore();
  const result = await dispatchOnce(settings, {
    execute: false,
    limit: 5,
    maxConcurrency: 2,
    jira: makeJira([]),
    store
  });
  assert.equal(result.maxConcurrency, 2, "caller can reduce below policy max");
});

// ── Invalid limit ─────────────────────────────────────────────────────────────

test("invalid limit (zero) throws before Jira poll", async () => {
  const settings = makeSettings();
  const store = makeStore();
  let pollCalled = false;
  await assert.rejects(
    () =>
      dispatchOnce(settings, {
        limit: 0,
        jira: { poll: async () => { pollCalled = true; return []; } },
        store
      }),
    /limit.*positive integer/i
  );
  assert.equal(pollCalled, false, "Jira must not be polled when limit is invalid");
});

test("invalid limit (negative) throws", async () => {
  const settings = makeSettings();
  await assert.rejects(
    () => dispatchOnce(settings, { limit: -1, jira: makeJira([]), store: makeStore() }),
    /limit.*positive integer/i
  );
});

test("invalid limit (float) throws", async () => {
  const settings = makeSettings();
  await assert.rejects(
    () => dispatchOnce(settings, { limit: 1.5, jira: makeJira([]), store: makeStore() }),
    /limit.*positive integer/i
  );
});

test("invalid limit (string) throws", async () => {
  const settings = makeSettings();
  await assert.rejects(
    () => dispatchOnce(settings, { limit: "all", jira: makeJira([]), store: makeStore() }),
    /limit.*positive integer/i
  );
});

// ── Invalid maxConcurrency ────────────────────────────────────────────────────

test("invalid maxConcurrency (zero) throws before Jira poll", async () => {
  const settings = makeSettings();
  let pollCalled = false;
  await assert.rejects(
    () =>
      dispatchOnce(settings, {
        limit: 5,
        maxConcurrency: 0,
        jira: { poll: async () => { pollCalled = true; return []; } },
        store: makeStore()
      }),
    /maxConcurrency.*positive integer/i
  );
  assert.equal(pollCalled, false);
});

test("invalid policy.maxConcurrency (zero) throws", async () => {
  const settings = makeSettings({ maxConcurrency: 0 });
  await assert.rejects(
    () => dispatchOnce(settings, { limit: 5, jira: makeJira([]), store: makeStore() }),
    /policy\.maxConcurrency.*positive integer/i
  );
});

// ── Pre-aborted signal ────────────────────────────────────────────────────────

test("pre-aborted signal returns aborted result without polling Jira", async () => {
  const settings = makeSettings();
  const ac = new AbortController();
  ac.abort(); // already aborted before call
  let pollCalled = false;
  const result = await dispatchOnce(settings, {
    execute: false,
    limit: 5,
    signal: ac.signal,
    jira: { poll: async () => { pollCalled = true; return []; } },
    store: makeStore()
  });
  assert.equal(pollCalled, false, "Jira must not be polled when signal is pre-aborted");
  assert.equal(result.aborted, true);
  assert.equal(result.waves.length, 0);
  assert.equal(result.failed, 0);
});

test("pre-aborted signal returns aborted result in execute mode too", async () => {
  const settings = makeSettings();
  const ac = new AbortController();
  ac.abort();
  let runCalled = false;
  const result = await dispatchOnce(settings, {
    execute: true,
    limit: 5,
    signal: ac.signal,
    jira: makeJira([]),
    store: makeStore(),
    runIssueImpl: async () => { runCalled = true; return { exitCode: 0, output: {} }; }
  });
  assert.equal(result.aborted, true);
  assert.equal(runCalled, false, "runIssueImpl must not be called when pre-aborted");
});

// ── Non-aborted returns aborted=false ─────────────────────────────────────────

test("non-aborted call returns aborted=false in dry-run", async () => {
  const settings = makeSettings();
  const result = await dispatchOnce(settings, {
    execute: false,
    limit: 5,
    jira: makeJira([]),
    store: makeStore()
  });
  assert.equal(result.aborted, false);
});
