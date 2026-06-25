# Codex Adapter Guide

This adapter configures a repository for Codex CLI and Codex coding-agent runs.

## Installed Structure

```text
AGENTS.md
ORCHESTRATION.md
PACEBUILD_ORCHESTRATOR.md
.codex/
|-- README.md
|-- rules/
|-- personas/
|-- agents/
`-- skills/
```

Codex reads repository instructions from `AGENTS.md`. The `.codex/` directory
stores the persona, task-agent, skill, and rule inventory so a run can load
only the files needed for the active phase.

`PACEBUILD_ORCHESTRATOR.md` is shared with the other adapters. Codex discovers
it through `AGENTS.md` and the thin `.codex/skills/pacebuild-orchestrator`
wrapper.

## Installation

PowerShell:

```powershell
.\install.ps1 C:\path\to\target 2 4
```

Bash:

```bash
./install.sh /path/to/target 2 4
```

The choices mean:

- `2`: Core + PaceBuild pack
- `4`: Codex adapter

## Usage

Start the run from the target repository root. For Jira work, provide only an
issue key, exact issue title, or epic.

Example prompt:

```text
PACE-123
```

## Notes

- `AGENTS.md` is the Codex entry point.
- `PACEBUILD_ORCHESTRATOR.md` selects the first executable child when the input
  is an epic or coordination issue.
- `.codex/skills/` preserves full skill folders, including `scripts/`,
  `references/`, `profiles/`, and `assets/`.
- PaceBuild-specific overrides are copied into `.codex/` when that pack is
  selected.
