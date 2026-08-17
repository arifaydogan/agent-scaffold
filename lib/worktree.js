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

  // Check if issue belongs to a parent epic with pinned childBaseSha
  let targetRef = epicBranch;
  let epicTask = null;
  if (store) {
    const parentKey = epicKey || plan?.parentKey || plan?.epicKey;
    if (parentKey && typeof store.getEpicTask === "function") {
      epicTask = store.getEpicTask(parentKey, issueKey);
    }
    if (!epicTask && store.database) {
      try {
        const row = store.database.prepare("SELECT * FROM epic_tasks WHERE issue_key = ? LIMIT 1").get(issueKey);
        if (row) {
          epicTask = {
            epicKey: row.epic_key,
            parentKey: row.epic_key,
            issueKey: row.issue_key,
            summary: row.summary,
            branch: row.branch,
            worktree: row.worktree,
            state: row.state,
            orchestrationState: row.orchestration_state,
            dependencies: row.dependencies ? JSON.parse(row.dependencies) : [],
            childBaseSha: row.child_base_sha,
            reviewedSha: row.reviewed_sha,
            integratedSha: row.integrated_sha,
            blockedReasons: row.blocked_reasons ? JSON.parse(row.blocked_reasons) : []
          };
        }
      } catch {}
    } else if (!epicTask && typeof store.listEpicTasks === "function") {
      const allTasks = store.listEpicTasks(null) || [];
      epicTask = allTasks.find((t) => t.issueKey === issueKey);
    }
    if (epicTask?.childBaseSha) {
      targetRef = epicTask.childBaseSha;
    }
  }

  const base = resolveBaseRef({
    repoPath,
    requestedRef: targetRef,
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
      throw new Error(base.error || `Base ref cannot be resolved: ${targetRef}`);
    }

    // Check if worktree is already created
    const wtListRes = runtime.spawnSync(
      "git",
      ["-c", `safe.directory=${repoPath}`, "-C", repoPath, "worktree", "list", "--porcelain"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const isRegistered = String(wtListRes.stdout || "").includes(worktree);

    if (isRegistered) {
      const curBranchRes = runtime.spawnSync(
        "git",
        ["-c", `safe.directory=${worktree}`, "-C", worktree, "branch", "--show-current"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );
      const curBranch = String(curBranchRes.stdout || "").trim();
      if (curBranch !== branch) {
        throw new Error(`Existing worktree at '${worktree}' is on branch '${curBranch}', expected '${branch}'`);
      }
    } else {
      const result = runtime.spawnSync(command[0], command.slice(1), {
        cwd: repoPath,
        stdio: "inherit"
      });
      if (result.status !== 0) throw new Error("Failed to create worktree");
    }

    // If epicTask has childBaseSha, verify HEAD matches or descends from childBaseSha
    if (epicTask?.childBaseSha) {
      const headRes = runtime.spawnSync(
        "git",
        ["-c", `safe.directory=${worktree}`, "-C", worktree, "rev-parse", "HEAD"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );
      const curHead = String(headRes.stdout || "").trim().toLowerCase();
      if (curHead !== epicTask.childBaseSha.toLowerCase()) {
        const ancCheck = runtime.spawnSync(
          "git",
          ["-c", `safe.directory=${repoPath}`, "-C", repoPath, "merge-base", "--is-ancestor", epicTask.childBaseSha, curHead],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        if (ancCheck.status !== 0) {
          throw new Error(`Child worktree HEAD (${curHead.slice(0, 8)}) is not descended from pinned childBaseSha (${epicTask.childBaseSha.slice(0, 8)})`);
        }
      }
    }

    // Persist worktree path back to epicTask in store
    if (store && epicTask) {
      store.upsertEpicTask({
        ...epicTask,
        worktree
      });
    }
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
