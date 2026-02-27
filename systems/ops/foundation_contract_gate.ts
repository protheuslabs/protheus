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
    'config/primitive_catalog.json',
    'config/primitive_policy_vm.json',
    'config/scale_envelope_policy.json',
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
