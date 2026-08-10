import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Local-only epic orchestration primitives. This module plans and persists
 * hierarchy, branches and integration intent. It never pushes, merges into
 * develop, updates Jira or sends a remote notification.
 */
function slug(value) {
  return String(value || "work")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "work";
}

export function epicBranchName(epicKey, summary = "") {
  return `epic/${String(epicKey).toLowerCase()}-${slug(summary)}`;
}

export function leafBranchName(issueKey, summary = "") {
  return `task/${String(issueKey).toLowerCase()}-${slug(summary)}`;
}

export function prepareEpicWorktree({ repoPath, root, epicKey, summary, baseRef = "develop", execute = false }) {
  const branch = epicBranchName(epicKey, summary);
  const worktree = path.join(root, branch.replaceAll("/", "-"));
  const command = ["git", "-c", "safe.directory=*", "worktree", "add", "-b", branch, worktree, baseRef];
  if (execute) {
    const result = spawnSync(command[0], command.slice(1), { cwd: repoPath, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Failed to create epic worktree for ${epicKey}`);
  }
  return { epicKey, branch, worktree, baseRef, command };
}

export function prepareLeafWorktree({ repoPath, root, epicKey, epicBranch, issueKey, summary, execute = false }) {
  const branch = leafBranchName(issueKey, summary);
  const worktree = path.join(root, branch.replaceAll("/", "-"));
  const command = ["git", "-c", "safe.directory=*", "worktree", "add", "-b", branch, worktree, epicBranch];
  if (execute) {
    const result = spawnSync(command[0], command.slice(1), { cwd: repoPath, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Failed to create leaf worktree for ${issueKey}`);
  }
  return { epicKey, issueKey, branch, worktree, baseRef: epicBranch, command };
}

function taskKey(task) {
  return typeof task === "string" ? task : task.key;
}

/** Create a durable epic context and attach leaf tasks. Safe to call repeatedly. */
export function registerEpicContext(store, context) {
  const branch = context.branch || epicBranchName(context.key, context.summary);
  const epic = store.upsertEpic({
    key: context.key,
    summary: context.summary,
    branch,
    baseBranch: context.baseBranch || "develop",
    modelBudget: context.modelBudget || 0
  });
  for (const task of context.tasks || []) {
    const key = taskKey(task);
    store.upsertEpicTask({
      epicKey: epic.key,
      issueKey: key,
      summary: typeof task === "string" ? key : task.summary || key,
      branch: typeof task === "string" ? leafBranchName(key) : task.branch || leafBranchName(key, task.summary),
      state: typeof task === "string" ? "planned" : task.state || "planned",
      model: typeof task === "string" ? null : task.model || null,
      budget: typeof task === "string" ? 0 : task.budget || 0
    });
  }
  return store.getEpic(epic.key);
}

/**
 * Return an integration plan only when no other leaf is integrating. Conflicts
 * are persisted and block the epic-ready gate until a human resolves/requeues.
 */
export function requestEpicIntegration(store, { epicKey, issueKey }) {
  const task = store.getEpicTask(epicKey, issueKey);
  if (!task) throw new Error(`Unknown epic task: ${epicKey}/${issueKey}`);
  return store.queueEpicIntegration({ epicKey, issueKey, leafBranch: task.branch });
}

export function completeEpicIntegration(store, { epicKey, issueKey, conflict = null, commit = null }) {
  return store.finishEpicIntegration({ epicKey, issueKey, conflict, commit });
}

/** Every registered leaf must be integrated and no queue/conflict may remain. */
export function evaluateEpicReady(store, epicKey) {
  return store.getEpicReadyGate(epicKey);
}

/** Atomically reserve the one epic-complete notification for an already-ready epic. */
export function reserveEpicReadyNotification(store, epicKey) {
  const gate = evaluateEpicReady(store, epicKey);
  if (!gate.ready) return { reserved: false, gate };
  const notification = store.reserveEpicNotification(epicKey, "epic-ready");
  return { ...notification, gate };
}
