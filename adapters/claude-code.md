# Claude Code Adapter Guide

This adapter configures the repository for **Claude Code**, Anthropic's agentic CLI tool.

## Directory Structure

The Claude Code adapter installs files under the root `CLAUDE.md` and the `.claude/` directory:

```
target-project/
├── CLAUDE.md               # Unified System Prompt (Rules & Workflows)
├── ORCHESTRATION.md         # Canonical phase and handoff protocol
└── .claude/
    ├── personas/           # Decision personas
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

1. **Root Prompt (`CLAUDE.md`)**: Includes the orchestration protocol, global instructions, branching rules, and reliability guidelines.
2. **Personas (`.claude/personas/`)**: Exactly one persona supplies judgment for the active phase.
3. **Subagents (`.claude/agents/`)**: Scoped task executors.
4. **Skills (`.claude/skills/`)**: Stack freely within the phase.

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
