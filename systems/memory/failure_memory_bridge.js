#!/usr/bin/env node
'use strict';

/**
 * systems/memory/failure_memory_bridge.js
 *
 * Deterministic bridge from runtime failure signals into memory nodes + pointer logs.
 * No LLM calls. Idempotent by failure signature/hash.
 *
 * Usage:
 *   node systems/memory/failure_memory_bridge.js run [YYYY-MM-DD] [--max-nodes=4]
 *   node systems/memory/failure_memory_bridge.js status [YYYY-MM-DD]
 *   node systems/memory/failure_memory_bridge.js --help
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { enforceMutationProvenance, recordMutationAudit } = require('../../lib/mutation_provenance.js');

const SCRIPT_SOURCE = 'systems/memory/failure_memory_bridge.js';
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const MEMORY_DIR = process.env.FAILURE_MEMORY_BRIDGE_MEMORY_DIR
  ? path.resolve(String(process.env.FAILURE_MEMORY_BRIDGE_MEMORY_DIR))
  : path.join(REPO_ROOT, 'memory');
const PAIN_SIGNALS_PATH = process.env.FAILURE_MEMORY_BRIDGE_PAIN_SIGNALS_PATH
  ? path.resolve(String(process.env.FAILURE_MEMORY_BRIDGE_PAIN_SIGNALS_PATH))
  : path.join(REPO_ROOT, 'state', 'autonomy', 'pain_signals.jsonl');
const HUMAN_ESCALATIONS_PATH = process.env.FAILURE_MEMORY_BRIDGE_HUMAN_ESCALATIONS_PATH
  ? path.resolve(String(process.env.FAILURE_MEMORY_BRIDGE_HUMAN_ESCALATIONS_PATH))
  : path.join(REPO_ROOT, 'state', 'security', 'autonomy_human_escalations.jsonl');
const POINTERS_DIR = process.env.FAILURE_MEMORY_BRIDGE_POINTERS_DIR
  ? path.resolve(String(process.env.FAILURE_MEMORY_BRIDGE_POINTERS_DIR))
  : path.join(REPO_ROOT, 'state', 'memory', 'failure_pointers');
const POINTER_INDEX_PATH = process.env.FAILURE_MEMORY_BRIDGE_POINTER_INDEX_PATH
  ? path.resolve(String(process.env.FAILURE_MEMORY_BRIDGE_POINTER_INDEX_PATH))
  : path.join(POINTERS_DIR, 'index.json');
const LEDGER_PATH = process.env.FAILURE_MEMORY_BRIDGE_LEDGER_PATH
  ? path.resolve(String(process.env.FAILURE_MEMORY_BRIDGE_LEDGER_PATH))
  : path.join(REPO_ROOT, 'state', 'memory', 'failure_memory_bridge.jsonl');

const DEFAULT_MAX_NODES = clampInt(process.env.FAILURE_MEMORY_BRIDGE_MAX_NODES || 4, 1, 20);
const MAX_SOURCE_ROWS = clampInt(process.env.FAILURE_MEMORY_BRIDGE_MAX_SOURCE_ROWS || 10000, 100, 200000);
const MAX_CAPTURE_TIER = clampInt(process.env.FAILURE_MEMORY_BRIDGE_MAX_CAPTURE_TIER || 3, 1, 3);
const INCLUDE_RESOLVED_ESCALATIONS = String(process.env.FAILURE_MEMORY_BRIDGE_INCLUDE_RESOLVED_ESCALATIONS || '0') === '1';

const CRITICAL_CODE_RE = /\b(integrity|security|guard|attestation|policy_root|break_glass|command_failed|spine|gate_manual|startup)\b/i;

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/failure_memory_bridge.js run [YYYY-MM-DD] [--max-nodes=4]');
  console.log('  node systems/memory/failure_memory_bridge.js status [YYYY-MM-DD]');
  console.log('  node systems/memory/failure_memory_bridge.js --help');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] || '');
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
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

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function toDate(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 10);
}

function toDateOnly(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonl(filePath, maxRows = null) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const use = maxRows == null ? lines : lines.slice(Math.max(0, lines.length - maxRows));
  const out = [];
  for (const line of use) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function cleanLine(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function numeric(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sha16(v) {
  return crypto.createHash('sha256').update(String(v || ''), 'utf8').digest('hex').slice(0, 16);
}

function uidAlnum(seed) {
  return crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 24);
}

function tokenizeCode(v) {
  const blob = String(v || '').toLowerCase().replace(/[^a-z0-9:_-]+/g, ' ');
  return Array.from(new Set(
    blob
      .split(/[:\s_-]+/)
      .map((t) => normalizeToken(t))
      .filter((t) => t.length >= 3)
  )).slice(0, 10);
}

function classifyTierFromSignal(row) {
  const severity = cleanLine(row && row.severity, 24).toLowerCase();
  const risk = cleanLine(row && row.risk, 24).toLowerCase();
  const code = cleanLine(row && row.code, 120).toLowerCase();
  const summary = cleanLine(row && row.summary, 240).toLowerCase();
  const blob = `${code} ${summary}`;
  if (severity === 'high' || risk === 'high' || CRITICAL_CODE_RE.test(blob)) return 1;
  if (severity === 'medium' || risk === 'medium') return 2;
  return 3;
}

function classifyTierFromEscalation(row) {
  const risk = cleanLine(row && row.risk, 24).toLowerCase();
  const stage = cleanLine(row && row.stage, 120).toLowerCase();
  const err = cleanLine(row && row.error_code, 120).toLowerCase();
  if (risk === 'high') return 1;
  if (CRITICAL_CODE_RE.test(`${stage} ${err}`)) return 1;
  return 2;
}

function computePriority(c) {
  const tier = clampInt(c && c.failure_tier || 3, 1, 3);
  const failureWindow = clampInt(c && c.failure_count_window || 1, 1, 500);
  const totalCount = clampInt(c && c.total_count || 1, 1, 5000);
  const base = (4 - tier) * 100;
  const windowBoost = Math.min(120, failureWindow * 6);
  const totalBoost = Math.min(80, Math.round(Math.log2(totalCount + 1) * 14));
  const escalationBoost = c && c.failure_kind === 'human_escalation' ? 25 : 0;
  return Number((base + windowBoost + totalBoost + escalationBoost).toFixed(2));
}

function loadPointerIndex() {
  const base = safeReadJson(POINTER_INDEX_PATH, { version: '1.0', updated_ts: null, item_hashes: {} });
  if (!base || typeof base !== 'object') return { version: '1.0', updated_ts: null, item_hashes: {} };
  if (!base.item_hashes || typeof base.item_hashes !== 'object') base.item_hashes = {};
  return base;
}

function savePointerIndex(index) {
  ensureDir(path.dirname(POINTER_INDEX_PATH));
  fs.writeFileSync(POINTER_INDEX_PATH, JSON.stringify({ ...index, updated_ts: nowIso() }, null, 2) + '\n', 'utf8');
}

function existingNodeIds(memoryPath) {
  if (!fs.existsSync(memoryPath)) return new Set();
  const text = fs.readFileSync(memoryPath, 'utf8');
  const ids = new Set();
  const re = /^\s*node_id:\s*([A-Za-z0-9._-]+)\s*$/gm;
  let m = re.exec(text);
  while (m) {
    if (m[1]) ids.add(String(m[1]));
    m = re.exec(text);
  }
  return ids;
}

function uniqueNodeId(base, seen) {
  if (!seen.has(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const next = `${base}-${i}`;
    if (!seen.has(next)) return next;
  }
  return `${base}-${Date.now()}`;
}

function makePainCandidate(row, dateStr) {
  if (!row || typeof row !== 'object') return null;
  if (String(row.type || '') !== 'pain_signal') return null;
  if (row.deferred === true) return null;
  const d = toDateOnly(row.ts);
  if (!d || d !== dateStr) return null;

  const source = cleanLine(row.source, 80) || 'unknown_source';
  const subsystem = cleanLine(row.subsystem, 80) || 'unknown_subsystem';
  const code = cleanLine(row.code, 160) || 'unknown_code';
  const summary = cleanLine(row.summary, 240) || `${source}:${code}`;
  const details = cleanLine(row.details, 400);
  const severity = cleanLine(row.severity, 24).toLowerCase() || 'medium';
  const risk = cleanLine(row.risk, 24).toLowerCase() || 'medium';
  const signature = cleanLine(row.signature, 128) || sha16(`${source}|${subsystem}|${code}|${summary}`);
  const failureTier = classifyTierFromSignal(row);
  if (failureTier > MAX_CAPTURE_TIER) return null;
  const topics = Array.from(new Set([
    'failure',
    `failure-tier-${failureTier}`,
    normalizeToken(source),
    normalizeToken(subsystem),
    ...tokenizeCode(code).slice(0, 5)
  ].filter(Boolean)));

  const failureCountWindow = Math.max(1, Number(row.failure_count_window || 1));
  const totalCount = Math.max(failureCountWindow, Number(row.total_count || failureCountWindow));

  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  const evidenceRefs = evidence
    .map((e) => cleanLine(e && (e.evidence_ref || e.match || e.path), 180))
    .filter(Boolean)
    .slice(0, 4);

  const candidate = {
    failure_kind: 'pain_signal',
    item_hash: signature,
    failure_tier: failureTier,
    ts: cleanLine(row.ts, 64),
    source,
    subsystem,
    code,
    summary,
    details,
    severity,
    risk,
    status: cleanLine(row.status, 40) || 'active',
    failure_count_window: failureCountWindow,
    total_count: totalCount,
    suggested_next_command: cleanLine(row.suggested_next_command, 240),
    topics,
    evidence_refs: evidenceRefs
  };
  candidate.priority = computePriority(candidate);
  return candidate;
}

function makeEscalationCandidate(row, dateStr) {
  if (!row || typeof row !== 'object') return null;
  if (String(row.type || '') !== 'autonomy_human_escalation') return null;
  const d = toDateOnly(row.ts);
  if (!d || d !== dateStr) return null;
  if (!INCLUDE_RESOLVED_ESCALATIONS && String(row.status || '').toLowerCase() === 'resolved') return null;

  const source = 'autonomy_human_escalation';
  const subsystem = 'governance';
  const stage = cleanLine(row.stage, 120) || 'unknown_stage';
  const errorCode = cleanLine(row.error_code, 120) || 'unknown_error';
  const code = `human_escalation:${errorCode}`;
  const summary = cleanLine(row.summary, 240) || `Human escalation required at ${stage}`;
  const details = cleanLine(row.details, 400) || cleanLine(row.message, 400);
  const signature = cleanLine(row.escalation_id, 120)
    || cleanLine(row.signature, 120)
    || sha16(`${stage}|${errorCode}|${summary}`);
  const failureTier = classifyTierFromEscalation(row);
  if (failureTier > MAX_CAPTURE_TIER) return null;

  const topics = Array.from(new Set([
    'failure',
    'human-escalation',
    `failure-tier-${failureTier}`,
    normalizeToken(stage),
    normalizeToken(errorCode)
  ].filter(Boolean)));

  const candidate = {
    failure_kind: 'human_escalation',
    item_hash: signature,
    failure_tier: failureTier,
    ts: cleanLine(row.ts, 64),
    source,
    subsystem,
    code,
    summary,
    details,
    severity: 'high',
    risk: cleanLine(row.risk, 24).toLowerCase() || 'high',
    status: cleanLine(row.status, 40) || 'active',
    failure_count_window: 1,
    total_count: 1,
    suggested_next_command: `node systems/autonomy/autonomy_controller.js status ${dateStr}`,
    topics,
    evidence_refs: [
      cleanLine(`state/security/autonomy_human_escalations.jsonl#${signature}`, 180)
    ].filter(Boolean)
  };
  candidate.priority = computePriority(candidate);
  return candidate;
}

function loadCandidates(dateStr) {
  const painRows = readJsonl(PAIN_SIGNALS_PATH, MAX_SOURCE_ROWS);
  const escRows = readJsonl(HUMAN_ESCALATIONS_PATH, MAX_SOURCE_ROWS);
  const candidates = [];
  for (const row of painRows) {
    const c = makePainCandidate(row, dateStr);
    if (c) candidates.push(c);
  }
  for (const row of escRows) {
    const c = makeEscalationCandidate(row, dateStr);
    if (c) candidates.push(c);
  }
  const merged = new Map();
  for (const c of candidates) {
    const key = String(c.item_hash || '').trim();
    if (!key) continue;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, c);
      continue;
    }
    if (Number(c.priority || 0) > Number(prev.priority || 0)) {
      merged.set(key, c);
      continue;
    }
    if (Number(c.failure_count_window || 0) > Number(prev.failure_count_window || 0)) {
      merged.set(key, c);
      continue;
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => {
      if (a.failure_tier !== b.failure_tier) return a.failure_tier - b.failure_tier;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return String(b.ts || '').localeCompare(String(a.ts || ''));
    });
}

function renderNode(dateStr, nodeId, c) {
  const uid = uidAlnum(`${dateStr}|${c.item_hash}|${c.failure_kind}|${c.code}|v1`);
  const tags = Array.from(new Set([
    'failure',
    `failure-tier-${c.failure_tier}`,
    normalizeToken(c.source),
    normalizeToken(c.subsystem),
    ...((Array.isArray(c.topics) ? c.topics : []).slice(0, 4))
  ].filter(Boolean)));
  const lines = [
    '---',
    `date: ${dateStr}`,
    `node_id: ${nodeId}`,
    `uid: ${uid}`,
    `tags: [${tags.join(', ')}]`,
    'edges_to: []',
    '---',
    '',
    `# ${nodeId}`,
    '',
    '## Failure Signal',
    '',
    `- Tier: ${c.failure_tier}`,
    `- Kind: ${c.failure_kind}`,
    `- Source: ${c.source}`,
    `- Subsystem: ${c.subsystem}`,
    `- Code: ${c.code}`,
    `- Severity/Risk: ${c.severity}/${c.risk}`,
    `- Signature: ${c.item_hash}`,
    `- Window count: ${c.failure_count_window}`,
    `- Total count: ${c.total_count}`,
    `- Status: ${c.status || 'active'}`,
    `- Priority: ${c.priority}`,
    '',
    '## Summary',
    '',
    `- ${c.summary}`,
    c.details ? `- Details: ${c.details}` : '- Details: n/a',
    c.suggested_next_command
      ? `- Suggested next command: \`${c.suggested_next_command}\``
      : '- Suggested next command: n/a',
    '',
    '## Evidence Refs',
    ''
  ];
  if (Array.isArray(c.evidence_refs) && c.evidence_refs.length > 0) {
    for (const ref of c.evidence_refs.slice(0, 6)) {
      lines.push(`- ${ref}`);
    }
  } else {
    lines.push('- none');
  }
  lines.push('');
  lines.push('## Learning Loop');
  lines.push('');
  lines.push('- Revisit this failure during dream cycles until recurrence drops.');
  lines.push(`- Prefer tier-${c.failure_tier} failures when selecting repair experiments.`);
  lines.push('');
  return { text: lines.join('\n'), uid };
}

function appendNodeToMemory(dateStr, c) {
  ensureDir(MEMORY_DIR);
  const memoryPath = path.join(MEMORY_DIR, `${dateStr}.md`);
  const seen = existingNodeIds(memoryPath);
  const baseNodeId = `failure-t${c.failure_tier}-${String(c.item_hash || '').slice(0, 8)}`;
  const nodeId = uniqueNodeId(baseNodeId, seen);
  const rendered = renderNode(dateStr, nodeId, c);
  if (!fs.existsSync(memoryPath) || fs.readFileSync(memoryPath, 'utf8').trim().length === 0) {
    fs.writeFileSync(memoryPath, rendered.text + '\n', 'utf8');
  } else {
    fs.appendFileSync(memoryPath, `\n\n<!-- NODE -->\n\n${rendered.text}\n`, 'utf8');
  }
  return { memoryPath, nodeId, uid: rendered.uid };
}

function writePointers(dateStr, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  ensureDir(POINTERS_DIR);
  const fp = path.join(POINTERS_DIR, `${dateStr}.jsonl`);
  for (const row of rows) appendJsonl(fp, row);
  return fp;
}

function runBridge(dateStr, maxNodes) {
  const provenance = enforceMutationProvenance('memory', {
    source: SCRIPT_SOURCE,
    reason: 'failure_memory_bridge_run'
  }, {
    fallbackSource: SCRIPT_SOURCE,
    defaultReason: 'failure_memory_bridge_run',
    context: `run:${dateStr}`
  });

  const index = loadPointerIndex();
  const known = new Set(Object.keys(index.item_hashes || {}));
  const pointerPath = path.join(POINTERS_DIR, `${dateStr}.jsonl`);
  const existingPointerRows = fs.existsSync(pointerPath) ? readJsonl(pointerPath) : [];
  const alreadyPointeredToday = new Set(
    existingPointerRows.map((r) => String(r && r.item_hash || '').trim()).filter(Boolean)
  );

  const candidates = loadCandidates(dateStr);
  const eligible = candidates.filter((c) => !alreadyPointeredToday.has(c.item_hash));
  const unseen = eligible.filter((c) => !known.has(c.item_hash));
  const seen = eligible.filter((c) => known.has(c.item_hash));
  const selected = [
    ...unseen.slice(0, maxNodes),
    ...seen.slice(0, Math.max(0, maxNodes - unseen.length))
  ].slice(0, maxNodes);

  const pointerRows = [];
  const created = [];
  let revisits = 0;
  for (const c of selected) {
    const knownMap = index.item_hashes[c.item_hash];
    const isRevisit = !!(knownMap && knownMap.node_id && knownMap.memory_file);
    const node = isRevisit
      ? {
          nodeId: String(knownMap.node_id),
          uid: String(knownMap.uid || ''),
          memoryPath: path.join(REPO_ROOT, String(knownMap.memory_file))
        }
      : appendNodeToMemory(dateStr, c);
    const pointer = {
      ts: nowIso(),
      date: dateStr,
      source: 'failure_memory_bridge',
      failure_kind: c.failure_kind,
      failure_tier: c.failure_tier,
      item_hash: c.item_hash,
      code: c.code,
      source_system: c.source,
      subsystem: c.subsystem,
      title: c.summary,
      details: c.details || null,
      severity: c.severity,
      risk: c.risk,
      failure_count_window: c.failure_count_window,
      total_count: c.total_count,
      node_id: node.nodeId,
      uid: node.uid,
      memory_file: path.relative(REPO_ROOT, node.memoryPath).replace(/\\/g, '/'),
      pointer_kind: isRevisit ? 'revisit' : 'new_node',
      topics: Array.isArray(c.topics) ? c.topics.slice(0, 8) : [],
      priority: c.priority
    };
    pointerRows.push(pointer);
    if (isRevisit) revisits += 1;
    else created.push(pointer);
    index.item_hashes[c.item_hash] = {
      node_id: node.nodeId,
      uid: node.uid,
      memory_file: pointer.memory_file,
      date: dateStr,
      failure_tier: c.failure_tier,
      source: c.source,
      code: c.code,
      ts: pointer.ts
    };
  }

  savePointerIndex(index);
  const pointerFile = writePointers(dateStr, pointerRows);
  const result = {
    ok: true,
    type: 'failure_memory_bridge',
    date: dateStr,
    candidates: candidates.length,
    eligible_candidates: eligible.length,
    selected: selected.length,
    created_nodes: created.length,
    revisit_pointers: revisits,
    skipped_existing: Math.max(0, eligible.length - selected.length),
    memory_file: path.relative(REPO_ROOT, path.join(MEMORY_DIR, `${dateStr}.md`)).replace(/\\/g, '/'),
    pointers_file: pointerFile ? path.relative(REPO_ROOT, pointerFile).replace(/\\/g, '/') : null,
    pointer_index: path.relative(REPO_ROOT, POINTER_INDEX_PATH).replace(/\\/g, '/'),
    max_capture_tier: MAX_CAPTURE_TIER,
    created: created.slice(0, 12)
  };

  appendJsonl(LEDGER_PATH, {
    ts: nowIso(),
    type: 'failure_memory_bridge_run',
    date: dateStr,
    candidates: result.candidates,
    eligible_candidates: result.eligible_candidates,
    selected: result.selected,
    created_nodes: result.created_nodes,
    revisit_pointers: result.revisit_pointers
  });

  recordMutationAudit('memory', {
    type: 'controller_run',
    controller: SCRIPT_SOURCE,
    operation: 'failure_memory_bridge_run',
    source: provenance.meta && provenance.meta.source || SCRIPT_SOURCE,
    reason: provenance.meta && provenance.meta.reason || 'failure_memory_bridge_run',
    provenance_ok: provenance.ok === true,
    provenance_violations: Array.isArray(provenance.violations) ? provenance.violations : [],
    files_touched: [
      result.memory_file,
      result.pointers_file,
      result.pointer_index,
      path.relative(REPO_ROOT, LEDGER_PATH).replace(/\\/g, '/')
    ].filter(Boolean),
    metrics: {
      candidates: result.candidates,
      selected: result.selected,
      created_nodes: result.created_nodes,
      revisit_pointers: result.revisit_pointers,
      max_capture_tier: MAX_CAPTURE_TIER
    }
  });

  return result;
}

function status(dateStr) {
  const index = loadPointerIndex();
  const pointerPath = path.join(POINTERS_DIR, `${dateStr}.jsonl`);
  const rows = readJsonl(pointerPath);
  return {
    ok: true,
    type: 'failure_memory_bridge_status',
    date: dateStr,
    pointers_today: rows.length,
    pointer_index_entries: Object.keys(index.item_hashes || {}).length,
    pointers_file: fs.existsSync(pointerPath)
      ? path.relative(REPO_ROOT, pointerPath).replace(/\\/g, '/')
      : null,
    max_capture_tier: MAX_CAPTURE_TIER
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    const dateStr = toDate(args._[1]);
    const maxNodes = clampInt(args['max-nodes'] == null ? DEFAULT_MAX_NODES : args['max-nodes'], 1, 20);
    process.stdout.write(JSON.stringify(runBridge(dateStr, maxNodes)) + '\n');
    return;
  }
  if (cmd === 'status') {
    const dateStr = toDate(args._[1]);
    process.stdout.write(JSON.stringify(status(dateStr)) + '\n');
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  runBridge,
  status,
  loadCandidates,
  makePainCandidate,
  makeEscalationCandidate
};

