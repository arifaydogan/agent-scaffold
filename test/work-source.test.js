import test from "node:test";
import assert from "node:assert/strict";
import { GitHubIssuesWorkSourceProvider } from "../lib/github-issues.js";
import { JiraClient } from "../lib/jira.js";
import { createWorkSourceProvider } from "../lib/work-source.js";
import { mapProviderState } from "../lib/workflow.js";

test("canonical workflow mapping supports defaults and provider overrides", () => {
  assert.equal(mapProviderState("jira", "In Progress"), "in_progress");
  assert.equal(mapProviderState("github-issues", "open", {}, ["blocked"]), "blocked");
  assert.equal(
    mapProviderState("jira", "Awaiting Security", { review: ["Awaiting Security"] }),
    "review"
  );
  assert.equal(mapProviderState("jira", "Vendor-specific state"), "unknown");
});

test("Jira adapter emits a canonical work item while preserving provider state", async () => {
  const jira = new JiraClient(
    {
      baseUrl: "https://example.atlassian.net",
      emailEnv: "EMAIL",
      tokenEnv: "TOKEN",
      stateMapping: { review: ["Security Review"] }
    },
    { EMAIL: "agent@example.com", TOKEN: "secret" }
  );
  jira.request = async () => ({
    id: "10001",
    key: "PACE-12",
    fields: {
      summary: "Provider-neutral work",
      description: "Acceptance Criteria\n- [ ] mapped",
      issuetype: { name: "Story" },
      status: { name: "Security Review" },
      labels: ["agent-ready"],
      parent: null,
      assignee: { displayName: "Arif" }
    }
  });

  const item = await jira.getWorkItem("PACE-12");
  assert.equal(item.status, "Security Review");
  assert.equal(item.canonicalState, "review");
  assert.equal(item.source.provider, "jira");
  assert.equal(item.providerKey, "PACE-12");
});

test("GitHub Issues adapter filters pull requests and emits canonical issue packets", async () => {
  const github = new GitHubIssuesWorkSourceProvider({
    owner: "arifaydogan",
    repo: "agent-scaffold",
    projectKey: "AS"
  });
  let requestedRoute = null;
  github.request = async (route) => {
    requestedRoute = route;
    return [
      {
        number: 42,
        title: "Add provider abstraction",
        body: "Acceptance Criteria\n- [ ] adapters",
        state: "open",
        labels: [{ name: "agent-ready" }, { name: "in-review" }],
        assignee: { login: "arif" },
        html_url: "https://github.com/arifaydogan/agent-scaffold/issues/42"
      },
      { number: 43, title: "PR", state: "open", labels: [], pull_request: {} }
    ];
  };

  const items = await github.poll({ requiredLabels: ["agent-ready"], limit: 5 });
  assert.match(requestedRoute, /labels=agent-ready/);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, "AS-42");
  assert.equal(items[0].canonicalState, "review");
  assert.equal(items[0].source.id, "42");
});

test("work source factory selects GitHub without constructing Jira credentials", () => {
  const settings = {
    projectKey: "AS",
    data: {
      workSource: {
        defaultProvider: "github-issues",
        providers: {
          jira: { type: "jira", baseUrl: "https://example.atlassian.net" },
          "github-issues": { type: "github-issues", owner: "o", repo: "r" }
        }
      }
    }
  };
  assert.ok(createWorkSourceProvider(settings) instanceof GitHubIssuesWorkSourceProvider);
});

test("Jira adapter constructs JQL with canonicalStates forwarding for ready, review, rework, human_approval", async () => {
  const jira = new JiraClient(
    {
      baseUrl: "https://example.atlassian.net",
      emailEnv: "EMAIL",
      tokenEnv: "TOKEN"
    },
    { EMAIL: "agent@example.com", TOKEN: "secret" }
  );

  let requestedJql = null;
  jira.request = async (method, route) => {
    if (route.startsWith("/rest/api/3/search/jql")) {
      requestedJql = decodeURIComponent(route);
      return { issues: [{ key: "PACE-1" }, { key: "PACE-2" }] };
    }
    if (route.startsWith("/rest/api/3/issue/PACE-1")) {
      return {
        id: "1",
        key: "PACE-1",
        fields: {
          summary: "Issue 1",
          description: "",
          issuetype: { name: "Task" },
          status: { name: "To Do" },
          labels: ["agent-ready"]
        }
      };
    }
    if (route.startsWith("/rest/api/3/issue/PACE-2")) {
      return {
        id: "2",
        key: "PACE-2",
        fields: {
          summary: "Issue 2",
          description: "",
          issuetype: { name: "Task" },
          status: { name: "In Review" },
          labels: ["agent-ready"]
        }
      };
    }
  };

  const items = await jira.listWorkItems({
    projectKey: "PACE",
    requiredLabels: ["agent-ready"],
    canonicalStates: ["ready", "review", "rework", "human_approval"]
  });

  assert.match(requestedJql, /project = PACE/);
  assert.match(requestedJql, /labels = "agent-ready"/);
  assert.match(requestedJql, /status IN \(/);
  assert.match(requestedJql, /"To Do"/);
  assert.match(requestedJql, /"In Review"/);
  assert.match(requestedJql, /"Agent Rework"/);
  assert.match(requestedJql, /"Human Approval"/);
  assert.equal(items.length, 2);
  assert.equal(items[0].canonicalState, "ready");
  assert.equal(items[1].canonicalState, "review");
});

test("GitHub Issues adapter performs OR discovery across canonical states and deduplicates", async () => {
  const github = new GitHubIssuesWorkSourceProvider({
    owner: "test-owner",
    repo: "test-repo",
    projectKey: "GH"
  });

  const routesCalled = [];
  github.request = async (route) => {
    routesCalled.push(route);
    if (route.includes("labels=agent-ready%2Cready") || route.includes("labels=agent-ready%2Cagent-ready") || route.includes("labels=agent-ready%2Copen")) {
      return [
        {
          number: 10,
          title: "Ready Issue",
          state: "open",
          labels: [{ name: "agent-ready" }, { name: "ready" }]
        }
      ];
    }
    if (route.includes("labels=agent-ready%2Creview") || route.includes("labels=agent-ready%2Cin-review") || route.includes("labels=agent-ready%2Cagent-review")) {
      return [
        {
          number: 11,
          title: "Review Issue",
          state: "open",
          labels: [{ name: "agent-ready" }, { name: "agent-review" }]
        }
      ];
    }
    if (route.includes("labels=agent-ready%2Cagent-rework")) {
      return [
        {
          number: 12,
          title: "Rework Issue",
          state: "open",
          labels: [{ name: "agent-ready" }, { name: "agent-rework" }]
        }
      ];
    }
    if (route.includes("labels=agent-ready%2Chuman-approval")) {
      return [
        {
          number: 13,
          title: "Approval Issue",
          state: "open",
          labels: [{ name: "agent-ready" }, { name: "human-approval" }]
        }
      ];
    }
    return [];
  };

  const items = await github.listWorkItems({
    requiredLabels: ["agent-ready"],
    canonicalStates: ["ready", "review", "rework", "human_approval"]
  });

  // Verify that multiple discrete queries were made, not combining all states into a single labels= filter
  assert.ok(routesCalled.length > 1);
  for (const route of routesCalled) {
    assert.ok(!route.includes("ready%2Cagent-review%2Cagent-rework"), "Should not combine all state labels into one filter");
  }

  const states = items.map(i => i.canonicalState);
  assert.ok(states.includes("ready"));
  assert.ok(states.includes("review"));
  assert.ok(states.includes("rework"));
  assert.ok(states.includes("human_approval"));
});

test("GitHub Issues transition preserves unrelated labels and removes previous workflow labels", async () => {
  const github = new GitHubIssuesWorkSourceProvider(
    {
      owner: "test-owner",
      repo: "test-repo",
      projectKey: "GH",
      tokenEnv: "TOKEN",
      writeEnabled: true,
      writeMapping: {
        review: { addLabel: "agent-review" }
      }
    },
    { TOKEN: "gh-token" }
  );

  let putLabelsBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts.method === "PUT" && url.includes("/issues/10/labels")) {
      putLabelsBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return originalFetch(url, opts);
  };

  try {
    github.request = async (route) => {
      if (route.includes("/issues/10")) {
        return {
          number: 10,
          title: "Issue 10",
          labels: [{ name: "bug" }, { name: "priority-high" }, { name: "agent-ready" }]
        };
      }
      return [];
    };

    await github.transition("GH-10", "review");

    assert.ok(putLabelsBody);
    assert.ok(putLabelsBody.labels.includes("bug"), "Preserves unrelated label 'bug'");
    assert.ok(putLabelsBody.labels.includes("priority-high"), "Preserves unrelated label 'priority-high'");
    assert.ok(putLabelsBody.labels.includes("agent-review"), "Adds new workflow label 'agent-review'");
    assert.ok(!putLabelsBody.labels.includes("agent-ready"), "Removes previous workflow label 'agent-ready'");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub Issues transition throws error on non-2xx response", async () => {
  const github = new GitHubIssuesWorkSourceProvider(
    {
      owner: "test-owner",
      repo: "test-repo",
      projectKey: "GH",
      tokenEnv: "TOKEN",
      writeEnabled: true,
      writeMapping: {
        review: { addLabel: "agent-review" }
      }
    },
    { TOKEN: "gh-token" }
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts.method === "PUT" && url.includes("/issues/10/labels")) {
      return { ok: false, status: 500 };
    }
    return originalFetch(url, opts);
  };

  try {
    github.request = async () => ({
      number: 10,
      labels: [{ name: "agent-ready" }]
    });

    await assert.rejects(
      () => github.transition("GH-10", "review"),
      /PUT labels failed for issue #10: 500/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub Issues addComment throws error on non-2xx response", async () => {
  const github = new GitHubIssuesWorkSourceProvider(
    {
      owner: "test-owner",
      repo: "test-repo",
      projectKey: "GH",
      tokenEnv: "TOKEN",
      writeEnabled: true
    },
    { TOKEN: "gh-token" }
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts.method === "POST" && url.includes("/comments")) {
      return { ok: false, status: 403 };
    }
    return originalFetch(url, opts);
  };

  try {
    await assert.rejects(
      () => github.addComment("GH-10", "Test comment"),
      /POST comment failed for issue #10: 403/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
