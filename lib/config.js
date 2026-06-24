import fs from "node:fs";
import path from "node:path";

export function loadSettings(configPath) {
  const source = path.resolve(configPath);
  const data = JSON.parse(fs.readFileSync(source, "utf8"));
  for (const section of ["project", "policy", "worktree", "jira", "executor"]) {
    if (!data[section]) throw new Error(`Missing config section: ${section}`);
  }
  const base = path.dirname(source);
  return {
    source,
    data,
    projectKey: data.project.key,
    repoPath: path.resolve(base, data.project.repoPath),
    worktreeRoot: path.resolve(base, data.worktree.root)
  };
}
