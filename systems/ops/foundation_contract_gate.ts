#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .replace(/[^a-zA-Z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeLowerToken(v: unknown, maxLen = 120) {
  return normalizeToken(v, maxLen).toLowerCase();
}

function normalizeUpperToken(v: unknown, maxLen = 120) {
  return normalizeToken(v, maxLen).toUpperCase();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/foundation_contract_gate.js run [--strict=1|0]');
  console.log('  node systems/ops/foundation_contract_gate.js status');
}

function readFileSafe(absPath: string) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}

function readJsonSafe(absPath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function runGate() {
  const checks: AnyObj[] = [];
  const addCheck = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok: ok === true, detail: cleanText(detail, 400) });
  };

  const requiredFiles = [
    'config/abstraction_debt_baseline.json',
    'config/deterministic_control_plane_policy.json',
    'config/formal_invariants.json',
    'config/profile_compatibility_policy.json',
    'config/primitive_catalog.json',
    'config/primitive_migration_contract.json',
    'config/primitive_policy_vm.json',
    'config/runtime_scheduler_policy.json',
    'config/scale_envelope_policy.json',
    'systems/ops/profile_compatibility_gate.ts',
    'systems/distributed/deterministic_control_plane.ts',
    'systems/primitives/runtime_scheduler.ts',
    'systems/security/formal_invariant_engine.ts',
    'systems/primitives/primitive_runtime.ts',
    'systems/primitives/policy_vm.ts',
    'systems/primitives/replay_verify.ts'
  ];
  for (const rel of requiredFiles) {
    const abs = path.join(ROOT, rel);
    addCheck(`file:${rel}`, fs.existsSync(abs), fs.existsSync(abs) ? 'present' : 'missing');
  }

  const catalog = readJsonSafe(path.join(ROOT, 'config', 'primitive_catalog.json'), {});
  const commandRules = Array.isArray(catalog.command_rules) ? catalog.command_rules.length : 0;
  addCheck(
    'catalog:rules',
    commandRules >= 3,
    `command_rules=${commandRules}`
  );
  const adapterEffectCount = catalog.adapter_effect_map && typeof catalog.adapter_effect_map === 'object'
    ? Object.keys(catalog.adapter_effect_map).length
    : 0;
  addCheck(
    'catalog:adapter_effect_map',
    adapterEffectCount >= 3,
    `adapter_effect_map=${adapterEffectCount}`
  );
  const commandRulesRaw = Array.isArray(catalog.command_rules) ? catalog.command_rules : [];
  const adapterOpcodeMap = catalog.adapter_opcode_map && typeof catalog.adapter_opcode_map === 'object'
    ? catalog.adapter_opcode_map
    : {};
  const adapterEffectMap = catalog.adapter_effect_map && typeof catalog.adapter_effect_map === 'object'
    ? catalog.adapter_effect_map
    : {};
  const opcodeSet = new Set<string>();
  const defaultOpcode = normalizeUpperToken(catalog.default_command_opcode || 'SHELL_EXECUTE', 80) || 'SHELL_EXECUTE';
  opcodeSet.add(defaultOpcode);
  opcodeSet.add('RECEIPT_VERIFY');
  opcodeSet.add('FLOW_GATE');
  opcodeSet.add('ACTUATION_ADAPTER');
  for (const row of commandRulesRaw) {
    const opcode = normalizeUpperToken(row && row.opcode ? row.opcode : '', 80);
    if (opcode) opcodeSet.add(opcode);
  }
  for (const v of Object.values(adapterOpcodeMap)) {
    const opcode = normalizeUpperToken(v, 80);
    if (opcode) opcodeSet.add(opcode);
  }
  const opcodeCount = opcodeSet.size;
  const opcodeCap = Math.max(1, Number(catalog.primitive_count_cap || catalog.opcode_cap || 24) || 24);
  addCheck(
    'catalog:opcode_cap',
    opcodeCount <= opcodeCap,
    `opcodes=${opcodeCount} cap=${opcodeCap}`
  );

  const adaptersCfg = readJsonSafe(path.join(ROOT, 'config', 'actuation_adapters.json'), {});
  const adaptersMap = adaptersCfg && adaptersCfg.adapters && typeof adaptersCfg.adapters === 'object'
    ? adaptersCfg.adapters
    : {};
  const adapterIds = Object.keys(adaptersMap).map((id) => normalizeLowerToken(id, 80)).filter(Boolean);
  const missingOpcodeMappings = adapterIds.filter((id) => !normalizeUpperToken(adapterOpcodeMap[id], 80));
  const missingEffectMappings = adapterIds.filter((id) => !normalizeLowerToken(adapterEffectMap[id], 80));
  addCheck(
    'catalog:adapter_opcode_coverage',
    missingOpcodeMappings.length === 0,
    missingOpcodeMappings.length === 0 ? `covered=${adapterIds.length}` : `missing=${missingOpcodeMappings.join(',')}`
  );
  addCheck(
    'catalog:adapter_effect_coverage',
    missingEffectMappings.length === 0,
    missingEffectMappings.length === 0 ? `covered=${adapterIds.length}` : `missing=${missingEffectMappings.join(',')}`
  );

  const migration = readJsonSafe(path.join(ROOT, 'config', 'primitive_migration_contract.json'), {});
  const migrationVersion = cleanText(migration.schema_version || '', 40);
  const migrationGrammarVersion = cleanText(migration.grammar_version || '', 40);
  addCheck(
    'catalog:migration_contract_version',
    !!migrationVersion && !!migrationGrammarVersion,
    `schema_version=${migrationVersion || 'missing'} grammar_version=${migrationGrammarVersion || 'missing'}`
  );
  const activeOpcodesRaw = Array.isArray(migration.active_opcodes)
    ? migration.active_opcodes
    : Array.isArray(migration.opcodes) ? migration.opcodes : [];
  const activeOpcodeSet = new Set(
    activeOpcodesRaw
      .map((row: unknown) => normalizeUpperToken(row, 80))
      .filter(Boolean)
  );
  const unmappedOpcodes = Array.from(opcodeSet).filter((op) => !activeOpcodeSet.has(op));
  addCheck(
    'catalog:migration_contract_coverage',
    unmappedOpcodes.length === 0,
    unmappedOpcodes.length === 0 ? `covered=${opcodeSet.size}` : `missing=${unmappedOpcodes.join(',')}`
  );

  const debtBaseline = readJsonSafe(path.join(ROOT, 'config', 'abstraction_debt_baseline.json'), {});
  const subExecPolicy = readJsonSafe(path.join(ROOT, 'config', 'sub_executor_synthesis_policy.json'), {});
  const subExecStatePathRaw = cleanText(
    subExecPolicy.state_path || 'state/actuation/sub_executor_synthesis/state.json',
    320
  );
  const subExecStatePath = path.isAbsolute(subExecStatePathRaw)
    ? subExecStatePathRaw
    : path.join(ROOT, subExecStatePathRaw);
  const subExecState = readJsonSafe(subExecStatePath, {});
  const candidates = subExecState && subExecState.candidates && typeof subExecState.candidates === 'object'
    ? Object.values(subExecState.candidates)
    : [];
  const activeDebt = candidates.filter((row: AnyObj) => {
    const status = normalizeLowerToken(row && row.status ? row.status : '', 40);
    return status === 'proposed' || status === 'validated';
  }).length;
  const totalCandidates = candidates.length;
  const maxActiveDebt = Math.max(0, Number(debtBaseline.max_active_sub_executors || 0) || 0);
  const maxTotalCandidates = Math.max(0, Number(debtBaseline.max_total_sub_executor_candidates || 0) || 0);
  addCheck(
    'distill_or_atrophy:active_debt_cap',
    activeDebt <= maxActiveDebt,
    `active_debt=${activeDebt} cap=${maxActiveDebt}`
  );
  addCheck(
    'distill_or_atrophy:total_candidate_cap',
    totalCandidates <= maxTotalCandidates,
    `total_candidates=${totalCandidates} cap=${maxTotalCandidates}`
  );

  const schedulerPolicy = readJsonSafe(path.join(ROOT, 'config', 'runtime_scheduler_policy.json'), {});
  const modes = Array.isArray(schedulerPolicy.modes) ? schedulerPolicy.modes : [];
  const normalizedModes = new Set(modes.map((row: unknown) => normalizeLowerToken(row, 40)).filter(Boolean));
  addCheck(
    'scheduler_modes:contains_dream_inversion',
    normalizedModes.has('dream') && normalizedModes.has('inversion'),
    `modes=${Array.from(normalizedModes).join(',')}`
  );

  const compatPolicy = readJsonSafe(path.join(ROOT, 'config', 'profile_compatibility_policy.json'), {});
  const maxMinorBehind = Math.max(0, Number(compatPolicy.max_minor_behind || 0) || 0);
  addCheck(
    'profile_compatibility:n_minus_2_minimum',
    maxMinorBehind >= 2,
    `max_minor_behind=${maxMinorBehind}`
  );
  const controlPlanePolicy = readJsonSafe(path.join(ROOT, 'config', 'deterministic_control_plane_policy.json'), {});
  const quorumSize = Math.max(0, Number(controlPlanePolicy.quorum_size || 0) || 0);
  addCheck(
    'distributed_control_plane:quorum_floor',
    quorumSize >= 2,
    `quorum_size=${quorumSize}`
  );
  const localTrustDomain = normalizeLowerToken(controlPlanePolicy.local_trust_domain || '', 80);
  addCheck(
    'distributed_control_plane:trust_domain_required',
    !!localTrustDomain,
    `local_trust_domain=${localTrustDomain || 'missing'}`
  );
  const mergeGuardSrc = readFileSafe(path.join(ROOT, 'systems', 'security', 'merge_guard.ts'));
  addCheck(
    'formal_invariant_engine:merge_guard_hook',
    mergeGuardSrc.includes('formal_invariant_engine.js') && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce formal invariant engine'
  );

  const workflowSrc = readFileSafe(path.join(ROOT, 'systems', 'workflow', 'workflow_executor.ts'));
  addCheck(
    'workflow:primitive_runtime_import',
    workflowSrc.includes("require('../primitives/primitive_runtime.js')"),
    'workflow_executor must import primitive runtime'
  );
  addCheck(
    'workflow:primitive_execute_call',
    workflowSrc.includes('executeCommandPrimitiveSync('),
    'workflow_executor must route command execution through primitive runtime'
  );

  const actuationSrc = readFileSafe(path.join(ROOT, 'systems', 'actuation', 'actuation_executor.ts'));
  addCheck(
    'actuation:primitive_runtime_import',
    actuationSrc.includes("require('../primitives/primitive_runtime.js')"),
    'actuation_executor must import primitive runtime'
  );
  addCheck(
    'actuation:primitive_execute_call',
    actuationSrc.includes('executeActuationPrimitiveAsync('),
    'actuation_executor must route adapter execution through primitive runtime'
  );

  const contractCheckSrc = readFileSafe(path.join(ROOT, 'systems', 'spine', 'contract_check.ts'));
  addCheck(
    'contract_check:foundation_hooks',
    contractCheckSrc.includes('foundation_contract_gate.js') && contractCheckSrc.includes('scale_envelope_baseline.js'),
    'contract_check should validate foundation scripts'
  );

  const strict = checks.every((row) => row.ok === true);
  return {
    schema_id: 'foundation_contract_gate',
    schema_version: '1.0',
    ts: nowIso(),
    ok: strict,
    checks,
    failed_checks: checks.filter((row) => row.ok !== true).length
  };
}

function statePath() {
  return path.join(ROOT, 'state', 'ops', 'foundation_contract_gate.json');
}

function writeState(payload: AnyObj) {
  const fp = statePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function cmdRun(args: AnyObj) {
  const strict = boolFlag(args.strict, false);
  const payload = runGate();
  writeState(payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function cmdStatus() {
  const fp = statePath();
  if (!fs.existsSync(fp)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: 'status_not_found',
      state_path: path.relative(ROOT, fp)
    }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${fs.readFileSync(fp, 'utf8')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
