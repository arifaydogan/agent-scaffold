---
name: multi-agent-reliability
description: Coordinates multi-agent state boundaries, lease heartbeats, and idempotent task execution. Use this skill when running concurrent or multi-agent workflows that require single-writer state isolation, lease renewal, and error recovery telemetry.
---

# Multi-Agent Reliability

## Overview

The `multi-agent-reliability` skill defines coordination protocols for multi-agent execution. It guarantees operational stability using clear topology ownership, single-writer state boundaries, lease heartbeats, idempotent operations, self-recovery, least privilege access, bounded task contexts, and telemetry instrumentation.

## Key Principles

- **Topology Ownership & Bounded Context**: Explicit role assignment with strictly separated areas of responsibility.
- **One-Writer Boundaries**: State mutation is restricted to a single owning worker per resource or directory.
- **Leases & Heartbeats**: Ownership locks must be periodically renewed via heartbeat signals to detect stalled runs.
- **Idempotency & Recovery**: Task actions and state transitions must be safe to retry after transient failures.
- **Least Privilege**: Agents receive only the minimum scope required to execute assigned phases.
- **Telemetry & Tracing**: All multi-agent operations emit structured events for audit and observability.

Refer to [`references/patterns.md`](references/patterns.md) for pattern details.
