---
name: docker-patterns
description: Build reproducible and secure container workflows.
triggers: [docker, container, compose, dockerfile]
always: false
---

# Docker Patterns

Pin important versions, use small runtime images, run as non-root, add health checks, and keep secrets outside images. Verify startup ordering with readiness checks rather than sleep.
