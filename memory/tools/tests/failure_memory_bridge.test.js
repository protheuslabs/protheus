#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body + (body ? '\n' : ''), 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseJson(stdout) {
  try { return JSON.parse(String(stdout || '').trim()); } catch { return null; }
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'memory', 'failure_memory_bridge.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-memory-bridge-'));
  const dateStr = '2026-02-22';
  const memoryDir = path.join(tmpRoot, 'memory');
  const pointersDir = path.join(tmpRoot, 'state', 'memory', 'failure_pointers');
  const painSignalsPath = path.join(tmpRoot, 'state', 'autonomy', 'pain_signals.jsonl');
  const escalationsPath = path.join(tmpRoot, 'state', 'security', 'autonomy_human_escalations.jsonl');
  const ledgerPath = path.join(tmpRoot, 'state', 'memory', 'failure_memory_bridge.jsonl');

  writeJsonl(painSignalsPath, [
    {
      ts: `${dateStr}T12:01:00.000Z`,
      type: 'pain_signal',
      source: 'spine',
      subsystem: 'orchestration',
      code: 'integrity_violation',
      summary: 'Security integrity violation blocked run',
      details: 'hash mismatch in startup attestation',
      severity: 'high',
      risk: 'high',
      failure_count_window: 2,
      total_count: 5,
      status: 'active'
    },
    {
      ts: `${dateStr}T12:02:00.000Z`,
      type: 'pain_signal',
      source: 'sensory',
      subsystem: 'collector',
      code: 'collector_timeout',
      summary: 'Collector timed out',
      details: 'network timeout while fetching source',
      severity: 'low',
      risk: 'low',
      failure_count_window: 3,
      total_count: 8,
      status: 'active'
    },
    {
      ts: `${dateStr}T12:03:00.000Z`,
      type: 'pain_signal',
      source: 'sensory',
      subsystem: 'collector',
      code: 'deferred_sample',
      summary: 'Deferred signal should skip',
      severity: 'medium',
      risk: 'medium',
      deferred: true
    },
    {
      ts: `2026-02-21T23:00:00.000Z`,
      type: 'pain_signal',
      source: 'spine',
      subsystem: 'orchestration',
      code: 'previous_day',
      summary: 'should skip previous day',
      severity: 'high',
      risk: 'high'
    }
  ]);

  writeJsonl(escalationsPath, [
    {
      ts: `${dateStr}T12:04:00.000Z`,
      type: 'autonomy_human_escalation',
      escalation_id: 'ESC-1234',
      stage: 'route_execute',
      error_code: 'verify_gate_failed',
      summary: 'Manual approval needed for high-risk mutation',
      details: 'blocked by execution gate',
      risk: 'medium',
      status: 'active'
    }
  ]);

  const env = {
    ...process.env,
    FAILURE_MEMORY_BRIDGE_MEMORY_DIR: memoryDir,
    FAILURE_MEMORY_BRIDGE_POINTERS_DIR: pointersDir,
    FAILURE_MEMORY_BRIDGE_PAIN_SIGNALS_PATH: painSignalsPath,
    FAILURE_MEMORY_BRIDGE_HUMAN_ESCALATIONS_PATH: escalationsPath,
    FAILURE_MEMORY_BRIDGE_LEDGER_PATH: ledgerPath
  };

  const first = spawnSync(process.execPath, [scriptPath, 'run', dateStr, '--max-nodes=5'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(first.status, 0, first.stderr || 'first run failed');
  const out1 = parseJson(first.stdout);
  assert.ok(out1 && out1.ok === true, 'expected ok=true on first run');
  assert.strictEqual(Number(out1.selected || 0), 3, 'should select three date-matched failures');
  assert.strictEqual(Number(out1.created_nodes || 0), 3, 'first run should create nodes');

  const memoryFile = path.join(memoryDir, `${dateStr}.md`);
  assert.ok(fs.existsSync(memoryFile), 'memory file should exist');
  const memoryText = fs.readFileSync(memoryFile, 'utf8');
  assert.ok(memoryText.includes('tags: [failure'), 'memory node should include failure tag');
  assert.ok(memoryText.includes('failure-tier-1'), 'tier-1 failure tag should be present');

  const pointersFile = path.join(pointersDir, `${dateStr}.jsonl`);
  const pointers = readJsonl(pointersFile);
  assert.strictEqual(pointers.length, 3, 'pointer rows should match selected count');
  assert.ok(pointers.some((p) => Number(p.failure_tier || 0) === 1), 'at least one pointer must be tier-1');
  assert.ok(pointers.every((p) => /^[A-Za-z0-9]+$/.test(String(p.uid || ''))), 'uids must be alphanumeric');

  const second = spawnSync(process.execPath, [scriptPath, 'run', dateStr, '--max-nodes=5'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(second.status, 0, second.stderr || 'second run failed');
  const out2 = parseJson(second.stdout);
  assert.ok(out2 && out2.ok === true, 'expected ok=true on second run');
  assert.strictEqual(Number(out2.selected || 0), 0, 'second run should be idempotent for same date pointers');
  assert.strictEqual(Number(out2.created_nodes || 0), 0, 'second run should not create duplicate nodes');

  const status = spawnSync(process.execPath, [scriptPath, 'status', dateStr], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(status.status, 0, status.stderr || 'status failed');
  const outStatus = parseJson(status.stdout);
  assert.ok(outStatus && outStatus.ok === true, 'status should return ok=true');
  assert.strictEqual(Number(outStatus.pointers_today || 0), 3, 'status should report pointer count');
  assert.ok(Number(outStatus.pointer_index_entries || 0) >= 3, 'pointer index should persist entries');

  console.log('failure_memory_bridge.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`failure_memory_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

