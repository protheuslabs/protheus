#!/usr/bin/env node
/* eslint-disable no-console */
// TODO(rkapoor): Add threshold validation for weekly churn % - Q2 2026
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT_JSON = 'core/local/artifacts/churn_guard_current.json';
const OUT_MD = 'local/workspace/reports/CHURN_GUARD_CURRENT.md';

function parseArgs(argv) {
  const allowGovernanceDocChurn =
    argv.includes('--allow-governance-doc-churn=1') ||
    argv.includes('--allow-governance-doc-churn') ||
    process.env.ALLOW_GOVERNANCE_DOC_CHURN === '1';
  const commitGate =
    argv.includes('--commit-gate=1') ||
    argv.includes('--commit-gate') ||
    process.env.CHURN_GUARD_COMMIT_GATE === '1';
  return {
    strict: argv.includes('--strict=1') || argv.includes('--strict'),
    allowGovernanceDocChurn,
    commitGate,
  };
}

function classifyPath(path) {
  if (
    path === 'docs/workspace/TODO.md' ||
    path === 'docs/workspace/SRS.md' ||
    path === 'docs/workspace/UPGRADE_BACKLOG.md' ||
    /^docs\/client\/requirements\/REQ-[^/]+\.md$/i.test(path)
  ) {
    return 'governance_doc_churn';
  }
  if (
    path.startsWith('local/') ||
    path.startsWith('simulated-commits/')
  ) {
    return 'local_simulation_churn';
  }
  if (
    path.startsWith('packages/lensmap/') ||
    path.startsWith('tests/fixtures/lensmap_') ||
    path === 'core/layer0/ops/src/bin/lensmap.rs'
  ) {
    return 'lensmap_churn';
  }
  if (
    /^core\/local\/artifacts\/.*_current\.json$/i.test(path) ||
    (/^docs\/workspace\/SRS_.*CURRENT\.md$/i.test(path) || /^local\/workspace\/reports\/SRS_.*CURRENT\.md$/i.test(path)) ||
    path === 'docs/workspace/BLOCKED_EXTERNAL_EVIDENCE_STATUS.md' ||
    path === 'local/workspace/reports/BLOCKED_EXTERNAL_EVIDENCE_STATUS.md' ||
    path === 'docs/workspace/BLOCKED_EXTERNAL_RECONCILE_CANDIDATES.md' ||
    path === 'local/workspace/reports/BLOCKED_EXTERNAL_RECONCILE_CANDIDATES.md' ||
    path === 'docs/workspace/BLOCKED_EXTERNAL_UNBLOCK_PLAN.md' ||
    path === 'local/workspace/reports/BLOCKED_EXTERNAL_UNBLOCK_PLAN.md' ||
    path === 'docs/workspace/BLOCKED_EXTERNAL_PACKET_AUDIT.md' ||
    path === 'local/workspace/reports/BLOCKED_EXTERNAL_PACKET_AUDIT.md' ||
    path === 'docs/workspace/BLOCKED_EXTERNAL_TOP10.md' ||
    path === 'local/workspace/reports/BLOCKED_EXTERNAL_TOP10.md'
  ) {
    return 'generated_report_churn';
  }
  return 'other';
}

function parseStatus() {
  const raw = execSync('git status --porcelain=v1 -uall', { encoding: 'utf8' });
  if (!raw.trim()) return [];
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const status = line.slice(0, 2);
      const path = line.slice(3).trim();
      return { status, path, category: classifyPath(path) };
    });
}

function isDeleted(status) {
  return status.includes('D');
}

function isUntracked(status) {
  return status === '??';
}

function detectLikelyUnstagedMoves(rows) {
  const deleted = rows.filter((row) => isDeleted(row.status)).map((row) => row.path);
  const untracked = rows.filter((row) => isUntracked(row.status)).map((row) => row.path);
  const untrackedSet = new Set(untracked);
  const untrackedByBasename = new Map();
  for (const path of untracked) {
    const base = path.split('/').pop() || path;
    if (!untrackedByBasename.has(base)) {
      untrackedByBasename.set(base, []);
    }
    untrackedByBasename.get(base).push(path);
  }

  const prefixMoves = [
    ['apps/_shared/cognition/', 'client/cognition/shared/'],
    ['apps/habits/', 'client/cognition/habits/'],
    ['scripts/', 'tests/tooling/scripts/'],
  ];

  const pairs = [];
  for (const oldPath of deleted) {
    const expectedPaths = [];
    for (const [fromPrefix, toPrefix] of prefixMoves) {
      if (oldPath.startsWith(fromPrefix)) {
        expectedPaths.push(`${toPrefix}${oldPath.slice(fromPrefix.length)}`);
      }
    }
    if (oldPath === 'apps/_shared/run_protheus_ops.js') {
      expectedPaths.push('client/runtime/systems/ops/run_protheus_ops.js');
    }
    let match = expectedPaths.find((candidate) => untrackedSet.has(candidate)) || null;
    if (!match) {
      const base = oldPath.split('/').pop() || oldPath;
      const basenameCandidates = untrackedByBasename.get(base) || [];
      match = basenameCandidates[0] || null;
    }
    if (match) {
      pairs.push({ from: oldPath, to: match });
    }
  }
  return pairs;
}

function toMarkdown(payload) {
  const lines = [];
  lines.push('# Churn Guard (Current)');
  lines.push('');
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- strict: ${payload.summary.strict}`);
  lines.push(`- commit_gate: ${payload.summary.commit_gate}`);
  lines.push(`- total_dirty_entries: ${payload.summary.total}`);
  lines.push(`- local_simulation_churn: ${payload.summary.local_simulation_churn}`);
  lines.push(`- lensmap_churn: ${payload.summary.lensmap_churn}`);
  lines.push(`- generated_report_churn: ${payload.summary.generated_report_churn}`);
  lines.push(`- governance_doc_churn: ${payload.summary.governance_doc_churn}`);
  lines.push(`- allow_governance_doc_churn: ${payload.summary.allow_governance_doc_churn}`);
  lines.push(`- likely_unstaged_moves: ${payload.summary.likely_unstaged_moves}`);
  lines.push(`- untracked: ${payload.summary.untracked}`);
  lines.push(`- commit_gate_forbidden: ${payload.summary.commit_gate_forbidden}`);
  lines.push(`- other: ${payload.summary.other}`);
  lines.push(`- clean_pass: ${payload.summary.clean_pass}`);
  lines.push(`- commit_gate_pass: ${payload.summary.commit_gate_pass}`);
  lines.push(`- pass: ${payload.summary.pass}`);
  lines.push('');
  if (payload.likely_unstaged_moves.length > 0) {
    lines.push('## Likely Unstaged Move Pairs');
    lines.push('| From (deleted) | To (untracked) |');
    lines.push('| --- | --- |');
    for (const pair of payload.likely_unstaged_moves.slice(0, 80)) {
      lines.push(`| ${pair.from} | ${pair.to} |`);
    }
    lines.push('');
    lines.push('Remediation: stage moves as a single rename set (`git add -A`) before continuing.');
    lines.push('');
  }
  if (payload.rows.length > 0) {
    lines.push('| Status | Category | Path |');
    lines.push('| --- | --- | --- |');
    for (const row of payload.rows) {
      lines.push(`| ${row.status.trim()} | ${row.category} | ${row.path} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = parseStatus();
  const likelyUnstagedMoves = detectLikelyUnstagedMoves(rows);
  const untrackedRows = rows.filter((row) => isUntracked(row.status));
  const forbiddenCommitCategories = new Set([
    'local_simulation_churn',
    'lensmap_churn',
    'generated_report_churn',
  ]);
  const forbiddenCommitRows = rows.filter((row) => forbiddenCommitCategories.has(row.category));
  const governanceCommitRows = rows.filter((row) => row.category === 'governance_doc_churn');
  const commitGatePass =
    forbiddenCommitRows.length === 0 &&
    (args.allowGovernanceDocChurn || governanceCommitRows.length === 0) &&
    likelyUnstagedMoves.length === 0 &&
    untrackedRows.length === 0;

  const summary = {
    strict: args.strict,
    commit_gate: args.commitGate,
    total: rows.length,
    local_simulation_churn: rows.filter((r) => r.category === 'local_simulation_churn').length,
    lensmap_churn: rows.filter((r) => r.category === 'lensmap_churn').length,
    generated_report_churn: rows.filter((r) => r.category === 'generated_report_churn').length,
    governance_doc_churn: rows.filter((r) => r.category === 'governance_doc_churn').length,
    allow_governance_doc_churn: args.allowGovernanceDocChurn,
    likely_unstaged_moves: likelyUnstagedMoves.length,
    untracked: untrackedRows.length,
    commit_gate_forbidden: forbiddenCommitRows.length,
    other: rows.filter((r) => r.category === 'other').length,
  };
  summary.clean_pass =
    summary.local_simulation_churn === 0 &&
    summary.lensmap_churn === 0 &&
    (summary.governance_doc_churn === 0 || args.allowGovernanceDocChurn) &&
    summary.likely_unstaged_moves === 0 &&
    summary.other === 0;
  summary.commit_gate_pass = commitGatePass;
  summary.pass = args.commitGate ? summary.commit_gate_pass : summary.clean_pass;

  const payload = {
    ok: true,
    type: 'churn_guard',
    generatedAt: new Date().toISOString(),
    summary,
    likely_unstaged_moves: likelyUnstagedMoves,
    rows,
  };

  mkdirSync(resolve('core/local/artifacts'), { recursive: true });
  mkdirSync(resolve('local/workspace/reports'), { recursive: true });
  writeFileSync(resolve(OUT_JSON), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(resolve(OUT_MD), toMarkdown(payload));

  if (args.strict && !summary.pass) {
    console.error(
      JSON.stringify(
        { ok: false, type: 'churn_guard', out_json: OUT_JSON, out_markdown: OUT_MD, summary },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      { ok: true, type: 'churn_guard', out_json: OUT_JSON, out_markdown: OUT_MD, summary },
      null,
      2,
    ),
  );
}

main();
