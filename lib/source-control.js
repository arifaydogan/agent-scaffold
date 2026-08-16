import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBaseRef } from "./worktree.js";
import { epicBranchName, leafBranchName } from "./epic.js";
import { integrateLeafToEpic } from "./git-integration.js";

/**
 * Provider-neutral SourceControlProvider base class.
 */
export class SourceControlProvider {
  async resolveBaseRevision(options) { throw new Error("Not implemented"); }
  async prepareIntegrationWorktree(options) { throw new Error("Not implemented"); }
  async prepareChildWorktree(options) { throw new Error("Not implemented"); }
  async getHead(options) { throw new Error("Not implemented"); }
  async isAncestor(ancestorSha, descendantSha, options) { throw new Error("Not implemented"); }
  async isClean(options) { throw new Error("Not implemented"); }
  async integrateReviewedRevision(settings, request, options) { throw new Error("Not implemented"); }
}

/**
 * Local Git SourceControlProvider implementation.
 * Wraps existing worktree, git-integration, and epic branch naming utilities.
 */
export class LocalGitSourceControlProvider extends SourceControlProvider {
  constructor(config = {}, environment = process.env) {
    super();
    this.name = config.providerName || "local-git";
    this.type = config.type || "local-git";
    this.enabled = config.enabled !== false;
  }

  resolveBaseRevision({ repoPath, requestedRef = "HEAD", epicKey = null, runtime = { spawnSync } }) {
    return resolveBaseRef({ repoPath, requestedRef, epicKey, runtime });
  }

  prepareIntegrationWorktree({
    repoPath,
    root,
    parentKey,
    summary = "",
    baseRef = "develop",
    execute = false,
    runtime = { spawnSync }
  }) {
    const branch = epicBranchName(parentKey, summary);
    const worktree = path.join(root, branch.replaceAll("/", "-"));
    const base = this.resolveBaseRevision({ repoPath, requestedRef: baseRef, runtime });
    const command = ["git", "-c", `safe.directory=${repoPath}`, "worktree", "add", "-b", branch, worktree, base.ref];
    if (execute) {
      if (!base.resolved) throw new Error(base.error || `Git base ref does not exist: ${baseRef}`);
      const result = runtime.spawnSync(command[0], command.slice(1), { cwd: repoPath, stdio: "inherit" });
      if (result.status !== 0) throw new Error(`Failed to create integration worktree for ${parentKey}`);
    }
    return {
      parentKey,
      branch,
      worktree,
      baseRef: base.ref,
      baseRefResolved: base.resolved,
      baseRefError: base.error,
      command
    };
  }

  prepareChildWorktree({
    repoPath,
    root,
    parentKey,
    parentBranch,
    issueKey,
    summary = "",
    baseRef = null,
    execute = false,
    runtime = { spawnSync }
  }) {
    const branch = leafBranchName(issueKey, summary);
    const worktree = path.join(root, branch.replaceAll("/", "-"));
    const targetRef = baseRef || parentBranch;
    const base = this.resolveBaseRevision({
      repoPath,
      requestedRef: targetRef,
      epicKey: parentKey,
      runtime
    });
    const command = ["git", "-c", `safe.directory=${repoPath}`, "worktree", "add", "-b", branch, worktree, base.ref];
    if (execute) {
      if (!base.resolved) throw new Error(base.error || `Git base ref does not exist: ${targetRef}`);
      const result = runtime.spawnSync(command[0], command.slice(1), { cwd: repoPath, stdio: "inherit" });
      if (result.status !== 0) throw new Error(`Failed to create child worktree for ${issueKey}`);
    }
    return {
      parentKey,
      issueKey,
      branch,
      worktree,
      baseRef: base.ref,
      baseRefResolved: base.resolved,
      baseRefError: base.error,
      command
    };
  }

  getHead({ repoPath, worktree = null, runtime = { spawnSync } }) {
    const cwd = worktree || repoPath;
    const result = runtime.spawnSync(
      "git",
      ["-c", `safe.directory=${cwd}`, "-C", cwd, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const sha = String(result.stdout || "").trim().toLowerCase();
    const ok = result.status === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(sha);
    return {
      ok,
      sha: ok ? sha : null,
      error: ok ? null : String(result.stderr || result.stdout || "Failed to resolve HEAD").trim()
    };
  }

  isAncestor(ancestorSha, descendantSha, { repoPath, worktree = null, runtime = { spawnSync } } = {}) {
    const cwd = worktree || repoPath;
    const result = runtime.spawnSync(
      "git",
      ["-c", `safe.directory=${cwd}`, "-C", cwd, "merge-base", "--is-ancestor", ancestorSha, descendantSha],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return result.status === 0;
  }

  isClean({ repoPath, worktree = null, runtime = { spawnSync } } = {}) {
    const cwd = worktree || repoPath;
    const result = runtime.spawnSync(
      "git",
      ["-c", `safe.directory=${cwd}`, "-C", cwd, "status", "--porcelain=v1"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return result.status === 0 && String(result.stdout || "").trim().length === 0;
  }

  integrateReviewedRevision(settings, request, options = {}) {
    const store = settings._store || (typeof settings.getStore === "function" ? settings.getStore() : null);
    const parent = store?.getParentExecution ? store.getParentExecution(request.epicKey) : null;
    const effectiveRepoPath = request.worktree || parent?.integrationWorktree || settings.repoPath;
    const effectiveSettings = effectiveRepoPath !== settings.repoPath
      ? { ...settings, repoPath: effectiveRepoPath }
      : settings;
    return integrateLeafToEpic(effectiveSettings, request, options);
  }
}

export function configuredSourceControlProviders(settings) {
  return settings.data?.sourceControl?.providers || {
    "local-git": { type: "local-git", enabled: true }
  };
}

export function selectedSourceControlProviderName(settings) {
  const providers = configuredSourceControlProviders(settings);
  return settings.data?.sourceControl?.defaultProvider || Object.keys(providers)[0] || "local-git";
}

export function createSourceControlProvider(settings, environment = process.env) {
  const name = selectedSourceControlProviderName(settings);
  const providers = configuredSourceControlProviders(settings);
  const config = providers[name] || { type: "local-git" };
  if (config.type === "local-git" || name === "local-git") {
    return new LocalGitSourceControlProvider({ ...config, providerName: name }, environment);
  }
  throw new Error(`Unsupported source control provider type: ${config.type || name}`);
}

export function describeSourceControlProviders(settings) {
  const selected = selectedSourceControlProviderName(settings);
  return Object.entries(configuredSourceControlProviders(settings)).map(([name, config]) => ({
    id: name,
    type: config.type || name,
    selected: name === selected,
    enabled: config.enabled !== false
  }));
}
