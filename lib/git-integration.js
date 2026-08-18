import { spawnSync } from "node:child_process";

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

function run(runtime, command, args, cwd, options = {}) {
  return runtime.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: options.shell ?? false
  });
}

function git(runtime, repoPath, args) {
  return run(runtime, "git", ["-c", `safe.directory=${repoPath}`, ...args], repoPath, { shell: false });
}

function output(result) {
  return String(result?.stdout || result?.stderr || "").trim();
}

function failure(message, result = null) {
  const detail = output(result);
  return { completed: false, conflict: detail ? `${message}: ${detail}` : message };
}

/**
 * Integrate one independently reviewed leaf SHA into the checked-out epic branch.
 * The merge is kept uncommitted until the full repository check passes, so a
 * failed check or conflict can be aborted without advancing the epic branch.
 */
export function integrateLeafToEpic(settings, request, options = {}) {
  const runtime = options.runtime || { spawnSync };
  const repoPath = settings.repoPath;
  const { issueKey, sourceBranch, targetBranch, reviewedSha } = request;
  if (!FULL_SHA.test(String(reviewedSha || ""))) {
    return failure("Integration requires a full independently reviewed Git SHA");
  }

  const current = git(runtime, repoPath, ["branch", "--show-current"]);
  if (current.status !== 0 || output(current) !== targetBranch) {
    return failure(`Canonical epic worktree must have ${targetBranch} checked out`, current);
  }
  const status = git(runtime, repoPath, ["status", "--porcelain"]);
  if (status.status !== 0 || output(status)) {
    return failure("Canonical epic worktree is not clean", status);
  }
  let source = git(runtime, repoPath, ["rev-parse", `${sourceBranch}^{commit}`]);
  if (source.status !== 0) {
    source = git(runtime, repoPath, ["rev-parse", `${reviewedSha}^{commit}`]);
  }
  if (source.status !== 0 || output(source).toLowerCase() !== reviewedSha.toLowerCase()) {
    return failure("Reviewed SHA no longer matches the leaf branch tip", source);
  }

  const merge = git(runtime, repoPath, ["merge", "--no-ff", "--no-commit", reviewedSha]);
  if (merge.status !== 0) {
    const unmerged = git(runtime, repoPath, ["diff", "--name-only", "--diff-filter=U"]);
    git(runtime, repoPath, ["merge", "--abort"]);
    return failure(
      `Leaf-to-epic merge conflict${output(unmerged) ? ` in ${output(unmerged)}` : ""}`,
      merge
    );
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const verification = run(runtime, npmCommand, ["run", "check"], repoPath, { shell: process.platform === "win32" });
  if (verification.status !== 0) {
    git(runtime, repoPath, ["merge", "--abort"]);
    return failure("Merged tree failed npm run check", verification);
  }

  const commit = git(runtime, repoPath, [
    "commit",
    "-m",
    `chore(epic): integrate ${issueKey}`
  ]);
  if (commit.status !== 0) {
    git(runtime, repoPath, ["merge", "--abort"]);
    return failure("Could not create the epic integration commit", commit);
  }

  const integrated = git(runtime, repoPath, ["rev-parse", "HEAD"]);
  const integratedSha = output(integrated).toLowerCase();
  const ancestry = git(runtime, repoPath, ["merge-base", "--is-ancestor", reviewedSha, integratedSha]);
  if (integrated.status !== 0 || !FULL_SHA.test(integratedSha) || ancestry.status !== 0) {
    return failure("Epic integration commit does not contain the reviewed SHA", integrated);
  }

  return {
    completed: true,
    reviewedSha: reviewedSha.toLowerCase(),
    integratedSha,
    evidence: [
      `source ${sourceBranch}@${reviewedSha.toLowerCase()}`,
      "npm run check: exit 0",
      `target ${targetBranch}@${integratedSha}`
    ]
  };
}
