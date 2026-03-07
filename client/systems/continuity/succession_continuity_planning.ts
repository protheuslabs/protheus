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
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.SUCCESSION_CONTINUITY_PLANNING_POLICY_PATH
  ? path.resolve(process.env.SUCCESSION_CONTINUITY_PLANNING_POLICY_PATH)
  : path.join(ROOT, 'config', 'succession_continuity_planning_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/continuity/succession_continuity_planning.js nominate --successor-id=<id> [--delay-hours=<n>] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/continuity/succession_continuity_planning.js activate --ticket=<id> [--force=1|0] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/continuity/succession_continuity_planning.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    min_delay_hours: 24,
    max_delay_hours: 24 * 90,
    require_cryptographic_delegation: true,
    paths: {
      latest_path: 'state/continuity/succession_continuity_planning/latest.json',
      receipts_path: 'state/continuity/succession_continuity_planning/receipts.jsonl',
      state_path: 'state/continuity/succession_continuity_planning/state.json',
      audit_path: 'state/continuity/succession_continuity_planning/audit.jsonl'
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
    min_delay_hours: clampInt(raw.min_delay_hours, 1, 24 * 365, base.min_delay_hours),
    max_delay_hours: clampInt(raw.max_delay_hours, 1, 24 * 365, base.max_delay_hours),
    require_cryptographic_delegation: toBool(raw.require_cryptographic_delegation, true),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      audit_path: resolvePath(paths.audit_path, base.paths.audit_path)
    }
  };
}

function loadState(policy) {
  const raw = readJson(policy.paths.state_path, {});
  return {
    successor_id: cleanText(raw.successor_id || '', 120),
    nomination_ts: cleanText(raw.nomination_ts || '', 64),
    activation_window_starts_at: cleanText(raw.activation_window_starts_at || '', 64),
    active_ticket: cleanText(raw.active_ticket || '', 120),
    activated: toBool(raw.activated, false)
  };
}

function saveState(policy, state) {
  writeJsonAtomic(policy.paths.state_path, state);
  return state;
}

function writeReceipt(policy, row) {
  const out = { ts: nowIso(), ok: true, shadow_only: policy.shadow_only, ...row };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function nominate(args, policy) {
  const apply = toBool(args.apply, false);
  const successorId = normalizeToken(args['successor-id'] || args.successor_id || '', 120);
  if (!successorId) return { ok: false, type: 'succession_nominate', error: 'successor_id_required' };
  const delayHours = clampInt(args['delay-hours'] || args.delay_hours, policy.min_delay_hours, policy.max_delay_hours, policy.min_delay_hours);
  const nominationTs = nowIso();
  const startsAt = new Date(Date.parse(nominationTs) + (delayHours * 60 * 60 * 1000)).toISOString();
  const ticket = `succ_${stableHash(`${successorId}|${nominationTs}|${delayHours}`, 18)}`;
  const state = {
    successor_id: successorId,
    nomination_ts: nominationTs,
    activation_window_starts_at: startsAt,
    active_ticket: ticket,
    activated: false
  };
  if (apply) {
    saveState(policy, state);
    appendJsonl(policy.paths.audit_path, {
      ts: nominationTs,
      type: 'succession_nominate',
      successor_id: successorId,
      delay_hours: delayHours,
      ticket,
      require_cryptographic_delegation: policy.require_cryptographic_delegation
    });
  }
  return writeReceipt(policy, {
    type: 'succession_nominate',
    apply,
    successor_id: successorId,
    delay_hours: delayHours,
    activation_window_starts_at: startsAt,
    ticket
  });
}

function activate(args, policy) {
  const apply = toBool(args.apply, false);
  const force = toBool(args.force, false);
  const ticket = cleanText(args.ticket || '', 120);
  const state = loadState(policy);
  if (!state.active_ticket) return { ok: false, type: 'succession_activate', error: 'no_pending_nomination' };
  if (!ticket || ticket !== state.active_ticket) return { ok: false, type: 'succession_activate', error: 'invalid_ticket' };

  const nowMs = Date.parse(nowIso());
  const startsMs = Date.parse(String(state.activation_window_starts_at || ''));
  if (!force && Number.isFinite(startsMs) && nowMs < startsMs) {
    return { ok: false, type: 'succession_activate', error: 'activation_window_not_started', activation_window_starts_at: state.activation_window_starts_at };
  }

  const next = {
    ...state,
    activated: true
  };
  if (apply) {
    saveState(policy, next);
    appendJsonl(policy.paths.audit_path, {
      ts: nowIso(),
      type: 'succession_activate',
      successor_id: state.successor_id,
      ticket,
      activated: true
    });
  }
  return writeReceipt(policy, {
    type: 'succession_activate',
    apply,
    force,
    successor_id: state.successor_id,
    activated: true
  });
}

function status(policy) {
  const state = loadState(policy);
  return {
    ok: true,
    type: 'succession_continuity_planning_status',
    shadow_only: policy.shadow_only,
    require_cryptographic_delegation: policy.require_cryptographic_delegation,
    state,
    latest: readJson(policy.paths.latest_path, {})
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
  if (!policy.enabled) emit({ ok: false, error: 'succession_continuity_planning_disabled' }, 1);

  if (cmd === 'nominate') emit(nominate(args, policy));
  if (cmd === 'activate') emit(activate(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
