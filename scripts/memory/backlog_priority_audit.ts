#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'config', 'backlog_registry.json');
const POLICY_PATH = path.join(ROOT, 'config', 'backlog_registry_policy.json');
const REVIEW_REGISTRY_PATH = path.join(ROOT, 'config', 'backlog_review_registry.json');
const PRIORITY_VIEW_PATH = path.join(ROOT, 'docs', 'backlog_views', 'priority_queue.md');
const REVIEW_VIEW_PATH = path.join(ROOT, 'docs', 'backlog_views', 'reviewed.md');
const STATE_DIR = path.join(ROOT, 'state', 'ops', 'backlog_priority_audit');
const LATEST_PATH = path.join(STATE_DIR, 'latest.json');
const HISTORY_PATH = path.join(STATE_DIR, 'history.jsonl');
const ROOT_PATH_PREFIXES = [
  'client/runtime/systems/',
  'crates/',
  'client/runtime/config/',
  'docs/client/',
  'client/memory/',
  'client/cognition/adaptive/',
  'state/',
  'client/runtime/lib/',
  'packages/',
  'platform/'
];

const STATUS_WEIGHT = {
  in_progress: 120,
  queued: 100,
  blocked: 40,
  done: 10
};

const IMPACT_KEYWORDS = [
  'rust', 'migration', 'primitive', 'kernel', 'conduit', 'execution', 'memory',
  'spine', 'policy', 'receipt', 'covenant', 'security', 'runtime', 'settle',
  'blob', 'lattice', 'flux', 'core'
];

const RISK_KEYWORDS = [
  'security', 'sovereignty', 'covenant', 'policy', 'receipt', 'runtime', 'core',
  'payment', 'wallet', 'tamper', 'integrity', 'fail-closed', 'drift', 'autonomy',
  'sandbox', 'supply chain', 'secrets'
];

let FILE_BASENAME_INDEX = null;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalize(value) {
  return String(value || '').toLowerCase();
}

function keywordScore(text, keywords, weight) {
  let score = 0;
  for (const k of keywords) {
    if (text.includes(k)) {
      score += weight;
    }
  }
  return score;
}

function extractBacktickedPaths(text) {
  const source = String(text || '');
  const matches = source.match(/`([^`]+)`/g) || [];
  const refs = [];
  for (const m of matches) {
    const t = m.slice(1, -1).trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    if (
      t.includes(' ') ||
      t.includes('...') ||
      t.includes('<') ||
      t.includes('>') ||
      t.includes('%') ||
      t === '.js' ||
      t === '.ts' ||
      t === '.rs' ||
      t === '.md' ||
      t.startsWith('.') ||
      lower.startsWith('node ') ||
      lower.startsWith('npm ') ||
      lower.startsWith('cargo ') ||
      lower.startsWith('cd ') ||
      lower.startsWith('git ')
    ) {
      continue;
    }
    const pathLike =
      ROOT_PATH_PREFIXES.some((p) => t.startsWith(p)) ||
      t.endsWith('.json') ||
      t.endsWith('.ts') ||
      t.endsWith('.js') ||
      t.endsWith('.rs') ||
      t.endsWith('.md');
    if (pathLike) {
      refs.push(t);
    }
  }
  return Array.from(new Set(refs));
}

function buildBasenameIndex() {
  if (FILE_BASENAME_INDEX) return FILE_BASENAME_INDEX;
  const roots = ['systems', 'crates', 'config', 'docs', 'memory', 'adaptive', 'lib', 'packages', 'platform', 'state'];
  const index = new Set();
  const stack = roots.map((r) => path.join(ROOT, r)).filter((p) => fs.existsSync(p));
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_err) {
      continue;
    }
    for (const ent of ents) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        stack.push(p);
      } else if (ent.isFile()) {
        index.add(ent.name);
      }
    }
  }
  FILE_BASENAME_INDEX = index;
  return index;
}

function resolveRef(ref) {
  const cleaned = ref.replace(/^\.\/+/, '');
  return path.isAbsolute(cleaned) ? cleaned : path.join(ROOT, cleaned);
}

function fileExists(ref) {
  try {
    if (ref.includes('{ts,js}')) {
      return fileExists(ref.replace('{ts,js}', 'ts')) || fileExists(ref.replace('{ts,js}', 'js'));
    }
    if (ref.includes('*')) {
      const absPattern = resolveRef(ref);
      const dir = path.dirname(absPattern);
      if (!fs.existsSync(dir)) return false;
      const base = path.basename(absPattern);
      const escaped = base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const re = new RegExp(`^${escaped}$`);
      const entries = fs.readdirSync(dir);
      return entries.some((name) => re.test(name));
    }
    if (ref.endsWith('.*')) {
      const base = resolveRef(ref.slice(0, -2));
      const candidates = [`${base}.ts`, `${base}.js`, `${base}.rs`, `${base}.json`, `${base}.md`];
      return candidates.some((c) => fs.existsSync(c));
    }
    const abs = resolveRef(ref);
    if (fs.existsSync(abs)) return true;
    if (!ref.includes('/')) {
      const baseIndex = buildBasenameIndex();
      if (baseIndex.has(ref)) return true;
    }
    const candidates = [];
    if (abs.endsWith('.ts')) candidates.push(abs.replace(/\.ts$/i, '.js'));
    if (abs.endsWith('.js')) candidates.push(abs.replace(/\.js$/i, '.ts'));
    if (!path.extname(abs)) {
      candidates.push(`${abs}.ts`, `${abs}.js`, `${abs}.rs`, path.join(abs, 'index.ts'), path.join(abs, 'index.js'));
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) return true;
    }
    return false;
  } catch (_err) {
    return false;
  }
}

function formatIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(filePath, value) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function byPriority(a, b) {
  if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
  return a.id.localeCompare(b.id);
}

function buildPriorityRows(rows) {
  const statusById = new Map(rows.map((r) => [r.id, r.status]));
  const dependents = new Map();
  for (const row of rows) {
    for (const dep of row.dependencies || []) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(row.id);
    }
  }

  return rows.map((row) => {
    const text = normalize(`${row.title}\n${row.problem}\n${row.acceptance}\n${row.class}\n${row.wave}`);
    const impact = keywordScore(text, IMPACT_KEYWORDS, 3);
    const risk = keywordScore(text, RISK_KEYWORDS, 4);
    const unresolvedDeps = (row.dependencies || []).filter((dep) => {
      const s = statusById.get(dep);
      return s && s !== 'done';
    }).length;
    const unlockCount = (dependents.get(row.id) || []).length;
    const statusWeight = STATUS_WEIGHT[row.status] || 0;
    const blockedPenalty = row.status === 'blocked' ? 8 : 0;
    const priorityScore = statusWeight + impact + risk + (unlockCount * 2) - (unresolvedDeps * 3) - blockedPenalty;

    return {
      ...row,
      impact_score: impact,
      risk_score: risk,
      unresolved_deps: unresolvedDeps,
      unlock_count: unlockCount,
      priority_score: priorityScore
    };
  }).sort(byPriority);
}

function buildReviewRows(rows, doneStatuses) {
  const doneSet = new Set(doneStatuses || ['done']);
  const out = [];
  for (const row of rows) {
    const refs = extractBacktickedPaths(row.acceptance);
    const existingRefs = refs.filter(fileExists);
    const missingRefs = refs.filter((r) => !fileExists(r));
    let reviewResult = 'n/a';
    let reviewed = false;
    let reviewedStatus = row.status;

    if (doneSet.has(row.status)) {
      reviewed = true;
      reviewedStatus = 'reviewed';
      const hardMissing = missingRefs.filter((ref) => {
        const lower = ref.toLowerCase();
        if (
          lower.startsWith('state/') ||
          lower.startsWith('client/cognition/adaptive/') ||
          lower.startsWith('client/memory/') ||
          lower.startsWith('tmp/')
        ) {
          return false;
        }
        return true;
      });
      if (hardMissing.length > 0) {
        reviewResult = 'fail';
      } else if (existingRefs.length > 0) {
        reviewResult = 'pass';
      } else {
        reviewResult = 'warn';
      }
    } else if (row.status === 'blocked') {
      reviewResult = 'blocked';
    } else {
      reviewResult = 'needs_implementation';
    }

    out.push({
      id: row.id,
      class: row.class,
      wave: row.wave,
      status: row.status,
      reviewed_status: reviewedStatus,
      title: row.title,
      reviewed,
      review_result: reviewResult,
      evidence_refs: refs,
      evidence_found: existingRefs,
      evidence_missing: missingRefs,
      dependencies: row.dependencies || []
    });
  }
  return out;
}

function writePriorityView(rows, generatedAt) {
  const active = rows.filter((r) => r.status !== 'done');
  const done = rows.filter((r) => r.status === 'done');
  const lines = [];
  lines.push('# Backlog Priority Queue');
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push('');
  lines.push('Scoring model: impact + risk + dependency pressure (unblocks and unresolved deps), with status weighting.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total rows: ${rows.length}`);
  lines.push(`- Active rows: ${active.length}`);
  lines.push(`- Completed rows: ${done.length}`);
  lines.push('');
  lines.push('## Active Execution Order');
  lines.push('');
  lines.push('| Rank | ID | Status | Priority | Impact | Risk | Unresolved Deps | Unlock Count | Title |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---|');
  active.forEach((r, idx) => {
    lines.push(`| ${idx + 1} | ${r.id} | ${r.status} | ${r.priority_score} | ${r.impact_score} | ${r.risk_score} | ${r.unresolved_deps} | ${r.unlock_count} | ${r.title} |`);
  });
  lines.push('');
  lines.push('## Completed Review Order');
  lines.push('');
  lines.push('| Rank | ID | Priority | Impact | Risk | Unlock Count | Title |');
  lines.push('|---|---|---:|---:|---:|---:|---|');
  done.forEach((r, idx) => {
    lines.push(`| ${idx + 1} | ${r.id} | ${r.priority_score} | ${r.impact_score} | ${r.risk_score} | ${r.unlock_count} | ${r.title} |`);
  });
  lines.push('');
  ensureDir(PRIORITY_VIEW_PATH);
  fs.writeFileSync(PRIORITY_VIEW_PATH, `${lines.join('\n')}\n`);
}

function writeReviewedView(reviewRows, generatedAt) {
  const doneRows = reviewRows.filter((r) => r.reviewed);
  const pass = doneRows.filter((r) => r.review_result === 'pass').length;
  const warn = doneRows.filter((r) => r.review_result === 'warn').length;
  const fail = doneRows.filter((r) => r.review_result === 'fail').length;
  const blocked = reviewRows.filter((r) => r.review_result === 'blocked').length;

  const lines = [];
  lines.push('# Backlog Reviewed View');
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push('');
  lines.push(`Summary: reviewed ${doneRows.length}/${reviewRows.length} | pass ${pass} | warn ${warn} | fail ${fail} | blocked ${blocked}`);
  lines.push('');
  lines.push('| ID | Status | Reviewed Status | Review Result | Reviewed | Title |');
  lines.push('|---|---|---|---|---|---|');
  reviewRows.forEach((r) => {
    lines.push(`| ${r.id} | ${r.status} | ${r.reviewed_status} | ${r.review_result} | ${r.reviewed ? 'yes' : 'no'} | ${r.title} |`);
  });
  lines.push('');
  ensureDir(REVIEW_VIEW_PATH);
  fs.writeFileSync(REVIEW_VIEW_PATH, `${lines.join('\n')}\n`);
}

function main() {
  const registry = readJson(REGISTRY_PATH);
  const policy = readJson(POLICY_PATH);
  const generatedAt = formatIso();
  const priorityRows = buildPriorityRows(registry.rows || []);
  const reviewRows = buildReviewRows(priorityRows, policy?.governance?.done_statuses || ['done']);

  const summary = {
    total: reviewRows.length,
    reviewed_done: reviewRows.filter((r) => r.reviewed).length,
    pass: reviewRows.filter((r) => r.review_result === 'pass').length,
    warn: reviewRows.filter((r) => r.review_result === 'warn').length,
    fail: reviewRows.filter((r) => r.review_result === 'fail').length,
    blocked: reviewRows.filter((r) => r.review_result === 'blocked').length,
    needs_implementation: reviewRows.filter((r) => r.review_result === 'needs_implementation').length
  };

  const payload = {
    schema_id: 'backlog_priority_audit',
    schema_version: '1.0',
    generated_at: generatedAt,
    source_registry_path: path.relative(ROOT, REGISTRY_PATH),
    summary,
    priority_rows: priorityRows,
    review_rows: reviewRows
  };

  writePriorityView(priorityRows, generatedAt);
  writeReviewedView(reviewRows, generatedAt);
  writeJson(REVIEW_REGISTRY_PATH, payload);
  writeJson(LATEST_PATH, payload);
  appendJsonl(HISTORY_PATH, {
    ts: generatedAt,
    summary
  });

  console.log(JSON.stringify({
    ok: true,
    generated_at: generatedAt,
    summary,
    outputs: {
      priority_view_path: path.relative(ROOT, PRIORITY_VIEW_PATH),
      reviewed_view_path: path.relative(ROOT, REVIEW_VIEW_PATH),
      review_registry_path: path.relative(ROOT, REVIEW_REGISTRY_PATH),
      latest_path: path.relative(ROOT, LATEST_PATH),
      history_path: path.relative(ROOT, HISTORY_PATH)
    }
  }, null, 2));
}

main();
