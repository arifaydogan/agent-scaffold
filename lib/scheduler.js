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
  return plan.execution?.provider || "unconfigured";
}

export function selectDispatchBatch(
  plans,
  { maxConcurrency = 2, providerConcurrency = {} } = {}
) {
  const eligible = plans.filter((plan) => plan.eligible);
  const candidates = eligible.filter((plan) => plan.parallelSafe);
  const selected = [];
  const providerCounts = new Map();
  for (const candidate of candidates) {
    if (selected.length >= maxConcurrency) break;
    const provider = providerFor(candidate);
    const providerLimit = providerConcurrency[provider] ?? maxConcurrency;
    if ((providerCounts.get(provider) || 0) >= providerLimit) continue;
    if (
      selected.some((current) =>
        scopesOverlap(current.allowedPaths, candidate.allowedPaths)
      )
    ) {
      continue;
    }
    selected.push(candidate);
    providerCounts.set(provider, (providerCounts.get(provider) || 0) + 1);
  }
  if (selected.length) return selected;
  const exclusive = eligible.find((plan) => !plan.parallelSafe) || eligible[0];
  return exclusive ? [exclusive] : [];
}

export function buildDispatchWaves(plans, limits = {}) {
  const queue = plans.filter((plan) => plan.eligible);
  const waves = [];
  while (queue.length) {
    const batch = selectDispatchBatch(queue, limits);
    if (!batch.length) break;
    waves.push(batch);
    const selectedIssues = new Set(batch.map((plan) => plan.issue));
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (selectedIssues.has(queue[index].issue)) queue.splice(index, 1);
    }
  }
  return waves;
}

export async function executeDispatchWaves(waves, launch) {
  const results = [];
  for (let index = 0; index < waves.length; index += 1) {
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
