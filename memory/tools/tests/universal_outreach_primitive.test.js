#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(scriptPath, args, env, cwd) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
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
  const root = path.resolve(__dirname, '..', '..', '..');
  const outreachScript = path.join(root, 'systems', 'workflow', 'universal_outreach_primitive.js');
  const disposableScript = path.join(root, 'systems', 'actuation', 'disposable_infrastructure_organ.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-outreach-'));

  const disposablePolicyPath = path.join(tmp, 'disposable_policy.json');
  const outreachPolicyPath = path.join(tmp, 'outreach_policy.json');
  const burnLatestPath = path.join(tmp, 'burn', 'latest.json');

  writeJson(disposablePolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    pools: {
      accounts: {
        max_active: 4,
        providers_allowed: ['gmail'],
        warmup_days_min: 3
      },
      proxies: {
        max_active: 4,
        providers_allowed: ['residential_pool']
      }
    },
    state: {
      state_path: path.join(tmp, 'disposable', 'state.json'),
      latest_path: path.join(tmp, 'disposable', 'latest.json'),
      receipts_path: path.join(tmp, 'disposable', 'receipts.jsonl'),
      sessions_path: path.join(tmp, 'disposable', 'sessions.jsonl')
    }
  });

  writeJson(outreachPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    max_leads_per_batch: 20,
    min_personalization_score: 0.5,
    high_burn_batch_cap: 3,
    critical_burn_batch_cap: 1,
    autonomous_execution: {
      enabled: true,
      medium_veto_window_minutes: 0,
      high_risk_min_approval_note_chars: 12,
      default_cost_per_lead_usd: 8,
      default_liability_score: 0.35,
      allow_gate_timeout_low_medium: true,
      workflow_class_default: 'revenue_outreach',
      threshold_usd: {
        low: 100,
        medium: 1000
      },
      liability_threshold: {
        low: 0.2,
        medium: 0.55
      }
    },
    dependencies: {
      burn_oracle_latest_path: burnLatestPath,
      disposable_infra_policy_path: disposablePolicyPath,
      weaver_latest_path: path.join(tmp, 'weaver', 'latest.json')
    },
    profile_pack: {
      actions: [
        { id: 'site_build', profile_id: 'marketing_site_generator_v1', lane: 'build', required: true },
        { id: 'site_deploy', profile_id: 'static_site_deploy_v1', lane: 'deploy', required: true },
        { id: 'email_draft', profile_id: 'cold_email_personalize_v1', lane: 'draft', required: true },
        { id: 'email_send', profile_id: 'cold_email_send_v1', lane: 'send', required: true },
        { id: 'followup_schedule', profile_id: 'followup_schedule_v1', lane: 'followup', required: false }
      ],
      storm_human_lane: {
        enabled: true,
        queue_name: 'storm_human_outreach_review'
      }
    },
    state: {
      state_path: path.join(tmp, 'outreach', 'state.json'),
      campaigns_dir: path.join(tmp, 'outreach', 'campaigns'),
      latest_path: path.join(tmp, 'outreach', 'latest.json'),
      receipts_path: path.join(tmp, 'outreach', 'receipts.jsonl'),
      weaver_hints_path: path.join(tmp, 'outreach', 'weaver_hints.jsonl')
    }
  });

  writeJson(burnLatestPath, {
    ok: true,
    type: 'dynamic_burn_budget_oracle_run',
    projection: {
      pressure: 'high',
      projected_runway_days: 4.2
    }
  });

  const env = {
    ...process.env,
    UNIVERSAL_OUTREACH_PRIMITIVE_POLICY_PATH: outreachPolicyPath,
    DISPOSABLE_INFRASTRUCTURE_POLICY_PATH: disposablePolicyPath
  };

  let out = run(disposableScript, [
    'register-account',
    '--account-id=acct_1',
    '--provider=gmail',
    '--warmup-days=8',
    '--reputation=0.8',
    '--apply=0'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'disposable account register should pass');

  out = run(disposableScript, [
    'register-proxy',
    '--proxy-id=proxy_1',
    '--provider=residential_pool',
    '--region=us',
    '--quality-score=0.9',
    '--apply=0'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'disposable proxy register should pass');

  const leads = [
    { lead_id: 'l1', business_name: 'Atlas HVAC', email: 'owner@atlas-hvac.com', website: 'https://atlas-hvac.com', category: 'hvac', city: 'salt lake city' },
    { lead_id: 'l2', business_name: 'Summit Dental', email: 'team@summitdental.com', website: 'https://summitdental.com', category: 'dental', city: 'provo' },
    { lead_id: 'l3', business_name: 'Foothill Auto', email: 'service@foothillauto.com', website: 'https://foothillauto.com', category: 'automotive', city: 'ogden' },
    { lead_id: 'l4', business_name: 'weak lead' }
  ];

  out = run(outreachScript, [
    'plan',
    '--campaign-id=slc_batch_1',
    `--leads-json=${JSON.stringify(leads)}`,
    '--offer-json={"offer":"free speed audit"}',
    '--apply=0'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'outreach plan should pass');
  assert.ok(out.payload && out.payload.ok === true, 'plan payload should be ok');
  assert.strictEqual(Number(out.payload.leads_selected || 0), 3, 'high burn cap should limit selected leads to 3');
  assert.strictEqual(Number(out.payload.micro_tasks || 0), 15, 'expected 5 tasks per selected lead');
  assert.strictEqual(String(out.payload.risk_tier || ''), 'medium', 'revenue outreach should default to medium tier');
  assert.strictEqual(Boolean(out.payload.operator_prompt_required), false, 'medium tier should not prompt operator');
  assert.ok(Array.isArray(out.payload.reason_codes) && out.payload.reason_codes.includes('burn_pressure_high'), 'reason codes should include burn pressure');

  out = run(outreachScript, [
    'run',
    '--campaign-id=slc_batch_1',
    '--apply=0'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'outreach run should pass');
  assert.ok(out.payload && out.payload.ok === true, 'run payload should be ok');
  assert.strictEqual(Number(out.payload.leads_executed || 0), 3, 'run should execute selected leads');
  assert.ok(Number(out.payload.deliverability_average || 0) > 0, 'deliverability average should be positive');
  assert.strictEqual(String(out.payload.stage || ''), 'executed_autonomous_medium', 'medium tier should auto-execute after veto window');

  out = run(outreachScript, [
    'status',
    '--campaign-id=slc_batch_1'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'outreach status should pass');
  assert.ok(out.payload && out.payload.ok === true, 'status payload should be ok');
  assert.strictEqual(String(out.payload.campaign.stage || ''), 'executed_autonomous_medium', 'campaign should reflect autonomous medium execution');

  console.log('universal_outreach_primitive.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`universal_outreach_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
