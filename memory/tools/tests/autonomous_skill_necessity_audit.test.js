#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'autonomous_skill_necessity_audit.js');

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, payload) {
  writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-necessity-audit-'));
  const receiptsDir = path.join(tmp, 'state', 'security', 'skill_quarantine', 'install_receipts');
  const policyPath = path.join(tmp, 'config', 'autonomous_skill_necessity_audit_policy.json');
  const latestPath = path.join(tmp, 'state', 'security', 'autonomous_skill_necessity_audit', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'security', 'autonomous_skill_necessity_audit', 'history.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    days: 30,
    receipts_dir: receiptsDir,
    required_fields: [
      'problem',
      'repeat_frequency',
      'expected_time_or_token_savings',
      'why_existing_habits_or_skills_insufficient',
      'risk_class'
    ],
    outputs: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  const receiptPath = path.join(receiptsDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  appendJsonl(receiptPath, {
    ts: new Date().toISOString(),
    type: 'skill_install_receipt',
    decision: 'blocked_necessity',
    autonomous: true,
    necessity: {
      reasons: ['novelty_only_reasoning']
    }
  });
  appendJsonl(receiptPath, {
    ts: new Date().toISOString(),
    type: 'skill_install_receipt',
    decision: 'installed_and_trusted',
    autonomous: true,
    necessity: {
      allowed: false,
      reasons: ['problem_too_short']
    }
  });

  const env = {
    SKILL_NECESSITY_AUDIT_ROOT: tmp,
    SKILL_NECESSITY_AUDIT_POLICY_PATH: policyPath
  };

  let r = run(['run', '--strict=1'], env);
  assert.notStrictEqual(r.status, 0, 'strict audit should fail when installed receipt lacks allowed necessity');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === false, 'payload should fail');
  assert.ok(Number(out.novelty_only_blocked_count || 0) >= 1, 'novelty-only block should be counted');
  assert.strictEqual(Number(out.violation_count || 0), 1, 'one installed necessity violation expected');

  writeText(receiptPath, '');
  appendJsonl(receiptPath, {
    ts: new Date().toISOString(),
    type: 'skill_install_receipt',
    decision: 'installed_and_trusted',
    autonomous: true,
    necessity: {
      allowed: true,
      normalized: {
        problem: 'repeated workflow breakage',
        repeat_frequency: 6,
        expected_time_or_token_savings: 35,
        why_existing_habits_or_skills_insufficient: 'missing deterministic quarantine validation wrapper',
        risk_class: 'medium'
      }
    }
  });

  r = run(['run', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'valid autonomous necessity receipts should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'payload should pass');
  assert.ok(fs.existsSync(latestPath), 'latest output should exist');
  assert.ok(fs.existsSync(historyPath), 'history output should exist');

  console.log('autonomous_skill_necessity_audit.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`autonomous_skill_necessity_audit.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
