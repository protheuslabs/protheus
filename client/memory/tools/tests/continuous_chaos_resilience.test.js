#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function run(script, cwd, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'ops', 'continuous_chaos_resilience.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuous-chaos-'));
  const policyPath = path.join(tmp, 'config', 'continuous_chaos_resilience_policy.json');
  const chaosPolicyPath = path.join(tmp, 'config', 'chaos_program_policy.json');
  const fakeChaosScript = path.join(tmp, 'scripts', 'fake_chaos_program.js');

  write(fakeChaosScript, `#!/usr/bin/env node\n'use strict';\nconst arg = process.argv.find((v) => String(v).startsWith('--scenario='));\nconst id = arg ? String(arg).split('=')[1] : 'unknown';\nconst fail = String(process.env.CHAOS_FAIL_SCENARIO || '').trim();\nconst pass = fail ? id !== fail : true;\nconst out = {\n  ok: pass,\n  type: 'chaos_program_run',\n  rows: [{\n    scenario_id: id,\n    pass,\n    recovered: pass,\n    integrity_ok: true,\n    recovery: { duration_ms: pass ? 1200 : 64000 }\n  }]\n};\nprocess.stdout.write(JSON.stringify(out));\nprocess.exit(pass ? 0 : 0);\n`);

  writeJson(chaosPolicyPath, {
    version: '1.0',
    scenarios: [
      {
        id: 'alpha_fault',
        lane: 'alpha',
        fault: 'alpha_sim',
        recovery_command: 'runbook_alpha',
        timeout_ms: 5000
      }
    ]
  });

  writeJson(policyPath, {
    schema_id: 'continuous_chaos_resilience_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: false,
    strict_default: false,
    chaos_program_script: fakeChaosScript,
    chaos_program_policy: chaosPolicyPath,
    max_scenarios_per_tick: 2,
    scenario_cadence_minutes: {
      alpha_fault: 1
    },
    gate: {
      window_runs: 10,
      min_samples: 2,
      required_pass_rate: 0.75,
      max_failed_runs: 1,
      max_recovery_p95_ms: 45000
    },
    outputs: {
      state_path: path.join(tmp, 'state', 'ops', 'continuous_chaos_resilience', 'state.json'),
      latest_path: path.join(tmp, 'state', 'ops', 'continuous_chaos_resilience', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'ops', 'continuous_chaos_resilience', 'receipts.jsonl'),
      gate_receipts_path: path.join(tmp, 'state', 'ops', 'continuous_chaos_resilience', 'gate_receipts.jsonl')
    }
  });

  const envPass = {
    ...process.env,
    CONTINUOUS_CHAOS_ROOT: tmp,
    CONTINUOUS_CHAOS_POLICY_PATH: policyPath,
    CHAOS_FAIL_SCENARIO: ''
  };

  const tickPass = run(script, repoRoot, ['tick', '--apply=0', '--strict=0', `--policy=${policyPath}`], envPass);
  assert.strictEqual(tickPass.status, 0, tickPass.stderr || 'first tick should pass');
  assert.ok(tickPass.payload && tickPass.payload.ok === true, 'first tick payload should be ok');
  assert.strictEqual(Number(tickPass.payload.executed_count || 0), 1, 'one scenario should execute');
  assert.strictEqual(String(tickPass.payload.executed[0].runbook_action || ''), 'runbook_alpha', 'runbook action should be attached');

  const envFail = {
    ...envPass,
    CHAOS_FAIL_SCENARIO: 'alpha_fault'
  };
  const tickFail = run(script, repoRoot, ['tick', '--apply=0', '--strict=0', `--policy=${policyPath}`], envFail);
  assert.strictEqual(tickFail.status, 0, tickFail.stderr || 'second tick should complete');
  assert.ok(tickFail.payload && tickFail.payload.ok === false, 'second tick should record failure');

  const gate = run(script, repoRoot, ['gate', '--strict=0', `--policy=${policyPath}`], envFail);
  assert.strictEqual(gate.status, 0, gate.stderr || 'gate should execute');
  assert.ok(gate.payload && gate.payload.ok === false, 'gate should fail after regression');
  assert.strictEqual(gate.payload.evaluation.promotion_blocked, true, 'promotion should be blocked');

  const status = run(script, repoRoot, ['status', `--policy=${policyPath}`], envFail);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.ok(status.payload.gate && status.payload.gate.samples >= 2, 'status should expose gate sample count');

  console.log('continuous_chaos_resilience.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`continuous_chaos_resilience.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
