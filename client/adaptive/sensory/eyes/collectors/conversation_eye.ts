/**
 * adaptive/sensory/eyes/collectors/conversation_eye.ts
 *
 * Conversation Eye
 * - Ingests cockpit envelope history (push context).
 * - Synthesizes dialogue/decision insights into tagged memory nodes.
 * - Emits external_eyes-compatible signal items.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { synthesizeEnvelope } = require('../../../../systems/sensory/conversation_eye_synthesizer');

const WORKSPACE_DIR = path.join(__dirname, '..', '..', '..', '..');
const DEFAULT_HISTORY_PATH = process.env.CONVERSATION_EYE_HISTORY_PATH
  ? path.resolve(process.env.CONVERSATION_EYE_HISTORY_PATH)
  : path.join(WORKSPACE_DIR, 'local', 'state', 'cockpit', 'inbox', 'history.jsonl');
const DEFAULT_LATEST_PATH = process.env.CONVERSATION_EYE_LATEST_PATH
  ? path.resolve(process.env.CONVERSATION_EYE_LATEST_PATH)
  : path.join(WORKSPACE_DIR, 'local', 'state', 'cockpit', 'inbox', 'latest.json');
const CONVERSATION_MEMORY_DIR = process.env.CONVERSATION_EYE_MEMORY_DIR
  ? path.resolve(process.env.CONVERSATION_EYE_MEMORY_DIR)
  : path.join(WORKSPACE_DIR, 'local', 'state', 'memory', 'conversation_eye');
const CONVERSATION_MEMORY_JSONL = path.join(CONVERSATION_MEMORY_DIR, 'nodes.jsonl');
const CONVERSATION_MEMORY_INDEX = path.join(CONVERSATION_MEMORY_DIR, 'index.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function sha16(v) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, 16);
}

function ensureDir(absDir) {
  fs.mkdirSync(absDir, { recursive: true });
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonlTail(filePath, maxLines = 64) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(Math.max(0, lines.length - Math.max(1, Number(maxLines) || 64)));
  const out = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // malformed lines are skipped; collector remains fail-soft.
    }
  }
  return out;
}

function loadMemoryIndex() {
  const base = readJsonSafe(CONVERSATION_MEMORY_INDEX, {
    version: '1.0',
    updated_ts: null,
    emitted_node_ids: {}
  });
  if (!base || typeof base !== 'object') {
    return { version: '1.0', updated_ts: null, emitted_node_ids: {} };
  }
  if (!base.emitted_node_ids || typeof base.emitted_node_ids !== 'object') {
    base.emitted_node_ids = {};
  }
  return base;
}

function saveMemoryIndex(index) {
  ensureDir(CONVERSATION_MEMORY_DIR);
  const out = {
    version: '1.0',
    updated_ts: nowIso(),
    emitted_node_ids: index && typeof index.emitted_node_ids === 'object'
      ? index.emitted_node_ids
      : {}
  };
  fs.writeFileSync(CONVERSATION_MEMORY_INDEX, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

function appendMemoryNode(row) {
  ensureDir(CONVERSATION_MEMORY_DIR);
  fs.appendFileSync(CONVERSATION_MEMORY_JSONL, `${JSON.stringify(row)}\n`, 'utf8');
}

function normalizeTopics(eyeConfig) {
  const defaults = ['conversation', 'decision', 'insight', 'directive', 't1'];
  const topics = Array.isArray(eyeConfig && eyeConfig.topics) ? eyeConfig.topics : [];
  const out = [];
  for (const raw of defaults.concat(topics)) {
    const value = cleanText(raw, 48).toLowerCase();
    if (!value) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out.slice(0, 8);
}

function synthesizeFromSource(maxRows) {
  const historyRows = readJsonlTail(DEFAULT_HISTORY_PATH, maxRows);
  if (historyRows.length > 0) return historyRows;
  const latest = readJsonSafe(DEFAULT_LATEST_PATH, null);
  return latest && typeof latest === 'object' ? [latest] : [];
}

function toCollectItem(node, topics) {
  const date = cleanText(node && node.date, 20) || nowIso().slice(0, 10);
  const nodeId = cleanText(node && node.node_id, 80) || `conversation-eye-${sha16(`${date}|fallback`)}`;
  const url = `https://local.workspace/conversation/${date}/${nodeId}`;
  const title = cleanText(node && node.title, 180) || '[Conversation Eye] synthesized signal';
  const preview = cleanText(node && node.preview, 240) || 'conversation_eye synthesized runtime node';
  return {
    collected_at: nowIso(),
    id: sha16(`${nodeId}|${title}`),
    url,
    title,
    content_preview: preview,
    topics,
    node_id: nodeId,
    node_kind: cleanText(node && node.node_kind, 32) || 'insight',
    node_tags: Array.isArray(node && node.node_tags) ? node.node_tags.slice(0, 12) : ['conversation', 'decision', 'insight', 'directive', 't1'],
    edges_to: Array.isArray(node && node.edges_to) ? node.edges_to.slice(0, 12) : [],
    bytes: Math.min(8192, title.length + preview.length + 160)
  };
}

function preflightConversationEye(eyeConfig, budgets) {
  const checks = [];
  const failures = [];
  const maxItems = Number(budgets && budgets.max_items);
  if (!Number.isFinite(maxItems) || maxItems <= 0) {
    failures.push({ code: 'invalid_budget', message: 'budgets.max_items must be > 0' });
  } else {
    checks.push({ name: 'max_items_valid', ok: true, value: maxItems });
  }

  const historyExists = fs.existsSync(DEFAULT_HISTORY_PATH);
  const latestExists = fs.existsSync(DEFAULT_LATEST_PATH);
  if (!historyExists && !latestExists) {
    failures.push({
      code: 'conversation_source_missing',
      message: `missing cockpit context source (${DEFAULT_HISTORY_PATH} or ${DEFAULT_LATEST_PATH})`
    });
  } else {
    checks.push({
      name: 'cockpit_source_present',
      ok: true,
      history_path: DEFAULT_HISTORY_PATH,
      latest_path: DEFAULT_LATEST_PATH
    });
  }

  return {
    ok: failures.length === 0,
    parser_type: 'conversation_eye',
    checks,
    failures
  };
}

async function collectConversationEye(eyeConfig, budgets) {
  const started = Date.now();
  const preflight = preflightConversationEye(eyeConfig, budgets);
  if (!preflight.ok) {
    const first = preflight.failures[0] || {};
    const err = new Error(`conversation_eye_preflight_failed (${cleanText(first.message || 'unknown', 160)})`);
    err.code = String(first.code || 'conversation_eye_preflight_failed');
    throw err;
  }

  const maxItems = Math.max(1, Math.min(Number((budgets && budgets.max_items) || 6), 32));
  const maxRows = Math.max(4, Math.min(Number((budgets && budgets.max_rows) || 96), 500));
  const topics = normalizeTopics(eyeConfig);
  const sourceRows = synthesizeFromSource(maxRows);
  const index = loadMemoryIndex();
  const emitted = index.emitted_node_ids || {};
  const items = [];
  let nodeWrites = 0;

  for (let i = sourceRows.length - 1; i >= 0; i -= 1) {
    const row = sourceRows[i];
    const node = synthesizeEnvelope(row);
    if (!node || !node.node_id) continue;
    if (emitted[node.node_id]) continue;
    emitted[node.node_id] = nowIso();
    appendMemoryNode({
      ts: nowIso(),
      source: 'conversation_eye',
      node_id: node.node_id,
      node_kind: node.node_kind,
      tags: Array.isArray(node.node_tags) ? node.node_tags : ['conversation', 'decision', 'insight', 'directive', 't1'],
      edges_to: Array.isArray(node.edges_to) ? node.edges_to : [],
      title: node.title,
      preview: node.preview
    });
    nodeWrites += 1;
    items.push(toCollectItem(node, topics));
    if (items.length >= maxItems) break;
  }

  index.emitted_node_ids = emitted;
  saveMemoryIndex(index);

  return {
    success: true,
    items,
    duration_ms: Date.now() - started,
    requests: 0,
    bytes: items.reduce((sum, item) => sum + Number(item && item.bytes || 0), 0),
    metadata: {
      node_writes: nodeWrites,
      source_rows_seen: sourceRows.length
    }
  };
}

module.exports = {
  collectConversationEye,
  preflightConversationEye
};
