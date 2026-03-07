#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'memory_index_freshness_gate.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-freshness-'));
  const memoryDir = path.join(tmp, 'memory');
  const stateRoot = path.join(tmp, 'state');
  const policyPath = path.join(tmp, 'config', 'memory_index_freshness_policy.json');
  const memoryIndexPath = path.join(memoryDir, 'MEMORY_INDEX.md');
  const tagsIndexPath = path.join(memoryDir, 'TAGS_INDEX.md');
  const rebuildScript = path.join(tmp, 'scripts', 'rebuild.js');
  const dailyPathA = path.join(memoryDir, '2026-02-28.md');
  const dailyPathB = path.join(memoryDir, '2026-03-01.md');

  writeText(dailyPathA, '---\ndate: 2026-02-28\nnode_id: n1\ntags: [memory]\n---\n# n1\n');
  writeText(dailyPathB, '---\ndate: 2026-03-01\nnode_id: n2\ntags: [memory]\n---\n# n2\n');
  writeText(memoryIndexPath, '# MEMORY_INDEX\n');
  writeText(tagsIndexPath, '# TAGS_INDEX\n');

  const oldMs = Date.parse('2026-02-20T00:00:00.000Z');
  fs.utimesSync(memoryIndexPath, oldMs / 1000, oldMs / 1000);
  fs.utimesSync(tagsIndexPath, oldMs / 1000, oldMs / 1000);

  writeText(rebuildScript, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const root = process.env.FRESHNESS_TEST_ROOT;
if (!root) process.exit(2);
const memoryDir = path.join(root, 'memory');
fs.mkdirSync(memoryDir, { recursive: true });
fs.writeFileSync(path.join(memoryDir, 'MEMORY_INDEX.md'), '# rebuilt memory index\\n', 'utf8');
fs.writeFileSync(path.join(memoryDir, 'TAGS_INDEX.md'), '# rebuilt tags index\\n', 'utf8');
`);
  fs.chmodSync(rebuildScript, 0o755);

  writeJson(policyPath, {
    enabled: true,
    shadow_only: false,
    auto_rebuild_on_violation: true,
    thresholds: {
      max_index_age_hours: 24,
      max_daily_files_since_rebuild: 1
    },
    paths: {
      memory_dir: memoryDir,
      memory_index_path: memoryIndexPath,
      tags_index_path: tagsIndexPath,
      rebuild_script: rebuildScript,
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      rebuild_history_path: path.join(stateRoot, 'rebuild_history.jsonl'),
      last_rebuild_state_path: path.join(stateRoot, 'last_rebuild.json')
    }
  });

  const env = {
    FRESHNESS_TEST_ROOT: tmp,
    PROTHEUS_NOW_ISO: '2026-03-01T20:00:00.000Z'
  };

  let out = run(['run', `--policy=${policyPath}`, '--strict=0', '--apply=0'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === false, 'stale index should fail freshness');
  assert.ok(Array.isArray(out.payload.before.stale_reasons) && out.payload.before.stale_reasons.length > 0, 'stale reasons should be present');

  out = run(['run', `--policy=${policyPath}`, '--strict=1', '--apply=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'apply run should rebuild and pass');
  assert.ok(out.payload.rebuild && out.payload.rebuild.ok === true, 'rebuild should be executed');
  assert.strictEqual(out.payload.after.stale, false, 'freshness should pass after rebuild');

  out = run(['status', `--policy=${policyPath}`], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest && out.payload.latest.type === 'memory_index_freshness_gate', 'status should expose latest gate run');
  assert.ok(out.payload.last_rebuild && out.payload.last_rebuild.last_rebuild_ts, 'status should expose rebuild state');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('memory_index_freshness_gate.test.js: OK');
} catch (err) {
  console.error(`memory_index_freshness_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
