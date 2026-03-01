#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'readiness_bridge_pack.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-pack-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateRoot = path.join(tmp, 'state');

  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'health.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), critical_failure: false })}\n`);
  fs.writeFileSync(path.join(stateRoot, 'trace.jsonl'), `${JSON.stringify({ trace_id: 't', request_id: 'r', run_id: 'u', job_id: 'j' })}\n`);
  const benchmarkRow = { ts: new Date().toISOString(), result: { score: 1 } };
  benchmarkRow.signature = require('crypto').createHash('sha256').update(JSON.stringify(benchmarkRow.result), 'utf8').digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(stateRoot, 'bench.jsonl'), `${JSON.stringify(benchmarkRow)}\n`);
  writeJson(path.join(stateRoot, 'scorecard.json'), { score: 0.9 });
  writeJson(path.join(stateRoot, 'extsec.json'), { last_scan_at: new Date().toISOString(), open_critical_findings: 0 });

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    thresholds: { min_reliability_days: 1, min_trace_coverage: 0.9, min_benchmark_signature_coverage: 0.9, min_outcome_score: 0.7, max_external_security_scan_age_days: 14 },
    paths: {
      state_root: stateRoot,
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      health_history_path: path.join(stateRoot, 'health.jsonl'),
      thought_trace_path: path.join(stateRoot, 'trace.jsonl'),
      benchmark_results_path: path.join(stateRoot, 'bench.jsonl'),
      outcome_scorecard_path: path.join(stateRoot, 'scorecard.json'),
      external_security_program_path: path.join(stateRoot, 'extsec.json')
    }
  });

  const res = run(['run', `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.ok === true, 'strict run should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('readiness_bridge_pack.test.js: OK');
} catch (err) {
  console.error(`readiness_bridge_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
