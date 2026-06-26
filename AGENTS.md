# Agent Operating Rules

Before any multi-step task, read and follow [ORCHESTRATION.md](ORCHESTRATION.md).
That document is the canonical persona, skill, task-agent, phase, and handoff
protocol.

For PaceBuild Jira work, including a `PACE-XX` key, exact Jira issue title, or
epic, also read and follow
[PACEBUILD_ORCHESTRATOR.md](PACEBUILD_ORCHESTRATOR.md). It is the
provider-neutral Jira execution contract.

For PaceBuild product discovery, feature shaping, backlog design, or
Confluence product documentation, read and follow
[PACEBUILD_DISCOVERY.md](PACEBUILD_DISCOVERY.md). Start this conversational
workflow with `DISCOVERY:` or `PRODUCT:`.

## Objective

This repository builds a reusable autonomous software-delivery scaffold. The
current MVP uses Codex and isolated Git worktrees. Provider-specific execution
must remain behind adapters so the runtime can later use API models, local LLMs,
or a LangGraph-style control plane.

## Orchestration First

Every task is evaluated by the Orchestrator before implementation:

1. Read the Jira issue, comments, parent, links, labels, and acceptance criteria.
2. Apply eligibility and human-approval policy.
3. Select exactly one active persona and the required skill stack.
4. Decide whether work is sequential or safe to parallelize.
5. Assign one task agent with explicit scope and verification.
6. Run test, review, and security gates.
7. Produce a Jira/PR handoff. Never merge or transition to Done.

## Persona And Task-Agent Separation

- Personas live under `core/personas/` and define judgment.
- Task agents live under `core/agents/` and `packs/*/agents/`.
- Skills live below each agent and define execution.
- Never blend multiple personas in one phase.
- Skills may stack freely.
- Persona-free skill chains are allowed for procedural tasks.

## Persona, Skill, Task

- Persona defines judgment and priorities.
- Skill defines a repeatable execution method.
- Task agent performs one bounded unit of work.
- Do not load every persona or skill into every run.
- Use [scaffold-manifest.json](scaffold-manifest.json) as the canonical inventory.
- Use the mandatory phase handoff format from `ORCHESTRATION.md`.

## Safety Boundaries

- Only issues with the configured `agent-ready` label may be claimed.
- Epics, Done transitions, merges, deletions, and production credential changes
  require human approval.
- One issue may have only one active run lock.
- Never silently fall back to mock data or swallow an error.
- A blocker must become a recorded run state and a Jira handoff.

## Engineering Rules

- Make the smallest change that satisfies explicit acceptance criteria.
- Reproduce bugs with a failing test before fixing them when practical.
- Keep changes inside the assigned issue scope.
- Run repository-specific lint, type, test, and security checks.
- Missing required verification tools are failures, not warnings.
- Preserve user changes and do not perform destructive Git operations.

## Handoff

Each completed phase reports:

```text
Phase [N] complete.
Decisions: [...]
Artifacts: [...]
Verification: [...]
Open items: [...]
Next: [persona] + [skills]
```
