#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'self_improvement_cadence_orchestrator.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-improvement-cadence-'));
  const stubs = path.join(tmp, 'stubs');
  const stateRoot = path.join(tmp, 'state');
  const triggerRoot = path.join(tmp, 'trigger');

  const observerScript = path.join(stubs, 'observer_stub.js');
  mkStubScript(observerScript, `#!/usr/bin/env node\n'use strict';\nconsole.log(JSON.stringify({ ok: true, type: 'observer_mirror_run', mood: 'stable' }));\n`);

  const loopScript = path.join(stubs, 'loop_stub.js');
  mkStubScript(loopScript, `#!/usr/bin/env node\n'use strict';\nconst cmd = String(process.argv[2] || '');\nif (cmd === 'propose') {\n  const targetArg = process.argv.find((row) => String(row).startsWith('--target-path=')) || '';\n  const target = targetArg.slice('--target-path='.length) || 'unknown';\n  const id = 'prp_' + Buffer.from(target).toString('hex').slice(0, 8);\n  console.log(JSON.stringify({ ok: true, type: 'gated_self_improvement_propose', proposal_id: id }));\n  process.exit(0);\n}\nif (cmd === 'run') {\n  const proposalArg = process.argv.find((row) => String(row).startsWith('--proposal-id=')) || '';\n  const proposalId = proposalArg.slice('--proposal-id='.length) || null;\n  const applyArg = process.argv.find((row) => String(row).startsWith('--apply=')) || '--apply=0';\n  const apply = applyArg.endsWith('=1');\n  console.log(JSON.stringify({ ok: true, type: 'gated_self_improvement_run', proposal_id: proposalId, applied: apply, stage: apply ? 'applied' : 'shadow_simulated' }));\n  process.exit(0);\n}\nconsole.log(JSON.stringify({ ok: false, error: 'unknown_cmd', cmd }));\nprocess.exit(2);\n`);

  const distillerScript = path.join(stubs, 'distiller_stub.js');
  mkStubScript(distillerScript, `#!/usr/bin/env node\n'use strict';\nconsole.log(JSON.stringify({ ok: true, type: 'trajectory_skill_distill', profile_id: 'distill_test' }));\n`);

  const policyPath = path.join(tmp, 'config', 'self_improvement_cadence_policy.json');
  const gatedLatestPath = path.join(triggerRoot, 'gated_latest.json');
  const strategyScorecardPath = path.join(triggerRoot, 'strategy_latest.json');
  const triggerStatePath = path.join(stateRoot, 'self_improvement_cadence', 'trigger_state.json');
  writeJson(gatedLatestPath, {
    ok: true,
    evidence_pack: {
      confidence: {
        value: 1
      }
    }
  });
  writeJson(strategyScorecardPath, {
    top_strategies: [
      {
        strategy_id: 'default_general',
        score: 42,
        confidence: 1
      }
    ]
  });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_first: true,
    cadence_minutes: 30,
    max_cycles_per_run: 1,
    proposal_cap_per_cycle: 2,
    apply_cap_per_cycle: 1,
    objective_id: 'test_self_improvement',
    target_paths: ['systems/a.ts', 'systems/b.ts', 'systems/c.ts'],
    timeout_ms_per_step: 10000,
    quiet_hours: {
      enabled: false,
      start_hour_local: 22,
      end_hour_local: 7
    },
    budget_guard: {
      max_cycles_per_day: 5,
      max_proposals_per_day: 10,
      max_applies_per_day: 3
    },
    scripts: {
      observer: observerScript,
      loop: loopScript,
      distiller: distillerScript
    },
    event_trigger: {
      enabled: true,
      shadow_only: true,
      min_confidence: 0.997,
      min_strategy_confidence: 0.8,
      min_strategy_score: 30,
      cooldown_minutes: 120,
      allowed_sources: ['manual', 'high_success_receipt'],
      paths: {
        gated_loop_latest_path: gatedLatestPath,
        strategy_scorecard_latest_path: strategyScorecardPath,
        trigger_state_path: triggerStatePath
      }
    },
    outputs: {
      state_path: path.join(stateRoot, 'self_improvement_cadence', 'state.json'),
      latest_path: path.join(stateRoot, 'self_improvement_cadence', 'latest.json'),
      receipts_path: path.join(stateRoot, 'self_improvement_cadence', 'receipts.jsonl')
    }
  });

  let out = run(['run', '2026-02-28', '--apply=1', `--policy=${policyPath}`], {
    SELF_IMPROVEMENT_CADENCE_POLICY_PATH: policyPath,
    SELF_IMPROVEMENT_CADENCE_NOW_ISO: '2026-02-28T12:00:00.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr || 'run should succeed');
  assert.ok(out.payload && out.payload.ok === true, 'run payload should be ok');
  assert.strictEqual(Number(out.payload.cycles_executed || 0), 1, 'should execute one cycle');
  assert.strictEqual(Number(out.payload.proposals_created || 0), 2, 'proposal cap should apply');
  assert.strictEqual(Number(out.payload.applies_executed || 0), 0, 'shadow_first should block apply');
  assert.strictEqual(Number(out.payload.trial_cells_generated || 0), 2, 'trial cells should be generated');
  assert.ok(Array.isArray(out.payload.cycles[0].trial_cells), 'cycle should expose trial cells');
  assert.strictEqual(Number(out.payload.cycles[0].trial_cells.length || 0), 2, 'cycle trial cell count should match proposals');

  const policyApplyPath = path.join(tmp, 'config', 'self_improvement_cadence_apply_policy.json');
  writeJson(policyApplyPath, {
    ...JSON.parse(fs.readFileSync(policyPath, 'utf8')),
    shadow_first: false,
    budget_guard: {
      max_cycles_per_day: 5,
      max_proposals_per_day: 10,
      max_applies_per_day: 1
    }
  });

  out = run(['run', '2026-03-01', '--apply=1', '--max-cycles=1', `--policy=${policyApplyPath}`], {
    SELF_IMPROVEMENT_CADENCE_POLICY_PATH: policyApplyPath,
    SELF_IMPROVEMENT_CADENCE_NOW_ISO: '2026-03-01T12:00:00.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr || 'apply run should succeed');
  assert.ok(out.payload && out.payload.ok === true, 'apply payload should be ok');
  assert.strictEqual(Number(out.payload.applies_executed || 0), 1, 'apply cap should allow one apply');

  const quietPolicyPath = path.join(tmp, 'config', 'self_improvement_cadence_quiet_policy.json');
  writeJson(quietPolicyPath, {
    ...JSON.parse(fs.readFileSync(policyPath, 'utf8')),
    quiet_hours: {
      enabled: true,
      start_hour_local: 10,
      end_hour_local: 13
    }
  });

  out = run(['run', '2026-03-02', `--policy=${quietPolicyPath}`], {
    SELF_IMPROVEMENT_CADENCE_POLICY_PATH: quietPolicyPath,
    SELF_IMPROVEMENT_CADENCE_NOW_ISO: '2026-03-02T12:10:00.000'
  });
  assert.strictEqual(out.status, 0, out.stderr || 'quiet-hours run should succeed');
  assert.ok(out.payload && out.payload.skipped === true, 'quiet-hours should skip cycle');
  assert.strictEqual(String(out.payload.skip_reason || ''), 'quiet_hours');

  const triggerOut = run(['trigger', '2026-03-03', '--source=manual', `--policy=${policyPath}`], {
    SELF_IMPROVEMENT_CADENCE_POLICY_PATH: policyPath,
    SELF_IMPROVEMENT_CADENCE_NOW_ISO: '2026-03-03T12:00:00.000Z'
  });
  assert.strictEqual(triggerOut.status, 0, triggerOut.stderr || 'trigger should succeed');
  assert.ok(triggerOut.payload && triggerOut.payload.triggered === true, 'trigger should execute run');
  assert.strictEqual(triggerOut.payload.apply_allowed, false, 'trigger shadow mode should block apply');
  assert.ok(triggerOut.payload.run_result && triggerOut.payload.run_result.ok === true, 'trigger should include run result');

  const cooldownOut = run(['trigger', '2026-03-03', '--source=manual', `--policy=${policyPath}`], {
    SELF_IMPROVEMENT_CADENCE_POLICY_PATH: policyPath,
    SELF_IMPROVEMENT_CADENCE_NOW_ISO: '2026-03-03T12:15:00.000Z'
  });
  assert.strictEqual(cooldownOut.status, 0, cooldownOut.stderr || 'cooldown trigger should still return success envelope');
  assert.ok(cooldownOut.payload && cooldownOut.payload.triggered === false, 'cooldown should block immediate re-trigger');
  assert.strictEqual(cooldownOut.payload.gate.checks.cooldown_ok, false, 'cooldown gate should fail');

  const statusOut = run(['status', `--policy=${policyPath}`], {
    SELF_IMPROVEMENT_CADENCE_POLICY_PATH: policyPath
  });
  assert.strictEqual(statusOut.status, 0, statusOut.stderr || 'status should succeed');
  assert.ok(statusOut.payload && statusOut.payload.ok === true, 'status payload should be ok');
  assert.ok(statusOut.payload.paths && statusOut.payload.paths.state_path, 'status should include state path');

  console.log('self_improvement_cadence_orchestrator.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`self_improvement_cadence_orchestrator.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
