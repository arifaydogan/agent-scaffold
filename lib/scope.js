function normalized(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function globExpression(pattern) {
  const source = normalized(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${source}$`);
}

export function pathMatchesScope(file, pattern) {
  return globExpression(pattern).test(normalized(file));
}

export function validateChangedFiles({
  changedFiles,
  allowedPatterns,
  maxChangedFiles
}) {
  const normalizedFiles = [...new Set(changedFiles.map(normalized))];
  const violations = normalizedFiles.filter(
    (file) => !allowedPatterns.some((pattern) => pathMatchesScope(file, pattern))
  );
  const reasons = [];
  if (!allowedPatterns.length) reasons.push("No allowed path scope is configured");
  if (normalizedFiles.length > maxChangedFiles) {
    reasons.push(
      `Changed file count ${normalizedFiles.length} exceeds limit ${maxChangedFiles}`
    );
  }
  if (violations.length) {
    reasons.push(`Changed files outside scope: ${violations.join(", ")}`);
  }
  return {
    allowed: reasons.length === 0,
    changedFiles: normalizedFiles,
    violations,
    reasons
  };
}

export function parseGitStatus(stdout) {
  return (stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const value = line.slice(3).trim();
      const renameIndex = value.lastIndexOf(" -> ");
      return renameIndex >= 0 ? value.slice(renameIndex + 4) : value;
    });
}

export function intersectTwoPatterns(policyPattern, orchPattern) {
  const pNorm = normalized(policyPattern);
  const oNorm = normalized(orchPattern);

  if (pNorm === oNorm) return pNorm;
  if (pNorm === "**") return oNorm;
  if (oNorm === "**") return pNorm;

  if (pNorm === "*") {
    const oSegs = oNorm.split("/");
    return oSegs.length === 1 ? oNorm : null;
  }
  if (oNorm === "*") {
    const pSegs = pNorm.split("/");
    return pSegs.length === 1 ? pNorm : null;
  }

  const pSegs = pNorm.split("/");
  const oSegs = oNorm.split("/");

  const result = [];
  let i = 0;
  let j = 0;

  while (i < pSegs.length && j < oSegs.length) {
    const p = pSegs[i];
    const o = oSegs[j];

    if (p === "**" && o === "**") {
      const pRest = pSegs.slice(i + 1).join("/");
      const oRest = oSegs.slice(j + 1).join("/");
      if (!pRest && !oRest) {
        result.push("**");
        return result.join("/");
      }
      if (!pRest) {
        result.push(oSegs.slice(j).join("/"));
        return result.join("/");
      }
      if (!oRest) {
        result.push(pSegs.slice(i).join("/"));
        return result.join("/");
      }
      const restIntersect = intersectTwoPatterns(pRest, oRest);
      if (!restIntersect) return null;
      result.push(restIntersect);
      return result.join("/");
    }

    if (p === "**") {
      // Policy allows everything below; orchestrator's remaining sub-pattern is the bound
      result.push(oSegs.slice(j).join("/"));
      return result.join("/");
    }

    if (o === "**") {
      // Orchestrator wants everything below; policy's remaining sub-pattern is the bound
      result.push(pSegs.slice(i).join("/"));
      return result.join("/");
    }

    if (p === o) {
      result.push(p);
      i++;
      j++;
    } else if (p === "*") {
      result.push(o);
      i++;
      j++;
    } else if (o === "*") {
      result.push(p);
      i++;
      j++;
    } else {
      return null;
    }
  }

  if (i < pSegs.length || j < oSegs.length) {
    return null;
  }

  return result.join("/");
}

export function isSubScope(subPattern, parentPattern) {
  const intersected = intersectTwoPatterns(parentPattern, subPattern);
  return intersected !== null && intersected === normalized(subPattern);
}

export function intersectPathScopes(orchestratorPaths, policyPaths) {
  if (!Array.isArray(orchestratorPaths)) return [];
  if (orchestratorPaths.length === 0) return [];
  if (!Array.isArray(policyPaths) || policyPaths.length === 0) return [...orchestratorPaths];
  if (policyPaths.includes("**")) return [...orchestratorPaths];

  const effective = [];
  for (const orchPath of orchestratorPaths) {
    for (const polPath of policyPaths) {
      const intersected = intersectTwoPatterns(polPath, orchPath);
      if (intersected && !effective.includes(intersected)) {
        effective.push(intersected);
      }
    }
  }
  return effective;
}
