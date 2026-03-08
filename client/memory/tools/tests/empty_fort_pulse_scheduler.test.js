#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

(function main() {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-empty-fort-pulse-'));
  const policyPath = path.join(tmp, 'policy.json');
  const auditPath = path.join(tmp, 'audit.json');
  const pulseLogPath = path.join(tmp, 'pulse_log.md');
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1,
    service_account: 'svc-bot',
    max_prs_per_day: 2,
    allow_apply: true,
    labels: ['empty-fort-pulse', 'maintenance'],
    target_file: pulseLogPath
  }, null, 2));

  const run = (args, expectedStatus = 0) => {
    const out = spawnSync('node', [
      path.join(repoRoot, 'scripts/empty_fort_pulse_scheduler.js'),
      `--policy=${policyPath}`,
      `--audit=${auditPath}`,
      '--now=2026-03-08T10:00:00.000Z',
      ...args
    ], { cwd: repoRoot, encoding: 'utf8' });
    assert.strictEqual(out.status, expectedStatus, out.stderr || out.stdout);
    return out;
  };

  const dry = run(['--actor=someone'], 0);
  assert.ok(dry.stdout.includes('"ok": true'), 'dry run should succeed');

  const denied = run(['--apply=1', '--actor=someone'], 1);
  assert.ok(denied.stderr.includes('actor_not_service_account') || denied.stdout.includes('actor_not_service_account'), 'expected actor guard deny');

  run(['--apply=1', '--actor=svc-bot'], 0);
  run(['--apply=1', '--actor=svc-bot'], 0);
  const capped = run(['--apply=1', '--actor=svc-bot'], 1);
  assert.ok(capped.stderr.includes('daily_cap_reached') || capped.stdout.includes('daily_cap_reached'), 'expected cap guard deny');

  assert.ok(fs.existsSync(pulseLogPath), 'pulse log should exist after apply');
  const logBody = fs.readFileSync(pulseLogPath, 'utf8');
  assert.ok(logBody.includes('actor=svc-bot'), 'pulse log missing actor');

  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  assert.ok(Array.isArray(audit.history) && audit.history.length >= 3, 'audit should contain successful run history');
  console.log('ok empty_fort_pulse_scheduler');
})();
