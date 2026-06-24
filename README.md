# ai-team-scaffold

Reusable AI Agent operating environment scaffold including rules, worktrees, and skills. This project provides a standardized structure for deploying and managing an AI-driven development team on any project.

## Quick Install

To install the core agent scaffold in your project, run the following command in your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/arifaydogan/ai-team-scaffold/main/install.sh | bash
```

For Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/arifaydogan/ai-team-scaffold/main/install.ps1 | iex
```

## Agent Team Matrix

The scaffold includes 9 core roles designed to coordinate and develop software systems:

| Role | Directory | Primary Model | Scope & Focus |
|------|-----------|---------------|---------------|
| **Orchestrator** | `core/agents/orchestrator` | `claude-opus-4` | Task routing, review coordination, conflict resolution |
| **Architect** | `core/agents/architect` | `claude-sonnet-4` | System design, ADR patterns, tech debt management |
| **Backend Engineer** | `core/agents/backend-engineer` | `claude-sonnet-4` | API design, database patterns, backend testing |
| **Frontend Engineer** | `core/agents/frontend-engineer` | `claude-sonnet-4` | Component design, stream integration, frontend testing |
| **DevOps Engineer** | `core/agents/devops-engineer` | `claude-sonnet-4` | Docker patterns, CI/CD pipelines, monitoring systems |
| **QA Engineer** | `core/agents/qa-engineer` | `claude-sonnet-4` | Test strategy, TDD, end-to-end testing |
| **PM/Analyst** | `core/agents/pm-analyst` | `claude-sonnet-4` | PRD writing, Jira tracking, Confluence documentation |
| **Security Engineer** | `core/agents/security-engineer` | `claude-sonnet-4` | Security review, OWASP checklist, secret scanning |
| **Data Engineer** | `core/agents/data-engineer` | `claude-sonnet-4` | Time-series databases, data pipelines, aggregation queries |

The scaffold is extensible through packs. The **PaceBuild Extension Pack** (`packs/pacebuild/`) extends the core with a **CV Engineer** agent role and project-specific overrides.

## Installation Options

When you run the installer (`install.sh` or `install.ps1`), you will be prompted for two optional add-ons:

1. **Production-grade Skills (`alirezarezvani/claude-skills`)**:
   - Integrates rich, production-grade agent skills (e.g., `senior-architect`, `senior-backend`, `senior-frontend`, `senior-devops`, `tdd-guide`, `security-pen-testing`, `senior-data-engineer`, `senior-pm`, `confluence-expert`, `jira-expert`, and `senior-computer-vision` for PaceBuild).
   - Clones `https://github.com/alirezarezvani/claude-skills.git` locally and copies relevant skills into your target project's `core/agents/`, `.agents/`, and/or `.claude/` structures.

2. **Caveman Token Optimizer**:
   - Installs JuliusBrussee's **Caveman** tool (`npx -y github:JuliusBrussee/caveman -- --with-init`).
   - Optimizes and reduces output tokens by up to ~65% for expensive models like Claude 3 Opus, saving cost and context window space.

