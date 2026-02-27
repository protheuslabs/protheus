#!/usr/bin/env node
'use strict';
export {};

/**
 * helix_admission_gate.js
 *
 * V3-032: admission checks for Assimilation/Forge/Doctor grafts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadCodex } = require('./codex_root');
const { buildHelixManifest } = require('./strand_verifier');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.HELIX_ADMISSION_POLICY_PATH
  ? path.resolve(String(process.env.HELIX_ADMISSION_POLICY_PATH))
  : path.join(ROOT, 'config', 'helix_admission_policy.json');

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

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok).slice(2)] = true;
    else out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
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

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(v: unknown, fallbackRel: string) {
  const raw = cleanText(v || fallbackRel, 360);
  return path.isAbsolute(raw) ? path.resolve(raw) : path.join(ROOT, raw);
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function sha256(text: string) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  const obj = value as AnyObj;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    require_doctor_approval_for_apply: true,
    require_codex_root_for_apply: false,
    manifest_update_on_apply: true,
    allowed_sources: ['assimilation', 'forge', 'doctor'],
    paths: {
      admissions_path: 'state/helix/admissions.jsonl',
      latest_path: 'state/helix/admission_latest.json',
      manifest_path: 'state/helix/manifest.json'
    },
    helix: {
      policy_path: 'config/helix_policy.json',
      codex_path: 'codex.helix'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const pathsRaw = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const helixRaw = raw.helix && typeof raw.helix === 'object' ? raw.helix : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    require_doctor_approval_for_apply: raw.require_doctor_approval_for_apply !== false,
    require_codex_root_for_apply: raw.require_codex_root_for_apply !== false,
    manifest_update_on_apply: raw.manifest_update_on_apply !== false,
    allowed_sources: Array.isArray(raw.allowed_sources)
      ? raw.allowed_sources.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
      : base.allowed_sources.slice(0),
    paths: {
      admissions_path: resolvePath(pathsRaw.admissions_path, base.paths.admissions_path),
      latest_path: resolvePath(pathsRaw.latest_path, base.paths.latest_path),
      manifest_path: resolvePath(pathsRaw.manifest_path, base.paths.manifest_path)
    },
    helix: {
      policy_path: resolvePath(helixRaw.policy_path, base.helix.policy_path),
      codex_path: resolvePath(helixRaw.codex_path, base.helix.codex_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadHelixCodexRoot(policy: AnyObj) {
  const codex = loadCodex(policy.helix.codex_path);
  if (!codex || typeof codex !== 'object') return '';
  return cleanText(codex.root_hash || '', 200);
}

function computeCandidateHash(candidate: AnyObj) {
  const body = {
    strand_id: cleanText(candidate.strand_id || '', 120),
    source: normalizeToken(candidate.source || '', 80),
    capability_id: normalizeToken(candidate.capability_id || '', 160),
    risk_class: normalizeToken(candidate.risk_class || 'general', 80),
    artifact_hash: cleanText(candidate.artifact_hash || '', 200),
    codex_root_hash: cleanText(candidate.codex_root_hash || '', 200),
    created_at: cleanText(candidate.created_at || '', 40)
  };
  return sha256(stableStringify(body));
}

function buildStrandCandidate(input: AnyObj = {}, opts: AnyObj = {}) {
  const source = normalizeToken(input.source || 'assimilation', 80) || 'assimilation';
  const capabilityId = normalizeToken(input.capability_id || '', 180) || 'unknown_capability';
  const riskClass = normalizeToken(input.risk_class || 'general', 80) || 'general';
  const createdAt = cleanText(input.created_at || nowIso(), 40) || nowIso();
  const codexRootHash = cleanText(input.codex_root_hash || opts.codex_root_hash || '', 200) || 'missing_codex_root';
  const artifactHash = cleanText(
    input.artifact_hash || sha256(stableStringify({
      capability_id: capabilityId,
      source,
      risk_class: riskClass,
      mode: cleanText(input.mode || '', 40),
      replica_id: cleanText(input.replica_id || '', 120),
      forge_id: cleanText(input.forge_id || '', 120)
    })),
    200
  );
  const strandId = cleanText(input.strand_id || `strand_${sha256(`${capabilityId}|${source}|${createdAt}`).slice(0, 16)}`, 120);
  const candidate = {
    schema_id: 'helix_strand_candidate',
    schema_version: '1.0',
    strand_id: strandId,
    source,
    capability_id: capabilityId,
    risk_class: riskClass,
    artifact_hash: artifactHash,
    codex_root_hash: codexRootHash,
    created_at: createdAt
  };
  return {
    ...candidate,
    strand_hash: computeCandidateHash(candidate)
  };
}

function writeHelixManifest(policy: AnyObj) {
  const helixPolicy = readJson(policy.helix.policy_path, {});
  const codex = loadCodex(policy.helix.codex_path);
  const manifest = buildHelixManifest(codex || {}, helixPolicy || {}, { generated_at: nowIso() });
  writeJsonAtomic(policy.paths.manifest_path, manifest);
  return manifest;
}

function evaluateHelixAdmission(input: AnyObj = {}, policy: AnyObj) {
  const candidate = input && input.candidate && typeof input.candidate === 'object'
    ? input.candidate
    : {};
  const reasonCodes: string[] = [];
  let allowed = true;
  const source = normalizeToken(candidate.source || '', 80);
  const capabilityId = normalizeToken(candidate.capability_id || '', 180);
  if (!source || !policy.allowed_sources.includes(source)) {
    allowed = false;
    reasonCodes.push('source_not_allowed');
  }
  if (!capabilityId) {
    allowed = false;
    reasonCodes.push('capability_id_missing');
  }
  const strandHash = cleanText(candidate.strand_hash || '', 200);
  const expectedHash = computeCandidateHash(candidate);
  if (!strandHash || strandHash !== expectedHash) {
    allowed = false;
    reasonCodes.push('strand_hash_mismatch');
  }
  const codexRoot = loadHelixCodexRoot(policy);
  const candidateCodex = cleanText(candidate.codex_root_hash || '', 200);
  const applyRequested = input.apply_requested === true;
  const doctorApproved = input.doctor_approved === true;
  if (applyRequested && policy.require_codex_root_for_apply === true) {
    if (!codexRoot || codexRoot === 'missing_codex_root') {
      allowed = false;
      reasonCodes.push('codex_root_missing');
    } else if (candidateCodex !== codexRoot) {
      allowed = false;
      reasonCodes.push('codex_root_hash_mismatch');
    }
  }
  if (applyRequested && policy.require_doctor_approval_for_apply === true && !doctorApproved) {
    allowed = false;
    reasonCodes.push('doctor_approval_required');
  }
  const applyExecutable = applyRequested === true
    && policy.shadow_only !== true
    && allowed === true;
  if (policy.shadow_only === true) reasonCodes.push('shadow_only_mode');
  return {
    allowed,
    apply_requested: applyRequested,
    apply_executed: applyExecutable,
    reason_codes: Array.from(new Set(reasonCodes)),
    candidate: candidate || null
  };
}

function admitStrandCandidate(input: AnyObj = {}, opts: AnyObj = {}) {
  const policy = loadPolicy(opts.policy_path ? path.resolve(String(opts.policy_path)) : DEFAULT_POLICY_PATH);
  const decision = evaluateHelixAdmission(input, policy);
  let manifestUpdated = false;
  let manifestMeta = null;
  if (decision.apply_executed === true && policy.manifest_update_on_apply === true) {
    const manifest = writeHelixManifest(policy);
    manifestUpdated = true;
    manifestMeta = {
      manifest_path: rel(policy.paths.manifest_path),
      merkle_root: cleanText(manifest.merkle_root || '', 120) || null,
      strand_count: Number(manifest.strand_count || 0)
    };
  }
  const receipt = {
    ts: nowIso(),
    type: 'helix_admission',
    decision,
    manifest_updated: manifestUpdated,
    manifest: manifestMeta
  };
  appendJsonl(policy.paths.admissions_path, receipt);
  writeJsonAtomic(policy.paths.latest_path, receipt);
  return {
    ok: true,
    type: 'helix_admission',
    ...decision,
    manifest_updated: manifestUpdated,
    manifest: manifestMeta
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/helix/helix_admission_gate.js candidate --source=<assimilation|forge|doctor> --capability-id=<id> [--risk-class=<class>]');
  console.log('  node systems/helix/helix_admission_gate.js admit --candidate-json=<json> [--apply=1|0] [--doctor-approved=1|0]');
  console.log('  node systems/helix/helix_admission_gate.js status');
}

function cmdCandidate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const codexRoot = loadHelixCodexRoot(policy);
  const out = buildStrandCandidate({
    source: args.source || 'assimilation',
    capability_id: args['capability-id'] || args.capability_id || '',
    risk_class: args['risk-class'] || args.risk_class || 'general',
    mode: args.mode || ''
  }, {
    codex_root_hash: codexRoot || 'missing_codex_root'
  });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'helix_strand_candidate', candidate: out }, null, 2)}\n`);
}

function cmdAdmit(args: AnyObj) {
  let candidate = {};
  if (args['candidate-json']) {
    try { candidate = JSON.parse(String(args['candidate-json'])); } catch { candidate = {}; }
  }
  const out = admitStrandCandidate({
    candidate,
    apply_requested: toBool(args.apply, false),
    doctor_approved: toBool(args['doctor-approved'], false)
  }, {
    policy_path: args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH
  });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (out.allowed !== true && out.apply_requested === true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.paths.latest_path, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'helix_admission_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    latest,
    paths: {
      admissions_path: rel(policy.paths.admissions_path),
      latest_path: rel(policy.paths.latest_path),
      manifest_path: rel(policy.paths.manifest_path)
    }
  }, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'candidate') return cmdCandidate(args);
  if (cmd === 'admit') return cmdAdmit(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  buildStrandCandidate,
  evaluateHelixAdmission,
  admitStrandCandidate
};
