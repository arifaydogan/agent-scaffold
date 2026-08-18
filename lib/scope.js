function normalized(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function globExpression(pattern) {
  const norm = normalized(pattern);
  if (norm === "**") return /^.*$/;

  const escaped = norm.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const tokenized = escaped
    .replace(/\/\*\*\//g, "\u0001")
    .replace(/\/\*\*$/g, "\u0002")
    .replace(/^\*\*\//g, "\u0003")
    .replaceAll("**", "\u0004")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0001", "/(?:.*/)?")
    .replaceAll("\u0002", "(?:/.*)?")
    .replaceAll("\u0003", "(?:.*/)?")
    .replaceAll("\u0004", ".*");

  return new RegExp(`^${tokenized}$`);
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
  const traversalViolations = normalizedFiles.filter(
    (file) => file.startsWith("/") || /^[a-zA-Z]:/.test(file) || file.split("/").includes("..")
  );
  const scopeViolations = normalizedFiles.filter(
    (file) => !allowedPatterns.some((pattern) => pathMatchesScope(file, pattern))
  );
  const violations = [...new Set([...traversalViolations, ...scopeViolations])];
  const reasons = [];
  if (!allowedPatterns.length) reasons.push("No allowed path scope is configured");
  if (normalizedFiles.length > maxChangedFiles) {
    reasons.push(
      `Changed file count ${normalizedFiles.length} exceeds limit ${maxChangedFiles}`
    );
  }
  if (traversalViolations.length) {
    reasons.push(`Changed files contain path traversal or absolute paths: ${traversalViolations.join(", ")}`);
  }
  if (scopeViolations.length) {
    reasons.push(`Changed files outside scope: ${scopeViolations.join(", ")}`);
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

function parsePatternParts(pat) {
  const norm = normalized(pat);
  const segments = norm.split("/").filter(Boolean);
  const starIdx = segments.indexOf("**");
  if (starIdx === -1) {
    return {
      prefix: segments,
      hasDoubleStar: false,
      suffix: []
    };
  }
  return {
    prefix: segments.slice(0, starIdx),
    hasDoubleStar: true,
    suffix: segments.slice(starIdx + 1)
  };
}

function intersectSegment(s1, s2) {
  if (s1 === s2) return s1;
  if (s1 === "*") return s2;
  if (s2 === "*") return s1;
  if (s1.startsWith("*.") && s2.startsWith("*.")) {
    return s1 === s2 ? s1 : null;
  }
  if (s1.startsWith("*.")) {
    const ext = s1.slice(1);
    return s2.endsWith(ext) ? s2 : null;
  }
  if (s2.startsWith("*.")) {
    const ext = s2.slice(1);
    return s1.endsWith(ext) ? s1 : null;
  }
  return null;
}

function verifyPatternContainment(candidate, policyPat, orchPat) {
  // Test samples across multiple depths to verify candidate is strictly contained in both
  const prefix = candidate.replace(/\/?\*\*?.*$/, "");
  const suffix = candidate.match(/\*\*?\/?(.*)$/)?.[1] || "";
  const ext = suffix.match(/\*(\.[a-zA-Z0-9]+)$/)?.[1] || (suffix ? `/${suffix}` : "/file.tmp");

  const sampleDepths = [
    prefix ? `${prefix}${ext.startsWith("/") ? ext : `/${ext}`}` : ext.replace(/^\//, ""),
    prefix ? `${prefix}/sub${ext.startsWith("/") ? ext : `/${ext}`}` : `sub${ext.startsWith("/") ? ext : `/${ext}`}`,
    prefix ? `${prefix}/deep/nested${ext.startsWith("/") ? ext : `/${ext}`}` : `deep/nested${ext.startsWith("/") ? ext : `/${ext}`}`
  ];

  for (const sample of sampleDepths) {
    if (pathMatchesScope(sample, candidate)) {
      if (!pathMatchesScope(sample, policyPat) || !pathMatchesScope(sample, orchPat)) {
        return false;
      }
    }
  }
  return true;
}

export function intersectTwoPatterns(policyPattern, orchPattern) {
  const pNorm = normalized(policyPattern);
  const oNorm = normalized(orchPattern);

  if (pNorm === oNorm) return pNorm;
  if (pNorm === "**") return oNorm;
  if (oNorm === "**") return pNorm;

  const p = parsePatternParts(pNorm);
  const o = parsePatternParts(oNorm);

  // If orchestrator requests an infinite recursive subtree (**) but policy is bounded without **,
  // policy cannot authorize that subtree.
  if (o.hasDoubleStar && !p.hasDoubleStar) {
    return null;
  }

  // 1. Prefix intersection
  const combinedPrefix = [];
  const minPrefixLen = Math.min(p.prefix.length, o.prefix.length);

  for (let k = 0; k < minPrefixLen; k++) {
    const seg = intersectSegment(p.prefix[k], o.prefix[k]);
    if (!seg) return null;
    combinedPrefix.push(seg);
  }

  if (p.prefix.length > minPrefixLen) {
    if (!o.hasDoubleStar) return null;
    combinedPrefix.push(...p.prefix.slice(minPrefixLen));
  } else if (o.prefix.length > minPrefixLen) {
    if (!p.hasDoubleStar) return null;
    combinedPrefix.push(...o.prefix.slice(minPrefixLen));
  }

  // 2. Suffix intersection
  const combinedSuffix = [];
  const sLenP = p.suffix.length;
  const sLenO = o.suffix.length;

  if (sLenP > 0 && sLenO > 0) {
    const minSuffixLen = Math.min(sLenP, sLenO);
    for (let k = 1; k <= minSuffixLen; k++) {
      const seg = intersectSegment(p.suffix[sLenP - k], o.suffix[sLenO - k]);
      if (!seg) return null;
      combinedSuffix.unshift(seg);
    }
    if (sLenP > minSuffixLen) {
      if (!o.hasDoubleStar) return null;
      combinedSuffix.unshift(...p.suffix.slice(0, sLenP - minSuffixLen));
    } else if (sLenO > minSuffixLen) {
      if (!p.hasDoubleStar) return null;
      combinedSuffix.unshift(...o.suffix.slice(0, sLenO - minSuffixLen));
    }
  } else if (sLenP > 0) {
    if (!o.hasDoubleStar) return null;
    combinedSuffix.push(...p.suffix);
  } else if (sLenO > 0) {
    if (!p.hasDoubleStar) return null;
    combinedSuffix.push(...o.suffix);
  }

  // 3. Double-star determination
  const hasDoubleStar = p.hasDoubleStar && o.hasDoubleStar;

  // 4. Assemble candidate pattern
  const parts = [...combinedPrefix];
  if (hasDoubleStar) {
    parts.push("**");
  }
  parts.push(...combinedSuffix);

  const candidate = parts.join("/");
  if (!candidate) return null;

  // 5. Fail-closed safety verification: candidate must be strictly contained in both
  if (!verifyPatternContainment(candidate, pNorm, oNorm)) {
    return null;
  }

  return candidate;
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
