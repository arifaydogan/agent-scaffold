# Capability Mapping & Precedence Mechanics

## Precedence Hierarchy

When capabilities or policies contain overlapping guidelines, resolution is evaluated in the following strict order:

1. **`canonical_policy`**: Non-negotiable repository contracts (`AGENTS.md`, `ORCHESTRATION.md`, `PACEBUILD_ORCHESTRATOR.md`).
2. **`local_override`**: Project-specific local skill overrides (e.g. `packs/pacebuild/overrides/`).
3. **`upstream_capability`**: External capabilities declared in `sources.lock.json`.
4. **`persona_voice`**: Judgment and tone guidance from persona files (`core/personas/`).

## Selection Algorithm

1. Read `scaffold-manifest.json` and `sources.lock.json`.
2. Map required task keywords to capability IDs.
3. Validate that each selected capability has `vendored_code: false` and valid source SHAs.
4. If two capabilities define contradictory rules, the one with higher precedence overrides lower levels.
5. Emit provenance details (`source_id`, `commit`, `skill_path`) in phase handoff logs.
