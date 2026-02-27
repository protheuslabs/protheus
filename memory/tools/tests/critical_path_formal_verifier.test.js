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
  const script = path.join(repoRoot, 'systems', 'security', 'critical_path_formal_verifier.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'critical-path-formal-'));

  const weaverPolicyPath = path.join(tmp, 'config', 'weaver_policy.json');
  const inversionPolicyPath = path.join(tmp, 'config', 'inversion_policy.json');
  const constitutionPolicyPath = path.join(tmp, 'config', 'constitution_guardian_policy.json');
  const formalInvariantsPath = path.join(tmp, 'config', 'formal_invariants.json');
  const weaverArbSourcePath = path.join(tmp, 'systems', 'weaver', 'arbitration_engine.ts');
  const weaverCoreSourcePath = path.join(tmp, 'systems', 'weaver', 'weaver_core.ts');
  const inversionSourcePath = path.join(tmp, 'systems', 'autonomy', 'inversion_controller.ts');
  const policyPath = path.join(tmp, 'config', 'critical_path_formal_policy.json');

  writeJson(weaverPolicyPath, {
    enabled: true,
    arbitration: {
      weights: {
        impact: 1.2,
        confidence: 1.05,
        uncertainty: 0.3,
        drift_risk: 1.15,
        cost_pressure: 1.0,
        mirror_pressure: 0.8,
        regime_alignment: 0.45
      }
    },
    monoculture_guard: { enabled: true },
    constitutional_veto: { enabled: true }
  });

  writeJson(inversionPolicyPath, {
    tier_transition: {
      enabled: true,
      first_live_uses_require_human_veto: {
        tactical: 0,
        belief: 2,
        identity: 5,
        directive: 20,
        constitution: 9999
      }
    },
    shadow_pass_gate: {
      require_for_live_apply: true,
      required_passes_by_target: {
        tactical: 0,
        belief: 2,
        identity: 5,
        directive: 10,
        constitution: 20
      }
    },
    live_graduation_ladder: {
      observer_quorum_by_target: {
        tactical: 0,
        belief: 1,
        identity: 2,
        directive: 3,
        constitution: 3
      }
    },
    guardrails: {
      objective_id_required_min_target_rank: 2
    },
    targets: {
      tactical: { rank: 1, live_enabled: true, min_shadow_hours: 0 },
      belief: { rank: 2, live_enabled: true, min_shadow_hours: 6 },
      identity: { rank: 3, live_enabled: true, min_shadow_hours: 24 },
      directive: { rank: 4, live_enabled: false, min_shadow_hours: 72 },
      constitution: { rank: 4, live_enabled: false, min_shadow_hours: 96 }
    },
    immutable_axioms: {
      enabled: true,
      axioms: [
        { id: 'preserve_root_constitution' },
        { id: 'preserve_user_sovereignty' },
        { id: 'never_self_terminate' },
        { id: 'never_bypass_guardrails' },
        { id: 'never_disable_integrity_kernel' }
      ]
    }
  });

  writeJson(constitutionPolicyPath, {
    require_dual_approval: true,
    enforce_inheritance_lock: true
  });

  writeJson(formalInvariantsPath, {
    schema_id: 'formal_invariants_spec',
    schema_version: '1.0',
    invariants: [
      { id: 'merge_guard_profile_compat_hook' },
      { id: 'scheduler_mode_dream' },
      { id: 'scheduler_mode_inversion' },
      { id: 'subexec_requires_nursery' },
      { id: 'subexec_requires_adversarial' },
      { id: 'primitive_count_cap_floor' }
    ]
  });

  write(weaverArbSourcePath, 'function applyConfiguredSoftCaps(){}\nfunction applyCombinedShareCap(){}\n');
  write(weaverCoreSourcePath, 'function evaluateConstitutionalVeto(){}\n');
  write(inversionSourcePath, 'const evaluateAxiomSemanticMatch = () => true;\n');

  writeJson(policyPath, {
    schema_id: 'critical_path_formal_policy',
    schema_version: '1.0',
    enabled: true,
    strict_fail_closed: true,
    paths: {
      weaver_policy: weaverPolicyPath,
      inversion_policy: inversionPolicyPath,
      constitution_policy: constitutionPolicyPath,
      formal_invariants: formalInvariantsPath,
      weaver_arbitration_source: weaverArbSourcePath,
      weaver_core_source: weaverCoreSourcePath,
      inversion_source: inversionSourcePath
    },
    checks: {
      required_weaver_weights: [
        'impact',
        'confidence',
        'uncertainty',
        'drift_risk',
        'cost_pressure',
        'mirror_pressure',
        'regime_alignment'
      ],
      required_axiom_ids: [
        'preserve_root_constitution',
        'preserve_user_sovereignty',
        'never_self_terminate',
        'never_bypass_guardrails',
        'never_disable_integrity_kernel'
      ],
      objective_id_required_min_target_rank: 2,
      require_shadow_pass_for_live_rank_at_least: 2,
      require_human_veto_for_live_rank_at_least: 3,
      minimum_observer_quorum_for_live_rank_at_least: 2,
      minimum_shadow_hours_for_live_rank_at_least: 2,
      required_disabled_live_targets: ['directive', 'constitution']
    },
    state_path: path.join(tmp, 'state', 'security', 'critical_path_formal', 'latest.json'),
    history_path: path.join(tmp, 'state', 'security', 'critical_path_formal', 'history.jsonl')
  });

  const env = {
    ...process.env,
    CRITICAL_PATH_FORMAL_POLICY_PATH: policyPath
  };

  const passRun = run(script, repoRoot, ['run', '--strict=1', `--policy=${policyPath}`], env);
  assert.strictEqual(passRun.status, 0, passRun.stderr || 'run should pass');
  assert.ok(passRun.payload && passRun.payload.ok === true, 'payload should be ok');
  assert.ok(Array.isArray(passRun.payload.model_rows), 'model_rows should exist');

  const broken = readJson(inversionPolicyPath, {});
  broken.targets.directive.live_enabled = true;
  writeJson(inversionPolicyPath, broken);

  const failRun = run(script, repoRoot, ['run', '--strict=1', `--policy=${policyPath}`], env);
  assert.notStrictEqual(failRun.status, 0, 'run should fail strict mode on policy violation');
  assert.ok(failRun.payload && failRun.payload.ok === false, 'payload should fail');
  const byId = new Map((failRun.payload.checks || []).map((row) => [String(row.id || ''), row]));
  assert.strictEqual(byId.get('inversion:high_risk_live_targets_disabled').ok, false, 'directive live should be blocked');

  const status = run(script, repoRoot, ['status', `--policy=${policyPath}`], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.schema_id === 'critical_path_formal_verifier_result', 'status payload schema mismatch');

  console.log('critical_path_formal_verifier.test.js: OK');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

try {
  main();
} catch (err) {
  console.error(`critical_path_formal_verifier.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
