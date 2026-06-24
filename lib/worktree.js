import path from "node:path";
import { spawnSync } from "node:child_process";

export function branchName(issueKey, summary) {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${issueKey.toLowerCase()}-${slug}`;
}

export function prepareWorktree({
  repoPath,
  root,
  issueKey,
  summary,
  execute = false
}) {
  const branch = branchName(issueKey, summary);
  const worktree = path.join(root, branch);
  const command = [
    "git",
    "-c",
    "safe.directory=*",
    "worktree",
    "add",
    "-b",
    branch,
    worktree,
    "HEAD"
  ];
  if (execute) {
    const result = spawnSync(command[0], command.slice(1), {
      cwd: repoPath,
      stdio: "inherit"
    });
    if (result.status !== 0) throw new Error("Failed to create worktree");
  }
  return { branch, worktree, command };
}
