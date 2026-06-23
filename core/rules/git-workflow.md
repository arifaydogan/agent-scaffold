# Git Workflow Rules

Standard policies for branch management, commit messages, and repository access.

## 1. Branch Naming Conventions

- Task branches must be prefixed with the ticket type and ID.
- Format: `[pace/gh/issue]-[id]-[short-description]`
- Examples:
  - `pace-125-core-rules`
  - `pace-128-git-hooks`
  - `hotfix-10-auth-leak`

## 2. Commit Message Structure

- All commits must include the Jira issue ID or GitHub issue ID prefix.
- Format: `[TICKET-ID] type: description`
- Valid types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `style`
- Examples:
  - `[PACE-125] chore: repo structure + global rules`
  - `[PACE-126] feat: 9 core agent definitions`
  - `[PACE-128] fix: credential scanner pattern`

## 3. Parallel Worktree Architecture

To prevent branch switching collisions when multiple AI agents work on different services:
- Maintain separate worktrees for frontend, backend, and computer vision components:
  - `/houndvision-cv-engine-agent` (for cv-engine tasks)
  - `/houndvision-backend-agent` (for API and database tasks)
  - `/houndvision-frontend-agent` (for Next.js and client tasks)
- Agents must checkout local feature branches within their designated worktree and never work directly on main branches.

## 4. Pull Requests & Reviews

- PR titles must match the commit message format.
- PR descriptions must list:
  1. Changes made
  2. Test results
  3. Action taken on unhappy path scenarios
- No PR can be merged without automated test suites passing.
