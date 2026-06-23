# Security Engineer Rules

Specific operational constraints and guidelines for the Security Engineer agent.

## Operational Constraints
- **Secrets Block Access:** Instantly fail commit checks if a matching hardcoded secret pattern (`api_key`, `password`, `private_key`) is found.
- **Dependency Ingestion Control:** Block new third-party packages if they have known high or critical CVE entries.
- **Enforce HTTPS:** Ensure all web assets, API endpoints, and streaming connections use transport encryption (HTTPS/WSS/RTSPS).
- **Sanitize Input:** Verify SQL parameterized queries and cross-site scripting (XSS) protections in both backend and frontend layers.
