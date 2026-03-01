#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'benchmark_autonomy_gate.js');

function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: Number.isFinite(r.status) ? r.status : 1, payload, stderr: String(r.stderr || '') };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-auto-gate-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateRoot = path.join(tmp, 'state');
  const benchPath = path.join(stateRoot, 'bench.jsonl');

  fs.mkdirSync(stateRoot, { recursive: true });
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    const result = { quality_score: 0.95, i };
    const signature = require('crypto').createHash('sha256').update(JSON.stringify(result), 'utf8').digest('hex').slice(0, 16);
    rows.push({ ts: new Date(Date.now() - i * 3600 * 1000).toISOString(), quality_score: 0.95, regression: false, metrics: result, signature });
  }
  fs.writeFileSync(benchPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  writeJson(path.join(stateRoot, 'queue.json'), { ids: ['V3-TEST-001'] });
  writeJson(path.join(stateRoot, 'meta.json'), { items: { 'V3-TEST-001': { id: 'V3-TEST-001', owner: 'ops', risk_tier: 'low', exit_criteria: 'green' } } });

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    thresholds: { min_window_samples: 10, min_window_days: 7, min_quality_score: 0.9, max_regressions: 0, min_integrity_coverage: 0.9 },
    paths: {
      state_root: stateRoot,
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      benchmark_history_path: benchPath,
      autonomy_queue_path: path.join(stateRoot, 'queue.json'),
      metadata_contract_path: path.join(stateRoot, 'meta.json')
    }
  });

  const res = run(['run', `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.eligible_count === 1, 'item should be eligible');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('benchmark_autonomy_gate.test.js: OK');
} catch (err) {
  console.error(`benchmark_autonomy_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
