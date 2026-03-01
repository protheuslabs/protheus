#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'memory_recall.js');

let failed = false;

function runTest(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
  }
}

function mkDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, text) {
  mkDir(path.dirname(p));
  fs.writeFileSync(p, text, 'utf8');
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-recall-'));
  mkDir(path.join(root, 'memory'));
  mkDir(path.join(root, 'state', 'memory', 'working_set'));

  writeFile(
    path.join(root, 'memory', 'MEMORY_INDEX.md'),
    [
      '# MEMORY_INDEX.md',
      '| node_id | uid | tags | file | summary |',
      '|---------|-----|------|------|---------|',
      '| routing-cache-design | memabc123routing01 | #routing #memory | 2026-01-01.md | Routing cache and fallback behavior |',
      '| autonomy-loop-gate | memabc123autonomy2 | #autonomy #memory | 2026-01-01.md | Repeat-gate policy and stop conditions |',
      ''
    ].join('\n')
  );

  writeFile(
    path.join(root, 'memory', 'TAGS_INDEX.md'),
    [
      '# TAGS_INDEX.md',
      '#routing -> routing-cache-design',
      '#autonomy -> autonomy-loop-gate',
      '#memory -> routing-cache-design, autonomy-loop-gate',
      ''
    ].join('\n')
  );

  writeFile(
    path.join(root, 'memory', '2026-01-01.md'),
    [
      '---',
      'date: 2026-01-01',
      'node_id: routing-cache-design',
      'uid: memabc123routing01',
      'tags: [routing, memory]',
      'edges_to: []',
      '---',
      '# routing-cache-design',
      '- Use cache-first retrieval and fallback logic.',
      '- Keep deterministic behavior under degraded conditions.',
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
      '- Escalate when cooldown repeats exceed threshold.',
      ''
    ].join('\n')
  );

  return root;
}

function writeJson(filePath, payload) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function runRecall(root, args, extraEnv = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORY_RECALL_ROOT: root,
      ...extraEnv
    }
  });
}

function parseJson(stdout) {
  try { return JSON.parse(String(stdout || '').trim()); } catch { return null; }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   MEMORY RECALL TESTS');
console.log('═══════════════════════════════════════════════════════════');

runTest('query returns ranked hits with tag filtering and no expansion', () => {
  const root = makeWorkspace();
  const r = runRecall(root, ['query', '--q=routing', '--tags=routing', '--expand=none', '--session=t1']);
  assert.strictEqual(r.status, 0, `query failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(out.type, 'memory_recall_query');
  assert.ok(Array.isArray(out.hits) && out.hits.length >= 1, 'expected at least one hit');
  assert.strictEqual(out.hits[0].node_id, 'routing-cache-design');
  assert.strictEqual(out.hits[0].uid, 'memabc123routing01');
  assert.strictEqual(out.hits[0].expanded, false);
});

runTest('query requested rust backend falls back to js when crate is missing', () => {
  const root = makeWorkspace();
  const missingCrate = path.join(root, 'systems', 'rust', 'memory_box_missing');
  const r = runRecall(
    root,
    ['query', '--q=routing', '--expand=none', '--session=rustfallback'],
    {
      MEMORY_RECALL_BACKEND: 'rust',
      MEMORY_RECALL_RUST_CRATE_PATH: missingCrate
    }
  );
  assert.strictEqual(r.status, 0, `query failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(out.backend_requested, 'rust');
  assert.strictEqual(out.backend_used, 'js');
  assert.strictEqual(out.backend_fallback_reason, 'rust_crate_missing');
  assert.ok(Array.isArray(out.hits) && out.hits.length > 0, 'fallback should still return hits');
});

runTest('query rust backend enters cooldown after first rust failure', () => {
  const root = makeWorkspace();
  const missingCrate = path.join(root, 'systems', 'rust', 'memory_box_missing');
  const env = {
    MEMORY_RECALL_BACKEND: 'rust',
    MEMORY_RECALL_RUST_CRATE_PATH: missingCrate,
    MEMORY_RECALL_RUST_COOLDOWN_MS: '600000'
  };
  const r1 = runRecall(root, ['query', '--q=routing', '--expand=none', '--session=rustcool1'], env);
  assert.strictEqual(r1.status, 0, `first query failed: ${r1.stderr}`);
  const out1 = parseJson(r1.stdout);
  assert.ok(out1 && out1.ok === true, 'first query should return ok=true');
  assert.strictEqual(out1.backend_fallback_reason, 'rust_crate_missing');

  const r2 = runRecall(root, ['query', '--q=routing', '--expand=none', '--session=rustcool2'], env);
  assert.strictEqual(r2.status, 0, `second query failed: ${r2.stderr}`);
  const out2 = parseJson(r2.stdout);
  assert.ok(out2 && out2.ok === true, 'second query should return ok=true');
  assert.strictEqual(out2.backend_fallback_reason, 'rust_cooldown_active');
});

runTest('query auto backend uses selector rust then falls back to js when crate is missing', () => {
  const root = makeWorkspace();
  writeJson(path.join(root, 'state', 'memory', 'rust_transition', 'backend_selector.json'), {
    backend: 'rust',
    fallback_backend: 'js'
  });
  const missingCrate = path.join(root, 'systems', 'rust', 'memory_box_missing');
  const r = runRecall(
    root,
    ['query', '--q=autonomy', '--expand=none', '--session=autosel'],
    {
      MEMORY_RECALL_BACKEND: 'auto',
      MEMORY_RECALL_RUST_CRATE_PATH: missingCrate
    }
  );
  assert.strictEqual(r.status, 0, `query failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(out.backend_requested, 'rust');
  assert.strictEqual(out.backend_used, 'js');
  assert.strictEqual(out.backend_fallback_reason, 'rust_crate_missing');
});

runTest('expanded query reuses working-set cache on second run', () => {
  const root = makeWorkspace();
  const args = ['query', '--q=cache fallback behavior', '--expand=always', '--session=cachetest', '--max-files=1'];
  const r1 = runRecall(root, args);
  assert.strictEqual(r1.status, 0, `first query failed: ${r1.stderr}`);
  const out1 = parseJson(r1.stdout);
  assert.ok(out1 && out1.ok === true, 'first output should be ok');
  assert.ok(Number(out1.metrics.file_reads || 0) >= 1, 'first run should read file');

  const r2 = runRecall(root, args);
  assert.strictEqual(r2.status, 0, `second query failed: ${r2.stderr}`);
  const out2 = parseJson(r2.stdout);
  assert.ok(out2 && out2.ok === true, 'second output should be ok');
  assert.ok(Number(out2.metrics.cache_hits || 0) >= 1, 'second run should hit cache');
  assert.strictEqual(Number(out2.metrics.file_reads || 0), 0, 'second run should avoid file reads');
});

runTest('get returns full node section and metadata', () => {
  const root = makeWorkspace();
  const r = runRecall(root, ['get', '--node-id=routing-cache-design', '--session=gettest']);
  assert.strictEqual(r.status, 0, `get failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(out.type, 'memory_recall_get');
  assert.strictEqual(out.node_id, 'routing-cache-design');
  assert.strictEqual(out.uid, 'memabc123routing01');
  assert.ok(String(out.section || '').includes('# routing-cache-design'), 'section should include node heading');
  assert.ok(out.section_hash, 'section_hash expected');
});

runTest('get can resolve node by uid', () => {
  const root = makeWorkspace();
  const r = runRecall(root, ['get', '--uid=memabc123autonomy2', '--session=getuid']);
  assert.strictEqual(r.status, 0, `get by uid failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(out.node_id, 'autonomy-loop-gate');
  assert.strictEqual(out.uid, 'memabc123autonomy2');
  assert.ok(String(out.section || '').includes('# autonomy-loop-gate'), 'section should include uid-matched node');
});

runTest('get requested rust backend falls back to js when crate is missing', () => {
  const root = makeWorkspace();
  const missingCrate = path.join(root, 'systems', 'rust', 'memory_box_missing');
  const r = runRecall(
    root,
    ['get', '--node-id=routing-cache-design', '--session=getrustfallback'],
    {
      MEMORY_RECALL_BACKEND: 'rust',
      MEMORY_RECALL_RUST_CRATE_PATH: missingCrate
    }
  );
  assert.strictEqual(r.status, 0, `get failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(out.backend_requested, 'rust');
  assert.strictEqual(out.backend_used, 'js');
  assert.strictEqual(out.backend_fallback_reason, 'rust_crate_missing');
  assert.ok(String(out.section || '').includes('# routing-cache-design'), 'fallback should still return section');
});

runTest('get rust backend enters cooldown after first rust failure', () => {
  const root = makeWorkspace();
  const missingCrate = path.join(root, 'systems', 'rust', 'memory_box_missing');
  const env = {
    MEMORY_RECALL_BACKEND: 'rust',
    MEMORY_RECALL_RUST_CRATE_PATH: missingCrate,
    MEMORY_RECALL_RUST_COOLDOWN_MS: '600000'
  };
  const r1 = runRecall(root, ['get', '--node-id=routing-cache-design', '--session=getrustcool1'], env);
  assert.strictEqual(r1.status, 0, `first get failed: ${r1.stderr}`);
  const out1 = parseJson(r1.stdout);
  assert.ok(out1 && out1.ok === true, 'first get should return ok=true');
  assert.strictEqual(out1.backend_fallback_reason, 'rust_crate_missing');

  const r2 = runRecall(root, ['get', '--node-id=routing-cache-design', '--session=getrustcool2'], env);
  assert.strictEqual(r2.status, 0, `second get failed: ${r2.stderr}`);
  const out2 = parseJson(r2.stdout);
  assert.ok(out2 && out2.ok === true, 'second get should return ok=true');
  assert.strictEqual(out2.backend_fallback_reason, 'rust_cooldown_active');
});

runTest('get auto backend uses selector rust then falls back to js when crate is missing', () => {
  const root = makeWorkspace();
  writeJson(path.join(root, 'state', 'memory', 'rust_transition', 'backend_selector.json'), {
    backend: 'rust',
    fallback_backend: 'js'
  });
  const missingCrate = path.join(root, 'systems', 'rust', 'memory_box_missing');
  const r = runRecall(
    root,
    ['get', '--uid=memabc123autonomy2', '--session=getautosel'],
    {
      MEMORY_RECALL_BACKEND: 'auto',
      MEMORY_RECALL_RUST_CRATE_PATH: missingCrate
    }
  );
  assert.strictEqual(r.status, 0, `get failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(out.backend_requested, 'rust');
  assert.strictEqual(out.backend_used, 'js');
  assert.strictEqual(out.backend_fallback_reason, 'rust_crate_missing');
  assert.strictEqual(out.node_id, 'autonomy-loop-gate');
});

if (failed) process.exit(1);
console.log('   ✅ ALL MEMORY RECALL TESTS PASS');
