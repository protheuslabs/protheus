#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.SIMPLICITY_BUDGET_ROOT
  ? path.resolve(process.env.SIMPLICITY_BUDGET_ROOT)
  : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SIMPLICITY_BUDGET_POLICY_PATH
  ? path.resolve(process.env.SIMPLICITY_BUDGET_POLICY_PATH)
  : path.join(ROOT, 'config', 'simplicity_budget_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/simplicity_budget_gate.js run [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/simplicity_budget_gate.js status [--policy=<path>]');
  console.log('  node systems/ops/simplicity_budget_gate.js capture-baseline [--policy=<path>]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function resolvePath(v: unknown) {
  const text = cleanText(v || '', 320);
  if (!text) return ROOT;
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    schema_id: 'simplicity_budget_policy',
    schema_version: '1.0',
    enabled: true,
    max_system_files: 1400,
    max_system_loc: 450000,
    max_files_per_organ: 140,
    max_primitive_opcodes: 24,
    max_bespoke_actuation_modules: 28,
    require_offset_receipt_for_new_organs: true,
    systems_root: 'systems',
    baseline_path: 'config/simplicity_baseline.json',
    offset_receipts_path: 'state/ops/complexity_offsets.jsonl',
    latest_path: 'state/ops/simplicity_budget/latest.json'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  return {
    schema_id: 'simplicity_budget_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    max_system_files: clampInt(raw.max_system_files, 1, 1_000_000, base.max_system_files),
    max_system_loc: clampInt(raw.max_system_loc, 1, 50_000_000, base.max_system_loc),
    max_files_per_organ: clampInt(raw.max_files_per_organ, 1, 10_000, base.max_files_per_organ),
    max_primitive_opcodes: clampInt(raw.max_primitive_opcodes, 1, 10_000, base.max_primitive_opcodes),
    max_bespoke_actuation_modules: clampInt(
      raw.max_bespoke_actuation_modules,
      0,
      10_000,
      base.max_bespoke_actuation_modules
    ),
    require_offset_receipt_for_new_organs: raw.require_offset_receipt_for_new_organs !== false,
    systems_root: resolvePath(raw.systems_root || base.systems_root),
    baseline_path: resolvePath(raw.baseline_path || base.baseline_path),
    offset_receipts_path: resolvePath(raw.offset_receipts_path || base.offset_receipts_path),
    latest_path: resolvePath(raw.latest_path || base.latest_path),
    policy_path: path.resolve(policyPath)
  };
}

function scanSystemsMetrics(systemsRoot: string) {
  const organMetrics: AnyObj = {};
  let totalFiles = 0;
  let totalLoc = 0;

  const entryDirs = fs.existsSync(systemsRoot)
    ? fs.readdirSync(systemsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];

  for (const entry of entryDirs) {
    const organId = normalizeToken(entry.name, 80);
    if (!organId) continue;
    const absDir = path.join(systemsRoot, entry.name);
    let fileCount = 0;
    let locCount = 0;

    const walk = (dirPath: string) => {
      const rows = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const row of rows) {
        const abs = path.join(dirPath, row.name);
        if (row.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!row.isFile()) continue;
        const ext = path.extname(row.name).toLowerCase();
        if (!['.ts', '.js', '.json', '.md'].includes(ext)) continue;
        fileCount += 1;
        totalFiles += 1;
        try {
          const body = fs.readFileSync(abs, 'utf8');
          const loc = body.split('\n').filter((line) => String(line || '').trim().length > 0).length;
          locCount += loc;
          totalLoc += loc;
        } catch {
          // Ignore unreadable files.
        }
      }
    };

    walk(absDir);
    organMetrics[organId] = {
      organ_id: organId,
      file_count: fileCount,
      loc: locCount
    };
  }

  const actuationDir = path.join(systemsRoot, 'actuation');
  let bespokeActuationModules = 0;
  if (fs.existsSync(actuationDir)) {
    const rows = fs.readdirSync(actuationDir).filter((name) => name.endsWith('.ts'));
    bespokeActuationModules = rows.filter((name) => ![
      'actuation_executor.ts',
      'universal_execution_primitive.ts',
      'adapter_defragmentation.ts',
      'sub_executor_synthesis.ts',
      'claw_registry.ts',
      'real_world_claws_bundle.ts'
    ].includes(name)).length;
  }

  return {
    total_files: totalFiles,
    total_loc: totalLoc,
    organ_metrics: organMetrics,
    bespoke_actuation_modules: bespokeActuationModules,
    organs: Object.keys(organMetrics).sort()
  };
}

function currentPrimitiveOpcodeCount() {
  const catalog = readJson(path.join(ROOT, 'config', 'primitive_catalog.json'), {});
  const set = new Set<string>();
  if (catalog.default_command_opcode) set.add(String(catalog.default_command_opcode));
  const commandRules = Array.isArray(catalog.command_rules) ? catalog.command_rules : [];
  for (const row of commandRules) {
    const op = String(row && row.opcode || '').trim().toUpperCase();
    if (op) set.add(op);
  }
  const adapterMap = catalog.adapter_opcode_map && typeof catalog.adapter_opcode_map === 'object'
    ? Object.values(catalog.adapter_opcode_map)
    : [];
  for (const value of adapterMap) {
    const op = String(value || '').trim().toUpperCase();
    if (op) set.add(op);
  }
  return set.size;
}

function loadBaseline(policy: AnyObj) {
  return readJson(policy.baseline_path, {
    schema_id: 'simplicity_baseline',
    schema_version: '1.0',
    organs: [],
    max_bespoke_actuation_modules: policy.max_bespoke_actuation_modules
  });
}

function captureBaseline(policy: AnyObj) {
  const metrics = scanSystemsMetrics(policy.systems_root);
  const baseline = {
    schema_id: 'simplicity_baseline',
    schema_version: '1.0',
    captured_at: nowIso(),
    organs: metrics.organs,
    organ_file_counts: Object.fromEntries(Object.entries(metrics.organ_metrics).map(([k, v]) => [k, Number((v as AnyObj).file_count || 0)])),
    max_bespoke_actuation_modules: Number(metrics.bespoke_actuation_modules || 0)
  };
  writeJsonAtomic(policy.baseline_path, baseline);
  return baseline;
}

function runGate(policy: AnyObj) {
  const metrics = scanSystemsMetrics(policy.systems_root);
  const baseline = loadBaseline(policy);
  const offsets = readJsonl(policy.offset_receipts_path);
  const checks: AnyObj[] = [];
  const addCheck = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok: ok === true, detail: cleanText(detail, 320) });
  };

  addCheck('system_files_budget', metrics.total_files <= policy.max_system_files, `files=${metrics.total_files} cap=${policy.max_system_files}`);
  addCheck('system_loc_budget', metrics.total_loc <= policy.max_system_loc, `loc=${metrics.total_loc} cap=${policy.max_system_loc}`);
  addCheck('primitive_opcode_budget', currentPrimitiveOpcodeCount() <= policy.max_primitive_opcodes, `opcodes=${currentPrimitiveOpcodeCount()} cap=${policy.max_primitive_opcodes}`);
  addCheck(
    'bespoke_actuation_budget',
    metrics.bespoke_actuation_modules <= policy.max_bespoke_actuation_modules,
    `bespoke_actuation_modules=${metrics.bespoke_actuation_modules} cap=${policy.max_bespoke_actuation_modules}`
  );

  const organRows = Object.values(metrics.organ_metrics) as AnyObj[];
  for (const row of organRows) {
    const organId = String(row.organ_id || 'unknown');
    addCheck(
      `organ_budget:${organId}`,
      Number(row.file_count || 0) <= policy.max_files_per_organ,
      `files=${Number(row.file_count || 0)} cap=${policy.max_files_per_organ}`
    );
  }

  const baselineOrgans = new Set(Array.isArray(baseline.organs) ? baseline.organs.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean) : []);
  const newOrgans = metrics.organs.filter((organId: string) => !baselineOrgans.has(organId));
  if (policy.require_offset_receipt_for_new_organs === true) {
    const offsetOrgans = new Set(
      offsets
        .filter((row: AnyObj) => row && row.approved === true)
        .map((row: AnyObj) => normalizeToken(row.organ_id || '', 80))
        .filter(Boolean)
    );
    const missingOffsets = newOrgans.filter((organId: string) => !offsetOrgans.has(organId));
    addCheck(
      'new_organs_offset_receipts',
      missingOffsets.length === 0,
      missingOffsets.length ? `missing_offsets=${missingOffsets.join(',')}` : 'all_new_organs_offset_attested'
    );
  }

  const baselineBespoke = Number(baseline.max_bespoke_actuation_modules || policy.max_bespoke_actuation_modules || 0);
  addCheck(
    'bespoke_trend_non_increasing',
    metrics.bespoke_actuation_modules <= baselineBespoke,
    `current=${metrics.bespoke_actuation_modules} baseline=${baselineBespoke}`
  );

  const ok = checks.every((row) => row.ok === true);
  const payload = {
    ok,
    type: 'simplicity_budget_gate',
    ts: nowIso(),
    policy_version: policy.schema_version,
    policy_path: rel(policy.policy_path),
    baseline_path: rel(policy.baseline_path),
    offset_receipts_path: rel(policy.offset_receipts_path),
    total_files: metrics.total_files,
    total_loc: metrics.total_loc,
    organ_count: metrics.organs.length,
    bespoke_actuation_modules: metrics.bespoke_actuation_modules,
    new_organs: newOrgans,
    checks,
    failed_checks: checks.filter((row) => row.ok !== true).length
  };
  writeJsonAtomic(policy.latest_path, payload);
  return payload;
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, false);
  const payload = runGate(policy);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const payload = readJson(policy.latest_path, null);
  if (!payload) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'status_not_found', latest_path: rel(policy.latest_path) }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function cmdCaptureBaseline(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const baseline = captureBaseline(policy);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'simplicity_baseline_capture',
    baseline_path: rel(policy.baseline_path),
    baseline
  }, null, 2)}\n`);
}

function main(argv: string[]) {
  const args = parseArgs(argv);
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'capture-baseline') return cmdCaptureBaseline(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  runGate,
  captureBaseline
};
