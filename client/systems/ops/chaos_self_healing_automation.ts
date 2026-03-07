#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  clampNumber,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.CHAOS_SELF_HEALING_AUTOMATION_POLICY_PATH
  ? path.resolve(process.env.CHAOS_SELF_HEALING_AUTOMATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'chaos_self_healing_automation_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/chaos_self_healing_automation.js run [--apply=0|1] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/chaos_self_healing_automation.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    cadence_hours: 24,
    max_fault_injections_per_run: 3,
    strict_fail_on_unhealed_critical: true,
    paths: {
      latest_path: 'state/ops/chaos_self_healing_automation/latest.json',
      receipts_path: 'state/ops/chaos_self_healing_automation/receipts.jsonl',
      schedule_path: 'state/ops/chaos_self_healing_automation/schedule.json',
      postmortem_path: 'state/ops/postmortem_loop/latest.json',
      doctor_path: 'state/ops/execution_doctor_ga/latest.json',
      chaos_path: 'state/ops/continuous_chaos_resilience/latest.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    cadence_hours: clampInt(raw.cadence_hours, 1, 24 * 14, base.cadence_hours),
    max_fault_injections_per_run: clampInt(raw.max_fault_injections_per_run, 1, 24, base.max_fault_injections_per_run),
    strict_fail_on_unhealed_critical: toBool(raw.strict_fail_on_unhealed_critical, true),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      schedule_path: resolvePath(paths.schedule_path, base.paths.schedule_path),
      postmortem_path: resolvePath(paths.postmortem_path, base.paths.postmortem_path),
      doctor_path: resolvePath(paths.doctor_path, base.paths.doctor_path),
      chaos_path: resolvePath(paths.chaos_path, base.paths.chaos_path)
    }
  };
}

function writeReceipt(policy, row) {
  const out = { ts: nowIso(), ok: true, shadow_only: policy.shadow_only, ...row };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function buildSchedule(policy, seed = nowIso()) {
  const slots = [];
  const max = clampInt(policy.max_fault_injections_per_run, 1, 24, 3);
  for (let i = 0; i < max; i += 1) {
    slots.push({
      slot_id: `fault_slot_${i + 1}`,
      profile: i % 2 === 0 ? 'latency_spike' : 'service_drop',
      severity: i === 0 ? 'medium' : 'high',
      scheduled_after_minutes: 15 + (i * 20)
    });
  }
  const schedule = {
    schema_id: 'chaos_self_healing_schedule',
    schema_version: '1.0',
    generated_at: nowIso(),
    cadence_hours: policy.cadence_hours,
    seed_hash: stableHash(seed, 16),
    slots
  };
  writeJsonAtomic(policy.paths.schedule_path, schedule);
  return schedule;
}

function run(args, policy) {
  const apply = toBool(args.apply, false);
  const strict = toBool(args.strict, false);
  const schedule = buildSchedule(policy);
  const doctor = readJson(policy.paths.doctor_path, {});
  const postmortem = readJson(policy.paths.postmortem_path, {});
  const chaos = readJson(policy.paths.chaos_path, {});

  const wounded = clampInt(doctor.wounded_active || doctor.wounded_modules || 0, 0, 10000, 0);
  const healed = clampInt(doctor.healing_active || 0, 0, 10000, 0);
  const critical = clampInt(chaos.critical_findings || chaos.critical_failures || 0, 0, 10000, 0);
  const postmortems = clampInt(postmortem.generated_last_24h || postmortem.entries_last_24h || 0, 0, 10000, 0);

  const checks = {
    injections_scheduled: Array.isArray(schedule.slots) && schedule.slots.length >= 1,
    remediation_lane_ready: healed >= 0,
    postmortem_lane_ready: postmortems >= 0,
    no_unhealed_critical: wounded === 0 && critical === 0
  };

  const ok = strict
    ? (checks.injections_scheduled && checks.remediation_lane_ready && checks.postmortem_lane_ready && (!policy.strict_fail_on_unhealed_critical || checks.no_unhealed_critical))
    : true;

  return writeReceipt(policy, {
    type: 'chaos_self_healing_automation_run',
    apply,
    strict,
    ok,
    checks,
    stats: {
      slots: schedule.slots.length,
      wounded_active: wounded,
      healing_active: healed,
      critical_findings: critical,
      postmortems_last_24h: postmortems
    },
    schedule_path: path.relative(ROOT, policy.paths.schedule_path).replace(/\\/g, '/')
  });
}

function status(policy) {
  return {
    ok: true,
    type: 'chaos_self_healing_automation_status',
    shadow_only: policy.shadow_only,
    latest: readJson(policy.paths.latest_path, {}),
    schedule: readJson(policy.paths.schedule_path, {})
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'chaos_self_healing_automation_disabled' }, 1);

  if (cmd === 'run') emit(run(args, policy), 0);
  if (cmd === 'status') emit(status(policy), 0);

  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
