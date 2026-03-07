#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'root_scaffolding_rationalization.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-scaffold-'));
  const docsDir = path.join(tmp, 'docs');
  const configDir = path.join(tmp, 'config');
  const systemsOpsDir = path.join(tmp, 'systems', 'ops');
  fs.mkdirSync(path.join(tmp, 'drafts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'patches'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'research'), { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(systemsOpsDir, { recursive: true });

  fs.writeFileSync(path.join(docsDir, 'DATA_SCOPE_BOUNDARIES.md'), 'Internal lane: .internal/\n', 'utf8');

  fs.writeFileSync(path.join(systemsOpsDir, 'root_surface_contract.js'), "#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,type:'root_surface_contract'}));\n", 'utf8');
  fs.writeFileSync(path.join(systemsOpsDir, 'docs_surface_contract.js'), "#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,type:'docs_surface_contract'}));\n", 'utf8');

  const policyPath = path.join(configDir, 'root_scaffolding_rationalization_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    scaffold_dirs: {
      drafts: 'docs_required',
      notes: 'internal_only',
      patches: 'runtime_required',
      research: 'runtime_required'
    },
    internal_target_dir: '.internal/root_scaffolds',
    move_internal_on_apply: false,
    root_contract_script: path.join(tmp, 'systems', 'ops', 'root_surface_contract.js'),
    docs_contract_script: path.join(tmp, 'systems', 'ops', 'docs_surface_contract.js'),
    data_scope_doc_path: path.join(tmp, 'docs', 'DATA_SCOPE_BOUNDARIES.md'),
    require_data_scope_reference: '.internal/',
    paths: {
      latest_path: path.join(tmp, 'state', 'ops', 'root_scaffolding_rationalization', 'latest.json'),
      history_path: path.join(tmp, 'state', 'ops', 'root_scaffolding_rationalization', 'history.jsonl')
    }
  });

  let out = run(['run', '--strict=1', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.notStrictEqual(out.status, 0, 'strict run should fail when internal_only dir has not been moved');
  assert.strictEqual(out.payload.ok, false, 'expected failure before move');
  assert.ok(Array.isArray(out.payload.pending_internal_moves) && out.payload.pending_internal_moves.length === 1, 'expected one pending internal move');

  out = run(['run', '--apply=1', '--move_internal=1', '--strict=1', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'run should pass after moving internal dir');
  assert.ok(Array.isArray(out.payload.moved) && out.payload.moved.length === 1, 'expected one moved dir');

  out = run(['status', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should expose latest payload');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('root_scaffolding_rationalization.test.js: OK');
} catch (err) {
  console.error(`root_scaffolding_rationalization.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
