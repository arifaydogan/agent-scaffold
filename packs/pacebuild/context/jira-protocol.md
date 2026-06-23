# PaceBuild Jira Protocol Context

This context override restricts issue tracking and management specifically to the PaceBuild project key and domain.

## Project Scope
- **Jira Domain:** `houndvision.atlassian.net`
- **Project Key:** `PACE` (PaceBuild)
- **Allowed Issue ID Format:** `PACE-[0-9]+`

## Commit & Branch Naming Context
- All commit messages must be prefixed with the active PaceBuild issue key (e.g. `[PACE-129] Implement PaceBuild extension pack`).
- All worktree branches must be named in the format `pace-[0-9]+-short-description` (e.g. `pace-129-pacebuild-extension`).

## Status Transitions
- Before starting work on any `PACE-XX` issue, transition the issue to **Devam Ediyor** (In Progress) on `houndvision.atlassian.net`.
- When work is finished and ready for review:
  - Transition the issue to **İncelemede** (In Review).
  - Add a comprehensive progress comment explaining the changes made, the files touched, and the testing steps performed.
  - Do NOT transition any issue to **Tamam** (Done) without human verification.
