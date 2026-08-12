/**
 * test/promotion-path.test.js
 *
 * Node built-in test suite for validate-promotion-path.js logic.
 * Dependency-free ESM. Run with: node --test test/promotion-path.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.resolve(__dirname, '../scripts/validate-promotion-path.js');

/**
 * Runs the validator script with given BASE_REF / HEAD_REF env vars.
 * Returns { exitCode, stderr, stdout }.
 */
function runValidator({ BASE_REF = '', HEAD_REF = '' } = {}) {
  const result = spawnSync(
    process.execPath,
    [VALIDATOR],
    {
      env: { ...process.env, BASE_REF, HEAD_REF },
      encoding: 'utf8',
    }
  );
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// Valid promotion paths
// ---------------------------------------------------------------------------

describe('valid promotions', () => {
  it('task branch -> epic branch is permitted', () => {
    const { exitCode, stdout } = runValidator({
      HEAD_REF: 'task/pace-359-epic-runtime',
      BASE_REF: 'epic/pace-124-agent-orchestration',
    });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.match(stdout, /OK/);
  });

  it('develop -> release is permitted', () => {
    const { exitCode, stdout } = runValidator({
      HEAD_REF: 'develop',
      BASE_REF: 'release',
    });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.match(stdout, /OK/);
  });

  it('release -> master is permitted', () => {
    const { exitCode, stdout } = runValidator({
      HEAD_REF: 'release',
      BASE_REF: 'master',
    });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.match(stdout, /OK/);
  });
});

// ---------------------------------------------------------------------------
// Invalid / bad promotion paths
// ---------------------------------------------------------------------------

describe('bad promotion paths', () => {
  it('feature branch -> release is rejected', () => {
    const { exitCode, stderr } = runValidator({
      HEAD_REF: 'feature/foo',
      BASE_REF: 'release',
    });
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}`);
    assert.match(stderr, /FAIL/);
    assert.match(stderr, /expected:.*"develop" -> "release"/);
    assert.match(stderr, /observed:.*"feature\/foo" -> "release"/);
  });

  it('feature branch -> master is rejected', () => {
    const { exitCode, stderr } = runValidator({
      HEAD_REF: 'feature/foo',
      BASE_REF: 'master',
    });
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}`);
    assert.match(stderr, /FAIL/);
    assert.match(stderr, /expected:.*"release" -> "master"/);
    assert.match(stderr, /observed:.*"feature\/foo" -> "master"/);
  });

  it('develop -> master skips release and is rejected', () => {
    const { exitCode, stderr } = runValidator({
      HEAD_REF: 'develop',
      BASE_REF: 'master',
    });
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}`);
    assert.match(stderr, /FAIL/);
    assert.match(stderr, /expected:.*"release" -> "master"/);
    assert.match(stderr, /observed:.*"develop" -> "master"/);
  });

  it('release -> develop is rejected (wrong direction)', () => {
    const { exitCode, stderr } = runValidator({
      HEAD_REF: 'release',
      BASE_REF: 'develop',
    });
    assert.equal(exitCode, 1, `only epic branches may target develop`);
  });

  it('unsupported base branch is rejected', () => {
    const { exitCode, stderr } = runValidator({
      HEAD_REF: 'develop',
      BASE_REF: 'hotfix',
    });
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}`);
    assert.match(stderr, /FAIL/);
    assert.match(stderr, /observed:.*"develop" -> "hotfix"/);
  });
});

// ---------------------------------------------------------------------------
// Missing refs
// ---------------------------------------------------------------------------

describe('missing refs', () => {
  it('missing BASE_REF fails with a clear message', () => {
    const { exitCode, stderr } = runValidator({
      HEAD_REF: 'develop',
      BASE_REF: '',
    });
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}`);
    assert.match(stderr, /missing.*BASE_REF/i);
    assert.match(stderr, /observed:/);
  });

  it('missing HEAD_REF fails with a clear message', () => {
    const { exitCode, stderr } = runValidator({
      HEAD_REF: '',
      BASE_REF: 'develop',
    });
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}`);
    assert.match(stderr, /missing.*HEAD_REF/i);
    assert.match(stderr, /observed:/);
  });

  it('both refs missing fails with a clear message', () => {
    const { exitCode, stderr } = runValidator({
      HEAD_REF: '',
      BASE_REF: '',
    });
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}`);
    assert.match(stderr, /missing/i);
  });
});

it('accepts story leaves and rejects bypassed targets', () => {
  assert.equal(runValidator({ HEAD_REF: 'story/pace-400-api', BASE_REF: 'epic/pace-124-agent-orchestration' }).exitCode, 0);
  assert.equal(runValidator({ HEAD_REF: 'epic/pace-124-agent-orchestration', BASE_REF: 'develop' }).exitCode, 0);
  assert.equal(runValidator({ HEAD_REF: 'task/pace-359-epic-runtime', BASE_REF: 'develop' }).exitCode, 1);
  assert.equal(runValidator({ HEAD_REF: 'epic/pace-124-agent-orchestration', BASE_REF: 'release' }).exitCode, 1);
});
