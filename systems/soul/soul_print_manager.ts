#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'soul_policy.json');

const { buildModalityRegistry, listActiveModalities } = require('./modality_registry');
const { collectSensorObservations } = require('./sensor_abstraction_layer');
const { evaluateLiveness } = require('./liveness_engine');
const { fuseBiometricAttestation } = require('./biometric_fusion');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackAbs: string) {
  const text = cleanText(raw, 500);
  if (!text) return fallbackAbs;
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    k_of_n_threshold: 2,
    min_confidence: 0.82,
    min_liveness_modalities: 2,
    anti_replay: {
      require_nonce: true,
      max_challenge_age_sec: 120
    },
    template: {
      rotation_days: 30,
      allow_drift_adaptation: true,
      max_drift_delta: 0.2
    },
    modalities: {},
    fallback_chain: ['biometric_primary', 'biometric_secondary', 'knowledge_possession'],
    outputs: {
      state_root: 'state/security/soul_biometric',
      latest_path: 'state/security/soul_biometric/latest.json',
      runtime_state_path: 'state/security/soul_biometric/runtime_state.json',
      receipts_path: 'state/security/soul_biometric/receipts.jsonl',
      events_path: 'state/security/soul_biometric/events.jsonl',
      obsidian_path: 'state/security/soul_biometric/obsidian_projection.jsonl',
      emit_holo_events: true,
      emit_obsidian_receipts: true
    }
  };
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const antiReplay = raw.anti_replay && typeof raw.anti_replay === 'object' ? raw.anti_replay : {};
  const template = raw.template && typeof raw.template === 'object' ? raw.template : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    ...base,
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    k_of_n_threshold: clampInt(raw.k_of_n_threshold, 1, 32, base.k_of_n_threshold),
    min_confidence: clampNumber(raw.min_confidence, 0, 1, base.min_confidence),
    min_liveness_modalities: clampInt(
      raw.min_liveness_modalities,
      1,
      32,
      base.min_liveness_modalities
    ),
    anti_replay: {
      require_nonce: antiReplay.require_nonce !== false,
      max_challenge_age_sec: clampInt(
        antiReplay.max_challenge_age_sec,
        1,
        3600,
        base.anti_replay.max_challenge_age_sec
      )
    },
    template: {
      rotation_days: clampInt(template.rotation_days, 1, 3650, base.template.rotation_days),
      allow_drift_adaptation: template.allow_drift_adaptation !== false,
      max_drift_delta: clampNumber(template.max_drift_delta, 0, 1, base.template.max_drift_delta)
    },
    modalities: raw.modalities && typeof raw.modalities === 'object' ? raw.modalities : {},
    fallback_chain: Array.isArray(raw.fallback_chain)
      ? raw.fallback_chain.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean).slice(0, 12)
      : base.fallback_chain.slice(0),
    outputs: {
      state_root: cleanText(outputs.state_root || base.outputs.state_root, 260) || base.outputs.state_root,
      latest_path: cleanText(outputs.latest_path || base.outputs.latest_path, 260) || base.outputs.latest_path,
      runtime_state_path: cleanText(outputs.runtime_state_path || base.outputs.runtime_state_path, 260) || base.outputs.runtime_state_path,
      receipts_path: cleanText(outputs.receipts_path || base.outputs.receipts_path, 260) || base.outputs.receipts_path,
      events_path: cleanText(outputs.events_path || base.outputs.events_path, 260) || base.outputs.events_path,
      obsidian_path: cleanText(outputs.obsidian_path || base.outputs.obsidian_path, 260) || base.outputs.obsidian_path,
      emit_holo_events: outputs.emit_holo_events !== false,
      emit_obsidian_receipts: outputs.emit_obsidian_receipts !== false
    }
  };
}

function resolvePaths(policy: AnyObj, stateRootOverride: unknown) {
  const root = resolvePath(
    stateRootOverride || policy.outputs.state_root,
    path.join(ROOT, 'state', 'security', 'soul_biometric')
  );
  const latest = resolvePath(policy.outputs.latest_path, path.join(root, 'latest.json'));
  const runtime = resolvePath(policy.outputs.runtime_state_path, path.join(root, 'runtime_state.json'));
  const receipts = resolvePath(policy.outputs.receipts_path, path.join(root, 'receipts.jsonl'));
  const events = resolvePath(policy.outputs.events_path, path.join(root, 'events.jsonl'));
  const obsidian = resolvePath(policy.outputs.obsidian_path, path.join(root, 'obsidian_projection.jsonl'));
  return {
    root,
    latest_path: latest,
    runtime_state_path: runtime,
    receipts_path: receipts,
    events_path: events,
    obsidian_path: obsidian
  };
}

function renderObsidian(out: AnyObj = {}) {
  return [
    '# Soul Attestation',
    '',
    `- Match: \`${out.match === true ? 'yes' : 'no'}\``,
    `- Confidence: \`${Number(out.confidence || 0).toFixed(3)}\``,
    `- Liveness: \`${out.liveness_ok === true ? 'pass' : 'fail'}\``,
    `- Matched modalities: \`${Number(out.matched_modalities || 0)}/${Number(out.total_modalities || 0)}\``,
    `- Shadow only: \`${out.shadow_only === true ? 'yes' : 'no'}\``,
    `- Commitment: \`${cleanText(out.commitment_id || '', 40)}\``
  ].join('\n');
}

function generateTemplateId(runtimeState: AnyObj = {}) {
  const existing = cleanText(runtimeState.template_id || '', 80);
  if (existing) return existing;
  return `tpl_${crypto.randomBytes(8).toString('hex')}`;
}

function runSoulAttestation(input: AnyObj = {}) {
  const policyPath = resolvePath(
    input.policy_path || process.env.SOUL_POLICY_PATH,
    DEFAULT_POLICY_PATH
  );
  const policy = loadPolicy(policyPath);
  const paths = resolvePaths(policy, input.state_root);
  const runtime = readJson(paths.runtime_state_path, {});
  const challengeNonce = cleanText(input.challenge_nonce || crypto.randomBytes(8).toString('hex'), 120)
    || crypto.randomBytes(8).toString('hex');
  const registry = buildModalityRegistry(policy);
  const active = listActiveModalities(policy);
  const obs = collectSensorObservations(
    active.map((row: AnyObj) => ({
      ...row,
      min_confidence: row.min_confidence
    })),
    {
      challenge_nonce: challengeNonce,
      mock_profile: input.mock_profile
    }
  ).map((row: AnyObj) => {
    const cfg = registry.find((item: AnyObj) => String(item.id) === String(row.modality_id)) || {};
    return {
      ...row,
      weight: Number(cfg.weight || 0),
      min_confidence: Number(cfg.min_confidence || 0.7)
    };
  });
  const liveness = evaluateLiveness(obs, policy);
  const fused = fuseBiometricAttestation({
    policy,
    observations: obs,
    liveness,
    challenge_nonce: challengeNonce
  });
  const ts = nowIso();
  const shadowOnly = input.shadow_only != null
    ? toBool(input.shadow_only, true)
    : (policy.shadow_only !== false);
  const templateId = generateTemplateId(runtime);
  const fallbackStep = fused.match === true ? null : (policy.fallback_chain && policy.fallback_chain[0]) || 'knowledge_possession';
  const out = {
    ok: true,
    type: 'soul_biometric_attestation',
    ts,
    shadow_only: shadowOnly === true,
    checked: true,
    match: fused.match === true,
    confidence: Number(fused.confidence || 0),
    min_confidence: Number(fused.min_confidence || policy.min_confidence || 0.82),
    k_threshold: Number(fused.k_threshold || policy.k_of_n_threshold || 2),
    matched_modalities: Number(fused.matched_modalities || 0),
    total_modalities: Number(fused.total_modalities || 0),
    liveness_ok: fused.liveness_ok === true,
    reason_codes: Array.isArray(fused.reason_codes) ? fused.reason_codes : [],
    commitment_id: cleanText(fused.commitment_id || '', 80) || null,
    fallback_next: fallbackStep,
    template_id: templateId,
    policy_path: relPath(policyPath),
    state_root: relPath(paths.root),
    modalities: active.map((row: AnyObj) => String(row.id || '')).filter(Boolean)
  };

  writeJsonAtomic(paths.latest_path, out);
  writeJsonAtomic(paths.runtime_state_path, {
    template_id: templateId,
    last_run_ts: ts,
    last_match: out.match,
    last_confidence: out.confidence,
    last_commitment_id: out.commitment_id,
    shadow_only: out.shadow_only,
    policy_path: out.policy_path,
    state_root: out.state_root
  });
  appendJsonl(paths.receipts_path, {
    ts,
    type: 'soul_biometric_receipt',
    match: out.match,
    confidence: out.confidence,
    shadow_only: out.shadow_only,
    commitment_id: out.commitment_id,
    reason_codes: out.reason_codes
  });
  if (policy.outputs.emit_holo_events === true) {
    appendJsonl(paths.events_path, {
      ts,
      type: 'soul_biometric_event',
      stage: out.match ? 'verified' : 'uncertain',
      confidence: out.confidence,
      matched_modalities: out.matched_modalities,
      total_modalities: out.total_modalities,
      commitment_id: out.commitment_id
    });
  }
  if (policy.outputs.emit_obsidian_receipts === true) {
    appendJsonl(paths.obsidian_path, {
      ts,
      type: 'soul_biometric_obsidian',
      markdown: renderObsidian(out)
    });
  }
  return out;
}

function statusSoulAttestation(input: AnyObj = {}) {
  const policyPath = resolvePath(
    input.policy_path || process.env.SOUL_POLICY_PATH,
    DEFAULT_POLICY_PATH
  );
  const policy = loadPolicy(policyPath);
  const paths = resolvePaths(policy, input.state_root);
  const latest = readJson(paths.latest_path, null);
  if (!latest || typeof latest !== 'object') {
    return {
      ok: false,
      type: 'soul_biometric_status',
      error: 'latest_missing',
      state_root: relPath(paths.root),
      latest_path: relPath(paths.latest_path)
    };
  }
  return {
    ok: true,
    type: 'soul_biometric_status',
    ts: cleanText(latest.ts || '', 80) || null,
    match: latest.match === true,
    confidence: Number(latest.confidence || 0),
    shadow_only: latest.shadow_only === true,
    commitment_id: cleanText(latest.commitment_id || '', 80) || null,
    template_id: cleanText(latest.template_id || '', 80) || null,
    latest_path: relPath(paths.latest_path),
    state_root: relPath(paths.root)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/soul/soul_print_manager.js run [--policy=path] [--state-root=path] [--shadow-only=1] [--challenge=<nonce>]');
  console.log('  node systems/soul/soul_print_manager.js status [--policy=path] [--state-root=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 24) || 'status';
  if (cmd === 'run') {
    const out = runSoulAttestation({
      policy_path: args.policy,
      state_root: args['state-root'] || args.state_root,
      shadow_only: args['shadow-only'] || args.shadow_only,
      challenge_nonce: args.challenge
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  if (cmd === 'status') {
    const out = statusSoulAttestation({
      policy_path: args.policy,
      state_root: args['state-root'] || args.state_root
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    if (!out.ok) process.exitCode = 1;
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'soul_biometric_attestation',
      error: cleanText(err && err.message ? err.message : err || 'soul_biometric_failed', 260)
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  runSoulAttestation,
  statusSoulAttestation
};

