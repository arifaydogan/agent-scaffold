# Provider-neutral delivery control plane

This first slice keeps the runtime as a small modular Node.js process and puts
provider-specific behavior behind explicit ports. It does not add a workflow
framework, remote service, database migration, or automatic external writes.

## Provider boundaries

| Port | Responsibility | First adapters |
| --- | --- | --- |
| `WorkSourceProvider` | Poll and resolve work into a canonical packet | Jira, GitHub Issues |
| `OrchestratorProvider` | Select persona, skills, risk, and scope | Built-in deterministic router |
| `ExecutorProvider` | Run the prepared prompt inside the selected worktree | Codex CLI, Antigravity CLI |
| `CodeIntelligenceProvider` | Advertise code graph/search/impact capabilities | codebase-memory-mcp config point |

The orchestrator never spawns a model command. The executor never decides work
eligibility or canonical workflow state. Existing Codex and Antigravity command,
model-selection, streaming, scope, and timeout behavior remains in `lib/executor.js`
and `lib/runtime.js`.

## Canonical work item

Every work source returns the existing runtime fields plus source metadata and a
canonical state:

```json
{
  "key": "PACE-42",
  "providerKey": "#42",
  "summary": "Add provider abstraction",
  "description": "Acceptance Criteria ...",
  "issueType": "Issue",
  "status": "open",
  "canonicalState": "ready",
  "labels": ["agent-ready"],
  "source": {
    "provider": "github-issues",
    "id": "42",
    "url": "https://github.com/org/repo/issues/42"
  }
}
```

Canonical states are `backlog`, `ready`, `in_progress`, `review`, `blocked`,
`done`, `cancelled`, and `unknown`. Adapter defaults can be extended with
`stateMapping` in config. The provider's raw state remains in `status`; unknown
provider states are never silently treated as ready.

GitHub's REST Issues endpoint also returns pull requests. The GitHub adapter
explicitly filters items with a `pull_request` field.

## Capability registry

`lib/capability-registry.js` combines two inventories:

- skill capabilities and provenance from `sources.lock.json`;
- configured code-intelligence services.

This keeps Ponytail's `minimal-change` adaptation visible with its pinned source
and exposes `codebase-memory-mcp` without vendoring or installing it. The adapter
uses the project's standard MCP stdio shape. The example is in
`adapters/codebase-memory-mcp.example.json`. Installation and index mutation are
deliberately outside this slice.

## 4317 API

`GET /api/snapshot` remains secret-safe and now returns:

- `projectInfo`;
- configured/selected work-source, orchestrator, executor, and code-intelligence providers;
- canonical workflow states;
- the capability registry;
- mutable provider selections and safety gates.

`PATCH /api/config/providers` accepts only these string fields:

```json
{
  "workSource": "github-issues",
  "orchestrator": "builtin",
  "executor": "antigravity",
  "codeIntelligence": "codebase-memory"
}
```

The endpoint binds only through the existing `127.0.0.1` server and is disabled
unless `controlPlane.configMutationEnabled` is explicitly `true`. It also requires
JSON plus loopback `Host`/`Origin` headers to resist browser-based cross-origin and
DNS-rebinding requests. Values must name enabled, already configured providers. It cannot change commands, credentials, policies,
`supervisor.executeEnabled`, provider write flags, merge policy, or Done transitions.
The config file update is written through a private-permission, same-directory
temporary file and rename. Snapshot descriptors never expose executable paths or
credential environment-variable names.

## Compatibility and safety

- A legacy top-level `jira` section normalizes to `workSource.providers.jira`.
- Jira remains the default work source in the example.
- `run`, `dispatch`, and supervisor execution remain dry-run/fail-closed by default.
- Epic changes, external writes, merge, and Done transitions remain human-only.
- Provider selection does not install software or test credentials.
