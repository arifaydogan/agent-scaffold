---
name: database-patterns
description: Implement safe schemas, queries, transactions, and migrations.
triggers: [database, sql, migration, transaction, index]
always: false
---

# Database Patterns

Use migrations for every schema change. Protect invariants with constraints. Inspect query plans for hot paths. Make retries idempotent and document rollback behavior.
