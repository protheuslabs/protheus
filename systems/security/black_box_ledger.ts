#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/security/black_box_ledger.js
 *
 * V2-031 black-box hash ledger.
 * Builds append-only hash-chain receipts for critical daily decision flow.
 *
 * Usage:
 *   node systems/security/black_box_ledger.js rollup [YYYY-MM-DD] [--mode=daily]
 *   node systems/security/black_box_ledger.js verify
 *   node systems/security/black_box_ledger.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const LEDGER_DIR = process.env.BLACK_BOX_LEDGER_DIR
  ? path.resolve(process.env.BLACK_BOX_LEDGER_DIR)
  : path.join(ROOT, 'state', 'security', 'black_box_ledger');
const CHAIN_PATH = path.join(LEDGER_DIR, 'chain.jsonl');
const SPINE_RUNS_DIR = process.env.BLACK_BOX_SPINE_RUNS_DIR
  ? path.resolve(process.env.BLACK_BOX_SPINE_RUNS_DIR)
  : path.join(ROOT, 'state', 'spine', 'runs');
const AUTONOMY_RUNS_DIR = process.env.BLACK_BOX_AUTONOMY_RUNS_DIR
  ? path.resolve(process.env.BLACK_BOX_AUTONOMY_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const EXTERNAL_ATTESTATION_DIR = process.env.BLACK_BOX_EXTERNAL_ATTESTATION_DIR
  ? path.resolve(process.env.BLACK_BOX_EXTERNAL_ATTESTATION_DIR)
  : path.join(LEDGER_DIR, 'attestations');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/black_box_ledger.js rollup [YYYY-MM-DD] [--mode=daily]');
  console.log('  node systems/security/black_box_ledger.js verify');
  console.log('  node systems/security/black_box_ledger.js status');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const out = [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') out.push(row);
      } catch {
        // ignore malformed rows
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashOf(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function allowedSpineType(type) {
  const t = String(type || '').trim();
  if (!t) return false;
  return t === 'spine_run_started'
    || t === 'spine_run_completed'
    || t.includes('spine_trit_shadow')
    || t.includes('spine_alignment_oracle')
    || t.includes('spine_suggestion_lane')
    || t.includes('spine_self_documentation')
    || t.includes('spine_router_budget_calibration')
    || t.includes('spine_ops_dashboard')
    || t.includes('spine_integrity')
    || t.includes('spine_state_backup')
    || t.includes('spine_backup_integrity');
}

function allowedAutonomyType(type) {
  return String(type || '').trim() === 'autonomy_run'
    || String(type || '').trim() === 'autonomy_candidate_audit';
}

function compactEvent(row, source) {
  const evt = row && typeof row === 'object' ? row : {};
  const out = {
    ts: String(evt.ts || '').trim() || null,
    source,
    type: String(evt.type || '').trim() || null,
    proposal_id: String(evt.proposal_id || '').trim() || null,
    result: String(evt.result || '').trim() || null,
    outcome: String(evt.outcome || '').trim() || null,
    objective_id: String(
      evt.objective_id
      || (evt.directive_pulse && evt.directive_pulse.objective_id)
      || (evt.objective_binding && evt.objective_binding.objective_id)
      || ''
    ).trim() || null,
    risk: String(evt.risk || '').trim() || null,
    ok: typeof evt.ok === 'boolean' ? evt.ok : null,
    reason: String(evt.reason || '').trim() || null
  };
  return out;
}

function allowedAttestationType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (!t) return false;
  return t === 'external_boundary_attestation'
    || t === 'boundary_attestation'
    || t === 'cross_runtime_attestation'
    || t === 'cross_service_attestation';
}

function compactAttestationEvent(row) {
  const evt = row && typeof row === 'object' ? row : {};
  const sourceSystem = String(evt.system || evt.source_system || evt.attestor || '').trim() || null;
  const boundary = String(evt.boundary || evt.scope || '').trim() || null;
  const chainHash = String(evt.chain_hash || evt.receipt_hash || evt.hash || '').trim() || null;
  const signature = String(evt.signature || evt.sig || '').trim() || null;
  const out = {
    ts: String(evt.ts || evt.timestamp || '').trim() || null,
    source: 'boundary_attestation',
    type: 'external_boundary_attestation',
    proposal_id: null,
    result: null,
    outcome: null,
    objective_id: String(evt.objective_id || '').trim() || null,
    risk: null,
    ok: typeof evt.ok === 'boolean' ? evt.ok : null,
    reason: boundary || null,
    external_attestation: {
      system: sourceSystem,
      boundary,
      chain_hash: chainHash,
      signature,
      signer: String(evt.signer || evt.attestor || '').trim() || null
    }
  };
  return out;
}

function loadExternalAttestations(dateStr) {
  const fp = path.join(EXTERNAL_ATTESTATION_DIR, `${dateStr}.jsonl`);
  const rows = readJsonl(fp)
    .filter((row) => allowedAttestationType(row && row.type))
    .map((row) => compactAttestationEvent(row))
    .filter((row) => row.external_attestation && row.external_attestation.chain_hash);
  return rows;
}

function loadCriticalEvents(dateStr) {
  const spineRows = readJsonl(path.join(SPINE_RUNS_DIR, `${dateStr}.jsonl`))
    .filter((row) => allowedSpineType(row && row.type))
    .map((row) => compactEvent(row, 'spine'));
  const autonomyRows = readJsonl(path.join(AUTONOMY_RUNS_DIR, `${dateStr}.jsonl`))
    .filter((row) => allowedAutonomyType(row && row.type))
    .map((row) => compactEvent(row, 'autonomy'));
  const externalRows = loadExternalAttestations(dateStr);
  const all = [...spineRows, ...autonomyRows, ...externalRows].sort((a, b) => {
    const ta = Date.parse(String(a.ts || ''));
    const tb = Date.parse(String(b.ts || ''));
    const va = Number.isFinite(ta) ? ta : 0;
    const vb = Number.isFinite(tb) ? tb : 0;
    return va - vb;
  });
  return {
    all,
    spineCount: spineRows.length,
    autonomyCount: autonomyRows.length,
    externalCount: externalRows.length
  };
}

function detailPath(dateStr, rollupSeq = 1) {
  const seq = Number(rollupSeq || 1);
  if (seq <= 1) return path.join(LEDGER_DIR, `${dateStr}.jsonl`);
  return path.join(LEDGER_DIR, `${dateStr}.${seq}.jsonl`);
}

function writeDetailLedger(dateStr, events, rollupSeq) {
  const rows = [];
  let prevHash = 'GENESIS';
  for (let i = 0; i < events.length; i += 1) {
    const payload = {
      schema_id: 'black_box_event',
      schema_version: '1.0.0',
      date: dateStr,
      index: i,
      event: events[i],
      prev_hash: prevHash
    };
    const hash = hashOf(payload);
    rows.push({ ...payload, hash });
    prevHash = hash;
  }
  writeJsonl(detailPath(dateStr, rollupSeq), rows);
  const digest = rows.length ? rows[rows.length - 1].hash : hashOf({ date: dateStr, empty: true });
  return { rows, digest };
}

function currentChainRows() {
  return readJsonl(CHAIN_PATH);
}

function chainTailHash() {
  const rows = currentChainRows();
  if (!rows.length) return 'GENESIS';
  return String(rows[rows.length - 1].hash || 'GENESIS');
}

function nextRollupSeq(dateStr, mode) {
  const rows = currentChainRows();
  let maxSeq = 0;
  for (const row of rows) {
    if (String(row.date || '') !== String(dateStr || '')) continue;
    if (String(row.mode || '') !== String(mode || '')) continue;
    maxSeq = Math.max(maxSeq, Number(row.rollup_seq || 1));
  }
  return maxSeq + 1;
}

function upsertChainRow(row) {
  const rows = currentChainRows();
  const existing = rows.find((r) =>
    String(r.date || '') === String(row.date || '')
    && String(r.mode || '') === String(row.mode || '')
    && String(r.digest || '') === String(row.digest || '')
  );
  if (existing) {
    return {
      appended: false,
      hash: String(existing.hash || ''),
      rollup_seq: Number(existing.rollup_seq || 1)
    };
  }
  appendJsonl(CHAIN_PATH, row);
  return {
    appended: true,
    hash: String(row.hash || ''),
    rollup_seq: Number(row.rollup_seq || 1)
  };
}

function makeChainRow(dateStr, mode, digest, stats, rollupSeq) {
  const prevHash = chainTailHash();
  const payload = {
    schema_id: 'black_box_chain',
    schema_version: '1.0.0',
    ts: nowIso(),
    date: dateStr,
    mode: String(mode || 'daily'),
    rollup_seq: Number(rollupSeq || 1),
    detail_file: path.basename(detailPath(dateStr, rollupSeq)),
    digest,
    prev_hash: prevHash,
    spine_events: Number(stats.spineCount || 0),
    autonomy_events: Number(stats.autonomyCount || 0),
    external_events: Number(stats.externalCount || 0),
    total_events: Number(stats.total || 0)
  };
  const hash = hashOf(payload);
  return { ...payload, hash };
}

function cmdRollup(dateStr, mode) {
  const stats = loadCriticalEvents(dateStr);
  const rollupSeq = nextRollupSeq(dateStr, mode);
  const detail = writeDetailLedger(dateStr, stats.all, rollupSeq);
  const chainRow = makeChainRow(dateStr, mode, detail.digest, {
    spineCount: stats.spineCount,
    autonomyCount: stats.autonomyCount,
    externalCount: stats.externalCount,
    total: stats.all.length
  }, rollupSeq);
  const upsert = upsertChainRow(chainRow);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'black_box_ledger_rollup',
    date: dateStr,
    mode,
    rollup_seq: upsert.rollup_seq,
    appended: upsert.appended,
    spine_events: stats.spineCount,
    autonomy_events: stats.autonomyCount,
    external_events: stats.externalCount,
    total_events: stats.all.length,
    digest: detail.digest,
    chain_hash: upsert.hash || chainRow.hash,
    detail_path: path.relative(ROOT, detailPath(dateStr, rollupSeq)).replace(/\\/g, '/'),
    chain_path: path.relative(ROOT, CHAIN_PATH).replace(/\\/g, '/')
  })}\n`);
}

function verifyDetailFile(dateStr, detailFile) {
  const fallback = detailPath(dateStr, 1);
  const fp = detailFile
    ? path.join(LEDGER_DIR, String(detailFile || '').trim())
    : fallback;
  const rows = readJsonl(fp);
  let prevHash = 'GENESIS';
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const payload = {
      schema_id: row.schema_id,
      schema_version: row.schema_version,
      date: row.date,
      index: row.index,
      event: row.event,
      prev_hash: row.prev_hash
    };
    const expected = hashOf(payload);
    if (String(row.prev_hash || '') !== String(prevHash)) return { ok: false, error: 'detail_prev_hash_mismatch', index: i };
    if (String(row.hash || '') !== expected) return { ok: false, error: 'detail_hash_mismatch', index: i };
    prevHash = expected;
  }
  return {
    ok: true,
    digest: rows.length ? rows[rows.length - 1].hash : hashOf({ date: dateStr, empty: true }),
    rows: rows.length
  };
}

function cmdVerify() {
  const rows = currentChainRows();
  const latestSeqByKey = {};
  for (const row of rows) {
    const key = `${String(row.date || '')}|${String(row.mode || '')}`;
    const seq = Number(row.rollup_seq || 1);
    latestSeqByKey[key] = Math.max(Number(latestSeqByKey[key] || 0), seq);
  }
  let skippedSuperseded = 0;
  let prevHash = 'GENESIS';
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const payload = {
      schema_id: row.schema_id,
      schema_version: row.schema_version,
      ts: row.ts,
      date: row.date,
      mode: row.mode,
      digest: row.digest,
      prev_hash: row.prev_hash,
      spine_events: row.spine_events,
      autonomy_events: row.autonomy_events,
      total_events: row.total_events
    } as Record<string, any>;
    if (Object.prototype.hasOwnProperty.call(row, 'external_events')) {
      payload.external_events = row.external_events;
    }
    if (Object.prototype.hasOwnProperty.call(row, 'detail_file')) {
      payload.detail_file = row.detail_file;
    }
    if (Object.prototype.hasOwnProperty.call(row, 'rollup_seq')) {
      payload.rollup_seq = row.rollup_seq;
    }
    const expected = hashOf(payload);
    if (String(row.prev_hash || '') !== String(prevHash)) {
      process.stdout.write(`${JSON.stringify({ ok: false, type: 'black_box_ledger_verify', error: 'chain_prev_hash_mismatch', index: i })}\n`);
      process.exitCode = 1;
      return;
    }
    if (String(row.hash || '') !== expected) {
      process.stdout.write(`${JSON.stringify({ ok: false, type: 'black_box_ledger_verify', error: 'chain_hash_mismatch', index: i })}\n`);
      process.exitCode = 1;
      return;
    }
    const detail = verifyDetailFile(
      String(row.date || '').slice(0, 10),
      row.detail_file ? String(row.detail_file || '').trim() : null
    );
    if (!detail.ok) {
      process.stdout.write(`${JSON.stringify({ ok: false, type: 'black_box_ledger_verify', error: detail.error, date: row.date, index: detail.index })}\n`);
      process.exitCode = 1;
      return;
    }
    if (String(row.digest || '') !== String(detail.digest || '')) {
      const key = `${String(row.date || '')}|${String(row.mode || '')}`;
      const seq = Number(row.rollup_seq || 1);
      const latestSeq = Number(latestSeqByKey[key] || seq);
      if (seq < latestSeq) {
        skippedSuperseded += 1;
      } else {
        process.stdout.write(`${JSON.stringify({ ok: false, type: 'black_box_ledger_verify', error: 'digest_mismatch', date: row.date })}\n`);
        process.exitCode = 1;
        return;
      }
    }
    prevHash = expected;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'black_box_ledger_verify',
    rows: rows.length,
    valid: true,
    skipped_superseded: skippedSuperseded,
    chain_path: path.relative(ROOT, CHAIN_PATH).replace(/\\/g, '/')
  })}\n`);
}

function cmdStatus() {
  const rows = currentChainRows();
  if (!rows.length) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'black_box_ledger_status', error: 'chain_empty' })}\n`);
    return;
  }
  const last = rows[rows.length - 1];
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'black_box_ledger_status',
    rows: rows.length,
    last_date: last.date || null,
    last_mode: last.mode || null,
    last_rollup_seq: Number(last.rollup_seq || 1),
    last_external_events: Number(last.external_events || 0),
    last_hash: last.hash || null,
    chain_path: path.relative(ROOT, CHAIN_PATH).replace(/\\/g, '/')
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'rollup') {
    const dateStr = dateArgOrToday(args._[1]);
    const mode = String(args.mode || 'daily').trim() || 'daily';
    cmdRollup(dateStr, mode);
    return;
  }
  if (cmd === 'verify') {
    cmdVerify();
    return;
  }
  if (cmd === 'status') {
    cmdStatus();
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}
