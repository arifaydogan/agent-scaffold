#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      values.dryRun = true;
      continue;
    }
    if (!argument.startsWith("--") || !argv[index + 1]) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    values[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return values;
}

export function installAgents({ source, target, dryRun = false }) {
  const sourceRoot = path.resolve(source);
  const targetRoot = path.resolve(
    target || path.join(os.homedir(), ".gemini", "config", "agents")
  );
  const installed = [];
  const backups = [];
  const timestamp = new Date().toISOString().replaceAll(":", "-");

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceFile = path.join(sourceRoot, entry.name, "agent.md");
    if (!fs.existsSync(sourceFile)) continue;
    const targetDirectory = path.join(targetRoot, entry.name);
    const targetFile = path.join(targetDirectory, "agent.md");
    const next = fs.readFileSync(sourceFile, "utf8");
    const current = fs.existsSync(targetFile)
      ? fs.readFileSync(targetFile, "utf8")
      : null;
    if (current === next) {
      installed.push({ name: entry.name, status: "unchanged", targetFile });
      continue;
    }
    if (!dryRun) {
      fs.mkdirSync(targetDirectory, { recursive: true });
      if (current !== null) {
        const backupFile = `${targetFile}.backup-${timestamp}`;
        fs.copyFileSync(targetFile, backupFile);
        backups.push(backupFile);
      }
      fs.writeFileSync(targetFile, next, "utf8");
    }
    installed.push({
      name: entry.name,
      status: current === null ? "created" : "updated",
      targetFile
    });
  }
  return { sourceRoot, targetRoot, dryRun, installed, backups };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const source =
    options.source ||
    path.resolve("adapters", "antigravity", "agents");
  console.log(
    JSON.stringify(
      installAgents({ source, target: options.target, dryRun: options.dryRun }),
      null,
      2
    )
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
