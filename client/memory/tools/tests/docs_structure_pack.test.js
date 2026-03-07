#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'docs_structure_pack.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args) {
  const res = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return { status: res.status == null ? 1 : res.status, payload, stderr: String(res.stderr || '') };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-structure-pack-'));
  const policyPath = path.join(tmp, 'config', 'docs_structure_pack_policy.json');
  const controlsPath = path.join(tmp, 'config', 'compliance_controls_map.json');

  writeJson(controlsPath, {
    controls: {
      SEC_001: {
        owner: 'security',
        cadence: 'daily',
        checks: ['merge_guard'],
        evidence_paths: ['state/security/receipts.jsonl']
      }
    }
  });

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    paths: {
      docs_hub_path: path.join(tmp, 'docs', 'README.md'),
      adr_root: path.join(tmp, 'docs', 'adr'),
      service_catalog_path: path.join(tmp, 'config', 'service_catalog.json'),
      interface_registry_path: path.join(tmp, 'config', 'interface_contract_registry.json'),
      control_evidence_matrix_path: path.join(tmp, 'state', 'ops', 'docs_structure', 'control_evidence_matrix.json'),
      release_templates_root: path.join(tmp, 'docs', 'release', 'templates'),
      data_governance_matrix_path: path.join(tmp, 'docs', 'data_governance_matrix.md'),
      environment_matrix_path: path.join(tmp, 'docs', 'environment_matrix.md'),
      latest_path: path.join(tmp, 'state', 'ops', 'docs_structure', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'ops', 'docs_structure', 'receipts.jsonl'),
      compliance_controls_map_path: controlsPath
    }
  });

  let res = run(['run-all', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(res.status, 0, `run-all should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.type, 'docs_structure_run_all');

  res = run(['validate', `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(res.status, 0, `validate strict should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.pass, true);

  res = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload.latest, 'latest payload expected');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('docs_structure_pack.test.js: OK');
} catch (err) {
  console.error(`docs_structure_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
