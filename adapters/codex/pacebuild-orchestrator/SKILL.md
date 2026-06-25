---
name: pacebuild-orchestrator
description: >
  Load the provider-neutral PaceBuild Jira orchestration contract when a user
  provides a PACE issue key, exact Jira title, epic, or asks for Jira work.
triggers:
  - "PACE-[0-9]+"
  - "Jira task"
  - "Jira epic"
  - "orchestration"
---

# PaceBuild Orchestrator Adapter

Read and follow the repository-root `PACEBUILD_ORCHESTRATOR.md` as the complete
execution contract. `ORCHESTRATION.md` remains the shared persona, skill,
task-agent, phase, and handoff model.

Do not add Codex-specific workflow rules. If this wrapper conflicts with the
provider-neutral contract, the provider-neutral contract wins.
