#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function run(script, args) {
  const proc = spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    encoding: 'utf8'
  });
  const text = String(proc.stdout || '').trim();
  let payload = null;
  try { payload = JSON.parse(text); } catch {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { payload = JSON.parse(lines[i]); break; } catch {}
    }
  }
  return { status: Number(proc.status || 0), payload, stderr: String(proc.stderr || '') };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-ops-pack-'));

  const chaosPolicy = path.join(tmp, 'chaos_policy.json');
  const formalPolicy = path.join(tmp, 'formal_policy.json');
  const parityPolicy = path.join(tmp, 'parity_policy.json');

  writeJson(chaosPolicy, {
    enabled: true,
    shadow_only: true,
    paths: {
      latest_path: path.join(tmp, 'chaos_latest.json'),
      receipts_path: path.join(tmp, 'chaos_receipts.jsonl'),
      schedule_path: path.join(tmp, 'chaos_schedule.json'),
      postmortem_path: path.join(tmp, 'postmortem.json'),
      doctor_path: path.join(tmp, 'doctor.json'),
      chaos_path: path.join(tmp, 'chaos_source.json')
    }
  });
  writeJson(path.join(tmp, 'postmortem.json'), { generated_last_24h: 1 });
  writeJson(path.join(tmp, 'doctor.json'), { wounded_active: 0, healing_active: 1 });
  writeJson(path.join(tmp, 'chaos_source.json'), { critical_findings: 0 });

  writeJson(formalPolicy, {
    enabled: true,
    shadow_only: true,
    strict_fail_closed: true,
    required_paths: ['client/systems/spine/spine.js'],
    verifier_cmd: ['node', 'client/systems/security/critical_path_formal_verifier.js', 'status'],
    paths: {
      latest_path: path.join(tmp, 'formal_latest.json'),
      receipts_path: path.join(tmp, 'formal_receipts.jsonl')
    }
  });

  writeJson(parityPolicy, {
    enabled: true,
    shadow_only: true,
    strict_default: false,
    remediation_threshold: 0.95,
    remediation_limit: 4,
    parity_cmd: ['node', 'client/systems/ops/narrow_agent_parity_harness.js', 'status', 'latest'],
    paths: {
      latest_path: path.join(tmp, 'parity_latest.json'),
      receipts_path: path.join(tmp, 'parity_receipts.jsonl'),
      remediation_queue_path: path.join(tmp, 'parity_queue.json')
    }
  });

  const chaosScript = path.join(root, 'systems', 'ops', 'chaos_self_healing_automation.js');
  const formalScript = path.join(root, 'systems', 'ops', 'critical_protocol_formal_suite.js');
  const parityScript = path.join(root, 'systems', 'ops', 'continuous_parity_maintainer.js');

  let out = run(chaosScript, ['run', '--strict=1', '--apply=1', `--policy=${chaosPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'chaos run should succeed');
  assert.strictEqual(out.payload.ok, true, 'chaos strict should be green');

  out = run(formalScript, ['run', '--strict=0', `--policy=${formalPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'formal suite should run');
  assert.ok(out.payload && out.payload.type === 'critical_protocol_formal_suite_run', 'formal payload type');

  out = run(parityScript, ['run', '--strict=0', '--apply=1', `--policy=${parityPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'parity maintainer should run');
  assert.ok(out.payload && out.payload.type === 'continuous_parity_maintainer_run', 'parity payload type');

  console.log('v4_ops_pack.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`v4_ops_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
