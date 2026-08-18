import fs from "node:fs";
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

function canonicalPath(p) {
  try {
    const realFn = fs.realpathSync.native || fs.realpathSync;
    const resolved = fs.existsSync(p) ? realFn(p) : path.resolve(p);
    return path.normalize(resolved).toLowerCase().replaceAll("\\", "/");
  } catch {
    return path.normalize(path.resolve(p)).toLowerCase().replaceAll("\\", "/");
  }
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

  resolveRevision({ repoPath, requestedRef = "develop", epicKey = null, runtime = { spawnSync } }) {
    const base = this.resolveBaseRevision({ repoPath, requestedRef, epicKey, runtime });
    if (!base.resolved) {
      return { ok: false, ref: base.ref || requestedRef, sha: null, error: base.error || `Cannot resolve ref: ${requestedRef}` };
    }
    const cwd = repoPath;
    const result = (runtime.spawnSync || spawnSync)(
      "git",
      ["-c", `safe.directory=${cwd}`, "-C", cwd, "rev-parse", `${base.ref}^{commit}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const sha = String(result.stdout || "").trim().toLowerCase();
    const ok = result.status === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(sha);
    return {
      ok,
      ref: base.ref,
      sha: ok ? sha : null,
      error: ok ? null : String(result.stderr || result.stdout || `Failed to resolve commit SHA for ${base.ref}`).trim()
    };
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
    const resolvedRoot = path.resolve(root);
    const worktree = path.join(resolvedRoot, branch.replaceAll("/", "-"));
    if (!worktree.startsWith(resolvedRoot + path.sep) && worktree !== resolvedRoot) {
      throw new Error(`Worktree path '${worktree}' escapes configured worktree root '${resolvedRoot}'`);
    }
    if (fs.existsSync(resolvedRoot) && fs.existsSync(worktree)) {
      const realRoot = fs.realpathSync(resolvedRoot);
      const realWorktree = fs.realpathSync(worktree);
      if (!realWorktree.startsWith(realRoot + path.sep) && realWorktree !== realRoot) {
        throw new Error(`Worktree realpath '${realWorktree}' escapes trusted root '${realRoot}'`);
      }
    }
    const baseRev = this.resolveRevision({ repoPath, requestedRef: baseRef, runtime });
    const baseSha = baseRev.sha;
    const command = ["git", "-c", `safe.directory=${repoPath}`, "worktree", "add", "-b", branch, worktree, baseRev.ref || baseRef];

    if (execute) {
      if (!baseRev.ok) throw new Error(baseRev.error || `Git base ref does not exist: ${baseRef}`);

      const worktreeExists = (runtime.spawnSync || spawnSync)(
        "git",
        ["-c", `safe.directory=${repoPath}`, "-C", repoPath, "worktree", "list", "--porcelain"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );
      const registeredWorktrees = String(worktreeExists.stdout || "")
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => canonicalPath(line.slice(9).trim()));

      const normalizedTarget = canonicalPath(worktree);
      const isRegistered = registeredWorktrees.includes(normalizedTarget);

      if (fs.existsSync(worktree) && !isRegistered) {
        throw new Error(`Directory at '${worktree}' exists but is not a registered Git worktree`);
      }

      if (isRegistered) {
        const branchCheck = (runtime.spawnSync || spawnSync)(
          "git",
          ["-c", `safe.directory=${worktree}`, "-C", worktree, "branch", "--show-current"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        const currentBranch = String(branchCheck.stdout || "").trim();
        if (currentBranch !== branch) {
          throw new Error(`Integration worktree at '${worktree}' is on branch '${currentBranch}', expected '${branch}'`);
        }
        if (!this.isClean({ repoPath: worktree, runtime })) {
          throw new Error(`Existing integration worktree at '${worktree}' is dirty`);
        }
        const wtHeadRes = this.getHead({ repoPath: worktree, runtime });
        if (!wtHeadRes.ok || (baseSha && !this.isAncestor(baseSha, wtHeadRes.sha, { repoPath, runtime }))) {
          throw new Error(`Existing integration worktree at '${worktree}' does not have base '${baseSha || baseRef}' in its ancestry`);
        }
      } else {
        const result = (runtime.spawnSync || spawnSync)(command[0], command.slice(1), { cwd: repoPath, stdio: "inherit" });
        if (result.status !== 0) throw new Error(`Failed to create integration worktree for ${parentKey}`);
      }
    }

    return {
      parentKey,
      branch,
      worktree,
      baseRef: baseRev.ref || baseRef,
      baseSha,
      baseRefResolved: baseRev.ok,
      baseRefError: baseRev.error,
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
    runtime = { spawnSync },
    plan = null,
    originatingRun = null
  } = {}, options = {}) {
    const branch = leafBranchName(issueKey, summary);
    const resolvedRoot = path.resolve(root);
    const worktree = path.join(resolvedRoot, branch.replaceAll("/", "-"));
    if (!worktree.startsWith(resolvedRoot + path.sep) && worktree !== resolvedRoot) {
      throw new Error(`Worktree path '${worktree}' escapes configured worktree root '${resolvedRoot}'`);
    }
    if (fs.existsSync(resolvedRoot) && fs.existsSync(worktree)) {
      const realRoot = fs.realpathSync(resolvedRoot);
      const realWorktree = fs.realpathSync(worktree);
      if (!realWorktree.startsWith(realRoot + path.sep) && realWorktree !== realRoot) {
        throw new Error(`Worktree realpath '${realWorktree}' escapes trusted root '${realRoot}'`);
      }
    }
    const targetRef = baseRef || parentBranch;
    const baseRev = this.resolveRevision({
      repoPath,
      requestedRef: targetRef,
      epicKey: parentKey,
      runtime
    });
    const baseSha = baseRev.sha;
    const command = ["git", "-c", `safe.directory=${repoPath}`, "worktree", "add", "-b", branch, worktree, baseSha || baseRev.ref || targetRef];

    if (execute) {
      if (!baseRev.ok) throw new Error(baseRev.error || `Git base ref does not exist: ${targetRef}`);

      const worktreeExists = (runtime.spawnSync || spawnSync)(
        "git",
        ["-c", `safe.directory=${repoPath}`, "-C", repoPath, "worktree", "list", "--porcelain"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );
      const registeredWorktrees = String(worktreeExists.stdout || "")
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => canonicalPath(line.slice(9).trim()));

      const normalizedTarget = canonicalPath(worktree);
      const isRegistered = registeredWorktrees.includes(normalizedTarget);

      if (fs.existsSync(worktree) && !isRegistered) {
        throw new Error(`Directory at '${worktree}' exists but is not a registered Git worktree`);
      }

      if (isRegistered) {
        const branchCheck = (runtime.spawnSync || spawnSync)(
          "git",
          ["-c", `safe.directory=${worktree}`, "-C", worktree, "branch", "--show-current"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        const currentBranch = String(branchCheck.stdout || "").trim();
        if (currentBranch && currentBranch !== branch) {
          throw new Error(`Child worktree at '${worktree}' is on branch '${currentBranch}', expected '${branch}'`);
        }
        if (!this.isClean({ repoPath: worktree, runtime })) {
          throw new Error(`Existing child worktree at '${worktree}' is dirty`);
        }
      } else {
        const brCheck = (runtime.spawnSync || spawnSync)(
          "git",
          ["-c", `safe.directory=${repoPath}`, "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        const cmd = brCheck.status === 0
          ? ["git", "-c", `safe.directory=${repoPath}`, "-C", repoPath, "worktree", "add", worktree, branch]
          : command;
        const result = (runtime.spawnSync || spawnSync)(cmd[0], cmd.slice(1), { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        if (result.status !== 0) throw new Error(`Failed to create child worktree for ${issueKey}: ${result.stderr || result.stdout}`);
      }

      // Verify HEAD == baseSha if baseSha was pinned
      if (baseSha) {
        const wtHead = this.getHead({ repoPath: worktree, runtime });
        if (!wtHead.ok) {
          throw new Error(`Cannot resolve HEAD of child worktree at '${worktree}'`);
        }
        const effectiveOriginatingRun = originatingRun || options?.originatingRun;
        const effectivePlan = plan || options?.plan;
        const isFirstImplementation = !effectiveOriginatingRun && (!effectivePlan?.attempt || effectivePlan.attempt === 0);
        if (isFirstImplementation) {
          if (wtHead.sha.toLowerCase() !== baseSha.toLowerCase()) {
            throw new Error(`Child worktree HEAD (${wtHead.sha.slice(0, 8)}) must exactly match pinned childBaseSha (${baseSha.slice(0, 8)}) on first implementation`);
          }
        } else {
          if (!this.isAncestor(baseSha, wtHead.sha, { repoPath, runtime })) {
            throw new Error(`Child worktree HEAD (${wtHead.sha.slice(0, 8)}) is not descended from pinned baseSha (${baseSha.slice(0, 8)})`);
          }
        }
      }
    }

    return {
      parentKey,
      issueKey,
      branch,
      worktree,
      baseRef: baseRev.ref || targetRef,
      baseSha,
      baseRefResolved: baseRev.ok,
      baseRefError: baseRev.error,
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
