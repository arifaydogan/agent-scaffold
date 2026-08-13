import path from "node:path";
import { spawnSync } from "node:child_process";
import { authorizeRuntimeAction } from "./policy.js";

function git(repoPath, args, runtime = { spawnSync }) {
  return runtime.spawnSync(
    "git",
    ["-c", `safe.directory=${repoPath}`, "-C", repoPath, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Resolve a requested branch to a real local or origin ref. Epic keys may be
 * supplied as an unslugged prefix (epic/pace-124); in that case exactly one
 * slugged branch must exist.
 */
export function resolveBaseRef({ repoPath, requestedRef = "HEAD", epicKey = null, runtime = { spawnSync } }) {
  if (requestedRef === "HEAD") {
    const originHead = git(repoPath, ["rev-parse", "--verify", "--quiet", "origin/HEAD^{commit}"], runtime);
    if (originHead.status === 0) {
      return { ref: "origin/HEAD", resolved: true, candidates: ["origin/HEAD"], error: null };
    }
    return { ref: requestedRef, resolved: true, candidates: [requestedRef], error: null };
  }

  const exactCandidates = unique([requestedRef, `origin/${requestedRef}`]);
  for (const candidate of exactCandidates) {
    const result = git(repoPath, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], runtime);
    if (result.status === 0) {
      return { ref: candidate, resolved: true, candidates: [candidate], error: null };
    }
  }

  const normalizedEpicKey = String(epicKey || "").toLowerCase();
  if (normalizedEpicKey) {
    const prefix = `epic/${normalizedEpicKey}-`;
    const refs = git(
      repoPath,
      [
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/heads/${prefix}*`,
        `refs/remotes/origin/${prefix}*`
      ],
      runtime
    );
    if (refs.status === 0) {
      const candidates = unique(
        String(refs.stdout || "")
          .split(/\r?\n/)
          .map((value) => value.trim())
      );
      const local = candidates.filter((candidate) => !candidate.startsWith("origin/"));
      const usable = local.length ? local : candidates;
      if (usable.length === 1) {
        return { ref: usable[0], resolved: true, candidates, error: null };
      }
      if (usable.length > 1) {
        return {
          ref: requestedRef,
          resolved: false,
          candidates,
          error: `Ambiguous epic branch for ${epicKey}: ${usable.join(", ")}`
        };
      }
    }
  }

  return {
    ref: requestedRef,
    resolved: false,
    candidates: [],
    error: `Git base ref does not exist: ${requestedRef}`
  };
}

export function branchName(issueKey, summary, issueType = "task") {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const type = issueType.toLowerCase();
  const prefix = ["story", "subtask"].includes(type) ? type : "task";
  return `${prefix}/${issueKey.toLowerCase()}-${slug}`;
}

export function prepareWorktree({
  repoPath,
  root,
  issueKey,
  summary,
  issueType = "task",
  epicBranch = "HEAD",
  epicKey = null,
  execute = false,
  runtime = { spawnSync },
  settings = null,
  store = null,
  plan = null,
  originatingRun = null
}) {
  const branch = branchName(issueKey, summary, issueType);
  const worktree = path.join(root, branch.replace(/\//g, "-"));
  const base = resolveBaseRef({
    repoPath,
    requestedRef: epicBranch,
    epicKey,
    runtime
  });
  const command = [
    "git",
    "-c",
    `safe.directory=${repoPath}`,
    "worktree",
    "add",
    "-b",
    branch,
    worktree,
    base.ref
  ];
  if (execute) {
    if (settings) {
      const auth = authorizeRuntimeAction(settings, store, {
        issueKey,
        action: "branchCreation",
        plan,
        originatingRun
      });
      if (!auth.allowed) {
        throw new Error(`Branch creation is not authorized: ${auth.reason}`);
      }
    }
    if (!base.resolved) {
      throw new Error(base.error);
    }
    const result = runtime.spawnSync(command[0], command.slice(1), {
      cwd: repoPath,
      stdio: "inherit"
    });
    if (result.status !== 0) throw new Error("Failed to create worktree");
  }
  return {
    branch,
    worktree,
    baseRef: base.ref,
    baseRefResolved: base.resolved,
    baseRefError: base.error,
    command
  };
}
