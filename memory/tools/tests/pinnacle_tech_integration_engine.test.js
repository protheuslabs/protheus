#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'research', 'pinnacle_tech_integration_engine.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnacle-tech-'));
  const policyPath = path.join(tmp, 'config', 'pinnacle_tech_integration_policy.json');
  const catalogPath = path.join(tmp, 'systems', 'research', 'pinnacle_tech_catalog.json');
  writeJson(catalogPath, {
    classes: [
      { id: 'crdt', title: 'CRDT', readiness: 'pilot', guardrails: ['merge'] },
      { id: 'zk', title: 'ZK Proofs', readiness: 'research', guardrails: ['verifier'] }
    ]
  });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    research: {
      catalog_path: catalogPath
    },
    event_stream: {
      enabled: false,
      publish: false,
      stream: 'research.pinnacle_tech'
    },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'research', 'preferences'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'research', 'preferences', 'index.json'),
      events_path: path.join(tmp, 'state', 'research', 'pinnacle_tech', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'research', 'pinnacle_tech', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'research', 'pinnacle_tech', 'receipts.jsonl'),
      proposals_path: path.join(tmp, 'state', 'research', 'pinnacle_tech', 'proposals.jsonl')
    }
  });

  let out = run([
    'configure',
    '--owner=jay',
    '--adoption_mode=observe_only',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'configure should pass');

  out = run([
    'scan',
    '--risk-tier=2',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'scan should pass');
  assert.ok(Array.isArray(out.payload.candidates) && out.payload.candidates.length === 2, 'scan should emit candidate proposals');

  assert.ok(fs.existsSync(path.join(tmp, 'state', 'research', 'pinnacle_tech', 'proposals.jsonl')), 'proposals should be written');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('pinnacle_tech_integration_engine.test.js: OK');
} catch (err) {
  console.error(`pinnacle_tech_integration_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
