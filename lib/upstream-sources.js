import fs from "node:fs";
import path from "node:path";

function isOutsideRoot(relPath) {
  return (
    relPath === ".." ||
    relPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relPath)
  );
}

function checkPathSafety(targetPath, rootDir) {
  if (typeof targetPath !== "string" || !targetPath) {
    return { safe: false, reason: "path is empty or not a string" };
  }

  if (path.isAbsolute(targetPath)) {
    return { safe: false, reason: `absolute path rejected: ${targetPath}` };
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);

  if (isOutsideRoot(rel)) {
    return { safe: false, reason: `path escapes root: ${targetPath}` };
  }

  if (fs.existsSync(resolvedTarget)) {
    try {
      const realRoot = fs.realpathSync(resolvedRoot);
      const realTarget = fs.realpathSync(resolvedTarget);
      const realRel = path.relative(realRoot, realTarget);
      if (isOutsideRoot(realRel)) {
        return { safe: false, reason: `symlink escapes real root: ${targetPath}` };
      }
    } catch {
      return { safe: false, reason: `unable to resolve realpath for: ${targetPath}` };
    }
  }

  return { safe: true, resolvedPath: resolvedTarget };
}

export function validateUpstreamSources(
  sourcesLockInput = "sources.lock.json",
  manifestInput = "scaffold-manifest.json",
  rootDir = "."
) {
  const errors = [];
  let sourcesLock = sourcesLockInput;
  let manifest = manifestInput;

  if (typeof sourcesLockInput === "string") {
    const fullPath = path.resolve(rootDir, sourcesLockInput);
    if (!fs.existsSync(fullPath)) {
      return [`Missing registry lock file: ${sourcesLockInput}`];
    }
    try {
      sourcesLock = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch (err) {
      return [`Failed to parse JSON in ${sourcesLockInput}: ${err.message}`];
    }
  }

  if (typeof manifestInput === "string") {
    const fullPath = path.resolve(rootDir, manifestInput);
    if (!fs.existsSync(fullPath)) {
      return [`Missing manifest file: ${manifestInput}`];
    }
    try {
      manifest = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch (err) {
      return [`Failed to parse JSON in ${manifestInput}: ${err.message}`];
    }
  }

  if (!sourcesLock || typeof sourcesLock !== "object") {
    return ["Registry sources lock must be a non-null object"];
  }

  if (sourcesLock.version !== 1) {
    errors.push(`Invalid version in sources.lock.json: expected 1, got ${sourcesLock.version}`);
  }

  const expectedPrecedence = [
    "canonical_policy",
    "local_override",
    "upstream_capability",
    "persona_voice"
  ];
  if (
    !Array.isArray(sourcesLock.precedence) ||
    sourcesLock.precedence.length !== expectedPrecedence.length ||
    !sourcesLock.precedence.every((val, idx) => val === expectedPrecedence[idx])
  ) {
    errors.push(
      `Invalid precedence in sources.lock.json: expected ${JSON.stringify(expectedPrecedence)}, got ${JSON.stringify(sourcesLock.precedence)}`
    );
  }

  if (!Array.isArray(sourcesLock.sources)) {
    errors.push("sources in sources.lock.json must be an array");
  } else {
    const seenSourceIds = new Set();
    const seenRepos = new Set();

    for (const source of sourcesLock.sources) {
      if (!source || typeof source !== "object") {
        errors.push("Invalid source entry in sources.lock.json");
        continue;
      }

      const { id, repo, commit, license, copyright } = source;

      if (!id || typeof id !== "string") {
        errors.push("Source entry missing string id");
      } else if (seenSourceIds.has(id)) {
        errors.push(`Duplicate source ID in sources.lock.json: ${id}`);
      } else {
        seenSourceIds.add(id);
      }

      if (!repo || typeof repo !== "string") {
        errors.push(`Source ${id || "unknown"} missing repo URL`);
      } else if (seenRepos.has(repo)) {
        errors.push(`Duplicate repo URL in sources.lock.json: ${repo}`);
      } else {
        seenRepos.add(repo);
      }

      if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
        errors.push(
          `Source ${id || "unknown"} has invalid commit SHA: expected 40 lowercase hex characters, got '${commit}'`
        );
      }

      if (license !== "MIT") {
        errors.push(`Source ${id || "unknown"} license must be 'MIT', got '${license}'`);
      }

      if (!copyright || typeof copyright !== "string") {
        errors.push(`Source ${id || "unknown"} missing copyright statement`);
      }
    }
  }

  if (!Array.isArray(sourcesLock.capabilities)) {
    errors.push("capabilities in sources.lock.json must be an array");
  } else {
    const declaredSourceIds = new Set(
      Array.isArray(sourcesLock.sources)
        ? sourcesLock.sources.map((s) => s?.id).filter(Boolean)
        : []
    );

    const manifestUpstreamSkills = new Set([
      ...(manifest?.upstream_core_skills ?? []),
      ...(manifest?.upstream_pacebuild_skills ?? [])
    ]);

    const seenCapabilityIds = new Set();

    for (const cap of sourcesLock.capabilities) {
      if (!cap || typeof cap !== "object") {
        errors.push("Invalid capability entry in sources.lock.json");
        continue;
      }

      const { id, skill_path, reference_paths, source_ids, adaptation, vendored_code } = cap;

      if (!id || typeof id !== "string") {
        errors.push("Capability entry missing string id");
      } else if (seenCapabilityIds.has(id)) {
        errors.push(`Duplicate capability ID in sources.lock.json: ${id}`);
      } else {
        seenCapabilityIds.add(id);
      }

      if (vendored_code !== false) {
        errors.push(`Capability ${id || "unknown"} vendored_code must be boolean false`);
      }

      if (!adaptation || typeof adaptation !== "string") {
        errors.push(`Capability ${id || "unknown"} missing adaptation description`);
      }

      if (!Array.isArray(source_ids) || source_ids.length === 0) {
        errors.push(`Capability ${id || "unknown"} source_ids must be a non-empty array`);
      } else {
        const capSourceIds = new Set();
        for (const sId of source_ids) {
          if (capSourceIds.has(sId)) {
            errors.push(`Capability ${id || "unknown"} contains duplicate source ID: ${sId}`);
          } else {
            capSourceIds.add(sId);
          }
          if (!declaredSourceIds.has(sId)) {
            errors.push(
              `Capability ${id || "unknown"} references undeclared source ID: ${sId}`
            );
          }
        }
      }

      if (!skill_path || typeof skill_path !== "string") {
        errors.push(`Capability ${id || "unknown"} missing skill_path`);
      } else {
        const safety = checkPathSafety(skill_path, rootDir);
        if (!safety.safe) {
          errors.push(`Capability ${id || "unknown"} skill_path path escape detected: ${skill_path}`);
        } else {
          if (!fs.existsSync(safety.resolvedPath)) {
            errors.push(`Capability ${id || "unknown"} skill_path file does not exist: ${skill_path}`);
          }
          if (!manifestUpstreamSkills.has(skill_path)) {
            errors.push(
              `Capability ${id || "unknown"} skill_path not listed in manifest upstream skills: ${skill_path}`
            );
          }
        }
      }

      if (reference_paths !== undefined) {
        if (!Array.isArray(reference_paths)) {
          errors.push(`Capability ${id || "unknown"} reference_paths must be an array if defined`);
        } else {
          for (const refPath of reference_paths) {
            if (typeof refPath !== "string") {
              errors.push(`Capability ${id || "unknown"} reference_paths item must be string`);
              continue;
            }
            const safety = checkPathSafety(refPath, rootDir);
            if (!safety.safe) {
              errors.push(`Capability ${id || "unknown"} reference_paths path escape detected: ${refPath}`);
            } else {
              if (!fs.existsSync(safety.resolvedPath)) {
                errors.push(`Capability ${id || "unknown"} reference path file does not exist: ${refPath}`);
              }
            }
          }
        }
      }
    }
  }

  return errors;
}
