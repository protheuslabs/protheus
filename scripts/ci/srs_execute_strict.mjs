#!/usr/bin/env node
/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve('.');
const OUT_JSON = resolve('core/local/artifacts/srs_execute_strict_current.json');
const OUT_MD = resolve('local/workspace/reports/SRS_EXECUTE_STRICT_CURRENT.md');
const MAP_JSON = resolve('core/local/artifacts/srs_actionable_map_current.json');
const QUEUE_JSON = resolve('client/local/state/ops/backlog_queue_executor/latest.json');
const FULL_JSON = resolve('core/local/artifacts/srs_full_regression_current.json');
const TOP200_JSON = resolve('core/local/artifacts/srs_top200_regression_2026-03-10.json');

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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runStep(name, cmd, args, opts = {}) {
  const out = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
  });
  const rec = {
    name,
    command: [cmd, ...args].join(' '),
    ok: out.status === 0,
    status: out.status ?? 1,
    stdout_tail: String(out.stdout || '').trim().slice(-2000),
    stderr_tail: String(out.stderr || '').trim().slice(-2000),
  };
  if (!rec.ok && !opts.allowFail) {
    throw new Error(`${name}_failed`);
  }
  return rec;
}

function writeArtifacts(payload) {
  const summary = payload.summary || {
    execute_now_before: null,
    queue_scanned: null,
    queue_executed: null,
    queue_failed: null,
    queue_skipped: null,
    queue_receipt_hash: null,
    full_regression_fail: null,
    top200_regression_fail: null,
    execute_now_after: null,
  };
  writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const lines = [];
  lines.push('# SRS Strict Execution');
  lines.push('');
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- ok: ${payload.ok}`);
  lines.push(`- execute_now_before: ${summary.execute_now_before}`);
  lines.push(`- queue_scanned: ${summary.queue_scanned}`);
  lines.push(`- queue_executed: ${summary.queue_executed}`);
  lines.push(`- queue_failed: ${summary.queue_failed}`);
  lines.push(`- queue_skipped: ${summary.queue_skipped}`);
  lines.push(`- queue_receipt_hash: ${summary.queue_receipt_hash}`);
  lines.push(`- full_regression_fail: ${summary.full_regression_fail}`);
  lines.push(`- top200_regression_fail: ${summary.top200_regression_fail}`);
  lines.push(`- execute_now_after: ${summary.execute_now_after}`);
  lines.push('');
  lines.push('## Steps');
  lines.push('| Step | OK | Status | Command |');
  lines.push('| --- | --- | --- | --- |');
  for (const step of payload.steps) {
    lines.push(`| ${step.name} | ${step.ok} | ${step.status} | \`${step.command}\` |`);
  }
  writeFileSync(OUT_MD, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv);
  const dryRun = String(args.get('dry-run') || '0') === '1';
  const steps = [];
  const generatedAt = new Date().toISOString();
  try {
    if (dryRun) {
      const payload = {
        ok: true,
        type: 'srs_execute_strict',
        mode: 'dry_run',
        generatedAt,
        steps: [
          { name: 'srs_actionable_map:pre', command: 'node scripts/ci/srs_actionable_map.mjs' },
          {
            name: 'backlog_queue_executor:run_all_with_tests',
            command:
              'cargo run -q -p protheus-ops-core --bin protheus-ops -- backlog-queue-executor run --all=1 --with-tests=1',
          },
          { name: 'srs_full_regression', command: 'node scripts/ci/srs_full_regression.mjs' },
          { name: 'srs_top200_regression', command: 'node scripts/ci/srs_top200_regression.mjs' },
          { name: 'srs_contract_runtime_evidence_test', command: 'npm run -s test:ops:srs-contract-runtime-evidence' },
          { name: 'verify', command: './verify.sh' },
          { name: 'srs_actionable_map:post', command: 'node scripts/ci/srs_actionable_map.mjs' },
        ],
      };
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    steps.push(runStep('srs_actionable_map:pre', 'node', ['scripts/ci/srs_actionable_map.mjs']));
    const preMap = readJson(MAP_JSON);
    const executeNowBefore = Number(preMap?.summary?.execute_now || 0);

    steps.push(
      runStep('backlog_queue_executor:run_all_with_tests', 'cargo', [
        'run',
        '-q',
        '-p',
        'protheus-ops-core',
        '--bin',
        'protheus-ops',
        '--',
        'backlog-queue-executor',
        'run',
        '--all=1',
        '--with-tests=1',
      ]),
    );
    const queue = readJson(QUEUE_JSON);
    const queueScanned = Number(queue?.counts?.scanned || 0);
    const queueExecuted = Number(queue?.counts?.executed || 0);
    const queueFailed = Number(queue?.counts?.failed || 0);
    const queueSkipped = Number(queue?.counts?.skipped || 0);
    const queueReceiptHash = String(queue?.receipt_hash || '');
    if (queueScanned !== queueExecuted + queueFailed + queueSkipped) {
      throw new Error(
        `queue_count_mismatch:scanned=${queueScanned}:executed=${queueExecuted}:failed=${queueFailed}:skipped=${queueSkipped}`,
      );
    }
    if (queueScanned < executeNowBefore) {
      throw new Error(`queue_under_scanned:${queueScanned}:${executeNowBefore}`);
    }
    if (queueFailed !== 0) {
      throw new Error(
        `queue_execution_failed:failed=${queueFailed}:scanned=${queueScanned}:executed=${queueExecuted}:skipped=${queueSkipped}`,
      );
    }

    steps.push(runStep('srs_full_regression', 'node', ['scripts/ci/srs_full_regression.mjs']));
    const full = readJson(FULL_JSON);
    const fullFail = Number(full?.summary?.regression?.fail || 0);
    if (fullFail !== 0) {
      throw new Error(`full_regression_fail:${fullFail}`);
    }

    steps.push(runStep('srs_top200_regression', 'node', ['scripts/ci/srs_top200_regression.mjs']));
    const top = readJson(TOP200_JSON);
    const topFail = Number(top?.summary?.regression?.fail || 0);
    if (topFail !== 0) {
      throw new Error(`top200_regression_fail:${topFail}`);
    }

    steps.push(
      runStep('srs_contract_runtime_evidence_test', 'npm', ['run', '-s', 'test:ops:srs-contract-runtime-evidence']),
    );
    steps.push(runStep('verify', './verify.sh', []));

    steps.push(runStep('srs_actionable_map:post', 'node', ['scripts/ci/srs_actionable_map.mjs']));
    const postMap = readJson(MAP_JSON);
    const executeNowAfter = Number(postMap?.summary?.execute_now || 0);

    const payload = {
      ok: true,
      type: 'srs_execute_strict',
      generatedAt,
      summary: {
        execute_now_before: executeNowBefore,
        queue_scanned: queueScanned,
        queue_executed: queueExecuted,
        queue_failed: queueFailed,
        queue_skipped: queueSkipped,
        queue_receipt_hash: queueReceiptHash,
        full_regression_fail: fullFail,
        top200_regression_fail: topFail,
        execute_now_after: executeNowAfter,
      },
      steps,
      artifacts: {
        actionable_map_json: 'core/local/artifacts/srs_actionable_map_current.json',
        queue_latest_json: 'client/local/state/ops/backlog_queue_executor/latest.json',
        full_regression_json: 'core/local/artifacts/srs_full_regression_current.json',
        top200_regression_json: 'core/local/artifacts/srs_top200_regression_2026-03-10.json',
      },
    };
    writeArtifacts(payload);
    console.log(JSON.stringify(payload, null, 2));
  } catch (error) {
    const payload = {
      ok: false,
      type: 'srs_execute_strict',
      generatedAt,
      error: String(error && error.message ? error.message : error),
      steps,
    };
    writeArtifacts(payload);
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
}

main();
