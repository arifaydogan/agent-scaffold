# Core Global Operating Rules
Source: karpathy-guidelines + mattpocock/skills + PaceBuild code review findings

## 1. Think before code
- State assumptions explicitly. If uncertain, ask the user.
- If there are multiple ways to interpret a request, present them — do not choose one silently.
- If a simpler approach exists, suggest it and push back on complexity.
- If instructions are unclear, STOP and ask for clarification immediately.
- **Verification Rule:** Always verify that referenced configuration or environment files exist on the filesystem before attempting to load or execute them.

## 2. Simplicity first
- Write the minimum amount of code required to solve the problem. Avoid speculative development.
- Do not build features or configurations that are not requested.
- Keep components focused and small. If a 50-line solution is possible, rewrite longer implementations.
- No single-use abstractions or unnecessary configuration layers.

## 3. Surgical changes
- Touch only the code and folders that are required for the task.
- Do not refactor code that is not broken.
- Match the surrounding code style, indentation, naming conventions, and patterns.
- If dead or redundant code is spotted in adjacent functions, mention it to the user rather than deleting it.

## 4. Goal-driven execution (test-first)
- For bug fixes, write a reproduction test first (if applicable), then fix the bug.
- For multi-step tasks, outline a concrete step-by-step plan: `"1. [step] -> verify: [check]"`.
- **Deduplication Check:** When submitting events to backend endpoints or writing database entries, ensure frame-level or payload-based deduplication is active to prevent overcounting.

## 5. Demo reliability guard
- **No Silent Fallbacks:** If a backend service or API call fails, the UI must display a visible error state (e.g. "BAĞLANTI YOK") rather than silently falling back to mock data.
- **No Swallowed Errors:** Never wrap failures in silent `try/except` or `try/catch` blocks. Always log with details (`logger.error()`) and propagate the error.
- **No Hardcoded "Ready" Assumptions:** Implement retry mechanisms and timeouts when establishing connections between services (e.g., waiting for database readiness).
- **unhappy Path Focus:** Document how the system behaves under unhappy paths (e.g., camera disconnected, stream lag) in PR descriptions.
