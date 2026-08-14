function normalizedPattern(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function staticRoot(pattern) {
  const normalized = normalizedPattern(pattern);
  const wildcard = normalized.search(/[?*[]/);
  const root = (wildcard < 0 ? normalized : normalized.slice(0, wildcard))
    .replace(/\/$/, "");
  return root || normalized;
}

export function scopesOverlap(left = [], right = []) {
  return left.some((leftPattern) =>
    right.some((rightPattern) => {
      const a = normalizedPattern(leftPattern);
      const b = normalizedPattern(rightPattern);
      if (a === b) return true;
      const aRoot = staticRoot(a);
      const bRoot = staticRoot(b);
      return Boolean(
        aRoot &&
          bRoot &&
          (aRoot === bRoot ||
            aRoot.startsWith(`${bRoot}/`) ||
            bRoot.startsWith(`${aRoot}/`))
      );
    })
  );
}

function providerFor(plan) {
  return plan.dispatchProvider || plan.execution?.provider || "unconfigured";
}

/**
 * Assert that a concurrency value is a positive integer (>= 1). Throws on any
 * invalid value: zero, negative, NaN, float, or numeric string.
 *
 * @param {unknown} value
 * @param {string} name - field name for error messages
 * @returns {number}
 */
function assertPositiveConcurrency(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a positive integer >= 1, got: ${JSON.stringify(value)}`
    );
  }
  return value;
}

export function selectDispatchBatch(
  plans,
  { maxConcurrency = 2, providerConcurrency = {}, agentConcurrency = {} } = {},
  currentQueue = []
) {
  const effectiveMax = assertPositiveConcurrency(maxConcurrency, "maxConcurrency");

  const eligible = plans.filter((plan) => plan.eligible);
  
  // A plan is a candidate if it is parallelSafe AND all its dependencies are resolved
  // (i.e. none of its dependencies are still in the currentQueue).
  const queueIssues = new Set(currentQueue.map(p => p.issue));
  const candidates = eligible.filter((plan) => {
    if (!plan.parallelSafe) return false;
    const deps = Array.isArray(plan.dependencies) ? plan.dependencies : [];
    return !deps.some(dep => queueIssues.has(dep));
  });
  
  const selected = [];
  const providerCounts = new Map();
  const agentCounts = new Map();
  for (const candidate of candidates) {
    if (selected.length >= effectiveMax) break;
    const provider = providerFor(candidate);

    let providerLimit = effectiveMax;
    if (Object.prototype.hasOwnProperty.call(providerConcurrency, provider)) {
      providerLimit = assertPositiveConcurrency(
        providerConcurrency[provider],
        `providerConcurrency.${provider}`
      );
    }

    if ((providerCounts.get(provider) || 0) >= providerLimit) continue;

    const agentId = candidate.taskAgent || candidate.persona || candidate.agentId;
    let agentLimit = candidate.maxConcurrency || candidate.configSnapshot?.maxConcurrency || effectiveMax;
    if (agentId && Object.prototype.hasOwnProperty.call(agentConcurrency, agentId)) {
      agentLimit = Math.min(agentLimit, agentConcurrency[agentId]);
    }
    if (agentId && (agentCounts.get(agentId) || 0) >= agentLimit) continue;

    if (
      selected.some((current) =>
        scopesOverlap(current.allowedPaths, candidate.allowedPaths)
      )
    ) {
      continue;
    }
    selected.push(candidate);
    providerCounts.set(provider, (providerCounts.get(provider) || 0) + 1);
    if (agentId) {
      agentCounts.set(agentId, (agentCounts.get(agentId) || 0) + 1);
    }
  }
  
  if (selected.length) return selected;
  
  // Fallback for exclusive (non-parallel-safe) tasks that have their dependencies resolved.
  const exclusiveCandidates = eligible.filter(plan => {
    if (plan.parallelSafe) return false;
    const deps = Array.isArray(plan.dependencies) ? plan.dependencies : [];
    return !deps.some(dep => queueIssues.has(dep));
  });
  
  const exclusive = exclusiveCandidates[0] || eligible[0];
  return exclusive ? [exclusive] : [];
}

export function buildDispatchWaves(plans, limits = {}) {
  const queue = plans.filter((plan) => plan.eligible);
  const waves = [];
  let stuckCounter = 0;
  
  while (queue.length) {
    const batch = selectDispatchBatch(queue, limits, queue);
    if (!batch.length) {
       // Prevent infinite loop if circular dependencies exist
       if (stuckCounter++ > 100) break; 
       break; 
    }
    stuckCounter = 0;
    waves.push(batch);
    const selectedIssues = new Set(batch.map((plan) => plan.issue));
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (selectedIssues.has(queue[index].issue)) queue.splice(index, 1);
    }
  }
  return waves;
}

/**
 * Execute dispatch waves sequentially, running plans within each wave in parallel.
 * AbortSignal is checked before EVERY wave including wave 0. If already aborted,
 * no waves are launched.
 *
 * @param {object[][]} waves
 * @param {Function} launch - async (plan) => result
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - stop before launching any wave if aborted
 * @returns {Promise<{wave: number, executions: object[]}[]>}
 */
export async function executeDispatchWaves(waves, launch, { signal } = {}) {
  const results = [];
  for (let index = 0; index < waves.length; index += 1) {
    // Check abort signal before every wave, including the first.
    if (signal?.aborted) break;
    const wave = waves[index];
    const executions = await Promise.all(
      wave.map(async (plan) => ({
        issue: plan.issue,
        provider: providerFor(plan),
        ...(await launch(plan))
      }))
    );
    results.push({ wave: index + 1, executions });
  }
  return results;
}
