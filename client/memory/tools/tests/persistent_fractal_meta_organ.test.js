#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'persistent_fractal_meta_organ.js');

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function run(args, env) {
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

function makeScript(filePath, body) {
  writeText(filePath, body);
  fs.chmodSync(filePath, 0o755);
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-fractal-meta-organ-'));
  const stubsDir = path.join(tmp, 'stubs');
  const stateDir = path.join(tmp, 'state');
  const policyPath = path.join(tmp, 'config', 'persistent_fractal_meta_organ_policy.json');

  const loopScript = path.join(stubsDir, 'loop_stub.js');
  makeScript(loopScript, `#!/usr/bin/env node
'use strict';
const cmd = String(process.argv[2] || '');
if (cmd === 'propose') {
  const targetArg = process.argv.find((row) => String(row).startsWith('--target-path=')) || '';
  const target = targetArg.slice('--target-path='.length) || 'unknown';
  const id = 'p_' + Buffer.from(target).toString('hex').slice(0, 8);
  console.log(JSON.stringify({ ok: true, type: 'gated_self_improvement_propose', proposal_id: id }));
  process.exit(0);
}
if (cmd === 'run') {
  const idArg = process.argv.find((row) => String(row).startsWith('--proposal-id=')) || '';
  const proposalId = idArg.slice('--proposal-id='.length) || null;
  const applyArg = process.argv.find((row) => String(row).startsWith('--apply=')) || '--apply=0';
  const apply = applyArg.endsWith('=1');
  console.log(JSON.stringify({
    ok: true,
    type: 'gated_self_improvement_run',
    proposal_id: proposalId,
    stage: apply ? 'live' : 'shadow_simulated',
    status: apply ? 'live_ready' : 'gated_pass',
    applied: apply
  }));
  process.exit(0);
}
console.log(JSON.stringify({ ok: false, error: 'unknown_cmd', cmd }));
process.exit(2);
`);

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    allow_live_apply: false,
    objective_id: 'persistent_fractal_meta_organ',
    trigger: {
      allowed_sources: ['nightly', 'high_success_receipt'],
      cooldown_minutes: 0
    },
    mutation_domains: [
      { id: 'habit_code', target_path: 'client/systems/a.ts', risk: 'medium', summary: 'm1' },
      { id: 'memory_schema', target_path: 'client/systems/b.ts', risk: 'medium', summary: 'm2' },
      { id: 'routing_policy', target_path: 'client/systems/c.ts', risk: 'medium', summary: 'm3' }
    ],
    scripts: {
      loop_script: loopScript
    },
    paths: {
      state_path: path.join(stateDir, 'meta_organ', 'state.json'),
      latest_path: path.join(stateDir, 'meta_organ', 'latest.json'),
      receipts_path: path.join(stateDir, 'meta_organ', 'receipts.jsonl')
    }
  });

  let out = run(['run', `--policy=${policyPath}`, '--source=nightly', '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'run should pass');
  assert.strictEqual(out.payload.triggered, true, 'nightly source should trigger');
  assert.strictEqual(Number(out.payload.proposals_created || 0), 3, 'should create 3 proposals');
  assert.strictEqual(Number(out.payload.shadow_trials_executed || 0), 3, 'should execute 3 shadow trials');
  assert.strictEqual(Number(out.payload.promotions_succeeded || 0), 0, 'live apply should be blocked by policy');

  out = run(['run', `--policy=${policyPath}`, '--source=manual']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.triggered === false, 'manual source should not trigger');
  assert.strictEqual(out.payload.gate.checks.source_allowed, false);

  const livePolicyPath = path.join(tmp, 'config', 'persistent_fractal_meta_organ_live_policy.json');
  writeJson(livePolicyPath, {
    ...JSON.parse(fs.readFileSync(policyPath, 'utf8')),
    allow_live_apply: true
  });

  out = run(['run', `--policy=${livePolicyPath}`, '--source=high_success_receipt', '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.triggered === true, 'high_success_receipt should trigger');
  assert.strictEqual(Number(out.payload.promotions_succeeded || 0), 3, 'live apply should promote all candidates in stub');

  out = run(['status', `--policy=${livePolicyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.state && Number(out.payload.state.runs || 0) >= 2, 'status should expose run counters');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('persistent_fractal_meta_organ.test.js: OK');
} catch (err) {
  console.error(`persistent_fractal_meta_organ.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
