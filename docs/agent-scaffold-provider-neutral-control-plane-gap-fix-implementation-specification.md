# Agent Scaffold — Provider Neutral Control Plane
## Gap-Fix Implementation Specification

**Repository:** `arifaydogan/agent-scaffold`  
**Target branch:** `epic/provider-neutral-control-plane`  
**Current branch head inspected:** `5ad0bd45e910fb68dddf2af1c8dfb7e89126fb8d`  
**Base:** `develop`

---

# 1. Objective

The previous implementation created a useful foundation, but a significant part of the requested functionality currently exists only as:

1. interfaces,
2. scaffolding,
3. UI placeholders,
4. database placeholders,
5. comments/TODO-level behavior,
6. or documentation in `docs/tasks.md`.

This task is **not** to create additional architecture documentation.

This task is to turn the remaining specification into **working, tested runtime behavior**.

`docs/tasks.md` must be treated only as historical/reference documentation.  
Do not consider an item completed merely because:

- an interface exists,
- an empty method exists,
- a DB table exists,
- a UI section exists,
- a provider name can be selected,
- or a README claims the feature exists.

A feature is complete only when its end-to-end behavior works and is covered by tests.

---

# 2. Critical Rule

## DO NOT create more stubs

The following are **not acceptable implementations**:

```js
async method() {
  throw new Error("Not implemented");
}
```

or:

```js
async method() {
  return [];
}
```

when the provider is expected to support the capability.

Similarly this is **not** a valid LLM orchestrator implementation:

```js
async createPlan(workItem) {
  return routeIssue(workItem);
}
```

A Codex, Claude Code, Antigravity, or generic CLI orchestrator must actually invoke its configured provider.

---

# 3. Definition of Complete

For every section below:

```text
implementation
+
runtime integration
+
tests
+
safe failure behavior
+
observable state
```

are required.

Where a feature cannot be supported by a provider, return an explicit capability result such as:

```json
{
  "supported": false,
  "reason": "GitHub Issues does not expose native parent-child relationships in this adapter"
}
```

Do not silently pretend the capability was executed.

---

# 4. P0 — Fix State-Driven Dispatch

This is the highest-priority issue.

The current dispatcher groups:

```text
ready
review
rework
```

into the same ordinary execution path and ultimately calls the same `runIssueImpl()` implementation path. This violates the intended lifecycle. 

## Required behavior

Implement explicit pipeline routing:

```js
switch (workItem.canonicalState) {
  case "ready":
    return handleImplementation(workItem);

  case "review":
    return handleReview(workItem);

  case "rework":
    return handleRework(workItem);

  case "human_approval":
    return handleHumanApprovalObservation(workItem);

  default:
    return skipWorkItem(workItem);
}
```

## READY

`ready` must:

```text
PM planning
→ agent routing
→ builder execution
→ deterministic verification
→ work source transition to review
```

## REVIEW

`review` must:

```text
load implementation evidence
→ create independent reviewer run
→ review exact implementation SHA
→ persist structured review result
```

It must **never** launch the regular builder path.

## REWORK

`rework` must:

```text
load original task
+ implementation history
+ previous review findings
+ previous implementation SHA
+ verification evidence
→ run bounded rework
→ verify again
→ return to review
```

## HUMAN_APPROVAL

No builder or reviewer must run automatically.

Runtime may observe the state and expose it to the Control Plane.

---

# 5. P0 — Complete Review → Rework → Human Approval Lifecycle

Canonical `rework` and `human_approval` states already exist. 

The complete lifecycle must now work.

## Required flow

```text
READY
  ↓
IN_PROGRESS
  ↓
REVIEW
  ├─ FAIL → REWORK → REVIEW
  │
  └─ PASS → HUMAN_APPROVAL
```

## On successful implementation

If provider writes are enabled and runtime external writes are allowed:

```text
ready
→ in_progress
→ review
```

must be persisted to the work source.

## On review failure

Persist:

```text
structured review findings
review attempt
implementation SHA
reviewer identity
review evidence
```

Then:

```text
workSource.addComment(...)
workSource.transition(..., "rework")
```

## On review success

For standalone work items:

```text
workSource.transition(issue, "human_approval")
```

must occur.

For child work items belonging to an integration parent:

```text
review clean
→ queue integration
```

must occur instead.

Final parent/integration work reaches `human_approval`.

---

# 6. Structured Review Findings

The current review model primarily stores `verdict + evidence[]`. It must become structured.

Use a schema equivalent to:

```json
{
  "reviewId": "uuid",
  "implementationSha": "full-git-sha",
  "reviewer": {
    "runId": "...",
    "agentId": "correctness-reviewer",
    "provider": "claude-code",
    "model": "..."
  },
  "verdict": "changes-requested",
  "findings": [
    {
      "id": "R1",
      "severity": "major",
      "category": "correctness",
      "file": "src/example.js",
      "line": 42,
      "problem": "Empty response causes HTTP 500",
      "expected": "Return HTTP 200 with an empty collection",
      "verification": "Call endpoint with no matching rows"
    }
  ],
  "reviewedAt": "..."
}
```

## Required severities

```text
critical
major
minor
suggestion
```

## Required categories

At minimum:

```text
correctness
security
scope
tests
regression
api-contract
data-integrity
simplicity
```

---

# 7. Work Source Review Comments

Generate human-readable comments from structured findings.

Example:

```md
## Agent Review Failed

Implementation: `<sha>`

Reviewer: `correctness-reviewer`

### R1 · Major · Correctness

**File:** `src/example.js:42`

**Problem**

Empty response causes HTTP 500.

**Expected**

Return HTTP 200 with an empty collection.

**Verification**

Call endpoint with no matching rows.
```

Do not reduce review feedback to one unstructured evidence string.

---

# 8. Rework Attempt Limits

Add a dedicated policy:

```json
{
  "review": {
    "maxReworkAttempts": 3
  }
}
```

Do not overload unrelated retry settings.

After limit exhaustion:

```text
runtime → blocked
work source → blocked, if safely writable
comment → Human Attention Required
```

The comment must explain:

```text
number of rework attempts
latest implementation SHA
latest findings
why automation stopped
```

---

# 9. P0 — Add Real Operating Modes

Implement first-class project operating modes:

```text
manual
supervised
autonomous
```

These currently do not exist as real runtime behavior.

## Config

Add:

```json
{
  "project": {
    "key": "PACE",
    "operatingMode": "supervised"
  }
}
```

Validate allowed values.

---

# 10. Manual Mode

Manual means:

```text
work-source sync           allowed
PM analysis                allowed
PM chat                    allowed
plan generation            allowed
dependency analysis        allowed
automatic worker dispatch  denied
```

Example:

```text
User:
Analyze PACE-412. Do not start it.

PM:
Analysis completed.
Suggested agent: backend-engineer.
No execution started.
```

Execution must require explicit human action.

---

# 11. Supervised Mode

Supervised means:

```text
discovery        automatic
analysis         automatic
routing          automatic
plan             automatic
execution        requires human approval
```

The Control Plane must expose:

```text
Approve
Reject
Edit Plan
```

for pending execution plans.

No worker process may start before approval.

---

# 12. Autonomous Mode

Autonomous means the PM may automatically:

```text
discover
analyze
route
build
verify
review
rework
integrate child work
create PR where policy permits
```

but must still stop at deterministic human-only gates.

---

# 13. Granular Autonomy Policy

Operating mode is only a preset.

Add policy similar to:

```json
{
  "autonomy": {
    "discovery": "auto",
    "planning": "auto",
    "routing": "auto",
    "implementation": "auto",
    "review": "auto",
    "rework": "auto",
    "createBranch": "auto",
    "createPullRequest": "auto",
    "integrateChildren": "auto",

    "finalMerge": "human",
    "markDone": "human",
    "productionDeploy": "human",
    "destructiveMigration": "human",
    "credentialChanges": "human"
  }
}
```

Allowed action values:

```text
auto
approval
disabled
```

---

# 14. Run Configuration Snapshot

A running task must not change behavior if configuration is modified from the UI.

At run creation persist:

```json
{
  "configSnapshot": {
    "operatingMode": "autonomous",
    "policyVersion": 4,
    "orchestratorProvider": "codex",
    "executorProvider": "antigravity",
    "agentId": "backend-engineer",
    "agentVersion": 8,
    "codeIntelligenceProvider": "codebase-memory"
  }
}
```

Any later Control Plane config mutation applies only to future runs unless the operator explicitly performs a supported run-level action.

---

# 15. P0 — Real Orchestrator Providers

Current non-builtin orchestrators fall back to `routeIssue()`. That is a stub and must be replaced. 

Implement actual orchestrator adapters for:

```text
builtin
codex
antigravity
claude-code
generic-cli
```

The design must make adding another provider straightforward.

---

# 16. Orchestrator Provider Contract

Use an interface comparable to:

```js
class OrchestratorProvider {
  async analyzeWorkItem(context) {}
  async createPlan(context) {}
  async routeWork(context) {}
  async decomposeParent(context) {}
  async buildDependencyGraph(context) {}
  async respondToHuman(context) {}
  async handleBlocker(context) {}
  async summarizeDecision(context) {}
}
```

Each configured LLM orchestrator must invoke the real CLI/provider.

---

# 17. Structured PM Output

Do not parse free-form prose to drive the runtime.

The PM must return validated structured output.

Example:

```json
{
  "persona": "startup-cto",

  "taskAgent": "backend-engineer",

  "skills": [
    "api-design",
    "backend-testing",
    "minimal-change"
  ],

  "capabilities": [
    "code-intelligence",
    "git"
  ],

  "executor": {
    "provider": "antigravity",
    "modelProfile": "medium"
  },

  "risk": "normal",

  "parallelSafe": true,

  "dependencies": [],

  "allowedPaths": [
    "backend/**",
    "tests/**"
  ],

  "decisionSummary": [
    "Task modifies backend API behavior",
    "No destructive migration detected"
  ]
}
```

Schema validation failure must fail closed.

---

# 18. Persona and Task Agent Must Be Separate

The current runtime still assigns:

```js
taskAgent: route.persona
```

which must be removed. 

Correct conceptual model:

```text
Persona
   ↓
Task Agent
   ↓
Skills
   ↓
Capabilities
   ↓
Executor
   ↓
Model
```

Example:

```yaml
persona: startup-cto
taskAgent: backend-engineer

skills:
  - api-design
  - backend-testing
  - minimal-change

executor:
  provider: codex
  modelProfile: medium
```

`persona` is judgment style.

`taskAgent` is the specialist role.

They must not be aliases.

---

# 19. Agent Registry — Complete It

Current storage only keeps the latest definition and increments a version number. Historical versions are lost. 

Implement immutable version history.

Recommended tables:

```sql
agent_definitions
-----------------
id
status
current_version
created_at
updated_at

agent_versions
--------------
agent_id
version
definition_json
definition_hash
created_at
PRIMARY KEY(agent_id, version)
```

---

# 20. Agent Lifecycle

Support:

```text
enabled
disabled
archived
```

Rules:

### Enabled

May receive new work.

### Disabled

May not receive new work.

Historical runs remain visible.

### Archived

Cannot receive work and is hidden from normal selection UI.

Historical runs remain resolvable.

### Hard delete

Allow only when:

```text
agent has never been used by a run
```

Otherwise reject.

---

# 21. Agent Definition

Minimum model:

```json
{
  "id": "backend-engineer",
  "displayName": "Backend Engineer",
  "status": "enabled",
  "role": "implementation",

  "defaultPersona": "startup-cto",

  "skills": [
    "api-design",
    "backend-testing",
    "minimal-change"
  ],

  "capabilities": [
    "code-intelligence",
    "git"
  ],

  "executor": {
    "provider": "codex",
    "modelProfile": "medium"
  },

  "reviewer": "correctness-reviewer",

  "risk": "normal",

  "maxConcurrency": 2,

  "allowedPaths": [
    "backend/**",
    "tests/**"
  ]
}
```

---

# 22. Agent Registry Runtime Integration

The registry must not only exist in SQLite.

PM routing must resolve:

```text
taskAgent id
→ active agent definition
→ version
→ skills
→ capabilities
→ executor defaults
→ path scope
→ concurrency
```

The selected immutable agent version must be attached to the run.

---

# 23. Agent Management API

Implement:

```text
GET    /api/agents
POST   /api/agents

GET    /api/agents/:id
PATCH  /api/agents/:id

POST   /api/agents/:id/enable
POST   /api/agents/:id/disable
POST   /api/agents/:id/archive
```

Optional:

```text
DELETE /api/agents/:id
```

only for never-used agents.

Mutations must:

```text
require loopback request
require JSON
validate schema
write audit event
never expose secrets
```

---

# 24. Agent Management UI

Current Agent UI only renders stored JSON. It must become an actual management interface. 

Implement:

```text
Add Agent
Edit Agent
Enable
Disable
Archive
View Versions
```

The user must be able to select:

```text
persona
skills
capabilities
executor
model profile
reviewer
risk
concurrency
allowed paths
```

---

# 25. P0 — PM Workspace Must Actually Work

The UI currently contains a PM form, but no full conversation API/action path exists. 

Implement:

```text
POST /api/pm/messages
GET  /api/pm/messages
GET  /api/pm/decisions
```

---

# 26. PM Message Flow

For a human message:

```text
UI
↓
Control Plane API
↓
persist user message
↓
selected OrchestratorProvider.respondToHuman()
↓
persist PM response
↓
persist structured decisions if applicable
↓
return response
```

Manual mode must support conversations without launching workers.

---

# 27. PM Decision Journal

Persist decisions such as:

```text
work-discovered
analysis-completed
routing-decision
execution-proposed
execution-approved
execution-started
review-started
rework-requested
integration-decision
human-approval-entered
```

Example:

```json
{
  "type": "routing-decision",
  "workItem": "PACE-412",
  "payload": {
    "persona": "startup-cto",
    "taskAgent": "backend-engineer",
    "executor": "codex",
    "risk": "normal"
  }
}
```

---

# 28. PM Context Management

Do not keep one infinitely-growing conversation.

Use:

```text
persistent messages
persistent decisions
bounded recent messages
structured project/task context
summaries
```

A new PM invocation should reconstruct only the context it needs.

Persist provider conversation IDs only as optional metadata.

Do not make provider-native conversation state the source of truth.

---

# 29. Usage Telemetry — Complete It

Current usage persistence only has basic input/output tokens and duration. 

Expand the schema.

Recommended normalized event:

```json
{
  "projectId": "PACE",
  "workItem": "PACE-412",
  "runId": "...",

  "role": "builder",
  "agentId": "backend-engineer",

  "provider": "codex",
  "model": "...",

  "inputTokens": 32000,
  "outputTokens": 8000,
  "cachedInputTokens": 12000,

  "totalTokens": 40000,

  "context": {
    "used": 54000,
    "limit": 128000,
    "source": "provider"
  },

  "cost": {
    "amount": 0.82,
    "currency": "USD",
    "estimated": true
  },

  "durationMs": 420000
}
```

---

# 30. Usage Roles

Every usage event must identify:

```text
pm
builder
reviewer
rework
integration
```

Do not mix all token usage together.

---

# 31. Context Reporting

If context limit is known:

```text
54,000 / 128,000
42%
```

If limit is unknown:

```text
Context used: 54,000
Context limit: Unknown
```

Do not invent limits.

Do not infer an unsupported context size only from model name unless model metadata is configured explicitly.

---

# 32. Cost Estimation

Optional model pricing config:

```json
{
  "pricing": {
    "provider/model": {
      "inputPerMillion": 2.0,
      "outputPerMillion": 8.0,
      "cachedInputPerMillion": 0.5,
      "currency": "USD"
    }
  }
}
```

If pricing is configured:

```text
Estimated Cost
```

may be calculated.

If pricing is unavailable, do not show fake cost values.

---

# 33. Usage APIs

Implement:

```text
GET /api/usage/summary
GET /api/usage/runs
GET /api/usage/work-items/:id
```

Filters should support where practical:

```text
date range
provider
model
role
agent
work item
```

---

# 34. Usage UI

Build a real usage screen.

Show:

```text
Today
7 Days
30 Days
```

Break down by:

```text
PM
Builders
Reviewers
Rework
```

and:

```text
provider
model
agent
work item
```

Per-run cards must display context usage where available.

---

# 35. P0 — Implement Codebase Memory for Real

Current `CodeIntelligenceProvider` methods are all unimplemented. 

Do not call this integration complete until these methods invoke the real MCP server.

Implement:

```js
health()
getArchitecture()
searchCode()
tracePath()
detectChanges()
impactAnalysis()
checkCoverage()
getSnippet()
```

---

# 36. Codebase Memory MCP Client

Implement an MCP client/adapter that can:

```text
spawn/connect to configured MCP transport
initialize session
discover tools
call tools
handle JSON-RPC errors
timeout safely
terminate cleanly
```

Do not make worker agents responsible for manually invoking Codebase Memory.

The runtime/control plane owns this capability.

---

# 37. Tool Capability Discovery

Do not assume tool names without validating the connected MCP server.

At startup or first use:

```text
discover available tools
map supported capability methods
report unsupported methods explicitly
```

Expected Codebase Memory tools may include:

```text
get_architecture
search_graph
trace_path
detect_changes
check_index_coverage
get_code_snippet
```

but runtime must discover/validate them.

---

# 38. Code Intelligence Preflight

Before PM finalizes an implementation plan, optionally gather:

```text
index health
coverage
relevant architecture
similar code
call paths
impact radius
```

Attach a bounded summary to PM context.

Do not dump the entire graph into the prompt.

---

# 39. Builder Code Intelligence Context

Builder input should include useful structured findings such as:

```json
{
  "architecture": ["..."],
  "relatedSymbols": ["..."],
  "likelyFiles": ["..."],
  "callPaths": ["..."],
  "impactNotes": ["..."]
}
```

The builder may still inspect source directly.

---

# 40. Review Code Intelligence

Before reviewer execution:

```text
Git diff
+
changed symbols
+
Codebase Memory detect_changes
+
impact analysis
```

must be available where provider health permits.

Reviewer should inspect affected callers/dependencies, not only changed files.

---

# 41. Code Intelligence Failure Policy

Add:

```json
{
  "codeIntelligence": {
    "required": false
  }
}
```

If false:

```text
provider unavailable
→ warning event
→ fallback to direct source inspection
```

If true:

```text
provider unavailable
→ block affected run
```

---

# 42. Code Intelligence Health UI

Expose:

```text
Provider
Status
Indexed SHA
Coverage
Last Refresh
Available tools
```

If information cannot be obtained:

```text
Unknown
```

rather than fake values.

---

# 43. Git / Worktree Correctness

Current behavior attempts `origin/HEAD`, then may fall back to local `HEAD`. 

This must be hardened.

Before standalone task worktree creation in execute mode:

```bash
git fetch origin --prune
```

Resolve configured default branch, for example:

```text
origin/develop
```

to an exact SHA.

Persist:

```json
{
  "baseBranch": "develop",
  "baseSha": "..."
}
```

Create worker branch from that SHA.

Do not silently use stale local `HEAD` for autonomous execution.

Dry-run must not mutate Git state.

---

# 44. SourceControlProvider

Introduce a provider boundary rather than hard-coding GitHub-specific future behavior directly into PM logic.

Minimum contract:

```js
class SourceControlProvider {
  async getDefaultBranch() {}
  async fetchRemote() {}
  async resolveRef(ref) {}
  async createBranch(request) {}
  async createPullRequest(request) {}
}
```

Local Git operations may remain separate implementation helpers.

First remote provider:

```text
GitHub
```

Final merge must still remain human-only.

---

# 45. WorkSourceProvider Safety

Current adapters mostly check only `this.writeEnabled`. 

Required external write gate:

```text
provider.writeEnabled
AND
runtime policy.externalWritesEnabled
AND
specific action autonomy policy permits it
```

Centralize this in runtime/policy.

Do not trust each provider implementation to independently remember every gate.

---

# 46. Jira Dependency Semantics

Current Jira dependency implementation treats all issue links as dependencies. 

Fix this.

Only configured blocking link semantics should produce DAG edges.

Example configurable mapping:

```json
{
  "dependencyLinks": {
    "blocks": {
      "outwardMeans": "blocks",
      "inwardMeans": "depends_on"
    }
  }
}
```

A:

```text
relates to
duplicates
clones
```

link must not automatically become an execution dependency.

---

# 47. GitHub Workflow Label Transitions

Current GitHub transition adds a new state label without cleaning previous workflow labels. 

Fix transition semantics.

Before adding the target workflow label:

remove other canonical workflow labels such as:

```text
agent-ready
agent-working
agent-review
agent-rework
human-approval
blocked
```

Then add exactly the target label.

Preserve unrelated labels.

---

# 48. Provider Write Error Handling

Current direct `fetch()` writes must validate HTTP response status.

For every mutation:

```text
non-2xx
→ throw typed provider error
→ persist runtime event
→ do not assume transition succeeded
```

Never silently ignore external write failure.

---

# 49. Canonical WorkItemPacket

Ensure all work sources return a normalized object containing at least:

```json
{
  "key": "...",
  "providerKey": "...",
  "summary": "...",
  "description": "...",
  "acceptanceCriteria": [],
  "issueType": "...",
  "status": "...",
  "canonicalState": "...",
  "labels": [],
  "parentKey": null,
  "children": [],
  "dependencies": [],
  "comments": [],
  "assignee": null,
  "source": {}
}
```

Expensive fields may be lazily hydrated, but the PM must be able to request a complete packet.

---

# 50. Acceptance Criteria Parsing

Do not only detect whether a heading containing `Acceptance Criteria` exists.

Extract actual acceptance criteria when possible.

A description like:

```text
Acceptance Criteria: TBD
```

must not be treated as sufficient.

Implement basic validation that at least one meaningful criterion exists.

---

# 51. P0 — Parent / Story / Epic Orchestration

Current policy still blocks Epics as human-only. 

Change this.

Parent work items must be treated as:

```text
coordination units
```

not direct coding tasks.

---

# 52. Parent Eligibility

Parent may be automatically coordinated only if policy permits.

Do not send an Epic directly to `backend-engineer` to edit source.

Instead:

```text
parent discovered
↓
load children
↓
load dependencies
↓
PM decomposition/validation
↓
build DAG
↓
create integration lane
```

---

# 53. Dependency DAG

Normalize dependencies as:

```json
{
  "nodes": [
    "PACE-401",
    "PACE-402",
    "PACE-403",
    "PACE-404"
  ],
  "edges": [
    ["PACE-401", "PACE-404"],
    ["PACE-402", "PACE-404"],
    ["PACE-403", "PACE-404"]
  ]
}
```

Meaning:

```text
PACE-404 depends on PACE-401/402/403
```

---

# 54. Cycle Detection

Current scheduler may fall back to dispatching an eligible task even when dependency scheduling becomes stuck. 

Replace with real DAG validation.

If:

```text
A → B
B → A
```

then:

```text
parent = blocked
reason = dependency cycle
```

No affected child may launch.

Persist cycle evidence.

---

# 55. Parallel Waves

Use topological ordering.

Example:

```text
401 ─┐
402 ─┼→ 404
403 ─┘
```

Expected:

```text
Wave 1:
401
402
403

Wave 2:
404
```

Within each wave continue enforcing:

```text
global concurrency
provider concurrency
agent concurrency
path overlap
locks
```

---

# 56. Integration Branch

For parent:

```text
epic/pace-400-integration
```

or configured equivalent.

Base it on exact remote default branch SHA.

Child branches must branch from the parent integration base/branch according to the integration model.

---

# 57. Child Integration

Existing reviewed-SHA integration protections must be retained.

Do not weaken:

```text
full implementation SHA
reviewer evidence
reviewed SHA matches leaf
ancestor validation
npm run check before integration commit
```

---

# 58. Parent Integration Review

After all required children have been integrated:

run a parent/integration review against:

```text
parent acceptance criteria
combined diff
integration tests
API contracts
cross-child interactions
E2E where configured
```

Only after this passes:

```text
parent → human_approval
```

and optionally create the final PR.

---

# 59. Final PR

If policy allows PR creation:

```text
integration branch → configured default branch
```

PR may be created automatically.

PR metadata should contain:

```text
parent work item
child work items
reviewed SHAs
verification summary
known risks
```

Do not merge it automatically.

---

# 60. Agent-to-Agent Communication

Do not implement uncontrolled free-form swarm chat.

Use structured handoffs.

Example:

```json
{
  "from": "backend-engineer",
  "to": "frontend-engineer",
  "workItem": "PACE-402",
  "decisions": [],
  "contracts": [],
  "changedFiles": [],
  "verification": [],
  "blockers": []
}
```

Control Plane/runtime persists these artifacts.

---

# 61. Control Plane — Complete Management APIs

The current server is still largely snapshot/provider-config/retry oriented. 

Implement at minimum:

```text
GET   /api/config

PATCH /api/config/operating-mode
PATCH /api/config/autonomy
PATCH /api/config/providers

GET   /api/agents
POST  /api/agents
GET   /api/agents/:id
PATCH /api/agents/:id
POST  /api/agents/:id/enable
POST  /api/agents/:id/disable
POST  /api/agents/:id/archive

GET   /api/pm/messages
POST  /api/pm/messages
GET   /api/pm/decisions

GET   /api/work
GET   /api/work/:id

GET   /api/usage/summary
GET   /api/usage/runs
GET   /api/usage/work-items/:id

POST  /api/control/pause
POST  /api/control/resume
POST  /api/control/emergency-stop
```

---

# 62. Pause Semantics

`Pause Autonomous Dispatch` means:

```text
supervisor remains alive
existing workers continue
new builder work is not started
new autonomous PM dispatches are not started
```

Persist state.

UI must visibly show:

```text
AUTONOMOUS DISPATCH PAUSED
```

---

# 63. Emergency Stop

Emergency Stop must:

```text
stop new launches immediately
request termination of active managed workers
persist operator action
leave durable state recoverable
```

Require explicit confirmation in UI.

Do not delete branches, worktrees, database state, or history.

---

# 64. 4317 Navigation

Move from three placeholder tabs toward:

```text
Overview
PM
Work
Agents
Runs
Reviews
Providers
Capabilities
Workflow
Usage
Settings
```

You may implement this incrementally with the existing vanilla UI.

Do not add React/Next/Vue.

---

# 65. Overview

Show:

```text
Project
Operating Mode
Autonomous Dispatch Status
Supervisor

Work Source
PM Orchestrator
Default Builder
Reviewer
Code Intelligence

Ready
Running
Review
Rework
Human Approval
Blocked

Tokens today
Estimated cost
Context warnings
```

---

# 66. PM Screen

Must support:

```text
conversation
decision journal
pending approvals
active plans
PM provider/model
PM token/context usage
```

---

# 67. Work Screen

Group by canonical state:

```text
Ready
In Progress
Review
Rework
Human Approval
Blocked
```

Each work item:

```text
key
summary
source
parent
agent
provider/model
runtime state
tokens
elapsed
```

---

# 68. Agents Screen

Must provide real management, not raw JSON rendering.

Display:

```text
Agent
Status
Version
Role
Persona
Skills
Capabilities
Executor
Model profile
Concurrency
Current runs
Token usage
```

Actions:

```text
Add
Edit
Enable
Disable
Archive
Versions
```

---

# 69. Runs Screen

Run detail must expose:

```text
work item
parent
role

persona
task agent
agent version
skills
capabilities

orchestrator
executor
model

base branch
base SHA
branch
worktree
implementation SHA

tokens
context
estimated cost

verification
review result
review findings

events
```

Do not expose secrets or complete prompts.

---

# 70. Reviews Screen

Show:

```text
pending reviews
completed reviews
failed reviews
rework attempts
structured findings
reviewer
implementation SHA
```

---

# 71. Providers Screen

Group:

```text
Work Sources
Orchestrators
Executors
Code Intelligence
Source Control
```

Selection changes must apply only to future runs.

Do not allow arbitrary shell command editing from the browser in this phase.

---

# 72. Workflow Screen

Show the actual state machine:

```text
READY
  ↓
IN PROGRESS
  ↓
REVIEW
 ↙     ↘
REWORK  HUMAN APPROVAL
   ↓
 REVIEW
```

Expose safe settings:

```text
max rework
simplicity review
operating mode
autonomy gates
child integration
```

---

# 73. Usage Screen

Show:

```text
tokens
context
estimated cost
duration
```

grouped by:

```text
provider
model
agent
role
work item
```

---

# 74. Audit Trail

Persist all operator and autonomous control-plane actions.

At minimum:

```text
operating-mode-changed
autonomy-policy-changed
provider-changed

agent-created
agent-updated
agent-enabled
agent-disabled
agent-archived

pm-message
pm-decision

task-claimed
task-routed
execution-proposed
execution-approved
execution-started

review-started
review-failed
review-passed

rework-started

integration-started
integration-completed

human-approval-entered

dispatch-paused
dispatch-resumed
emergency-stop
```

---

# 75. Database Migrations

Do not rely only on `CREATE TABLE IF NOT EXISTS` if schema evolution requires columns/indexes.

Implement a lightweight migration mechanism.

For example:

```text
schema_migrations
```

with monotonically increasing migration IDs.

Existing runtime databases must remain usable.

---

# 76. Recommended New Tables

At minimum consider:

```text
schema_migrations

pm_messages
pm_decisions

agent_definitions
agent_versions

usage_events

review_findings

work_item_snapshots

configuration_events

control_plane_state

handoffs
```

Do not create a table unless it is actually used.

---

# 77. Human-Only Boundaries

These remain deterministic runtime rules.

Never make autonomous:

```text
final merge into protected/default branch
mark Done
production deployment
credential/secret mutation
destructive database migration
destructive infrastructure mutation
```

Even if PM/provider asks for them.

---

# 78. `Done` Must Stay Human-Owned

Agents may move a task to:

```text
human_approval
```

They must not move it to:

```text
done
```

A later explicit human integration may be added, but autonomous runtime must not currently mark Done.

---

# 79. Simplicity / Ponytail

Keep Ponytail-derived `minimal-change`.

Builder default may use:

```text
full
```

High-risk work may use:

```text
lite
```

Do not globally apply Ponytail/YAGNI reasoning to PM scope decisions.

PM must not delete requirements simply because they look unnecessary.

---

# 80. Simplicity Reviewer

If enabled:

```text
Correctness Reviewer
        ↓
Simplicity Reviewer
```

Simplicity checks:

```text
unnecessary abstraction
unnecessary dependency
existing helper reuse
stdlib alternative
dead code
smaller safe implementation
```

Default:

```json
{
  "simplicityReview": {
    "enabled": true,
    "blocking": false
  }
}
```

---

# 81. Testing Requirements

Do not finish this task with only existing tests passing.

Add tests for the newly implemented behavior.

---

# 82. State Routing Tests

Required:

```text
ready → builder
review → reviewer
review must not invoke builder
rework → rework path
human_approval → no agent
done → no agent
cancelled → no agent
unknown → fail closed
```

---

# 83. Operating Mode Tests

## Manual

```text
discovery allowed
planning allowed
automatic dispatch denied
explicit human execution allowed
```

## Supervised

```text
plan generated automatically
worker does not start
approval starts worker
rejection does not start worker
```

## Autonomous

```text
ready task automatically proceeds to implementation
```

Human-only final gates remain enforced in all three modes.

---

# 84. WorkSource Tests

## Jira

Test:

```text
canonical read state mapping
write transition
comments
children
parent
blocking dependencies only
write-disabled behavior
external-write-policy behavior
transition failure
```

## GitHub Issues

Test:

```text
canonical labels
PR filtering
comment
workflow label replacement
unrelated label preservation
write failure
write-disabled behavior
```

---

# 85. Review Tests

Test:

```text
review exact SHA required
reviewer identity required
builder cannot reuse builder run as review run
structured findings persisted
review failure → rework transition
review success → human approval
max rework → blocked
```

---

# 86. Orchestrator Tests

Each real orchestrator adapter must have deterministic mocked CLI tests.

Test:

```text
valid structured response
invalid JSON
schema-invalid response
process non-zero
timeout
provider unavailable
```

No non-builtin provider test may merely assert fallback to builtin routing.

---

# 87. Agent Registry Tests

Test:

```text
create
version 1
update → immutable version 2
retrieve v1
retrieve v2
disable
enable
archive
disabled agent not routable
archived agent not routable
used agent cannot hard delete
run retains selected agent version
```

---

# 88. PM Workspace Tests

Test:

```text
POST human message persists
orchestrator receives bounded context
PM response persists
decision persists
manual mode does not launch worker from analysis-only message
```

---

# 89. Usage Tests

Test normalization for:

```text
input tokens
output tokens
cached tokens
known context limit
unknown context limit
cost configured
cost unavailable
role tagging
agent tagging
work-item aggregation
```

---

# 90. Code Intelligence Tests

Use an injectable/mock MCP transport.

Test:

```text
initialize
tool discovery
health
architecture
search
trace
coverage
detect changes
impact analysis

server unavailable + required=false
server unavailable + required=true

timeout
malformed response
```

---

# 91. DAG Tests

Required:

```text
A B C → D
```

produces:

```text
Wave 1: A B C
Wave 2: D
```

Also:

```text
A → B → C
```

produces sequential waves.

Cycle:

```text
A → B
B → A
```

must produce:

```text
BLOCKED
```

No task may be dispatched.

---

# 92. Integration Tests

Test:

```text
child reviewed SHA required
wrong SHA rejected
merge conflict blocked
npm run check failure aborts integration
successful integration
all children integrated gate
parent integration review
human approval transition
```

Do not weaken existing integration tests.

---

# 93. Worktree Tests

Test:

```text
execute performs remote fetch
exact default branch SHA resolved
branch created from exact SHA
stale local HEAD ignored
fetch failure blocks safely
dry-run performs no fetch/mutation
```

---

# 94. Control Plane API Security Tests

Test:

```text
non-loopback mutation denied
hostile Origin denied
wrong Content-Type denied
oversized body denied
unknown fields denied

secret values never returned

raw executable commands not mutable

disabled config mutation denied where applicable
```

---

# 95. PM/Agent UI Is Not Considered Complete Without APIs

A UI element is not completion.

Examples of unacceptable completion claims:

```text
"Add Agent button exists"
```

when no agent can be persisted.

```text
"PM form exists"
```

when submit does nothing.

```text
"Usage tab exists"
```

when it only dumps SQLite rows.

Every user-facing control must invoke a real API and show success/failure state.

---

# 96. Documentation Accuracy

Update README only after implementation.

Do not describe:

```text
real-time Code Intelligence
real orchestrator providers
agent management
PM conversation
autonomous lifecycle
```

as complete unless the corresponding tests and runtime behavior exist.

Explicitly distinguish:

```text
supported
experimental
configured but disabled
not supported
```

---

# 97. Remove Misleading Claims

Review current README changes that call Code Intelligence a real-time integration.

If methods still cannot execute:

either implement them,

or downgrade documentation until they do.

Do not allow documentation to be more complete than the code.

---

# 98. Implementation Order

Execute in this order.

## Phase A — Runtime correctness

1. state-driven dispatcher
2. review/rework/human approval lifecycle
3. structured findings
4. rework limits
5. external write gates

No UI work before these pass.

## Phase B — PM control

1. operating modes
2. autonomy policy
3. config snapshots
4. PM approval states

## Phase C — Orchestrator

1. structured plan schema
2. real generic CLI orchestrator
3. Codex adapter
4. Antigravity adapter
5. Claude Code adapter
6. persona/taskAgent separation

## Phase D — Agents

1. immutable versioning
2. lifecycle
3. routing integration
4. APIs

## Phase E — PM workspace

1. persistent chat
2. real PM invocation
3. decision journal
4. approval actions

## Phase F — Observability

1. normalized usage
2. context
3. cost
4. usage APIs

## Phase G — Code Intelligence

1. MCP client
2. capability discovery
3. runtime preflight
4. review impact
5. health UI data

## Phase H — Parent orchestration

1. Jira dependency semantics
2. DAG
3. cycles
4. integration branch
5. child waves
6. parent integration review
7. PR creation

## Phase I — Control Plane

Build management UI on top of already-working APIs.

## Phase J — Hardening

1. DB migrations
2. full tests
3. security tests
4. documentation
5. backward compatibility

---

# 99. Commit / PR Strategy

Do not put all remaining implementation into another giant unreviewable commit.

Prefer multiple commits even if they remain on this branch.

Suggested commit groups:

```text
fix(runtime): route canonical states to dedicated pipelines

feat(review): complete review rework human approval lifecycle

feat(policy): add operating modes and autonomy gates

feat(orchestrator): add real provider-backed PM execution

refactor(runtime): separate persona and task agent

feat(agents): add versioned agent registry and lifecycle

feat(pm): implement PM conversation and decision journal

feat(usage): normalize token context and cost telemetry

feat(code-intelligence): integrate codebase-memory MCP runtime

feat(orchestration): add dependency-aware parent execution

feat(control-plane): add management APIs and UI

test: complete autonomous delivery acceptance coverage
```

---

# 100. Required Final End-to-End Scenario — Standalone Success

Given:

```text
Jira item PACE-501
state = Agent Ready
```

Autonomous mode must:

```text
discover
↓
PM analyze
↓
select persona/taskAgent/skills/executor
↓
transition Agent In Progress
↓
builder execute
↓
verification
↓
transition Agent Review
↓
independent reviewer execute
↓
review clean
↓
transition Human Approval
```

No final merge.

No Done.

---

# 101. Required Final End-to-End Scenario — Review Failure

```text
Agent Ready
↓
builder
↓
Agent Review
↓
review fail
↓
structured finding persisted
↓
comment written
↓
Agent Rework
↓
rework execution
↓
Agent Review
↓
clean
↓
Human Approval
```

---

# 102. Required Final End-to-End Scenario — Manual Mode

Given:

```text
operatingMode = manual
```

User:

```text
Analyze PACE-600 and tell me how you would implement it.
Do not start work.
```

Expected:

```text
PM responds
plan persisted
decision journal updated
0 workers started
```

---

# 103. Required Final End-to-End Scenario — Supervised Mode

Given:

```text
operatingMode = supervised
```

System discovers PACE-601.

Expected:

```text
analysis automatic
routing automatic
plan automatic
execution status = awaiting approval
```

No worker until human presses:

```text
Approve
```

---

# 104. Required Final End-to-End Scenario — Autonomous Mode

Given:

```text
operatingMode = autonomous
```

No human interaction is required until:

```text
Human Approval
```

except if:

```text
blocked
policy gate
rework exhausted
provider failure requiring operator action
```

---

# 105. Required Final End-to-End Scenario — Parent

Given parent:

```text
PACE-700
```

children:

```text
701 backend
702 frontend
703 CV
704 integration tests
```

dependencies:

```text
701 ─┐
702 ─┼→ 704
703 ─┘
```

Expected:

```text
parent analyzed
↓
integration branch created
↓
Wave 1:
701 702 703
↓
independent reviews
↓
accepted SHAs integrated
↓
Wave 2:
704
↓
review
↓
integrate
↓
parent integration review
↓
PR created
↓
Human Approval
```

---

# 106. Required Final End-to-End Scenario — Agent Management

From `http://127.0.0.1:4317`:

User creates:

```text
mobile-engineer
```

with:

```text
persona
skills
executor
model
paths
concurrency
```

Expected:

```text
agent persisted v1
appears in PM routing choices
can be disabled
disabled agent receives no new work
edit creates v2
old run still resolves v1
```

---

# 107. Required Final End-to-End Scenario — PM Chat

Manual mode.

User opens PM Workspace and sends:

```text
Analyze PACE-812. Which agents would you use?
```

Expected:

```text
POST API called
user message persisted
configured PM provider actually invoked
PM response persisted
structured routing decision persisted
UI updates
no worker automatically starts
```

---

# 108. Required Final End-to-End Scenario — Usage

After one PM, one builder and one reviewer run:

Control Plane must show separate usage for:

```text
PM
Builder
Reviewer
```

At minimum:

```text
input tokens
output tokens
total tokens
duration
provider
model
```

Where provider supports it:

```text
context used
context limit
```

Where pricing is configured:

```text
estimated cost
```

---

# 109. Required Final End-to-End Scenario — Codebase Memory

With Codebase Memory enabled:

Before builder execution:

```text
health checked
coverage checked
architecture/search information retrieved
```

Before review:

```text
changed code impact inspected
```

These calls must be observable in runtime events or capability telemetry.

A mere MCP config entry does not satisfy this scenario.

---

# 110. Acceptance Command

Before declaring the branch complete, run:

```bash
npm run check
```

and any additional integration test command introduced by this work.

The final report must provide:

```text
tests executed
tests passed
tests failed
features completed
known limitations
```

Do not state “all requirements complete” if any item remains stubbed.

---

# 111. Final Safety Checklist

Before completion confirm:

- [ ] Review items never launch builder pipeline.
- [ ] Rework has bounded attempts.
- [ ] Clean standalone review reaches Human Approval.
- [ ] Done cannot be performed autonomously.
- [ ] Final merge cannot be performed autonomously.
- [ ] Manual mode never auto-dispatches.
- [ ] Supervised mode waits for approval.
- [ ] Autonomous mode respects all hard gates.
- [ ] Codex/Claude/Antigravity orchestrators actually invoke providers.
- [ ] Persona and task agent are separate concepts.
- [ ] Disabled/archived agents cannot receive new work.
- [ ] Agent historical versions are immutable.
- [ ] PM chat actually invokes the selected orchestrator.
- [ ] Token/context values are not fabricated.
- [ ] Cost values are clearly estimated.
- [ ] Codebase Memory actually receives MCP calls.
- [ ] Jira dependencies only include true blocking semantics.
- [ ] GitHub workflow labels do not accumulate.
- [ ] Dependency cycles block rather than dispatch.
- [ ] Worktrees originate from a current exact remote SHA.
- [ ] Credentials are never returned to the UI.
- [ ] Control Plane mutations remain localhost-only.
- [ ] Existing reviewed-SHA integration protection remains intact.
- [ ] `npm run check` passes.

---

# 112. Final Instruction to the Implementing Agent

Do not optimize for the number of boxes that can be marked complete.

Optimize for:

```text
working end-to-end behavior
deterministic state transitions
provider neutrality
safe autonomous operation
auditability
human control
test coverage
```

When there is a choice between:

```text
a broad interface with stub methods
```

and:

```text
a smaller capability that actually works end-to-end
```

choose the working capability.

Do not add another large specification document as a substitute for implementation.

Do not claim a feature is complete because its schema, table, interface, UI placeholder, or provider name exists.

**The goal of this branch is to convert the current control-plane scaffold into a genuinely operational autonomous software delivery runtime.**

