#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.SYMBIOTIC_FUSION_POLICY_PATH
  ? path.resolve(process.env.SYMBIOTIC_FUSION_POLICY_PATH)
  : path.join(ROOT, 'config', 'symbiotic_fusion_chamber_policy.json');
const STATE_PATH = process.env.SYMBIOTIC_FUSION_STATE_PATH
  ? path.resolve(process.env.SYMBIOTIC_FUSION_STATE_PATH)
  : path.join(ROOT, 'state', 'fractal', 'symbiotic_fusion_chamber', 'state.json');
const RECEIPTS_PATH = process.env.SYMBIOTIC_FUSION_RECEIPTS_PATH
  ? path.resolve(process.env.SYMBIOTIC_FUSION_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'fractal', 'symbiotic_fusion_chamber', 'receipts.jsonl');

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

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
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

function hash10(seed: string) {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    max_active_fusions: 12,
    default_ttl_hours: 12,
    max_ttl_hours: 168,
    min_members: 2,
    max_members: 8,
    require_policy_approval: true
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    max_active_fusions: clampInt(raw.max_active_fusions, 1, 128, base.max_active_fusions),
    default_ttl_hours: clampInt(raw.default_ttl_hours, 1, 24 * 30, base.default_ttl_hours),
    max_ttl_hours: clampInt(raw.max_ttl_hours, 1, 24 * 365, base.max_ttl_hours),
    min_members: clampInt(raw.min_members, 2, 32, base.min_members),
    max_members: clampInt(raw.max_members, 2, 64, base.max_members),
    require_policy_approval: raw.require_policy_approval !== false
  };
}

function defaultState() {
  return {
    schema_id: 'symbiotic_fusion_chamber_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    fusions: {}
  };
}

function loadState() {
  const src = readJson(STATE_PATH, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'symbiotic_fusion_chamber_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    fusions: src.fusions && typeof src.fusions === 'object' ? src.fusions : {}
  };
}

function saveState(state: AnyObj) {
  writeJsonAtomic(STATE_PATH, {
    schema_id: 'symbiotic_fusion_chamber_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    fusions: state && state.fusions && typeof state.fusions === 'object' ? state.fusions : {}
  });
}

function parseMembers(raw: unknown, minMembers: number, maxMembers: number) {
  let src: unknown[] = [];
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    if (Array.isArray(parsed)) src = parsed;
  } catch {}
  const out = Array.from(new Set(src
    .map((v) => normalizeToken(v, 120))
    .filter(Boolean)))
    .slice(0, maxMembers);
  if (out.length < minMembers) return null;
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/fractal/symbiotic_fusion_chamber.js form --members-json=\"[\\\"organ_a\\\",\\\"organ_b\\\"]\" [--fusion-id=<id>] [--ttl-hours=12] [--policy-approval=1] [--apply=1]');
  console.log('  node systems/fractal/symbiotic_fusion_chamber.js dissolve --fusion-id=<id> [--reason=...]');
  console.log('  node systems/fractal/symbiotic_fusion_chamber.js status [--fusion-id=<id>]');
}

function cmdForm(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState();
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'symbiotic_fusion_form', error: 'fusion_chamber_disabled' })}\n`);
    process.exit(1);
  }
  const activeCount = Object.values(state.fusions || {}).filter((row: any) => row && row.status === 'active').length;
  if (activeCount >= policy.max_active_fusions) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'symbiotic_fusion_form', error: 'max_active_fusions_reached' })}\n`);
    process.exit(1);
  }

  const members = parseMembers(args.members_json || args['members-json'], policy.min_members, policy.max_members);
  if (!members) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'symbiotic_fusion_form', error: 'invalid_members' })}\n`);
    process.exit(1);
  }
  const ts = nowIso();
  const ttlHours = clampInt(args.ttl_hours || args['ttl-hours'], 1, policy.max_ttl_hours, policy.default_ttl_hours);
  const fusionId = normalizeToken(args.fusion_id || args['fusion-id'] || `fusion_${hash10(`${members.join('|')}|${ts}`)}`, 120);
  const apply = toBool(args.apply, false);
  const policyApproval = toBool(args.policy_approval != null ? args.policy_approval : args['policy-approval'], false);
  const blocked: string[] = [];
  if (policy.shadow_only === true && apply === true) blocked.push('shadow_only_mode');
  if (policy.require_policy_approval === true && !policyApproval) blocked.push('policy_approval_required');

  const record = {
    fusion_id: fusionId,
    status: blocked.length ? 'blocked' : 'active',
    ts,
    members,
    ttl_hours: ttlHours,
    expires_at: new Date(Date.parse(ts) + ttlHours * 60 * 60 * 1000).toISOString(),
    apply,
    policy_approval: policyApproval,
    rollback_receipt_id: `rb_${hash10(`${fusionId}|rollback|${ts}`)}`
  };
  state.fusions[fusionId] = record;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, { ts, type: 'symbiotic_fusion_form', ok: blocked.length === 0, blocked, fusion_id: fusionId, members, ttl_hours: ttlHours });
  process.stdout.write(`${JSON.stringify({ ok: blocked.length === 0, type: 'symbiotic_fusion_form', blocked, record })}\n`);
  if (blocked.length) process.exit(1);
}

function cmdDissolve(args: AnyObj) {
  const state = loadState();
  const fusionId = normalizeToken(args.fusion_id || args['fusion-id'] || '', 120);
  const row = fusionId ? state.fusions[fusionId] : null;
  if (!row) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'symbiotic_fusion_dissolve', error: 'fusion_not_found' })}\n`);
    process.exit(1);
  }
  const reason = cleanText(args.reason || 'manual_dissolve', 220) || 'manual_dissolve';
  row.status = 'dissolved';
  row.dissolved_at = nowIso();
  row.dissolve_reason = reason;
  state.fusions[fusionId] = row;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, { ts: nowIso(), type: 'symbiotic_fusion_dissolve', ok: true, fusion_id: fusionId, reason });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'symbiotic_fusion_dissolve', record: row })}\n`);
}

function cmdStatus(args: AnyObj) {
  const state = loadState();
  const fusionId = normalizeToken(args.fusion_id || args['fusion-id'] || '', 120);
  if (fusionId) {
    process.stdout.write(`${JSON.stringify({ ok: true, type: 'symbiotic_fusion_status', fusion_id: fusionId, record: state.fusions[fusionId] || null })}\n`);
    return;
  }
  const rows = Object.values(state.fusions || {});
  const counts = {
    total: rows.length,
    active: rows.filter((row: any) => row && row.status === 'active').length,
    blocked: rows.filter((row: any) => row && row.status === 'blocked').length,
    dissolved: rows.filter((row: any) => row && row.status === 'dissolved').length
  };
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'symbiotic_fusion_status', counts })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'form') return cmdForm(args);
  if (cmd === 'dissolve') return cmdDissolve(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

