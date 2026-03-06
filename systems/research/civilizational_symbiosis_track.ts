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
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.CIVILIZATIONAL_SYMBIOSIS_TRACK_POLICY_PATH
  ? path.resolve(process.env.CIVILIZATIONAL_SYMBIOSIS_TRACK_POLICY_PATH)
  : path.join(ROOT, 'config', 'civilizational_symbiosis_track_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/research/civilizational_symbiosis_track.js charter [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/research/civilizational_symbiosis_track.js milestone --name=<id> [--risk=<low|medium|high>] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/research/civilizational_symbiosis_track.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    max_open_milestones: 16,
    require_non_production_scope: true,
    paths: {
      latest_path: 'state/research/civilizational_symbiosis_track/latest.json',
      receipts_path: 'state/research/civilizational_symbiosis_track/receipts.jsonl',
      charter_path: 'state/research/civilizational_symbiosis_track/charter.json',
      milestones_path: 'state/research/civilizational_symbiosis_track/milestones.json',
      doc_path: 'docs/CIVILIZATIONAL_SYMBIOSIS_TRACK.md'
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
    max_open_milestones: clampInt(raw.max_open_milestones, 1, 128, base.max_open_milestones),
    require_non_production_scope: toBool(raw.require_non_production_scope, true),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      charter_path: resolvePath(paths.charter_path, base.paths.charter_path),
      milestones_path: resolvePath(paths.milestones_path, base.paths.milestones_path),
      doc_path: resolvePath(paths.doc_path, base.paths.doc_path)
    }
  };
}

function writeReceipt(policy, row) {
  const out = { ts: nowIso(), ok: true, shadow_only: policy.shadow_only, ...row };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function charter(args, policy) {
  const apply = toBool(args.apply, false);
  const payload = {
    schema_id: 'civilizational_symbiosis_charter',
    schema_version: '1.0',
    generated_at: nowIso(),
    scope: 'research_only_non_production',
    ethics_gates: ['constitution_review', 'mirror_red_team_review', 'human_approval_required'],
    risk_model: {
      disallowed: ['deployment_without_gates', 'identity_override', 'unbounded_autonomy'],
      required_controls: ['shadow_first', 'bounded_experiments', 'auditable_receipts']
    }
  };
  if (apply) writeJsonAtomic(policy.paths.charter_path, payload);
  return writeReceipt(policy, {
    type: 'civilizational_symbiosis_charter',
    apply,
    scope: payload.scope,
    ethics_gates: payload.ethics_gates
  });
}

function milestone(args, policy) {
  const apply = toBool(args.apply, false);
  const name = normalizeToken(args.name || '', 120);
  if (!name) return { ok: false, type: 'civilizational_symbiosis_milestone', error: 'name_required' };
  const risk = cleanText(args.risk || 'medium', 20).toLowerCase();
  const existing = readJson(policy.paths.milestones_path, { milestones: [] });
  const milestones = Array.isArray(existing.milestones) ? existing.milestones : [];
  const open = milestones.filter((row) => String(row.status || '') === 'open').length;
  if (open >= policy.max_open_milestones) {
    return { ok: false, type: 'civilizational_symbiosis_milestone', error: 'max_open_milestones_reached', max: policy.max_open_milestones };
  }
  const row = {
    id: `ms_${Date.now()}`,
    ts: nowIso(),
    name,
    risk,
    status: 'open',
    production_scope: false
  };
  const next = { milestones: [row, ...milestones].slice(0, 200) };
  if (apply) writeJsonAtomic(policy.paths.milestones_path, next);
  return writeReceipt(policy, {
    type: 'civilizational_symbiosis_milestone',
    apply,
    milestone_id: row.id,
    name,
    risk,
    production_scope: row.production_scope
  });
}

function status(policy) {
  const charterRow = readJson(policy.paths.charter_path, {});
  const milestonesRow = readJson(policy.paths.milestones_path, { milestones: [] });
  const milestones = Array.isArray(milestonesRow.milestones) ? milestonesRow.milestones : [];
  return {
    ok: true,
    type: 'civilizational_symbiosis_track_status',
    shadow_only: policy.shadow_only,
    charter_present: String(charterRow.schema_id || '') === 'civilizational_symbiosis_charter',
    open_milestones: milestones.filter((row) => String(row.status || '') === 'open').length,
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
  if (!policy.enabled) emit({ ok: false, error: 'civilizational_symbiosis_track_disabled' }, 1);

  if (cmd === 'charter') emit(charter(args, policy));
  if (cmd === 'milestone') emit(milestone(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
