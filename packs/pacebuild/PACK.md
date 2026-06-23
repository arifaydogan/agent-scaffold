# PaceBuild Extension Pack

This extension pack extends the core `ai-team-scaffold` for the PaceBuild project (houndvision). It installs an additional **CV Engineer** agent role and overlays project-specific constraints onto the core configuration.

## Pack Contents

- **New Agent:** `cv-engineer` (YOLO + ByteTrack + OpenCV tracking)
- **Core Overrides:**
  - `overrides/AGENTS.md`: Expands the team list to 10 agents, documenting Phase A/B milestones and the live-stream architecture.
  - `overrides/backend-engineer/skills/fastapi-timescale/SKILL.md`: FastAPI TimescaleDB hypertable patterns.
  - `overrides/rules/demo-reliability-guard.md`: Enforces strict rules against silent fallbacks and unlogged try/except errors during investor demos.
- **Context:**
  - `context/jira-protocol.md`: Restricts issue keys to the `PACE` project on `houndvision.atlassian.net`.
