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

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'memory', 'memory_dream.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-dream-'));
  const pointersDir = path.join(tmpRoot, 'state', 'memory', 'eyes_pointers');
  const dreamsDir = path.join(tmpRoot, 'state', 'memory', 'dreams');
  const adaptivePointersPath = path.join(tmpRoot, 'state', 'memory', 'adaptive_pointers.jsonl');
  const memoryIndexPath = path.join(tmpRoot, 'memory', 'MEMORY_INDEX.md');
  const ledgerPath = path.join(dreamsDir, 'dream_runs.jsonl');
  const dateStr = '2026-02-21';
  writeJsonl(adaptivePointersPath, []);

  writeJsonl(path.join(pointersDir, '2026-02-20.jsonl'), [
    {
      date: '2026-02-20',
      eye_id: 'hn_frontpage',
      title: 'AI routing benchmark for coding workflows',
      topics: ['ai', 'routing', 'coding'],
      node_id: 'eye-hn-aaa11111',
      memory_file: 'memory/2026-02-20.md'
    },
    {
      date: '2026-02-20',
      eye_id: 'moltbook_feed',
      title: 'Memory routing patterns in agent systems',
      topics: ['memory', 'routing', 'agents'],
      node_id: 'eye-molt-bbb22222',
      memory_file: 'memory/2026-02-20.md'
    }
  ]);

  writeJsonl(path.join(pointersDir, `${dateStr}.jsonl`), [
    {
      date: dateStr,
      eye_id: 'hn_frontpage',
      title: 'Cost routing for AI coding workloads',
      topics: ['ai', 'routing', 'cost'],
      node_id: 'eye-hn-ccc33333',
      memory_file: 'memory/2026-02-21.md'
    }
  ]);

  fs.mkdirSync(path.dirname(memoryIndexPath), { recursive: true });
  fs.writeFileSync(memoryIndexPath, [
    '# MEMORY_INDEX.md',
    '| node_id | tags | file | summary |',
    '|---|---|---|---|',
    '| routing-cache-design | #routing #memory #system | 2026-02-10.md | Router cache strategy for cheap fast-path tasks |',
    '| old-market-signal | #market #strategy | 2026-02-09.md | Market trend synthesis before pivot decisions |',
    '| today-node-should-not-link | #routing | 2026-02-21.md | Same day should be excluded from older echoes |'
  ].join('\n') + '\n', 'utf8');

  const env = {
    ...process.env,
    MEMORY_DREAM_POINTERS_DIR: pointersDir,
    MEMORY_DREAM_OUTPUT_DIR: dreamsDir,
    MEMORY_DREAM_LEDGER_PATH: ledgerPath,
    MEMORY_DREAM_MEMORY_INDEX_PATH: memoryIndexPath,
    MEMORY_DREAM_ADAPTIVE_POINTERS_PATH: adaptivePointersPath
  };

  const runRes = spawnSync(process.execPath, [scriptPath, 'run', dateStr, '--days=2', '--top=5'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runRes.status, 0, runRes.stderr || 'dream run failed');
  const out = JSON.parse(String(runRes.stdout || '{}').trim());
  assert.strictEqual(out.ok, true);
  assert.ok(Number(out.pointer_rows || 0) >= 3);
  assert.ok(Number(out.themes || 0) >= 1);

  const mdPath = path.join(dreamsDir, `${dateStr}.md`);
  const jsonPath = path.join(dreamsDir, `${dateStr}.json`);
  assert.ok(fs.existsSync(mdPath), 'dream markdown should exist');
  assert.ok(fs.existsSync(jsonPath), 'dream json should exist');

  const md = fs.readFileSync(mdPath, 'utf8');
  assert.ok(md.includes('# Memory Dream Sheet: 2026-02-21'));
  assert.ok(md.includes('memory/2026-02-20.md#eye-hn-aaa11111') || md.includes('memory/2026-02-20.md#eye-molt-bbb22222'));
  assert.ok(md.includes('2026-02-10.md#routing-cache-design'), 'should include older-memory echo');

  const statusRes = spawnSync(process.execPath, [scriptPath, 'status', dateStr], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusRes.status, 0, statusRes.stderr || 'dream status failed');
  const status = JSON.parse(String(statusRes.stdout || '{}').trim());
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.exists, true);
  assert.ok(Number(status.themes || 0) >= 1);
  assert.ok(Number(status.older_links_total || 0) >= 1);

  console.log('memory_dream.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`memory_dream.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
