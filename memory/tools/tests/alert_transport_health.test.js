#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'alert_transport_health.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function run(args, env) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '').trim());
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-transport-health-'));
  const policyPath = path.join(tmp, 'config', 'alert_transport_policy.json');
  const statePath = path.join(tmp, 'state', 'ops', 'alert_transport_health.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'alert_transport_health_history.jsonl');
  const emailOutboxPath = path.join(tmp, 'state', 'observability', 'alerts', 'email_fallback.jsonl');
  const localOutboxPath = path.join(tmp, 'state', 'observability', 'alerts', 'local_fallback.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    rolling_days: 30,
    target_success_rate: 0.99,
    dedupe_window_days: 30,
    state_path: statePath,
    history_path: historyPath,
    channels: {
      slack_webhook: {
        enabled: true,
        url: '',
        url_env: 'MISSING_WEBHOOK_ENV',
        timeout_ms: 1000
      },
      email_fallback: {
        enabled: true,
        outbox_path: emailOutboxPath
      },
      local_fallback: {
        enabled: true,
        outbox_path: localOutboxPath
      }
    }
  });

  const first = run(
    ['run', '--probe-id=2026-02-26T10', `--policy=${policyPath}`],
    { ALERT_TRANSPORT_FORCE_PRIMARY_OK: '1' }
  );
  assert.strictEqual(first.status, 0, `first probe failed: ${first.stderr || first.stdout}`);
  const firstPayload = parseJson(first.stdout);
  assert.strictEqual(firstPayload.delivered, true, 'first probe should deliver');
  assert.strictEqual(firstPayload.delivered_via, 'slack_webhook', 'first probe should use slack');

  const dedupe = run(
    ['run', '--probe-id=2026-02-26T10', `--policy=${policyPath}`],
    { ALERT_TRANSPORT_FORCE_PRIMARY_OK: '1' }
  );
  assert.strictEqual(dedupe.status, 0, `dedupe probe failed: ${dedupe.stderr || dedupe.stdout}`);
  const dedupePayload = parseJson(dedupe.stdout);
  assert.strictEqual(dedupePayload.deduped, true, 'second probe should dedupe');
  assert.strictEqual(dedupePayload.delivered_via, 'dedupe_cache', 'dedupe should report cache');

  writeJson(policyPath, {
    version: '1.0-test',
    rolling_days: 30,
    target_success_rate: 0.99,
    dedupe_window_days: 30,
    state_path: statePath,
    history_path: historyPath,
    channels: {
      slack_webhook: {
        enabled: true,
        url: '',
        url_env: 'MISSING_WEBHOOK_ENV',
        timeout_ms: 1000
      },
      email_fallback: {
        enabled: true,
        outbox_path: emailOutboxPath
      },
      local_fallback: {
        enabled: true,
        outbox_path: localOutboxPath
      }
    }
  });

  const fallback = run(['run', '--probe-id=2026-02-26T11', `--policy=${policyPath}`, '--strict=1'], {});
  assert.strictEqual(fallback.status, 0, `fallback probe failed: ${fallback.stderr || fallback.stdout}`);
  const fallbackPayload = parseJson(fallback.stdout);
  assert.strictEqual(fallbackPayload.delivered, true, 'fallback probe should deliver');
  assert.strictEqual(fallbackPayload.delivered_via, 'email_fallback', 'fallback probe should use email');

  const state = readJson(statePath);
  assert.strictEqual(state.schema_id, 'alert_transport_health', 'state schema mismatch');
  assert.strictEqual(state.pass, true, 'rolling pass should be true with all delivered');
  assert.ok(Number(state.rolling && state.rolling.success_rate || 0) >= 0.99, 'rolling success should meet target');

  const emailRows = readJsonl(emailOutboxPath);
  assert.ok(emailRows.length >= 1, 'email fallback outbox should have rows');
  const localRows = readJsonl(localOutboxPath);
  assert.strictEqual(localRows.length, 0, 'local fallback should not be used when email succeeds');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('alert_transport_health.test.js: OK');
}

main().catch((err) => {
  console.error(`alert_transport_health.test.js: FAIL: ${err.message}`);
  process.exit(1);
});
