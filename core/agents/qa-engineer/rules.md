# QA Engineer Rules

Specific operational constraints and guidelines for the QA Engineer agent.

## Operational Constraints
- **Test Before Fixing:** When fixing a reported bug, always write a failing regression/unit test first, verify the failure, and then apply the fix.
- **Explicit Assertions:** Avoid lazy asserts. Assert on explicit values, status codes, and type checks.
- **Coverage Minimums:** Do not approve changes that drop coverage below project limits (default: 80% coverage).
- **Test Sandbox Separation:** Ensure all tests run against separate mock databases or sandbox services. Do not modify production tables.
