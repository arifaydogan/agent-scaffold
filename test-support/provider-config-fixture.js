import fs from "node:fs";
import path from "node:path";

export function writeProviderConfig(directory, mutationEnabled = false) {
  const config = {
    project: { key: "TEST", name: "Test Project", repoPath: "." },
    policy: {
      allowedProjects: ["TEST"],
      requiredLabels: ["agent-ready"],
      humanOnlyStatuses: ["Done"],
      maxConcurrency: 2,
      providerConcurrency: {}
    },
    worktree: { root: "." },
    workSource: {
      defaultProvider: "jira",
      providers: {
        jira: {
          type: "jira",
          baseUrl: "https://example.atlassian.net",
          emailEnv: "EMAIL",
          tokenEnv: "TOKEN",
          writeEnabled: false
        },
        "github-issues": {
          type: "github-issues",
          owner: "owner",
          repo: "repo",
          tokenEnv: "GITHUB_TOKEN",
          writeEnabled: false
        }
      }
    },
    orchestrator: {
      defaultProvider: "builtin",
      providers: { builtin: { type: "builtin" } }
    },
    executor: {
      defaultProvider: "codex",
      providers: {
        codex: { command: ["codex", "exec", "{prompt}"] },
        antigravity: { command: ["agy", "-p", "{prompt}"] }
      }
    },
    codeIntelligence: {
      defaultProvider: "codebase-memory",
      providers: {
        "codebase-memory": {
          type: "codebase-memory-mcp",
          command: ["C:/secret-tools/codebase-memory-mcp"],
          readOnly: true
        }
      }
    },
    controlPlane: { configMutationEnabled: mutationEnabled }
  };
  const file = path.join(directory, "agent-scaffold.json");
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
  return { file, config };
}
