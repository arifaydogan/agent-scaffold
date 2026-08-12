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
