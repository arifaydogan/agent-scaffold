#!/usr/bin/env node
/**
 * validate-promotion-path.js
 *
 * Enforces the linear branch promotion policy:
 *   any branch  --> develop  (open)
 *   develop     --> release  (restricted)
 *   release     --> master   (restricted)
 *
 * Reads ONLY from environment variables set by the CI job:
 *   BASE_REF  – the PR target branch (github.base_ref)
 *   HEAD_REF  – the PR source branch (github.head_ref)
 *
 * Exit 0 = valid promotion, exit 1 = invalid / missing refs.
 */

const base = process.env.BASE_REF ?? '';
const head = process.env.HEAD_REF ?? '';

if (!base || !head) {
  const missing = [!base && 'BASE_REF', !head && 'HEAD_REF']
    .filter(Boolean)
    .join(', ');
  console.error(`[promotion-path] FAIL: missing environment variable(s): ${missing}`);
  console.error(`[promotion-path] expected: HEAD_REF -> BASE_REF (both must be non-empty)`);
  console.error(`[promotion-path] observed: "${head}" -> "${base}"`);
  process.exit(1);
}

/**
 * Returns true when the promotion is permitted.
 * @param {string} head - source branch name
 * @param {string} base - target branch name
 * @returns {boolean}
 */
function isValidPromotion(head, base) {
  switch (base) {
    case 'develop':
      // Any non-empty head may target develop
      return head.length > 0;
    case 'release':
      return head === 'develop';
    case 'master':
      return head === 'release';
    default:
      return false;
  }
}

if (isValidPromotion(head, base)) {
  console.log(`[promotion-path] OK: "${head}" -> "${base}"`);
  process.exit(0);
} else {
  const hint =
    base === 'release' ? 'develop'
    : base === 'master' ? 'release'
    : `any non-empty branch`;

  console.error(`[promotion-path] FAIL: "${head}" -> "${base}" is not a permitted promotion path`);
  console.error(`[promotion-path] expected: "${hint}" -> "${base}"`);
  console.error(`[promotion-path] observed: "${head}" -> "${base}"`);
  process.exit(1);
}
