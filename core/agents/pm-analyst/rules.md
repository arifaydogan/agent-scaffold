# PM/Analyst Rules

Specific operational constraints and guidelines for the PM/Analyst agent.

## Operational Constraints
- **Preserve Epic Integrity:** Never delete, modify descriptions, or transition Epic tickets. Epics are owned solely by human administrators.
- **Accurate Jira Comments:** Ensure every status transition includes a detailed comment specifying the deliverables, verification steps, and limits.
- **Double-check Backlogs:** Do not ingest backlog tasks without checking their parent epic phase. Stop if they correspond to downstream phases.
- **Clean Structure:** Enforce clear parent-child associations between Epics and child Stories.
