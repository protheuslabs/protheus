#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-018
 * Proposal admission + queue hygiene hardening.
 *
 * Usage:
 *   node systems/autonomy/proposal_admission_hygiene.js run [--apply=1|0] [--strict=1|0]
 *   node systems/autonomy/proposal_admission_hygiene.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.PROPOSAL_HYGIENE_ROOT
  ? path.resolve(process.env.PROPOSAL_HYGIENE_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.PROPOSAL_HYGIENE_POLICY_PATH
  ? path.resolve(process.env.PROPOSAL_HYGIENE_POLICY_PATH)
  : path.join(ROOT, 'config', 'proposal_admission_hygiene_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 360) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const eq = tok.indexOf('=');
    if (eq >= 0) { out[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
    out[key] = true;
  }
  return out;
}
function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = null) {
  try { if (!fs.existsSync(filePath)) return fallback; const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); return parsed == null ? fallback : parsed; } catch { return fallback; }
}
function readJsonl(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const lines = String(fs.readFileSync(filePath, 'utf8') || '').split(/\r?\n/).filter(Boolean);
  const out: AnyObj[] = [];
  for (const line of lines) {
    try { const row = JSON.parse(line); if (row && typeof row === 'object') out.push(row); } catch {}
  }
  return out;
}
function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath)); const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath: string, row: AnyObj) { ensureDir(path.dirname(filePath)); fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8'); }
function resolvePath(raw: unknown, fallbackRel: string) { const txt = cleanText(raw, 520); if (!txt) return path.join(ROOT, fallbackRel); return path.isAbsolute(txt) ? txt : path.join(ROOT, txt); }
function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function asStringArray(v: unknown) {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) { const s = cleanText(item, 80).toLowerCase(); if (!s) continue; if (!out.includes(s)) out.push(s); }
  return out;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    inputs: {
      proposals_path: 'state/autonomy/proposal_admission_hygiene/proposals.jsonl'
    },
    static_gate: {
      unknown_eye_blocklist: ['unknown', 'stub', 'unmapped'],
      title_stub_tokens: ['stub', 'placeholder', 'tbd']
    },
    outputs: {
      latest_path: 'state/autonomy/proposal_admission_hygiene/latest.json',
      history_path: 'state/autonomy/proposal_admission_hygiene/history.jsonl',
      accepted_path: 'state/autonomy/proposal_admission_hygiene/accepted.json',
      filtered_path: 'state/autonomy/proposal_admission_hygiene/filtered.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const inputs = raw.inputs && typeof raw.inputs === 'object' ? raw.inputs : {};
  const gate = raw.static_gate && typeof raw.static_gate === 'object' ? raw.static_gate : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    inputs: {
      proposals_path: resolvePath(inputs.proposals_path, base.inputs.proposals_path)
    },
    static_gate: {
      unknown_eye_blocklist: asStringArray(gate.unknown_eye_blocklist || base.static_gate.unknown_eye_blocklist),
      title_stub_tokens: asStringArray(gate.title_stub_tokens || base.static_gate.title_stub_tokens)
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path),
      accepted_path: resolvePath(outputs.accepted_path, base.outputs.accepted_path),
      filtered_path: resolvePath(outputs.filtered_path, base.outputs.filtered_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function normalizeProposals(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const rows = ext === '.json' ? (readJson(filePath, []) || []) : readJsonl(filePath);
  return Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
}

function shouldFilterProposal(row: AnyObj, policy: AnyObj) {
  const eye = cleanText(row.eye_id || row.source_eye || '', 80).toLowerCase();
  const title = cleanText(row.title || '', 500).toLowerCase();
  if (policy.static_gate.unknown_eye_blocklist.includes(eye)) {
    return { filtered: true, reason: 'unknown_or_stub_eye' };
  }
  if ((policy.static_gate.title_stub_tokens || []).some((tok: string) => tok && title.includes(tok))) {
    return { filtered: true, reason: 'stub_title' };
  }
  return { filtered: false, reason: null };
}

function cmdRun(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const apply = toBool(args.apply, false);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, apply, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const inputRows = normalizeProposals(policy.inputs.proposals_path);
  const seen = new Set();
  const accepted: AnyObj[] = [];
  const filtered: AnyObj[] = [];

  for (const src of inputRows) {
    const proposalId = cleanText(src.proposal_id || src.id, 120) || null;
    if (!proposalId) {
      filtered.push({ ...src, status: 'filtered', filter_reason: 'missing_proposal_id' });
      continue;
    }
    if (seen.has(proposalId)) {
      filtered.push({ ...src, proposal_id: proposalId, status: 'filtered', filter_reason: 'duplicate_proposal_id' });
      continue;
    }
    seen.add(proposalId);

    const gate = shouldFilterProposal(src, policy);
    if (gate.filtered) {
      filtered.push({ ...src, proposal_id: proposalId, status: 'filtered', filter_reason: gate.reason });
      continue;
    }
    const normalizedStatus = cleanText(src.status || 'admitted', 40).toLowerCase() === 'unknown' ? 'filtered' : (cleanText(src.status || 'admitted', 40).toLowerCase() || 'admitted');
    accepted.push({ ...src, proposal_id: proposalId, status: normalizedStatus });
  }

  const out = {
    ok: true,
    ts: nowIso(),
    type: 'proposal_admission_hygiene',
    strict,
    apply,
    counts: {
      input: inputRows.length,
      accepted: accepted.length,
      filtered: filtered.length,
      deduped: inputRows.length - seen.size
    },
    accepted_preview: accepted.slice(0, 10),
    filtered_preview: filtered.slice(0, 10),
    policy_path: rel(policy.policy_path)
  };

  if (apply) {
    writeJsonAtomic(policy.outputs.accepted_path, { ts: out.ts, proposals: accepted });
    writeJsonAtomic(policy.outputs.filtered_path, { ts: out.ts, proposals: filtered });
  }

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    apply,
    counts: out.counts,
    ok: true
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'proposal_admission_hygiene_status',
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null),
    accepted_path: rel(policy.outputs.accepted_path),
    filtered_path: rel(policy.outputs.filtered_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/proposal_admission_hygiene.js run [--apply=1|0] [--strict=1|0]');
  console.log('  node systems/autonomy/proposal_admission_hygiene.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  try {
    const payload = cmd === 'run' ? cmdRun(args)
      : cmd === 'status' ? cmdStatus(args)
      : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'proposal_admission_hygiene_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { loadPolicy, shouldFilterProposal, cmdRun, cmdStatus };
