#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

function normalized(value) {
  return path.resolve(value).replaceAll("\\", "/");
}

function unique(values) {
  return [...new Set(values)];
}

export function buildRestrictedSettings(current, { repo, worktreeRoot, scaffold }) {
  const repoPath = normalized(repo);
  const worktreePath = normalized(worktreeRoot);
  const scaffoldPath = normalized(scaffold);
  const permissions = current.permissions || {};
  return {
    ...current,
    toolPermission: "request-review",
    allowNonWorkspaceAccess: false,
    enableTerminalSandbox: true,
    permissions: {
      ...permissions,
      allow: unique([
        ...(permissions.allow || []),
        `read_file(${repoPath})`,
        `read_file(${worktreePath})`,
        `write_file(${worktreePath})`
      ]),
      deny: unique([
        ...(permissions.deny || []),
        `write_file(${repoPath})`,
        `write_file(${scaffoldPath})`,
        "command(git push)",
        "command(git merge)",
        "command(git reset)",
        "command(git clean)",
        "command(Remove-Item)",
        "command(del)"
      ])
    }
  };
}

export function configurePermissions(options) {
  for (const required of ["repo", "worktree-root", "scaffold"]) {
    if (!options[required]) throw new Error(`Missing --${required}`);
  }
  const settingsPath = path.resolve(
    options.settings ||
      path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json")
  );
  const current = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : {};
  const next = buildRestrictedSettings(current, {
    repo: options.repo,
    worktreeRoot: options["worktree-root"],
    scaffold: options.scaffold
  });
  if (options.dryRun) return { settingsPath, changed: true, next };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  let backupPath = null;
  if (fs.existsSync(settingsPath)) {
    backupPath = `${settingsPath}.backup-${new Date()
      .toISOString()
      .replaceAll(":", "-")}`;
    fs.copyFileSync(settingsPath, backupPath);
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { settingsPath, backupPath, changed: true };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = configurePermissions(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
