#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadSettings } from "../lib/config.js";
import { JiraClient } from "../lib/jira.js";
import { configuredExecutors } from "../lib/executor.js";
import { startDashboardServer } from "../lib/dashboard.js";
import { getStore, issuePlan, runIssue, runIssueLocal } from "../lib/runtime.js";
import { dispatchOnce } from "../lib/dispatcher.js";
import { runSupervisor } from "../lib/supervisor.js";
import { backfillExternalRun } from "../lib/external-run.js";

function usage() {
  console.error(
    "Usage: agentctl [--config file] doctor|dashboard|poll|dispatch|plan|run|local-run|runs|report|resume|unlock|supervise|supervisor-status|supervisor-stop|backfill-external-run [args]"
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

function numericArgument(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.command) {
    usage();
    return 1;
  }
  const settings = loadSettings(parsed.config);

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
        "safe.directory=*",
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
    const dashboard = await startDashboardServer(settings, { port, demo });
    console.log(
      `Agent Operations Console${demo ? " (demo)" : ""}: ${dashboard.url}`
    );
    await new Promise((resolve) => {
      const shutdown = () => {
        dashboard.server.close(resolve);
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
    // will throw before any Jira polling or dispatch. This check is enforced inside
    // runSupervisor; we surface it early for a clear CLI error message.
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

  // ── Jira-dependent commands ───────────────────────────────────────────────
  // JiraClient is instantiated here, AFTER all local-only commands have been
  // handled. Commands above this point do not require Jira credentials.
  const jira = new JiraClient(settings.data.jira);

  if (parsed.command === "poll") {
    const limit = numericArgument(parsed.args, "--limit", 10);
    const label = settings.data.policy.requiredLabels[0];
    const issues = await jira.poll(settings.projectKey, label, limit);
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
      jira
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
  const issue = await jira.getIssue(issueKey);
  if (parsed.command === "plan") {
    console.log(JSON.stringify(issuePlan(settings, issue), null, 2));
    return 0;
  }
  if (parsed.command === "run") {
    const result = await Promise.resolve(runIssue(settings, issue, parsed.args.includes("--execute")));
    console.log(JSON.stringify(result.output, null, 2));
    return result.exitCode;
  }
  usage();
  return 1;
}

process.exitCode = await main();
