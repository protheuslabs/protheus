#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.COGNITIVE_CONTROL_POLICY_PATH
  ? path.resolve(process.env.COGNITIVE_CONTROL_POLICY_PATH)
  : path.join(ROOT, 'config', 'cognitive_control_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 280) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
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
function toBool(v: unknown, fallback = false) { if (v == null) return fallback; const raw = String(v).trim().toLowerCase(); if (['1','true','yes','on'].includes(raw)) return true; if (['0','false','no','off'].includes(raw)) return false; return fallback; }
function resolvePath(raw: unknown, fallbackRel: string) { const txt = cleanText(raw || '', 520); if (!txt) return path.join(ROOT, fallbackRel); return path.isAbsolute(txt) ? txt : path.join(ROOT, txt); }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    min_sufficiency: 0.55,
    max_retrieval_items: 6,
    receipts_path: 'state/primitives/cognitive_control/receipts.jsonl',
    latest_path: 'state/primitives/cognitive_control/latest.json'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    shadow_only: src.shadow_only !== false,
    min_sufficiency: Number(src.min_sufficiency != null ? src.min_sufficiency : base.min_sufficiency) || base.min_sufficiency,
    max_retrieval_items: Number(src.max_retrieval_items != null ? src.max_retrieval_items : base.max_retrieval_items) || base.max_retrieval_items,
    receipts_path: resolvePath(src.receipts_path || base.receipts_path, base.receipts_path),
    latest_path: resolvePath(src.latest_path || base.latest_path, base.latest_path)
  };
}

function runPrimitive(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) return { ok: false, type: 'cognitive_control_run', error: 'policy_disabled' };

  const objectiveId = normalizeToken(args['objective-id'] || args.objective_id || '', 180) || null;
  const query = cleanText(args.query || args.prompt || '', 1200);
  const retrievalSource = cleanText(args['retrieval-source'] || args.retrieval_source || 'memory_index', 120);
  if (!query) return { ok: false, type: 'cognitive_control_run', error: 'query_required' };

  const sufficiency = Math.max(0, Math.min(1, Number(args.sufficiency || 0.72) || 0.72));
  const prethink = {
    stage: 'prethink',
    sufficiency,
    threshold: Number(policy.min_sufficiency || 0.55),
    needs_retrieval: sufficiency < Number(policy.min_sufficiency || 0.55)
  };
  const retrievalCount = prethink.needs_retrieval
    ? Math.max(1, Math.min(Number(policy.max_retrieval_items || 6), Number(args['retrieval-count'] || args.retrieval_count || 3) || 3))
    : Math.max(1, Math.min(Number(policy.max_retrieval_items || 6), Number(args['retrieval-count'] || args.retrieval_count || 2) || 2));

  const retrieve = {
    stage: 'retrieve',
    source: retrievalSource,
    item_count: retrievalCount,
    selected_keys: Array.from({ length: retrievalCount }).map((_, idx) => `ctx_${idx + 1}`)
  };
  const write = {
    stage: 'write',
    compression_ratio: Number((1 / Math.max(1, retrievalCount)).toFixed(3)),
    summary: cleanText(query, 220)
  };

  const out = {
    ok: true,
    type: 'cognitive_control_run',
    ts: nowIso(),
    objective_id: objectiveId,
    query,
    shadow_only: policy.shadow_only === true,
    stages: {
      prethink,
      retrieve,
      write
    }
  };
  appendJsonl(policy.receipts_path, out);
  writeJsonAtomic(policy.latest_path, out);
  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  const receiptsCount = fs.existsSync(policy.receipts_path)
    ? String(fs.readFileSync(policy.receipts_path, 'utf8') || '').split('\n').filter(Boolean).length
    : 0;
  return {
    ok: true,
    type: 'cognitive_control_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      min_sufficiency: policy.min_sufficiency,
      max_retrieval_items: policy.max_retrieval_items,
      shadow_only: policy.shadow_only === true
    },
    receipts_count: receiptsCount,
    latest: latest && typeof latest === 'object'
      ? {
        ts: latest.ts || null,
        objective_id: latest.objective_id || null,
        retrieval_items: latest.stages && latest.stages.retrieve ? Number(latest.stages.retrieve.item_count || 0) : 0
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
  console.log('  node systems/primitives/cognitive_control_primitive.js run --query="..." [--objective-id=<id>] [--sufficiency=0.7] [--retrieval-count=3]');
  console.log('  node systems/primitives/cognitive_control_primitive.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'help' || args.help) { usage(); process.exit(0); }
  if (cmd === 'run') out = runPrimitive(args);
  else if (cmd === 'status') out = status(args);
  else out = { ok: false, type: 'cognitive_control', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true && toBool(args.strict, false)) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  runPrimitive,
  status
};
