#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'helix_policy.json');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'helix');
const DEFAULT_CODEX_PATH = path.join(ROOT, 'codex.helix');

const { initCodex, loadCodex, verifyCodexRoot } = require('./codex_root');
const { buildHelixManifest, verifyHelixManifest } = require('./strand_verifier');
const { evaluateSentinel } = require('./sentinel_network');
const { planHunterActions } = require('./hunter_strand');
const { applyQuarantine } = require('./quarantine_manager');
const { applyPermanentQuarantine } = require('./confirmed_malice_quarantine');
const { planReweave, captureReweaveSnapshot, applyReweave } = require('./reweave_doctor');
const { evaluateSafetyResilience } = require('../security/safety_resilience_guard');

function nowIso() {
  return new Date().toISOString();
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
    advisory_mode: false,
    codex: {
      codex_path: 'codex.helix',
      key_env: 'HELIX_CODEX_KEY',
      constitution_path: 'AGENT-CONSTITUTION.md',
      soul_token_state_path: 'state/security/soul_token_guard.json',
      soul_biometric_state_path: 'state/security/soul_biometric/latest.json',
      bootstrap_truths: [
        'preserve_constitutional_root',
        'preserve_user_sovereignty',
        'deny_unauthorized_self_rewrite',
        'fail_secure_before_actuation'
      ]
    },
    strands: {
      roots: ['systems', 'lib', 'config'],
      include_ext: ['.ts', '.js', '.json'],
      exclude_paths: ['state/**', 'dist/**', 'node_modules/**', 'tmp/**', 'agent-holo-viz/**']
    },
    sentinel: {
      enabled: true,
      force_confirmed_malice: false,
      max_manifest_age_minutes: 1440,
      thresholds: {
        stasis_mismatch_count: 1,
        malice_mismatch_count: 8,
        confirmed_malice_score: 3
      }
    },
    outputs: {
      emit_events: true,
      emit_obsidian_projection: true
    },
    integration: {
      eye_gate_mode: 'shadow_advisory'
    },
    reweave: {
      snapshot_path: 'state/helix/reweave_snapshot.json',
      receipts_path: 'state/helix/reweave_receipts.jsonl',
      quarantine_dir: 'state/helix/reweave_quarantine',
      require_approval_note: true,
      snapshot_on_clear_attest: true
    }
  };
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const codex = raw.codex && typeof raw.codex === 'object' ? raw.codex : {};
  const strands = raw.strands && typeof raw.strands === 'object' ? raw.strands : {};
  const sentinel = raw.sentinel && typeof raw.sentinel === 'object' ? raw.sentinel : {};
  const thresholds = sentinel.thresholds && typeof sentinel.thresholds === 'object'
    ? sentinel.thresholds
    : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const integration = raw.integration && typeof raw.integration === 'object' ? raw.integration : {};
  const reweave = raw.reweave && typeof raw.reweave === 'object' ? raw.reweave : {};
  return {
    ...base,
    version: cleanText(raw.version || base.version, 40) || '1.0',
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    advisory_mode: raw.advisory_mode === true,
    codex: {
      ...base.codex,
      codex_path: cleanText(codex.codex_path || base.codex.codex_path, 260) || base.codex.codex_path,
      key_env: cleanText(codex.key_env || base.codex.key_env, 80) || base.codex.key_env,
      constitution_path: cleanText(codex.constitution_path || base.codex.constitution_path, 260)
        || base.codex.constitution_path,
      soul_token_state_path: cleanText(codex.soul_token_state_path || base.codex.soul_token_state_path, 260)
        || base.codex.soul_token_state_path,
      soul_biometric_state_path: cleanText(
        codex.soul_biometric_state_path || base.codex.soul_biometric_state_path,
        260
      ) || base.codex.soul_biometric_state_path,
      bootstrap_truths: Array.isArray(codex.bootstrap_truths)
        ? codex.bootstrap_truths.map((row: unknown) => cleanText(row, 200)).filter(Boolean).slice(0, 64)
        : base.codex.bootstrap_truths.slice(0)
    },
    strands: {
      ...base.strands,
      roots: Array.isArray(strands.roots) ? strands.roots.slice(0, 64) : base.strands.roots.slice(0),
      include_ext: Array.isArray(strands.include_ext) ? strands.include_ext.slice(0, 64) : base.strands.include_ext.slice(0),
      exclude_paths: Array.isArray(strands.exclude_paths)
        ? strands.exclude_paths.slice(0, 512)
        : base.strands.exclude_paths.slice(0)
    },
    sentinel: {
      enabled: sentinel.enabled !== false,
      force_confirmed_malice: sentinel.force_confirmed_malice === true,
      max_manifest_age_minutes: clampInt(
        sentinel.max_manifest_age_minutes,
        1,
        365 * 24 * 60,
        base.sentinel.max_manifest_age_minutes
      ),
      thresholds: {
        stasis_mismatch_count: clampInt(
          thresholds.stasis_mismatch_count,
          1,
          1000000,
          base.sentinel.thresholds.stasis_mismatch_count
        ),
        malice_mismatch_count: clampInt(
          thresholds.malice_mismatch_count,
          1,
          1000000,
          base.sentinel.thresholds.malice_mismatch_count
        ),
        confirmed_malice_score: Number(
          Math.max(0, Math.min(100, Number(
            thresholds.confirmed_malice_score == null
              ? base.sentinel.thresholds.confirmed_malice_score
              : thresholds.confirmed_malice_score
          )))
        )
      }
    },
    outputs: {
      emit_events: outputs.emit_events !== false,
      emit_obsidian_projection: outputs.emit_obsidian_projection !== false
    },
    integration: {
      eye_gate_mode: normalizeToken(integration.eye_gate_mode || base.integration.eye_gate_mode, 40)
        || base.integration.eye_gate_mode
    },
    reweave: {
      snapshot_path: cleanText(reweave.snapshot_path || base.reweave.snapshot_path, 320) || base.reweave.snapshot_path,
      receipts_path: cleanText(reweave.receipts_path || base.reweave.receipts_path, 320) || base.reweave.receipts_path,
      quarantine_dir: cleanText(reweave.quarantine_dir || base.reweave.quarantine_dir, 320) || base.reweave.quarantine_dir,
      require_approval_note: reweave.require_approval_note !== false,
      snapshot_on_clear_attest: reweave.snapshot_on_clear_attest !== false
    }
  };
}

function runtimePaths(policyPath: string, policy: AnyObj) {
  const stateDir = resolvePath(process.env.HELIX_STATE_DIR, DEFAULT_STATE_DIR);
  const codexPath = resolvePath(
    process.env.HELIX_CODEX_PATH || (policy && policy.codex && policy.codex.codex_path),
    DEFAULT_CODEX_PATH
  );
  return {
    policy_path: policyPath,
    state_dir: stateDir,
    codex_path: codexPath,
    latest_path: path.join(stateDir, 'latest.json'),
    events_path: path.join(stateDir, 'events.jsonl'),
    runs_dir: path.join(stateDir, 'runs'),
    manifest_path: path.join(stateDir, 'manifest.json'),
    quarantine_path: path.join(stateDir, 'quarantine_state.json'),
    sentinel_path: path.join(stateDir, 'sentinel_state.json'),
    obsidian_path: path.join(stateDir, 'obsidian_projection.jsonl')
  };
}

function emitEvent(paths: AnyObj, policy: AnyObj, stage: string, payload: AnyObj = {}) {
  if (!(policy && policy.outputs && policy.outputs.emit_events === true)) return;
  appendJsonl(paths.events_path, {
    ts: nowIso(),
    type: 'helix_event',
    stage,
    ...payload
  });
}

function emitObsidianProjection(paths: AnyObj, policy: AnyObj, markdown: string) {
  if (!(policy && policy.outputs && policy.outputs.emit_obsidian_projection === true)) return;
  appendJsonl(paths.obsidian_path, {
    ts: nowIso(),
    type: 'helix_obsidian_projection',
    markdown: cleanText(markdown, 16000)
  });
}

function readSentinelState(paths: AnyObj) {
  return readJson(paths.sentinel_path, {
    schema_id: 'helix_sentinel_state',
    schema_version: '1.0',
    updated_at: null,
    current_tier: 'clear'
  });
}

function writeSentinelState(paths: AnyObj, sentinel: AnyObj) {
  const prev = readSentinelState(paths);
  const next = {
    schema_id: 'helix_sentinel_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    current_tier: String(sentinel && sentinel.tier || 'clear'),
    score: Number(sentinel && sentinel.score || 0),
    reason_codes: Array.isArray(sentinel && sentinel.reason_codes) ? sentinel.reason_codes.slice(0, 64) : [],
    prior_tier: String(prev && prev.current_tier || 'clear')
  };
  writeJsonAtomic(paths.sentinel_path, next);
  return next;
}

function commandInit(args: AnyObj) {
  const policyPath = resolvePath(args.policy || process.env.HELIX_POLICY_PATH, DEFAULT_POLICY_PATH);
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const initCodexResult = initCodex(paths.codex_path, policy, {
    overwrite: toBool(args.overwrite, false),
    approval_note: args['approval-note'] || args.approval_note
  });
  const codex = loadCodex(paths.codex_path);
  const manifest = buildHelixManifest(codex, policy, { generated_at: nowIso() });
  writeJsonAtomic(paths.manifest_path, manifest);
  const snapshot = captureReweaveSnapshot(policy, {
    manifest_path: paths.manifest_path,
    codex_path: paths.codex_path
  });
  const advisoryMode = policy && policy.advisory_mode === true;
  const initReasonCodes = Array.isArray(initCodexResult && initCodexResult.verification && initCodexResult.verification.reason_codes)
    ? initCodexResult.verification.reason_codes
    : [];
  const initMissingSigningKey = initCodexResult
    && initCodexResult.verification
    && initCodexResult.verification.key_present === false
    && initReasonCodes.includes('codex_signing_key_missing');
  const initOk = initCodexResult.ok === true || (advisoryMode && initMissingSigningKey);
  const out = {
    ok: initOk,
    type: 'helix_init',
    ts: nowIso(),
    shadow_only: policy.shadow_only === true,
    codex_path: relPath(paths.codex_path),
    manifest_path: relPath(paths.manifest_path),
    codex_root_hash: codex.root_hash,
    merkle_root: manifest.merkle_root,
    strand_count: manifest.strand_count,
    reweave_snapshot: snapshot,
    policy: {
      version: policy.version,
      path: relPath(policyPath)
    },
    advisory_mode: {
      enabled: advisoryMode,
      codex_key_missing_override: advisoryMode && initMissingSigningKey
    }
  };
  writeJsonAtomic(paths.latest_path, out);
  emitEvent(paths, policy, 'init', {
    codex_root_hash: codex.root_hash,
    merkle_root: manifest.merkle_root,
    strand_count: manifest.strand_count
  });
  emitObsidianProjection(paths, policy, [
    '# Helix Initialized',
    '',
    `- Codex root: \`${codex.root_hash}\``,
    `- Strands: \`${manifest.strand_count}\``,
    `- Merkle root: \`${manifest.merkle_root}\``
  ].join('\n'));
  return out;
}

function commandAttest(args: AnyObj) {
  const policyPath = resolvePath(args.policy || process.env.HELIX_POLICY_PATH, DEFAULT_POLICY_PATH);
  const policy = loadPolicy(policyPath);
  if (toBool(args['force-malice'] || args.force_malice, false)) {
    policy.sentinel.force_confirmed_malice = true;
  }
  const paths = runtimePaths(policyPath, policy);
  if (!fs.existsSync(paths.codex_path)) {
    initCodex(paths.codex_path, policy, {
      overwrite: false,
      approval_note: 'auto_init_before_attestation'
    });
  }
  const codex = loadCodex(paths.codex_path);
  const codexVerificationRaw = verifyCodexRoot(codex, policy);
  const advisoryMode = policy && policy.advisory_mode === true;
  const missingSigningKey = codexVerificationRaw
    && codexVerificationRaw.key_present === false
    && Array.isArray(codexVerificationRaw.reason_codes)
    && codexVerificationRaw.reason_codes.includes('codex_signing_key_missing');
  const codexVerification = (advisoryMode && missingSigningKey)
    ? {
        ...codexVerificationRaw,
        ok: true,
        advisory_override: true,
        advisory_reason_codes: ['codex_signing_key_missing_advisory'],
        reason_codes: (Array.isArray(codexVerificationRaw.reason_codes)
          ? codexVerificationRaw.reason_codes
          : []
        ).filter((row: string) => String(row || '') !== 'codex_signing_key_missing')
      }
    : codexVerificationRaw;
  const previousManifest = readJson(paths.manifest_path, null);
  const baseManifest = previousManifest && typeof previousManifest === 'object'
    ? previousManifest
    : buildHelixManifest(codex, policy, { generated_at: nowIso() });
  if (!previousManifest || typeof previousManifest !== 'object') {
    writeJsonAtomic(paths.manifest_path, baseManifest);
  }
  const verifierBase = verifyHelixManifest(codex, baseManifest, policy);
  const manifestGeneratedAtMs = Date.parse(String(baseManifest && baseManifest.generated_at || ''));
  const manifestAgeMinutes = Number.isFinite(manifestGeneratedAtMs)
    ? Number(Math.max(0, (Date.now() - Number(manifestGeneratedAtMs)) / 60000).toFixed(3))
    : null;
  const maxManifestAgeMinutes = Number(policy && policy.sentinel && policy.sentinel.max_manifest_age_minutes || 1440);
  const manifestFresh = manifestAgeMinutes != null && manifestAgeMinutes <= maxManifestAgeMinutes;
  const verifier = (!manifestFresh)
    ? {
        ...verifierBase,
        ok: false,
        reason_codes: Array.from(new Set([...(verifierBase.reason_codes || []), 'manifest_stale'])),
        mismatches: (Array.isArray(verifierBase.mismatches) ? verifierBase.mismatches.slice(0) : []).concat([
          {
            type: 'manifest_stale',
            file: null,
            age_minutes: manifestAgeMinutes,
            max_age_minutes: maxManifestAgeMinutes
          }
        ])
      }
    : verifierBase;
  const sentinelBase = evaluateSentinel(verifier, codexVerification, policy, readSentinelState(paths));
  const resilience = evaluateSafetyResilience({
    source: 'helix_attestation',
    sentinel: sentinelBase,
    signals: {
      strand_mismatch: Array.isArray(verifier && verifier.mismatches) && verifier.mismatches.length > 0,
      codex_failure: codexVerification && codexVerification.ok === false,
      codex_signature_mismatch: Array.isArray(codexVerification && codexVerification.reason_codes)
        && codexVerification.reason_codes.includes('codex_signature_mismatch')
    }
  }, {
    apply: true
  });
  const sentinel = resilience && resilience.adjusted_sentinel && typeof resilience.adjusted_sentinel === 'object'
    ? resilience.adjusted_sentinel
    : sentinelBase;
  const hunter = planHunterActions(sentinel, policy);
  const quarantine = applyQuarantine(sentinel, verifier, policy, paths.quarantine_path);
  const permanentQuarantine = applyPermanentQuarantine({
    sentinel,
    verifier: {
      mismatch_count: Array.isArray(verifier && verifier.mismatches) ? verifier.mismatches.length : 0,
      reason_codes: verifier && verifier.reason_codes
    },
    codex_verification: codexVerification,
    hunter,
    confirmed_malice_score_threshold: policy
      && policy.sentinel
      && policy.sentinel.thresholds
      && policy.sentinel.thresholds.confirmed_malice_score,
    apply_requested: true
  }, {
    state_root: paths.state_dir
  });
  const reweave = planReweave(sentinel, verifier, policy, {
    reason: sentinel.tier === 'clear' ? 'routine_attestation' : 'integrity_mismatch'
  });
  const snapshotRefresh = (
    sentinel.tier === 'clear'
    && verifier.ok === true
    && manifestFresh === true
    && policy
    && policy.reweave
    && policy.reweave.snapshot_on_clear_attest === true
  )
    ? captureReweaveSnapshot(policy, {
        manifest_path: paths.manifest_path,
        codex_path: paths.codex_path
      })
    : null;
  const sentinelState = writeSentinelState(paths, sentinel);

  const attestationDecision = sentinel.tier === 'clear'
    ? 'allow'
    : (sentinel.tier === 'stasis' ? 'escalate' : 'deny');
  const out = {
    ok: sentinel.tier !== 'confirmed_malice',
    type: 'helix_attestation',
    ts: nowIso(),
    shadow_only: policy.shadow_only === true,
    attestation_decision: attestationDecision,
    codex_verification: codexVerification,
    verifier: {
      ok: verifier.ok,
      mismatch_count: Array.isArray(verifier.mismatches) ? verifier.mismatches.length : 0,
      reason_codes: verifier.reason_codes,
      mismatches: Array.isArray(verifier.mismatches) ? verifier.mismatches.slice(0, 5000) : []
    },
    manifest_freshness: {
      generated_at: baseManifest && baseManifest.generated_at ? String(baseManifest.generated_at) : null,
      age_minutes: manifestAgeMinutes,
      max_age_minutes: maxManifestAgeMinutes,
      fresh: manifestFresh === true
    },
    sentinel,
    safety_resilience: resilience,
    hunter,
    quarantine: quarantine.state,
    permanent_quarantine: permanentQuarantine && permanentQuarantine.state
      ? permanentQuarantine.state
      : {
          active: false,
          mode: 'idle'
        },
    reweave_plan: {
      plan_id: reweave.plan_id,
      strategy: reweave.strategy,
      step_count: Array.isArray(reweave.steps) ? reweave.steps.length : 0
    },
    reweave_snapshot: snapshotRefresh,
    paths: {
      codex_path: relPath(paths.codex_path),
      manifest_path: relPath(paths.manifest_path),
      latest_path: relPath(paths.latest_path)
    },
    integration: {
      eye_gate_mode: policy.integration && policy.integration.eye_gate_mode || 'shadow_advisory'
    },
    advisory_mode: {
      enabled: advisoryMode,
      codex_key_missing_override: advisoryMode && missingSigningKey
    }
  };
  const runDate = nowIso().slice(0, 10);
  const runPath = path.join(paths.runs_dir, `${runDate}.json`);
  writeJsonAtomic(runPath, out);
  writeJsonAtomic(paths.latest_path, out);
  emitEvent(paths, policy, 'attestation', {
    tier: sentinel.tier,
    attestation_decision: attestationDecision,
    mismatch_count: out.verifier.mismatch_count,
    codex_ok: codexVerification.ok === true,
    manifest_fresh: manifestFresh === true
  });
  emitEvent(paths, policy, 'sentinel_state', sentinelState);
  emitEvent(paths, policy, 'confirmed_malice_quarantine', {
    active: !!(permanentQuarantine && permanentQuarantine.state && permanentQuarantine.state.active),
    mode: cleanText(
      permanentQuarantine && permanentQuarantine.state && permanentQuarantine.state.mode,
      80
    ) || 'idle',
    tier: cleanText(
      permanentQuarantine && permanentQuarantine.state && permanentQuarantine.state.tier,
      80
    ) || 'clear'
  });
  emitObsidianProjection(paths, policy, [
    '# Helix Attestation',
    '',
    `- Decision: \`${attestationDecision}\``,
    `- Tier: \`${sentinel.tier}\``,
    `- Mismatches: \`${out.verifier.mismatch_count}\``,
    `- Permanent quarantine: \`${out.permanent_quarantine.mode}\``,
    `- Reweave strategy: \`${reweave.strategy}\``
  ].join('\n'));
  return out;
}

function commandReweave(args: AnyObj) {
  const policyPath = resolvePath(args.policy || process.env.HELIX_POLICY_PATH, DEFAULT_POLICY_PATH);
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const latest = readJson(paths.latest_path, null);
  const sentinel = latest && latest.sentinel ? latest.sentinel : { tier: 'clear' };
  const verifier = latest && latest.verifier ? {
    mismatches: Array.isArray(latest.verifier.mismatches) ? latest.verifier.mismatches : []
  } : { mismatches: [] };
  const plan = planReweave(sentinel, verifier, policy, {
    reason: args.reason || 'manual_reweave_request'
  });
  const applyRequested = toBool(args.apply, false);
  const applyResult = applyReweave(plan, verifier, policy, {
    apply: applyRequested,
    approval_note: args['approval-note'] || args.approval_note,
    manifest_path: paths.manifest_path,
    codex_path: paths.codex_path
  });
  const snapshot = (applyResult && applyResult.applied)
    ? captureReweaveSnapshot(policy, {
        manifest_path: paths.manifest_path,
        codex_path: paths.codex_path
      })
    : null;
  emitEvent(paths, policy, 'reweave_request', {
    plan_id: plan.plan_id,
    strategy: plan.strategy,
    tier: plan.tier,
    apply_requested: applyRequested
  });
  writeJsonAtomic(paths.latest_path, {
    ok: applyResult.ok !== false,
    type: 'helix_reweave',
    ts: nowIso(),
    shadow_only: policy.shadow_only === true,
    verifier: {
      mismatch_count: Array.isArray(verifier.mismatches) ? verifier.mismatches.length : 0,
      mismatches: Array.isArray(verifier.mismatches) ? verifier.mismatches.slice(0, 5000) : []
    },
    plan,
    apply_result: applyResult,
    reweave_snapshot: snapshot
  });
  return {
    ok: applyResult.ok !== false,
    type: 'helix_reweave',
    ts: nowIso(),
    shadow_only: policy.shadow_only === true,
    verifier: {
      mismatch_count: Array.isArray(verifier.mismatches) ? verifier.mismatches.length : 0,
      mismatches: Array.isArray(verifier.mismatches) ? verifier.mismatches.slice(0, 5000) : []
    },
    plan,
    apply_result: applyResult,
    reweave_snapshot: snapshot
  };
}

function commandStatus(args: AnyObj) {
  const policyPath = resolvePath(args.policy || process.env.HELIX_POLICY_PATH, DEFAULT_POLICY_PATH);
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const which = String(args._ && args._[0] || 'latest').trim().toLowerCase();
  const payload = which === 'latest'
    ? readJson(paths.latest_path, null)
    : readJson(path.join(paths.runs_dir, `${which}.json`), null);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      type: 'helix_status',
      error: 'helix_snapshot_missing',
      requested: which
    };
  }
  return {
    ok: true,
    type: 'helix_status',
    ts: String(payload.ts || ''),
    attestation_decision: String(payload.attestation_decision || 'unknown'),
    tier: String(payload.sentinel && payload.sentinel.tier || 'unknown'),
    mismatch_count: Number(payload.verifier && payload.verifier.mismatch_count || 0),
    shadow_only: payload.shadow_only === true,
    policy: {
      version: policy.version,
      path: relPath(policyPath)
    }
  };
}

function commandBaseline(args: AnyObj) {
  const policyPath = resolvePath(args.policy || process.env.HELIX_POLICY_PATH, DEFAULT_POLICY_PATH);
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  if (!fs.existsSync(paths.codex_path)) {
    initCodex(paths.codex_path, policy, {
      overwrite: false,
      approval_note: 'auto_init_before_baseline'
    });
  }
  const codex = loadCodex(paths.codex_path);
  const codexVerificationRaw = verifyCodexRoot(codex, policy);
  const advisoryMode = policy && policy.advisory_mode === true;
  const keyMissingOnly = codexVerificationRaw
    && codexVerificationRaw.key_present === false
    && Array.isArray(codexVerificationRaw.reason_codes)
    && codexVerificationRaw.reason_codes.includes('codex_signing_key_missing');
  const codexOk = codexVerificationRaw.ok === true || (advisoryMode && keyMissingOnly);
  const manifest = readJson(paths.manifest_path, null);
  const snapshotPath = resolvePath(policy.reweave && policy.reweave.snapshot_path, 'state/helix/reweave_snapshot.json');
  let snapshot = readJson(snapshotPath, {});
  const manifestStrands = Number(manifest && manifest.strand_count || 0);
  let snapshotFiles = Number(snapshot && snapshot.file_count || 0);
  let snapshotRefreshed = false;
  if (manifestStrands > 0 && snapshotFiles < manifestStrands) {
    captureReweaveSnapshot(policy, {
      manifest_path: paths.manifest_path,
      codex_path: paths.codex_path
    });
    snapshot = readJson(snapshotPath, {});
    snapshotFiles = Number(snapshot && snapshot.file_count || 0);
    snapshotRefreshed = true;
  }
  const reasons: string[] = [];
  if (!codexOk) reasons.push('codex_verification_failed');
  if (!(manifest && manifestStrands > 0)) reasons.push('manifest_missing_or_empty');
  if (!(snapshot && snapshotFiles > 0)) reasons.push('reweave_snapshot_missing_or_empty');
  if (policy.shadow_only !== true) reasons.push('shadow_mode_disabled');
  return {
    ok: reasons.length === 0,
    type: 'helix_baseline_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      path: relPath(policyPath),
      shadow_only: policy.shadow_only === true
    },
    codex: {
      path: relPath(paths.codex_path),
      root_hash: codex.root_hash || null,
      verified: codexOk,
      advisory_override: advisoryMode && keyMissingOnly
    },
    manifest: {
      path: relPath(paths.manifest_path),
      strand_count: manifestStrands,
      merkle_root: manifest && manifest.merkle_root ? String(manifest.merkle_root) : null
    },
    snapshot: {
      path: relPath(snapshotPath),
      file_count: snapshotFiles,
      refreshed: snapshotRefreshed
    },
    reasons
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/helix/helix_controller.js init [--policy=path] [--overwrite=1]');
  console.log('  node systems/helix/helix_controller.js attest [--policy=path] [--force-malice=1]');
  console.log('  node systems/helix/helix_controller.js reweave [--policy=path] [--reason="..."] [--apply=1|0] [--approval-note="..."]');
  console.log('  node systems/helix/helix_controller.js status [latest|YYYY-MM-DD] [--policy=path]');
  console.log('  node systems/helix/helix_controller.js baseline [--policy=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  let out: AnyObj;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    return;
  }
  if (cmd === 'init') out = commandInit(args);
  else if (cmd === 'attest') out = commandAttest(args);
  else if (cmd === 'reweave') out = commandReweave(args);
  else if (cmd === 'baseline') out = commandBaseline(args);
  else if (cmd === 'status') {
    args._ = args._.slice(1);
    out = commandStatus(args);
  } else {
    out = {
      ok: false,
      type: 'helix_controller',
      error: `unknown_command:${cmd}`
    };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out && out.ok === false) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'helix_controller',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'helix_failed', 260)
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  commandInit,
  commandAttest,
  commandReweave,
  commandStatus,
  commandBaseline
};
