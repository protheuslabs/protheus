#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'psycheforge', 'psycheforge_organ.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'psycheforge-organ-'));
  const policyPath = path.join(tmp, 'config', 'psycheforge_policy.json');
  const rustStub = path.join(tmp, 'rust_hot_state_stub.js');
  const rustStubLog = path.join(tmp, 'state', 'rust_hot_state_stub.jsonl');

  writeText(rustStub, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const cmd = String(args[0] || '');
const keyArg = args.find((row) => String(row).startsWith('--key=')) || '';
const key = keyArg ? keyArg.slice('--key='.length) : '';
const out = { ok: true, backend: 'rust_hot_state_stub', cmd, key };
const logPath = process.env.RUST_STUB_LOG || '';
if (logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), cmd, key }) + '\\n');
}
console.log(JSON.stringify(out));
`);
  fs.chmodSync(rustStub, 0o755);

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    default_risk_tier: 2,
    activation_tier_threshold: 3,
    rust_memory: {
      enabled: true,
      command_base: [process.execPath, rustStub],
      root: '.',
      db_path: '',
      key_prefix: 'psycheforge.profile'
    },
    encryption: {
      key_env: 'PSYCHEFORGE_PROFILE_KEY'
    },
    paths: {
      profiles_path: path.join(tmp, 'state', 'security', 'psycheforge', 'profiles.json'),
      latest_path: path.join(tmp, 'state', 'security', 'psycheforge', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'security', 'psycheforge', 'receipts.jsonl'),
      shadow_queue_path: path.join(tmp, 'state', 'security', 'psycheforge', 'shadow_queue.json'),
      promotion_path: path.join(tmp, 'state', 'security', 'psycheforge', 'promotions.jsonl'),
      guard_hint_path: path.join(tmp, 'state', 'security', 'guard', 'psycheforge_hint.json'),
      redteam_hint_path: path.join(tmp, 'state', 'redteam', 'psycheforge_hint.json'),
      venom_hint_path: path.join(tmp, 'state', 'security', 'venom', 'psycheforge_hint.json'),
      fractal_hint_path: path.join(tmp, 'state', 'fractal', 'psycheforge_hint.json')
    }
  });

  const commonEnv = {
    PSYCHEFORGE_PROFILE_KEY: 'test_psycheforge_key_material',
    RUST_STUB_LOG: rustStubLog
  };

  let res = run([
    'evaluate',
    `--policy=${policyPath}`,
    '--actor=attacker_a',
    '--telemetry_json={"probe_density":0.95,"escalation_attempts":16,"entropy_score":0.9,"signature_failures":2}',
    '--apply=1'
  ], commonEnv);
  assert.strictEqual(res.status, 0, res.stderr || res.stdout);
  assert.ok(res.payload && res.payload.ok === true, 'evaluate should pass');
  assert.strictEqual(res.payload.stage, 'shadow', 'tier3+ should stay shadow without second gate');
  assert.strictEqual(res.payload.requires_two_gate, true, 'should require two gate');
  assert.ok(res.payload.persistence && res.payload.persistence.local_persisted === true, 'local persistence should pass');
  assert.ok(res.payload.persistence.rust_hot_state && res.payload.persistence.rust_hot_state.ok === true, 'rust mirror should pass');
  const decisionId = String(res.payload.decision_id || '');
  assert.ok(decisionId, 'decision id should exist');

  res = run([
    'promote',
    `--policy=${policyPath}`,
    `--decision_id=${decisionId}`,
    '--two_gate_approved=1',
    '--apply=1'
  ], commonEnv);
  assert.strictEqual(res.status, 0, res.stderr || res.stdout);
  assert.ok(res.payload && res.payload.ok === true, 'promote should pass');
  assert.strictEqual(res.payload.to_stage, 'live', 'promotion should transition to live');

  res = run([
    'evaluate',
    `--policy=${policyPath}`,
    '--actor=attacker_b',
    '--telemetry_json={"probe_density":0.2,"escalation_attempts":1,"entropy_score":0.4,"signature_failures":0}',
    '--apply=1'
  ], commonEnv);
  assert.strictEqual(res.status, 0, res.stderr || res.stdout);
  assert.ok(res.payload && res.payload.ok === true, 'second evaluate should pass');
  assert.strictEqual(res.payload.stage, 'live', 'low-risk path should apply live');

  const profilesPath = path.join(tmp, 'state', 'security', 'psycheforge', 'profiles.json');
  const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  assert.ok(profiles.profiles && profiles.profiles.attacker_a, 'profiles should persist attacker_a');
  const row = profiles.profiles.attacker_a[0];
  assert.ok(row.envelope && row.envelope.ciphertext, 'encrypted envelope should exist');
  assert.strictEqual(row.profile, undefined, 'plaintext profile should not be stored directly');

  const guardHint = path.join(tmp, 'state', 'security', 'guard', 'psycheforge_hint.json');
  const redteamHint = path.join(tmp, 'state', 'redteam', 'psycheforge_hint.json');
  const venomHint = path.join(tmp, 'state', 'security', 'venom', 'psycheforge_hint.json');
  const fractalHint = path.join(tmp, 'state', 'fractal', 'psycheforge_hint.json');
  assert.ok(fs.existsSync(guardHint), 'guard hint should exist');
  assert.ok(fs.existsSync(redteamHint), 'redteam hint should exist');
  assert.ok(fs.existsSync(venomHint), 'venom hint should exist');
  assert.ok(fs.existsSync(fractalHint), 'fractal hint should exist');

  const rustLines = fs.readFileSync(rustStubLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(rustLines.length >= 2, 'rust hot-state bridge should be invoked');

  res = run(['status', `--policy=${policyPath}`], commonEnv);
  assert.strictEqual(res.status, 0, res.stderr || res.stdout);
  assert.ok(res.payload && res.payload.ok === true, 'status should pass');
  assert.ok(Number(res.payload.actor_count || 0) >= 2, 'status should report actors');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('psycheforge_organ.test.js: OK');
} catch (err) {
  console.error(`psycheforge_organ.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
