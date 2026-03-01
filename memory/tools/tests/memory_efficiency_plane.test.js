#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'memory_efficiency_plane.js');

function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: Number.isFinite(r.status) ? r.status : 1, payload, stderr: String(r.stderr || '') };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-eff-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateRoot = path.join(tmp, 'state');
  const memoryIndex = path.join(tmp, 'MEMORY_INDEX.md');
  const dayFile = path.join(tmp, 'memory', '2026-02-28.md');

  fs.mkdirSync(path.dirname(dayFile), { recursive: true });
  fs.writeFileSync(memoryIndex, [
    '| node_id | title | file |',
    '|---|---|---|',
    `| \`node-a\` | node-a | \`${dayFile}\` |`
  ].join('\n'));

  fs.writeFileSync(dayFile, `---\nnode_id: node-a\ntags: [memory]\n---\nHello world memory node\n`);
  fs.mkdirSync(path.join(stateRoot, 'routing'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'routing', 'history.jsonl'), '');

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    paths: {
      memory_index_path: memoryIndex,
      state_root: stateRoot,
      content_store_path: path.join(stateRoot, 'content_store.json'),
      metadata_index_path: path.join(stateRoot, 'metadata_index.json'),
      shard_index_path: path.join(stateRoot, 'shards.json'),
      distilled_views_path: path.join(stateRoot, 'distilled.json'),
      prompt_block_cache_path: path.join(stateRoot, 'prompt_cache.json'),
      transform_memo_path: path.join(stateRoot, 'memo.json'),
      receipt_views_path: path.join(stateRoot, 'receipt_views.json'),
      probe_cadence_path: path.join(stateRoot, 'probe_cadence.json'),
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      model_health_history_path: path.join(stateRoot, 'routing', 'history.jsonl'),
      full_receipts_path: path.join(stateRoot, 'full_receipts.jsonl')
    }
  });

  let res = run(['run', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.ok === true, 'run should pass');

  res = run(['query', `--policy=${policyPath}`, '--q=hello']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.ok === true, 'query should pass');

  res = run(['memoize', `--policy=${policyPath}`, '--kind=normalize', '--input=abc', '--output=xyz']);
  assert.strictEqual(res.status, 0, res.stderr);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('memory_efficiency_plane.test.js: OK');
} catch (err) {
  console.error(`memory_efficiency_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
