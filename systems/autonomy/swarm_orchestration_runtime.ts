#!/usr/bin/env node
'use strict';
export {};

/** V3-RACE-006 */
const path = require('path');
const {
  ROOT, nowIso, parseArgs, normalizeToken, toBool, clampInt,
  readJson, writeJsonAtomic, appendJsonl, resolvePath, emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.SWARM_ORCHESTRATION_RUNTIME_POLICY_PATH
  ? path.resolve(process.env.SWARM_ORCHESTRATION_RUNTIME_POLICY_PATH)
  : path.join(ROOT, 'config', 'swarm_orchestration_runtime_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/swarm_orchestration_runtime.js run --objective=<id> [--team_size=3] [--consensus=1]');
  console.log('  node systems/autonomy/swarm_orchestration_runtime.js status');
}

function policy() {
  const base = {
    enabled: true,
    shadow_only: true,
    max_team_size: 8,
    paths: {
      latest_path: 'state/autonomy/swarm_runtime/latest.json',
      receipts_path: 'state/autonomy/swarm_runtime/receipts.jsonl',
      rounds_path: 'state/autonomy/swarm_runtime/rounds.json'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    max_team_size: clampInt(raw.max_team_size, 1, 100, base.max_team_size),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      rounds_path: resolvePath(paths.rounds_path, base.paths.rounds_path)
    }
  };
}

function runRound(args: any, p: any) {
  const objective = normalizeToken(args.objective || 'generic_objective', 120) || 'generic_objective';
  const teamSize = clampInt(args.team_size, 1, p.max_team_size, Math.min(3, p.max_team_size));
  const requiresConsensus = toBool(args.consensus, true);

  const rounds = readJson(p.paths.rounds_path, { schema_version: '1.0', rounds: [] });
  rounds.rounds = Array.isArray(rounds.rounds) ? rounds.rounds : [];
  const roundId = `swarm_${Date.now()}`;

  const team = Array.from({ length: teamSize }).map((_, i) => ({
    agent_id: `cell_${i + 1}`,
    role: i === 0 ? 'leader' : (i % 2 === 0 ? 'critic' : 'builder'),
    vote: requiresConsensus ? (i === 0 ? 'approve' : (i % 3 === 0 ? 'reject' : 'approve')) : 'approve'
  }));
  const approvals = team.filter((row) => row.vote === 'approve').length;
  const consensus = !requiresConsensus || approvals >= Math.ceil(team.length / 2);

  const row = {
    ts: nowIso(),
    round_id: roundId,
    objective,
    team,
    requires_consensus: requiresConsensus,
    consensus,
    approval_ratio: Number((approvals / Math.max(1, team.length)).toFixed(6))
  };
  rounds.rounds.push(row);
  rounds.updated_at = nowIso();
  writeJsonAtomic(p.paths.rounds_path, rounds);

  const out = { ts: nowIso(), type: 'swarm_orchestration_round', ok: true, shadow_only: p.shadow_only, ...row };
  writeJsonAtomic(p.paths.latest_path, out);
  appendJsonl(p.paths.receipts_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    return;
  }
  const p = policy();
  if (!p.enabled) emit({ ok: false, error: 'swarm_orchestration_runtime_disabled' }, 1);
  if (cmd === 'run') emit(runRound(args, p));
  if (cmd === 'status') emit({ ok: true, type: 'swarm_orchestration_status', latest: readJson(p.paths.latest_path, {}) });
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
