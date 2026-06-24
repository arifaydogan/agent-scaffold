#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadSettings } from "../lib/config.js";
import { JiraClient } from "../lib/jira.js";
import { getStore, issuePlan, runIssue } from "../lib/runtime.js";

function usage() {
  console.error(
    "Usage: agentctl [--config file] doctor|poll|plan|run|report|resume [args]"
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

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.command) {
    usage();
    return 1;
  }
  const settings = loadSettings(parsed.config);
  if (parsed.command === "doctor") {
    const checks = {
      repoExists: fs.existsSync(settings.repoPath),
      git: commandAvailable("git"),
      codex: commandAvailable("codex"),
      manifest: fs.existsSync(
        path.join(path.dirname(settings.source), "scaffold-manifest.json")
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
      ])
        .status === 0;
    console.log(JSON.stringify(checks, null, 2));
    return Object.values(checks).every(Boolean) ? 0 : 1;
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
  const jira = new JiraClient(settings.data.jira);
  if (parsed.command === "poll") {
    const limitIndex = parsed.args.indexOf("--limit");
    const limit = limitIndex >= 0 ? Number(parsed.args[limitIndex + 1]) : 10;
    const label = settings.data.policy.requiredLabels[0];
    const issues = await jira.poll(settings.projectKey, label, limit);
    console.log(JSON.stringify(issues.map((issue) => issuePlan(settings, issue)), null, 2));
    return 0;
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
    const result = runIssue(settings, issue, parsed.args.includes("--execute"));
    console.log(JSON.stringify(result.output, null, 2));
    return result.exitCode;
  }
  usage();
  return 1;
}

process.exitCode = await main();
