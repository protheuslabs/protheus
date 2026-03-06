#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-190
 * Mobile lifecycle resilience + power envelope lane.
 *
 * Usage:
 *   node systems/edge/mobile_lifecycle_resilience.js configure --owner=<owner_id> [--battery-soft=30] [--battery-hard=18]
 *   node systems/edge/mobile_lifecycle_resilience.js run --owner=<owner_id> [--battery=64] [--thermal=38] [--doze=0] [--background-kills=0] [--apply=1]
 *   node systems/edge/mobile_lifecycle_resilience.js recover --owner=<owner_id> [--reason=background_kill] [--apply=1]
 *   node systems/edge/mobile_lifecycle_resilience.js status [--owner=<owner_id>]
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  toBool,
  clampNumber,
  readJson,
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.MOBILE_LIFECYCLE_RESILIENCE_POLICY_PATH
  ? path.resolve(process.env.MOBILE_LIFECYCLE_RESILIENCE_POLICY_PATH)
  : path.join(ROOT, 'config', 'mobile_lifecycle_resilience_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/edge/mobile_lifecycle_resilience.js configure --owner=<owner_id> [--battery-soft=30] [--battery-hard=18]');
  console.log('  node systems/edge/mobile_lifecycle_resilience.js run --owner=<owner_id> [--battery=64] [--thermal=38] [--doze=0] [--background-kills=0] [--apply=1]');
  console.log('  node systems/edge/mobile_lifecycle_resilience.js recover --owner=<owner_id> [--reason=background_kill] [--apply=1]');
  console.log('  node systems/edge/mobile_lifecycle_resilience.js status [--owner=<owner_id>]');
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readState(policy: any) {
  return readJson(policy.paths.lifecycle_state_path, {
    schema_id: 'mobile_lifecycle_resilience_state',
    schema_version: '1.0',
    owner_id: null,
    action: 'continue',
    mode: 'normal',
    last_reason_codes: [],
    wake_lock_minutes: 0,
    background_kills: 0,
    doze_mode: false,
    battery_pct: null,
    thermal_c: null,
    uptime_hours: null,
    survives_72h_target: false,
    recovery_attempts: 0,
    last_recovery_at: null,
    updated_at: null
  });
}

function writeState(policy: any, state: any) {
  ensureDir(policy.paths.lifecycle_state_path);
  writeJsonAtomic(policy.paths.lifecycle_state_path, state);
}

function readThresholds(policy: any) {
  const row = readJson(policy.policy_path, {});
  const thresholds = row.thresholds && typeof row.thresholds === 'object' ? row.thresholds : {};
  return {
    battery_soft_pct: clampNumber(thresholds.battery_soft_pct, 5, 100, 30),
    battery_hard_pct: clampNumber(thresholds.battery_hard_pct, 1, 100, 18),
    thermal_soft_c: clampNumber(thresholds.thermal_soft_c, 20, 120, 42),
    thermal_hard_c: clampNumber(thresholds.thermal_hard_c, 20, 120, 48),
    background_kill_soft: clampNumber(thresholds.background_kill_soft, 0, 1000, 2),
    background_kill_hard: clampNumber(thresholds.background_kill_hard, 0, 1000, 4),
    wake_lock_soft_min: clampNumber(thresholds.wake_lock_soft_min, 0, 1440, 20),
    wake_lock_hard_min: clampNumber(thresholds.wake_lock_hard_min, 0, 1440, 45),
    target_autonomy_hours: clampNumber(thresholds.target_autonomy_hours, 1, 720, 72)
  };
}

function lifecycleDecision(metrics: any, thresholds: any) {
  const reasons: string[] = [];
  let action = 'continue';
  let mode = 'normal';

  if (metrics.battery_pct <= thresholds.battery_hard_pct) reasons.push('battery_hard_floor');
  if (metrics.thermal_c >= thresholds.thermal_hard_c) reasons.push('thermal_hard_ceiling');
  if (metrics.background_kills >= thresholds.background_kill_hard) reasons.push('background_kill_hard');
  if (metrics.wake_lock_minutes >= thresholds.wake_lock_hard_min) reasons.push('wake_lock_hard');

  if (reasons.length > 0) {
    action = 'pause';
    mode = 'fail_safe';
  } else {
    if (metrics.battery_pct <= thresholds.battery_soft_pct) reasons.push('battery_soft_floor');
    if (metrics.thermal_c >= thresholds.thermal_soft_c) reasons.push('thermal_soft_ceiling');
    if (metrics.background_kills >= thresholds.background_kill_soft) reasons.push('background_kill_soft');
    if (metrics.wake_lock_minutes >= thresholds.wake_lock_soft_min) reasons.push('wake_lock_soft');
    if (metrics.doze_mode) reasons.push('doze_detected');
    if (reasons.length > 0) {
      action = 'throttle';
      mode = 'power_save';
    }
  }

  const survives72h = metrics.uptime_hours >= thresholds.target_autonomy_hours && action !== 'pause';
  return {
    action,
    mode,
    reason_codes: reasons,
    survives_72h_target: survives72h,
    target_autonomy_hours: thresholds.target_autonomy_hours,
    allow_background_hands: action !== 'pause'
  };
}

runStandardLane({
  lane_id: 'V3-RACE-190',
  script_rel: 'systems/edge/mobile_lifecycle_resilience.js',
  policy_path: POLICY_PATH,
  stream: 'edge.lifecycle',
  paths: {
    memory_dir: 'memory/edge/lifecycle',
    adaptive_index_path: 'adaptive/edge/lifecycle/index.json',
    events_path: 'state/edge/mobile_lifecycle/events.jsonl',
    latest_path: 'state/edge/mobile_lifecycle/latest.json',
    receipts_path: 'state/edge/mobile_lifecycle/receipts.jsonl',
    lifecycle_state_path: 'state/edge/mobile_lifecycle/state.json'
  },
  usage,
  handlers: {
    run(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };
      const apply = toBool(args.apply, true);
      const metrics = {
        battery_pct: clampNumber(args.battery != null ? args.battery : args.battery_pct, 0, 100, 100),
        thermal_c: clampNumber(args.thermal != null ? args.thermal : args.thermal_c, 0, 150, 35),
        doze_mode: toBool(args.doze != null ? args.doze : args.doze_mode, false),
        background_kills: clampNumber(args['background-kills'] != null ? args['background-kills'] : args.background_kills, 0, 1000, 0),
        wake_lock_minutes: clampNumber(args['wake-lock-minutes'] != null ? args['wake-lock-minutes'] : args.wake_lock_minutes, 0, 1440, 0),
        uptime_hours: clampNumber(args['uptime-hours'] != null ? args['uptime-hours'] : args.uptime_hours, 0, 720, 0)
      };
      const thresholds = readThresholds(policy);
      const decision = lifecycleDecision(metrics, thresholds);
      const current = readState(policy);
      const next = {
        ...current,
        owner_id: ownerId,
        action: decision.action,
        mode: decision.mode,
        last_reason_codes: decision.reason_codes,
        wake_lock_minutes: metrics.wake_lock_minutes,
        background_kills: metrics.background_kills,
        doze_mode: metrics.doze_mode,
        battery_pct: metrics.battery_pct,
        thermal_c: metrics.thermal_c,
        uptime_hours: metrics.uptime_hours,
        survives_72h_target: decision.survives_72h_target,
        updated_at: nowIso()
      };
      if (apply) writeState(policy, next);

      return ctx.cmdRecord(policy, {
        ...args,
        event: 'mobile_lifecycle_evaluated',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          metrics,
          thresholds,
          decision,
          lifecycle_state_path: path.relative(ROOT, policy.paths.lifecycle_state_path).replace(/\\/g, '/')
        })
      });
    },

    recover(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };
      const apply = toBool(args.apply, true);
      const reason = cleanText(args.reason || 'background_kill', 240) || 'background_kill';
      const current = readState(policy);
      const next = {
        ...current,
        owner_id: ownerId,
        recovery_attempts: Number(current.recovery_attempts || 0) + (apply ? 1 : 0),
        action: 'recover',
        mode: 'resume_backoff',
        last_recovery_at: nowIso(),
        updated_at: nowIso()
      };
      if (apply) writeState(policy, next);

      return ctx.cmdRecord(policy, {
        ...args,
        event: 'mobile_lifecycle_recover',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          reason,
          recovery_attempts: next.recovery_attempts,
          lifecycle_state_path: path.relative(ROOT, policy.paths.lifecycle_state_path).replace(/\\/g, '/')
        })
      });
    },

    status(policy: any, args: any, ctx: any) {
      const base = ctx.cmdStatus(policy, args);
      const state = readState(policy);
      return {
        ...base,
        lifecycle: state,
        artifacts: {
          ...base.artifacts,
          lifecycle_state_path: path.relative(ROOT, policy.paths.lifecycle_state_path).replace(/\\/g, '/')
        }
      };
    }
  }
});
