# GitHub Copilot Adapter Guide

This adapter configures the repository for **GitHub Copilot Workspace** and **GitHub Copilot Chat** (VS Code).

## Directory Structure

The GitHub Copilot adapter installs a unified instruction file under `.github/`:

```
.github/
└── copilot-instructions.md  # Copilot Custom Workspace Prompt
```

## How It Works

GitHub Copilot automatically loads instructions from `.github/copilot-instructions.md` to guide its behavior and responses within the workspace.

The installer merges the following into a single markdown file:
1. Global Karpathy Principles & Simplicity Rules.
2. Git Branching & Commit Conventions.
3. Jira Task Protocol (domain, project keys, status transitions).
4. Full Agent Routing Matrix (outlining the 9 core or 10 PaceBuild roles to help Copilot route sub-tasks correctly).

## Setup & Usage

### Interactive Installation
```bash
./install.sh
# Select: Target Dir (e.g. .)
# Select: Pack (e.g. 2 for PaceBuild)
# Select: Adapter (3 for GitHub Copilot)
```

### Unattended Installation
```bash
./install.sh /path/to/target 2 3
```

## VS Code Workspace MCP Settings

If utilizing Atlassian or other MCP servers with Copilot in VS Code, add the following to your local `.vscode/settings.json` configurations:

```json
{
  "github.copilot.chat.mcp.servers": {
    "atlassian": {
      "command": "npx",
      "args": ["-y", "@atlassian/mcp-server-jira-confluence"],
      "env": {
        "ATLASSIAN_URL": "https://houndvision.atlassian.net"
      }
    }
  }
}
```
*Note: Set the proper environment variables for authentication before launching.*
