#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = process.env.GROUP_EVOLVING_AGENTS_ROOT
  ? path.resolve(process.env.GROUP_EVOLVING_AGENTS_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.GROUP_EVOLVING_AGENTS_POLICY_PATH
  ? path.resolve(process.env.GROUP_EVOLVING_AGENTS_POLICY_PATH)
  : path.join(ROOT, 'config', 'group_evolving_agents_primitive_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
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
  console.log('  node systems/assimilation/group_evolving_agents_primitive.js run --input-json="{...}" [--policy=<path>] [--apply=1|0]');
  console.log('  node systems/assimilation/group_evolving_agents_primitive.js status [--policy=<path>] [--capability-id=<id>]');
  console.log('  node systems/assimilation/group_evolving_agents_primitive.js export-archive [--policy=<path>] [--opt-in=1|0] [--capability-id=<id>] [--peer-id=<id>] [--attestation-score=0..1]');
  console.log('  node systems/assimilation/group_evolving_agents_primitive.js import-archive --file=<path> [--policy=<path>] [--opt-in=1|0]');
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

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || fallbackRel, 500);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function parseJsonArg(raw: unknown, fallback: any = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function hashJson(value: AnyObj) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function defaultPolicy() {
  return {
    schema_id: 'group_evolving_agents_primitive_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: true,
    sharing: {
      max_peer_experiences: 48,
      min_reuse_confidence: 0.55,
      innovation_bonus: 0.22
    },
    trust: {
      min_peer_trust: 0.35,
      trust_decay: 0.97,
      trust_gain: 0.04,
      trust_penalty: 0.08
    },
    federation: {
      enabled: true,
      opt_in_required: true,
      local_instance_id: 'local_instance',
      max_export_capabilities: 32,
      max_import_capabilities: 64,
      min_attestation_score: 0.55,
      import_trust_gain: 0.03,
      import_trust_penalty: 0.05,
      archive_dir: 'state/assimilation/group_evolving_agents/federation'
    },
    state: {
      pool_path: 'state/assimilation/group_evolving_agents/pool.json',
      latest_path: 'state/assimilation/group_evolving_agents/latest.json',
      receipts_path: 'state/assimilation/group_evolving_agents/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const sharing = raw.sharing && typeof raw.sharing === 'object' ? raw.sharing : {};
  const trust = raw.trust && typeof raw.trust === 'object' ? raw.trust : {};
  const federation = raw.federation && typeof raw.federation === 'object' ? raw.federation : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    schema_id: base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    sharing: {
      max_peer_experiences: clampInt(sharing.max_peer_experiences, 1, 5000, base.sharing.max_peer_experiences),
      min_reuse_confidence: clampNumber(
        sharing.min_reuse_confidence,
        0,
        1,
        base.sharing.min_reuse_confidence
      ),
      innovation_bonus: clampNumber(sharing.innovation_bonus, 0, 1, base.sharing.innovation_bonus)
    },
    trust: {
      min_peer_trust: clampNumber(trust.min_peer_trust, 0, 1, base.trust.min_peer_trust),
      trust_decay: clampNumber(trust.trust_decay, 0, 1, base.trust.trust_decay),
      trust_gain: clampNumber(trust.trust_gain, 0, 1, base.trust.trust_gain),
      trust_penalty: clampNumber(trust.trust_penalty, 0, 1, base.trust.trust_penalty)
    },
    federation: {
      enabled: federation.enabled !== false,
      opt_in_required: federation.opt_in_required !== false,
      local_instance_id: normalizeToken(
        federation.local_instance_id || base.federation.local_instance_id,
        120
      ) || base.federation.local_instance_id,
      max_export_capabilities: clampInt(
        federation.max_export_capabilities,
        1,
        10000,
        base.federation.max_export_capabilities
      ),
      max_import_capabilities: clampInt(
        federation.max_import_capabilities,
        1,
        10000,
        base.federation.max_import_capabilities
      ),
      min_attestation_score: clampNumber(
        federation.min_attestation_score,
        0,
        1,
        base.federation.min_attestation_score
      ),
      import_trust_gain: clampNumber(
        federation.import_trust_gain,
        0,
        1,
        base.federation.import_trust_gain
      ),
      import_trust_penalty: clampNumber(
        federation.import_trust_penalty,
        0,
        1,
        base.federation.import_trust_penalty
      ),
      archive_dir: resolvePath(
        federation.archive_dir || base.federation.archive_dir,
        base.federation.archive_dir
      )
    },
    state: {
      pool_path: resolvePath(state.pool_path || base.state.pool_path, base.state.pool_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadPool(filePath: string) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      schema_id: 'group_evolving_agents_pool',
      schema_version: '1.0',
      updated_at: null,
      capabilities: {},
      peer_trust: {}
    };
  }
  return {
    schema_id: 'group_evolving_agents_pool',
    schema_version: '1.0',
    updated_at: payload.updated_at ? String(payload.updated_at) : null,
    capabilities: payload.capabilities && typeof payload.capabilities === 'object' ? payload.capabilities : {},
    peer_trust: payload.peer_trust && typeof payload.peer_trust === 'object' ? payload.peer_trust : {}
  };
}

function runGroupEvolvingAgents(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(opts.policyPath || opts.policy_path || DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'group_evolving_agents_primitive',
      error: 'policy_disabled'
    };
  }

  const ts = nowIso();
  const apply = toBool(opts.apply, false);
  const capabilityId = normalizeToken(inputRaw.capability_id || '', 160) || 'unknown_capability';
  const localAgentId = normalizeToken(inputRaw.agent_id || 'assimilation_controller', 120) || 'assimilation_controller';

  const experiences = (Array.isArray(inputRaw.experiences) ? inputRaw.experiences : [])
    .slice(0, Number(policy.sharing.max_peer_experiences || 48))
    .map((row: AnyObj, idx: number) => ({
      peer_id: normalizeToken(row && row.peer_id || row && row.agent_id || `peer_${idx + 1}`, 120),
      innovation_id: normalizeToken(row && row.innovation_id || row && row.recommendation || `innovation_${idx + 1}`, 140),
      confidence: clampNumber(row && row.confidence, 0, 1, 0.5),
      adopted: row && row.adopted === true,
      outcome: normalizeToken(row && row.outcome || row && row.recommendation || 'unknown', 80)
    }))
    .filter((row: AnyObj) => row.peer_id && row.innovation_id);

  const pool = loadPool(policy.state.pool_path);
  if (!pool.capabilities[capabilityId]) {
    pool.capabilities[capabilityId] = {
      innovations: {},
      reuse_count: 0,
      total_observations: 0,
      updated_at: null
    };
  }
  const capState = pool.capabilities[capabilityId];

  let accepted = 0;
  let reused = 0;
  const acceptedInnovations: AnyObj[] = [];

  for (const exp of experiences) {
    const peerTrustPrev = clampNumber(
      pool.peer_trust[exp.peer_id],
      0,
      1,
      Number(policy.trust.min_peer_trust || 0.35)
    );
    const peerTrusted = peerTrustPrev >= Number(policy.trust.min_peer_trust || 0.35);
    const reusable = exp.confidence >= Number(policy.sharing.min_reuse_confidence || 0.55);

    let peerTrustNext = (peerTrustPrev * Number(policy.trust.trust_decay || 0.97));
    if (reusable && peerTrusted) peerTrustNext += Number(policy.trust.trust_gain || 0.04);
    else peerTrustNext -= Number(policy.trust.trust_penalty || 0.08) * 0.25;
    pool.peer_trust[exp.peer_id] = clampNumber(peerTrustNext, 0, 1, peerTrustPrev);

    if (!(peerTrusted && reusable)) continue;
    accepted += 1;

    if (!capState.innovations[exp.innovation_id]) {
      capState.innovations[exp.innovation_id] = {
        first_seen_at: ts,
        score: 0,
        used_by: {}
      };
    }
    const innovation = capState.innovations[exp.innovation_id];
    innovation.score = clampNumber(
      Number(innovation.score || 0)
        + exp.confidence
        + Number(policy.sharing.innovation_bonus || 0)
        + (exp.adopted ? 0.1 : 0),
      0,
      10,
      0
    );
    innovation.used_by[localAgentId] = ts;
    innovation.updated_at = ts;

    if (exp.adopted) {
      reused += 1;
      capState.reuse_count = clampInt(capState.reuse_count, 0, 1000000000, 0) + 1;
    }

    acceptedInnovations.push({
      peer_id: exp.peer_id,
      innovation_id: exp.innovation_id,
      confidence: exp.confidence,
      adopted: exp.adopted,
      innovation_score: Number(innovation.score.toFixed(6))
    });
  }

  capState.total_observations = clampInt(capState.total_observations, 0, 1000000000, 0) + experiences.length;
  capState.updated_at = ts;
  pool.updated_at = ts;

  const distinctPeers = new Set(acceptedInnovations.map((row: AnyObj) => row.peer_id)).size;
  const innovationReuseScore = accepted > 0
    ? clampNumber((reused / accepted), 0, 1, 0)
    : 0;
  const groupAdvantageScore = clampNumber(
    (accepted > 0 ? 0.35 : 0)
      + (distinctPeers * 0.08)
      + (innovationReuseScore * 0.45),
    0,
    1,
    0
  );

  const out = {
    ok: true,
    type: 'group_evolving_agents_primitive',
    ts,
    shadow_only: policy.shadow_only === true,
    apply_requested: apply,
    capability_id: capabilityId,
    agent_id: localAgentId,
    accepted_experience_count: accepted,
    total_experience_count: experiences.length,
    distinct_peer_count: distinctPeers,
    innovation_reuse_count: reused,
    innovation_reuse_score: Number(innovationReuseScore.toFixed(6)),
    group_advantage_score: Number(groupAdvantageScore.toFixed(6)),
    accepted_innovations: acceptedInnovations.slice(0, 12),
    state_path: rel(policy.state.pool_path),
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.state.pool_path, pool);
  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.receipts_path, out);
  return out;
}

function commandExportArchive(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.GROUP_EVOLVING_AGENTS_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'group_evolving_agents_export_archive',
      error: 'policy_disabled'
    };
  }
  if (policy.federation.enabled !== true) {
    return {
      ok: false,
      type: 'group_evolving_agents_export_archive',
      error: 'federation_disabled'
    };
  }
  const optIn = toBool(args['opt-in'] || args.opt_in, false);
  if (policy.federation.opt_in_required === true && optIn !== true) {
    return {
      ok: false,
      type: 'group_evolving_agents_export_archive',
      error: 'opt_in_required'
    };
  }

  const capFilter = normalizeToken(args['capability-id'] || args.capability_id || '', 160);
  const peerId = normalizeToken(args['peer-id'] || args.peer_id || 'federated_peer', 120) || 'federated_peer';
  const attestationScore = clampNumber(args['attestation-score'] || args.attestation_score, 0, 1, 1);
  const pool = loadPool(policy.state.pool_path);
  const sourceCaps = pool.capabilities && typeof pool.capabilities === 'object' ? pool.capabilities : {};
  const selectedCaps = capFilter
    ? (sourceCaps[capFilter] ? { [capFilter]: sourceCaps[capFilter] } : {})
    : sourceCaps;
  const capEntries = Object.entries(selectedCaps)
    .slice(0, Number(policy.federation.max_export_capabilities || 32));

  const capabilities: AnyObj = {};
  for (const [capabilityId, rawCap] of capEntries) {
    const cap = rawCap && typeof rawCap === 'object' ? rawCap : {};
    const innovationsRaw = cap.innovations && typeof cap.innovations === 'object'
      ? cap.innovations
      : {};
    const innovations: AnyObj = {};
    for (const [innovationId, rawInnovation] of Object.entries(innovationsRaw)) {
      const innovation = rawInnovation && typeof rawInnovation === 'object' ? rawInnovation : {};
      innovations[innovationId] = {
        score: clampNumber(innovation.score, 0, 10, 0),
        confidence: clampNumber(innovation.confidence, 0, 1, 0.5),
        uses: clampInt(innovation.uses, 0, 1_000_000_000, 0),
        peer_id: peerId
      };
    }
    capabilities[capabilityId] = {
      innovations,
      reuse_count: clampInt(cap.reuse_count, 0, 1_000_000_000, 0),
      total_observations: clampInt(cap.total_observations, 0, 1_000_000_000, 0)
    };
  }

  const pkg = {
    schema_id: 'group_evolving_agents_exchange',
    schema_version: '1.0',
    exported_at: nowIso(),
    source_instance_id: policy.federation.local_instance_id,
    peer_id: peerId,
    attestation_score: Number(attestationScore.toFixed(6)),
    capabilities
  };
  const hash = hashJson(pkg);
  ensureDir(policy.federation.archive_dir);
  const fileName = `gea_exchange_${Date.now().toString(36)}_${hash.slice(0, 10)}.json`;
  const filePath = path.join(policy.federation.archive_dir, fileName);
  writeJsonAtomic(filePath, {
    ...pkg,
    package_hash: hash
  });
  const out = {
    ok: true,
    type: 'group_evolving_agents_export_archive',
    ts: nowIso(),
    capability_count: Object.keys(capabilities).length,
    package_hash: hash,
    package_path: rel(filePath),
    source_instance_id: policy.federation.local_instance_id,
    peer_id: peerId,
    attestation_score: Number(attestationScore.toFixed(6)),
    policy_path: rel(policy.policy_path)
  };
  appendJsonl(policy.state.receipts_path, out);
  return out;
}

function commandImportArchive(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.GROUP_EVOLVING_AGENTS_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'group_evolving_agents_import_archive',
      error: 'policy_disabled'
    };
  }
  if (policy.federation.enabled !== true) {
    return {
      ok: false,
      type: 'group_evolving_agents_import_archive',
      error: 'federation_disabled'
    };
  }
  const optIn = toBool(args['opt-in'] || args.opt_in, false);
  if (policy.federation.opt_in_required === true && optIn !== true) {
    return {
      ok: false,
      type: 'group_evolving_agents_import_archive',
      error: 'opt_in_required'
    };
  }
  const filePathRaw = cleanText(args.file || '', 500);
  if (!filePathRaw) {
    return {
      ok: false,
      type: 'group_evolving_agents_import_archive',
      error: 'file_required'
    };
  }
  const filePath = path.isAbsolute(filePathRaw) ? filePathRaw : path.resolve(filePathRaw);
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      type: 'group_evolving_agents_import_archive',
      error: 'file_not_found',
      file: filePathRaw
    };
  }
  const pkg = readJson(filePath, null);
  if (!pkg || typeof pkg !== 'object' || cleanText(pkg.schema_id || '', 80) !== 'group_evolving_agents_exchange') {
    return {
      ok: false,
      type: 'group_evolving_agents_import_archive',
      error: 'invalid_archive_package'
    };
  }
  const attestationScore = clampNumber(pkg.attestation_score, 0, 1, 0);
  if (attestationScore < Number(policy.federation.min_attestation_score || 0.55)) {
    return {
      ok: false,
      type: 'group_evolving_agents_import_archive',
      error: 'attestation_score_below_minimum',
      attestation_score: Number(attestationScore.toFixed(6)),
      min_required: Number(policy.federation.min_attestation_score || 0.55)
    };
  }
  const sourceInstanceId = normalizeToken(pkg.source_instance_id || 'unknown_source', 120) || 'unknown_source';
  const capabilities = pkg.capabilities && typeof pkg.capabilities === 'object' ? pkg.capabilities : {};
  const pool = loadPool(policy.state.pool_path);
  const targetCapabilities = pool.capabilities && typeof pool.capabilities === 'object' ? pool.capabilities : {};
  const capEntries = Object.entries(capabilities).slice(0, Number(policy.federation.max_import_capabilities || 64));

  let importedCapabilities = 0;
  let importedInnovations = 0;
  let reusedInnovations = 0;
  for (const [capabilityIdRaw, capRaw] of capEntries) {
    const capabilityId = normalizeToken(capabilityIdRaw, 160);
    if (!capabilityId) continue;
    const cap = capRaw && typeof capRaw === 'object' ? capRaw : {};
    const innovationsRaw = cap.innovations && typeof cap.innovations === 'object' ? cap.innovations : {};
    if (!targetCapabilities[capabilityId]) {
      targetCapabilities[capabilityId] = {
        innovations: {},
        reuse_count: 0,
        total_observations: 0,
        updated_at: null
      };
    }
    const dst = targetCapabilities[capabilityId];
    const dstInnovations = dst.innovations && typeof dst.innovations === 'object' ? dst.innovations : {};
    let capImported = 0;
    for (const [innovationIdRaw, innovationRaw] of Object.entries(innovationsRaw)) {
      const innovationId = normalizeToken(innovationIdRaw, 140);
      if (!innovationId) continue;
      const innovation = innovationRaw && typeof innovationRaw === 'object' ? innovationRaw : {};
      const importedScore = clampNumber(innovation.score, 0, 10, 0);
      const importedConfidence = clampNumber(innovation.confidence, 0, 1, 0.5);
      const peerTrust = clampNumber(pool.peer_trust[sourceInstanceId], 0, 1, Number(policy.trust.min_peer_trust || 0.35));
      const trustWeight = clampNumber(peerTrust * attestationScore, 0, 1, 0);
      const prev = dstInnovations[innovationId] && typeof dstInnovations[innovationId] === 'object'
        ? dstInnovations[innovationId]
        : null;
      const prevScore = clampNumber(prev && prev.score, 0, 10, 0);
      const prevConfidence = clampNumber(prev && prev.confidence, 0, 1, 0.5);
      const nextScore = prev
        ? clampNumber((prevScore * 0.6) + (importedScore * trustWeight * 0.4), 0, 10, prevScore)
        : clampNumber(importedScore * Math.max(0.4, trustWeight), 0, 10, importedScore);
      const nextConfidence = prev
        ? clampNumber((prevConfidence * 0.5) + (importedConfidence * 0.5), 0, 1, prevConfidence)
        : importedConfidence;
      dstInnovations[innovationId] = {
        score: Number(nextScore.toFixed(6)),
        confidence: Number(nextConfidence.toFixed(6)),
        uses: clampInt((prev && prev.uses) || 0, 0, 1_000_000_000, 0),
        used_by: {
          ...(prev && prev.used_by && typeof prev.used_by === 'object' ? prev.used_by : {}),
          [sourceInstanceId]: nowIso()
        },
        updated_at: nowIso()
      };
      capImported += 1;
      importedInnovations += 1;
      if (prev) reusedInnovations += 1;
    }
    dst.innovations = dstInnovations;
    dst.total_observations = clampInt(dst.total_observations, 0, 1_000_000_000, 0) + capImported;
    dst.updated_at = nowIso();
    importedCapabilities += 1;
  }

  pool.capabilities = targetCapabilities;
  const peerTrustPrev = clampNumber(pool.peer_trust[sourceInstanceId], 0, 1, Number(policy.trust.min_peer_trust || 0.35));
  const trustDelta = importedInnovations > 0
    ? Number(policy.federation.import_trust_gain || 0.03)
    : -Number(policy.federation.import_trust_penalty || 0.05);
  pool.peer_trust[sourceInstanceId] = clampNumber(peerTrustPrev + trustDelta, 0, 1, peerTrustPrev);
  pool.updated_at = nowIso();
  writeJsonAtomic(policy.state.pool_path, pool);

  const out = {
    ok: true,
    type: 'group_evolving_agents_import_archive',
    ts: nowIso(),
    source_instance_id: sourceInstanceId,
    attestation_score: Number(attestationScore.toFixed(6)),
    imported_capability_count: importedCapabilities,
    imported_innovation_count: importedInnovations,
    reused_innovation_count: reusedInnovations,
    peer_trust_before: Number(peerTrustPrev.toFixed(6)),
    peer_trust_after: Number(pool.peer_trust[sourceInstanceId].toFixed(6)),
    imported_file: rel(filePath),
    state_path: rel(policy.state.pool_path),
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.receipts_path, out);
  return out;
}

function commandRun(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.GROUP_EVOLVING_AGENTS_POLICY_PATH || DEFAULT_POLICY_PATH));
  const input = parseJsonArg(args['input-json'] || args.input_json, {});
  return runGroupEvolvingAgents(input, {
    policyPath,
    apply: toBool(args.apply, false)
  });
}

function commandStatus(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.GROUP_EVOLVING_AGENTS_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const pool = loadPool(policy.state.pool_path);
  const latest = readJson(policy.state.latest_path, null);
  const capabilityId = normalizeToken(args['capability-id'] || args.capability_id || '', 160);
  const capState = capabilityId ? (pool.capabilities[capabilityId] || null) : null;
  return {
    ok: true,
    type: 'group_evolving_agents_status',
    ts: nowIso(),
    tracked_capabilities: Object.keys(pool.capabilities || {}).length,
    tracked_peers: Object.keys(pool.peer_trust || {}).length,
    capability_id: capabilityId || null,
    capability_state: capState,
    latest: latest && typeof latest === 'object'
      ? {
        capability_id: latest.capability_id || null,
        group_advantage_score: latest.group_advantage_score || null,
        ts: latest.ts || null
      }
      : null,
    federation: {
      enabled: policy.federation.enabled === true,
      opt_in_required: policy.federation.opt_in_required === true,
      local_instance_id: policy.federation.local_instance_id,
      archive_dir: rel(policy.federation.archive_dir)
    },
    state_path: rel(policy.state.pool_path),
    policy_path: rel(policy.policy_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  try {
    let out: AnyObj;
    if (cmd === 'run') out = commandRun(args);
    else if (cmd === 'status') out = commandStatus(args);
    else if (cmd === 'export-archive') out = commandExportArchive(args);
    else if (cmd === 'import-archive') out = commandImportArchive(args);
    else if (!cmd || cmd === '--help' || cmd === 'help') {
      usage();
      process.exit(0);
      return;
    } else {
      throw new Error(`unknown_command:${cmd}`);
    }
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'group_evolving_agents_primitive',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'run_failed', 240)
    })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  runGroupEvolvingAgents,
  commandRun,
  commandStatus,
  commandExportArchive,
  commandImportArchive,
  loadPolicy
};
