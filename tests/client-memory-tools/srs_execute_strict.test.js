#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(raw) {
  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return null;
  }
}

function main() {
  const run = spawnSync(process.execPath, ['tests/tooling/scripts/ci/srs_execute_strict.mjs', '--dry-run=1'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  if (run.status !== 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          type: 'srs_execute_strict_test',
          error: `dry_run_exit_${run.status}`,
          stdout: String(run.stdout || '').trim(),
          stderr: String(run.stderr || '').trim(),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const payload = parseJson(run.stdout);
  try {
    assert(payload && payload.ok === true, 'dry run payload not ok=true');
    assert(payload.type === 'srs_execute_strict', 'unexpected payload type');
    assert(payload.mode === 'dry_run', 'expected dry_run mode');
    assert(Array.isArray(payload.steps), 'steps missing');
    assert(payload.steps.length >= 6, 'expected planned strict steps');
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          type: 'srs_execute_strict_test',
          error: String(error && error.message ? error.message : error),
          payload,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        type: 'srs_execute_strict_test',
      },
      null,
      2,
    ),
  );
}

main();
