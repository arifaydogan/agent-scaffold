import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../lib/store.js";

test("issue locks are exclusive", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-store-"));
  const store = new RunStore(path.join(directory, "runs.sqlite3"));
  const first = store.createRun("PACE-1", {});
  const second = store.createRun("PACE-1", {});
  assert.equal(store.acquireLock("PACE-1", first), true);
  assert.equal(store.acquireLock("PACE-1", second), false);
});
