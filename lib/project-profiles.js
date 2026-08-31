import path from "node:path";
import { spawnSync } from "node:child_process";

const PROFILE_ID = /^[a-z0-9][a-z0-9-]*$/;

function stringList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    repository: path.basename(profile.repoPath),
    repoPath: profile.repoPath,
    baseBranch: profile.baseBranch,
    match: {
      labels: [...profile.match.labels],
      components: [...profile.match.components]
    }
  };
}

export function normalizeProjectProfiles(data, configDirectory) {
  const rawProfiles = data.projectProfiles;
  if (rawProfiles === undefined) {
    return [{
      id: "default",
      name: data.project.name || data.project.key,
      repoPath: path.resolve(configDirectory, data.project.repoPath),
      worktreeRoot: path.resolve(configDirectory, data.worktree.root),
      rawRepoPath: data.project.repoPath,
      rawWorktreeRoot: data.worktree.root,
      baseBranch: data.project.baseBranch || data.project.baseRef || "develop",
      match: { labels: [], components: [] },
      legacyDefault: true
    }];
  }
  if (!rawProfiles || typeof rawProfiles !== "object" || Array.isArray(rawProfiles)) {
    throw new Error("projectProfiles must be an object keyed by profile id");
  }
  const entries = Object.entries(rawProfiles);
  if (entries.length === 0) throw new Error("projectProfiles must define at least one profile");
  return entries.map(([id, raw]) => {
    if (!PROFILE_ID.test(id)) throw new Error(`Invalid project profile id: ${id}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`projectProfiles.${id} must be an object`);
    }
    const repoPath = String(raw.repoPath || "").trim();
    const worktreeRoot = String(raw.worktreeRoot || "").trim();
    const baseBranch = String(raw.baseBranch || "").trim();
    if (!repoPath) throw new Error(`projectProfiles.${id}.repoPath is required`);
    if (!worktreeRoot) throw new Error(`projectProfiles.${id}.worktreeRoot is required`);
    if (!baseBranch) throw new Error(`projectProfiles.${id}.baseBranch is required`);
    const match = raw.match || {};
    if (!match || typeof match !== "object" || Array.isArray(match)) {
      throw new Error(`projectProfiles.${id}.match must be an object`);
    }
    return {
      id,
      name: String(raw.name || id).trim(),
      repoPath: path.resolve(configDirectory, repoPath),
      worktreeRoot: path.resolve(configDirectory, worktreeRoot),
      rawRepoPath: repoPath,
      rawWorktreeRoot: worktreeRoot,
      baseBranch,
      match: {
        labels: stringList(match.labels, `projectProfiles.${id}.match.labels`),
        components: stringList(match.components, `projectProfiles.${id}.match.components`)
      },
      legacyDefault: false
    };
  });
}

export function listProjectProfiles(settings) {
  return (settings.projectProfiles || []).map(publicProfile);
}

export function listProjectBaseRefs(settings, runtime = { spawnSync }) {
  const repoPath = settings.repoPath;
  const result = runtime.spawnSync(
    "git",
    [
      "-c", `safe.directory=${repoPath}`, "-C", repoPath,
      "for-each-ref", "--format=%(refname:short)%09%(objectname)",
      "refs/heads", "refs/remotes/origin"
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  if (result.status !== 0) return [];
  const refs = [];
  const seen = new Set();
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const [ref, sha] = line.trim().split(/\t/);
    if (!ref || ref.endsWith("/HEAD") || !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(sha || "")) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push({ ref, sha: sha.toLowerCase() });
    if (refs.length >= 200) break;
  }
  return refs.sort((left, right) => {
    const rank = value => value === "develop" ? 0 : value === "master" ? 1 : value.startsWith("epic/") ? 2 : 3;
    return rank(left.ref) - rank(right.ref) || left.ref.localeCompare(right.ref);
  });
}

export function settingsForProjectProfile(settings, profileId) {
  const profile = (settings.projectProfiles || []).find(candidate => candidate.id === profileId);
  if (!profile) throw new Error(`Unknown project profile: ${profileId}`);
  return {
    ...settings,
    repoPath: profile.repoPath,
    worktreeRoot: profile.worktreeRoot,
    selectedProjectProfile: publicProfile(profile),
    data: {
      ...settings.data,
      project: {
        ...settings.data.project,
        name: profile.name,
        repoPath: profile.rawRepoPath,
        baseBranch: profile.baseBranch
      },
      worktree: {
        ...settings.data.worktree,
        root: profile.rawWorktreeRoot
      }
    }
  };
}

function normalizedValues(values = []) {
  return new Set((Array.isArray(values) ? values : [])
    .map(value => typeof value === "object" ? value?.name : value)
    .filter(Boolean)
    .map(value => String(value).trim().toLowerCase()));
}

function matchingProfiles(profiles, field, values) {
  const normalized = normalizedValues(values);
  if (normalized.size === 0) return [];
  return profiles.filter(profile => profile.match[field]
    .some(value => normalized.has(value.toLowerCase())));
}

function resolved(profile, source) {
  return { status: "resolved", source, profile: publicProfile(profile) };
}

function uniqueMatch(profiles, issue, prefix) {
  const labels = matchingProfiles(profiles, "labels", issue?.labels);
  if (labels.length === 1) return resolved(labels[0], `${prefix}label`);
  if (labels.length > 1) return { status: "ambiguous", source: `${prefix}label`, matches: labels };
  const components = matchingProfiles(profiles, "components", issue?.components);
  if (components.length === 1) return resolved(components[0], `${prefix}component`);
  if (components.length > 1) return { status: "ambiguous", source: `${prefix}component`, matches: components };
  return null;
}

function selectedProfile(profiles, profileId) {
  if (!profileId) return null;
  const profile = profiles.find(candidate => candidate.id === profileId);
  if (!profile) throw new Error(`Unknown project profile: ${profileId}`);
  return profile;
}

export function resolveProjectProfile(settings, issue, options = {}) {
  const profiles = settings.projectProfiles || [];
  if (profiles.length === 0) throw new Error("No project profiles are configured");
  if (profiles.length === 1 && profiles[0].legacyDefault) {
    return resolved(profiles[0], "legacy-default");
  }

  const requested = selectedProfile(profiles, options.requestedProfileId);
  const itemMatch = uniqueMatch(profiles, issue, "work-item-");
  if (itemMatch?.status === "resolved") {
    if (requested && requested.id !== itemMatch.profile.id) {
      return {
        status: "required",
        reason: "selection_conflicts_with_work_item",
        detectedProfileId: itemMatch.profile.id,
        profiles: profiles.map(publicProfile)
      };
    }
    return itemMatch;
  }
  if (itemMatch?.status === "ambiguous" && requested) {
    return resolved(requested, "manual-ambiguous-work-item");
  }
  if (requested) return resolved(requested, "manual");

  const saved = options.savedProfileId
    ? profiles.find(profile => profile.id === options.savedProfileId) || null
    : null;
  if (saved) return resolved(saved, "saved-manual");

  const parentMatch = uniqueMatch(profiles, options.parentIssue, "parent-");
  if (parentMatch?.status === "resolved") return parentMatch;
  const savedParent = options.savedParentProfileId
    ? profiles.find(profile => profile.id === options.savedParentProfileId) || null
    : null;
  if (savedParent) return resolved(savedParent, "saved-parent");

  const ambiguousIds = [itemMatch, parentMatch]
    .filter(match => match?.status === "ambiguous")
    .flatMap(match => match.matches.map(profile => profile.id));
  return {
    status: "required",
    reason: ambiguousIds.length > 0 ? "ambiguous_match" : "no_match",
    matchedProfileIds: [...new Set(ambiguousIds)],
    profiles: profiles.map(publicProfile)
  };
}
