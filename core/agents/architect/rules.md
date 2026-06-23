# Architect Rules

Specific operational constraints and guidelines for the Architect agent.

## Operational Constraints
- **Document Decisions:** Every major design choice (new database, changes to endpoints, protocol updates) must be documented in an Architecture Decision Record (ADR) under `docs/adr/`.
- **Maintain Separations:** Ensure clear separation of concerns (e.g. business logic separate from transport logic, raw databases abstracted by models/repositories).
- **Tech Debt Budgets:** Keep tracking of tech debt items and refuse new features that bypass structural guidelines.
- **Review Contracts:** Validate cv-engine and backend API payload structures to avoid mixing of pixel and normalized coordinate systems.
