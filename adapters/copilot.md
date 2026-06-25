# GitHub Copilot Adapter Guide

This adapter configures a repository for GitHub Copilot Agent Mode in VS Code.

## Installed Structure

```text
.github/
|-- copilot-instructions.md
|-- agents/
|   `-- pacebuild-orchestrator.agent.md
|-- skills/
|-- personas/
`-- task-agents/
.vscode/
`-- mcp.example.json
ORCHESTRATION.md
PACEBUILD_ORCHESTRATOR.md
```

VS Code automatically discovers:

- repository instructions from `.github/copilot-instructions.md`;
- custom agents from `.github/agents/*.agent.md`;
- Agent Skills from `.github/skills/*/SKILL.md`.

The persona and task-agent source files are kept under `.github/personas/` and
`.github/task-agents/` so the orchestrator can load only the files required for
the active phase.

The custom agent is a thin adapter. Jira workflow, epic decomposition, approval
gates, and review behavior come from `PACEBUILD_ORCHESTRATOR.md`.

## Installation

PowerShell:

```powershell
.\install.ps1 C:\path\to\target 2 3
```

The choices mean:

- `2`: Core + PaceBuild pack
- `3`: GitHub Copilot adapter

## MCP Configuration

Review `.vscode/mcp.example.json`, then copy it to `.vscode/mcp.json`.
The example uses remote OAuth endpoints and does not contain credentials:

```json
{
  "servers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    },
    "atlassian": {
      "type": "http",
      "url": "https://mcp.atlassian.com/v1/mcp/authv2"
    }
  },
  "inputs": []
}
```

Start both servers from VS Code and complete their browser OAuth flows. Never
store access tokens in repository files.

## Manual Orchestration Test

1. Open the target repository in VS Code.
2. Open Copilot Chat in Agent Mode.
3. Select `PaceBuild Orchestrator`.
4. Enter only a Jira issue key, for example:

```text
PACE-123
```

The first test must stop after Phase 0. Verify that Copilot:

- reads the Jira issue, parent epic, comments, and acceptance criteria;
- selects `product-manager` as the active persona;
- selects the minimum required PM/Jira skills;
- produces the mandatory phase handoff;
- does not edit files or write to Jira without approval.
