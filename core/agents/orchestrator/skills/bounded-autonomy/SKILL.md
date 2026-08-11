---
name: bounded-autonomy
description: Enforces persistent goal execution within budget leases while retaining non-negotiable human approval gates. Use this skill when executing autonomous multi-step tasks that need token/time/turn limits, automated quality gates, and human approval for destructive operations or merges.
---

# Bounded Autonomy

## Overview

The `bounded-autonomy` skill balances autonomous execution with safety governance. Agents execute against persistent goals within approved lease scopes and turn/token/time budgets, while preserving human authority for scope expansion, destructive operations, Git merges, and issue completion.

## Core Rules

1. **Persistent Goal Focus**: Execution targets explicit acceptance criteria without deviating into unapproved features.
2. **Approved Scope Lease**: Work is confined strictly to assigned files, worktrees, and task boundaries.
3. **Budget Constraints**: Execution is bounded by maximum turn counts, token budgets, and time limits.
4. **Quality Gates & Auto-Continue**: Safe automated continuation is permitted only when all validation checks pass.
5. **Retry & Recovery**: Transient errors trigger bounded retry loops before escalating to a human or block state.
6. **Retained Human Authority**: Human approval is strictly required for scope expansion, destructive/external writes, and branch merges/Done transitions.

Refer to [`references/autonomy-contract.md`](references/autonomy-contract.md) for state machine details.
