#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function runBridge(repoRoot, dateStr, env) {
  const script = path.join(repoRoot, 'systems', 'actuation', 'bridge_from_proposals.js');
  return spawnSync('node', [script, 'run', dateStr], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_bridge_from_proposals');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const proposalsDir = path.join(tmpRoot, 'state', 'sensory', 'proposals');
  mkDir(proposalsDir);
  const date = '2099-12-31';
  const fp = path.join(proposalsDir, `${date}.json`);

  writeJson(fp, [
    {
      id: 'PRP-BRIDGE-1',
      type: 'external_intel',
      title: 'Stabilize collector retries',
      summary: 'Add bounded retries and verify with metrics',
      suggested_next_command: 'node systems/routing/route_execute.js --task="Stabilize collector retries with bounded checks" --dry-run',
      validation: [
        'Define measurable retry success rate target for 24h',
        'Verify with dry-run receipt'
      ],
      meta: {
        source_eye: 'hn_frontpage',
        signal_quality_score: 72,
        relevance_score: 74
      }
    }
  ]);

  const env = {
    ...process.env,
    ACTUATION_BRIDGE_PROPOSALS_DIR: proposalsDir
  };

  const r = runBridge(repoRoot, date, env);
  assert.strictEqual(r.status, 0, `bridge run should pass: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.changed, 1);

  const rows = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.ok(Array.isArray(rows) && rows.length === 1);
  const p = rows[0];
  assert.ok(p.action_spec && typeof p.action_spec === 'object', 'action_spec should be synthesized');
  assert.ok(Array.isArray(p.action_spec.verify) && p.action_spec.verify.length >= 1, 'verify should be present');
  assert.ok(Array.isArray(p.action_spec.success_criteria) && p.action_spec.success_criteria.length >= 1, 'success_criteria should be present');
  assert.ok(typeof p.action_spec.next_command === 'string' && p.action_spec.next_command.length > 10);
  assert.ok(p.meta && typeof p.meta.action_spec_target === 'string' && p.meta.action_spec_target.length > 0);

  console.log('bridge_from_proposals.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`bridge_from_proposals.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
