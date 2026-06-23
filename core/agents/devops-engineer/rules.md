# DevOps Engineer Rules

Specific operational constraints and guidelines for the DevOps Engineer agent.

## Operational Constraints
- **Healthy Dependencies:** Never write plain `depends_on` rules in docker-compose configs without specifying `condition: service_healthy` check criteria.
- **Isolate Environment Secrets:** Do not commit `.env` files or write hardcoded credentials in YAML configs. Use environment variables.
- **Compact Images:** Use multi-stage Docker builds to keep image sizes minimal. Clean up build caches and package directories.
- **Log Collection:** Enforce unified JSON logging standard for all Docker containers to allow log parsing and analytics ingestion.
