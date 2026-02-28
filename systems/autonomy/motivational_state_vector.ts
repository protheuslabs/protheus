#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.MOTIVATIONAL_STATE_VECTOR_POLICY_PATH
  ? path.resolve(process.env.MOTIVATIONAL_STATE_VECTOR_POLICY_PATH)
  : path.join(ROOT, 'config', 'motivational_state_vector_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 260) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function normalizeToken(v: unknown, maxLen = 160) { return cleanText(v, maxLen).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, ''); }
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any) { try { if (!fs.existsSync(filePath)) return fallback; const p = JSON.parse(fs.readFileSync(filePath, 'utf8')); return p == null ? fallback : p; } catch { return fallback; } }
function writeJsonAtomic(filePath: string, value: AnyObj) { ensureDir(path.dirname(filePath)); const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, filePath); }
function appendJsonl(filePath: string, row: AnyObj) { ensureDir(path.dirname(filePath)); fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8'); }
function relPath(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const idx = tok.indexOf('=');
    if (idx >= 0) { out[tok.slice(2, idx)] = tok.slice(idx + 1); continue; }
    const key = tok.slice(2); const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
    out[key] = true;
  }
  return out;
}
function resolvePath(raw: unknown, fallbackRel: string) { const txt = cleanText(raw || '', 520); if (!txt) return path.join(ROOT, fallbackRel); return path.isAbsolute(txt) ? txt : path.join(ROOT, txt); }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    advisory_only: true,
    min_vector: 0,
    max_vector: 1,
    receipts_path: 'state/autonomy/motivational_state_vector/receipts.jsonl',
    latest_path: 'state/autonomy/motivational_state_vector/latest.json'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    advisory_only: src.advisory_only !== false,
    min_vector: Number(src.min_vector != null ? src.min_vector : base.min_vector),
    max_vector: Number(src.max_vector != null ? src.max_vector : base.max_vector),
    receipts_path: resolvePath(src.receipts_path || base.receipts_path, base.receipts_path),
    latest_path: resolvePath(src.latest_path || base.latest_path, base.latest_path)
  };
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function evaluate(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) return { ok: false, type: 'motivational_state_vector_evaluate', error: 'policy_disabled' };

  const competence = clamp(Number(args.competence != null ? args.competence : 0.6), policy.min_vector, policy.max_vector);
  const caution = clamp(Number(args.caution != null ? args.caution : 0.5), policy.min_vector, policy.max_vector);
  const exploration = clamp(Number(args.exploration != null ? args.exploration : 0.55), policy.min_vector, policy.max_vector);
  const blended = {
    competence,
    caution,
    exploration,
    confidence: Number(((competence * 0.45) + ((1 - caution) * 0.2) + (exploration * 0.35)).toFixed(4))
  };
  const routingHint = blended.confidence >= 0.65
    ? 'balanced_growth'
    : blended.confidence >= 0.45
      ? 'guarded_iterate'
      : 'conservative_stabilize';

  const out = {
    ok: true,
    type: 'motivational_state_vector_evaluate',
    ts: nowIso(),
    advisory_only: policy.advisory_only === true,
    vector: blended,
    routing_hint: routingHint,
    objective_id: normalizeToken(args['objective-id'] || args.objective_id || '', 180) || null
  };
  appendJsonl(policy.receipts_path, out);
  writeJsonAtomic(policy.latest_path, out);
  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  const count = fs.existsSync(policy.receipts_path)
    ? String(fs.readFileSync(policy.receipts_path, 'utf8') || '').split('\n').filter(Boolean).length
    : 0;
  return {
    ok: true,
    type: 'motivational_state_vector_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      advisory_only: policy.advisory_only === true
    },
    receipts_count: count,
    latest: latest && typeof latest === 'object'
      ? {
        ts: latest.ts || null,
        routing_hint: latest.routing_hint || null,
        confidence: latest.vector && Number(latest.vector.confidence || 0)
      }
      : null,
    paths: {
      receipts_path: relPath(policy.receipts_path),
      latest_path: relPath(policy.latest_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/motivational_state_vector.js evaluate [--competence=0.6] [--caution=0.5] [--exploration=0.55] [--objective-id=<id>]');
  console.log('  node systems/autonomy/motivational_state_vector.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'help' || args.help) { usage(); process.exit(0); }
  if (cmd === 'evaluate') out = evaluate(args);
  else if (cmd === 'status') out = status(args);
  else out = { ok: false, type: 'motivational_state_vector', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  evaluate,
  status
};
