---
name: jira-management
description: Maintain traceable Jira work without exceeding agent authority.
triggers: [jira, backlog, sprint, issue, status]
always: false
---

# Jira Management

Read the issue, comments, parent, links, and phase before work. Require testable acceptance criteria. Agents may move work to review but never to Done, alter epics, delete issues, or merge without human approval.
