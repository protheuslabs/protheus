#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * queue_log_compact.js
 *
 * Deterministic compaction for state/sensory/queue_log.jsonl.
 * Removes repeated terminal-status churn events while preserving status history.
 *
 * Usage:
 *   node systems/ops/queue_log_compact.js run [--apply=1] [--force=1]
 *     [--min-lines=N] [--queue-log=/abs/or/rel/path]
 *   node systems/ops/queue_log_compact.js --help
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_QUEUE_LOG = path.join(ROOT, 'state', 'sensory', 'queue_log.jsonl');
const DEFAULT_AUDIT_LOG = path.join(ROOT, 'state', 'ops', 'queue_log_compaction.jsonl');
const TERMINAL_TYPES = new Set([
  'proposal_rejected',
  'proposal_done',
  'proposal_filtered',
  'proposal_accepted',
  'proposal_snoozed'
]);

/**
 * @param {string[]} argv
 * @returns {Record<string, any> & { _: string[] }}
 */
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

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/queue_log_compact.js run [--apply=1] [--force=1] [--min-lines=N] [--queue-log=/path]');
}

/**
 * @param {any} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {string} p
 */
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * @param {string} fp
 * @param {any} row
 */
function appendJsonl(fp, row) {
  ensureDir(path.dirname(fp));
  fs.appendFileSync(fp, JSON.stringify(row) + '\n', 'utf8');
}

/**
 * @param {string} s
 * @returns {number}
 */
function asInt(s) {
  const n = Number(s);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

/**
 * @param {any} row
 * @returns {string}
 */
function terminalDupKey(row) {
  const type = String(row && row.type || '').trim().toLowerCase();
  const id = String(row && row.proposal_id || '').trim();
  const hash = String(row && row.proposal_hash || '').trim();
  const status = String(row && row.status_after || '').trim().toLowerCase();
  const reason = String(row && row.reason || '').trim().toLowerCase();
  const until = String(row && row.snooze_until || '').trim();
  const note = String(row && row.note || '').trim().toLowerCase();
  return [type, id, hash, status, reason, until, note].join('|');
}

/**
 * @param {any} row
 * @returns {string}
 */
function rowType(row) {
  return String(row && row.type || '').trim().toLowerCase();
}

/**
 * @param {string} queueLogPath
 * @returns {{
 *   ok: boolean,
 *   total_lines: number,
 *   kept_lines: number,
 *   removed_lines: number,
 *   removed_exact: number,
 *   removed_terminal_dupe: number,
 *   removed_by_type: Record<string, number>,
 *   compacted_lines: string[],
 *   reason?: string
 * }}
 */
function compactRows(queueLogPath) {
  if (!fs.existsSync(queueLogPath)) {
    return {
      ok: true,
      total_lines: 0,
      kept_lines: 0,
      removed_lines: 0,
      removed_exact: 0,
      removed_terminal_dupe: 0,
      removed_by_type: {},
      compacted_lines: [],
      reason: 'missing_queue_log'
    };
  }

  const raw = fs.readFileSync(queueLogPath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  /** @type {string[]} */
  const kept = [];
  const seenExact = new Set();
  const seenTerminal = new Set();
  /** @type {Record<string, number>} */
  const removedByType = {};
  let removedExact = 0;
  let removedTerminal = 0;

  for (const line of lines) {
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      // Preserve malformed lines exactly; compactor should never destroy unknown data.
      kept.push(line);
      continue;
    }

    const exactKey = stableStringify(row);
    if (seenExact.has(exactKey)) {
      removedExact += 1;
      const t = rowType(row) || 'unknown';
      removedByType[t] = Number(removedByType[t] || 0) + 1;
      continue;
    }
    seenExact.add(exactKey);

    const t = rowType(row);
    if (TERMINAL_TYPES.has(t)) {
      const key = terminalDupKey(row);
      if (key && seenTerminal.has(key)) {
        removedTerminal += 1;
        removedByType[t || 'unknown'] = Number(removedByType[t || 'unknown'] || 0) + 1;
        continue;
      }
      if (key) seenTerminal.add(key);
    }

    kept.push(line);
  }

  const removed = Math.max(0, lines.length - kept.length);
  return {
    ok: true,
    total_lines: lines.length,
    kept_lines: kept.length,
    removed_lines: removed,
    removed_exact: removedExact,
    removed_terminal_dupe: removedTerminal,
    removed_by_type: removedByType,
    compacted_lines: kept
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'unsupported_command', command: cmd }) + '\n');
    process.exit(2);
  }

  const apply = String(args.apply || '0') === '1';
  const force = String(args.force || '0') === '1';
  const minLines = Math.max(1, asInt(String(args['min-lines'] || process.env.QUEUE_LOG_COMPACT_MIN_LINES || '250')) || 250);
  const queueLogArg = String(args['queue-log'] || process.env.QUEUE_LOG_COMPACT_PATH || '').trim();
  const queueLogPath = queueLogArg
    ? (path.isAbsolute(queueLogArg) ? queueLogArg : path.resolve(ROOT, queueLogArg))
    : DEFAULT_QUEUE_LOG;
  const auditPath = String(process.env.QUEUE_LOG_COMPACT_AUDIT_PATH || '').trim()
    ? path.resolve(String(process.env.QUEUE_LOG_COMPACT_AUDIT_PATH || '').trim())
    : DEFAULT_AUDIT_LOG;

  const result = compactRows(queueLogPath);
  if (!result.ok) {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(1);
  }

  const shouldSkipForSize = !force && Number(result.total_lines || 0) < minLines;
  const shouldSkipNoChanges = Number(result.removed_lines || 0) <= 0;
  const skipped = shouldSkipForSize || shouldSkipNoChanges;
  const action = skipped ? 'skipped' : (apply ? 'applied' : 'dry_run');

  /** @type {any} */
  const out = {
    ok: true,
    action,
    apply,
    force,
    queue_log: queueLogPath,
    min_lines: minLines,
    total_lines: result.total_lines,
    kept_lines: result.kept_lines,
    removed_lines: result.removed_lines,
    removed_exact: result.removed_exact,
    removed_terminal_dupe: result.removed_terminal_dupe,
    removed_by_type: result.removed_by_type
  };

  if (shouldSkipForSize) out.skip_reason = 'below_min_lines';
  if (!shouldSkipForSize && shouldSkipNoChanges) out.skip_reason = 'no_duplicates_found';

  if (!skipped && apply) {
    const stamp = nowIso().replace(/[:.]/g, '-');
    const backupPath = path.join(path.dirname(queueLogPath), `queue_log.backup.${stamp}.jsonl`);
    const tmpPath = `${queueLogPath}.tmp-${process.pid}-${Date.now()}`;
    fs.copyFileSync(queueLogPath, backupPath);
    fs.writeFileSync(tmpPath, result.compacted_lines.join('\n') + '\n', 'utf8');
    fs.renameSync(tmpPath, queueLogPath);
    out.backup_path = backupPath;
  }

  appendJsonl(auditPath, {
    ts: nowIso(),
    type: 'queue_log_compaction',
    action,
    queue_log: queueLogPath,
    min_lines: minLines,
    total_lines: Number(out.total_lines || 0),
    kept_lines: Number(out.kept_lines || 0),
    removed_lines: Number(out.removed_lines || 0),
    removed_exact: Number(out.removed_exact || 0),
    removed_terminal_dupe: Number(out.removed_terminal_dupe || 0),
    removed_by_type: out.removed_by_type || {}
  });

  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'queue_log_compact_failed')
    }) + '\n');
    process.exit(1);
  }
}

