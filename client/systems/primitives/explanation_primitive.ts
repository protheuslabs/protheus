#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { verifyCanonicalEvents } = require('./canonical_event_log.js');
const { appendAction } = require('../security/agent_passport.js');

type AnyObj = Record<string, any>;

type EventRef = {
  event_id: string,
  ts: string,
  seq: number,
  type: string,
  hash: string | null,
  prev_hash: string | null,
  log_path: string,
  payload: AnyObj
};

const ROOT = process.env.EXPLANATION_PRIMITIVE_ROOT
  ? path.resolve(process.env.EXPLANATION_PRIMITIVE_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.EXPLANATION_PRIMITIVE_POLICY_PATH
  ? path.resolve(process.env.EXPLANATION_PRIMITIVE_POLICY_PATH)
  : path.join(ROOT, 'config', 'explanation_primitive_policy.json');

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

function normalizeUpperToken(v: unknown, maxLen = 120) {
  return normalizeToken(v, maxLen).toUpperCase();
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/primitives/explanation_primitive.js explain --event-id=<id|latest> --category=<major_decision|policy_denial|self_modification> --summary="<text>" [--narrative="<text>"] [--decision=<allow|deny|propose>] [--objective-id=<id>] [--proof-link=<uri[,uri]>] [--apply=1|0]');
  console.log('  node systems/primitives/explanation_primitive.js verify --explanation-id=<id> [--strict=1|0]');
  console.log('  node systems/primitives/explanation_primitive.js status');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
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

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown) {
  const token = cleanText(raw || '', 500);
  if (!token) return ROOT;
  return path.isAbsolute(token) ? token : path.join(ROOT, token);
}

function stableStringify(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const obj = value as AnyObj;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function shaHex(value: unknown) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function sha16(value: unknown) {
  return shaHex(value).slice(0, 16);
}

function defaultPolicy() {
  return {
    schema_id: 'explanation_primitive_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: false,
    require_event_id: true,
    require_proof_links: true,
    require_event_replayable: true,
    allow_latest_pointer: true,
    max_narrative_chars: 2000,
    max_summary_chars: 320,
    allowed_categories: ['major_decision', 'policy_denial', 'self_modification'],
    passport_export: {
      enabled: true,
      source: 'explanation_primitive'
    },
    paths: {
      canonical_events: 'state/runtime/canonical_events',
      causal_graph_state: 'state/memory/causal_temporal_graph/state.json',
      index_path: 'state/primitives/explanation_primitive/index.json',
      latest_path: 'state/primitives/explanation_primitive/latest.json',
      artifacts_dir: 'state/primitives/explanation_primitive/artifacts',
      receipts_path: 'state/primitives/explanation_primitive/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const pathsRaw = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const passportRaw = raw.passport_export && typeof raw.passport_export === 'object' ? raw.passport_export : {};
  const allowedRaw = Array.isArray(raw.allowed_categories) ? raw.allowed_categories : base.allowed_categories;
  const allowedCategories = Array.from(new Set(allowedRaw.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)));
  return {
    schema_id: 'explanation_primitive_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    require_event_id: toBool(raw.require_event_id, base.require_event_id),
    require_proof_links: toBool(raw.require_proof_links, base.require_proof_links),
    require_event_replayable: toBool(raw.require_event_replayable, base.require_event_replayable),
    allow_latest_pointer: raw.allow_latest_pointer !== false,
    max_narrative_chars: clampInt(raw.max_narrative_chars, 64, 100000, base.max_narrative_chars),
    max_summary_chars: clampInt(raw.max_summary_chars, 32, 5000, base.max_summary_chars),
    allowed_categories: allowedCategories.length ? allowedCategories : base.allowed_categories.slice(0),
    passport_export: {
      enabled: passportRaw.enabled !== false,
      source: normalizeToken(passportRaw.source || base.passport_export.source, 80) || base.passport_export.source
    },
    paths: {
      canonical_events: resolvePath(pathsRaw.canonical_events || base.paths.canonical_events),
      causal_graph_state: resolvePath(pathsRaw.causal_graph_state || base.paths.causal_graph_state),
      index_path: resolvePath(pathsRaw.index_path || base.paths.index_path),
      latest_path: resolvePath(pathsRaw.latest_path || base.paths.latest_path),
      artifacts_dir: resolvePath(pathsRaw.artifacts_dir || base.paths.artifacts_dir),
      receipts_path: resolvePath(pathsRaw.receipts_path || base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function initIndex() {
  return {
    schema_id: 'explanation_primitive_index',
    schema_version: '1.0',
    created_at: nowIso(),
    updated_at: nowIso(),
    explanations: []
  };
}

function loadIndex(policy: AnyObj) {
  const raw = readJson(policy.paths.index_path, null);
  if (!raw || typeof raw !== 'object') return initIndex();
  return {
    schema_id: 'explanation_primitive_index',
    schema_version: '1.0',
    created_at: cleanText(raw.created_at || nowIso(), 40) || nowIso(),
    updated_at: cleanText(raw.updated_at || nowIso(), 40) || nowIso(),
    explanations: Array.isArray(raw.explanations) ? raw.explanations : []
  };
}

function saveIndex(policy: AnyObj, index: AnyObj) {
  writeJsonAtomic(policy.paths.index_path, {
    ...index,
    updated_at: nowIso()
  });
}

function eventFiles(eventsRoot: string) {
  if (!fs.existsSync(eventsRoot)) return [];
  const st = fs.statSync(eventsRoot);
  if (st.isFile() && eventsRoot.endsWith('.jsonl')) return [eventsRoot];
  if (!st.isDirectory()) return [];
  return fs.readdirSync(eventsRoot)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(eventsRoot, name))
    .filter((absPath) => {
      try { return fs.statSync(absPath).isFile(); } catch { return false; }
    })
    .sort((a, b) => a.localeCompare(b));
}

function latestEventId(eventsRoot: string) {
  const latestPath = path.join(eventsRoot, 'latest.json');
  const latest = readJson(latestPath, {});
  const eventId = cleanText(latest.event_id || '', 120);
  if (eventId) return eventId;
  const files = eventFiles(eventsRoot);
  if (!files.length) return null;
  const lastFile = files[files.length - 1];
  const rows = readJsonl(lastFile);
  if (!rows.length) return null;
  return cleanText(rows[rows.length - 1].event_id || '', 120) || null;
}

function findEventById(eventsRoot: string, eventIdRaw: unknown): EventRef | null {
  const target = cleanText(eventIdRaw || '', 120);
  if (!target) return null;
  const files = eventFiles(eventsRoot);
  for (const filePath of files) {
    const rows = readJsonl(filePath);
    for (const row of rows) {
      const eventId = cleanText(row && row.event_id || '', 120);
      if (eventId !== target) continue;
      return {
        event_id: eventId,
        ts: cleanText(row.ts || '', 40) || nowIso(),
        seq: clampInt(row.seq, 0, 1_000_000_000, 0),
        type: normalizeToken(row.type || 'runtime_event', 80) || 'runtime_event',
        hash: cleanText(row.hash || '', 80) || null,
        prev_hash: cleanText(row.prev_hash || '', 80) || null,
        log_path: rel(filePath),
        payload: row.payload && typeof row.payload === 'object' ? row.payload : {}
      };
    }
  }
  return null;
}

function readCausalSummary(causalStatePath: string, eventId: string) {
  const state = readJson(causalStatePath, {});
  const edges = Array.isArray(state.edges) ? state.edges : [];
  const inbound = edges.filter((edge: AnyObj) => cleanText(edge.target_event_id || '', 120) === eventId);
  const outbound = edges.filter((edge: AnyObj) => cleanText(edge.source_event_id || '', 120) === eventId);
  return {
    state_path: rel(causalStatePath),
    event_id: eventId,
    inbound_edge_count: inbound.length,
    outbound_edge_count: outbound.length,
    inbound_sources: inbound.slice(0, 50).map((edge: AnyObj) => cleanText(edge.source_event_id || '', 120)).filter(Boolean),
    outbound_targets: outbound.slice(0, 50).map((edge: AnyObj) => cleanText(edge.target_event_id || '', 120)).filter(Boolean)
  };
}

function parseProofLinks(args: AnyObj) {
  const rows: AnyObj[] = [];
  const raw = cleanText(args['proof-link'] || args.proof_link || '', 2000);
  if (!raw) return rows;
  const parts = raw.split(',').map((row) => cleanText(row, 500)).filter(Boolean);
  for (const part of parts) {
    rows.push({
      kind: 'external',
      ref: part,
      hash: shaHex({ ref: part })
    });
  }
  return rows;
}

function writeArtifact(policy: AnyObj, explanationId: string, artifact: AnyObj) {
  const outPath = path.join(policy.paths.artifacts_dir, `${explanationId}.json`);
  if (policy.shadow_only !== true) writeJsonAtomic(outPath, artifact);
  return outPath;
}

function emitReceipt(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    ...row
  });
}

function maybePassportExport(policy: AnyObj, artifact: AnyObj, artifactPath: string, reason: string) {
  if (policy.passport_export.enabled !== true) {
    return {
      linked: false,
      reason: 'passport_export_disabled'
    };
  }
  const appendRes = appendAction({
    source: policy.passport_export.source || 'explanation_primitive',
    action: {
      action_type: 'explanation_artifact',
      objective_id: artifact.objective_id || null,
      target: artifact.summary || artifact.explanation_id,
      status: artifact.verification && artifact.verification.ok === true ? 'verified' : 'generated',
      attempted: true,
      verified: artifact.verification && artifact.verification.ok === true,
      receipt_path: rel(artifactPath),
      receipt_id: artifact.explanation_id,
      receipt_hash: artifact.artifact_hash,
      metadata: {
        category: artifact.category,
        reason
      }
    }
  });
  return {
    linked: appendRes && appendRes.ok === true,
    append_result: appendRes
  };
}

function cmdExplain(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'explanation_primitive_explain', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const apply = toBool(args.apply, true);
  const category = normalizeToken(args.category || 'major_decision', 80) || 'major_decision';
  if (!policy.allowed_categories.includes(category)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'explanation_primitive_explain', error: 'category_not_allowed', category, allowed_categories: policy.allowed_categories })}\n`);
    process.exit(1);
  }

  let eventId = cleanText(args['event-id'] || args.event_id || '', 120);
  if (!eventId && policy.allow_latest_pointer === true) {
    eventId = String(latestEventId(policy.paths.canonical_events) || '');
  }
  if (policy.require_event_id === true && !eventId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'explanation_primitive_explain', error: 'event_id_required' })}\n`);
    process.exit(1);
  }

  const eventRef = eventId ? findEventById(policy.paths.canonical_events, eventId) : null;
  if (eventId && !eventRef) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'explanation_primitive_explain', error: 'event_not_found', event_id: eventId })}\n`);
    process.exit(1);
  }

  const summary = cleanText(args.summary || args.reason || '', policy.max_summary_chars);
  if (!summary) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'explanation_primitive_explain', error: 'summary_required' })}\n`);
    process.exit(1);
  }
  const narrative = cleanText(args.narrative || summary, policy.max_narrative_chars) || summary;
  const decision = normalizeToken(args.decision || '', 32) || null;
  const objectiveId = normalizeToken(args['objective-id'] || args.objective_id || '', 180) || null;

  const canonicalVerify = verifyCanonicalEvents(policy.paths.canonical_events);
  const replayable = canonicalVerify && canonicalVerify.ok === true;
  if (policy.require_event_replayable === true && replayable !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'explanation_primitive_explain', error: 'canonical_events_not_replayable', canonical_verify: canonicalVerify })}\n`);
    process.exit(1);
  }

  const externalProofLinks = parseProofLinks(args);
  const causalSummary = eventRef
    ? readCausalSummary(policy.paths.causal_graph_state, eventRef.event_id)
    : null;

  const explanationId = `exp_${sha16(`${nowIso()}|${eventRef && eventRef.event_id || 'none'}|${summary}|${Math.random()}`)}`;
  const proofLinks = [
    {
      kind: 'canonical_event',
      event_id: eventRef && eventRef.event_id || null,
      log_path: eventRef && eventRef.log_path || null,
      hash: eventRef && eventRef.hash || null,
      prev_hash: eventRef && eventRef.prev_hash || null,
      seq: eventRef && eventRef.seq || null
    },
    {
      kind: 'canonical_chain_verify',
      log_path: rel(policy.paths.canonical_events),
      ok: canonicalVerify && canonicalVerify.ok === true,
      checked_files: canonicalVerify && canonicalVerify.checked_files || [],
      total_events: canonicalVerify && canonicalVerify.total_events || 0,
      last_hash: canonicalVerify && canonicalVerify.last_hash || null,
      failure_count: Array.isArray(canonicalVerify && canonicalVerify.failures) ? canonicalVerify.failures.length : 0
    }
  ];
  if (causalSummary) {
    proofLinks.push({
      kind: 'causal_graph',
      summary: causalSummary,
      hash: shaHex(causalSummary)
    });
  }
  for (const row of externalProofLinks) proofLinks.push(row);
  if (policy.require_proof_links === true && !proofLinks.length) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'explanation_primitive_explain', error: 'proof_links_required' })}\n`);
    process.exit(1);
  }

  const artifactBase = {
    schema_id: 'explanation_artifact',
    schema_version: '1.0',
    ts: nowIso(),
    explanation_id: explanationId,
    category,
    decision,
    objective_id: objectiveId,
    summary,
    narrative,
    event_ref: eventRef,
    proof_links: proofLinks,
    replay_hints: {
      canonical_events_path: rel(policy.paths.canonical_events),
      causal_graph_state_path: rel(policy.paths.causal_graph_state),
      replay_command: `node systems/primitives/canonical_event_log.js verify --target=${rel(policy.paths.canonical_events)}`,
      why_command: eventRef ? `node systems/memory/causal_temporal_graph.js query --mode=why --event-id=${eventRef.event_id}` : null
    },
    machine_verification: {
      canonical_events_replayable: replayable,
      canonical_event_hash: eventRef && eventRef.hash || null,
      proof_link_count: proofLinks.length
    }
  };

  const artifactHash = shaHex(artifactBase);
  const artifact = {
    ...artifactBase,
    artifact_hash: artifactHash,
    verification: {
      ok: replayable,
      checks: {
        canonical_events_replayable: replayable,
        event_ref_present: eventRef != null,
        proof_links_present: proofLinks.length > 0
      }
    }
  };

  const index = loadIndex(policy);
  const artifactPath = writeArtifact(policy, explanationId, artifact);
  const indexRow = {
    explanation_id: explanationId,
    ts: artifact.ts,
    category,
    objective_id: objectiveId,
    event_id: eventRef && eventRef.event_id || null,
    artifact_hash: artifactHash,
    artifact_path: rel(artifactPath)
  };
  if (apply && policy.shadow_only !== true) {
    index.explanations.push(indexRow);
    if (index.explanations.length > 10000) index.explanations = index.explanations.slice(index.explanations.length - 10000);
    saveIndex(policy, index);
  }

  const passportExport = maybePassportExport(policy, artifact, artifactPath, 'explain');

  const out = {
    ok: true,
    type: 'explanation_primitive_explain',
    explanation_id: explanationId,
    category,
    event_id: eventRef && eventRef.event_id || null,
    artifact_hash: artifactHash,
    artifact_path: rel(artifactPath),
    apply: apply === true,
    shadow_only: policy.shadow_only === true,
    passport_export: passportExport,
    verification: artifact.verification,
    policy_path: rel(policy.policy_path)
  };

  emitReceipt(policy, out);
  writeJsonAtomic(policy.paths.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function readArtifactById(policy: AnyObj, explanationIdRaw: unknown) {
  const explanationId = normalizeToken(explanationIdRaw || '', 120);
  if (!explanationId) return null;
  const artifactPath = path.join(policy.paths.artifacts_dir, `${explanationId}.json`);
  if (!fs.existsSync(artifactPath)) return null;
  const artifact = readJson(artifactPath, null);
  if (!artifact || typeof artifact !== 'object') return null;
  return { artifactPath, artifact };
}

function cmdVerify(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, false);
  const explanationId = cleanText(args['explanation-id'] || args.explanation_id || '', 120);
  if (!explanationId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'explanation_primitive_verify', error: 'explanation_id_required' })}\n`);
    process.exit(1);
  }
  const loaded = readArtifactById(policy, explanationId);
  if (!loaded) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'explanation_primitive_verify', error: 'artifact_not_found', explanation_id: explanationId })}\n`);
    process.exit(1);
  }

  const artifact = loaded.artifact;
  const artifactPath = loaded.artifactPath;
  const artifactBase = { ...artifact };
  delete artifactBase.artifact_hash;
  delete artifactBase.verification;
  const recomputedHash = shaHex(artifactBase);
  const eventId = cleanText(artifact.event_ref && artifact.event_ref.event_id || '', 120);
  const eventRef = eventId ? findEventById(policy.paths.canonical_events, eventId) : null;
  const canonicalVerify = verifyCanonicalEvents(policy.paths.canonical_events);
  const ok = String(artifact.artifact_hash || '') === recomputedHash
    && (!eventId || !!eventRef)
    && (!policy.require_event_replayable || canonicalVerify.ok === true);

  const out = {
    ok,
    type: 'explanation_primitive_verify',
    explanation_id: explanationId,
    artifact_path: rel(artifactPath),
    hash_match: String(artifact.artifact_hash || '') === recomputedHash,
    event_ref_ok: eventId ? !!eventRef : true,
    canonical_events_replayable: canonicalVerify.ok === true,
    strict,
    policy_path: rel(policy.policy_path)
  };

  emitReceipt(policy, out);
  writeJsonAtomic(policy.paths.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const index = loadIndex(policy);
  const latest = readJson(policy.paths.latest_path, null);
  const files = fs.existsSync(policy.paths.artifacts_dir)
    ? fs.readdirSync(policy.paths.artifacts_dir).filter((name) => name.endsWith('.json'))
    : [];
  const out = {
    ok: true,
    type: 'explanation_primitive_status',
    ts: nowIso(),
    policy: {
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      require_event_id: policy.require_event_id === true,
      require_proof_links: policy.require_proof_links === true,
      require_event_replayable: policy.require_event_replayable === true,
      passport_export_enabled: policy.passport_export.enabled === true,
      path: rel(policy.policy_path)
    },
    counts: {
      index_entries: Array.isArray(index.explanations) ? index.explanations.length : 0,
      artifact_files: files.length
    },
    latest,
    paths: {
      canonical_events: rel(policy.paths.canonical_events),
      causal_graph_state: rel(policy.paths.causal_graph_state),
      index_path: rel(policy.paths.index_path),
      artifacts_dir: rel(policy.paths.artifacts_dir),
      receipts_path: rel(policy.paths.receipts_path)
    }
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 60);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'explain') return cmdExplain(args);
  if (cmd === 'verify') return cmdVerify(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  cmdExplain,
  cmdVerify,
  cmdStatus
};
