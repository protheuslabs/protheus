#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return null;
  }
}

function main() {
  const failures = [];

  try {
    const okRun = runNode(['tests/tooling/scripts/ci/srs_repair_lane_runner.mjs', '--id=V6-SOVEREIGN-002.1', '--dry-run=1']);
    assert(okRun.status === 0, `dry-run expected exit 0, got ${okRun.status}`);
    const okPayload = parseJson(okRun.stdout);
    assert(okPayload && okPayload.ok === true, 'dry-run payload not ok=true');
    assert(okPayload.type === 'srs_repair_lane_runner', 'unexpected payload type');
    assert(okPayload.mode === 'dry_run', 'dry-run payload missing mode');
    assert(okPayload.id === 'V6-SOVEREIGN-002.1', 'dry-run payload id mismatch');
  } catch (error) {
    failures.push({ case: 'dry-run', error: String(error && error.message ? error.message : error) });
  }

  try {
    const badRun = runNode(['tests/tooling/scripts/ci/srs_repair_lane_runner.mjs', '--id=bad-id', '--dry-run=1']);
    assert(badRun.status === 1, `invalid-id expected exit 1, got ${badRun.status}`);
    const badPayload = parseJson(badRun.stderr);
    assert(badPayload && badPayload.ok === false, 'invalid-id payload should be ok=false');
    assert(badPayload.error === 'invalid_or_missing_id', 'invalid-id error mismatch');
  } catch (error) {
    failures.push({ case: 'invalid-id', error: String(error && error.message ? error.message : error) });
  }

  if (failures.length > 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          type: 'srs_repair_lane_runner_test',
          failures,
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
        type: 'srs_repair_lane_runner_test',
      },
      null,
      2,
    ),
  );
}

main();
