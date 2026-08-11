import path from "node:path";
import { spawnSync } from "node:child_process";

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
  execute = false
}) {
  const branch = branchName(issueKey, summary, issueType);
  const worktree = path.join(root, branch.replace(/\//g, "-"));
  const command = [
    "git",
    "-c",
    `safe.directory=${repoPath}`,
    "worktree",
    "add",
    "-b",
    branch,
    worktree,
    epicBranch
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
