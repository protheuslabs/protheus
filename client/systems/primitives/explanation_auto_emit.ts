#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.EXPLANATION_AUTO_EMIT_ROOT
  ? path.resolve(process.env.EXPLANATION_AUTO_EMIT_ROOT)
  : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.EXPLANATION_AUTO_EMIT_POLICY_PATH
  ? path.resolve(process.env.EXPLANATION_AUTO_EMIT_POLICY_PATH)
  : path.join(ROOT, 'config', 'explanation_auto_emit_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 320) {
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
  const out: Record<string, any> = { _: [] };
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
  console.log('  node systems/primitives/explanation_auto_emit.js run [--hours=24] [--max-emits=6] [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/primitives/explanation_auto_emit.js status [--policy=<path>]');
}
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}
function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath: string, row: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || '', 600);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}
function rel(absPath: string) { return path.relative(ROOT, absPath).replace(/\\/g, '/'); }
function listCanonicalFiles(eventsDir: string) {
  if (!fs.existsSync(eventsDir)) return [];
  return fs.readdirSync(eventsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(eventsDir, name))
    .filter((absPath) => {
      try { return fs.statSync(absPath).isFile(); } catch { return false; }
    })
    .sort((a, b) => a.localeCompare(b));
}
function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    default_hours: 24,
    max_emits_default: 6,
    include_event_types: ['primitive_execution', 'route_execute', 'workflow_execution', 'policy_decision'],
    only_failures: true,
    canonical_events_dir: 'state/runtime/canonical_events',
    explanation_index_path: 'state/primitives/explanation_primitive/index.json',
    latest_path: 'state/primitives/explanation_auto_emit/latest.json',
    receipts_path: 'state/primitives/explanation_auto_emit/receipts.jsonl'
  };
}
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const includeTypes = Array.isArray(raw.include_event_types)
    ? raw.include_event_types.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
    : base.include_event_types;
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    default_hours: clampInt(raw.default_hours, 1, 24 * 180, base.default_hours),
    max_emits_default: clampInt(raw.max_emits_default, 1, 500, base.max_emits_default),
    include_event_types: includeTypes.length ? includeTypes : base.include_event_types,
    only_failures: toBool(raw.only_failures, base.only_failures),
    canonical_events_dir: resolvePath(raw.canonical_events_dir || base.canonical_events_dir, base.canonical_events_dir),
    explanation_index_path: resolvePath(raw.explanation_index_path || base.explanation_index_path, base.explanation_index_path),
    latest_path: resolvePath(raw.latest_path || base.latest_path, base.latest_path),
    receipts_path: resolvePath(raw.receipts_path || base.receipts_path, base.receipts_path),
    policy_path: path.resolve(policyPath)
  };
}

function existingExplainedEventIds(indexPath: string) {
  const index = readJson(indexPath, {});
  const rows = Array.isArray(index.explanations) ? index.explanations : [];
  const set = new Set<string>();
  for (const row of rows) {
    const eventId = cleanText(row && row.event_id || '', 120);
    if (eventId) set.add(eventId);
  }
  return set;
}

function shouldConsiderEvent(row: Record<string, any>, policy: Record<string, any>, sinceMs: number) {
  const tsMs = Date.parse(String(row && row.ts || ''));
  if (!Number.isFinite(tsMs) || tsMs < sinceMs) return false;
  const type = normalizeToken(row && row.type || '', 80);
  if (!policy.include_event_types.includes(type)) return false;
  if (String(row && row.phase || '') !== 'finish') return false;
  if (policy.only_failures === true && row.ok !== false) return false;
  return true;
}

function buildSummary(row: Record<string, any>) {
  const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
  const opcode = cleanText(row.opcode || 'unknown', 80) || 'unknown';
  const effect = cleanText(row.effect || 'unknown', 80) || 'unknown';
  const adapter = cleanText(payload.adapter_kind || payload.adapter || 'unknown', 100) || 'unknown';
  const dryRun = payload.dry_run === true ? 'dry-run' : 'live';
  const ok = row.ok === true ? 'ok' : (row.ok === false ? 'failed' : 'unknown');
  return `${opcode} ${effect} ${adapter} ${dryRun} execution ${ok}`.slice(0, 280);
}

function emitExplanation(eventId: string, summary: string, apply = true) {
  const args = [
    'systems/primitives/explanation_primitive.js',
    'explain',
    `--event-id=${eventId}`,
    '--category=major_decision',
    `--summary=${summary}`,
    '--proof-link=auto_emit',
    `--apply=${apply ? '1' : '0'}`
  ];
  const r = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  let parsed = null;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch { parsed = null; }
  return {
    ok: r.status === 0,
    status: Number(r.status || 0),
    stdout,
    stderr: String(r.stderr || '').trim(),
    parsed
  };
}

function runAutoEmit(args: Record<string, any>) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const hours = clampInt(args.hours, 1, 24 * 180, policy.default_hours);
  const maxEmits = clampInt(args['max-emits'] ?? args.max_emits, 1, 500, policy.max_emits_default);
  const apply = toBool(args.apply, true);
  const sinceMs = Date.now() - (hours * 3600000);
  const explained = existingExplainedEventIds(policy.explanation_index_path);

  const candidates: Record<string, any>[] = [];
  for (const filePath of listCanonicalFiles(policy.canonical_events_dir)) {
    for (const row of readJsonl(filePath)) {
      if (!shouldConsiderEvent(row, policy, sinceMs)) continue;
      const eventId = cleanText(row && row.event_id || '', 120);
      if (!eventId || explained.has(eventId)) continue;
      candidates.push({
        event_id: eventId,
        ts: row.ts || null,
        type: row.type || null,
        opcode: row.opcode || null,
        summary: buildSummary(row)
      });
    }
  }
  candidates.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));

  const emits = [] as Record<string, any>[];
  let failures = 0;
  for (const row of candidates.slice(0, maxEmits)) {
    const emit = emitExplanation(String(row.event_id || ''), String(row.summary || ''), apply);
    const ok = emit.ok === true && emit.parsed && emit.parsed.ok === true;
    if (!ok) failures += 1;
    emits.push({
      event_id: row.event_id,
      summary: row.summary,
      ok,
      explanation_id: emit.parsed && emit.parsed.explanation_id ? emit.parsed.explanation_id : null,
      status: emit.status,
      error: ok ? null : (emit.parsed && emit.parsed.error ? emit.parsed.error : (emit.stderr || 'emit_failed'))
    });
  }

  const out = {
    ok: failures === 0,
    type: 'explanation_auto_emit',
    ts: nowIso(),
    apply,
    hours,
    max_emits: maxEmits,
    policy_path: rel(policy.policy_path),
    candidates_seen: candidates.length,
    emitted: emits.length,
    failures,
    emits,
    paths: {
      canonical_events_dir: rel(policy.canonical_events_dir),
      explanation_index_path: rel(policy.explanation_index_path),
      latest_path: rel(policy.latest_path),
      receipts_path: rel(policy.receipts_path)
    }
  };

  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  return out;
}

function cmdStatus(args: Record<string, any>) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  if (!latest || typeof latest !== 'object') {
    return {
      ok: false,
      type: 'explanation_auto_emit_status',
      reason: 'status_not_found',
      latest_path: rel(policy.latest_path)
    };
  }
  return {
    ok: true,
    type: 'explanation_auto_emit_status',
    ts: nowIso(),
    latest,
    latest_path: rel(policy.latest_path),
    receipts_path: rel(policy.receipts_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 64);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    const out = runAutoEmit(args);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (toBool(args.strict, false) && out.ok !== true) process.exit(1);
    return;
  }
  if (cmd === 'status') {
    const out = cmdStatus(args);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (!out.ok) process.exit(1);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  runAutoEmit,
  cmdStatus
};
