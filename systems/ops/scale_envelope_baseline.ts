#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { compileCommandToGrammar, compileActuationToGrammar } = require('../primitives/action_grammar.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SCALE_ENVELOPE_POLICY_PATH
  ? path.resolve(process.env.SCALE_ENVELOPE_POLICY_PATH)
  : path.join(ROOT, 'config', 'scale_envelope_policy.json');
const DEFAULT_STATE_PATH = process.env.SCALE_ENVELOPE_STATE_PATH
  ? path.resolve(process.env.SCALE_ENVELOPE_STATE_PATH)
  : path.join(ROOT, 'state', 'ops', 'scale_envelope', 'latest.json');
const DEFAULT_HISTORY_PATH = process.env.SCALE_ENVELOPE_HISTORY_PATH
  ? path.resolve(process.env.SCALE_ENVELOPE_HISTORY_PATH)
  : path.join(ROOT, 'state', 'ops', 'scale_envelope', 'history.jsonl');

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

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    schema_id: 'scale_envelope_policy',
    schema_version: '1.0',
    parity_threshold: 1,
    profiles: [
      { id: 'phone_seed', surface_budget: 0.35, max_parallel: 1 },
      { id: 'desktop_seed', surface_budget: 0.7, max_parallel: 4 },
      { id: 'cluster_sim', surface_budget: 1, max_parallel: 16 }
    ],
    scenarios: []
  };
}

function loadPolicy() {
  const base = defaultPolicy();
  const raw = readJson(DEFAULT_POLICY_PATH, base);
  const profiles = Array.isArray(raw.profiles) ? raw.profiles : base.profiles;
  const scenarios = Array.isArray(raw.scenarios) ? raw.scenarios : base.scenarios;
  return {
    schema_id: 'scale_envelope_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || '1.0',
    parity_threshold: Number.isFinite(Number(raw.parity_threshold))
      ? Math.max(0, Math.min(1, Number(raw.parity_threshold)))
      : 1,
    profiles: profiles.map((row: AnyObj, i: number) => ({
      id: cleanText(row && row.id ? row.id : `profile_${i + 1}`, 80) || `profile_${i + 1}`,
      surface_budget: Number.isFinite(Number(row && row.surface_budget))
        ? Math.max(0, Math.min(1, Number(row.surface_budget)))
        : 0.5,
      max_parallel: Number.isFinite(Number(row && row.max_parallel))
        ? Math.max(1, Math.min(128, Math.floor(Number(row.max_parallel))))
        : 1
    })),
    scenarios: scenarios.map((row: AnyObj, i: number) => ({
      id: cleanText(row && row.id ? row.id : `scenario_${i + 1}`, 120) || `scenario_${i + 1}`,
      kind: cleanText(row && row.kind ? row.kind : 'command', 40).toLowerCase() || 'command',
      command: cleanText(row && row.command ? row.command : '', 4000),
      adapter: cleanText(row && row.adapter ? row.adapter : '', 80),
      step_type: cleanText(row && row.step_type ? row.step_type : 'command', 40).toLowerCase() || 'command'
    }))
  };
}

function compileScenario(profile: AnyObj, scenario: AnyObj) {
  const ctx = {
    workflow_id: `scale-envelope-${scenario.id}`,
    run_id: `scale-envelope-${profile.id}`,
    objective_id: 'foundation_scale_envelope',
    dry_run: true
  };
  if (scenario.kind === 'adapter') {
    return compileActuationToGrammar(scenario.adapter || 'unknown_adapter', {}, ctx);
  }
  return compileCommandToGrammar(scenario.command || '', {
    ...ctx,
    step_id: scenario.id,
    step_type: scenario.step_type || 'command'
  });
}

function runEnvelope() {
  const policy = loadPolicy();
  const profiles = Array.isArray(policy.profiles) ? policy.profiles : [];
  const scenarios = Array.isArray(policy.scenarios) ? policy.scenarios : [];
  const runs: AnyObj[] = [];
  for (const profile of profiles) {
    for (const scenario of scenarios) {
      const grammar = compileScenario(profile, scenario);
      runs.push({
        profile_id: profile.id,
        scenario_id: scenario.id,
        opcode: grammar.opcode,
        effect: grammar.effect,
        runtime_kind: grammar.runtime_kind
      });
    }
  }

  const scenarioMap: Record<string, AnyObj[]> = {};
  for (const row of runs) {
    const key = String(row.scenario_id || '');
    if (!scenarioMap[key]) scenarioMap[key] = [];
    scenarioMap[key].push(row);
  }
  const mismatches: AnyObj[] = [];
  for (const [scenarioId, rows] of Object.entries(scenarioMap)) {
    const first = rows[0];
    for (let i = 1; i < rows.length; i += 1) {
      const cur = rows[i];
      if (
        String(cur.opcode) !== String(first.opcode)
        || String(cur.effect) !== String(first.effect)
        || String(cur.runtime_kind) !== String(first.runtime_kind)
      ) {
        mismatches.push({
          scenario_id: scenarioId,
          expected: {
            opcode: first.opcode,
            effect: first.effect,
            runtime_kind: first.runtime_kind
          },
          actual: {
            profile_id: cur.profile_id,
            opcode: cur.opcode,
            effect: cur.effect,
            runtime_kind: cur.runtime_kind
          }
        });
      }
    }
  }

  const parityScore = runs.length > 0
    ? Number(((runs.length - mismatches.length) / runs.length).toFixed(4))
    : 1;
  return {
    schema_id: 'scale_envelope_baseline',
    schema_version: '1.0',
    ts: nowIso(),
    ok: mismatches.length === 0,
    policy_version: policy.schema_version,
    profile_count: profiles.length,
    scenario_count: scenarios.length,
    parity_score: parityScore,
    parity_threshold: Number(policy.parity_threshold || 1),
    mismatches,
    runs
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/scale_envelope_baseline.js run [--strict=1|0]');
  console.log('  node systems/ops/scale_envelope_baseline.js status');
}

function cmdRun(args: AnyObj) {
  const strict = boolFlag(args.strict, false);
  const payload = runEnvelope();
  writeJsonAtomic(DEFAULT_STATE_PATH, payload);
  appendJsonl(DEFAULT_HISTORY_PATH, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  const thresholdPass = Number(payload.parity_score || 0) >= Number(payload.parity_threshold || 1);
  if (strict && (!payload.ok || !thresholdPass)) process.exit(1);
}

function cmdStatus() {
  if (!fs.existsSync(DEFAULT_STATE_PATH)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: 'status_not_found',
      state_path: path.relative(ROOT, DEFAULT_STATE_PATH)
    }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${fs.readFileSync(DEFAULT_STATE_PATH, 'utf8')}\n`);
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
