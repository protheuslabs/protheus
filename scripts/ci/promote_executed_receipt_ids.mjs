#!/usr/bin/env node
/* eslint-disable no-console */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RECEIPT_PATH = process.argv[2] || 'client/local/state/ops/backlog_queue_executor/latest.json';
const TARGETS = ['docs/workspace/SRS.md', 'docs/workspace/UPGRADE_BACKLOG.md'];

function parseJsonCandidate(text) {
  const src = String(text || '').trim();
  if (!src) return null;
  try {
    return JSON.parse(src);
  } catch {
    // no-op
  }
  const lines = src
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep scanning
    }
  }
  return null;
}

function isLegacyRetiredExecution(row) {
  const laneRoute = String(row?.lane_route || row?.laneRoute || '').trim();
  const laneScript = String(row?.lane_script || row?.laneScript || '').trim();
  if (laneRoute === 'dynamic_legacy_adapter') return true;
  if (laneScript.startsWith('dynamic:legacy_alias_adapter:')) return true;
  const laneResult = row && typeof row === 'object' ? row.lane_result || row.laneResult : null;
  const payload = laneResult && typeof laneResult === 'object'
    ? parseJsonCandidate(laneResult.stdout || laneResult.output || '')
    : null;
  return !!(payload && payload.type === 'legacy_retired_lane');
}

function loadPromotableIds(path) {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const promoted = new Set();
  const rejected = [];
  for (const row of rows) {
    if (!row || row.status !== 'executed' || typeof row.id !== 'string') continue;
    if (isLegacyRetiredExecution(row)) {
      rejected.push({ id: row.id, reason: 'legacy_retired_lane_or_dynamic_alias' });
      continue;
    }
    promoted.add(row.id);
  }
  return { promoted, rejected };
}

function parseGitStatusPaths() {
  const out = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return String(out || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const body = line.slice(3).trim();
      if (!body) return '';
      if (body.includes(' -> ')) return body.split(' -> ').pop().trim();
      return body;
    })
    .filter(Boolean);
}

function isCodeOrTestPath(p) {
  if (p === 'package.json') return true;
  if (p.startsWith('core/')) return true;
  if (p.startsWith('client/')) return true;
  if (p.startsWith('apps/')) return true;
  if (p.startsWith('adapters/')) return true;
  if (p.startsWith('scripts/')) return true;
  if (p.startsWith('tests/')) return true;
  if (p.startsWith('.github/')) return true;
  return false;
}

function promoteTableRows(markdown, ids) {
  const lines = markdown.split('\n');
  let changed = 0;
  const out = lines.map((line) => {
    if (!line.startsWith('|')) return line;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) return line;
    const id = cells[0];
    const status = (cells[1] || '').toLowerCase();
    if (!ids.has(id)) return line;
    if (!['queued', 'in_progress'].includes(status)) return line;
    cells[1] = 'done';
    changed += 1;
    return `| ${cells.join(' | ')} |`;
  });
  return { markdown: out.join('\n'), changed };
}

function main() {
  const { promoted, rejected } = loadPromotableIds(RECEIPT_PATH);
  if (promoted.size === 0) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          type: 'promote_executed_receipt_ids',
          reason: rejected.length > 0 ? 'all_executed_ids_blocked_by_integrity_gate' : 'no_executed_ids_in_receipt',
          receipt: RECEIPT_PATH,
          rejected,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const codeLikePaths = parseGitStatusPaths().filter(isCodeOrTestPath);
  if (codeLikePaths.length === 0) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          type: 'promote_executed_receipt_ids',
          reason: 'no_code_or_test_diff_detected',
          receipt: RECEIPT_PATH,
          promotable_ids: promoted.size,
          rejected,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const changes = [];
  for (const target of TARGETS) {
    const abs = resolve(target);
    const before = readFileSync(abs, 'utf8');
    const result = promoteTableRows(before, promoted);
    if (result.changed > 0) {
      writeFileSync(abs, result.markdown, 'utf8');
    }
    changes.push({ file: target, changed: result.changed });
  }

  console.log(
    JSON.stringify(
        {
          ok: true,
          type: 'promote_executed_receipt_ids',
          receipt: RECEIPT_PATH,
          executed_ids: promoted.size,
          rejected,
          code_like_paths: codeLikePaths,
          changes,
        },
        null,
      2,
    ),
  );
}

main();
