---
title: PaceBuild bounded task
description: Execute one approved PaceBuild task packet without expanding scope or performing human-only actions.
---

# PaceBuild bounded task

1. Read the workspace `AGENTS.md`, `ORCHESTRATION.md`, and
   `PACEBUILD_ORCHESTRATOR.md`.
2. Require an execution packet containing the issue key, active phase, approval
   grant, canonical specification, allowed paths, non-goals, dependencies,
   resource locks, model budget, and output contract.
3. Select exactly one custom agent and the minimum relevant skills.
4. Reject missing approval, blocked dependencies, an unowned resource lock, or
   requested work outside the allowed paths.
5. For implementation, edit only the active worktree. Do not execute shell
   commands; return the required validation commands to the scheduler.
6. Never push, merge, transition work to Done, or perform Jira/Confluence writes
   without the exact external-write approval.
7. Return output matching the configured execution result schema.
