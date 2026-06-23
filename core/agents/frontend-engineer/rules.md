# Frontend Engineer Rules

Specific operational constraints and guidelines for the Frontend Engineer agent.

## Operational Constraints
- **No Silent Fallbacks:** Under no circumstances should backend API failures fallback silently to local mock data. If the backend is dead, show a prominent status indicator (e.g. "BAĞLANTI YOK") or error badge.
- **Robust Player States:** Stream players must handle stream disconnection, buffering delays, and timeout failures explicitly. Render helper overlays (e.g., buffering indicators or reconnect buttons).
- **TypeScript Strictness:** Never use `any`. Always declare explicit interfaces and types for API responses and component props.
- **Component Isolation:** Keep UI styling isolated within components. Do not write ad-hoc CSS modifications in global layouts.
