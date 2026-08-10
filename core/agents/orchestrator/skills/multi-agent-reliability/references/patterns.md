# Multi-Agent Reliability Patterns

## Topology Ownership

Multi-agent coordination requires explicit role definitions. Each task agent operates within a declared domain boundary (e.g. backend, frontend, devops) and does not write to files or resources managed by another agent.

## One-Writer Boundaries

- A resource, database table, or file path can have at most one active writer at any given time.
- Read operations may be shared, but mutations must acquire exclusive writer lock.
- Cross-agent coordination occurs via structured messages or immutable artifacts.

## Leases & Heartbeats

- Run locks are leased for a finite duration (e.g., 300 seconds).
- Active workers must emit a heartbeat token before lease expiration to extend ownership.
- If a heartbeat is missed, the coordinator expires the lease and marks the worker state as stalled/failed.

## Idempotency & Recovery

- All side-effecting operations (API calls, data mutations, file operations) must include idempotency keys or check-before-write logic.
- Retrying an interrupted phase must produce identical deterministic results without duplicate records or corrupted state.

## Least Privilege & Telemetry

- Agents run with restricted environment access, filesystem paths, and tool permissions tailored strictly to their role.
- Every state transition, lock event, and error condition logs standard telemetry events containing timestamp, run ID, persona, and status code.
