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

The installed `pacebuild-review-lite` and `pacebuild-review-deep` custom agents
are read-only reviewers. The first uses a lower-cost model for ordinary reviews;
the second is reserved for security, data, concurrency, and cross-service risk.

These model pins are specific to Codex. Other adapters follow the shared
cost/risk policy through their own model-selection mechanisms.

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

For an independent review in a new Codex chat, give the new agent the Jira key
or pull request URL:

```text
Review PACE-123 independently. Spawn pacebuild-review-lite. Read the Jira review
packet and linked Confluence validation page, compare the PR branch to its base,
and report findings only. Do not edit or write externally.
```

The shorter equivalent is:

```text
PACE-123 REVIEW
```

## Notes

- `AGENTS.md` is the Codex entry point.
- `PACEBUILD_ORCHESTRATOR.md` selects the first executable child when the input
  is an epic or coordination issue.
- After external-write approval, it writes a shared review packet to Jira and
  Confluence with test cases and user-visible change scenarios.
- `.codex/skills/` preserves full skill folders, including `scripts/`,
  `references/`, `profiles/`, and `assets/`.
- PaceBuild-specific overrides are copied into `.codex/` when that pack is
  selected.
