---
name: minimal-change
description: Enforces targeted code modifications by reusing local project patterns and avoiding unapproved dependencies. Use this skill when making code edits, fixing bugs, or implementing scoped tasks where refactoring must be minimized and existing test assertions preserved.
---

# Minimal Change

## Overview

The `minimal-change` skill enforces strict scope containment during autonomous software delivery tasks. It prioritizes reusing local codebase patterns, standard native runtime utilities, and tiny target modifications while preserving all test assertions, security contracts, and acceptance criteria.

## Core Rules

1. **Remove / No Change First**: Prefer deleting unused code or making no change over unnecessary refactoring or rewrite.
2. **Reuse Local Code**: Search existing modules, shared helpers, and project patterns before introducing new helpers or classes.
3. **Standard / Native Capabilities**: Prefer standard library and native runtime modules over new third-party packages.
4. **Existing Dependencies**: Leverage packages already declared in project manifests before considering new external dependencies.
5. **Tiny Local Implementation**: When missing a tiny utility, author a minimal local function cleanly scoped to the task.
6. **Measured Dependency Justification**: Adding a new external dependency requires explicit technical rationale and approval.
7. **Preserve Integrity**: Never weaken tests, swallow exceptions, bypass linting, or lower security thresholds to satisfy execution.
