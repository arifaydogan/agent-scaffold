export const CANONICAL_WORKFLOW_STATES = Object.freeze([
  "backlog",
  "ready",
  "in_progress",
  "review",
  "blocked",
  "done",
  "cancelled",
  "unknown"
]);

const DEFAULT_STATE_MAPPINGS = Object.freeze({
  jira: {
    backlog: ["Backlog"],
    ready: ["To Do", "Open", "Yapılacaklar"],
    in_progress: ["In Progress", "Devam Ediyor"],
    review: ["In Review", "Review"],
    blocked: ["Blocked", "Bloke"],
    done: ["Done", "Closed", "Tamam"],
    cancelled: ["Cancelled", "Canceled", "İptal"]
  },
  "github-issues": {
    backlog: ["backlog"],
    ready: ["open", "ready"],
    in_progress: ["in-progress", "in progress"],
    review: ["in-review", "review"],
    blocked: ["blocked"],
    done: ["closed", "completed"],
    cancelled: ["not-planned", "not_planned", "cancelled", "canceled"]
  }
});

function values(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function normalized(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US");
}

export function stateMappingFor(provider, override = {}) {
  const defaults = DEFAULT_STATE_MAPPINGS[provider] || {};
  return Object.fromEntries(
    CANONICAL_WORKFLOW_STATES.filter((state) => state !== "unknown").map((state) => [
      state,
      [...new Set([...values(defaults[state]), ...values(override[state])])]
    ])
  );
}

export function mapProviderState(provider, providerState, stateMapping = {}, aliases = []) {
  const mapping = stateMappingFor(provider, stateMapping);
  const priority = ["cancelled", "done", "blocked", "review", "in_progress", "ready", "backlog"];
  const resolve = (candidates) => {
    const normalizedCandidates = new Set(candidates.map(normalized).filter(Boolean));
    return priority.find((state) =>
      mapping[state].some((value) => normalizedCandidates.has(normalized(value)))
    ) || "unknown";
  };

  const direct = resolve([providerState]);
  if (["done", "cancelled"].includes(direct)) return direct;
  const aliasState = resolve(aliases);
  return aliasState === "unknown" ? direct : aliasState;
}
