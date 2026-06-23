# Backend Engineer Rules

Specific operational constraints and guidelines for the Backend Engineer agent.

## Operational Constraints
- **Strict Error Handling:** Never swallow exceptions. Every `try/except` block must log the failure using `logger.error` with contextual information and raise or return an appropriate HTTP error.
- **Deduplication Check:** Implement frame-level deduplication middleware for incoming data ingestions to avoid data pollution.
- **TimescaleDB Hygiene:** Ensure timeseries tables are hypertable-configured. Always verify migrations are PostgreSQL/TimescaleDB compatible.
- **API Versioning:** Follow REST API versioning guidelines (`/api/v1/...`). Never deprecate fields in a way that breaks frontend integrations.
