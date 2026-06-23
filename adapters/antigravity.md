# Antigravity Adapter Guide

This adapter configures the repository for the **Antigravity** agentic IDE.

## Directory Structure

The Antigravity adapter installs files under the `.agents/` directory in the target project root:

```
.agents/
├── AGENTS.md               # Root Agent Matrix & Routing Rules
├── agents/                 # Role Definitions
│   ├── orchestrator/
│   │   └── AGENT.md
│   ├── architect/
│   │   ├── AGENT.md
│   │   └── rules.md
│   └── ... (other agent roles)
├── rules/                  # Core & Project Rules
│   ├── global.md           # Simplicity rules and reliability guard
│   ├── git-workflow.md     # Branching & Git conventions
│   └── jira-protocol.md    # Jira status & comment protocol
└── skills/                 # Domain-Specific Skills (Trigger-Matched)
    ├── api-design/
    │   └── SKILL.md
    ├── database-patterns/
    │   └── SKILL.md
    └── ... (other skills)
```

## Setup & Usage

Antigravity automatically discovers and parses configurations from the `.agents/` directory.

### Interactive Installation
```bash
./install.sh
# Select: Target Dir (e.g. .)
# Select: Pack (e.g. 2 for PaceBuild)
# Select: Adapter (1 for Antigravity)
```

### Unattended Installation
```bash
./install.sh /path/to/target 2 1
```

## Manual Installation
To install manually without scripts:
1. Create `.agents/` in the target project.
2. Copy the `AGENTS.md` to `.agents/AGENTS.md`.
3. Copy all rules from `core/rules/` to `.agents/rules/`.
4. Copy all agent definitions and rules from `core/agents/` to `.agents/agents/`.
5. Copy all skills from `core/agents/*/skills/*` to `.agents/skills/`.

## Verification & Testing
To verify the installation:
- Check that `.agents/rules/global.md` exists and contains the instructions.
- Ensure `.agents/skills/` contains the triggers for all skills.
- Open Antigravity and check if it discovers the project scope rules.
