#!/usr/bin/env node
'use strict';
export {};

/**
 * broken_piece_lab.js
 *
 * V2-051 pipeline:
 * - Consumes doctor rollback queue entries.
 * - Clusters recurring signatures/root causes.
 * - Exports deterministic safe reimplementation proposals (JSON + Markdown).
 *
 * Usage:
 *   node systems/ops/broken_piece_lab.js run [--queue=path] [--clusters=path] [--proposals-dir=path]
 *   node systems/ops/broken_piece_lab.js status [--clusters=path]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function clean(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function stableHash(seed: string) {
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const s = clean(raw, 260);
  if (!s) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
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

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPaths(args: AnyObj) {
  return {
    queue: resolvePath(args.queue, 'state/ops/autotest_doctor/broken_lab_queue.jsonl'),
    clusters: resolvePath(args.clusters, 'state/ops/autotest_doctor/broken_lab_clusters.json'),
    proposalsDir: resolvePath(args['proposals-dir'], 'research/autotest_doctor/proposals')
  };
}

function clusterKey(row: AnyObj) {
  const kind = normalizeToken(row && row.kind || '', 48) || 'unknown';
  const sig = normalizeToken(row && row.signature_id || '', 120) || 'unknown_signature';
  const test = normalizeToken(row && row.test_id || row && row.test_path || '', 120) || 'unknown_test';
  return `${kind}|${sig}|${test}`;
}

function buildClusters(rows: AnyObj[]) {
  const clusters: Record<string, AnyObj> = {};
  for (const row of rows) {
    const key = clusterKey(row);
    if (!clusters[key]) {
      clusters[key] = {
        id: `lab_${stableHash(key)}`,
        key,
        kind: normalizeToken(row && row.kind || '', 48) || 'unknown',
        signature_id: clean(row && row.signature_id || '', 120) || null,
        test_id: clean(row && row.test_id || '', 120) || null,
        test_path: clean(row && row.test_path || '', 260) || null,
        occurrences: 0,
        first_seen_ts: null,
        last_seen_ts: null,
        rollback_reasons: {},
        sample_paths: []
      };
    }
    const c = clusters[key];
    c.occurrences += 1;
    const ts = clean(row && row.ts || '', 64) || null;
    if (!c.first_seen_ts || (ts && ts < c.first_seen_ts)) c.first_seen_ts = ts;
    if (!c.last_seen_ts || (ts && ts > c.last_seen_ts)) c.last_seen_ts = ts;
    const reason = clean(row && row.rollback_reason || 'unknown', 160) || 'unknown';
    c.rollback_reasons[reason] = Number(c.rollback_reasons[reason] || 0) + 1;
    const bp = clean(row && row.broken_piece_path || '', 260);
    if (bp && c.sample_paths.length < 5 && !c.sample_paths.includes(bp)) c.sample_paths.push(bp);
  }
  return Object.values(clusters)
    .sort((a: AnyObj, b: AnyObj) => {
      if (Number(b.occurrences || 0) !== Number(a.occurrences || 0)) return Number(b.occurrences || 0) - Number(a.occurrences || 0);
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
}

function proposalDateFromRows(rows: AnyObj[]) {
  let best = '';
  for (const row of rows) {
    const ts = clean(row && row.ts || '', 64);
    if (!ts) continue;
    const day = ts.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!best || day > best) best = day;
  }
  return best || nowIso().slice(0, 10);
}

function exportProposals(clusters: AnyObj[], proposalsDir: string, proposalDate: string) {
  ensureDir(proposalsDir);
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(proposalDate || ''))
    ? String(proposalDate)
    : nowIso().slice(0, 10);
  const jsonPath = path.join(proposalsDir, `${dateStr}.json`);
  const mdPath = path.join(proposalsDir, `${dateStr}.md`);
  const proposals = clusters.map((row, idx) => {
    const topReason = Object.entries(row.rollback_reasons || {})
      .sort((a: any, b: any) => Number(b[1] || 0) - Number(a[1] || 0))
      .map((entry: any) => String(entry[0] || 'unknown'))[0] || 'unknown';
    return {
      proposal_id: `reimpl_${stableHash(`${row.id}|${idx}`)}`,
      cluster_id: row.id,
      priority: idx + 1,
      confidence: Number(Math.min(0.95, 0.45 + (Number(row.occurrences || 0) * 0.05)).toFixed(3)),
      summary: `Re-implement guarded fix for ${row.kind} (${row.occurrences} occurrences)`,
      target_signature: row.signature_id,
      target_test: row.test_id || row.test_path || null,
      dominant_failure_reason: topReason,
      required_gates: [
        'sandbox_replay_pass',
        'doctor_recipe_release_valid',
        'human_review_required'
      ],
      sample_paths: row.sample_paths
    };
  });
  writeJsonAtomic(jsonPath, {
    ts: nowIso(),
    type: 'broken_piece_lab_proposals',
    proposals
  });
  const mdLines = [
    '# Broken Piece Reimplementation Proposals',
    '',
    `Generated: ${nowIso()}`,
    ''
  ];
  for (const row of proposals) {
    mdLines.push(`## ${row.proposal_id}`);
    mdLines.push(`- Priority: ${row.priority}`);
    mdLines.push(`- Summary: ${row.summary}`);
    mdLines.push(`- Target signature: ${row.target_signature || 'n/a'}`);
    mdLines.push(`- Target test: ${row.target_test || 'n/a'}`);
    mdLines.push(`- Dominant failure reason: ${row.dominant_failure_reason}`);
    mdLines.push(`- Confidence: ${row.confidence}`);
    mdLines.push(`- Gates: ${row.required_gates.join(', ')}`);
    mdLines.push('');
  }
  fs.writeFileSync(mdPath, `${mdLines.join('\n')}\n`, 'utf8');
  return {
    proposals_json_path: relPath(jsonPath),
    proposals_md_path: relPath(mdPath),
    proposal_count: proposals.length
  };
}

function runLab(args: AnyObj) {
  const paths = defaultPaths(args);
  const rows = readJsonl(paths.queue);
  const clusters = buildClusters(rows);
  const proposalDate = proposalDateFromRows(rows);
  const clusterPayload = {
    ts: nowIso(),
    type: 'broken_piece_lab_clusters',
    source_queue_path: relPath(paths.queue),
    cluster_count: clusters.length,
    total_items: rows.length,
    clusters
  };
  writeJsonAtomic(paths.clusters, clusterPayload);
  const proposals = exportProposals(clusters, paths.proposalsDir, proposalDate);
  return {
    ok: true,
    type: 'broken_piece_lab_run',
    ts: clusterPayload.ts,
    source_queue_path: relPath(paths.queue),
    clusters_path: relPath(paths.clusters),
    cluster_count: clusters.length,
    total_items: rows.length,
    ...proposals
  };
}

function status(args: AnyObj) {
  const paths = defaultPaths(args);
  const payload = readJson(paths.clusters, null);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      type: 'broken_piece_lab_status',
      error: 'clusters_missing',
      clusters_path: relPath(paths.clusters)
    };
  }
  return {
    ok: true,
    type: 'broken_piece_lab_status',
    ts: clean(payload.ts || '', 64) || null,
    cluster_count: Number(payload.cluster_count || 0),
    total_items: Number(payload.total_items || 0),
    clusters_path: relPath(paths.clusters)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/broken_piece_lab.js run [--queue=path] [--clusters=path] [--proposals-dir=path]');
  console.log('  node systems/ops/broken_piece_lab.js status [--clusters=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    process.stdout.write(`${JSON.stringify(runLab(args))}\n`);
    return;
  }
  if (cmd === 'status') {
    const payload = status(args);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (payload.ok !== true) process.exitCode = 1;
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'broken_piece_lab',
      error: clean(err && err.message ? err.message : err || 'broken_piece_lab_failed', 220)
    })}\n`);
    process.exit(1);
  }
}
