#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.RESONANCE_GATES_POLICY_PATH
  ? path.resolve(process.env.RESONANCE_GATES_POLICY_PATH)
  : path.join(ROOT, 'config', 'resonance_field_gates_policy.json');
const LATEST_PATH = process.env.RESONANCE_GATES_LATEST_PATH
  ? path.resolve(process.env.RESONANCE_GATES_LATEST_PATH)
  : path.join(ROOT, 'state', 'fractal', 'resonance_field_gates', 'latest.json');
const RECEIPTS_PATH = process.env.RESONANCE_GATES_RECEIPTS_PATH
  ? path.resolve(process.env.RESONANCE_GATES_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'fractal', 'resonance_field_gates', 'receipts.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  return Math.floor(clampNumber(v, lo, hi, fallback));
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[token.slice(2)] = true;
    else out[token.slice(2, idx)] = token.slice(idx + 1);
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    max_influence: 0.25,
    min_confidence: 0.6,
    fallback_confidence_floor: 0.45,
    min_consensus_sources: 2,
    allowed_objective_prefixes: [],
    auto_fallback_on_drop: true
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    max_influence: clampNumber(raw.max_influence, 0, 1, base.max_influence),
    min_confidence: clampNumber(raw.min_confidence, 0, 1, base.min_confidence),
    fallback_confidence_floor: clampNumber(raw.fallback_confidence_floor, 0, 1, base.fallback_confidence_floor),
    min_consensus_sources: clampInt(raw.min_consensus_sources, 1, 64, base.min_consensus_sources),
    allowed_objective_prefixes: Array.from(
      new Set((Array.isArray(raw.allowed_objective_prefixes) ? raw.allowed_objective_prefixes : base.allowed_objective_prefixes)
        .map((v: unknown) => normalizeToken(v, 80))
        .filter(Boolean))
    ),
    auto_fallback_on_drop: raw.auto_fallback_on_drop !== false
  };
}

function parseResonance(raw: unknown) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/fractal/resonance_field_gates.js evaluate --objective-id=<id> --resonance-json="{score,confidence,sources:[...]}"');
  console.log('  node systems/fractal/resonance_field_gates.js status');
}

function cmdEvaluate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const ts = nowIso();
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'resonance_field_evaluate', error: 'resonance_gates_disabled' })}\n`);
    process.exit(1);
  }

  const objectiveId = normalizeToken(args.objective_id || args['objective-id'] || '', 120) || 'unknown_objective';
  const resonance = parseResonance(args.resonance_json || args['resonance-json']);
  const score = clampNumber(resonance.score, 0, 1, 0);
  const confidence = clampNumber(resonance.confidence, 0, 1, 0);
  const sources = Array.from(new Set((Array.isArray(resonance.sources) ? resonance.sources : [])
    .map((v: unknown) => normalizeToken(v, 80))
    .filter(Boolean)));

  const blocked: string[] = [];
  if (sources.length < policy.min_consensus_sources) blocked.push('consensus_sources_below_min');
  if (confidence < policy.min_confidence) blocked.push('confidence_below_min');
  if (policy.allowed_objective_prefixes.length > 0) {
    const allowed = policy.allowed_objective_prefixes.some((prefix: string) => objectiveId.startsWith(prefix));
    if (!allowed) blocked.push('objective_not_allowlisted');
  }

  let hint = 'hold';
  if (score >= 0.75) hint = 'accelerate';
  else if (score >= 0.55) hint = 'steady';
  else if (score >= 0.35) hint = 'caution';
  else hint = 'fallback';

  let influence = Number((score * policy.max_influence).toFixed(6));
  let fallback = false;
  if (policy.auto_fallback_on_drop && confidence < policy.fallback_confidence_floor) {
    fallback = true;
    influence = 0;
    blocked.push('confidence_below_fallback_floor');
    hint = 'fallback';
  }
  if (blocked.length) influence = 0;

  const out = {
    ok: blocked.length === 0,
    type: 'resonance_field_evaluate',
    ts,
    objective_id: objectiveId,
    resonance: {
      score,
      confidence,
      sources
    },
    hint,
    influence,
    blocked,
    fallback
  };
  writeJsonAtomic(LATEST_PATH, out);
  appendJsonl(RECEIPTS_PATH, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (blocked.length) process.exit(1);
}

function cmdStatus() {
  const latest = readJson(LATEST_PATH, null);
  if (!latest) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'resonance_field_status', error: 'status_not_found' })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'resonance_field_status', latest })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

