import test from "node:test";
import assert from "node:assert/strict";
import { buildRestrictedSettings } from "../scripts/configure-antigravity-permissions.js";

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
  assert.ok(
    settings.permissions.allow.includes(
      "write_file(C:/Develop/houndvision/agent-worktrees)"
    )
  );
  assert.ok(
    !settings.permissions.allow.includes(
      "write_file(C:/Develop/houndvision/houndvision)"
    )
  );
  assert.ok(
    settings.permissions.deny.includes(
      "write_file(C:/Develop/houndvision/houndvision)"
    )
  );
  assert.ok(settings.permissions.deny.includes("command(git push)"));
});
