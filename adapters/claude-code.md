# Claude Code Adapter Guide

This adapter configures the repository for **Claude Code**, Anthropic's agentic CLI tool.

## Directory Structure

The Claude Code adapter installs files under the root `CLAUDE.md` and the `.claude/` directory:

```
target-project/
├── CLAUDE.md               # Unified System Prompt (Rules & Workflows)
└── .claude/
    ├── agents/             # Agent profiles and scoped instructions
    │   ├── orchestrator/
    │   │   └── AGENT.md
    │   └── ...
    └── skills/             # Skills matching subagent workflows
        ├── api-design/
        │   └── SKILL.md
        └── ...
```

## How It Works

1. **Root Prompt (`CLAUDE.md`)**: Claude Code automatically loads `CLAUDE.md` on startup as its system context. The installer compiles a single unified document combining global instructions, branching rules, and reliability guidelines into `CLAUDE.md`.
2. **Subagents (`.claude/agents/`)**: When Claude Code needs to spawn subagents, it reads profiles and scopes from `.claude/agents/` to assign roles.
3. **Skills (`.claude/skills/`)**: Relevant skill folders and guidelines are loaded during execution when triggered.

## Setup & Usage

### Interactive Installation
```bash
./install.sh
# Select: Target Dir (e.g. .)
# Select: Pack (e.g. 2 for PaceBuild)
# Select: Adapter (2 for Claude Code)
```

### Unattended Installation
```bash
./install.sh /path/to/target 2 2
```

## Subagent Invocation Guide

When executing a task, Claude Code can invoke a subagent:
- Ensure the subagent is initialized with the instructions from `.claude/agents/<role>/AGENT.md`.
- Read and follow agent-specific rules from `.claude/agents/<role>/rules.md` to prevent boundary-crossing.
