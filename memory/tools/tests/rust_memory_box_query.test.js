#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CRATE = path.join(ROOT, 'systems', 'rust', 'memory_box');

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function run(args, cwd) {
  const r = spawnSync('cargo', ['run', '--quiet', '--', ...args], {
    cwd,
    encoding: 'utf8'
  });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return {
    status: Number.isFinite(r.status) ? r.status : 1,
    payload,
    stderr: String(r.stderr || '')
  };
}

function hasCargo() {
  const r = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  return Number.isFinite(r.status) && r.status === 0;
}

try {
  if (!hasCargo()) {
    console.log('rust_memory_box_query.test.js: SKIP (cargo not installed)');
    process.exit(0);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-memory-box-query-'));
  writeFile(path.join(tmp, 'memory', 'MEMORY_INDEX.md'), [
    '| node_id | uid | tags | file | summary |',
    '|---|---|---|---|---|',
    '| routing-cache-design | memabc123routing01 | #routing #memory | 2026-01-01.md | Routing cache and fallback behavior |',
    '| autonomy-loop-gate | memabc123autonomy2 | #autonomy #memory | 2026-01-01.md | Repeat-gate policy and stop conditions |',
    ''
  ].join('\n'));
  writeFile(path.join(tmp, 'memory', 'TAGS_INDEX.md'), [
    '#routing -> routing-cache-design',
    '#autonomy -> autonomy-loop-gate',
    '#memory -> routing-cache-design, autonomy-loop-gate',
    ''
  ].join('\n'));
  writeFile(path.join(tmp, 'memory', '2026-01-01.md'), [
    '---',
    'date: 2026-01-01',
    'node_id: routing-cache-design',
    'uid: memabc123routing01',
    'tags: [routing, memory]',
    'edges_to: []',
    '---',
    '# routing-cache-design',
    '- Use cache-first retrieval and fallback logic.',
    '',
    '<!-- NODE -->',
    '---',
    'date: 2026-01-01',
    'node_id: autonomy-loop-gate',
    'uid: memabc123autonomy2',
    'tags: [autonomy, memory]',
    'edges_to: []',
    '---',
    '# autonomy-loop-gate',
    '- Stop on repeated no-progress streak.',
    ''
  ].join('\n'));

  let out = run(['query-index', `--root=${tmp}`, '--q=routing fallback', '--tags=routing', '--top=2'], CRATE);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.payload && out.payload.ok === true, 'query-index should return ok=true');
  assert.ok(Array.isArray(out.payload.hits), 'hits should be an array');
  assert.strictEqual(out.payload.hits[0].node_id, 'routing-cache-design', 'routing node should rank first');
  assert.ok(Array.isArray(out.payload.index_sources) && out.payload.index_sources.length >= 1, 'index sources should be present');

  out = run(['probe', `--root=${tmp}`], CRATE);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.payload && out.payload.ok === true, 'probe should return ok=true');
  assert.ok(Number(out.payload.estimated_ms || 0) >= 1, 'probe should report elapsed ms');

  out = run(['query-index', `--root=${tmp}`, '--q=cache fallback', '--top=2', '--expand-lines=6', '--max-files=1'], CRATE);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.payload && out.payload.ok === true, 'expanded query-index should return ok=true');
  assert.ok(typeof out.payload.hits[0].section_excerpt === 'string', 'expanded hit should include section_excerpt');

  out = run(['get-node', `--root=${tmp}`, '--uid=memabc123autonomy2'], CRATE);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.payload && out.payload.ok === true, 'get-node should return ok=true');
  assert.strictEqual(out.payload.node_id, 'autonomy-loop-gate', 'uid lookup should return correct node');
  assert.ok(String(out.payload.section || '').includes('# autonomy-loop-gate'), 'section should include node content');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rust_memory_box_query.test.js: OK');
} catch (err) {
  console.error(`rust_memory_box_query.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
