# PaceBuild Orchestrator

This is the provider-neutral execution contract for PaceBuild Jira work.
Adapters may discover or invoke it differently, but they must not duplicate or
override its workflow.

The user only needs to provide a Jira issue key such as `PACE-43`, an exact Jira
issue title, or an epic. Resolve a title to exactly one issue before continuing.
If no issue or multiple issues match, stop Phase 0 and ask for the issue key.

`PACE-43 REVIEW` is a distinct read-only command. It runs the independent
review workflow below; it does not restart implementation planning or ask for
the Phase 1 and Phase 2 approval tokens.

When the resolved issue is an epic or has child issues, inspect all children,
derive dependency order, and select the first eligible, unblocked child as the
next executable unit. Do not implement an epic as one large change.

## Non-negotiable state machine

Start every new issue at `PHASE_0_READ_ONLY`.

Allowed transitions:

```text
PHASE_0_READ_ONLY
  -> WAITING_PHASE_1_APPROVAL
  -> PHASE_1_READ_ONLY
  -> WAITING_PHASE_2_APPROVAL
  -> PHASE_2_IMPLEMENTATION
  -> PHASE_3_REVIEW
  -> WAITING_EXTERNAL_WRITE_APPROVAL
  -> PHASE_4_HANDOFF
```

No state may be skipped.

## Approval tokens

Only these exact user messages unlock the next state:

- `APPROVE PHASE 1`
- `APPROVE PHASE 2`
- `APPROVE EXTERNAL WRITES`

Messages such as `continue`, `proceed`, `do it`, or issue descriptions are not
approval tokens.

## Read-only phases

During Phase 0 and Phase 1:

- do not create, edit, rename, or delete files;
- do not create task artifacts such as `task.md`, plans, or memory files in the
  repository;
- do not run build, test, Docker, formatter, installer, or package commands;
- do not create branches, worktrees, commits, pushes, or pull requests;
- do not write to Jira, Confluence, or GitHub;
- terminal commands are limited to read-only inspection such as `git remote`,
  `git status`, `git diff`, directory listing, search, and file reads.

If a tool proposes a mutation, refuse it and remain in the current state.

## Phase 0 - Intake and repository gate

Persona: `product-manager`

Use Atlassian MCP to read:

- issue and issue type;
- parent epic;
- comments and links;
- labels and status;
- description and acceptance criteria.

Then perform a separate child-issue query using Jira MCP:

- search for `parent = <ISSUE_KEY>`;
- record every child key, summary, status, and description;
- if the issue response reports subtasks, verify the separate query returns
  the same keys;
- if child retrieval fails, Phase 0 is blocked and cannot be marked complete.

Run `git remote get-url origin` and normalize the current repository.

Known repository ownership:

| Jira parent epic | Expected repository |
| --- | --- |
| `PACE-124` | `arifaydogan/agent-scaffold` |
| `PACE-6` | `arifaydogan/houndvision` |
| `PACE-42` | `arifaydogan/houndvision` |
| `PACE-61` | `arifaydogan/houndvision` |

If repositories differ, stop with a blocked handoff. Do not inspect local
implementation files.

If the issue has subtasks:

- list every subtask in the Phase 0 handoff;
- derive their dependency order from descriptions and issue links;
- classify the parent as a coordination issue unless its own acceptance
  criteria require independent implementation;
- set the next executable unit to the first unblocked subtask;
- route the next phase from that executable subtask, not from the parent;
- never plan or implement the parent as one large change.

### Narrow routing gate

The proposed Phase 1 task agent and skills must match the first executable
issue's actual file/domain scope:

| Executable issue scope | Task agent | Minimum starting skills |
| --- | --- | --- |
| `cv-engine/`, OpenCV, YOLO, tracking, mock CV event | `cv-engineer` | `senior-computer-vision`, `cv-pipeline-checks` |
| `backend/`, API, FastAPI, persistence | `backend-engineer` | `senior-backend`, `backend-testing` |
| `frontend/`, Next.js, React, UI | `frontend-engineer` | `senior-frontend`, `frontend-testing` |
| Docker, CI/CD, deployment | `devops-engineer` | `senior-devops` |
| Tests only | `qa-engineer` | `tdd-guide` |

Do not select `architect` or `senior-architect` for a single-service,
single-module subtask. Add a cross-domain skill only when the executable
subtask itself changes that domain. A future dependent subtask is not a reason
to preload its agent or skills.

### Phase 0 completion gate

Do not output `Phase 0 complete` until all items below have explicit evidence:

- [ ] current Git remote and expected repository match;
- [ ] issue, parent epic, comments, links, labels, and acceptance criteria read;
- [ ] separate `parent = <ISSUE_KEY>` child query executed;
- [ ] child issues listed, or evidence recorded that none exist;
- [ ] dependencies and first executable issue identified;
- [ ] next task agent and minimum skills derived from the first executable issue;
- [ ] non-goals and human-only actions stated;
- [ ] no repository or external mutation performed.

The handoff `Verification` field must include the child-query result. A generic
statement such as `Jira issue read` is insufficient.

Finish with the mandatory handoff and enter
`WAITING_PHASE_1_APPROVAL`. Do not continue automatically.

## Phase 1 - Technical analysis

Enter only after the exact message `APPROVE PHASE 1`.

Persona: one of `startup-cto`, `devops-engineer`, or `solo-founder`.

Read the minimum relevant files and skills. Select the narrowest task agent.
Architect is used only for genuine cross-service architecture decisions, not
as the default for every technical task.

If Phase 0 identified subtasks, Phase 1 must analyze only the first approved,
unblocked subtask unless the user explicitly selects another child issue.

At Phase 1 entry, re-read the selected child issue and reject any route that
does not satisfy the narrow routing gate.

Output:

- current behavior versus acceptance criteria;
- subtask dependency order;
- exact files expected to change;
- minimum skill stack;
- intended base branch and task branch name;
- verification plan;
- risks and unresolved decisions.

Finish with the mandatory handoff and enter
`WAITING_PHASE_2_APPROVAL`. Do not edit files or continue automatically.

## Phase 2 - Implementation

Enter only after the exact message `APPROVE PHASE 2`.

Before editing:

1. run `git status --short --branch`;
2. run `git remote show origin` or equivalent to determine the remote default
   branch;
3. verify the current commit is based on the latest remote default branch;
4. inspect every modified or untracked non-ignored file;
5. if the current branch is a setup, feature, or unrelated task branch, do not
   create the issue branch from it;
6. if unrelated tracked changes exist, stop with a blocked preflight handoff
   and ask the user to commit, stash, or discard them;
7. create or switch to `pace-<issue-number>-<short-description>` from the
   latest remote default branch;
8. state the exact allowed file scope before editing.

Never silently carry tracked changes from another branch into the issue
branch. Ignored local agent configuration may remain in place.

Before the first edit, verify the branch name matches:

```text
^pace-[0-9]+-[a-z0-9-]+$
```

If it does not match, rename or recreate it before continuing.

Implement the approved plan, run relevant tests, and produce a Phase 2
handoff. Do not push or write to external systems.

### Phase 2 completion gate

Do not output `Phase 2 complete` until all items below pass:

- [ ] `git diff --name-only` contains only the approved file scope;
- [ ] the branch name matches `^pace-[0-9]+-[a-z0-9-]+$`;
- [ ] `git diff --check` passes;
- [ ] unrelated tracked changes are absent from the issue branch;
- [ ] every acceptance criterion has a corresponding verification command;
- [ ] verification exercises runtime behavior, not only import, syntax,
  `--help`, build, or object construction;
- [ ] expected output and exit status are recorded;
- [ ] failures or untested criteria remain in Phase 2 as blockers.

For mock/offline modes, verification must prove the behavior works without the
real external dependency being replaced. For example, a mock CV mode must
produce its event without requiring a camera or real model.

Do not satisfy this requirement by shadowing or replacing the dependency in
the test environment. Temporary files such as `cv2.py`, fake modules,
monkeypatches, or mocks that bypass the production control flow are forbidden
when the acceptance criterion requires the production mock/offline path itself
to avoid that dependency.

If any item fails, report `Phase 2 blocked`, keep the state at
`PHASE_2_IMPLEMENTATION`, and do not transition to review.

## Phase 3 - Independent review

Review the diff, tests, acceptance criteria, security risks, and out-of-scope
changes. Fixes require a clear review finding. Finish with a Phase 3 handoff.

Phase 3 must be a distinct state and handoff. Do not request external-write
approval while the reported state is `PHASE_3_REVIEW`.

Before Phase 3 completes:

- run `git status --short --branch`, `git diff --check`, and inspect untracked
  files separately;
- review every changed line for unused imports, dead variables, hidden test
  doubles, infinite-loop behavior, and scope creep;
- for changed Python files, run `ruff check <changed-python-files>`; if Ruff is
  unavailable, install it in the active development environment or report the
  review as blocked;
- require an automated test when behavior can be tested without external
  hardware or services;
- list the exact repository test file covering the changed behavior; ad-hoc
  `python -c`, timed threads, console inspection, and `--help` commands are
  supplemental evidence, not automated tests;
- run test files through the repository's test runner. A failed `pytest`
  invocation cannot be replaced with `python test_file.py`, a custom
  `__main__` block, or printed `All tests passed` output;
- for Python tests, require an actual zero-exit `pytest` command unless the
  repository explicitly uses another committed test framework;
- validate typed/structured acceptance criteria semantically: UUID values must
  parse as UUIDs, and UTC timestamps must parse as timezone-aware UTC values;
- map each acceptance criterion to evidence;
- report findings before summaries.

Do not claim `no unused imports`, `no dead variables`, or `all tests passed`
without including the corresponding command and exit status in Verification.

If findings require code changes, return to `PHASE_2_IMPLEMENTATION`, apply the
approved in-scope fixes, rerun verification, and repeat Phase 3.

### Automatic review-fix loop

The original `APPROVE PHASE 2` remains valid for fixes that:

- stay inside the approved file scope;
- directly address a Phase 3 finding;
- do not change architecture, public contracts, dependencies, or acceptance
  criteria;
- are objectively verifiable by lint, tests, or diff inspection.

For these findings, do not ask the user to diagnose or approve each fix.
Automatically:

1. report the finding with file and line;
2. transition back to `PHASE_2_IMPLEMENTATION`;
3. apply the smallest fix;
4. stage the complete approved diff;
5. rerun `ruff`, the repository test runner, `git diff --cached --check`, and
   acceptance verification;
6. transition to `PHASE_3_REVIEW` and review again.

Continue until Phase 3 is clean or three review-fix iterations have failed.

Stop and request human approval only when a fix would:

- touch a file outside the approved scope;
- change an API/schema/architecture decision;
- add or remove a dependency;
- alter Jira acceptance criteria;
- discard or overwrite unrelated user work.

The final Phase 3 handoff must include:

- findings discovered;
- fixes applied;
- review-fix iteration count;
- final lint/test commands and exit codes;
- confirmation that no unresolved findings remain.

Only a successful Phase 3 handoff may enter
`WAITING_EXTERNAL_WRITE_APPROVAL`.

## Model and token routing

Use the lowest-cost model and reasoning effort that can safely complete the
current bounded phase. Do not use a high-cost model merely because a task is
new or because an issue has an epic parent.

| Work | Default route | Escalate only when |
| --- | --- | --- |
| Jira/Confluence intake, child ordering, documentation, simple diff scan | lowest-cost available model, low or medium reasoning | evidence conflicts, scope is ambiguous, or a cross-service decision is needed |
| Single-module implementation and ordinary tests | provider-selected balanced model, medium reasoning | the change crosses services, changes public contracts, or verification fails repeatedly |
| Security, concurrency, data-loss, auth, migration, or cross-service review | strongest available model, high reasoning | never downgrade these risks solely to save tokens |

For an independent review, spawn exactly one read-only reviewer. Start with
the adapter's lightweight reviewer; use its deep reviewer only for the
high-risk conditions in the table. Do not fan out multiple reviewers unless the
user explicitly requests parallel review: subagents consume additional tokens.

Adapters own concrete model names and selection mechanisms. The active
conversation cannot change its own model solely by reading this file.

## External writes

Jira transitions/comments, Confluence writes, pushes, and pull request creation
require the exact message `APPROVE EXTERNAL WRITES`.

After approval, transition the implemented executable issue to the project's
configured review status, normally `In Review`, and add the evidence handoff.
If the original input was an epic, transition only the implemented child issue;
never transition or modify the epic.

Create or update one Confluence validation page linked from the Jira issue or
the project's documented delivery space. Read the target page before updating
it. The page and the Jira handoff must contain the same review packet:

- Jira issue key, repository, branch, commit SHA, and pull-request URL;
- acceptance-criteria result and exact automated test commands with exit codes;
- manual test cases with preconditions, steps, expected result, and observed result;
- a user-visible change log: screens, APIs, events, errors, permissions, and
  non-changes relevant to users or operators;
- known limitations, feature flags, test data, rollback notes, and reviewer
  focus areas.

If no linked or configured Confluence location can be identified, do not guess
or create an arbitrary page. Record the missing location in the Jira handoff
and complete the other approved external writes.

## Independent review handoff

A fresh reviewer receives only `PACE-43 REVIEW` or a pull-request URL. The
implemented-task handoff must put this exact `Review packet` in the Jira
comment before the issue transitions to `In Review`:

- repository, base branch, implementation branch, commit SHA, and PR URL;
- linked Confluence validation page;
- acceptance-criteria result and automated/manual test evidence;
- user-visible change scenarios, known limitations, and reviewer focus areas.

For `PACE-43 REVIEW`, the reviewer reads that packet, fetches the stated branch
if necessary, and compares the implementation branch with the declared base.
It must not infer a branch from the current checkout, task title, or a previous
conversation. A missing, contradictory, or inaccessible packet is a review
blocker.

The reviewer must remain read-only and report findings with file and line
references. Its completion report is written in the chat unless the user
separately approves an external review comment.

The reviewer does not transition Jira, update Confluence, push, create a pull
request, or apply fixes. A separate implementation run handles accepted review
findings through the normal Phase 2 and Phase 3 loop.

Never transition an issue to Done or merge a pull request.

## Mandatory handoff

```text
Phase [N] complete.
State: [state]
Objective: [...]
Persona: [...]
Skills: [...]
Task agent: [...]
Decisions: [...]
Artifacts: [...]
Verification: [...]
Review packet: [repository, base branch, implementation branch, SHA, PR, Confluence page]
Open items: [...]
Switching to: [...]
Human approval needed: [exact approval token]
```
