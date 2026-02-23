#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { reconcileHumanEscalations } = require('../../../systems/autonomy/escalation_resolver.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'escalation_resolver_'));
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${payload}\n`, 'utf8');
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function latestById(rows) {
  const out = new Map();
  for (const row of rows) {
    if (!row || row.type !== 'autonomy_human_escalation') continue;
    const id = String(row.escalation_id || '');
    if (!id) continue;
    const prev = out.get(id);
    if (!prev) {
      out.set(id, row);
      continue;
    }
    const prevMs = Date.parse(String(prev.ts || ''));
    const curMs = Date.parse(String(row.ts || ''));
    if (!Number.isFinite(prevMs) || (Number.isFinite(curMs) && curMs >= prevMs)) out.set(id, row);
  }
  return out;
}

function run() {
  const tmpDir = makeTempDir();
  const logPath = path.join(tmpDir, 'autonomy_human_escalations.jsonl');
  const nowIso = '2026-02-23T12:00:00.000Z';
  const nowMs = Date.parse(nowIso);

  writeJsonl(logPath, [
    {
      ts: '2026-02-20T00:00:00.000Z',
      type: 'autonomy_human_escalation',
      escalation_id: 'ESC-1',
      status: 'open',
      signature: 'sig-old',
      stage: 'verify',
      error_code: 'timeout'
    },
    {
      ts: '2026-02-23T09:00:00.000Z',
      type: 'autonomy_human_escalation',
      escalation_id: 'ESC-2',
      status: 'open',
      signature: 'sig-dup',
      stage: 'preflight',
      error_code: 'network_error'
    },
    {
      ts: '2026-02-23T10:00:00.000Z',
      type: 'autonomy_human_escalation',
      escalation_id: 'ESC-3',
      status: 'open',
      signature: 'sig-dup',
      stage: 'preflight',
      error_code: 'network_error'
    }
  ]);

  const out = reconcileHumanEscalations({
    logPath,
    holdHours: 6,
    nowMs,
    maxOpenPerSignature: 1,
    resolveExpired: true,
    resolveSuperseded: true
  });

  assert.strictEqual(out.ok, true);
  assert.ok(Number(out.resolved_count) >= 2, 'resolver should close expired and duplicate escalations');
  assert.strictEqual(Number(out.active_count), 1, 'only one escalation should remain active');
  assert.strictEqual(String(out.active[0].escalation_id || ''), 'ESC-3', 'latest duplicate should remain open');

  const latest = latestById(readJsonl(logPath));
  assert.strictEqual(String(latest.get('ESC-1').status || '').toLowerCase(), 'resolved', 'expired escalation should resolve');
  assert.strictEqual(String(latest.get('ESC-2').status || '').toLowerCase(), 'resolved', 'older duplicate escalation should resolve');
  assert.strictEqual(String(latest.get('ESC-3').status || '').toLowerCase(), 'open', 'latest duplicate escalation should stay open');

  console.log('escalation_resolver.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`escalation_resolver.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

