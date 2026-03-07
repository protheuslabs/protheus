#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'backlog_github_sync.js');

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

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeFakeGh(filePath) {
  const body = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

function readDb(file) {
  if (!fs.existsSync(file)) return { next_issue: 1, issues: [], labels: {} };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { next_issue: 1, issues: [], labels: {} }; }
}
function writeDb(file, db) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(db, null, 2) + '\\n', 'utf8');
}
function out(v) {
  process.stdout.write(JSON.stringify(v) + '\\n');
}
function fail(msg, code = 1) {
  out({ message: msg });
  process.exit(code);
}
function parseEndpoint(raw) {
  const i = raw.indexOf('?');
  if (i === -1) return { path: raw, query: {} };
  const p = raw.slice(0, i);
  const q = new URLSearchParams(raw.slice(i + 1));
  const outQ = {};
  for (const [k, v] of q.entries()) outQ[k] = v;
  return { path: p, query: outQ };
}

const dbPath = process.env.FAKE_GH_DB_PATH;
if (!dbPath) fail('FAKE_GH_DB_PATH required');

const argv = process.argv.slice(2);
if (argv[0] === 'auth' && argv[1] === 'status') {
  if (String(process.env.FAKE_GH_AUTH || '0') === '1') {
    process.stdout.write('logged in\\n');
    process.exit(0);
  }
  process.stderr.write('not logged in\\n');
  process.exit(1);
}
if (argv[0] !== 'api') fail('unsupported gh command');

let i = 1;
let method = 'GET';
let endpoint = '';
let inputMode = false;
while (i < argv.length) {
  const tok = argv[i];
  if (tok === '-X') {
    method = String(argv[i + 1] || 'GET').toUpperCase();
    i += 2;
    continue;
  }
  if (tok === '--input') {
    inputMode = true;
    i += 2;
    continue;
  }
  if (!tok.startsWith('-') && !endpoint) {
    endpoint = tok;
    i += 1;
    continue;
  }
  i += 1;
}

let payload = null;
if (inputMode) {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    payload = raw && raw.trim() ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
}

const db = readDb(dbPath);
const parsed = parseEndpoint(endpoint);
const endpointPath = parsed.path;
const q = parsed.query || {};

if (endpointPath === 'search/issues' && method === 'GET') {
  const query = String(q.q || '');
  const markerMatch = query.match(/backlog-mirror-id:([^\\"\s]+)/);
  const marker = markerMatch ? markerMatch[1] : '';
  const hit = marker
    ? db.issues.filter((r) => String(r.body || '').includes('backlog-mirror-id:' + marker))
    : [];
  out({ total_count: hit.length, items: hit });
  process.exit(0);
}

if (endpointPath === 'graphql') {
  out({ data: { addProjectV2ItemById: { item: { id: 'PVT_ITEM_1' } } } });
  process.exit(0);
}

const repoPrefix = 'repos/jakerslam/protheus';
if (endpointPath === repoPrefix && method === 'GET') {
  out({ full_name: 'jakerslam/protheus' });
  process.exit(0);
}

if (endpointPath === repoPrefix + '/issues' && method === 'POST') {
  const num = db.next_issue++;
  const issue = {
    number: num,
    node_id: 'I_' + String(num),
    html_url: 'https://github.com/protheuslabs/protheus/issues/' + String(num),
    title: String(payload && payload.title || ''),
    body: String(payload && payload.body || ''),
    state: 'open',
    labels: Array.isArray(payload && payload.labels)
      ? payload.labels.map((name) => ({ name: String(name) }))
      : []
  };
  db.issues.push(issue);
  writeDb(dbPath, db);
  out(issue);
  process.exit(0);
}

const issueMatch = endpointPath.match(/^repos\\/jakerslam\\/protheus\\/issues\\/(\\d+)$/);
if (issueMatch) {
  const num = Number(issueMatch[1]);
  const issue = db.issues.find((row) => Number(row.number) === num);
  if (!issue) fail('Not Found');
  if (method === 'GET') {
    out(issue);
    process.exit(0);
  }
  if (method === 'PATCH') {
    if (payload && typeof payload.title === 'string') issue.title = payload.title;
    if (payload && typeof payload.body === 'string') issue.body = payload.body;
    if (payload && typeof payload.state === 'string') issue.state = payload.state;
    if (payload && Array.isArray(payload.labels)) {
      issue.labels = payload.labels.map((name) => ({ name: String(name) }));
    }
    writeDb(dbPath, db);
    out(issue);
    process.exit(0);
  }
}

const labelGetMatch = endpointPath.match(/^repos\\/jakerslam\\/protheus\\/labels\\/(.+)$/);
if (labelGetMatch && method === 'GET') {
  const name = decodeURIComponent(labelGetMatch[1]);
  if (!db.labels[name]) fail('Not Found');
  out(db.labels[name]);
  process.exit(0);
}

if (endpointPath === repoPrefix + '/labels' && method === 'POST') {
  const name = String(payload && payload.name || '');
  if (!name) fail('Validation Failed');
  db.labels[name] = {
    name,
    color: String(payload && payload.color || '1f6feb')
  };
  writeDb(dbPath, db);
  out(db.labels[name]);
  process.exit(0);
}

fail('Unsupported endpoint: ' + endpointPath + ' [' + method + ']');
`;
  fs.writeFileSync(filePath, body, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-gh-sync-'));
  ensureDir(path.join(root, 'config'));
  ensureDir(path.join(root, 'state', 'ops'));

  const registryPath = path.join(root, 'config', 'backlog_registry.json');
  writeJson(registryPath, {
    schema_id: 'backlog_registry_v1',
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    source_hash: 'abc',
    row_count: 2,
    active_count: 1,
    archive_count: 1,
    rows: [
      {
        id: 'V3-RACE-115',
        class: 'hardening',
        wave: 'V3',
        status: 'queued',
        title: 'Command Registry + Script Surface Rationalization',
        problem: 'Script sprawl causes drift.',
        acceptance: 'One canonical command registry with checks.',
        dependencies: ['V3-RACE-107']
      },
      {
        id: 'V3-RACE-050',
        class: 'hardening',
        wave: 'V3',
        status: 'done',
        title: 'Independent Safety Coprocessor',
        problem: 'Archive row should not sync by default statuses.',
        acceptance: 'N/A',
        dependencies: []
      }
    ]
  });

  const fakeGh = path.join(root, 'fake-gh.js');
  writeFakeGh(fakeGh);

  const policyPath = path.join(root, 'config', 'backlog_github_sync_policy.json');
  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    strict_default: true,
    dry_run_default: true,
    sync_statuses: ['queued', 'in_progress', 'blocked', 'proposed'],
    max_sync_rows: 50,
    paths: {
      registry_path: registryPath,
      state_path: path.join(root, 'state', 'ops', 'backlog_github_sync', 'state.json'),
      latest_path: path.join(root, 'state', 'ops', 'backlog_github_sync', 'latest.json'),
      receipts_path: path.join(root, 'state', 'ops', 'backlog_github_sync', 'receipts.jsonl')
    },
    github: {
      host: 'github.com',
      owner: 'jakerslam',
      repo: 'protheus',
      gh_bin: fakeGh,
      auth_required: true,
      issue_title_prefix: '[Backlog]',
      body_header: 'Backlog mirror test',
      base_labels: ['backlog-mirror'],
      update_labels: true,
      create_missing_labels: true,
      close_on_archive: false,
      project_sync: false,
      project_v2_id: ''
    }
  });

  return {
    root,
    policyPath,
    registryPath,
    dbPath: path.join(root, 'fake-gh-db.json')
  };
}

function runCmd(ctx, args, auth = true) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      BACKLOG_GITHUB_SYNC_POLICY_PATH: ctx.policyPath,
      FAKE_GH_DB_PATH: ctx.dbPath,
      FAKE_GH_AUTH: auth ? '1' : '0'
    }
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch {
    return null;
  }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   BACKLOG GITHUB SYNC TESTS');
console.log('═══════════════════════════════════════════════════════════');

runTest('sync --apply=1 creates issue for queued row and writes mapping state', () => {
  const ctx = makeWorkspace();
  const r = runCmd(ctx, ['sync', '--apply=1', '--strict=1']);
  assert.strictEqual(r.status, 0, `sync failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'sync should pass');
  assert.strictEqual(Number(out.created || 0), 1, 'expected one created issue');

  const state = JSON.parse(fs.readFileSync(path.join(ctx.root, 'state', 'ops', 'backlog_github_sync', 'state.json'), 'utf8'));
  assert.ok(state.issues_by_id && state.issues_by_id['V3-RACE-115'], 'state mapping missing synced id');

  const db = JSON.parse(fs.readFileSync(ctx.dbPath, 'utf8'));
  assert.strictEqual(db.issues.length, 1, 'fake gh should have one issue');
  assert.ok(String(db.issues[0].body || '').includes('backlog-mirror-id:V3-RACE-115'), 'issue body missing id marker');
});

runTest('second sync does not duplicate issue', () => {
  const ctx = makeWorkspace();
  let r = runCmd(ctx, ['sync', '--apply=1', '--strict=1']);
  assert.strictEqual(r.status, 0, `first sync failed: ${r.stderr}`);

  r = runCmd(ctx, ['sync', '--apply=1', '--strict=1']);
  assert.strictEqual(r.status, 0, `second sync failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'second sync should pass');

  const db = JSON.parse(fs.readFileSync(ctx.dbPath, 'utf8'));
  assert.strictEqual(db.issues.length, 1, 'should still have one issue');
});

runTest('check strict fails when auth is required but unavailable', () => {
  const ctx = makeWorkspace();
  const r = runCmd(ctx, ['check', '--strict=1'], false);
  assert.strictEqual(r.status, 2, 'strict check should fail without auth');
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === false, 'check payload should fail');
  assert.strictEqual(out.auth_ok, false, 'auth_ok should be false');
});

runTest('sync closes mapped issue when backlog row transitions to done', () => {
  const ctx = makeWorkspace();
  let r = runCmd(ctx, ['sync', '--apply=1', '--strict=1']);
  assert.strictEqual(r.status, 0, `first sync failed: ${r.stderr}`);

  const registry = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8'));
  registry.rows = registry.rows.map((row) => row.id === 'V3-RACE-115' ? { ...row, status: 'done' } : row);
  fs.writeFileSync(ctx.registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  r = runCmd(ctx, ['sync', '--apply=1', '--strict=1']);
  assert.strictEqual(r.status, 0, `done sync failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && Number(out.closed_done || 0) >= 1, 'expected done issue closure');

  const db = JSON.parse(fs.readFileSync(ctx.dbPath, 'utf8'));
  assert.strictEqual(String(db.issues[0].state || ''), 'closed', 'issue should be closed');
});

runTest('check strict fails when in_progress issue lacks PR link marker', () => {
  const ctx = makeWorkspace();
  const registry = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8'));
  registry.rows = registry.rows.map((row) => row.id === 'V3-RACE-115' ? { ...row, status: 'in_progress' } : row);
  fs.writeFileSync(ctx.registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  let r = runCmd(ctx, ['sync', '--apply=1', '--strict=1']);
  assert.strictEqual(r.status, 0, `sync failed: ${r.stderr}`);

  r = runCmd(ctx, ['check', '--strict=1'], true);
  assert.strictEqual(r.status, 2, 'check should fail without PR link');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === false, 'expected check failure');
  assert.ok(Number(out.pr_link_missing_count || 0) >= 1, 'missing PR link should be reported');

  const db = JSON.parse(fs.readFileSync(ctx.dbPath, 'utf8'));
  db.issues[0].body = `${String(db.issues[0].body || '')}\n\nLinked PR: https://github.com/protheuslabs/protheus/pull/123\n`;
  fs.writeFileSync(ctx.dbPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8');

  r = runCmd(ctx, ['check', '--strict=1'], true);
  assert.strictEqual(r.status, 0, 'check should pass once PR link marker is present');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected check pass');
});

if (failed) process.exit(1);

console.log('✅ backlog_github_sync tests passed');
