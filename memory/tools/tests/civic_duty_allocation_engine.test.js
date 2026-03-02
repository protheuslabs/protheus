#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'civic_duty_allocation_engine.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'civic-duty-'));
  const policyPath = path.join(tmp, 'config', 'civic_duty_allocation_policy.json');
  const catalogPath = path.join(tmp, 'systems', 'objectives', 'civic_duty_objective_catalog.json');
  writeJson(catalogPath, {
    objectives: [
      { id: 'objective_alpha', title: 'Objective Alpha', priority: 50 },
      { id: 'objective_beta', title: 'Objective Beta', priority: 80 }
    ]
  });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    constraints: {
      default_duty_pct: 0.1,
      max_duty_pct: 0.4
    },
    objectives: {
      catalog_path: catalogPath
    },
    event_stream: {
      enabled: false,
      publish: false,
      stream: 'autonomy.civic_duty'
    },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'civic_duty'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'civic_duty', 'index.json'),
      events_path: path.join(tmp, 'state', 'autonomy', 'civic_duty', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'autonomy', 'civic_duty', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'autonomy', 'civic_duty', 'receipts.jsonl')
    }
  });

  let out = run([
    'configure',
    '--owner=jay',
    '--duty-pct=0.22',
    '--focus=objective_beta',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'configure should pass');

  out = run([
    'allocate',
    '--owner=jay',
    '--risk-tier=2',
    '--apply=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'allocate should pass');
  assert.strictEqual(out.payload.event, 'civic_duty_allocate');

  const memoryOwner = path.join(tmp, 'memory', 'civic_duty', 'jay.json');
  assert.ok(fs.existsSync(memoryOwner), 'user preference should be in memory/');
  assert.ok(fs.existsSync(path.join(tmp, 'adaptive', 'civic_duty', 'index.json')), 'adaptive index should exist');
  assert.ok(fs.existsSync(path.join(tmp, 'state', 'autonomy', 'civic_duty', 'events.jsonl')), 'event receipt should exist');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('civic_duty_allocation_engine.test.js: OK');
} catch (err) {
  console.error(`civic_duty_allocation_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
