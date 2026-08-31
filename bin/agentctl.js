#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { loadSettings } from "../lib/config.js";
import { createWorkSourceProvider } from "../lib/work-source.js";
import { configuredExecutors } from "../lib/executor.js";
import { startDashboardServer } from "../lib/dashboard.js";
import { getStore, issuePlan, runIssue, runIssueLocal, runIssueWithPlan } from "../lib/runtime.js";
import { dispatchOnce } from "../lib/dispatcher.js";
import { runSupervisor } from "../lib/supervisor.js";
import { reconcileWorkers, recordReviewerOutcome, tick } from "../lib/reconciler.js";
import { backfillExternalRun, requestExternalRetry } from "../lib/external-run.js";
import { computePlanFingerprint } from "../lib/policy.js";
import {
  listProjectBaseRefs,
  resolveProjectProfile,
  settingsForProjectProfile
} from "../lib/project-profiles.js";

function usage() {
  console.error(
    "Usage: agentctl [--config file] doctor|dashboard|poll|dispatch|plan|run|local-run|runs|report|resume|unlock|supervise|supervisor-status|supervisor-stop|tick|review-result|backfill-external-run [args]"
  );
}

function parseArguments(argv) {
  const args = [...argv];
  let config = "agent-scaffold.json";
  const configIndex = args.indexOf("--config");
  if (configIndex >= 0) {
    config = args[configIndex + 1];
    args.splice(configIndex, 2);
  }
  return { config, command: args.shift(), args };
}

function commandAvailable(command) {
  const check = process.platform === "win32" ? "where" : "which";
  return spawnSync(check, [command], { stdio: "ignore" }).status === 0;
}

function stringArgument(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] || null;
}

function numericArgument(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const DASHBOARD_ACTIVE_RUN_STATES = new Set([
  "claimed", "prepared", "queued", "started", "model_selected", "progress", "executing"
]);

function spawnDashboardRun(settings, {
  issueKey,
  planFingerprint,
  operatorRequestId = null,
  projectProfileId = null,
  baseRef = null
}) {
  if (!planFingerprint) throw new Error("A verified plan fingerprint is required");
  const args = [
    fileURLToPath(import.meta.url),
    "--config",
    settings.source,
    "run",
    issueKey,
    "--execute",
    "--expected-plan-fingerprint",
    planFingerprint
  ];
  if (projectProfileId) args.push("--project-profile", projectProfileId);
  if (baseRef) args.push("--base-ref", baseRef);
  if (operatorRequestId) args.push("--operator-request-id", operatorRequestId);
  const child = spawn(process.execPath, args, {
    cwd: path.dirname(settings.source),
    env: process.env,
    stdio: "ignore",
    // Keep the worker alive when the dashboard terminal/server is restarted.
    // The durable run/lease and explicit stop endpoint remain authoritative.
    detached: true,
    windowsHide: true
  });
  if (!Number.isInteger(child.pid) || child.pid < 1) throw new Error("Agent runner could not be started");
  child.unref();

  const store = getStore(settings);
  try {
    store.addPmDecision(issueKey, "dashboard_execution_started", {
      planFingerprint,
      operatorRequestId,
      runnerPid: child.pid
    });
  } finally {
    store.database.close();
  }
  return { accepted: true, pid: child.pid };
}

function stopDashboardRun(settings, { runId }) {
  const store = getStore(settings);
  try {
    let run = store.getRun(String(runId || ""));
    if (!DASHBOARD_ACTIVE_RUN_STATES.has(run.state)) throw new Error("Run is not active");

    // A dashboard may be restarted long after its worker disappeared. Recover
    // only lease-expired workers through the durable reconciler; this avoids
    // trusting a missing/reused PID and releases the matching issue lock.
    const recovery = reconcileWorkers(settings, store);
    if (recovery.recovered.includes(run.id)) {
      store.addPmDecision(run.issue_key, "stale_worker_recovered", {
        runId: run.id,
        previousState: run.state
      });
      return { accepted: true, runId: run.id, pid: null, recovered: true };
    }
    run = store.getRun(run.id);
    const eventPid = [...run.events].reverse()
      .map(event => Number(event.payload?.pid))
      .find(pid => Number.isInteger(pid) && pid > 0);
    const dispatch = store.listPmDecisions(400).find(decision =>
      decision.issueKey === run.issue_key &&
      decision.type === "dashboard_execution_started" &&
      decision.payload?.planFingerprint === run.payload?.planFingerprint
    );
    const pid = eventPid || Number(dispatch?.payload?.runnerPid);
    if (!Number.isInteger(pid) || pid < 1) throw new Error("Active worker PID is unavailable");

    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      if (result.status !== 0) throw new Error("Worker process tree could not be stopped");
    } else {
      process.kill(pid, "SIGTERM");
    }
    store.addPmDecision(run.issue_key, "operator_stop_requested", { runId: run.id, pid });
    return { accepted: true, runId: run.id, pid };
  } finally {
    store.database.close();
  }
}
async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.command) {
    usage();
    return 1;
  }
  const settings = loadSettings(parsed.config);

  const agentOverride = stringArgument(parsed.args, "--agent");
  if (agentOverride && settings.data.executor) {
    settings.data.executor.overrideProvider = agentOverride;
  }

  // ── Local-only commands: do NOT require Jira credentials ──────────────────
  if (parsed.command === "doctor") {
    const executorCommands = Object.fromEntries(
      Object.entries(configuredExecutors(settings)).map(([name, config]) => [
        name,
        commandAvailable(config.command[0])
      ])
    );
    const checks = {
      repoExists: fs.existsSync(settings.repoPath),
      git: commandAvailable("git"),
      executorCommands,
      manifest: fs.existsSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "..",
          "scaffold-manifest.json"
        )
      )
    };
    checks.gitRepo =
      checks.git &&
      spawnSync("git", [
        "-c",
        `safe.directory=${settings.repoPath}`,
        "-C",
        settings.repoPath,
        "rev-parse",
        "--is-inside-work-tree"
      ]).status === 0;
    console.log(JSON.stringify(checks, null, 2));
    return checks.repoExists &&
      checks.git &&
      checks.gitRepo &&
      checks.manifest &&
      Object.values(executorCommands).every(Boolean)
      ? 0
      : 1;
  }

  if (parsed.command === "dashboard") {
    const port = numericArgument(parsed.args, "--port", 4317);
    const demo = parsed.args.includes("--demo");
    if (!demo) {
      const store = getStore(settings);
      try {
        reconcileWorkers(settings, store);
      } finally {
        store.database.close();
      }
    }
    const dashboard = await startDashboardServer(settings, {
      port,
      demo,
      retryHandler: demo ? undefined : (request) => requestExternalRetry(settings, request),
      startHandler: demo ? undefined : request => spawnDashboardRun(settings, request),
      operatorResponseHandler: demo ? undefined : ({ request }) => spawnDashboardRun(settings, {
        issueKey: request.issueKey,
        planFingerprint: request.planFingerprint,
        operatorRequestId: request.requestId
      }),
      stopHandler: demo ? undefined : request => stopDashboardRun(settings, request)
    });
    console.log(
      `Agent Scaffold Control Plane${demo ? " (demo)" : ""}: ${dashboard.url}`
    );
    await new Promise((resolve) => {
      const shutdown = () => {
        dashboard.server.close(resolve);
        dashboard.server.closeAllConnections?.();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    return 0;
  }

  if (parsed.command === "runs") {
    const limit = numericArgument(parsed.args, "--limit", 20);
    const store = getStore(settings);
    console.log(
      JSON.stringify({ runs: store.listRuns(limit), locks: store.listLocks() }, null, 2)
    );
    return 0;
  }

  if (parsed.command === "unlock") {
    const runId = parsed.args[0];
    if (!runId) {
      usage();
      return 1;
    }
    const store = getStore(settings);
    const run = store.getRun(runId);
    const released = store.releaseLock(run.issue_key, run.id);
    console.log(
      JSON.stringify(
        { runId, issue: run.issue_key, released, previousState: run.state },
        null,
        2
      )
    );
    return released ? 0 : 1;
  }

  if (parsed.command === "tick") {
    const store = getStore(settings);
    const result = tick(settings, store);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (parsed.command === "review-result") {
    const runId = parsed.args[0];
    const implementationSha = stringArgument(parsed.args, "--sha");
    const reviewerId = stringArgument(parsed.args, "--reviewer");
    const verdict = stringArgument(parsed.args, "--verdict");
    const evidence = stringArgument(parsed.args, "--evidence");
    if (!runId || !implementationSha || !reviewerId || !verdict || !evidence) {
      console.error(
        "review-result requires <run-id> --sha <sha> --reviewer <id> " +
        "--verdict <clean|changes-requested> --evidence <text>"
      );
      return 1;
    }
    const result = recordReviewerOutcome(getStore(settings), {
      runId,
      implementationSha,
      reviewerId,
      verdict,
      evidence: [evidence]
    });
    console.log(JSON.stringify(result, null, 2));
    return result.recorded ? 0 : 1;
  }

  if (parsed.command === "report" || parsed.command === "resume") {
    const run = getStore(settings).getRun(parsed.args[0]);
    console.log(
      JSON.stringify(
        parsed.command === "resume" ? { resumeRequired: true, run } : run,
        null,
        2
      )
    );
    return 0;
  }

  /**
   * supervisor-status: show persisted supervisor state. Local-only; no Jira.
   */
  if (parsed.command === "supervisor-status") {
    const store = getStore(settings);
    const supervisors = store.listSupervisors();
    const events = store.listSupervisorEvents(20);
    console.log(JSON.stringify({ supervisors, events }, null, 2));
    return 0;
  }

  /**
   * supervisor-stop: request graceful stop. Local-only; no Jira.
   */
  if (parsed.command === "supervisor-stop") {
    const supervisorId = settings.projectKey;
    const store = getStore(settings);
    const existing = store.getSupervisor(supervisorId);
    if (!existing) {
      console.error(`No supervisor record found for id "${supervisorId}".`);
      return 1;
    }
    if (existing.status !== "running") {
      console.log(
        JSON.stringify({ supervisorId, alreadyStopped: true, status: existing.status }, null, 2)
      );
      return 0;
    }
    store.requestSupervisorStop(supervisorId);
    console.log(
      JSON.stringify({ supervisorId, stopRequested: true }, null, 2)
    );
    return 0;
  }

  /**
   * backfill-external-run: Backfill an external run.
   */
  if (parsed.command === "backfill-external-run") {
    const issueKey = parsed.args[parsed.args.indexOf("--issue") + 1];
    const pid = numericArgument(parsed.args, "--pid", null);
    const provider = parsed.args[parsed.args.indexOf("--provider") + 1];
    const model = parsed.args[parsed.args.indexOf("--model") + 1];
    const branch = parsed.args[parsed.args.indexOf("--branch") + 1];
    const blocker = parsed.args.includes("--blocker") ? parsed.args[parsed.args.indexOf("--blocker") + 1] : null;

    if (!issueKey || !provider || !model || !branch) {
      console.error("Missing required arguments for backfill-external-run.");
      return 1;
    }

    const runId = backfillExternalRun(settings, { issueKey, pid, provider, model, branch, blocker });
    console.log(JSON.stringify({ runId, backfilled: true }, null, 2));
    return 0;
  }

  /**
   * local-run: execute a pre-resolved issue packet from a JSON file or stdin.
   * This path never requires Jira credentials.
   *
   * Usage:
   *   agentctl local-run --issue-file packet.json [--execute]
   *   echo '{"key":"PACE-1",...}' | agentctl local-run --stdin [--execute]
   */
  if (parsed.command === "local-run") {
    let issuePacket;
    const fileArg = parsed.args.indexOf("--issue-file");
    const useStdin = parsed.args.includes("--stdin");
    if (fileArg >= 0) {
      issuePacket = JSON.parse(fs.readFileSync(parsed.args[fileArg + 1], "utf8"));
    } else if (useStdin) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      issuePacket = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } else {
      console.error("local-run requires --issue-file <path> or --stdin");
      return 1;
    }
    const execute = parsed.args.includes("--execute");
    const result = await Promise.resolve(runIssueLocal(settings, issuePacket, execute));
    console.log(JSON.stringify(result.output, null, 2));
    return result.exitCode;
  }

  /**
   * supervise: start the resident supervisor loop.
   *
   * Options:
   *   --limit N        max issues to poll per cycle (default: supervisor.issueLimit)
   *   --concurrency N  max concurrent dispatches (default: policy.maxConcurrency)
   *   --once           run exactly one cycle and stop
   *   --max-cycles N   stop after N cycles
   *   --execute        enable execute mode (requires supervisor.executeEnabled = true in config)
   *
   * Default is plan-only (dry-run) mode. SIGINT/SIGTERM requests a graceful stop.
   * Merge, Done transitions, and external writes remain human-only.
   */
  if (parsed.command === "supervise") {
    const execute = parsed.args.includes("--execute");
    const once = parsed.args.includes("--once");
    const maxCycles = numericArgument(parsed.args, "--max-cycles", once ? 1 : undefined);
    const limit = numericArgument(parsed.args, "--limit", undefined);
    const maxConcurrency = numericArgument(parsed.args, "--concurrency", undefined);

    // --execute is fail-closed: if config doesn't have executeEnabled=true, supervisor
    // will throw before any work-source polling or dispatch. This check is enforced
    // inside runSupervisor; we surface it early for a clear CLI error message.
    if (execute && !settings.data.supervisor.executeEnabled) {
      console.error(
        "Error: --execute requires supervisor.executeEnabled = true in config. " +
        "Set it explicitly to opt in."
      );
      return 1;
    }

    const ac = new AbortController();
    let gracefulStopRequested = false;

    const gracefulStop = () => {
      if (gracefulStopRequested) return;
      gracefulStopRequested = true;
      console.error("Graceful stop requested. Waiting for in-flight cycle...");
      // Write stop request to DB so supervisor loop detects it even if this
      // process exits before the current cycle finishes.
      try {
        getStore(settings).requestSupervisorStop(settings.projectKey);
      } catch {
        // Non-fatal: AC signal is the primary stop mechanism.
      }
      ac.abort();
    };

    process.once("SIGINT", gracefulStop);
    process.once("SIGTERM", gracefulStop);

    try {
      await runSupervisor(settings, {
        execute,
        once,
        ...(maxCycles !== undefined ? { maxCycles } : {}),
        ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
        ...(limit !== undefined ? { issueLimit: limit } : {}),
        signal: ac.signal
      });
    } catch (err) {
      console.error(`Supervisor terminated with error: ${err.message}`);
      return 1;
    } finally {
      process.off("SIGINT", gracefulStop);
      process.off("SIGTERM", gracefulStop);
    }
    return 0;
  }

  // ── Work-source-dependent commands ───────────────────────────────────────────────
  // The selected WorkSourceProvider is instantiated after local-only commands
  // have been handled. Commands above this point need no provider credentials.
  const workSource = createWorkSourceProvider(settings);

  if (parsed.command === "poll") {
    const limit = numericArgument(parsed.args, "--limit", 10);
    const label = settings.data.policy.requiredLabels[0];
    const issues = await workSource.poll({
      projectKey: settings.projectKey,
      requiredLabels: [label],
      limit
    });
    console.log(JSON.stringify(issues.map((issue) => issuePlan(settings, issue)), null, 2));
    return 0;
  }

  if (parsed.command === "dispatch") {
    const limit = numericArgument(parsed.args, "--limit", 10);
    const configuredMaximum = settings.data.policy.maxConcurrency || 2;
    const requestedConcurrency = numericArgument(
      parsed.args,
      "--concurrency",
      configuredMaximum
    );
    const maxConcurrency = Math.min(requestedConcurrency, configuredMaximum);
    const execute = parsed.args.includes("--execute");

    const result = await dispatchOnce(settings, {
      execute,
      limit,
      maxConcurrency,
      workSource
    });

    if (!execute) {
      console.log(
        JSON.stringify(
          { mode: "dry-run", maxConcurrency: result.maxConcurrency, waves: result.waves },
          null,
          2
        )
      );
      return 0;
    }

    console.log(
      JSON.stringify(
        { mode: "execute", maxConcurrency: result.maxConcurrency, results: result.results },
        null,
        2
      )
    );
    return result.failed > 0 ? 1 : 0;
  }

  const issueKey = parsed.args[0];
  if (!issueKey) {
    usage();
    return 1;
  }
  const issue = await workSource.getWorkItem(issueKey);
  const requestedProfileId = stringArgument(parsed.args, "--project-profile");
  const requestedBaseRef = stringArgument(parsed.args, "--base-ref");
  const issueStore = getStore(settings);
  const savedProjectProfileId = key => [...(issueStore.getPmDecisions?.(key) || [])]
    .reverse()
    .find(decision => decision.type === "project_profile_selected")
    ?.payload?.projectProfileId || null;
  const savedBaseRef = (key, projectProfileId) => [...(issueStore.getPmDecisions?.(key) || [])]
    .reverse()
    .find(decision =>
      decision.type === "base_ref_selected" &&
      decision.payload?.projectProfileId === projectProfileId
    )?.payload?.baseRef || null;
  const parentIssue = issue?.parentKey && typeof workSource.getWorkItem === "function"
    ? await workSource.getWorkItem(issue.parentKey)
    : null;
  const projectResolution = resolveProjectProfile(settings, issue, {
    requestedProfileId,
    savedProfileId: savedProjectProfileId(issueKey),
    parentIssue,
    savedParentProfileId: issue?.parentKey ? savedProjectProfileId(issue.parentKey) : null
  });
  if (projectResolution.status !== "resolved") {
    console.error(JSON.stringify({
      error: "Project selection is required before planning",
      code: "project_selection_required",
      projectResolution
    }, null, 2));
    return 2;
  }
  const issueSettings = settingsForProjectProfile(
    { ...settings, _store: issueStore },
    projectResolution.profile.id
  );
  const availableBaseRefs = listProjectBaseRefs(issueSettings);
  const baseRefOverride = requestedBaseRef
    || savedBaseRef(issueKey, projectResolution.profile.id)
    || null;
  if (baseRefOverride && !availableBaseRefs.some(candidate => candidate.ref === baseRefOverride)) {
    console.error(JSON.stringify({
      error: "Selected Git base ref does not exist in the chosen repository",
      code: "base_ref_selection_required",
      availableBaseRefs
    }, null, 2));
    return 2;
  }
  const planningIssue = baseRefOverride ? { ...issue, baseRef: baseRefOverride } : issue;
  const attachProjectProfile = planned => ({
    ...planned,
    projectProfileId: projectResolution.profile.id,
    projectProfile: projectResolution.profile,
    projectResolutionSource: projectResolution.source,
    baseRefOverride,
    availableBaseRefs
  });
  if (parsed.command === "plan") {
    const planned = attachProjectProfile(issuePlan(issueSettings, planningIssue));
    console.log(JSON.stringify({
      ...planned,
      planFingerprint: computePlanFingerprint(planned)
    }, null, 2));
    return 0;
  }
  if (parsed.command === "run") {
    const planned = attachProjectProfile(issuePlan(issueSettings, planningIssue));
    const planFingerprint = computePlanFingerprint(planned);
    const expectedPlanFingerprint = stringArgument(parsed.args, "--expected-plan-fingerprint");
    if (expectedPlanFingerprint && expectedPlanFingerprint !== planFingerprint) {
      console.error(JSON.stringify({
        error: "Plan fingerprint changed; execution was not started",
        expected: expectedPlanFingerprint,
        actual: planFingerprint
      }));
      return 2;
    }
    const operatorRequestId = stringArgument(parsed.args, "--operator-request-id");
    const result = await Promise.resolve(runIssueWithPlan(
      issueSettings,
      planningIssue,
      { ...planned, planFingerprint },
      parsed.args.includes("--execute"),
      undefined,
      operatorRequestId ? { operatorRequestId } : {}
    ));
    console.log(JSON.stringify(result.output, null, 2));
    return result.exitCode;
  }
  usage();
  return 1;
}

process.exitCode = await main();
