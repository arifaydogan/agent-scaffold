import crypto from "node:crypto";

/**
 * Normalizes an array of child descriptors or keys.
 * @param {Array<string|object>} children
 * @returns {Array<{ key: string, summary: string, raw: object }>}
 */
export function normalizeChildren(children = []) {
  return children.map((c) => {
    if (typeof c === "string") {
      return { key: c, summary: c, raw: { key: c } };
    }
    const key = c.key || c.id || c.issueKey;
    if (!key) throw new Error("Child work item missing key/id");
    return {
      key: String(key),
      summary: String(c.summary || c.title || key),
      raw: c
    };
  });
}

/**
 * Builds and validates a deterministic Directed Acyclic Graph (DAG) for parent-child execution.
 *
 * Validation rules:
 * - Unique child keys
 * - No self dependencies (A -> A)
 * - No duplicate edges
 * - No cycles (A -> B -> C -> A)
 * - Referenced internal children must exist
 * - External dependencies must be verified; unknown external dependency fails closed
 * - Deterministic ordering
 *
 * Provider-neutral normalized edge:
 * from -> to (meaning `to` cannot start until `from` is integrated)
 *
 * @param {object} params
 * @param {string} params.parentKey
 * @param {Array<string|object>} params.children
 * @param {Map<string, string[]>|object} [params.dependencyMap] - maps childKey to array of upstream blocker keys (deps that must complete first)
 * @param {Function} [params.externalDependencyChecker] - (key) => { satisfied: boolean, evidence?: any, reason?: string }
 * @returns {object} DAG validation result and topology
 */
export function buildHierarchyDag({
  parentKey,
  children: rawChildren = [],
  dependencyMap = {},
  externalDependencyChecker = null
}) {
  const errors = [];
  const normalized = normalizeChildren(rawChildren);
  const childKeys = normalized.map((c) => c.key);
  const childSet = new Set(childKeys);

  // 1. Check unique child keys
  if (childSet.size !== childKeys.length) {
    const seen = new Set();
    const duplicates = new Set();
    for (const key of childKeys) {
      if (seen.has(key)) duplicates.add(key);
      seen.add(key);
    }
    errors.push(`Duplicate child keys in parent ${parentKey}: ${[...duplicates].join(", ")}`);
  }

  // Normalize dependency lookup
  const getUpstream = (key) => {
    let deps;
    if (dependencyMap instanceof Map) {
      deps = dependencyMap.get(key);
    } else if (dependencyMap && typeof dependencyMap === "object") {
      deps = dependencyMap[key];
    }
    if (!deps) return [];
    if (Array.isArray(deps)) {
      return deps.map((d) => (typeof d === "string" ? d : d.key || d.issueKey)).filter(Boolean);
    }
    return [];
  };

  const edges = [];
  const edgeSet = new Set();
  const internalDependencies = {};
  const externalDependencies = {};

  for (const child of normalized) {
    const key = child.key;
    internalDependencies[key] = [];
    externalDependencies[key] = [];

    const upstreamKeys = getUpstream(key);
    const seenUpstream = new Set();

    for (const rawUpstream of upstreamKeys) {
      const upstreamKey = String(rawUpstream);

      // Check self dependency
      if (upstreamKey === key) {
        errors.push(`Self dependency detected: ${key} cannot depend on itself`);
        continue;
      }

      // Check duplicate edge definition
      if (seenUpstream.has(upstreamKey)) {
        continue; // deduplicate
      }
      seenUpstream.add(upstreamKey);

      if (childSet.has(upstreamKey)) {
        // Internal dependency: upstreamKey -> key
        const edgeId = `${upstreamKey}->${key}`;
        if (!edgeSet.has(edgeId)) {
          edgeSet.add(edgeId);
          edges.push({ from: upstreamKey, to: key });
        }
        internalDependencies[key].push(upstreamKey);
      } else {
        // External dependency
        let satisfied = false;
        let reason = `External dependency ${upstreamKey} status is unknown`;
        let evidence = null;

        if (typeof externalDependencyChecker === "function") {
          try {
            const check = externalDependencyChecker(upstreamKey);
            if (check && check.satisfied === true) {
              satisfied = true;
              evidence = check.evidence || null;
              reason = null;
            } else {
              satisfied = false;
              reason = check?.reason || `External dependency ${upstreamKey} is not satisfied`;
            }
          } catch (err) {
            satisfied = false;
            reason = `External dependency check failed for ${upstreamKey}: ${err.message}`;
          }
        }

        externalDependencies[key].push({
          key: upstreamKey,
          satisfied,
          reason,
          evidence
        });

        if (!satisfied) {
          errors.push(`Unresolved external dependency: child ${key} depends on ${upstreamKey} (${reason})`);
        }
      }
    }

    internalDependencies[key].sort();
    externalDependencies[key].sort((a, b) => a.key.localeCompare(b.key));
  }

  // Sort edges deterministically
  edges.sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));

  // 2. Cycle detection using 3-color graph traversal (0: unvisited, 1: visiting, 2: visited)
  const adjacency = new Map();
  for (const k of childKeys) adjacency.set(k, []);
  for (const edge of edges) {
    if (adjacency.has(edge.from)) {
      adjacency.get(edge.from).push(edge.to);
    }
  }
  for (const [k, list] of adjacency.entries()) {
    list.sort();
  }

  const color = new Map();
  const parentTrack = new Map();
  let cycleFound = null;

  function dfs(node, path = []) {
    color.set(node, 1);
    path.push(node);

    const neighbors = adjacency.get(node) || [];
    for (const neighbor of neighbors) {
      if (color.get(neighbor) === 1) {
        // Cycle detected
        const cycleStartIndex = path.indexOf(neighbor);
        cycleFound = [...path.slice(cycleStartIndex), neighbor];
        return true;
      }
      if (!color.get(neighbor)) {
        if (dfs(neighbor, path)) return true;
      }
    }

    path.pop();
    color.set(node, 2);
    return false;
  }

  for (const k of [...childKeys].sort()) {
    if (!color.get(k)) {
      if (dfs(k, [])) {
        errors.push(`Cycle detected in dependency graph: ${cycleFound.join(" -> ")}`);
        break;
      }
    }
  }

  // 3. Compute topological waves
  const waves = [];
  const topologicalOrder = [];

  if (errors.length === 0) {
    const inDegree = new Map();
    for (const k of childKeys) {
      inDegree.set(k, (internalDependencies[k] || []).length);
    }

    const remaining = new Set(childKeys);

    while (remaining.size > 0) {
      // Find all ready nodes in this wave (in-degree 0)
      const wave = [...remaining]
        .filter((k) => (inDegree.get(k) || 0) === 0)
        .sort();

      if (wave.length === 0) {
        errors.push("Graph contains unresolved dependency deadlock");
        break;
      }

      waves.push(wave);
      for (const node of wave) {
        topologicalOrder.push(node);
        remaining.delete(node);
        // Decrease in-degree for dependents
        const dependents = adjacency.get(node) || [];
        for (const dep of dependents) {
          inDegree.set(dep, (inDegree.get(dep) || 0) - 1);
        }
      }
    }
  }

  const valid = errors.length === 0;

  return {
    parentKey,
    valid,
    errors,
    children: normalized.sort((a, b) => a.key.localeCompare(b.key)),
    edges,
    internalDependencies,
    externalDependencies,
    waves,
    topologicalOrder
  };
}

/**
 * Computes a stable, deterministic cryptographic fingerprint for a parent graph.
 *
 * @param {object} params
 * @param {string} params.parentKey
 * @param {string} params.baseSha
 * @param {string} params.integrationBranch
 * @param {Array<string|object>} params.children
 * @param {Array<{from: string, to: string}>} params.edges
 * @returns {string} SHA-256 fingerprint hex
 */
export function computeGraphFingerprint({
  parentKey,
  baseSha = "",
  integrationBranch = "",
  children = [],
  edges = []
}) {
  const normChildren = children
    .map((c) => (typeof c === "string" ? c : c.key || c.id || c.issueKey))
    .filter(Boolean)
    .sort();

  const normEdges = edges
    .map((e) => ({ from: String(e.from), to: String(e.to) }))
    .sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));

  const canonical = {
    parentKey: String(parentKey),
    baseSha: String(baseSha || "").toLowerCase(),
    integrationBranch: String(integrationBranch || ""),
    children: normChildren,
    edges: normEdges
  };

  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Detects hierarchy drift between pinned snapshot and current work-source state.
 *
 * @param {string} pinnedFingerprint
 * @param {string} currentFingerprint
 * @returns {{ drift: boolean, message?: string }}
 */
export function detectHierarchyDrift(pinnedFingerprint, currentFingerprint) {
  if (!pinnedFingerprint || !currentFingerprint) {
    return { drift: false };
  }
  const drift = pinnedFingerprint !== currentFingerprint;
  return {
    drift,
    message: drift
      ? `Hierarchy drift detected: pinned graph fingerprint ${pinnedFingerprint.slice(0, 12)} does not match current graph ${currentFingerprint.slice(0, 12)}`
      : null
  };
}
