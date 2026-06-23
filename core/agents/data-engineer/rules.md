# Data Engineer Rules

Specific operational constraints and guidelines for the Data Engineer agent.

## Operational Constraints
- **Hypertables Mandatory:** Any table that scales with time metrics MUST be created as a hypertable using `create_hypertable()`.
- **Query Optimization:** Time-slice query operations must always use standard timeseries functions (e.g. `time_bucket()`) rather than expensive grouping.
- **Enforce Indexing:** Primary index constraints must always contain the time partition key to allow fast pruning.
- **Partition Testing:** Test compression policies and verify continuous aggregate queries do not cause lock contentions.
