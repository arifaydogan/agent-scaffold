import test from "node:test";
import assert from "node:assert/strict";
import { buildRestrictedSettings } from "../scripts/configure-antigravity-permissions.js";
import path from "node:path";

function normalizePath(value) {
  return path.resolve(value).replaceAll("\\", "/");
}

test("restricted Antigravity settings only grant writes to worktree root", () => {
  const settings = buildRestrictedSettings(
    { colorScheme: "dark" },
    {
      repo: "C:/Develop/houndvision/houndvision",
      worktreeRoot: "C:/Develop/houndvision/agent-worktrees",
      scaffold: "C:/Develop/houndvision/agent-scaffold"
    }
  );
  assert.equal(settings.colorScheme, "dark");
  assert.equal(settings.allowNonWorkspaceAccess, false);

  const worktreeRootPath = normalizePath("C:/Develop/houndvision/agent-worktrees");
  const repoPath = normalizePath("C:/Develop/houndvision/houndvision");

  assert.ok(
    settings.permissions.allow.includes(
      `write_file(${worktreeRootPath})`
    )
  );
  assert.ok(
    !settings.permissions.allow.includes(
      `write_file(${repoPath})`
    )
  );
  assert.ok(
    settings.permissions.deny.includes(
      `write_file(${repoPath})`
    )
  );
  assert.ok(settings.permissions.deny.includes("command(git push)"));
});
