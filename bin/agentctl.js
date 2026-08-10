#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadSettings } from "../lib/config.js";
import { JiraClient } from "../lib/jira.js";
import { configuredExecutors } from "../lib/executor.js";
import { startDashboardServer } from "../lib/dashboard.js";
import { getStore, issuePlan, runIssue, runIssueLocal } from "../lib/runtime.js";
import { buildDispatchWaves, executeDispatchWaves } from "../lib/scheduler.js";

function usage() {
  console.error(
    "Usage: agentctl [--config file] doctor|dashboard|poll|dispatch|plan|run|local-run|runs|report|resume|unlock [args]"
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

function launchIssue(configPath, issueKey) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--config", configPath, "run", issueKey, "--execute"],
      { stdio: "inherit" }
    );
    child.once("error", (error) =>
      resolve({ exitCode: 1, error: error.message })
    );
    child.once("close", (code, signal) =>
      resolve({ exitCode: code ?? 1, signal: signal || null })
    );
  });
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
    const providerConcurrency = settings.data.policy.providerConcurrency || {};
    const label = settings.data.policy.requiredLabels[0];
    const issues = await jira.poll(settings.projectKey, label, limit);
    const lockedIssues = new Set(
      getStore(settings).listLocks().map((lock) => lock.issue_key)
    );
    const plans = issues.map((issue) => {
      const plan = issuePlan(settings, issue);
      if (!lockedIssues.has(issue.key)) return plan;
      return {
        ...plan,
        eligible: false,
        eligibilityReasons: [...plan.eligibilityReasons, "Issue is already locked"]
      };
    });
    const waves = buildDispatchWaves(plans, {
      maxConcurrency,
      providerConcurrency
    });
    if (!parsed.args.includes("--execute")) {
      console.log(JSON.stringify({ mode: "dry-run", maxConcurrency, waves }, null, 2));
      return 0;
    }
    const results = await executeDispatchWaves(waves, (plan) =>
      launchIssue(settings.source, plan.issue)
    );
    console.log(JSON.stringify({ mode: "execute", maxConcurrency, results }, null, 2));
    return results.some((wave) =>
      wave.executions.some((execution) => execution.exitCode !== 0)
    )
      ? 1
      : 0;
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
