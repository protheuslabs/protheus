#!/usr/bin/env node
/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function parseArgs(argv) {
  const out = new Map();
  for (const token of argv.slice(2)) {
    if (!token.startsWith('--')) continue;
    const idx = token.indexOf('=');
    if (idx === -1) {
      out.set(token.slice(2), '1');
    } else {
      out.set(token.slice(2, idx), token.slice(idx + 1));
    }
  }
  return out;
}

function normalizeId(raw) {
  return String(raw || '').trim().toUpperCase();
}

function isValidId(id) {
  return /^V[0-9A-Z._-]+$/.test(id);
}

function fail(message, extra = {}) {
  const payload = {
    ok: false,
    type: 'srs_repair_lane_runner',
    error: message,
    ...extra,
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv);
  const id = normalizeId(args.get('id'));
  if (!id || !isValidId(id)) {
    fail('invalid_or_missing_id', { received: String(args.get('id') || '') });
  }

  const strict = String(args.get('strict') || '1') === '0' ? '0' : '1';
  const dryRun = String(args.get('dry-run') || '0') === '1';

  const contractPath = resolve(`planes/contracts/srs/${id}.json`);
  if (!existsSync(contractPath)) {
    fail('missing_contract', { id, contractPath });
  }

  const receiptPath = resolve(`local/state/ops/srs_contract_runtime/${id}/latest.json`);
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          type: 'srs_repair_lane_runner',
          mode: 'dry_run',
          id,
          strict: strict === '1',
          contractPath,
          receiptPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  const cmd = [
    'run',
    '-q',
    '-p',
    'protheus-ops-core',
    '--bin',
    'protheus-ops',
    '--',
    'srs-contract-runtime',
    'run',
    `--id=${id}`,
    `--strict=${strict}`,
  ];
  const child = spawnSync('cargo', cmd, {
    cwd: resolve('.'),
    stdio: 'inherit',
    env: process.env,
  });
  if (child.status !== 0) {
    fail('cargo_run_failed', { id, exitCode: child.status ?? 1 });
  }

  if (!existsSync(receiptPath)) {
    fail('missing_receipt_after_run', { id, receiptPath });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        type: 'srs_repair_lane_runner',
        mode: 'run',
        id,
        strict: strict === '1',
        contractPath,
        receiptPath,
      },
      null,
      2,
    ),
  );
}

main();
