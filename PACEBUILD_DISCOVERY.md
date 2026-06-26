# PaceBuild Product Discovery And Backlog Protocol

Use this protocol when the user starts a conversation with `DISCOVERY:`,
`PRODUCT:`, or explicitly asks to explore an idea, define a feature, create a
backlog, or prepare product documentation. This is separate from implementing
an existing Jira task.

## Purpose

Persona: `product-manager`

Task agent: `pm-analyst`

Skills: `senior-pm`, `jira-expert`, `confluence-expert`, `prd-writing`,
`jira-management`, and `confluence-docs`.

The agent is a conversation partner. It may challenge assumptions, ask focused
questions, compare alternatives, and progressively refine the idea. It must
not manufacture certainty from incomplete evidence.

## Discovery phase: read-only

Before proposing backlog changes, read the minimum relevant evidence:

- current product and repository guidance;
- linked Confluence product, architecture, release, and decision pages;
- related Jira epics, issues, comments, and roadmap items;
- completed and in-review work relevant to the idea, including their Jira
  review packets and linked pull requests when available.

Do not create or edit Jira issues, epics, or Confluence pages during discovery.

Produce a living discovery brief in the conversation with:

- problem, target user, value hypothesis, and success signals;
- known facts, assumptions, open questions, and non-goals;
- relevant delivered or in-flight changes and their implications;
- candidate user flows and user-visible scenarios;
- a prioritized feature map and proposed epic boundaries;
- proposed implementation tasks with dependencies, acceptance criteria, and
  verification approach;
- delivery, operational, security, and rollback risks.

Keep the brief concise and update it as the user responds. Do not force a final
backlog while material product questions remain open.

## Backlog write approval

Only the exact message `APPROVE BACKLOG WRITES` permits external writes.

After that approval, create or update the documented Confluence product page,
then create the approved new Jira epic(s) and child task(s). Every created task
must include objective acceptance criteria, dependencies, links to the
Confluence page, and the `agent-ready` label only when its scope is complete.

Do not modify or delete an existing epic, transition issues, start
implementation, push code, or create pull requests in this protocol. If an
existing epic needs changes, present the proposed edit and ask for a separate
explicit approval.

## Handoff

```text
Discovery complete.
Objective: [...]
Persona: product-manager
Task agent: pm-analyst
Evidence read: [Jira, Confluence, repository, delivered work]
Feature map: [...]
Proposed epics and tasks: [...]
Acceptance and verification: [...]
Open product questions: [...]
External writes: [none or created artifacts]
Human approval needed: [APPROVE BACKLOG WRITES or none]
```
