---
name: backend-testing
description: Verify backend behavior with focused unit and integration tests.
triggers: [backend test, pytest, integration test, api test]
always: false
---

# Backend Testing

Reproduce bugs first. Test domain logic separately from infrastructure. Cover validation, authorization, duplicate requests, timeouts, and dependency failures. Avoid mocks that hide the contract under test.
