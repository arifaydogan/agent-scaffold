const fs = require('fs');

const runtimeFile = 'c:/Develop/houndvision/agent-scaffold/lib/runtime.js';
let runtimeCode = fs.readFileSync(runtimeFile, 'utf8');

// 1. Add imports to runtime.js
if (!runtimeCode.includes('selectReviewProfile')) {
  // It's already exported from executor.js and imported! Wait, let's check imports.
}
// 2. Rename runIssue to handleImplementation
runtimeCode = runtimeCode.replace(
  'export function runIssue(settings, issue, execute, runtime = { spawnSync, spawn }) {',
  `import { recordReviewerOutcome } from "./reconciler.js";

export function runIssue(settings, issue, execute, runtime = { spawnSync, spawn }) {
  switch (issue.canonicalState) {
    case "ready":
      return handleImplementation(settings, issue, execute, runtime);
    case "review":
      return handleReview(settings, issue, execute, runtime);
    case "rework":
      return handleRework(settings, issue, execute, runtime);
    case "human_approval":
      return handleHumanApprovalObservation(settings, issue, execute, runtime);
    default:
      return { exitCode: 0, output: { runId: null, mode: "skipped" } };
  }
}

export function handleHumanApprovalObservation(settings, issue, execute, runtime) {
  return { exitCode: 0, output: { runId: null, mode: "human_approval_observation", issue: issue.key } };
}

export function handleRework(settings, issue, execute, runtime) {
  return handleImplementation(settings, issue, execute, runtime);
}

export function handleReview(settings, issue, execute, runtime = { spawnSync, spawn }) {
  const store = getStore(settings);
  const runs = store.listRunsDetailed(100);
  const queuedRun = runs.find(r => r.issue_key === issue.key && r.state === "review-queued");
  
  if (!queuedRun) {
    return { exitCode: 1, output: { runId: null, error: "No review-queued run found" } };
  }
  
  const implementationSha = queuedRun.latest_payload?.implementationSha;
  if (!implementationSha) {
    return { exitCode: 1, output: { runId: null, error: "No implementation SHA found to review" } };
  }
  
  const plan = issuePlan(settings, issue);
  const runId = store.createRun(issue.key, { ...plan, type: "review", implementationSha });
  
  if (!execute) {
    return { exitCode: 0, output: { runId, mode: "dry-run", type: "review", implementationSha } };
  }
  
  if (!store.acquireLock(issue.key, runId)) {
    store.transition(runId, "blocked", { reason: "issue already locked" });
    return { exitCode: 3, output: { runId, error: "issue already locked" } };
  }
  store.transition(runId, "claimed");
  
  let profile;
  try {
    profile = selectReviewProfile(settings, issue);
  } catch (err) {}
  
  if (!profile) {
    // fallback if selectReviewProfile fails or no label
    profile = {
      provider: "antigravity",
      config: settings.data.executor?.providers?.antigravity || {},
      persona: "correctness-reviewer",
      taskAgent: "correctness-reviewer",
      agent: "correctness-reviewer",
      model: settings.data.executor?.providers?.antigravity?.defaultModel || "claude-3-5-sonnet-20241022",
      modelProfile: "medium",
      effort: "medium",
      mode: "accept-edits",
      reviewOnly: true
    };
  }
  
  let prepared;
  try {
    prepared = prepareWorktree({
      repoPath: settings.repoPath,
      root: settings.worktreeRoot,
      issueKey: issue.key,
      summary: issue.summary,
      issueType: issue.issueType || "Task",
      epicBranch: issue.epicBranch || "HEAD",
      epicKey: issue.epicKey || null,
      execute: true,
      runtime: { spawnSync: runtime.spawnSync }
    });
    // checkout the exact implementation SHA to review!
    const checkout = runtime.spawnSync("git", ["-c", \`safe.directory=\${prepared.worktree}\`, "-C", prepared.worktree, "checkout", implementationSha], { stdio: "ignore" });
    if (checkout.status !== 0) throw new Error("git checkout failed for SHA " + implementationSha);
  } catch (error) {
    store.transition(runId, "failed", { reason: "Worktree setup failed", error: error.message });
    store.releaseLock(issue.key, runId);
    return { exitCode: 7, output: { runId, error: "Worktree setup failed" } };
  }
  store.transition(runId, "prepared", prepared);
  
  const prompt = \`Review implementation for \${issue.key}: \${issue.summary}\\nImplementation SHA: \${implementationSha}\\nPerform a correctness review and output structured review findings.\\nVerdict must be either "clean" or "changes-requested". Evidence should contain an array of findings.\`;
  
  const built = buildExecutorCommand({ settings, profile, prepared, prompt, runId });
  
  const handleReviewCompletion = ({ exitCode, telemetry, scope }) => {
     let verdict = "changes-requested";
     let evidence = ["Reviewer execution failed or returned invalid response."];
     if (telemetry.ok && telemetry.result) {
       verdict = telemetry.result.verdict === "clean" ? "clean" : "changes-requested";
       evidence = Array.isArray(telemetry.result.evidence) && telemetry.result.evidence.length > 0 
          ? telemetry.result.evidence 
          : ["Reviewer provided no specific evidence."];
     }
     
     recordReviewerOutcome(store, {
       runId: queuedRun.id,
       implementationSha,
       reviewerId: profile.taskAgent || "reviewer",
       verdict,
       evidence
     });
     
     return { exitCode, output: { runId, returnCode: exitCode, provider: profile.provider, model: profile.model, telemetry, scope } };
  };

  if (profile.provider === "antigravity") {
    return spawnProviderAsync(
      { store, runId, built, profile, plan, prepared, issueKey: issue.key, timeoutMs: (profile.config?.timeoutSeconds || 3600) * 1000, workerLeaseSeconds: settings.data.supervisor?.staleAfterSeconds || 90, heartbeatMs: (settings.data.supervisor?.heartbeatSeconds || 10) * 1000 },
      runtime
    ).then(handleReviewCompletion);
  }
  
  // Synchronous fallback
  store.transition(runId, "executing", { provider: profile.provider, workerLeaseId: runId + ":sync", workerLeaseExpiresAt: new Date(Date.now() + 3600000).toISOString() });
  const result = runtime.spawnSync(built.command[0], built.command.slice(1), { cwd: built.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: (profile.config?.timeoutSeconds || 3600) * 1000 });
  const returnCode = result.status ?? 1;
  const stdout = result.stdout || "";
  const stderr = result.stderr || result.error?.message || "";
  const telemetry = parseExecutionOutput(profile.provider, stdout, stderr, returnCode);
  const scope = { allowed: true, changedFiles: [], violations: [], reasons: [] };
  
  store.transition(runId, telemetry.ok ? "verifying" : "failed-retryable", { returnCode, provider: profile.provider, scope });
  return handleReviewCompletion({ exitCode: telemetry.ok ? 0 : returnCode || 4, telemetry, scope });
}

export function handleImplementation(settings, issue, execute, runtime = { spawnSync, spawn }) {`
);
if (!runtimeCode.includes('import { recordReviewerOutcome }')) {
  runtimeCode = runtimeCode.replace(
    'import { RunStore } from "./store.js";',
    'import { RunStore } from "./store.js";\nimport { recordReviewerOutcome } from "./reconciler.js";'
  );
}

// Add selectReviewProfile import
if (!runtimeCode.includes('selectReviewProfile')) {
  runtimeCode = runtimeCode.replace(
    'selectExecutionProfile\n} from "./executor.js";',
    'selectExecutionProfile,\n  selectReviewProfile\n} from "./executor.js";'
  );
}
if (!runtimeCode.includes('configuredExecutors')) {
    runtimeCode = runtimeCode.replace(
    'selectExecutionProfile,\n  selectReviewProfile\n} from "./executor.js";',
    'selectExecutionProfile,\n  selectReviewProfile,\n  configuredExecutors\n} from "./executor.js";'
  );
}


fs.writeFileSync(runtimeFile, runtimeCode, 'utf8');

// Now patch dispatcher.js
const dispatcherFile = 'c:/Develop/houndvision/agent-scaffold/lib/dispatcher.js';
let dispatcherCode = fs.readFileSync(dispatcherFile, 'utf8');

dispatcherCode = dispatcherCode.replace(
  `switch (issue.canonicalState) {
      case "ready":
      case "rework":
      case "review":
        ordinaryPlans.push(currentPlans.get(issue.key));
        break;
      case "human_approval":
        // Human approval doesn't dispatch agents
        break;
      default:
        // Skip unknown/unhandled states
        break;
    }`,
  `switch (issue.canonicalState) {
      case "ready":
      case "rework":
        ordinaryPlans.push(currentPlans.get(issue.key));
        break;
      case "review": {
        const plan = currentPlans.get(issue.key);
        // Review run uses the reviewer agent, which might affect concurrency limits
        ordinaryPlans.push({
          ...plan,
          execution: { ...plan.execution, provider: "antigravity" }, // Defaulting for capacity tracking
          taskAgent: "correctness-reviewer"
        });
        break;
      }
      case "human_approval":
        // Push a minimal plan so runIssueImpl can run handleHumanApprovalObservation
        ordinaryPlans.push({
          ...currentPlans.get(issue.key),
          execution: null,
          eligible: true
        });
        break;
      default:
        break;
    }`
);

fs.writeFileSync(dispatcherFile, dispatcherCode, 'utf8');

console.log("Patched runtime.js and dispatcher.js");
