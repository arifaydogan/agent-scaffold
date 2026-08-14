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

export function isSubScope(subPattern, parentPattern) {
  if (parentPattern === "**" || parentPattern === "*") return true;
  const subNorm = normalized(subPattern);
  const parentNorm = normalized(parentPattern);
  if (subNorm === parentNorm) return true;
  const parentPrefix = parentNorm.replace(/\/?\*\*?$/, "");
  return subNorm === parentPrefix || subNorm.startsWith(parentPrefix ? `${parentPrefix}/` : "");
}

export function intersectPathScopes(orchestratorPaths, policyPaths) {
  if (!Array.isArray(orchestratorPaths)) return [];
  if (!Array.isArray(policyPaths) || policyPaths.length === 0) return orchestratorPaths;
  if (policyPaths.includes("**") || policyPaths.includes("*")) return orchestratorPaths;

  return orchestratorPaths.filter((orchPath) =>
    policyPaths.some((polPath) => isSubScope(orchPath, polPath))
  );
}

