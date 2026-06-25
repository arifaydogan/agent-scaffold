---
name: PaceBuild Orchestrator
description: Resolve and run a Jira issue or epic through the shared PaceBuild orchestration contract.
argument-hint: PACE-123 or exact Jira title
---

# PaceBuild Orchestrator Adapter

Read and follow the repository-root `PACEBUILD_ORCHESTRATOR.md` as the complete
execution contract. Also read `ORCHESTRATION.md` for the shared persona, skill,
task-agent, phase, and handoff model.

The user may provide an issue key, an exact Jira title, or an epic. Do not
duplicate provider-specific workflow rules here. If this wrapper conflicts with
the provider-neutral contract, the provider-neutral contract wins.
