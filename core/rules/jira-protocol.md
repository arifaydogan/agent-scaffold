# Jira Agent Protocol
Issue tracker: houndvision.atlassian.net · Project: PACE

## 1. Task Acquisition
- Before starting work on an issue `PACE-XX`, read the issue description and ALL comments carefully.
- Check the parent epic. If the issue is part of a backlog/blocked epic, STOP and ask the user for confirmation.
- Change the issue status to **Devam Ediyor** (In Progress) before starting code modifications.
- Create a feature branch named `pace-XX-kisa-aciklama`.

## 2. Execution Constraints
- Do not perform out-of-scope modifications. If another issue or module is affected, leave a comment on that issue and do not touch it.
- If a blocker is encountered, write a detailed comment in Jira and notify the team immediately.

## 3. Issue Completion & Handover
- Complete the acceptance criteria self-check.
- Write a completion comment: list what was done, how it was verified, and any known limitations.
- Open a Pull Request with the title `[PACE-XX] short description` and link the Jira URL in the description body.
- Transition the Jira issue to **İncelemede** (In Review).
- **CRITICAL:** Do NOT transition the issue to **Tamam** (Done) yourself. This requires human authorization.

## 4. Strict Prohibitions
- **No Epic Modifications:** Never alter the status, description, or delete any Epic issue.
- **No Direct Done Transition:** Do not change issue status to Done.
- **No Conflict Work:** Do not touch tasks assigned to other agents.
- **No Unauthorized Backlog Ingestion:** Do not pull backlog tasks without explicit user approval.
- **No Issue Deletion:** Never delete any issue from Jira.
