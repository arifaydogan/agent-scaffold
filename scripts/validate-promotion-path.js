#!/usr/bin/env node
/**
 * Enforces PaceBuild hierarchical delivery:
 *   task/* or story/* -> epic/*
 *   epic/*            -> develop
 *   develop           -> release
 *   release           -> master
 *
 * The script only validates a pull-request path. It never merges or mutates.
 */
const base = process.env.BASE_REF ?? "";
const head = process.env.HEAD_REF ?? "";

if (!base || !head) {
  const missing = [!base && "BASE_REF", !head && "HEAD_REF"].filter(Boolean).join(", ");
  console.error(`[promotion-path] FAIL: missing environment variable(s): ${missing}`);
  console.error(`[promotion-path] observed: "${head}" -> "${base}"`);
  process.exit(1);
}

function isEpic(value) {
  return value.startsWith("epic/");
}
function isLeaf(value) {
  return value.startsWith("task/") || value.startsWith("story/");
}

function isValidPromotion(headRef, baseRef) {
  if (isEpic(baseRef)) return isLeaf(headRef);
  if (baseRef === "develop") return isEpic(headRef);
  if (baseRef === "release") return headRef === "develop";
  if (baseRef === "master") return headRef === "release";
  return false;
}

if (isValidPromotion(head, base)) {
  console.log(`[promotion-path] OK: "${head}" -> "${base}"`);
  process.exit(0);
}

const expected = isEpic(base) ? "task/* or story/*"
  : base === "develop" ? "epic/*"
  : base === "release" ? "develop"
  : base === "master" ? "release"
  : "a configured epic/*, develop, release, or master base";

console.error(`[promotion-path] FAIL: "${head}" -> "${base}" is not a permitted promotion path`);
console.error(`[promotion-path] expected: "${expected}" -> "${base}"`);
console.error(`[promotion-path] observed: "${head}" -> "${base}"`);
process.exit(1);
