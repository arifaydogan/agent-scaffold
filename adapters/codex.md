# Codex Adapter Guide

This adapter configures a repository for Codex CLI and Codex coding-agent runs.

## Installed Structure

```text
AGENTS.md
ORCHESTRATION.md
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

Start the run from the target repository root and tell Codex to read `AGENTS.md`
first, then `ORCHESTRATION.md`, then only the required files from `.codex/`.

Example prompt:

```text
Read AGENTS.md and ORCHESTRATION.md.
Objective: PACE-123 issue kapsam ve acceptance criteria netlestir.
Start with product-manager persona.
Load only the needed PM files from .codex/.
Stop after the Phase 0 handoff.
```

## Notes

- `AGENTS.md` is the Codex entry point.
- `.codex/skills/` preserves full skill folders, including `scripts/`,
  `references/`, `profiles/`, and `assets/`.
- PaceBuild-specific overrides are copied into `.codex/` when that pack is
  selected.
