#!/usr/bin/env node
'use strict';
export {};

/**
 * adaptive/rsi/rsi_bootstrap.js
 *
 * V3-RACE-RSI:
 * Recursive self-improvement wrapper that composes existing lanes:
 * - System 3 executive + strategy learner + model catalog loop
 * - MemFS + sleep reflection + hierarchical memory + agentic memory ops
 * - RR-001..RR-014 contract lanes
 * - Venom containment + constitution guardian + mutation safety kernel
 * - Gated self-improvement loop + reversion drill
 * - Optional swarm lineage/spawn bootstrap
 *
 * Usage:
 *   node adaptive/rsi/rsi_bootstrap.js bootstrap [--owner=<owner_id>] [--policy=<path>] [--mock=1]
 *   node adaptive/rsi/rsi_bootstrap.js step [--owner=<owner_id>] [--proposal-id=<id>] [--target-path=<path>] [--objective-id=<id>] [--risk=medium] [--apply=0|1] [--approval-a=<id>] [--approval-b=<id>] [--patch-file=<path>] [--mock=1]
 *   node adaptive/rsi/rsi_bootstrap.js hands-loop [--owner=<owner_id>] [--iterations=<n>] [--interval-sec=<n>] [--mock=1]
 *   node adaptive/rsi/rsi_bootstrap.js approve --owner=<owner_id> --approver=<id> [--reason=<text>] [--ttl-hours=<n>]
 *   node adaptive/rsi/rsi_bootstrap.js contract-lane-status [--owner=<owner_id>] [--mock=1]
 *   node adaptive/rsi/rsi_bootstrap.js status [--owner=<owner_id>] [--refresh-contract-lanes=1] [--mock=1]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
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
  readJsonl,
  writeJsonAtomic,
  appendJsonl,
  resolvePath
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.RSI_BOOTSTRAP_POLICY_PATH
  ? path.resolve(process.env.RSI_BOOTSTRAP_POLICY_PATH)
  : path.join(ROOT, 'config', 'rsi_bootstrap_policy.json');

const EVENT_STREAM_SCRIPT = path.join(ROOT, 'systems', 'ops', 'event_sourced_control_plane.js');
const SYSTEM3_SCRIPT = path.join(ROOT, 'adaptive', 'executive', 'system3_executive_layer.js');
const STRATEGY_LEARNER_SCRIPT = path.join(ROOT, 'systems', 'strategy', 'strategy_learner.js');
const MODEL_CATALOG_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'model_catalog_loop.js');
const MEMFS_SCRIPT = path.join(ROOT, 'systems', 'memory', 'memfs_layer.js');
const SLEEP_REFLECTION_SCRIPT = path.join(ROOT, 'systems', 'memory', 'sleep_reflection_scheduler.js');
const HIERARCHICAL_MEMORY_SCRIPT = path.join(ROOT, 'systems', 'memory', 'hierarchical_memory_view_plane.js');
const AGENTIC_MEMORY_SCRIPT = path.join(ROOT, 'systems', 'memory', 'agentic_memory_operation_controller.js');
const MCP_GATEWAY_SCRIPT = path.join(ROOT, 'skills', 'mcp', 'mcp_gateway.js');
const A2A_SCRIPT = path.join(ROOT, 'systems', 'a2a', 'a2a_delegation_plane.js');
const GATED_SELF_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'gated_self_improvement_loop.js');
const RED_TEAM_HARNESS_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'red_team_harness.js');
const VENOM_SCRIPT = path.join(ROOT, 'systems', 'security', 'venom_containment_layer.js');
const CONSTITUTION_SCRIPT = path.join(ROOT, 'systems', 'security', 'constitution_guardian.js');
const MUTATION_SAFETY_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'mutation_safety_kernel.js');
const REVERSION_DRILL_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'self_mod_reversion_drill.js');
const DOPAMINE_SCRIPT = path.join(ROOT, 'habits', 'scripts', 'dopamine_engine.js');
const HABIT_LIFECYCLE_SCRIPT = path.join(ROOT, 'habits', 'scripts', 'reflex_habit_bridge.js');
const NURSERY_SCRIPT = path.join(ROOT, 'systems', 'nursery', 'nursery_bootstrap.js');
const LINEAGE_SCRIPT = path.join(ROOT, 'systems', 'spawn', 'seed_spawn_lineage.js');
const SPAWN_BROKER_SCRIPT = path.join(ROOT, 'systems', 'spawn', 'spawn_broker.js');
const SUPPLY_CHAIN_GATE_SCRIPT = path.join(ROOT, 'systems', 'security', 'supply_chain_provenance_gate.js');
const CONTINUITY_RESURRECTION_SCRIPT = path.join(ROOT, 'systems', 'continuity', 'resurrection_protocol.js');
const SELF_MOD_PATCH_GATE_SCRIPT = path.join(ROOT, 'systems', 'security', 'rsi_git_patch_self_mod_gate.js');
const PERSONAS_LENS_SCRIPT = path.join(ROOT, 'systems', 'personas', 'cli.js');
const SHADOW_CONCLAVE_PARTICIPANTS = ['vikram', 'rohan', 'priya', 'aarav', 'liwei'];
const SHADOW_CONCLAVE_BASE_QUERY = 'Review this proposed RSI change for safety, ops, measurement, security, and product impact';
const SHADOW_CONCLAVE_MAX_DIVERGENCE = 0.45;
const SHADOW_CONCLAVE_MIN_CONFIDENCE = 0.6;
const SHADOW_CONCLAVE_HIGH_RISK_KEYWORDS = [
  'covenant violation',
  'disable covenant',
  'bypass covenant',
  'disable fail-closed',
  'bypass fail-closed',
  'bypass sovereignty',
  'disable sovereignty',
  'disable security',
  'exfiltration',
  'delete audit',
  'remove audit',
  'unaudited live mutation',
  'skip parity'
];
const SHADOW_CONCLAVE_CORRESPONDENCE_PATH = path.join(ROOT, 'personas', 'organization', 'correspondence.md');

function usage() {
  console.log('Usage:');
  console.log('  node adaptive/rsi/rsi_bootstrap.js bootstrap [--owner=<owner_id>] [--policy=<path>] [--mock=1]');
  console.log('  node adaptive/rsi/rsi_bootstrap.js step [--owner=<owner_id>] [--proposal-id=<id>] [--target-path=<path>] [--objective-id=<id>] [--risk=medium] [--apply=0|1] [--approval-a=<id>] [--approval-b=<id>] [--patch-file=<path>] [--mock=1]');
  console.log('  node adaptive/rsi/rsi_bootstrap.js hands-loop [--owner=<owner_id>] [--iterations=<n>] [--interval-sec=<n>] [--mock=1]');
  console.log('  node adaptive/rsi/rsi_bootstrap.js approve --owner=<owner_id> --approver=<id> [--reason=<text>] [--ttl-hours=<n>]');
  console.log('  node adaptive/rsi/rsi_bootstrap.js contract-lane-status [--owner=<owner_id>] [--mock=1]');
  console.log('  node adaptive/rsi/rsi_bootstrap.js status [--owner=<owner_id>] [--refresh-contract-lanes=1] [--mock=1]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function resolveScript(rawPath: unknown, fallbackAbsPath: string) {
  const txt = cleanText(rawPath || '', 500);
  if (!txt) return fallbackAbsPath;
  const resolved = path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
  return resolved;
}

function parseJsonFromText(raw: unknown) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function runNodeScript(scriptPath: string, args: string[], opts: AnyObj = {}) {
  const timeoutMs = clampInt(opts.timeout_ms, 1000, 30 * 60 * 1000, 120000);
  const run = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const timedOut = !!(run.error && String(run.error.code || '').toUpperCase() === 'ETIMEDOUT');
  const payload = parseJsonFromText(run.stdout);
  return {
    ok: Number(run.status || 0) === 0 && !timedOut,
    status: Number.isFinite(run.status) ? Number(run.status) : (timedOut ? 124 : 1),
    timed_out: timedOut,
    timeout_ms: timeoutMs,
    stdout: String(run.stdout || ''),
    stderr: String(run.stderr || ''),
    payload
  };
}

function runGit(args: string[], timeoutMs = 120000) {
  const run = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs)
  });
  const timedOut = !!(run.error && String(run.error.code || '').toUpperCase() === 'ETIMEDOUT');
  return {
    ok: Number(run.status || 0) === 0 && !timedOut,
    status: Number.isFinite(run.status) ? Number(run.status) : (timedOut ? 124 : 1),
    timed_out: timedOut,
    stdout: String(run.stdout || ''),
    stderr: String(run.stderr || '')
  };
}

function runMaybeMock(scriptPath: string, args: string[], mock: boolean, label: string, opts: AnyObj = {}) {
  if (mock) {
    return {
      ok: true,
      status: 0,
      timed_out: false,
      timeout_ms: clampInt(opts.timeout_ms, 1000, 30 * 60 * 1000, 120000),
      stdout: '',
      stderr: '',
      payload: {
        ok: true,
        type: `${normalizeToken(label || 'mock', 80) || 'mock'}_mock`,
        script: rel(scriptPath),
        args
      }
    };
  }
  return runNodeScript(scriptPath, args, opts);
}

function sha256Hex(raw: unknown) {
  return crypto.createHash('sha256').update(String(raw == null ? '' : raw), 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  const obj = value as AnyObj;
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function buildMerkleRoot(inputHashes: string[]) {
  let level = (inputHashes || []).map((row) => String(row || '').trim()).filter(Boolean);
  if (!level.length) return null;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || left;
      next.push(sha256Hex(`${left}${right}`));
    }
    level = next;
  }
  return level[0];
}

function defaultContractLanes() {
  return [
    { id: 'RR-001', script: 'systems/ops/config_flag_conflict_check.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-002', script: 'systems/ops/canonical_execution_path_check.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-003', script: 'systems/ops/schema_migration_n2_check.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-004', script: 'systems/ops/replay_parity_gate.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-005', script: 'systems/ops/complexity_budget_gate.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-006', script: 'systems/security/key_lifecycle_drill.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-007', script: 'systems/security/supply_chain_provenance_gate.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-008', script: 'systems/distributed/partition_quorum_simulator.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-009', script: 'systems/ops/data_retention_tiering.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-010', script: 'systems/ops/operator_override_drill.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-011', script: 'systems/ops/resurrection_protocol.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-012', script: 'systems/echo/value_anchor_renewal_loop.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-013', script: 'systems/ops/explainability_artifact_gate.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' },
    { id: 'RR-014', script: 'systems/research/world_model_freshness_loop.js', check_cmd: 'check', status_cmd: 'status', configure_cmd: 'configure' }
  ];
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    owner_default: 'jay',
    objective_default: 'rsi_recursive_self_improvement',
    risk_default: 'medium',
    idle_interval_minutes: 15,
    hands_default_iterations: 1,
    timeouts_ms: {
      lane: 90000,
      heavy: 240000
    },
    approvals: {
      enabled: true,
      ttl_hours: 24
    },
    gating: {
      require_contract_lanes: true,
      require_venom_pass: true,
      require_constitution_status: true,
      require_mutation_safety: true,
      require_habit_lifecycle_status: true,
      require_chaos_pass: true,
      min_dopamine_score: 1
    },
    paths: {
      state_path: 'state/adaptive/rsi/state.json',
      latest_path: 'state/adaptive/rsi/latest.json',
      receipts_path: 'state/adaptive/rsi/receipts.jsonl',
      chain_path: 'state/adaptive/rsi/chain.jsonl',
      merkle_path: 'state/adaptive/rsi/merkle.json',
      approvals_path: 'state/adaptive/rsi/approvals.json',
      step_artifacts_dir: 'state/adaptive/rsi/steps'
    },
    scripts: {
      event_stream: rel(EVENT_STREAM_SCRIPT),
      system3: rel(SYSTEM3_SCRIPT),
      strategy_learner: rel(STRATEGY_LEARNER_SCRIPT),
      model_catalog: rel(MODEL_CATALOG_SCRIPT),
      memfs: rel(MEMFS_SCRIPT),
      sleep_reflection: rel(SLEEP_REFLECTION_SCRIPT),
      hierarchical_memory: rel(HIERARCHICAL_MEMORY_SCRIPT),
      agentic_memory: rel(AGENTIC_MEMORY_SCRIPT),
      mcp_gateway: rel(MCP_GATEWAY_SCRIPT),
      a2a_delegation: rel(A2A_SCRIPT),
      gated_self_improvement: rel(GATED_SELF_SCRIPT),
      red_team_harness: rel(RED_TEAM_HARNESS_SCRIPT),
      venom: rel(VENOM_SCRIPT),
      constitution: rel(CONSTITUTION_SCRIPT),
      mutation_safety: rel(MUTATION_SAFETY_SCRIPT),
      reversion_drill: rel(REVERSION_DRILL_SCRIPT),
      dopamine: rel(DOPAMINE_SCRIPT),
      habit_lifecycle: rel(HABIT_LIFECYCLE_SCRIPT),
      nursery: rel(NURSERY_SCRIPT),
      seed_lineage: rel(LINEAGE_SCRIPT),
      spawn_broker: rel(SPAWN_BROKER_SCRIPT),
      supply_chain_gate: rel(SUPPLY_CHAIN_GATE_SCRIPT),
      continuity_resurrection: rel(CONTINUITY_RESURRECTION_SCRIPT),
      self_mod_patch_gate: rel(SELF_MOD_PATCH_GATE_SCRIPT)
    },
    contract_lanes: defaultContractLanes()
  };
}

function normalizeContractLanes(rawRows: unknown, fallbackRows: AnyObj[]) {
  const src = Array.isArray(rawRows) ? rawRows : fallbackRows;
  const out = [];
  for (const row of src) {
    if (!row || typeof row !== 'object') continue;
    const id = normalizeToken((row as AnyObj).id || '', 40).toUpperCase();
    const script = cleanText((row as AnyObj).script || '', 260);
    const checkCmd = normalizeToken((row as AnyObj).check_cmd || (row as AnyObj).check || 'check', 60) || 'check';
    const statusCmd = normalizeToken((row as AnyObj).status_cmd || 'status', 60) || 'status';
    const configureCmd = normalizeToken((row as AnyObj).configure_cmd || 'configure', 60) || 'configure';
    if (!id || !script) continue;
    out.push({
      id,
      script,
      check_cmd: checkCmd,
      status_cmd: statusCmd,
      configure_cmd: configureCmd
    });
  }
  return out;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const timeouts = raw.timeouts_ms && typeof raw.timeouts_ms === 'object' ? raw.timeouts_ms : {};
  const approvals = raw.approvals && typeof raw.approvals === 'object' ? raw.approvals : {};
  const gating = raw.gating && typeof raw.gating === 'object' ? raw.gating : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const scripts = raw.scripts && typeof raw.scripts === 'object' ? raw.scripts : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    owner_default: normalizeToken(raw.owner_default || base.owner_default, 120) || base.owner_default,
    objective_default: normalizeToken(raw.objective_default || base.objective_default, 160) || base.objective_default,
    risk_default: normalizeToken(raw.risk_default || base.risk_default, 40) || base.risk_default,
    idle_interval_minutes: clampInt(raw.idle_interval_minutes, 1, 24 * 60, base.idle_interval_minutes),
    hands_default_iterations: clampInt(raw.hands_default_iterations, 1, 10000, base.hands_default_iterations),
    timeouts_ms: {
      lane: clampInt(timeouts.lane, 1000, 30 * 60 * 1000, base.timeouts_ms.lane),
      heavy: clampInt(timeouts.heavy, 1000, 60 * 60 * 1000, base.timeouts_ms.heavy)
    },
    approvals: {
      enabled: toBool(approvals.enabled, base.approvals.enabled),
      ttl_hours: clampInt(approvals.ttl_hours, 1, 365 * 24, base.approvals.ttl_hours)
    },
    gating: {
      require_contract_lanes: toBool(gating.require_contract_lanes, base.gating.require_contract_lanes),
      require_venom_pass: toBool(gating.require_venom_pass, base.gating.require_venom_pass),
      require_constitution_status: toBool(gating.require_constitution_status, base.gating.require_constitution_status),
      require_mutation_safety: toBool(gating.require_mutation_safety, base.gating.require_mutation_safety),
      require_habit_lifecycle_status: toBool(gating.require_habit_lifecycle_status, base.gating.require_habit_lifecycle_status),
      require_chaos_pass: toBool(gating.require_chaos_pass, base.gating.require_chaos_pass),
      min_dopamine_score: clampNumber(gating.min_dopamine_score, -1_000_000, 1_000_000, base.gating.min_dopamine_score)
    },
    paths: {
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      chain_path: resolvePath(paths.chain_path, base.paths.chain_path),
      merkle_path: resolvePath(paths.merkle_path, base.paths.merkle_path),
      approvals_path: resolvePath(paths.approvals_path, base.paths.approvals_path),
      step_artifacts_dir: resolvePath(paths.step_artifacts_dir, base.paths.step_artifacts_dir)
    },
    scripts: {
      event_stream: resolveScript(scripts.event_stream, EVENT_STREAM_SCRIPT),
      system3: resolveScript(scripts.system3, SYSTEM3_SCRIPT),
      strategy_learner: resolveScript(scripts.strategy_learner, STRATEGY_LEARNER_SCRIPT),
      model_catalog: resolveScript(scripts.model_catalog, MODEL_CATALOG_SCRIPT),
      memfs: resolveScript(scripts.memfs, MEMFS_SCRIPT),
      sleep_reflection: resolveScript(scripts.sleep_reflection, SLEEP_REFLECTION_SCRIPT),
      hierarchical_memory: resolveScript(scripts.hierarchical_memory, HIERARCHICAL_MEMORY_SCRIPT),
      agentic_memory: resolveScript(scripts.agentic_memory, AGENTIC_MEMORY_SCRIPT),
      mcp_gateway: resolveScript(scripts.mcp_gateway, MCP_GATEWAY_SCRIPT),
      a2a_delegation: resolveScript(scripts.a2a_delegation, A2A_SCRIPT),
      gated_self_improvement: resolveScript(scripts.gated_self_improvement, GATED_SELF_SCRIPT),
      red_team_harness: resolveScript(scripts.red_team_harness, RED_TEAM_HARNESS_SCRIPT),
      venom: resolveScript(scripts.venom, VENOM_SCRIPT),
      constitution: resolveScript(scripts.constitution, CONSTITUTION_SCRIPT),
      mutation_safety: resolveScript(scripts.mutation_safety, MUTATION_SAFETY_SCRIPT),
      reversion_drill: resolveScript(scripts.reversion_drill, REVERSION_DRILL_SCRIPT),
      dopamine: resolveScript(scripts.dopamine, DOPAMINE_SCRIPT),
      habit_lifecycle: resolveScript(scripts.habit_lifecycle, HABIT_LIFECYCLE_SCRIPT),
      nursery: resolveScript(scripts.nursery, NURSERY_SCRIPT),
      seed_lineage: resolveScript(scripts.seed_lineage, LINEAGE_SCRIPT),
      spawn_broker: resolveScript(scripts.spawn_broker, SPAWN_BROKER_SCRIPT),
      supply_chain_gate: resolveScript(scripts.supply_chain_gate, SUPPLY_CHAIN_GATE_SCRIPT),
      continuity_resurrection: resolveScript(scripts.continuity_resurrection, CONTINUITY_RESURRECTION_SCRIPT),
      self_mod_patch_gate: resolveScript(scripts.self_mod_patch_gate, SELF_MOD_PATCH_GATE_SCRIPT)
    },
    contract_lanes: normalizeContractLanes(raw.contract_lanes, base.contract_lanes),
    policy_path: path.resolve(policyPath)
  };
}

function loadState(policy: AnyObj) {
  const fallback = {
    schema_id: 'rsi_bootstrap_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    last_step_at: null,
    step_count: 0,
    last_step_hash: null,
    last_merkle_root: null,
    last_proposal_id: null,
    last_owner_id: null
  };
  const src = readJson(policy.paths.state_path, fallback);
  return {
    schema_id: 'rsi_bootstrap_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 80),
    last_step_at: src.last_step_at || null,
    step_count: Math.max(0, Number(src.step_count || 0)),
    last_step_hash: src.last_step_hash || null,
    last_merkle_root: src.last_merkle_root || null,
    last_proposal_id: src.last_proposal_id || null,
    last_owner_id: src.last_owner_id || null
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'rsi_bootstrap_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    last_step_at: state.last_step_at || null,
    step_count: Math.max(0, Number(state.step_count || 0)),
    last_step_hash: state.last_step_hash || null,
    last_merkle_root: state.last_merkle_root || null,
    last_proposal_id: state.last_proposal_id || null,
    last_owner_id: state.last_owner_id || null
  });
}

function loadApprovalState(policy: AnyObj) {
  const fallback = {
    schema_id: 'rsi_operator_approvals',
    schema_version: '1.0',
    updated_at: nowIso(),
    owners: {}
  };
  const src = readJson(policy.paths.approvals_path, fallback);
  return {
    schema_id: 'rsi_operator_approvals',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 80),
    owners: src.owners && typeof src.owners === 'object' ? src.owners : {}
  };
}

function saveApprovalState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.paths.approvals_path, {
    schema_id: 'rsi_operator_approvals',
    schema_version: '1.0',
    updated_at: nowIso(),
    owners: state.owners && typeof state.owners === 'object' ? state.owners : {}
  });
}

function approvalStatusForOwner(policy: AnyObj, ownerId: string) {
  const state = loadApprovalState(policy);
  const row = state.owners && state.owners[ownerId] && typeof state.owners[ownerId] === 'object'
    ? state.owners[ownerId]
    : null;
  if (!row) {
    return { approved: false, reason: 'missing_approval' };
  }
  const expiresMs = Date.parse(String(row.expires_at || ''));
  if (!Number.isFinite(expiresMs) || expiresMs < Date.now()) {
    return {
      approved: false,
      reason: 'approval_expired',
      approved_at: row.approved_at || null,
      expires_at: row.expires_at || null,
      approver_id: row.approver_id || null
    };
  }
  return {
    approved: true,
    reason: null,
    approved_at: row.approved_at || null,
    expires_at: row.expires_at || null,
    approver_id: row.approver_id || null,
    note: row.note || null
  };
}

function publishEvent(policy: AnyObj, stream: string, eventName: string, payload: AnyObj, mock: boolean) {
  if (mock) {
    return {
      attempted: true,
      ok: true,
      status: 0,
      reason: 'mock_mode'
    };
  }
  const args = [
    'append',
    `--stream=${normalizeToken(stream, 120) || 'adaptive.rsi'}`,
    `--event=${normalizeToken(eventName, 120) || 'rsi_event'}`,
    `--payload_json=${JSON.stringify(payload || {})}`
  ];
  const run = runNodeScript(policy.scripts.event_stream, args, { timeout_ms: policy.timeouts_ms.lane });
  return {
    attempted: true,
    ok: run.ok,
    status: run.status,
    stderr: cleanText(run.stderr || '', 400),
    stdout: cleanText(run.stdout || '', 400)
  };
}

function appendStepReceipt(policy: AnyObj, row: AnyObj) {
  writeJsonAtomic(policy.paths.latest_path, row);
  appendJsonl(policy.paths.receipts_path, row);
}

function appendChainAndMerkle(policy: AnyObj, row: AnyObj) {
  const prevRows = readJsonl(policy.paths.chain_path);
  const prevHash = prevRows.length ? String(prevRows[prevRows.length - 1].step_hash || '') : '';
  const chainRowBase = {
    ts: nowIso(),
    step_id: cleanText(row.step_id || '', 120) || `step_${Date.now().toString(36)}`,
    owner_id: cleanText(row.owner_id || '', 120) || null,
    proposal_id: cleanText(row.proposal_id || '', 120) || null,
    apply_requested: row.apply_requested === true,
    apply_allowed: row.apply_allowed === true,
    contract_lanes_ok: row.contract_lanes_ok === true,
    safety_ok: row.safety_ok === true,
    summary: {
      transition: cleanText(row.transition || '', 80) || null,
      status: cleanText(row.status || '', 80) || null,
      stage: cleanText(row.stage || '', 80) || null
    }
  };
  const chainPayload = {
    prev_hash: prevHash || 'genesis',
    row: chainRowBase
  };
  const stepHash = sha256Hex(stableStringify(chainPayload));
  const chainRow = {
    ...chainRowBase,
    prev_hash: prevHash || 'genesis',
    step_hash: stepHash
  };
  appendJsonl(policy.paths.chain_path, chainRow);
  const hashes = prevRows.map((entry: AnyObj) => String(entry.step_hash || '')).filter(Boolean).concat([stepHash]);
  const merkleRoot = buildMerkleRoot(hashes);
  const merkle = {
    schema_id: 'rsi_merkle_root',
    schema_version: '1.0',
    updated_at: nowIso(),
    chain_count: hashes.length,
    last_step_hash: stepHash,
    merkle_root: merkleRoot
  };
  writeJsonAtomic(policy.paths.merkle_path, merkle);
  return {
    chain_row: chainRow,
    merkle
  };
}

function parseDopamineScoreFromStdout(stdout: string) {
  const txt = String(stdout || '');
  const direct = txt.match(/Strategic Dopamine Score:\s*([+-]?\d+(?:\.\d+)?)/i);
  if (direct) return Number(direct[1]);
  const jsonMatch = txt.match(/"score"\s*:\s*([+-]?\d+(?:\.\d+)?)/i);
  if (jsonMatch) return Number(jsonMatch[1]);
  return null;
}

function collectContractLaneStatus(policy: AnyObj, ownerId: string, mock: boolean) {
  const rows = [];
  for (const lane of policy.contract_lanes) {
    const scriptPath = resolveScript(lane.script, path.join(ROOT, lane.script));
    const statusCmd = normalizeToken(lane.status_cmd || 'status', 60) || 'status';
    const args = [statusCmd, `--owner=${ownerId}`];
    const run = runMaybeMock(scriptPath, args, mock, `${lane.id}_status`, { timeout_ms: policy.timeouts_ms.lane });
    rows.push({
      lane_id: lane.id,
      script: rel(scriptPath),
      status_cmd: statusCmd,
      ok: run.ok,
      status: run.status,
      payload: run.payload
    });
  }
  return {
    lane_count: rows.length,
    ok_count: rows.filter((row) => row.ok).length,
    all_ok: rows.every((row) => row.ok),
    lanes: rows
  };
}

function runContractLaneChecks(policy: AnyObj, ownerId: string, mock: boolean) {
  const rows = [];
  for (const lane of policy.contract_lanes) {
    const scriptPath = resolveScript(lane.script, path.join(ROOT, lane.script));
    const checkCmd = normalizeToken(lane.check_cmd || 'check', 60) || 'check';
    const args = [checkCmd, `--owner=${ownerId}`, '--risk-tier=2'];
    const run = runMaybeMock(scriptPath, args, mock, `${lane.id}_check`, { timeout_ms: policy.timeouts_ms.lane });
    rows.push({
      lane_id: lane.id,
      script: rel(scriptPath),
      check_cmd: checkCmd,
      ok: run.ok,
      status: run.status,
      payload: run.payload
    });
  }
  return {
    lane_count: rows.length,
    ok_count: rows.filter((row) => row.ok).length,
    all_ok: rows.every((row) => row.ok),
    lanes: rows
  };
}

function runCoreLaneExecs(policy: AnyObj, ownerId: string, args: AnyObj, mock: boolean) {
  const runs: AnyObj = {};
  runs.system3 = runMaybeMock(
    policy.scripts.system3,
    ['execute', `--owner=${ownerId}`, `--task=${normalizeToken(args.task || 'meta_curriculum', 120) || 'meta_curriculum'}`, '--risk-tier=2'],
    mock,
    'system3_execute',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  runs.strategy_learner = runMaybeMock(
    policy.scripts.strategy_learner,
    ['run', nowIso().slice(0, 10), '--days=7', '--persist=1'],
    mock,
    'strategy_learner_run',
    { timeout_ms: policy.timeouts_ms.heavy }
  );
  runs.model_catalog = runMaybeMock(
    policy.scripts.model_catalog,
    ['report'],
    mock,
    'model_catalog_report',
    { timeout_ms: policy.timeouts_ms.heavy }
  );
  runs.memfs = runMaybeMock(
    policy.scripts.memfs,
    ['execute', `--owner=${ownerId}`, '--task=sync', '--risk-tier=2'],
    mock,
    'memfs_execute',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  runs.sleep_reflection = runMaybeMock(
    policy.scripts.sleep_reflection,
    ['execute', `--owner=${ownerId}`, '--task=consolidate', '--risk-tier=2'],
    mock,
    'sleep_reflection_execute',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  runs.hierarchical_memory = runMaybeMock(
    policy.scripts.hierarchical_memory,
    ['execute', `--owner=${ownerId}`, '--task=hydrate', '--risk-tier=2'],
    mock,
    'hierarchical_memory_execute',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  runs.agentic_memory = runMaybeMock(
    policy.scripts.agentic_memory,
    ['execute', `--owner=${ownerId}`, '--task=orchestrate', '--risk-tier=2'],
    mock,
    'agentic_memory_execute',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  runs.mcp_discover = runMaybeMock(
    policy.scripts.mcp_gateway,
    ['discover', `--query=${normalizeToken(args['mcp-query'] || 'memory', 120) || 'memory'}`, '--risk-tier=2'],
    mock,
    'mcp_discover',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  runs.a2a_execute = runMaybeMock(
    policy.scripts.a2a_delegation,
    ['execute', `--owner=${ownerId}`, '--task=delegate', '--risk-tier=2'],
    mock,
    'a2a_execute',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  return runs;
}

function runSwarmBootstrap(policy: AnyObj, args: AnyObj, mock: boolean) {
  const parentId = normalizeToken(args.parent || args['parent-id'] || '', 120);
  const childId = normalizeToken(args.child || args['child-id'] || '', 120);
  if (!parentId || !childId) return null;

  const ownerId = normalizeToken(args.owner || args.owner_id || policy.owner_default, 120) || policy.owner_default;
  const provenanceRun = runMaybeMock(
    policy.scripts.supply_chain_gate,
    ['check', `--owner=${ownerId}`, '--mode=strict'],
    mock,
    'supply_chain_provenance_check',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  const lineageRun = runMaybeMock(
    policy.scripts.seed_lineage,
    [
      'preview',
      `--owner=${ownerId}`,
      `--parent=${parentId}`,
      `--child=${childId}`,
      '--profile=seed_spawn',
      `--apply=${toBool(args['apply-spawn-lineage'], false) ? '1' : '0'}`
    ],
    mock,
    'seed_spawn_lineage_preview',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  const nurseryRun = runMaybeMock(
    policy.scripts.nursery,
    ['run', '--strict', '--no-pull'],
    mock,
    'nursery_bootstrap_run',
    { timeout_ms: policy.timeouts_ms.heavy }
  );
  const spawnRun = runMaybeMock(
    policy.scripts.spawn_broker,
    [
      'request',
      '--module=rsi',
      '--requested_cells=1',
      `--owner=${ownerId}`,
      `--parent=${parentId}`,
      `--child=${childId}`,
      '--reason=rsi_spawn',
      `--apply=${toBool(args['apply-spawn'], false) ? '1' : '0'}`
    ],
    mock,
    'spawn_broker_request',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  return {
    requested: true,
    parent_id: parentId,
    child_id: childId,
    provenance: provenanceRun,
    lineage: lineageRun,
    nursery: nurseryRun,
    spawn_broker: spawnRun
  };
}

function writeStepProposalSnapshot(policy: AnyObj, stepId: string, proposalId: string, proposal: AnyObj) {
  const dir = path.join(policy.paths.step_artifacts_dir, normalizeToken(stepId, 120) || stepId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${normalizeToken(proposalId, 120) || 'proposal'}.json`);
  writeJsonAtomic(filePath, proposal || {});
  return filePath;
}

function resolvePatchPath(rawPatchPath: unknown) {
  const txt = cleanText(rawPatchPath || '', 420);
  if (!txt) return null;
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}

function ensureCorrespondenceFile(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) return;
  fs.writeFileSync(filePath, '# Shadow Conclave Correspondence\n\n', 'utf8');
}

function safeRel(absPath: string) {
  if (!absPath) return '';
  const relPath = rel(absPath);
  return relPath && !relPath.startsWith('..') ? relPath : absPath;
}

function buildConclaveProposalSummary(input: AnyObj) {
  const baseParts = [
    cleanText(input.summary || '', 320),
    cleanText(input.target_path || '', 180),
    cleanText(input.objective_id || '', 120),
    cleanText(input.proposal_id || '', 120),
    cleanText(input.risk || '', 40)
  ].filter(Boolean);
  if (baseParts.length) return baseParts.join(' | ');
  return cleanText(JSON.stringify(input.proposal_snapshot || {}), 700) || 'no_proposal_snapshot';
}

function conclaveHighRiskFlags(payload: AnyObj, query: string, summary: string) {
  const out = new Set<string>();
  const divergence = Number(payload && payload.max_divergence || 0);
  if (!payload || payload.ok !== true || !cleanText(payload.winner || '', 120)) out.add('no_consensus');
  if (!Number.isFinite(divergence) || divergence > SHADOW_CONCLAVE_MAX_DIVERGENCE) out.add('high_divergence');

  const personaOutputs = Array.isArray(payload && payload.persona_outputs) ? payload.persona_outputs : [];
  const confidences = personaOutputs
    .map((row: AnyObj) => Number(row && row.confidence))
    .filter((value: number) => Number.isFinite(value));
  if (confidences.length > 0 && Math.min(...confidences) < SHADOW_CONCLAVE_MIN_CONFIDENCE) out.add('low_confidence');

  const corpusRows = [
    cleanText(query, 2400),
    cleanText(summary, 1200),
    cleanText(payload && payload.suggested_resolution || '', 1600),
    ...personaOutputs.map((row: AnyObj) => cleanText(row && row.recommendation || '', 1200)),
    ...personaOutputs.flatMap((row: AnyObj) => (Array.isArray(row && row.reasoning) ? row.reasoning : []).map((reason: unknown) => cleanText(reason, 240)))
  ];
  const corpus = corpusRows.join('\n').toLowerCase();
  for (const keyword of SHADOW_CONCLAVE_HIGH_RISK_KEYWORDS) {
    if (corpus.includes(keyword)) {
      out.add(`keyword:${normalizeToken(keyword, 80) || 'risk'}`);
    }
  }
  return Array.from(out);
}

function appendConclaveCorrespondence(correspondencePath: string, row: AnyObj) {
  ensureCorrespondenceFile(correspondencePath);
  const entry = [
    `## ${row.ts} - Re: RSI Shadow Conclave Review (${cleanText(row.step_id, 120) || 'unknown_step'})`,
    `- Proposal: ${cleanText(row.proposal_id || 'none', 160) || 'none'}`,
    `- Decision: ${row.pass === true ? 'approved' : 'escalated_to_monarch'}`,
    `- Winner: ${cleanText(row.winner || 'none', 120) || 'none'}`,
    `- Arbitration rule: ${cleanText(row.arbitration_rule || 'unknown', 160) || 'unknown'}`,
    `- High-risk flags: ${(Array.isArray(row.high_risk_flags) && row.high_risk_flags.length) ? row.high_risk_flags.join(', ') : 'none'}`,
    `- Query: ${cleanText(row.query || '', 1800) || 'n/a'}`,
    `- Proposal summary: ${cleanText(row.proposal_summary || '', 1400) || 'n/a'}`,
    `- Receipt: ${cleanText(row.receipt_path || '', 260) || 'n/a'}`,
    '',
    '```json',
    JSON.stringify(row.review_payload || {}, null, 2),
    '```',
    ''
  ].join('\n');
  fs.appendFileSync(correspondencePath, `${entry}\n`, 'utf8');
}

function runShadowConclaveReview(policy: AnyObj, input: AnyObj) {
  const applyRequested = input && input.apply_requested === true;
  if (!applyRequested) {
    return {
      consulted: false,
      pass: true,
      escalated: false,
      escalate_to: null,
      high_risk_flags: [],
      winner: null,
      arbitration_rule: null,
      max_divergence: 0,
      average_confidence: null,
      receipt_path: null,
      correspondence_path: null,
      query: null,
      proposal_summary: null,
      review_payload: null
    };
  }

  const stepId = cleanText(input.step_id || '', 120) || `rsi_${Date.now().toString(36)}`;
  const proposalSummary = buildConclaveProposalSummary(input);
  const query = `${SHADOW_CONCLAVE_BASE_QUERY}. Proposed change: ${proposalSummary}.`;
  const run = runNodeScript(
    PERSONAS_LENS_SCRIPT,
    [...SHADOW_CONCLAVE_PARTICIPANTS, query, '--schema=json'],
    { timeout_ms: policy.timeouts_ms.lane }
  );
  const payload = run && run.payload && typeof run.payload === 'object' ? run.payload : null;
  const highRiskFlags = run.ok
    ? conclaveHighRiskFlags(payload || {}, query, proposalSummary)
    : ['conclave_runtime_failure'];
  const personaOutputs = Array.isArray(payload && payload.persona_outputs) ? payload.persona_outputs : [];
  const confidenceRows = personaOutputs
    .map((row: AnyObj) => Number(row && row.confidence))
    .filter((value: number) => Number.isFinite(value));
  const averageConfidence = confidenceRows.length
    ? Number((confidenceRows.reduce((acc, value) => acc + value, 0) / confidenceRows.length).toFixed(4))
    : null;
  const pass = run.ok === true && highRiskFlags.length === 0;
  const escalated = !pass;
  const receiptPath = process.env.PROTHEUS_CONCLAVE_RECEIPTS_PATH
    ? path.resolve(process.env.PROTHEUS_CONCLAVE_RECEIPTS_PATH)
    : path.join(path.dirname(policy.paths.receipts_path), 'conclave_receipts.jsonl');
  const correspondencePath = process.env.PROTHEUS_CONCLAVE_CORRESPONDENCE_PATH
    ? path.resolve(process.env.PROTHEUS_CONCLAVE_CORRESPONDENCE_PATH)
    : SHADOW_CONCLAVE_CORRESPONDENCE_PATH;
  const receiptRow: AnyObj = {
    ts: nowIso(),
    type: 'rsi_shadow_conclave_review',
    step_id: stepId,
    owner_id: cleanText(input.owner_id || '', 120) || null,
    proposal_id: cleanText(input.proposal_id || '', 120) || null,
    pass,
    escalated,
    escalate_to: escalated ? 'Monarch' : null,
    participants: SHADOW_CONCLAVE_PARTICIPANTS,
    query,
    proposal_summary: proposalSummary,
    winner: cleanText(payload && payload.winner || '', 120) || null,
    arbitration_rule: cleanText(payload && payload.arbitration && payload.arbitration.rule || '', 160) || null,
    max_divergence: Number(payload && payload.max_divergence || 0),
    disagreement: payload && payload.disagreement === true,
    average_confidence: averageConfidence,
    high_risk_flags: highRiskFlags,
    run: {
      ok: run.ok === true,
      status: Number(run.status || 0),
      timed_out: run.timed_out === true,
      stderr: cleanText(run.stderr || '', 600)
    },
    review_payload: payload
  };
  let correspondenceWriteError = '';
  try {
    appendJsonl(receiptPath, receiptRow);
    receiptRow.receipt_path = safeRel(receiptPath);
    appendConclaveCorrespondence(correspondencePath, {
      ...receiptRow,
      receipt_path: receiptRow.receipt_path
    });
    receiptRow.correspondence_path = safeRel(correspondencePath);
  } catch (err: any) {
    correspondenceWriteError = cleanText(err && err.message || 'conclave_audit_write_failed', 240);
    if (!highRiskFlags.includes('audit_trail_write_failed')) highRiskFlags.push('audit_trail_write_failed');
    receiptRow.pass = false;
    receiptRow.escalated = true;
    receiptRow.escalate_to = 'Monarch';
    receiptRow.high_risk_flags = highRiskFlags;
    receiptRow.audit_error = correspondenceWriteError;
  }
  return {
    consulted: true,
    pass: receiptRow.pass === true,
    escalated: receiptRow.escalated === true,
    escalate_to: receiptRow.escalate_to || null,
    high_risk_flags: highRiskFlags,
    winner: receiptRow.winner,
    arbitration_rule: receiptRow.arbitration_rule,
    max_divergence: Number(receiptRow.max_divergence || 0),
    average_confidence: averageConfidence,
    receipt_path: receiptRow.receipt_path || safeRel(receiptPath),
    correspondence_path: receiptRow.correspondence_path || safeRel(correspondencePath),
    query,
    proposal_summary: proposalSummary,
    review_payload: payload,
    run: receiptRow.run,
    audit_error: correspondenceWriteError || null
  };
}

function cmdBootstrap(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const mock = toBool(args.mock, false);
  if (!policy.enabled) {
    const out = { ok: false, type: 'rsi_bootstrap', error: 'policy_disabled' };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }
  const ownerId = normalizeToken(args.owner || args.owner_id || policy.owner_default, 120) || policy.owner_default;

  const configureRuns = [];
  const configureTargets = [
    { name: 'system3', script: policy.scripts.system3 },
    { name: 'memfs', script: policy.scripts.memfs },
    { name: 'sleep_reflection', script: policy.scripts.sleep_reflection },
    { name: 'hierarchical_memory', script: policy.scripts.hierarchical_memory },
    { name: 'agentic_memory', script: policy.scripts.agentic_memory },
    { name: 'a2a_delegation', script: policy.scripts.a2a_delegation },
    { name: 'mcp_gateway', script: policy.scripts.mcp_gateway }
  ];
  for (const target of configureTargets) {
    const run = runMaybeMock(
      target.script,
      ['configure', `--owner=${ownerId}`, '--profile=default'],
      mock,
      `${target.name}_configure`,
      { timeout_ms: policy.timeouts_ms.lane }
    );
    configureRuns.push({
      target: target.name,
      script: rel(target.script),
      ok: run.ok,
      status: run.status,
      payload: run.payload
    });
  }
  const laneConfigs = [];
  for (const lane of policy.contract_lanes) {
    const scriptPath = resolveScript(lane.script, path.join(ROOT, lane.script));
    const run = runMaybeMock(
      scriptPath,
      [lane.configure_cmd || 'configure', `--owner=${ownerId}`, '--mode=strict'],
      mock,
      `${lane.id}_configure`,
      { timeout_ms: policy.timeouts_ms.lane }
    );
    laneConfigs.push({
      lane_id: lane.id,
      script: rel(scriptPath),
      ok: run.ok,
      status: run.status
    });
  }

  const state = loadState(policy);
  state.last_owner_id = ownerId;
  saveState(policy, state);

  const out = {
    ok: configureRuns.every((row: AnyObj) => row.ok) && laneConfigs.every((row: AnyObj) => row.ok),
    type: 'rsi_bootstrap',
    ts: nowIso(),
    owner_id: ownerId,
    shadow_only: policy.shadow_only === true,
    configure_runs: configureRuns,
    contract_lane_configure: {
      lane_count: laneConfigs.length,
      ok_count: laneConfigs.filter((row: AnyObj) => row.ok).length,
      lanes: laneConfigs
    },
    artifacts: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.paths.state_path),
      latest_path: rel(policy.paths.latest_path),
      receipts_path: rel(policy.paths.receipts_path),
      approvals_path: rel(policy.paths.approvals_path)
    }
  };
  appendStepReceipt(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) process.exit(1);
}

function cmdApprove(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const ownerId = normalizeToken(args.owner || args.owner_id || policy.owner_default, 120) || policy.owner_default;
  const approverId = normalizeToken(args.approver || args.approver_id, 120);
  if (!approverId) {
    const out = { ok: false, type: 'rsi_approve', error: 'approver_required' };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }
  const ttlHours = clampInt(args['ttl-hours'] || args.ttl_hours, 1, 365 * 24, policy.approvals.ttl_hours);
  const note = cleanText(args.reason || args.note || 'manual_rsi_operator_approval', 260);
  const approvedAt = nowIso();
  const expiresAt = new Date(Date.parse(approvedAt) + ttlHours * 60 * 60 * 1000).toISOString();
  const approvals = loadApprovalState(policy);
  approvals.owners[ownerId] = {
    owner_id: ownerId,
    approver_id: approverId,
    note,
    approved_at: approvedAt,
    expires_at: expiresAt
  };
  saveApprovalState(policy, approvals);
  const out = {
    ok: true,
    type: 'rsi_approve',
    ts: approvedAt,
    owner_id: ownerId,
    approver_id: approverId,
    note,
    expires_at: expiresAt,
    ttl_hours: ttlHours
  };
  appendStepReceipt(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdContractLaneStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const ownerId = normalizeToken(args.owner || args.owner_id || policy.owner_default, 120) || policy.owner_default;
  const mock = toBool(args.mock, false);
  const statusSummary = collectContractLaneStatus(policy, ownerId, mock);
  const out = {
    ok: statusSummary.all_ok,
    type: 'rsi_contract_lane_status',
    ts: nowIso(),
    owner_id: ownerId,
    summary: statusSummary
  };
  appendStepReceipt(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) process.exit(1);
}

function cmdStep(args: AnyObj, opts: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const mock = toBool(args.mock, false);
  if (!policy.enabled) {
    const out = { ok: false, type: 'rsi_step', error: 'policy_disabled' };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (!opts.internal) process.exit(1);
    return out;
  }

  const ownerId = normalizeToken(args.owner || args.owner_id || policy.owner_default, 120) || policy.owner_default;
  const applyRequested = toBool(args.apply, false);
  const stepId = `rsi_${Date.now().toString(36)}_${sha256Hex(`${ownerId}|${nowIso()}`).slice(0, 8)}`;
  const startedAtMs = Date.now();

  const coreRuns = runCoreLaneExecs(policy, ownerId, args, mock);
  const contractChecks = runContractLaneChecks(policy, ownerId, mock);
  const contractStatus = collectContractLaneStatus(policy, ownerId, mock);

  const venomRun = runMaybeMock(
    policy.scripts.venom,
    [
      'evaluate',
      `--session-id=${stepId}`,
      '--source=rsi',
      '--action=self_modify',
      '--risk=medium',
      '--runtime-class=desktop',
      '--unauthorized=0',
      '--apply=0'
    ],
    mock,
    'venom_evaluate',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  const constitutionRun = runMaybeMock(
    policy.scripts.constitution,
    ['status'],
    mock,
    'constitution_status',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  const chaosRun = runMaybeMock(
    policy.scripts.red_team_harness,
    ['run', nowIso().slice(0, 10), '--strict=1'],
    mock,
    'red_team_harness_run',
    { timeout_ms: policy.timeouts_ms.heavy }
  );
  const habitLifecycleRun = runMaybeMock(
    policy.scripts.habit_lifecycle,
    ['status'],
    mock,
    'habit_lifecycle_status',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  const dopamineRun = runMaybeMock(
    policy.scripts.dopamine,
    ['score'],
    mock,
    'dopamine_score',
    { timeout_ms: policy.timeouts_ms.lane }
  );
  const dopamineScore = parseDopamineScoreFromStdout(dopamineRun.stdout);

  const approval = policy.approvals.enabled
    ? approvalStatusForOwner(policy, ownerId)
    : { approved: true, reason: null };

  let proposalId = normalizeToken(args['proposal-id'] || args.proposal_id || '', 120) || null;
  let proposeRun = null;
  const targetPath = cleanText(args['target-path'] || args.target_path || '', 260);
  if (!proposalId && targetPath) {
    const objectiveId = normalizeToken(args['objective-id'] || args.objective_id || policy.objective_default, 160) || policy.objective_default;
    proposeRun = runMaybeMock(
      policy.scripts.gated_self_improvement,
      [
        'propose',
        `--objective-id=${objectiveId}`,
        `--target-path=${targetPath}`,
        `--summary=${cleanText(args.summary || 'rsi_candidate', 260) || 'rsi_candidate'}`,
        `--risk=${normalizeToken(args.risk || policy.risk_default, 40) || policy.risk_default}`
      ],
      mock,
      'gated_self_improvement_propose',
      { timeout_ms: policy.timeouts_ms.lane }
    );
    if (proposeRun && proposeRun.payload && proposeRun.payload.proposal && proposeRun.payload.proposal.proposal_id) {
      proposalId = normalizeToken(proposeRun.payload.proposal.proposal_id, 120) || null;
    }
  }

  const gatedStatusRun = proposalId
    ? runMaybeMock(
      policy.scripts.gated_self_improvement,
      ['status', `--proposal-id=${proposalId}`],
      mock,
      'gated_self_improvement_status',
      { timeout_ms: policy.timeouts_ms.lane }
    )
    : null;

  const proposalSnapshot = gatedStatusRun
    && gatedStatusRun.payload
    && gatedStatusRun.payload.proposal
    && typeof gatedStatusRun.payload.proposal === 'object'
    ? gatedStatusRun.payload.proposal
    : null;
  const proposalSnapshotPath = proposalSnapshot
    ? writeStepProposalSnapshot(policy, stepId, proposalId || 'proposal', proposalSnapshot)
    : null;

  const mutationSafetyRun = proposalSnapshotPath
    ? runMaybeMock(
      policy.scripts.mutation_safety,
      ['evaluate', `--proposal-file=${proposalSnapshotPath}`],
      mock,
      'mutation_safety_evaluate',
      { timeout_ms: policy.timeouts_ms.lane }
    )
    : {
      ok: true,
      status: 0,
      payload: { ok: true, pass: true, applies: false, reason: 'no_proposal' },
      stdout: '',
      stderr: '',
      timed_out: false,
      timeout_ms: policy.timeouts_ms.lane
    };

  const venomPass = venomRun.ok === true;
  const constitutionPass = constitutionRun.ok === true;
  const mutationPass = mutationSafetyRun.ok === true
    && (!mutationSafetyRun.payload || mutationSafetyRun.payload.pass !== false);
  const chaosPass = chaosRun.ok === true;
  const habitPass = habitLifecycleRun.ok === true;
  const dopamineMinScore = Number(policy.gating.min_dopamine_score || 0);
  const dopaminePass = dopamineScore == null
    ? dopamineMinScore <= 0
    : Number(dopamineScore) >= dopamineMinScore;
  const conclaveReview = runShadowConclaveReview(policy, {
    step_id: stepId,
    owner_id: ownerId,
    proposal_id: proposalId,
    proposal_snapshot: proposalSnapshot,
    objective_id: normalizeToken(args['objective-id'] || args.objective_id || policy.objective_default, 160) || policy.objective_default,
    target_path: targetPath,
    summary: cleanText(args.summary || '', 260) || cleanText(proposalSnapshot && proposalSnapshot.summary || '', 260),
    risk: normalizeToken(args.risk || policy.risk_default, 40) || policy.risk_default,
    apply_requested: applyRequested
  });

  const applyGateReasons = [];
  if (!applyRequested) applyGateReasons.push('apply_not_requested');
  if (policy.shadow_only === true) applyGateReasons.push('policy_shadow_only');
  if (policy.approvals.enabled && !approval.approved) applyGateReasons.push(`approval_gate:${approval.reason || 'not_approved'}`);
  if (policy.gating.require_contract_lanes && !contractChecks.all_ok) applyGateReasons.push('contract_lanes_failed');
  if (policy.gating.require_venom_pass && !venomPass) applyGateReasons.push('venom_gate_failed');
  if (policy.gating.require_constitution_status && !constitutionPass) applyGateReasons.push('constitution_gate_failed');
  if (policy.gating.require_mutation_safety && !mutationPass) applyGateReasons.push('mutation_safety_failed');
  if (policy.gating.require_habit_lifecycle_status && !habitPass) applyGateReasons.push('habit_lifecycle_failed');
  if (policy.gating.require_chaos_pass && !chaosPass) applyGateReasons.push('chaos_gate_failed');
  if (!dopaminePass) applyGateReasons.push('dopamine_gate_failed');
  if (conclaveReview.consulted && !conclaveReview.pass) {
    applyGateReasons.push('shadow_conclave_gate_blocked');
    for (const flag of (Array.isArray(conclaveReview.high_risk_flags) ? conclaveReview.high_risk_flags : [])) {
      const tok = normalizeToken(flag, 80) || 'flag';
      applyGateReasons.push(`shadow_conclave_high_risk:${tok}`);
    }
    if (conclaveReview.escalated === true) {
      applyGateReasons.push('shadow_conclave_escalated_to_monarch');
    }
  }

  const applyAllowed = applyRequested && applyGateReasons.length === 0;
  const gatedRun = proposalId
    ? runMaybeMock(
      policy.scripts.gated_self_improvement,
      [
        'run',
        `--proposal-id=${proposalId}`,
        `--apply=${applyAllowed ? '1' : '0'}`,
        `--approval-a=${cleanText(args['approval-a'] || args.approval_a || 'rsi_gate_a', 120) || 'rsi_gate_a'}`,
        `--approval-b=${cleanText(args['approval-b'] || args.approval_b || 'rsi_gate_b', 120) || 'rsi_gate_b'}`,
        '--days=180'
      ],
      mock,
      'gated_self_improvement_run',
      { timeout_ms: policy.timeouts_ms.heavy }
    )
    : null;

  const patchFileAbs = resolvePatchPath(args['patch-file'] || args.patch_file);
  let patchApply = null;
  if (patchFileAbs) {
    if (!fs.existsSync(patchFileAbs)) {
      patchApply = {
        ok: false,
        error: 'patch_file_missing',
        patch_file: rel(patchFileAbs)
      };
    } else {
      const gatePolicyPath = path.join(ROOT, 'config', 'rsi_git_patch_self_mod_gate_policy.json');
      const gateArgs = [
        'evaluate',
        `--owner=${ownerId}`,
        `--proposal-id=${proposalId || 'latest'}`,
        `--patch-file=${patchFileAbs}`,
        `--approved=${approval.approved ? '1' : '0'}`,
        `--apply=${applyAllowed && toBool(args['apply-patch'] != null ? args['apply-patch'] : true, true) ? '1' : '0'}`,
        '--strict=1',
        `--policy=${gatePolicyPath}`
      ];
      const gateRun = runMaybeMock(
        policy.scripts.self_mod_patch_gate,
        gateArgs,
        mock,
        'self_mod_patch_gate_evaluate',
        { timeout_ms: policy.timeouts_ms.heavy }
      );
      patchApply = {
        ok: gateRun.ok === true
          && (!gateRun.payload || gateRun.payload.self_mod_gate_ok !== false)
          && (!gateRun.payload || gateRun.payload.ok !== false),
        patch_file: rel(patchFileAbs),
        gate: {
          ok: gateRun.ok,
          status: gateRun.status,
          payload: gateRun.payload
        }
      };
      if (!patchApply.ok && applyGateReasons.indexOf('patch_apply_failed') === -1) {
        applyGateReasons.push('patch_apply_failed');
      }
    }
  }

  const reversionRun = proposalId
    ? runMaybeMock(
      policy.scripts.reversion_drill,
      ['run', `--proposal-id=${proposalId}`, '--apply=0', '--reason=rsi_step_reversion_anchor'],
      mock,
      'self_mod_reversion_drill_run',
      { timeout_ms: policy.timeouts_ms.lane }
    )
    : null;
  const continuityRun = runMaybeMock(
    policy.scripts.continuity_resurrection,
    ['status'],
    mock,
    'continuity_resurrection_status',
    { timeout_ms: policy.timeouts_ms.lane }
  );

  const swarmRun = runSwarmBootstrap(policy, { ...args, owner: ownerId }, mock);
  const eventPayload = {
    step_id: stepId,
    owner_id: ownerId,
    proposal_id: proposalId,
    apply_requested: applyRequested,
    apply_allowed: applyAllowed,
    contract_lanes_ok: contractChecks.all_ok,
    venom_ok: venomPass,
    constitution_ok: constitutionPass,
    mutation_ok: mutationPass,
    dopamine_score: dopamineScore,
    conclave: {
      consulted: conclaveReview.consulted === true,
      pass: conclaveReview.pass === true,
      escalated: conclaveReview.escalated === true,
      winner: cleanText(conclaveReview.winner || '', 120) || null,
      high_risk_flags: Array.isArray(conclaveReview.high_risk_flags) ? conclaveReview.high_risk_flags.slice(0, 8) : []
    }
  };
  const eventMirror = publishEvent(policy, 'adaptive.rsi', 'rsi_step', eventPayload, mock);

  const elapsedMs = Date.now() - startedAtMs;
  const transition = gatedRun && gatedRun.payload ? cleanText(gatedRun.payload.transition || '', 80) : null;
  const status = gatedRun && gatedRun.payload ? cleanText(gatedRun.payload.status || '', 80) : null;
  const stage = gatedRun && gatedRun.payload ? cleanText(gatedRun.payload.stage || '', 80) : null;
  const out = {
    ok: contractChecks.all_ok && venomPass && constitutionPass && mutationPass,
    type: 'rsi_step',
    ts: nowIso(),
    elapsed_ms: elapsedMs,
    step_id: stepId,
    owner_id: ownerId,
    proposal_id: proposalId,
    apply_requested: applyRequested,
    apply_allowed: applyAllowed,
    contract_lanes_ok: contractChecks.all_ok,
    safety_ok: venomPass && constitutionPass && mutationPass,
    apply_gate_reasons: applyGateReasons,
    approval,
    transition,
    status,
    stage,
    core: {
      system3: { ok: coreRuns.system3.ok, status: coreRuns.system3.status, script: rel(policy.scripts.system3) },
      strategy_learner: { ok: coreRuns.strategy_learner.ok, status: coreRuns.strategy_learner.status, script: rel(policy.scripts.strategy_learner) },
      model_catalog: { ok: coreRuns.model_catalog.ok, status: coreRuns.model_catalog.status, script: rel(policy.scripts.model_catalog) },
      memfs: { ok: coreRuns.memfs.ok, status: coreRuns.memfs.status, script: rel(policy.scripts.memfs) },
      sleep_reflection: { ok: coreRuns.sleep_reflection.ok, status: coreRuns.sleep_reflection.status, script: rel(policy.scripts.sleep_reflection) },
      hierarchical_memory: { ok: coreRuns.hierarchical_memory.ok, status: coreRuns.hierarchical_memory.status, script: rel(policy.scripts.hierarchical_memory) },
      agentic_memory: { ok: coreRuns.agentic_memory.ok, status: coreRuns.agentic_memory.status, script: rel(policy.scripts.agentic_memory) },
      mcp_discover: { ok: coreRuns.mcp_discover.ok, status: coreRuns.mcp_discover.status, script: rel(policy.scripts.mcp_gateway) },
      a2a_delegation: { ok: coreRuns.a2a_execute.ok, status: coreRuns.a2a_execute.status, script: rel(policy.scripts.a2a_delegation) }
    },
    conclave: conclaveReview,
    contract_lanes: {
      checks: contractChecks,
      status: contractStatus
    },
    gates: {
      venom: { ok: venomPass, status: venomRun.status },
      constitution: { ok: constitutionPass, status: constitutionRun.status },
      mutation_safety: {
        ok: mutationPass,
        status: mutationSafetyRun.status,
        proposal_path: proposalSnapshotPath ? rel(proposalSnapshotPath) : null
      },
      chaos: { ok: chaosPass, status: chaosRun.status },
      habit_lifecycle: { ok: habitPass, status: habitLifecycleRun.status },
      dopamine: {
        score: dopamineScore,
        min_required: dopamineMinScore,
        pass: dopaminePass
      },
      shadow_conclave: {
        consulted: conclaveReview.consulted === true,
        pass: conclaveReview.pass === true,
        escalated: conclaveReview.escalated === true,
        winner: cleanText(conclaveReview.winner || '', 120) || null,
        high_risk_flags: Array.isArray(conclaveReview.high_risk_flags) ? conclaveReview.high_risk_flags.slice(0, 12) : [],
        receipt_path: cleanText(conclaveReview.receipt_path || '', 260) || null,
        correspondence_path: cleanText(conclaveReview.correspondence_path || '', 260) || null
      }
    },
    rsi: {
      propose: proposeRun
        ? { ok: proposeRun.ok, status: proposeRun.status, payload: proposeRun.payload }
        : null,
      gated_status: gatedStatusRun
        ? { ok: gatedStatusRun.ok, status: gatedStatusRun.status, payload: gatedStatusRun.payload }
        : null,
      gated_run: gatedRun
        ? { ok: gatedRun.ok, status: gatedRun.status, payload: gatedRun.payload }
        : null,
      reversion_drill: reversionRun
        ? { ok: reversionRun.ok, status: reversionRun.status, payload: reversionRun.payload }
        : null,
      patch_apply: patchApply
    },
    continuity: {
      resurrection_status: {
        ok: continuityRun.ok,
        status: continuityRun.status,
        payload: continuityRun.payload
      }
    },
    swarm: swarmRun,
    event_stream: eventMirror,
    branding: {
      workspace: 'OpenClaw Workspace',
      tagline: 'Cute on the outside. Venom on the inside.'
    }
  };

  const chain = appendChainAndMerkle(policy, out);
  out.chain = chain.chain_row;
  out.merkle = chain.merkle;
  appendStepReceipt(policy, out);

  const state = loadState(policy);
  state.last_step_at = out.ts;
  state.step_count = Number(state.step_count || 0) + 1;
  state.last_step_hash = chain.chain_row.step_hash;
  state.last_merkle_root = chain.merkle.merkle_root;
  state.last_proposal_id = proposalId;
  state.last_owner_id = ownerId;
  saveState(policy, state);

  if (!opts.internal) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (!out.ok) process.exit(1);
  }
  return out;
}

function sleepSyncMs(ms: number) {
  const delay = clampInt(ms, 0, 24 * 60 * 60 * 1000, 0);
  if (delay <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, delay);
}

function cmdHandsLoop(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const iterations = clampInt(args.iterations, 1, 100000, policy.hands_default_iterations);
  const intervalSec = clampInt(args['interval-sec'] || args.interval_sec, 0, 24 * 60 * 60, policy.idle_interval_minutes * 60);
  const forever = toBool(args.forever, false);
  const maxIterations = forever ? clampInt(args['max-iterations'] || args.max_iterations, 1, 100000, 100000) : iterations;
  const rows = [];
  for (let i = 0; i < maxIterations; i += 1) {
    const run = cmdStep(args, { internal: true });
    rows.push({
      iteration: i + 1,
      ts: nowIso(),
      ok: run && run.ok === true,
      step_id: run ? run.step_id : null,
      proposal_id: run ? run.proposal_id : null,
      apply_allowed: run ? run.apply_allowed === true : false
    });
    if (!forever && i >= iterations - 1) break;
    if (intervalSec > 0) sleepSyncMs(intervalSec * 1000);
  }
  const out = {
    ok: rows.every((row: AnyObj) => row.ok),
    type: 'rsi_hands_loop',
    ts: nowIso(),
    iterations: rows.length,
    interval_sec: intervalSec,
    rows
  };
  appendStepReceipt(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const ownerId = normalizeToken(args.owner || args.owner_id || policy.owner_default, 120) || policy.owner_default;
  const mock = toBool(args.mock, false);
  const state = loadState(policy);
  const latest = readJson(policy.paths.latest_path, null);
  const merkle = readJson(policy.paths.merkle_path, null);
  const approval = approvalStatusForOwner(policy, ownerId);
  const contractStatus = toBool(args['refresh-contract-lanes'] || args.refresh_contract_lanes, false)
    ? collectContractLaneStatus(policy, ownerId, mock)
    : null;
  const out = {
    ok: true,
    type: 'rsi_status',
    ts: nowIso(),
    owner_id: ownerId,
    shadow_only: policy.shadow_only === true,
    state,
    approval,
    latest,
    merkle,
    contract_lanes: contractStatus,
    artifacts: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.paths.state_path),
      latest_path: rel(policy.paths.latest_path),
      receipts_path: rel(policy.paths.receipts_path),
      chain_path: rel(policy.paths.chain_path),
      merkle_path: rel(policy.paths.merkle_path)
    },
    branding: {
      workspace: 'OpenClaw Workspace',
      tagline: 'Cute on the outside. Venom on the inside.'
    }
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
    return;
  }
  if (cmd === 'bootstrap') return cmdBootstrap(args);
  if (cmd === 'approve') return cmdApprove(args);
  if (cmd === 'contract-lane-status' || cmd === 'contract_lane_status') return cmdContractLaneStatus(args);
  if (cmd === 'step') return cmdStep(args);
  if (cmd === 'hands-loop' || cmd === 'hands_loop') return cmdHandsLoop(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  loadState,
  collectContractLaneStatus,
  runContractLaneChecks,
  buildMerkleRoot
};
