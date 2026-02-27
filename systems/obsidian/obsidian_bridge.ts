#!/usr/bin/env node
'use strict';
export {};

/**
 * Governed Obsidian bridge (Phase 1 foundation):
 * - Contract + policy-root validation (OBS-001)
 * - Read-only ingest lane (OBS-002)
 * - Governed projection lane (OBS-003)
 * - Loop/conflict suppression + idempotent ingest receipts (OBS-004)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'obsidian_bridge_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
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
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
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

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function fileSha256(filePath: string) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolvePath(raw: unknown, fallback: string) {
  const text = cleanText(raw, 400);
  if (!text) return fallback;
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function normalizePathList(src: unknown, fallback: string[]) {
  const rows = Array.isArray(src) ? src : fallback;
  const out = new Set<string>();
  for (const row of rows) {
    const p = resolvePath(row, '');
    if (!p) continue;
    out.add(path.resolve(p));
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function withinRoot(candidate: string, root: string) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeExtList(src: unknown, fallback: string[]) {
  const rows = Array.isArray(src) ? src : fallback;
  const out = new Set<string>();
  for (const row of rows) {
    const raw = String(row || '').trim().toLowerCase();
    if (!raw) continue;
    out.add(raw.startsWith('.') ? raw : `.${raw}`);
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    vault_roots: ['memory', 'notes'],
    allowed_extensions: ['.md', '.canvas'],
    clearance: {
      ingest_min: 1,
      project_min: 2,
      project_elevated_min: 3
    },
    ingest: {
      dedupe_enabled: true,
      loop_suppression: true,
      ignore_projection_marker: true
    },
    projection: {
      projection_roots: ['state/obsidian/projections'],
      deny_user_authored_paths: true,
      allow_elevated_override: true
    },
    outputs: {
      receipts_path: 'state/obsidian/receipts.jsonl',
      ingest_path: 'state/obsidian/ingest_events.jsonl',
      latest_path: 'state/obsidian/latest.json',
      ingest_index_path: 'state/obsidian/ingest_index.json'
    }
  };
}

function loadPolicy(policyPathRaw: unknown) {
  const policyPath = resolvePath(policyPathRaw, DEFAULT_POLICY_PATH);
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const clearance = raw && raw.clearance && typeof raw.clearance === 'object' ? raw.clearance : {};
  const ingest = raw && raw.ingest && typeof raw.ingest === 'object' ? raw.ingest : {};
  const projection = raw && raw.projection && typeof raw.projection === 'object' ? raw.projection : {};
  const outputs = raw && raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const pol = {
    version: cleanText(raw.version || base.version, 40) || '1.0',
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    vault_roots: normalizePathList(raw.vault_roots, base.vault_roots),
    allowed_extensions: normalizeExtList(raw.allowed_extensions, base.allowed_extensions),
    clearance: {
      ingest_min: Number.isFinite(Number(clearance.ingest_min)) ? Math.max(0, Math.floor(Number(clearance.ingest_min))) : base.clearance.ingest_min,
      project_min: Number.isFinite(Number(clearance.project_min)) ? Math.max(0, Math.floor(Number(clearance.project_min))) : base.clearance.project_min,
      project_elevated_min: Number.isFinite(Number(clearance.project_elevated_min)) ? Math.max(0, Math.floor(Number(clearance.project_elevated_min))) : base.clearance.project_elevated_min
    },
    ingest: {
      dedupe_enabled: ingest.dedupe_enabled !== false,
      loop_suppression: ingest.loop_suppression !== false,
      ignore_projection_marker: ingest.ignore_projection_marker !== false
    },
    projection: {
      projection_roots: normalizePathList(projection.projection_roots, base.projection.projection_roots),
      deny_user_authored_paths: projection.deny_user_authored_paths !== false,
      allow_elevated_override: projection.allow_elevated_override === true
    },
    outputs: {
      receipts_path: resolvePath(outputs.receipts_path, path.join(ROOT, base.outputs.receipts_path)),
      ingest_path: resolvePath(outputs.ingest_path, path.join(ROOT, base.outputs.ingest_path)),
      latest_path: resolvePath(outputs.latest_path, path.join(ROOT, base.outputs.latest_path)),
      ingest_index_path: resolvePath(outputs.ingest_index_path, path.join(ROOT, base.outputs.ingest_index_path))
    },
    policy_path: policyPath
  };
  return pol;
}

function loadIngestIndex(indexPath: string) {
  const base = {
    schema_id: 'obsidian_ingest_index',
    schema_version: '1.0',
    updated_at: null,
    by_event_id: {}
  };
  const idx = readJson(indexPath, base);
  if (!idx || typeof idx !== 'object') return base;
  if (!idx.by_event_id || typeof idx.by_event_id !== 'object') idx.by_event_id = {};
  return idx;
}

function saveIngestIndex(indexPath: string, idx: AnyObj) {
  const out = {
    schema_id: 'obsidian_ingest_index',
    schema_version: '1.0',
    updated_at: nowIso(),
    by_event_id: idx && typeof idx.by_event_id === 'object' ? idx.by_event_id : {}
  };
  writeJsonAtomic(indexPath, out);
  return out;
}

function emitReceipt(policy: AnyObj, row: AnyObj) {
  const receipt = {
    ts: nowIso(),
    type: 'obsidian_bridge_receipt',
    ...row
  };
  appendJsonl(policy.outputs.receipts_path, receipt);
  writeJsonAtomic(policy.outputs.latest_path, {
    schema_id: 'obsidian_bridge_latest',
    schema_version: '1.0',
    updated_at: nowIso(),
    latest: receipt
  });
  return receipt;
}

function inferClearance(args: AnyObj) {
  const explicit = Number(args.clearance);
  if (Number.isFinite(explicit)) return Math.max(0, Math.floor(explicit));
  const env = Number(process.env.OBSIDIAN_CLEARANCE);
  if (Number.isFinite(env)) return Math.max(0, Math.floor(env));
  return 0;
}

function projectMarker(eventId: string, sourceTag: string) {
  return `<!-- protheus:projection event_id=${eventId} source=${normalizeToken(sourceTag || 'protheus', 80)} -->`;
}

function buildIngestEventId(fileAbs: string, action: string, st: fs.Stats | null, contentHash: string | null) {
  const seed = [
    path.relative(ROOT, fileAbs).replace(/\\/g, '/'),
    normalizeToken(action, 40),
    st ? String(st.mtimeMs) : 'na',
    st ? String(st.size) : 'na',
    contentHash || 'na'
  ].join('|');
  return `obs_ing_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}

function validateIngestTarget(policy: AnyObj, fileAbs: string) {
  const resolved = path.resolve(fileAbs);
  const ext = path.extname(resolved).toLowerCase();
  if (!policy.allowed_extensions.includes(ext)) return { ok: false, reason: 'extension_not_allowed' };
  const rootOk = policy.vault_roots.some((root: string) => withinRoot(resolved, root));
  if (!rootOk) return { ok: false, reason: 'path_outside_vault_roots' };
  return { ok: true, resolved };
}

function ingestFileChange(args: AnyObj, policy: AnyObj) {
  const clearance = inferClearance(args);
  if (clearance < policy.clearance.ingest_min) {
    return emitReceipt(policy, {
      ok: false,
      action: 'ingest',
      reason: 'clearance_below_ingest_min',
      clearance,
      required: policy.clearance.ingest_min
    });
  }
  const fileAbs = resolvePath(args.file, '');
  if (!fileAbs) {
    return emitReceipt(policy, { ok: false, action: 'ingest', reason: 'file_not_found', file: cleanText(args.file, 320) });
  }
  const action = normalizeToken(args.action || 'edit', 40) || 'edit';
  const exists = fs.existsSync(fileAbs);
  if (!exists && action !== 'delete') {
    return emitReceipt(policy, { ok: false, action: 'ingest', reason: 'file_not_found', file: cleanText(args.file, 320) });
  }
  const valid = validateIngestTarget(policy, fileAbs);
  if (!valid.ok) {
    return emitReceipt(policy, {
      ok: false,
      action: 'ingest',
      reason: valid.reason,
      file: path.relative(ROOT, fileAbs).replace(/\\/g, '/')
    });
  }
  const st = exists ? fs.statSync(valid.resolved) : null;
  const content = exists ? fs.readFileSync(valid.resolved, 'utf8') : '';
  if (exists && policy.ingest.loop_suppression && policy.ingest.ignore_projection_marker && /protheus:projection\b/i.test(content)) {
    return emitReceipt(policy, {
      ok: true,
      action: 'ingest',
      skipped: true,
      reason: 'projection_marker_loop_suppressed',
      file: path.relative(ROOT, valid.resolved).replace(/\\/g, '/')
    });
  }
  const contentHash = exists ? crypto.createHash('sha256').update(content).digest('hex') : null;
  const eventId = buildIngestEventId(valid.resolved, action, st, contentHash);
  const idx = loadIngestIndex(policy.outputs.ingest_index_path);
  if (policy.ingest.dedupe_enabled && idx.by_event_id[eventId]) {
    return emitReceipt(policy, {
      ok: true,
      action: 'ingest',
      skipped: true,
      reason: 'duplicate_event_id',
      event_id: eventId,
      file: path.relative(ROOT, valid.resolved).replace(/\\/g, '/')
    });
  }
  const row = {
    ts: nowIso(),
    schema_id: 'obsidian_ingest_event',
    schema_version: '1.0',
    event_id: eventId,
    action,
    source_tag: normalizeToken(args.source || 'obsidian_user', 60) || 'obsidian_user',
    file: path.relative(ROOT, valid.resolved).replace(/\\/g, '/'),
    ext: path.extname(valid.resolved).toLowerCase(),
    size: Number((st && st.size) || 0),
    mtime: st ? st.mtime.toISOString() : null,
    content_hash: contentHash
  };
  appendJsonl(policy.outputs.ingest_path, row);
  idx.by_event_id[eventId] = {
    ts: row.ts,
    file: row.file,
    content_hash: contentHash
  };
  saveIngestIndex(policy.outputs.ingest_index_path, idx);
  return emitReceipt(policy, {
    ok: true,
    action: 'ingest',
    event_id: eventId,
    file: row.file,
    source_tag: row.source_tag
  });
}

function validateProjectionTarget(policy: AnyObj, targetAbs: string, elevated: boolean) {
  const resolved = path.resolve(targetAbs);
  const insideProjection = policy.projection.projection_roots.some((root: string) => withinRoot(resolved, root));
  if (insideProjection) return { ok: true, resolved, elevated_used: false };
  if (policy.projection.deny_user_authored_paths !== true) return { ok: true, resolved, elevated_used: false };
  if (elevated !== true) return { ok: false, reason: 'projection_target_denied' };
  if (policy.projection.allow_elevated_override !== true) return { ok: false, reason: 'elevated_override_disabled' };
  return { ok: true, resolved, elevated_used: true };
}

function projectMarkdown(args: AnyObj, policy: AnyObj) {
  const clearance = inferClearance(args);
  const elevated = toBool(args.elevated, false);
  const required = elevated ? policy.clearance.project_elevated_min : policy.clearance.project_min;
  if (clearance < required) {
    return emitReceipt(policy, {
      ok: false,
      action: 'project',
      reason: 'clearance_below_project_min',
      clearance,
      required
    });
  }
  const title = cleanText(args.title || 'Projection', 180) || 'Projection';
  const kind = normalizeToken(args.kind || 'summary', 40) || 'summary';
  let body = cleanText(args.content || '', 120000);
  const contentFile = resolvePath(args['content-file'] || args.content_file, '');
  if (!body && contentFile && fs.existsSync(contentFile)) body = cleanText(fs.readFileSync(contentFile, 'utf8'), 120000);
  if (!body) {
    return emitReceipt(policy, { ok: false, action: 'project', reason: 'content_missing' });
  }
  const defaultName = `${normalizeToken(kind, 40) || 'projection'}-${Date.now()}.md`;
  const targetRaw = cleanText(args.target || '', 400) || defaultName;
  const targetAbs = path.isAbsolute(targetRaw)
    ? targetRaw
    : path.join(policy.projection.projection_roots[0] || path.join(ROOT, 'state', 'obsidian', 'projections'), targetRaw);
  const valid = validateProjectionTarget(policy, targetAbs, elevated);
  if (!valid.ok) {
    return emitReceipt(policy, {
      ok: false,
      action: 'project',
      reason: valid.reason,
      target: path.relative(ROOT, targetAbs).replace(/\\/g, '/')
    });
  }
  const eventId = `obs_proj_${crypto.createHash('sha1').update(`${title}|${Date.now()}|${targetAbs}`).digest('hex').slice(0, 12)}`;
  const lines = [
    projectMarker(eventId, args.source || 'protheus_projection'),
    `# ${title}`,
    '',
    body
  ];
  ensureDir(path.dirname(valid.resolved));
  fs.writeFileSync(valid.resolved, `${lines.join('\n')}\n`, 'utf8');
  const rel = path.relative(ROOT, valid.resolved).replace(/\\/g, '/');
  return emitReceipt(policy, {
    ok: true,
    action: 'project',
    event_id: eventId,
    target: rel,
    elevated_used: valid.elevated_used === true,
    shadow_only: policy.shadow_only === true,
    kind
  });
}

function status(policy: AnyObj) {
  const latest = readJson(policy.outputs.latest_path, null);
  const ingestIndex = loadIngestIndex(policy.outputs.ingest_index_path);
  return {
    ok: true,
    type: 'obsidian_bridge_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      path: path.relative(ROOT, policy.policy_path).replace(/\\/g, '/'),
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true
    },
    vault_roots: policy.vault_roots.map((p: string) => path.relative(ROOT, p).replace(/\\/g, '/')),
    projection_roots: policy.projection.projection_roots.map((p: string) => path.relative(ROOT, p).replace(/\\/g, '/')),
    ingest_events_seen: Object.keys(ingestIndex.by_event_id || {}).length,
    latest: latest && latest.latest ? latest.latest : null,
    outputs: {
      receipts_path: path.relative(ROOT, policy.outputs.receipts_path).replace(/\\/g, '/'),
      ingest_path: path.relative(ROOT, policy.outputs.ingest_path).replace(/\\/g, '/'),
      latest_path: path.relative(ROOT, policy.outputs.latest_path).replace(/\\/g, '/')
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/obsidian/obsidian_bridge.js status [--policy=path]');
  console.log('  node systems/obsidian/obsidian_bridge.js ingest --file=path [--action=edit] [--source=obsidian_user] [--policy=path]');
  console.log('  node systems/obsidian/obsidian_bridge.js project --title=\"...\" [--content=\"...\"] [--content-file=path] [--target=path] [--kind=summary] [--elevated=1] [--policy=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  const policy = loadPolicy(args.policy || process.env.OBSIDIAN_BRIDGE_POLICY);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'obsidian_bridge',
      error: 'bridge_disabled'
    })}\n`);
    process.exit(1);
  }
  let out: AnyObj;
  if (cmd === 'status') out = status(policy);
  else if (cmd === 'ingest') out = ingestFileChange(args, policy);
  else if (cmd === 'project') out = projectMarkdown(args, policy);
  else {
    out = { ok: false, type: 'obsidian_bridge', error: `unknown_command:${cmd}` };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out && out.ok === false) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  ingestFileChange,
  projectMarkdown,
  status
};
