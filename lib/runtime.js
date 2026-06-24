import path from "node:path";
import { spawnSync } from "node:child_process";
import { evaluateIssue } from "./policy.js";
import { routeIssue } from "./routing.js";
import { RunStore } from "./store.js";
import { prepareWorktree } from "./worktree.js";

export function issuePlan(settings, issue) {
  const eligibility = evaluateIssue(issue, settings.data.policy);
  const route = routeIssue(issue);
  const worktree = prepareWorktree({
    repoPath: settings.repoPath,
    root: settings.worktreeRoot,
    issueKey: issue.key,
    summary: issue.summary
  });
  return {
    issue: issue.key,
    eligible: eligibility.allowed,
    eligibilityReasons: eligibility.reasons,
    ...route,
    ...worktree
  };
}

export function getStore(settings) {
  return new RunStore(
    path.join(path.dirname(settings.source), ".agent-runtime", "runs.sqlite3")
  );
}

export function runIssue(settings, issue, execute) {
  const plan = issuePlan(settings, issue);
  const store = getStore(settings);
  const runId = store.createRun(issue.key, plan);
  if (!plan.eligible) {
    store.transition(runId, "blocked", { reasons: plan.eligibilityReasons });
    return { exitCode: 2, output: { runId, ...plan } };
  }
  store.transition(runId, "eligible", plan);
  if (!execute) {
    return { exitCode: 0, output: { runId, mode: "dry-run", ...plan } };
  }
  if (!store.acquireLock(issue.key, runId)) {
    store.transition(runId, "blocked", { reason: "issue already locked" });
    return { exitCode: 3, output: { runId, error: "issue already locked" } };
  }
  store.transition(runId, "claimed");
  const prepared = prepareWorktree({
    repoPath: settings.repoPath,
    root: settings.worktreeRoot,
    issueKey: issue.key,
    summary: issue.summary,
    execute: true
  });
  store.transition(runId, "prepared", prepared);
  const prompt = [
    `Implement Jira issue ${issue.key}: ${issue.summary}`,
    issue.description,
    "Follow AGENTS.md. Keep scope surgical, run relevant tests, and do not merge or transition the issue to Done."
  ].join("\n\n");
  const executor = settings.data.executor.codex;
  const command = executor.command.map((part) =>
    part.replace("{worktree}", prepared.worktree).replace("{prompt}", prompt)
  );
  store.transition(runId, "executing", { command });
  const result = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    timeout: executor.timeoutSeconds * 1000
  });
  const returnCode = result.status ?? 1;
  store.transition(
    runId,
    returnCode === 0 ? "verifying" : "failed-retryable",
    { returnCode }
  );
  return { exitCode: returnCode, output: { runId, returnCode } };
}
