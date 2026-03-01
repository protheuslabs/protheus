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

function makeFakeRustBin(root) {
  const bin = path.join(root, 'fake_rust_bin.js');
  writeFile(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const sep = args.indexOf('--');
const cmd = sep >= 0 ? String(args[sep + 1] || '') : '';
if (cmd === 'query-index') {
  process.stdout.write(JSON.stringify({
    ok: true,
    backend: 'rust_memory_box',
    index_sources: ['memory/MEMORY_INDEX.md'],
    tag_sources: ['memory/TAGS_INDEX.md'],
    candidates_total: 2,
    hits: [{
      node_id: 'routing-cache-design',
      uid: 'memabc123routing01',
      file: 'memory/2026-01-01.md',
      summary: 'Routing cache and fallback behavior',
      tags: ['routing', 'memory'],
      score: 12,
      reasons: ['query_match']
    }]
  }) + '\\n');
  process.exit(0);
}
if (cmd === 'get-node') {
  process.stdout.write(JSON.stringify({
    ok: true,
    backend: 'rust_memory_box',
    node_id: 'autonomy-loop-gate',
    uid: 'memabc123autonomy2',
    file: 'memory/2026-01-01.md',
    summary: 'Repeat-gate policy and stop conditions',
    tags: ['autonomy', 'memory'],
    section_hash: '1111111111111111111111111111111111111111111111111111111111111111',
    section: '# autonomy-loop-gate\\n- Stop on repeated no-progress streak.'
  }) + '\\n');
  process.exit(0);
}
console.error('unsupported fake rust cmd', cmd);
process.exit(1);
`);
  fs.chmodSync(bin, 0o755);
  return bin;
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
  const missingCrate = path.join(root, 'systems', 'memory', 'rust_missing');
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

runTest('query requested rust backend uses rust payload when rust bin succeeds', () => {
  const root = makeWorkspace();
  const fakeBin = makeFakeRustBin(root);
  const cratePath = path.join(root, 'systems', 'memory', 'rust_present');
  mkDir(cratePath);
  const r = runRecall(
    root,
    ['query', '--q=routing', '--expand=none', '--session=rustsuccess'],
    {
      MEMORY_RECALL_BACKEND: 'rust',
      MEMORY_RECALL_RUST_BIN: fakeBin,
      MEMORY_RECALL_RUST_CRATE_PATH: cratePath
    }
  );
  assert.strictEqual(r.status, 0, `query failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(out.backend_used, 'rust');
  assert.strictEqual(out.backend_fallback_reason, null);
  assert.strictEqual(out.rust_transport, 'cli');
  assert.strictEqual(out.hits[0].node_id, 'routing-cache-design');
});

runTest('query rust backend enters cooldown after first rust failure', () => {
  const root = makeWorkspace();
  const missingCrate = path.join(root, 'systems', 'memory', 'rust_missing');
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
  const missingCrate = path.join(root, 'systems', 'memory', 'rust_missing');
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

runTest('query auto backend honors selector active_engine=rust', () => {
  const root = makeWorkspace();
  writeJson(path.join(root, 'state', 'memory', 'rust_transition', 'backend_selector.json'), {
    backend: 'unknown_mode',
    active_engine: 'rust',
    fallback_backend: 'js'
  });
  const missingCrate = path.join(root, 'systems', 'memory', 'rust_missing');
  const r = runRecall(
    root,
    ['query', '--q=routing', '--expand=none', '--session=autoactiveengine'],
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

runTest('query auto backend falls back to benchmark gate when selector is absent', () => {
  const root = makeWorkspace();
  writeJson(path.join(root, 'state', 'memory', 'rust_transition', 'benchmark_history.json'), {
    schema_version: '1.0',
    rows: [
      { speedup: 1.3, parity_error_count: 0 },
      { speedup: 1.25, parity_error_count: 0 },
      { speedup: 1.22, parity_error_count: 0 }
    ]
  });
  writeJson(path.join(root, 'config', 'rust_memory_transition_policy.json'), {
    thresholds: {
      min_speedup_for_cutover: 1.2,
      max_parity_error_count: 0,
      min_stable_runs_for_retirement: 3
    },
    paths: {
      benchmark_path: 'state/memory/rust_transition/benchmark_history.json'
    }
  });
  const missingCrate = path.join(root, 'systems', 'memory', 'rust_missing');
  const r = runRecall(
    root,
    ['query', '--q=routing', '--expand=none', '--session=autobenchmark'],
    {
      MEMORY_RECALL_BACKEND: 'auto',
      MEMORY_RECALL_RUST_CRATE_PATH: missingCrate,
      MEMORY_RECALL_RUST_POLICY_PATH: path.join(root, 'config', 'rust_memory_transition_policy.json')
    }
  );
  assert.strictEqual(r.status, 0, `query failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(out.backend_requested, 'rust');
  assert.strictEqual(out.backend_used, 'js');
  assert.strictEqual(out.backend_fallback_reason, 'rust_crate_missing');
});

runTest('query auto backend stays js when benchmark gate does not pass', () => {
  const root = makeWorkspace();
  writeJson(path.join(root, 'state', 'memory', 'rust_transition', 'benchmark_history.json'), {
    schema_version: '1.0',
    rows: [
      { speedup: 0.95, parity_error_count: 0 },
      { speedup: 1.01, parity_error_count: 0 },
      { speedup: 1.0, parity_error_count: 0 }
    ]
  });
  writeJson(path.join(root, 'config', 'rust_memory_transition_policy.json'), {
    thresholds: {
      min_speedup_for_cutover: 1.2,
      max_parity_error_count: 0,
      min_stable_runs_for_retirement: 3
    },
    paths: {
      benchmark_path: 'state/memory/rust_transition/benchmark_history.json'
    }
  });
  const missingCrate = path.join(root, 'systems', 'memory', 'rust_missing');
  const r = runRecall(
    root,
    ['query', '--q=routing', '--expand=none', '--session=autobenchmarkjs'],
    {
      MEMORY_RECALL_BACKEND: 'auto',
      MEMORY_RECALL_RUST_CRATE_PATH: missingCrate,
      MEMORY_RECALL_RUST_POLICY_PATH: path.join(root, 'config', 'rust_memory_transition_policy.json')
    }
  );
  assert.strictEqual(r.status, 0, `query failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(out.backend_requested, 'js');
  assert.strictEqual(out.backend_used, 'js');
  assert.strictEqual(out.backend_fallback_reason, null);
});

runTest('expanded query reuses working-set cache on second run', () => {
  const root = makeWorkspace();
  const args = ['query', '--q=cache fallback behavior', '--expand=always', '--session=cachetest', '--max-files=1'];
  const env = { MEMORY_RECALL_BACKEND: 'js' };
  const r1 = runRecall(root, args, env);
  assert.strictEqual(r1.status, 0, `first query failed: ${r1.stderr}`);
  const out1 = parseJson(r1.stdout);
  assert.ok(out1 && out1.ok === true, 'first output should be ok');
  assert.ok(Number(out1.metrics.file_reads || 0) >= 1, 'first run should read file');

  const r2 = runRecall(root, args, env);
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
  const missingCrate = path.join(root, 'systems', 'memory', 'rust_missing');
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

runTest('get requested rust backend uses rust payload when rust bin succeeds', () => {
  const root = makeWorkspace();
  const fakeBin = makeFakeRustBin(root);
  const cratePath = path.join(root, 'systems', 'memory', 'rust_present');
  mkDir(cratePath);
  const r = runRecall(
    root,
    ['get', '--uid=memabc123autonomy2', '--session=getrustsuccess'],
    {
      MEMORY_RECALL_BACKEND: 'rust',
      MEMORY_RECALL_RUST_BIN: fakeBin,
      MEMORY_RECALL_RUST_CRATE_PATH: cratePath
    }
  );
  assert.strictEqual(r.status, 0, `get failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(out.backend_used, 'rust');
  assert.strictEqual(out.backend_fallback_reason, null);
  assert.strictEqual(out.rust_transport, 'cli');
  assert.strictEqual(out.node_id, 'autonomy-loop-gate');
  assert.strictEqual(out.section_hash, '1111111111111111111111111111111111111111111111111111111111111111');
});

runTest('get rust backend enters cooldown after first rust failure', () => {
  const root = makeWorkspace();
  const missingCrate = path.join(root, 'systems', 'memory', 'rust_missing');
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
  const missingCrate = path.join(root, 'systems', 'memory', 'rust_missing');
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

runTest('clear-cache removes both js and rust session cache files', () => {
  const root = makeWorkspace();
  const session = 'clearboth';
  const jsCache = path.join(root, 'state', 'memory', 'working_set', `${session}.json`);
  const rustCache = path.join(root, 'state', 'memory', 'working_set', `${session}.rust.json`);
  writeJson(jsCache, { version: 1, nodes: { a: { x: 1 } } });
  writeJson(rustCache, { schema_version: '1.0', nodes: { b: { x: 2 } } });
  const r = runRecall(root, ['clear-cache', `--session=${session}`]);
  assert.strictEqual(r.status, 0, `clear-cache failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'clear-cache should return ok=true');
  assert.strictEqual(fs.existsSync(jsCache), false, 'js cache should be removed');
  assert.strictEqual(fs.existsSync(rustCache), false, 'rust cache should be removed');
  assert.ok(Array.isArray(out.removed_files), 'removed_files should be an array');
  assert.ok(out.removed_files.length >= 2, 'removed_files should include both cache paths');
});

if (failed) process.exit(1);
console.log('   ✅ ALL MEMORY RECALL TESTS PASS');
