# agent-scaffold

Provider-neutral scaffold for an autonomous software delivery team.

Turkish documentation:
[README.tr.md](README.tr.md) and
[docs/KULLANIM_KILAVUZU.tr.md](docs/KULLANIM_KILAVUZU.tr.md).

The primary operating model is the lightweight persona + skill + task-agent
protocol in [ORCHESTRATION.md](ORCHESTRATION.md). It works without a framework.
The JavaScript runtime is an optional automation layer for Jira polling, locks,
worktrees, and Codex execution.

## What It Provides

- One active persona per phase, freely stacked skills, scoped task agents.
- Mandatory phase handoffs that carry decisions and artifacts forward.
- Four relevant upstream personas copied into `core/personas/`.
- Eleven complete upstream skills copied with scripts, references, and assets.
- Jira eligibility rules and human-only action boundaries.
- SQLite run history and exclusive issue locks.
- Worktree planning and Codex executor adapter.
- Antigravity, Claude Code, GitHub Copilot, and Codex instruction adapters.
- PaceBuild-specific CV, TimescaleDB, and demo reliability rules.

## Quick Install

Linux/macOS/WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/arifaydogan/agent-scaffold/master/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/arifaydogan/agent-scaffold/master/install.ps1 | iex
```

## Updating

After installation, the target project receives `.agent-scaffold/update.ps1`
and `.agent-scaffold/update.sh`.

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.agent-scaffold\update.ps1 -PullIfChanged
```

Linux/macOS/WSL:

```bash
bash ./.agent-scaffold/update.sh --pull-if-changed
```

To only check whether the remote repo has a newer commit:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.agent-scaffold\update.ps1 -CheckOnly
```

To keep watching the repo and auto-apply updates on an interval:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.agent-scaffold\update.ps1 -Watch -IntervalSeconds 300
```

## Orchestration Quick Start

1. Read `ORCHESTRATION.md`.
2. State the objective, constraints, and success criteria.
3. Select one persona for the current phase.
4. Load the required skills.
5. Assign one scoped task agent.
6. Finish with the mandatory phase handoff.

## Optional Runtime Quick Start

```powershell
Copy-Item agent-scaffold.example.json agent-scaffold.json
node bin/agentctl.js --config agent-scaffold.json doctor
node bin/agentctl.js --config agent-scaffold.json plan PACE-123
node bin/agentctl.js --config agent-scaffold.json run PACE-123
```

`run` is dry-run by default. Pass `--execute` only after reviewing the generated
route, worktree path, persona, and skill selection.

Jira access uses `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN`. Jira writes remain
disabled until `jira.write_enabled = true` is set explicitly.

## Operating Model

| Runtime role | Responsibility |
| --- | --- |
| Orchestrator | Eligibility, routing, task lock, sequencing, retry, handoff |
| PM/Analyst | Requirement quality, acceptance criteria, Jira and Confluence |
| Builder | Scoped implementation using task-specific engineering skills |
| Reviewer/QA | Tests, diff review, security and acceptance gates |

Architect, Backend, Frontend, DevOps, Security, Data, and CV profiles remain in
the catalog. They are selected by the Orchestrator instead of running
continuously.

## Validation

```powershell
node scripts/validate-scaffold.js
node --test
```

The canonical inventory is [scaffold-manifest.json](scaffold-manifest.json).
Copied upstream content is documented in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Human-Only Actions

Agents must not:

- Modify or transition epics.
- Transition Jira work to Done.
- Merge pull requests.
- Ingest unlabeled backlog work.
- Bypass failing tests or security gates.
