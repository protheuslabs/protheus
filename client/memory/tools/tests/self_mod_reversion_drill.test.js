#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'self_mod_reversion_drill.js');

function writeFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
    status: Number(proc.status || 0),
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

function mkStubScript(filePath, src) {
  writeFile(filePath, src);
  fs.chmodSync(filePath, 0o755);
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-mod-reversion-drill-'));
  const loopStub = path.join(tmp, 'loop_stub.js');
  mkStubScript(loopStub, `#!/usr/bin/env node\n'use strict';\nconst cmd = String(process.argv[2] || '');\nif (cmd === 'rollback') {\n  const proposalArg = process.argv.find((row) => String(row).startsWith('--proposal-id=')) || '';\n  const proposalId = proposalArg.slice('--proposal-id='.length) || null;\n  console.log(JSON.stringify({ ok: true, type: 'gated_self_improvement_rollback', proposal_id: proposalId, stage: 'shadow_rollback', receipt_id: 'rct_' + proposalId }));\n  process.exit(0);\n}\nif (cmd === 'status') {\n  console.log(JSON.stringify({ ok: true, type: 'gated_self_improvement_status' }));\n  process.exit(0);\n}\nconsole.log(JSON.stringify({ ok: false, error: 'unknown_cmd', cmd }));\nprocess.exit(2);\n`);

  const policyPath = path.join(tmp, 'config', 'self_mod_reversion_drill_policy.json');
  const latestPath = path.join(tmp, 'state', 'drill', 'latest.json');
  const receiptsPath = path.join(tmp, 'state', 'drill', 'receipts.jsonl');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    sla_minutes: 5,
    freshness_days: 7,
    timeout_ms: 10000,
    scripts: {
      loop: loopStub
    },
    latest_state_paths: {
      gated_self_improvement_policy_path: path.join(tmp, 'config', 'gated_self_improvement_policy.json')
    },
    outputs: {
      latest_path: latestPath,
      receipts_path: receiptsPath
    }
  });

  let out = run(['run', '--proposal-id=proposal_1', '--apply=1', `--policy=${policyPath}`], {
    SELF_MOD_REVERSION_DRILL_POLICY_PATH: policyPath,
    SELF_MOD_REVERSION_NOW_ISO: '2026-03-03T12:00:00.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr || 'run should pass');
  assert.ok(out.payload && out.payload.ok === true, 'run payload should be ok');
  assert.strictEqual(String(out.payload.proposal_id || ''), 'proposal_1');
  assert.strictEqual(out.payload.within_sla, true, 'drill should be within sla');
  assert.ok(fs.existsSync(latestPath), 'latest should be written');
  assert.ok(fs.existsSync(receiptsPath), 'receipts should be written');

  out = run(['status', `--policy=${policyPath}`], {
    SELF_MOD_REVERSION_DRILL_POLICY_PATH: policyPath,
    SELF_MOD_REVERSION_NOW_ISO: '2026-03-03T12:10:00.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  assert.ok(out.payload && out.payload.ok === true, 'status payload should be ok');
  assert.strictEqual(Boolean(out.payload.freshness && out.payload.freshness.stale), false, 'fresh run should not be stale');

  out = run(['status', `--policy=${policyPath}`], {
    SELF_MOD_REVERSION_DRILL_POLICY_PATH: policyPath,
    SELF_MOD_REVERSION_NOW_ISO: '2026-03-20T12:00:00.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr || 'status stale should pass');
  assert.strictEqual(Boolean(out.payload.freshness && out.payload.freshness.stale), true, 'stale run should be flagged');
  assert.strictEqual(Boolean(out.payload.freshness && out.payload.freshness.promotion_blocked), true, 'stale drill should block promotion');

  console.log('self_mod_reversion_drill.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`self_mod_reversion_drill.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
