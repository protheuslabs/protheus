#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  for (const row of rows) {
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  }
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJsonStdout(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected JSON stdout');
  return JSON.parse(raw);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'weaver', 'weaver_core.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-core-'));
  const strategyDir = path.join(tmpRoot, 'strategies');
  const stateDir = path.join(tmpRoot, 'state', 'autonomy', 'weaver');
  const policyPath = path.join(tmpRoot, 'config', 'weaver_policy.json');
  const dualityPolicyPath = path.join(tmpRoot, 'config', 'duality_seed_policy.json');
  const dualityCodexPath = path.join(tmpRoot, 'config', 'duality_codex.txt');
  const regimePath = path.join(tmpRoot, 'state', 'autonomy', 'fractal', 'regime', 'latest.json');
  const mirrorPath = path.join(tmpRoot, 'state', 'autonomy', 'mirror_organ', 'latest.json');
  const autopausePath = path.join(tmpRoot, 'state', 'autonomy', 'budget_autopause.json');
  const ethicalPolicyPath = path.join(tmpRoot, 'config', 'ethical_reasoning_policy.json');
  const ethicalStateDir = path.join(tmpRoot, 'state', 'autonomy', 'ethical_reasoning');
  const historyPath = path.join(stateDir, 'history.jsonl');
  const activeOverlayPath = path.join(stateDir, 'strategy_overlay.json');
  const axisLedgerPath = path.join(stateDir, 'value_axis_switches.jsonl');

  writeJson(path.join(strategyDir, 'default.json'), {
    version: '1.0',
    id: 'default_general',
    status: 'active',
    objective: {
      primary: 'Maximize useful outcomes for users while staying safe.'
    },
    risk_policy: {
      allowed_risks: ['low', 'medium'],
      max_risk_per_action: 60
    },
    value_currency_policy: {
      default_currency: 'revenue'
    }
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    allow_apply: true,
    metric_schema: {
      include_builtin_metrics: true,
      min_metric_weight: 0.04,
      default_primary_metric: 'adaptive_value',
      extra_metrics: [
        {
          metric_id: 'beauty',
          label: 'Beauty',
          default_weight: 0.08
        }
      ]
    },
    arbitration: {
      floor_share: 0.04,
      soft_caps: [
        {
          value_currency: 'revenue',
          max_share: 0.6
        }
      ],
      max_uncertainty_exploration_share: 0.2,
      exploration_uncertainty_threshold: 0.3,
      block_unsafe_high_reward: true,
      unsafe_high_reward_impact_threshold: 0.8,
      unsafe_high_reward_drift_threshold: 0.25,
      max_unsafe_high_reward_share: 0.08,
      currency_profiles: {
        learning: {
          uncertainty_bias: 0.08,
          drift_risk_bias: -0.04
        }
      },
      weights: {
        impact: 1.2,
        confidence: 1.05,
        uncertainty: 0.35,
        drift_risk: 1.15,
        cost_pressure: 1,
        mirror_pressure: 0.8,
        regime_alignment: 0.45
      }
    },
    monoculture_guard: {
      enabled: true,
      window_days: 21,
      max_single_metric_share: 0.62,
      metric_caps: {},
      currency_caps: {}
    },
    constitutional_veto: {
      enabled: true,
      deny_on_directive_decision: ['deny'],
      deny_on_identity_block: true,
      fallback_block_on_error: true
    },
    creative_routing: {
      enabled: true,
      prefer_right_for_metric_ids: ['beauty', 'learning', 'truth_seeking'],
      prefer_right_for_currencies: ['learning', 'user_value'],
      task_class_default: 'general',
      task_class_creative: 'creative',
      persist_decisions: false
    },
    pathways: {
      enabled: true,
      min_share_for_active: 0.08,
      dormant_after_days: 1,
      archive_candidate_after_days: 2,
      atrophy_gain_per_day: 0.5
    },
    outputs: {
      emit_events: true,
      write_preview_overlay: true,
      emit_ide_events: true,
      emit_obsidian_projection: true
    }
  });
  writeFile(dualityCodexPath, [
    '[meta]',
    'version=1.0-test',
    '',
    '[flux_pairs]',
    'order|chaos|yin_attrs=structure,stability|yang_attrs=novelty,exploration'
  ].join('\n'));
  writeJson(dualityPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    advisory_only: true,
    codex_path: dualityCodexPath,
    state: {
      latest_path: path.join(tmpRoot, 'state', 'autonomy', 'duality', 'latest.json'),
      history_path: path.join(tmpRoot, 'state', 'autonomy', 'duality', 'history.jsonl')
    },
    integration: {
      weaver_arbitration: true
    }
  });

  writeJson(regimePath, {
    selected_regime: 'constrained_budget',
    candidate_confidence: 0.78,
    context: {
      trit: { trit: 1 },
      autopause: { active: true }
    }
  });
  writeJson(mirrorPath, {
    pressure_score: 0.22,
    reasons: ['yield_pressure_elevated']
  });
  writeJson(autopausePath, {
    active: true,
    until_ms: Date.now() + (10 * 60 * 1000)
  });
  writeJson(ethicalPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    thresholds: {
      monoculture_warn_share: 0.6,
      high_impact_share: 0.7,
      maturity_min_for_prior_updates: 0.4,
      mirror_pressure_warn: 0.55
    },
    value_priors: {
      adaptive_value: 0.2,
      user_value: 0.2,
      quality: 0.2,
      learning: 0.2,
      delivery: 0.2
    },
    max_prior_delta_per_run: 0.03,
    integration: {
      weaver_latest_path: path.join(stateDir, 'latest.json'),
      mirror_latest_path: mirrorPath
    }
  });

  appendJsonl(historyPath, Array.from({ length: 12 }).map((_, i) => ({
    ts: new Date(Date.now() - ((i + 1) * 60 * 60 * 1000)).toISOString(),
    primary_metric_id: 'revenue',
    value_currency: 'revenue'
  })));
  appendJsonl(historyPath, [
    {
      ts: new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString(),
      primary_metric_id: 'learning',
      value_currency: 'learning'
    }
  ]);

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    WEAVER_POLICY_PATH: policyPath,
    WEAVER_STATE_DIR: stateDir,
    WEAVER_HISTORY_PATH: historyPath,
    WEAVER_ACTIVE_OVERLAY_PATH: activeOverlayPath,
    WEAVER_REGIME_LATEST_PATH: regimePath,
    WEAVER_MIRROR_LATEST_PATH: mirrorPath,
    WEAVER_AUTOPAUSE_PATH: autopausePath,
    ETHICAL_REASONING_POLICY_PATH: ethicalPolicyPath,
    ETHICAL_REASONING_STATE_DIR: ethicalStateDir,
    DUALITY_SEED_POLICY_PATH: dualityPolicyPath
  };

  const run1 = runNode(scriptPath, [
    'run',
    '2026-02-26',
    '--objective-id=test_objective',
    '--value-metrics=revenue:1,learning:1,user_value:0.8'
  ], env, repoRoot);
  assert.strictEqual(run1.status, 0, run1.stderr || 'run1 should pass');
  const out1 = parseJsonStdout(run1);
  assert.strictEqual(out1.ok, true);
  assert.strictEqual(out1.type, 'weaver_run');
  assert.ok(out1.value_context && out1.value_context.value_currency, 'value context should be present');
  assert.ok(
    Array.isArray(out1.value_context.reason_codes)
      && out1.value_context.reason_codes.includes('uncertainty_exploration_capped'),
    'uncertainty exploration cap should emit reason code'
  );
  assert.ok(
    out1.value_context.reason_codes.includes('unsafe_high_reward_blocked'),
    'unsafe high-reward cap should emit reason code'
  );
  assert.strictEqual(
    out1.value_context.monoculture_guard && out1.value_context.monoculture_guard.triggered,
    true,
    'monoculture guard should trigger on revenue dominance'
  );
  assert.strictEqual(out1.veto_blocked, false, 'constitution/identity veto should not block healthy run');
  assert.ok(out1.value_context && out1.value_context.duality, 'duality advisory should be present');
  assert.strictEqual(typeof out1.value_context.duality.enabled, 'boolean');
  assert.ok(out1.ethical_reasoning && out1.ethical_reasoning.enabled === true, 'ethical reasoning should be attached');
  assert.ok(
    out1.ethical_reasoning.summary && typeof out1.ethical_reasoning.summary.top_metric_id === 'string',
    'ethical summary should include top metric'
  );
  assert.ok(
    out1.value_context
      && out1.value_context.creative_route
      && typeof out1.value_context.creative_route.selected_live_brain === 'string',
    'creative route metadata should be present'
  );
  const revenueRow = (out1.value_context.allocations || []).find((row) => String(row.value_currency) === 'revenue');
  assert.ok(revenueRow, 'expected revenue row');
  assert.ok(Number(revenueRow.share || 0) <= 0.62 + 1e-6, 'revenue share should be capped by guard');
  const requestedSwitchMetric = String(out1.value_context && out1.value_context.primary_metric_id) === 'beauty'
    ? 'learning'
    : 'beauty';

  const run2 = runNode(scriptPath, [
    'run',
    '2026-02-26',
    '--objective-id=creative_focus',
    '--value-metrics=beauty:1,revenue:0.2,learning:0.4',
    `--primary-metric=${requestedSwitchMetric}`,
    '--apply=1'
  ], env, repoRoot);
  assert.strictEqual(run2.status, 0, run2.stderr || 'run2 should pass');
  const out2 = parseJsonStdout(run2);
  assert.strictEqual(out2.ok, true);
  const beautyRow = (out2.value_context.allocations || []).find((row) => String(row.metric_id) === 'beauty');
  assert.ok(beautyRow, 'custom metric should exist in allocations');
  assert.strictEqual(out2.veto_blocked, false, 'creative run should not be vetoed');
  assert.ok(
    out2.value_context
      && out2.value_context.pathways
      && typeof out2.value_context.pathways.state_path === 'string',
    'pathway state markers should exist'
  );
  assert.ok(fs.existsSync(activeOverlayPath), 'apply=1 should write active overlay');
  assert.ok(fs.existsSync(axisLedgerPath), 'metric switch should be recorded in axis ledger');
  const overlay = JSON.parse(fs.readFileSync(activeOverlayPath, 'utf8'));
  assert.strictEqual(overlay.enabled, true, 'active overlay must be enabled');
  assert.ok(
    overlay.strategy_policy
      && overlay.strategy_policy.value_currency_policy_overrides
      && overlay.strategy_policy.value_currency_policy_overrides.default_currency,
    'overlay should include value currency overrides'
  );

  const status = runNode(scriptPath, ['status', 'latest'], env, repoRoot);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  const statusOut = parseJsonStdout(status);
  assert.strictEqual(statusOut.ok, true);
  assert.ok(statusOut.primary_metric_id, 'status should expose primary metric');
  assert.ok(typeof statusOut.veto_blocked === 'boolean', 'status should expose veto state');
  assert.ok(statusOut.latest_axis_switch && typeof statusOut.latest_axis_switch === 'object', 'status should expose latest axis switch');
  assert.strictEqual(
    String(statusOut.latest_axis_switch.requested_metric_id || ''),
    requestedSwitchMetric,
    'latest axis switch should track requested metric'
  );

  console.log('weaver_core.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`weaver_core.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
