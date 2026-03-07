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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-gov-pack-'));

  const distPolicy = path.join(tmp, 'dist_policy.json');
  const econPolicy = path.join(tmp, 'econ_policy.json');
  const emergencyPolicy = path.join(tmp, 'emergency_policy.json');
  const symbiosisPolicy = path.join(tmp, 'symbiosis_policy.json');
  const successionPolicy = path.join(tmp, 'succession_policy.json');

  writeJson(distPolicy, {
    enabled: true,
    shadow_only: true,
    target_profiles: ['phone_seed', 'desktop_seed'],
    package_cmd: ['node', 'client/systems/ops/protheus_prime_seed.js', 'status'],
    verify_cmd: ['node', 'client/systems/ops/protheus_prime_seed.js', 'status'],
    paths: {
      latest_path: path.join(tmp, 'dist_latest.json'),
      receipts_path: path.join(tmp, 'dist_receipts.jsonl'),
      manifest_path: path.join(tmp, 'dist_manifest.json')
    }
  });

  writeJson(econPolicy, {
    enabled: true,
    shadow_only: true,
    treasury_split: { sovereign_root: 0.1, generator_lane: 0.65, reserve_lane: 0.25 },
    storm_plan_cmd: ['node', 'client/systems/storm/storm_value_distribution.js', 'status'],
    paths: {
      latest_path: path.join(tmp, 'econ_latest.json'),
      receipts_path: path.join(tmp, 'econ_receipts.jsonl'),
      ledger_path: path.join(tmp, 'econ_ledger.jsonl')
    }
  });

  writeJson(emergencyPolicy, {
    enabled: true,
    shadow_only: true,
    min_independent_evidence: 2,
    protocol_ttl_minutes: 30,
    paths: {
      latest_path: path.join(tmp, 'emergency_latest.json'),
      receipts_path: path.join(tmp, 'emergency_receipts.jsonl'),
      ledger_path: path.join(tmp, 'emergency_ledger.jsonl'),
      state_path: path.join(tmp, 'emergency_state.json')
    }
  });

  writeJson(symbiosisPolicy, {
    enabled: true,
    shadow_only: true,
    max_open_milestones: 8,
    paths: {
      latest_path: path.join(tmp, 'sym_latest.json'),
      receipts_path: path.join(tmp, 'sym_receipts.jsonl'),
      charter_path: path.join(tmp, 'sym_charter.json'),
      milestones_path: path.join(tmp, 'sym_milestones.json'),
      doc_path: path.join(tmp, 'sym_doc.md')
    }
  });

  writeJson(successionPolicy, {
    enabled: true,
    shadow_only: true,
    min_delay_hours: 1,
    max_delay_hours: 72,
    require_cryptographic_delegation: true,
    paths: {
      latest_path: path.join(tmp, 'succ_latest.json'),
      receipts_path: path.join(tmp, 'succ_receipts.jsonl'),
      state_path: path.join(tmp, 'succ_state.json'),
      audit_path: path.join(tmp, 'succ_audit.jsonl')
    }
  });

  const distScript = path.join(root, 'systems', 'ops', 'universal_distribution_plane.js');
  const econScript = path.join(root, 'systems', 'storm', 'economic_value_distribution_layer.js');
  const emergencyScript = path.join(root, 'systems', 'security', 'dire_case_emergency_autonomy_protocol.js');
  const symbiosisScript = path.join(root, 'systems', 'research', 'civilizational_symbiosis_track.js');
  const successionScript = path.join(root, 'systems', 'continuity', 'succession_continuity_planning.js');

  let out = run(distScript, ['package', '--apply=1', `--policy=${distPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'distribution package should succeed');
  out = run(distScript, ['verify', '--strict=0', `--policy=${distPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'distribution verify should succeed');

  out = run(econScript, ['distribute', '--amount=1000', '--apply=1', `--policy=${econPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'economic distribute should succeed');
  assert.strictEqual(Number(out.payload.split.sovereign_root || 0) > 0, true, 'root split should be positive');

  out = run(emergencyScript, ['trigger', '--evidence-a=helix_mismatch', '--evidence-b=sentinel_confirmed', '--apply=1', `--policy=${emergencyPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'emergency trigger should succeed');
  const token = String(out.payload.activation_token || '');
  assert.ok(token, 'activation token should exist');

  out = run(emergencyScript, ['release', `--token=${token}`, '--apply=1', `--policy=${emergencyPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'emergency release should succeed');

  out = run(symbiosisScript, ['charter', '--apply=1', `--policy=${symbiosisPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'symbiosis charter should succeed');
  out = run(symbiosisScript, ['milestone', '--name=ethics_probe', '--risk=high', '--apply=1', `--policy=${symbiosisPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'symbiosis milestone should succeed');

  out = run(successionScript, ['nominate', '--successor-id=alpha', '--delay-hours=1', '--apply=1', `--policy=${successionPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'succession nominate should succeed');
  const ticket = String(out.payload.ticket || '');
  assert.ok(ticket, 'succession ticket should exist');
  out = run(successionScript, ['activate', `--ticket=${ticket}`, '--force=1', '--apply=1', `--policy=${successionPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'succession activate should succeed');
  assert.strictEqual(out.payload.activated, true, 'succession should activate');

  console.log('v4_governance_distribution_pack.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`v4_governance_distribution_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
