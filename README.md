# agent-scaffold

Provider-neutral scaffold for an autonomous software delivery team.

Turkish documentation:
[README.tr.md](README.tr.md) and
[docs/KULLANIM_KILAVUZU.tr.md](docs/KULLANIM_KILAVUZU.tr.md).

The primary operating model is the lightweight persona + skill + task-agent
protocol in [ORCHESTRATION.md](ORCHESTRATION.md). It works without a framework.
PaceBuild execution policy is defined once in
[PACEBUILD_ORCHESTRATOR.md](PACEBUILD_ORCHESTRATOR.md); providers only expose it
to their host. Jira remains the first work-source adapter, not a runtime boundary.
The JavaScript runtime is an optional automation layer for provider-neutral work
intake, locks, worktrees, orchestration, and executor dispatch.

## What It Provides

- One active persona per phase, freely stacked skills, scoped task agents.
- Mandatory phase handoffs that carry decisions and artifacts forward.
- Four relevant upstream personas copied into `core/personas/`.
- Eleven complete upstream skills copied with scripts, references, and assets.
- Jira and GitHub Issues work sources with canonical workflow-state mapping.
- Separate orchestrator and Codex/Antigravity executor provider registries.
- Capability registry with Ponytail provenance and a real-time `CodeIntelligenceProvider` MCP integration point.
- Provider-neutral eligibility rules and human-only action boundaries.
- SQLite run history, exclusive issue locks, and PM telemetry (messages, decisions, usage metrics).
- Worktree planning with Parent/Child dependency DAG (Directed Acyclic Graph) support.
- Localhost Control Plane Dashboard with PM Workspace, Agents, and Usage tabs.
- Explicit Antigravity model profiles, structured results, and token telemetry.
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
node bin/agentctl.js --config agent-scaffold.json dispatch --limit 10 --concurrency 3
node bin/agentctl.js --config agent-scaffold.json runs --limit 20
node bin/agentctl.js --config agent-scaffold.json dashboard --demo
```

`run` and `dispatch` are dry-run by default. Pass `--execute` only after reviewing
the generated route, worktree path, persona, skill selection, and dispatch waves.
Parallel dispatch is bounded by global and provider concurrency limits. Tasks with
overlapping path scopes are serialized, and cross-service tasks run in an exclusive
wave.

`dashboard` starts the localhost-only Agent Scaffold Control Plane on port 4317.
Its snapshot shows project, provider selections, canonical workflow states,
capabilities, runs, model capacity, and blockers without exposing prompts, work-item
descriptions, credential values, or log bodies.

Jira access uses `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN`; GitHub Issues can use
`GITHUB_TOKEN`. Work-source writes remain disabled in the example. Provider selection
mutation is also fail-closed and requires `controlPlane.configMutationEnabled = true`.

## Provider-neutral Control Plane

The provider model and safety contract are documented in
[docs/architecture/provider-neutral-control-plane.md](docs/architecture/provider-neutral-control-plane.md).
The example config contains two work sources ('jira', 'github-issues'), a deterministic
'builtin' orchestrator, existing Codex/Antigravity executors, and a disabled
'codebase-memory-mcp' code-intelligence integration point. Legacy top-level 'jira'
config remains supported.

The local mutation API accepts provider names only:

```http
PATCH /api/config/providers
Content-Type: application/json

{"workSource":"github-issues","executor":"antigravity"}
```

It cannot modify commands, credentials, policies, execution gates, merge behavior, or
Done transitions.

### Resident Supervisor

The supervisor runs a continuous poll/dispatch loop with persisted heartbeat, bounded
retries, and graceful shutdown. Default mode is **plan-only** (dry-run).

```powershell
# Start the supervisor in plan-only mode (safe, no execution).
node bin/agentctl.js --config agent-scaffold.json supervise

# Run exactly one plan cycle then stop.
node bin/agentctl.js --config agent-scaffold.json supervise --once

# Run up to 5 plan cycles then stop.
node bin/agentctl.js --config agent-scaffold.json supervise --max-cycles 5

# Enable execute mode (requires supervisor.executeEnabled = true in config first).
node bin/agentctl.js --config agent-scaffold.json supervise --execute

# Check supervisor state and recent lifecycle events (local-only, no Jira).
node bin/agentctl.js --config agent-scaffold.json supervisor-status

# Request a graceful stop (local-only, no Jira). In-flight cycle is awaited.
node bin/agentctl.js --config agent-scaffold.json supervisor-stop
```

**Execute gate:** `--execute` is fail-closed. It has no effect unless
`supervisor.executeEnabled = true` is explicitly set in the config file. The example
config ships with `executeEnabled: false`.

**Graceful shutdown:** SIGINT and SIGTERM request a graceful stop. The supervisor
finishes the in-flight dispatch cycle before exiting. `supervisor-stop` writes a
persisted stop request so the running process detects it even across heartbeat
intervals.

**Human-only actions remain unchanged.** The supervisor never merges pull requests,
transitions Jira issues to Done, writes to Jira, modifies epics, or releases live
issue locks. Those boundaries are enforced by the orchestration protocol and are not
configurable.

### Jira Intake Modes

- **Preferred orchestrated path:** Codex uses Atlassian Rovo MCP to read Jira, normalizes `{key, summary, description, issueType, status, labels}`, and pipes that JSON into `node bin/agentctl.js --config agent-scaffold.json local-run --stdin` with optional `--execute`. This path requires no local `ATLASSIAN_EMAIL` or `ATLASSIAN_API_TOKEN`.
- **Optional resident REST poller:** `supervise`/`poll` uses `JiraClient` and does require `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN`. The supervisor Node process does not embed or inherit Codex/Rovo OAuth.
- **Read-only boundary:** Rovo intake remains read-only until separately approved external Jira writes; merge, Done transition, and epic edits remain human-only.

PowerShell-friendly example:

```powershell
$issueJson = '{"key":"PACE-123","summary":"Implement feature","description":"Details","issueType":"Task","status":"To Do","labels":["agent-ready"]}'
$issueJson | node bin/agentctl.js --config agent-scaffold.json local-run --stdin --execute
```

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
