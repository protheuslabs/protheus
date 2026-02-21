#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'memory', 'eyes_memory_bridge.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-memory-bridge-'));
  const memoryDir = path.join(tmpRoot, 'memory');
  const proposalsDir = path.join(tmpRoot, 'state', 'sensory', 'proposals');
  const pointersDir = path.join(tmpRoot, 'state', 'memory', 'eyes_pointers');
  const ledgerPath = path.join(tmpRoot, 'state', 'memory', 'eyes_memory_bridge.jsonl');
  const dateStr = '2026-02-21';

  writeJson(path.join(proposalsDir, `${dateStr}.json`), [
    {
      id: 'EYE-keep-1',
      type: 'external_intel',
      title: '[Eyes:hn_frontpage] AI agent memory routing benchmark',
      evidence: [
        {
          evidence_ref: 'eye:hn_frontpage',
          evidence_url: 'https://example.com/agent-memory-routing',
          evidence_item_hash: 'abc123abc123abcd'
        }
      ],
      meta: {
        source_eye: 'hn_frontpage',
        url: 'https://example.com/agent-memory-routing',
        topics: ['ai', 'routing', 'memory'],
        signal_quality_score: 82,
        relevance_score: 74,
        composite_eligibility_score: 78,
        composite_eligibility_pass: true,
        actionability_pass: true
      },
      summary: 'Benchmark signal worth tracking.'
    },
    {
      id: 'EYE-drop-local',
      type: 'external_intel',
      title: '[Eyes:local_state_fallback] Review health and prioritize work',
      evidence: [
        {
          evidence_ref: 'eye:local_state_fallback',
          evidence_url: 'https://local.workspace/signals/2026-02-21/local_health',
          evidence_item_hash: 'dropdropdropdrop'
        }
      ],
      meta: {
        source_eye: 'local_state_fallback',
        signal_quality_score: 50,
        relevance_score: 52,
        composite_eligibility_score: 55,
        composite_eligibility_pass: false,
        actionability_pass: false
      }
    }
  ]);

  const env = {
    ...process.env,
    MEMORY_BRIDGE_MEMORY_DIR: memoryDir,
    MEMORY_BRIDGE_PROPOSALS_DIR: proposalsDir,
    MEMORY_BRIDGE_POINTERS_DIR: pointersDir,
    MEMORY_BRIDGE_LEDGER_PATH: ledgerPath
  };

  const first = spawnSync(process.execPath, [scriptPath, 'run', dateStr, '--max-nodes=3'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(first.status, 0, first.stderr || 'first run failed');
  const out1 = JSON.parse(String(first.stdout || '{}').trim());
  assert.strictEqual(out1.ok, true);
  assert.strictEqual(Number(out1.created_nodes || 0), 1);
  assert.strictEqual(Number(out1.selected || 0), 1);

  const memoryFile = path.join(memoryDir, `${dateStr}.md`);
  assert.ok(fs.existsSync(memoryFile), 'memory file should exist');
  const memoryText = fs.readFileSync(memoryFile, 'utf8');
  assert.ok(memoryText.includes('node_id: eye-hn_frontpage-abc123ab'));
  const uidMatch = memoryText.match(/\nuid:\s*([A-Za-z0-9]+)\s*\n/);
  assert.ok(uidMatch, 'new memory node should include uid');
  assert.ok(/^[A-Za-z0-9]+$/.test(uidMatch[1]), 'uid must be alphanumeric');

  const pointersFile = path.join(pointersDir, `${dateStr}.jsonl`);
  assert.ok(fs.existsSync(pointersFile), 'pointers file should exist');
  const pointers = readJsonl(pointersFile);
  assert.strictEqual(pointers.length, 1);
  assert.strictEqual(pointers[0].item_hash, 'abc123abc123abcd');
  assert.ok(/^[A-Za-z0-9]+$/.test(String(pointers[0].uid || '')), 'pointer should include alphanumeric uid');

  const second = spawnSync(process.execPath, [scriptPath, 'run', dateStr, '--max-nodes=3'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(second.status, 0, second.stderr || 'second run failed');
  const out2 = JSON.parse(String(second.stdout || '{}').trim());
  assert.strictEqual(out2.ok, true);
  assert.strictEqual(Number(out2.created_nodes || 0), 0, 'second run should be idempotent');

  const status = spawnSync(process.execPath, [scriptPath, 'status', dateStr], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(status.status, 0, status.stderr || 'status failed');
  const outStatus = JSON.parse(String(status.stdout || '{}').trim());
  assert.strictEqual(outStatus.ok, true);
  assert.strictEqual(Number(outStatus.pointers_today || 0), 1);

  console.log('eyes_memory_bridge.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`eyes_memory_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
