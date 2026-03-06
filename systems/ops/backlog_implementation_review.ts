#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-REVIEW-001
 * Backlog implementation-depth review lane.
 *
 * Goal: for each backlog row, record a deterministic review result proving
 * whether the row is implemented, wired, and not just wrapper-only scaffolding.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  resolvePath,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');
const { writeArtifactSet } = require('../../lib/state_artifact_contract');

const DEFAULT_POLICY_PATH = process.env.BACKLOG_IMPLEMENTATION_REVIEW_POLICY_PATH
  ? path.resolve(process.env.BACKLOG_IMPLEMENTATION_REVIEW_POLICY_PATH)
  : path.join(ROOT, 'config', 'backlog_implementation_review_policy.json');

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.rs', '.py', '.go', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.kt', '.swift'
]);

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/backlog_implementation_review.js run [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/backlog_implementation_review.js status [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function asList(v: unknown, maxLen = 400) {
  if (Array.isArray(v)) {
    return v.map((row) => cleanText(row, maxLen)).filter(Boolean);
  }
  const txt = cleanText(v || '', 5000);
  if (!txt) return [];
  return txt.split(',').map((row) => cleanText(row, maxLen)).filter(Boolean);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const review = raw.review && typeof raw.review === 'object' ? raw.review : {};
  const search = raw.search && typeof raw.search === 'object' ? raw.search : {};
  return {
    version: cleanText(raw.version || '1.0', 24) || '1.0',
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, false),
    source_registry_path: resolvePath(raw.source_registry_path, 'config/backlog_registry.json'),
    outputs: {
      review_registry_path: resolvePath(outputs.review_registry_path, 'config/backlog_review_registry.json'),
      reviewed_view_path: resolvePath(outputs.reviewed_view_path, 'docs/backlog_views/reviewed.md'),
      latest_path: resolvePath(outputs.latest_path, 'state/ops/backlog_implementation_review/latest.json'),
      history_path: resolvePath(outputs.history_path, 'state/ops/backlog_implementation_review/history.jsonl')
    },
    review: {
      done_statuses: asList(review.done_statuses || ['done'], 40).map((v) => normalizeToken(v, 40)).filter(Boolean),
      blocked_statuses: asList(review.blocked_statuses || ['blocked'], 40).map((v) => normalizeToken(v, 40)).filter(Boolean),
      wrapper_max_bytes: clampInt(review.wrapper_max_bytes, 32, 4096, 240),
      min_substantive_lines: clampInt(review.min_substantive_lines, 1, 5000, 20),
      max_scan_bytes: clampInt(review.max_scan_bytes, 1024, 1024 * 16, 1024 * 1024)
    },
    search: {
      roots: asList(
        search.roots || ['systems', 'lib', 'core', 'packages', 'platform', 'config', 'docs', 'memory/tools/tests', 'tests'],
        220
      ),
      exclude_paths: asList(
        search.exclude_paths || [
          'UPGRADE_BACKLOG.md',
          'docs/backlog_views/active.md',
          'docs/backlog_views/archive.md',
          'docs/backlog_views/reviewed.md',
          'config/backlog_registry.json',
          'config/backlog_review_registry.json',
          'node_modules/'
        ],
        260
      )
    },
    policy_path: path.resolve(policyPath)
  };
}

function escapeRegExp(v: string) {
  return String(v || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikePath(raw: string) {
  const txt = cleanText(raw || '', 520).replace(/[),.;:]+$/g, '');
  if (!txt) return '';
  if (txt.startsWith('http://') || txt.startsWith('https://')) return '';
  if (txt.includes(' ')) return '';
  const plain = txt.replace(/^`|`$/g, '');
  if (
    plain.startsWith('/')
    || plain.startsWith('./')
    || plain.startsWith('../')
    || plain.startsWith('systems/')
    || plain.startsWith('lib/')
    || plain.startsWith('core/')
    || plain.startsWith('packages/')
    || plain.startsWith('platform/')
    || plain.startsWith('config/')
    || plain.startsWith('docs/')
    || plain.startsWith('memory/')
    || plain.startsWith('tests/')
    || plain === 'UPGRADE_BACKLOG.md'
  ) {
    return plain;
  }
  if (/^[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+$/.test(plain)) return plain;
  return '';
}

function extractAcceptancePaths(text: string) {
  const out: string[] = [];
  const re = /`([^`]+)`/g;
  let match;
  while ((match = re.exec(String(text || '')))) {
    const ref = looksLikePath(match[1]);
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

function acceptanceRefExists(ref: string) {
  const raw = cleanText(ref || '', 520).replace(/[),.;:]+$/g, '');
  if (!raw) return { exists: false, resolved: null };

  const candidates = new Set<string>();
  candidates.add(raw);

  const bracePairs = [
    ['{ts,js}', ['ts', 'js']],
    ['{js,ts}', ['js', 'ts']],
    ['{md,json}', ['md', 'json']],
    ['{json,md}', ['json', 'md']]
  ];
  for (const [token, exts] of bracePairs) {
    if (raw.includes(token)) {
      for (const ext of exts as string[]) {
        candidates.add(raw.replace(token, ext));
      }
    }
  }

  if (raw.endsWith('.*')) {
    const stem = raw.slice(0, -2);
    for (const ext of ['ts', 'js', 'json', 'md', 'rs']) {
      candidates.add(`${stem}.${ext}`);
    }
  }

  const absRaw = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
  const hasExplicitExt = !!path.extname(raw);
  if (!hasExplicitExt && !raw.endsWith('/')) {
    for (const ext of ['.ts', '.js', '.json', '.md', '.rs']) {
      candidates.add(`${raw}${ext}`);
    }
  }

  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate) ? candidate : path.join(ROOT, candidate);
    if (fs.existsSync(abs)) return { exists: true, resolved: rel(abs) };
  }

  // Simple wildcard support, e.g. docs/proofs/platform/socket_*.md
  if (raw.includes('*')) {
    const absPattern = absRaw;
    const dir = path.dirname(absPattern);
    const base = path.basename(raw);
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { entries = []; }
    if (entries.length) {
      const escaped = base.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const re = new RegExp(`^${escaped}$`);
      const match = entries.find((entry) => re.test(entry));
      if (match) {
        const found = path.join(dir, match);
        return { exists: true, resolved: rel(found) };
      }
    }
  }

  return { exists: false, resolved: null };
}

function listSearchFiles(policy: any) {
  const roots = (policy.search && Array.isArray(policy.search.roots) ? policy.search.roots : [])
    .map((row: string) => cleanText(row, 260))
    .filter(Boolean)
    .filter((row: string) => fs.existsSync(path.join(ROOT, row)));

  const exclude = new Set(
    (policy.search && Array.isArray(policy.search.exclude_paths) ? policy.search.exclude_paths : [])
      .map((row: string) => cleanText(row, 260))
      .filter(Boolean)
  );

  let relPaths: string[] = [];
  if (roots.length > 0) {
    const rg = spawnSync('rg', ['--files', ...roots], { cwd: ROOT, encoding: 'utf8' });
    if (Number(rg.status || 0) === 0) {
      relPaths = String(rg.stdout || '')
        .split('\n')
        .map((row) => cleanText(row, 520))
        .filter(Boolean);
    }
  }
  if (!relPaths.length) {
    const walked: string[] = [];
    function walk(absDir: string) {
      let entries = [];
      try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const abs = path.join(absDir, entry.name);
        const relPath = rel(abs);
        if (exclude.has(relPath)) continue;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          walk(abs);
        } else if (entry.isFile()) {
          walked.push(relPath);
        }
      }
    }
    for (const rootRel of roots) walk(path.join(ROOT, rootRel));
    relPaths = walked;
  }
  return relPaths.filter((row) => {
    if (!row) return false;
    if (exclude.has(row)) return false;
    for (const ex of exclude) {
      if (!ex.endsWith('/') && row === ex) return false;
      if (ex.endsWith('/') && row.startsWith(ex)) return false;
    }
    return true;
  });
}

function classifyBucket(relPath: string) {
  const v = String(relPath || '');
  if (v.startsWith('memory/tools/tests/') || v.startsWith('tests/')) return 'test';
  if (v.startsWith('config/')) return 'config';
  if (v.startsWith('docs/')) return 'docs';
  if (
    v.startsWith('systems/')
    || v.startsWith('lib/')
    || v.startsWith('core/')
    || v.startsWith('packages/')
    || v.startsWith('platform/')
  ) return 'runtime';
  return 'other';
}

function countSubstantiveLines(body: string) {
  return String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line === '{' || line === '}' || line === ';') return false;
      if (line.startsWith('//')) return false;
      if (line.startsWith('/*') || line.startsWith('*') || line.startsWith('*/')) return false;
      if (line.startsWith('#')) return false;
      return true;
    })
    .length;
}

function isJsWrapper(absPath: string, policy: any) {
  if (path.extname(absPath).toLowerCase() !== '.js') return false;
  let stat = null;
  try { stat = fs.statSync(absPath); } catch { return false; }
  if (!stat || !stat.isFile()) return false;
  if (stat.size > Number(policy.review.wrapper_max_bytes || 240)) return false;
  let body = '';
  try { body = fs.readFileSync(absPath, 'utf8'); } catch { return false; }
  const normalized = body.replace(/\s+/g, ' ');
  if (normalized.includes('ts_bootstrap') && normalized.includes('bootstrap(__filename')) return true;
  return false;
}

function hasSubstantiveTwin(absJsPath: string, policy: any) {
  const tsPath = absJsPath.replace(/\.js$/i, '.ts');
  if (!fs.existsSync(tsPath)) return false;
  let body = '';
  try { body = fs.readFileSync(tsPath, 'utf8'); } catch { return false; }
  return countSubstantiveLines(body) >= Number(policy.review.min_substantive_lines || 20);
}

function isSubstantiveCode(absPath: string, policy: any) {
  const ext = path.extname(absPath).toLowerCase();
  if (!CODE_EXT.has(ext)) return false;
  if (ext === '.js') {
    if (isJsWrapper(absPath, policy)) return false;
  }
  let body = '';
  try { body = fs.readFileSync(absPath, 'utf8'); } catch { return false; }
  return countSubstantiveLines(body) >= Number(policy.review.min_substantive_lines || 20);
}

function buildIdEvidence(rows: any[], policy: any) {
  const ids = rows
    .map((row) => cleanText(row && row.id || '', 80))
    .filter((row) => /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(row));
  const uniqueIds = Array.from(new Set(ids));
  const evidenceById: any = {};
  for (const id of uniqueIds) evidenceById[id] = new Set<string>();
  if (!uniqueIds.length) return evidenceById;

  const files = listSearchFiles(policy);
  if (!files.length) return evidenceById;

  const pattern = new RegExp(`\\b(?:${uniqueIds.map((id) => escapeRegExp(id)).join('|')})\\b`, 'g');
  const maxScanBytes = Number(policy.review.max_scan_bytes || 1024 * 1024);
  for (const relPath of files) {
    const absPath = path.join(ROOT, relPath);
    let stat = null;
    try { stat = fs.statSync(absPath); } catch { continue; }
    if (!stat || !stat.isFile() || stat.size > maxScanBytes) continue;
    let body = '';
    try { body = fs.readFileSync(absPath, 'utf8'); } catch { continue; }
    pattern.lastIndex = 0;
    let match;
    const localHits = new Set<string>();
    while ((match = pattern.exec(body))) {
      const id = cleanText(match[0], 80);
      if (id) localHits.add(id);
    }
    for (const id of localHits) evidenceById[id].add(relPath);
  }
  return evidenceById;
}

function renderReviewedView(registry: any) {
  const lines: string[] = [];
  lines.push('# Backlog Reviewed View');
  lines.push('');
  lines.push(`Generated: ${registry.generated_at}`);
  lines.push('');
  lines.push(`Summary: reviewed ${registry.reviewed_count}/${registry.row_count} | pass ${registry.pass_count} | warn ${registry.warn_count} | fail ${registry.fail_count} | blocked ${registry.blocked_count}`);
  lines.push('');
  lines.push('| ID | Status | Review Result | Reviewed | Title |');
  lines.push('|---|---|---|---|---|');
  for (const row of registry.rows || []) {
    lines.push(`| ${row.id} | ${row.status} | ${row.review_result} | ${row.reviewed ? 'yes' : 'no'} | ${row.title || ''} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function reviewRow(row: any, idEvidenceByRow: any, policy: any, doneSet: Set<string>, blockedSet: Set<string>) {
  const id = cleanText(row && row.id || '', 80);
  const status = normalizeToken(row && row.status || 'queued', 40) || 'queued';
  const title = cleanText(row && row.title || '', 400);
  const acceptance = cleanText(row && row.acceptance || '', 16000);
  const reviewedAt = nowIso();

  const refs = extractAcceptancePaths(acceptance);
  const existingRefs: string[] = [];
  const missingRefs: string[] = [];
  for (const ref of refs) {
    const resolved = acceptanceRefExists(ref);
    if (resolved.exists && resolved.resolved) existingRefs.push(resolved.resolved);
    else missingRefs.push(cleanText(ref, 260));
  }

  const idEvidence = Array.from((idEvidenceByRow[id] || new Set<string>()) as Set<string>);
  const evidence = new Set<string>([...existingRefs, ...idEvidence]);

  const runtimePaths: string[] = [];
  const configPaths: string[] = [];
  const testPaths: string[] = [];
  const docPaths: string[] = [];
  const codePaths: string[] = [];
  const substantiveCodePaths: string[] = [];
  const wrapperOnlyPaths: string[] = [];

  for (const relPath of evidence) {
    const abs = path.join(ROOT, relPath);
    const bucket = classifyBucket(relPath);
    if (bucket === 'runtime') runtimePaths.push(relPath);
    else if (bucket === 'config') configPaths.push(relPath);
    else if (bucket === 'test') testPaths.push(relPath);
    else if (bucket === 'docs') docPaths.push(relPath);

    const ext = path.extname(relPath).toLowerCase();
    if (CODE_EXT.has(ext)) {
      codePaths.push(relPath);
      const wrapper = ext === '.js' && isJsWrapper(abs, policy);
      if (wrapper) {
        if (hasSubstantiveTwin(abs, policy)) {
          const twin = rel(abs.replace(/\.js$/i, '.ts'));
          if (!substantiveCodePaths.includes(twin)) substantiveCodePaths.push(twin);
        } else {
          wrapperOnlyPaths.push(relPath);
        }
      } else if (isSubstantiveCode(abs, policy)) {
        substantiveCodePaths.push(relPath);
      }
    }
  }

  const reasons: string[] = [];
  let reviewResult = 'pass';
  if (doneSet.has(status)) {
    const hasImplementation = substantiveCodePaths.length > 0;
    const wrapperOnlyRisk = codePaths.length > 0 && substantiveCodePaths.length === 0 && wrapperOnlyPaths.length > 0;
    const hasWiringEvidence = runtimePaths.length > 0 && (configPaths.length > 0 || testPaths.length > 0 || docPaths.length > 0 || existingRefs.length > 0);

    if (!hasImplementation) reasons.push('implementation_anchor_missing');
    if (wrapperOnlyRisk) reasons.push('wrapper_only_without_substantive_impl');
    if (!hasWiringEvidence) reasons.push('wiring_evidence_missing');
    if (missingRefs.length > 0) reasons.push('acceptance_reference_missing');

    if (wrapperOnlyRisk) reviewResult = 'fail';
    else if (reasons.length > 0) reviewResult = 'warn';
  } else if (blockedSet.has(status)) {
    reviewResult = 'blocked_external';
    reasons.push('blocked_non_doable');
  } else {
    reviewResult = 'non_archive_status';
    reasons.push('status_not_done');
  }

  return {
    id,
    status,
    title,
    reviewed: true,
    reviewed_at: reviewedAt,
    review_result: reviewResult,
    reasons,
    evidence: {
      acceptance_references: refs,
      acceptance_reference_missing: missingRefs,
      acceptance_reference_existing: existingRefs,
      id_evidence_paths: idEvidence,
      runtime_paths: runtimePaths,
      config_paths: configPaths,
      test_paths: testPaths,
      doc_paths: docPaths,
      code_paths: codePaths,
      substantive_code_paths: Array.from(new Set(substantiveCodePaths)),
      wrapper_only_paths: wrapperOnlyPaths
    },
    dependencies: Array.isArray(row && row.dependencies) ? row.dependencies : []
  };
}

function runReview(policy: any) {
  const src = readJson(policy.source_registry_path, null);
  if (!src || typeof src !== 'object') {
    return {
      ok: false,
      error: 'source_registry_missing_or_invalid',
      source_registry_path: rel(policy.source_registry_path)
    };
  }
  const rows = Array.isArray(src.rows) ? src.rows : [];
  const doneSet = new Set((policy.review.done_statuses || ['done']).map((v: string) => normalizeToken(v, 40)).filter(Boolean));
  const blockedSet = new Set((policy.review.blocked_statuses || ['blocked']).map((v: string) => normalizeToken(v, 40)).filter(Boolean));
  const idEvidence = buildIdEvidence(rows, policy);

  const reviewedRows = rows.map((row: any) => reviewRow(row, idEvidence, policy, doneSet, blockedSet));
  const passRows = reviewedRows.filter((row: any) => row.review_result === 'pass');
  const warnRows = reviewedRows.filter((row: any) => row.review_result === 'warn');
  const failRows = reviewedRows.filter((row: any) => row.review_result === 'fail');
  const blockedRows = reviewedRows.filter((row: any) => row.review_result === 'blocked_external');

  const registry = {
    schema_id: 'backlog_review_registry_v1',
    schema_version: '1.0',
    generated_at: nowIso(),
    policy_path: rel(policy.policy_path),
    source_registry_path: rel(policy.source_registry_path),
    source_registry_hash: stableHash(JSON.stringify(src), 24),
    row_count: reviewedRows.length,
    reviewed_count: reviewedRows.filter((row: any) => row.reviewed === true).length,
    pass_count: passRows.length,
    warn_count: warnRows.length,
    fail_count: failRows.length,
    blocked_count: blockedRows.length,
    rows: reviewedRows
  };

  const view = renderReviewedView(registry);
  writeJsonAtomic(policy.outputs.review_registry_path, registry);
  fs.mkdirSync(path.dirname(policy.outputs.reviewed_view_path), { recursive: true });
  fs.writeFileSync(policy.outputs.reviewed_view_path, view, 'utf8');

  const latest = {
    ok: failRows.length === 0,
    type: 'backlog_implementation_review',
    action: 'run',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    source_registry_path: rel(policy.source_registry_path),
    review_registry_path: rel(policy.outputs.review_registry_path),
    reviewed_view_path: rel(policy.outputs.reviewed_view_path),
    row_count: registry.row_count,
    reviewed_count: registry.reviewed_count,
    pass_count: registry.pass_count,
    warn_count: registry.warn_count,
    fail_count: registry.fail_count,
    blocked_count: registry.blocked_count,
    fail_samples: failRows.slice(0, 25).map((row: any) => ({
      id: row.id,
      status: row.status,
      reasons: row.reasons
    })),
    warn_samples: warnRows.slice(0, 25).map((row: any) => ({
      id: row.id,
      status: row.status,
      reasons: row.reasons
    }))
  };

  writeArtifactSet(
    {
      latestPath: policy.outputs.latest_path,
      historyPath: policy.outputs.history_path
    },
    latest,
    { schemaId: 'backlog_implementation_review_receipt', schemaVersion: '1.0', artifactType: 'receipt' }
  );
  return latest;
}

function cmdStatus(policy: any) {
  const latest = readJson(policy.outputs.latest_path, null);
  const registry = readJson(policy.outputs.review_registry_path, null);
  emit({
    ok: true,
    type: 'backlog_implementation_review',
    action: 'status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    latest,
    registry_summary: registry
      ? {
        schema_id: registry.schema_id || null,
        generated_at: registry.generated_at || null,
        row_count: Number(registry.row_count || 0),
        reviewed_count: Number(registry.reviewed_count || 0),
        pass_count: Number(registry.pass_count || 0),
        warn_count: Number(registry.warn_count || 0),
        fail_count: Number(registry.fail_count || 0),
        blocked_count: Number(registry.blocked_count || 0)
      }
      : null
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 40) || 'status';
  if (args.help || cmd === 'help') {
    usage();
    process.exit(0);
  }
  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  if (!policy.enabled) emit({ ok: false, error: 'backlog_implementation_review_disabled' }, 1);

  if (cmd === 'run') {
    const strict = toBool(args.strict, policy.strict_default);
    const out = runReview(policy);
    if (!out || out.ok == null) emit({ ok: false, error: 'review_failed_to_execute' }, 1);
    out.strict = strict;
    emit(out, strict && out.ok !== true ? 1 : 0);
  }
  if (cmd === 'status') return cmdStatus(policy);

  usage();
  process.exit(1);
}

main();
