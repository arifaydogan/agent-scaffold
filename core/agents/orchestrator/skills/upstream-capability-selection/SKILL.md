---
name: upstream-capability-selection
description: Resolves external capabilities from sources.lock.json using provenance and precedence rules. Use this skill when selecting upstream skills, applying canonical-to-persona override order, or eliminating conflicting capabilities.
---

# Upstream Capability Selection

## Overview

The `upstream-capability-selection` skill manages external capabilities imported from upstream repositories. It inspects `sources.lock.json`, selects the minimal effective capability set, enforces strict precedence, prevents conflicting instructions, and records capability provenance.

## Core Rules

1. **Read Lock Registry**: Inspect `sources.lock.json` to verify source metadata, commit SHAs, and capability paths.
2. **Minimal Capability Set**: Select only the capabilities explicitly required for the current task objective.
3. **Precedence Hierarchy**: Enforce resolution strictly in order:
   `canonical_policy` > `local_override` > `upstream_capability` > `persona_voice`
4. **Deduplication**: Filter out duplicate or conflicting guidelines from upstream sources.
5. **Provenance Audit**: Record source IDs, repository URLs, commit SHAs, and adaptation notes in phase handoffs.

Refer to [`references/capability-map.md`](references/capability-map.md) for capability mapping rules.
