#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_LOG_PATH = process.env.AUTONOMY_HUMAN_ESCALATION_LOG_PATH
  ? path.resolve(process.env.AUTONOMY_HUMAN_ESCALATION_LOG_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'autonomy_human_escalations.jsonl');

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function isTerminalEscalationStatus(status) {
  const s = normalizeText(status).toLowerCase();
  if (!s) return false;
  return (
    s === 'resolved'
    || s === 'closed'
    || s === 'dismissed'
    || s === 'cancelled'
    || s === 'canceled'
    || s === 'expired'
    || s.startsWith('resolved:')
    || s.startsWith('auto_resolved')
    || s.startsWith('closed:')
  );
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === 'object');
  } catch {
    return [];
  }
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function parseIsoMs(v) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function computeExpiryMs(row, holdHours, fallbackNowMs) {
  const explicit = parseIsoMs(row && row.expires_at);
  if (Number.isFinite(explicit)) return explicit;
  const tsMs = parseIsoMs(row && row.ts);
  const baseMs = Number.isFinite(tsMs) ? tsMs : fallbackNowMs;
  return baseMs + (Math.max(1, Number(holdHours || 6)) * 60 * 60 * 1000);
}

function latestEventsByEscalation(rows) {
  const latest = new Map();
  for (const row of rows) {
    if (!row || String(row.type || '') !== 'autonomy_human_escalation') continue;
    const id = normalizeText(row.escalation_id);
    if (!id) continue;
    const prev = latest.get(id);
    if (!prev) {
      latest.set(id, row);
      continue;
    }
    const prevMs = parseIsoMs(prev.ts);
    const curMs = parseIsoMs(row.ts);
    if (!Number.isFinite(prevMs) || (Number.isFinite(curMs) && curMs >= prevMs)) {
      latest.set(id, row);
    }
  }
  return latest;
}

function activeEscalationsFromLatest(latestMap, holdHours, nowMs) {
  const out = [];
  for (const row of latestMap.values()) {
    if (isTerminalEscalationStatus(row && row.status)) continue;
    const expMs = computeExpiryMs(row, holdHours, nowMs);
    if (nowMs > expMs) continue;
    out.push({
      ...row,
      expires_at: new Date(expMs).toISOString(),
      remaining_minutes: Number(Math.max(0, (expMs - nowMs) / 60000).toFixed(2))
    });
  }
  out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return out;
}

function buildResolutionEvent(row, nowTs, reason, holdHours) {
  return {
    ts: nowTs,
    type: 'autonomy_human_escalation',
    escalation_id: row && row.escalation_id ? String(row.escalation_id) : null,
    status: 'resolved',
    resolved_at: nowTs,
    resolved_via: 'escalation_resolver',
    resolution_note: reason,
    signature: row && row.signature ? String(row.signature) : null,
    stage: row && row.stage ? String(row.stage) : null,
    error_code: row && row.error_code ? String(row.error_code) : null,
    proposal_id: row && row.proposal_id ? String(row.proposal_id) : null,
    receipt_id: row && row.receipt_id ? String(row.receipt_id) : null,
    gate: row && row.gate ? String(row.gate) : null,
    hold_hours: Math.max(1, Number(holdHours || 6)),
    expires_at: row && row.expires_at ? String(row.expires_at) : null,
    requires_human_review: false
  };
}

function nextClearAt(activeRows) {
  const rows = Array.isArray(activeRows) ? activeRows : [];
  const ms = rows
    .map((row) => parseIsoMs(row && row.expires_at))
    .filter((v) => Number.isFinite(v));
  if (!ms.length) return null;
  return new Date(Math.min(...ms)).toISOString();
}

function reconcileHumanEscalations(opts = {}) {
  const logPath = opts.logPath || DEFAULT_LOG_PATH;
  const holdHours = Math.max(1, Number(opts.holdHours || 6));
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const nowTs = new Date(nowMs).toISOString();
  const resolveExpired = opts.resolveExpired !== false;
  const resolveSuperseded = opts.resolveSuperseded !== false;
  const maxOpenPerSignature = Math.max(1, Number(opts.maxOpenPerSignature || 1));
  const staleMultiplier = Math.max(1, Number(opts.staleMultiplier || 2));

  const rows = readJsonl(logPath);
  const latestById = latestEventsByEscalation(rows);
  const open = activeEscalationsFromLatest(latestById, holdHours, nowMs);
  const toResolve = [];
  const touchedIds = new Set();

  if (resolveExpired) {
    for (const row of latestById.values()) {
      const id = normalizeText(row && row.escalation_id);
      if (!id) continue;
      if (isTerminalEscalationStatus(row && row.status)) continue;
      const expMs = computeExpiryMs(row, holdHours, nowMs);
      const staleMs = expMs + (Math.max(1, staleMultiplier) * holdHours * 60 * 60 * 1000);
      if (nowMs <= expMs && nowMs <= staleMs) continue;
      if (touchedIds.has(id)) continue;
      toResolve.push(buildResolutionEvent(row, nowTs, 'auto_resolved:expired_or_stale', holdHours));
      touchedIds.add(id);
    }
  }

  if (resolveSuperseded) {
    const openBySig = new Map();
    for (const row of open) {
      const sig = normalizeText(row && row.signature);
      if (!sig) continue;
      const arr = openBySig.get(sig) || [];
      arr.push(row);
      openBySig.set(sig, arr);
    }
    for (const arr of openBySig.values()) {
      arr.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
      const keep = arr.slice(0, maxOpenPerSignature).map((row) => normalizeText(row && row.escalation_id));
      for (const row of arr) {
        const id = normalizeText(row && row.escalation_id);
        if (!id || keep.includes(id) || touchedIds.has(id)) continue;
        toResolve.push(buildResolutionEvent(row, nowTs, 'auto_resolved:superseded_signature_duplicate', holdHours));
        touchedIds.add(id);
      }
    }
  }

  for (const evt of toResolve) appendJsonl(logPath, evt);

  const latestAfter = latestEventsByEscalation(readJsonl(logPath));
  const activeAfter = activeEscalationsFromLatest(latestAfter, holdHours, nowMs);

  return {
    ok: true,
    ts: nowTs,
    hold_hours: holdHours,
    resolved_count: toResolve.length,
    resolved: toResolve.map((row) => ({
      escalation_id: row.escalation_id || null,
      signature: row.signature || null,
      resolution_note: row.resolution_note || null
    })),
    active_count: activeAfter.length,
    next_clear_at: nextClearAt(activeAfter),
    active: activeAfter.slice(0, 10).map((row) => ({
      escalation_id: row.escalation_id || null,
      signature: row.signature || null,
      stage: row.stage || null,
      error_code: row.error_code || null,
      expires_at: row.expires_at || null,
      remaining_minutes: row.remaining_minutes
    }))
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function cmdRun(args) {
  const holdHours = Number(args['hold-hours'] || 6);
  const maxOpenPerSignature = Number(args['max-open-per-signature'] || 1);
  const staleMultiplier = Number(args['stale-multiplier'] || 2);
  const out = reconcileHumanEscalations({
    logPath: args.log ? path.resolve(String(args.log)) : DEFAULT_LOG_PATH,
    holdHours,
    maxOpenPerSignature,
    staleMultiplier,
    resolveExpired: args['resolve-expired'] !== '0',
    resolveSuperseded: args['resolve-superseded'] !== '0'
  });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdStatus(args) {
  const holdHours = Math.max(1, Number(args['hold-hours'] || 6));
  const rows = readJsonl(args.log ? path.resolve(String(args.log)) : DEFAULT_LOG_PATH);
  const latest = latestEventsByEscalation(rows);
  const active = activeEscalationsFromLatest(latest, holdHours, Date.now());
  process.stdout.write(`${JSON.stringify({
    ok: true,
    ts: nowIso(),
    hold_hours: holdHours,
    active_count: active.length,
    next_clear_at: nextClearAt(active),
    active: active.slice(0, 10).map((row) => ({
      escalation_id: row.escalation_id || null,
      signature: row.signature || null,
      stage: row.stage || null,
      error_code: row.error_code || null,
      expires_at: row.expires_at || null,
      remaining_minutes: row.remaining_minutes
    }))
  })}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/escalation_resolver.js run [--hold-hours=6] [--max-open-per-signature=1]');
  console.log('  node systems/autonomy/escalation_resolver.js status [--hold-hours=6]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}

module.exports = {
  reconcileHumanEscalations,
  activeEscalationsFromLatest,
  latestEventsByEscalation
};
