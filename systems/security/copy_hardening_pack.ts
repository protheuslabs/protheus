#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-CPY-002..008 implementation pack.
 * Defensive-only copy/reverse-engineering hardening controls.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  clampNumber,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.COPY_HARDENING_PACK_POLICY_PATH
  ? path.resolve(process.env.COPY_HARDENING_PACK_POLICY_PATH)
  : path.join(ROOT, 'config', 'copy_hardening_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/copy_hardening_pack.js diversify-build --instance-id=<id> [--release=<tag>] [--apply=0|1]');
  console.log('  node systems/security/copy_hardening_pack.js watermark-mesh --artifact-id=<id> [--runtime-fingerprint=<fp>] [--apply=0|1]');
  console.log('  node systems/security/copy_hardening_pack.js trust-degrade --trust-score=<0..1> [--apply=0|1]');
  console.log('  node systems/security/copy_hardening_pack.js module-seal --module-id=<id> --module-path=<path> [--apply=0|1]');
  console.log('  node systems/security/copy_hardening_pack.js module-unseal --module-id=<id> [--apply=0|1]');
  console.log('  node systems/security/copy_hardening_pack.js instrumentation-scan [--apply=0|1]');
  console.log('  node systems/security/copy_hardening_pack.js honey-trap --trap-id=<id> [--touch=0|1] [--apply=0|1]');
  console.log('  node systems/security/copy_hardening_pack.js clone-risk-score [--device-id=id] [--geo=US] [--concurrency=1] [--lease-drift=0.0] [--apply=0|1]');
  console.log('  node systems/security/copy_hardening_pack.js status');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    trust_degrade_bands: {
      full: 0.9,
      reduced: 0.7,
      read_only: 0.5,
      sandbox_only: 0.25
    },
    module_crypto: {
      algorithm: 'aes-256-gcm',
      key_seed: 'copy_hardening_seed_change_me'
    },
    instrumentation_markers: ['--inspect', '--inspect-brk', 'frida', 'ptrace', 'gdb', 'lldb', 'LD_PRELOAD'],
    paths: {
      latest_path: 'state/security/copy_hardening_pack/latest.json',
      receipts_path: 'state/security/copy_hardening_pack/receipts.jsonl',
      state_path: 'state/security/copy_hardening_pack/state.json',
      variants_path: 'state/security/copy_hardening_pack/variants.json',
      watermarks_path: 'state/security/copy_hardening_pack/watermarks.jsonl',
      modules_path: 'state/security/copy_hardening_pack/modules.json',
      honey_events_path: 'state/security/copy_hardening_pack/honey_events.jsonl',
      forensic_path: 'state/security/copy_hardening_pack/forensics.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const bands = raw.trust_degrade_bands && typeof raw.trust_degrade_bands === 'object' ? raw.trust_degrade_bands : {};
  const moduleCrypto = raw.module_crypto && typeof raw.module_crypto === 'object' ? raw.module_crypto : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};

  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    trust_degrade_bands: {
      full: clampNumber(bands.full, 0, 1, base.trust_degrade_bands.full),
      reduced: clampNumber(bands.reduced, 0, 1, base.trust_degrade_bands.reduced),
      read_only: clampNumber(bands.read_only, 0, 1, base.trust_degrade_bands.read_only),
      sandbox_only: clampNumber(bands.sandbox_only, 0, 1, base.trust_degrade_bands.sandbox_only)
    },
    module_crypto: {
      algorithm: cleanText(moduleCrypto.algorithm || base.module_crypto.algorithm, 40),
      key_seed: cleanText(moduleCrypto.key_seed || base.module_crypto.key_seed, 200)
    },
    instrumentation_markers: (Array.isArray(raw.instrumentation_markers) ? raw.instrumentation_markers : base.instrumentation_markers)
      .map((v) => cleanText(v, 120))
      .filter(Boolean),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      variants_path: resolvePath(paths.variants_path, base.paths.variants_path),
      watermarks_path: resolvePath(paths.watermarks_path, base.paths.watermarks_path),
      modules_path: resolvePath(paths.modules_path, base.paths.modules_path),
      honey_events_path: resolvePath(paths.honey_events_path, base.paths.honey_events_path),
      forensic_path: resolvePath(paths.forensic_path, base.paths.forensic_path)
    }
  };
}

function loadState(policy) {
  const state = readJson(policy.paths.state_path, {});
  return {
    schema_id: 'copy_hardening_pack_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    degrade_mode: normalizeToken(state.degrade_mode || 'full', 32) || 'full',
    last_risk_score: clampNumber(state.last_risk_score, 0, 1, 0),
    instrumentation_events: clampInt(state.instrumentation_events, 0, 1_000_000, 0),
    honey_hits: clampInt(state.honey_hits, 0, 1_000_000, 0)
  };
}

function saveState(policy, state) {
  writeJsonAtomic(policy.paths.state_path, { ...state, updated_at: nowIso() });
}

function receipt(policy, row) {
  const payload = {
    ts: nowIso(),
    ok: true,
    shadow_only: policy.shadow_only,
    ...row
  };
  writeJsonAtomic(policy.paths.latest_path, payload);
  appendJsonl(policy.paths.receipts_path, payload);
  return payload;
}

function loadVariants(policy) {
  const db = readJson(policy.paths.variants_path, { variants: [] });
  return Array.isArray(db.variants) ? db.variants : [];
}

function saveVariants(policy, variants) {
  writeJsonAtomic(policy.paths.variants_path, { variants });
}

function getKey(policy) {
  return crypto.createHash('sha256').update(String(policy.module_crypto.key_seed || ''), 'utf8').digest();
}

function encryptText(policy, plaintext) {
  const key = getKey(policy);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(policy.module_crypto.algorithm, key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: enc.toString('hex')
  };
}

function decryptText(policy, payload) {
  const key = getKey(policy);
  const iv = Buffer.from(String(payload.iv || ''), 'hex');
  const tag = Buffer.from(String(payload.tag || ''), 'hex');
  const data = Buffer.from(String(payload.ciphertext || ''), 'hex');
  const decipher = crypto.createDecipheriv(policy.module_crypto.algorithm, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

function diversifyBuild(args, policy) {
  const apply = toBool(args.apply, false);
  const instanceId = normalizeToken(args['instance-id'] || args.instance_id || 'default', 120) || 'default';
  const release = cleanText(args.release || 'current', 64);
  const variantId = `var_${stableHash(`${instanceId}|${release}|${Date.now()}`, 18)}`;
  const variant = {
    variant_id: variantId,
    instance_id: instanceId,
    release,
    generated_at: nowIso(),
    layout_salt: stableHash(`${variantId}|layout`, 16),
    const_salt: stableHash(`${variantId}|const`, 16),
    pack_salt: stableHash(`${variantId}|pack`, 16),
    provenance_hash: stableHash(`${variantId}|provenance`, 24)
  };

  if (apply) {
    const variants = loadVariants(policy);
    variants.push(variant);
    saveVariants(policy, variants);
  }

  return receipt(policy, {
    type: 'cpy_per_instance_polymorphic_build',
    apply,
    variant
  });
}

function watermarkMesh(args, policy) {
  const apply = toBool(args.apply, false);
  const artifactId = cleanText(args['artifact-id'] || args.artifact_id || '', 140);
  if (!artifactId) return { ok: false, error: 'artifact_id_required' };
  const runtimeFingerprint = cleanText(args['runtime-fingerprint'] || args.runtime_fingerprint || 'unknown', 140);
  const watermark = {
    watermark_id: `wm_${stableHash(`${artifactId}|${runtimeFingerprint}|${Date.now()}`, 18)}`,
    artifact_id: artifactId,
    runtime_fingerprint: runtimeFingerprint,
    receipt_chain: stableHash(`${artifactId}|receipt_chain`, 24),
    generated_at: nowIso()
  };
  if (apply) appendJsonl(policy.paths.watermarks_path, watermark);
  return receipt(policy, {
    type: 'cpy_forensic_watermark_mesh',
    apply,
    watermark
  });
}

function trustDegrade(args, policy) {
  const apply = toBool(args.apply, false);
  const score = clampNumber(args['trust-score'] || args.trust_score, 0, 1, 0);
  let mode = 'full';
  if (score < policy.trust_degrade_bands.sandbox_only) mode = 'sandbox_only';
  else if (score < policy.trust_degrade_bands.read_only) mode = 'read_only';
  else if (score < policy.trust_degrade_bands.reduced) mode = 'reduced';

  if (apply) {
    const state = loadState(policy);
    state.degrade_mode = mode;
    saveState(policy, state);
  }

  return receipt(policy, {
    type: 'cpy_trust_drift_graceful_degrade',
    apply,
    trust_score: score,
    degrade_mode: mode,
    allowed_caps: mode === 'full'
      ? ['all']
      : mode === 'reduced'
        ? ['core_read', 'sandbox_exec', 'local_queue']
        : mode === 'read_only'
          ? ['core_read']
          : ['sandbox_exec']
  });
}

function moduleSeal(args, policy) {
  const apply = toBool(args.apply, false);
  const moduleId = normalizeToken(args['module-id'] || args.module_id || '', 120);
  const modulePath = args['module-path'] ? path.resolve(String(args['module-path'])) : (args.module_path ? path.resolve(String(args.module_path)) : '');
  if (!moduleId || !modulePath) return { ok: false, error: 'module_id_and_path_required' };
  if (!fs.existsSync(modulePath)) return { ok: false, error: 'module_path_not_found' };

  const plaintext = fs.readFileSync(modulePath, 'utf8');
  const encrypted = encryptText(policy, plaintext);
  const modules = readJson(policy.paths.modules_path, { modules: {} });
  const table = modules.modules && typeof modules.modules === 'object' ? modules.modules : {};
  table[moduleId] = {
    ...encrypted,
    sealed_at: nowIso(),
    module_hash: stableHash(plaintext, 24),
    source_path: modulePath
  };

  if (apply) writeJsonAtomic(policy.paths.modules_path, { modules: table });

  return receipt(policy, {
    type: 'cpy_encrypted_module_delivery_seal',
    apply,
    module_id: moduleId,
    sealed: true,
    ciphertext_hash: stableHash(encrypted.ciphertext, 24)
  });
}

function moduleUnseal(args, policy) {
  const apply = toBool(args.apply, false);
  const moduleId = normalizeToken(args['module-id'] || args.module_id || '', 120);
  if (!moduleId) return { ok: false, error: 'module_id_required' };
  const modules = readJson(policy.paths.modules_path, { modules: {} });
  const table = modules.modules && typeof modules.modules === 'object' ? modules.modules : {};
  const row = table[moduleId];
  if (!row) return { ok: false, error: 'module_not_found' };

  let plaintext = '';
  try {
    plaintext = decryptText(policy, row);
  } catch {
    return { ok: false, error: 'module_unseal_failed' };
  }

  const transientHash = stableHash(`${moduleId}|${Date.now()}|${plaintext.length}`, 24);
  if (apply) {
    appendJsonl(policy.paths.forensic_path, {
      ts: nowIso(),
      type: 'module_unseal_event',
      module_id: moduleId,
      transient_hash: transientHash,
      persisted_plaintext: false
    });
  }

  return receipt(policy, {
    type: 'cpy_encrypted_module_delivery_unseal',
    apply,
    module_id: moduleId,
    unsealed: true,
    plaintext_length: plaintext.length,
    persisted_plaintext: false,
    transient_hash: transientHash
  });
}

function instrumentationScan(args, policy) {
  const apply = toBool(args.apply, false);
  const argv = process.argv.join(' ').toLowerCase();
  const envBlob = JSON.stringify(process.env).toLowerCase();
  const hits = [];
  for (const marker of policy.instrumentation_markers) {
    const m = String(marker || '').toLowerCase();
    if (!m) continue;
    if (argv.includes(m) || envBlob.includes(m)) hits.push(m);
  }

  let response = 'allow';
  if (hits.length) response = 'alert';
  if (hits.length >= 2) response = 'degrade';
  if (hits.length >= 4) response = 'quarantine';

  if (apply && hits.length) {
    const state = loadState(policy);
    state.instrumentation_events += 1;
    saveState(policy, state);
    appendJsonl(policy.paths.forensic_path, {
      ts: nowIso(),
      type: 'instrumentation_detection',
      hits,
      response
    });
  }

  return receipt(policy, {
    type: 'cpy_instrumentation_detection',
    apply,
    hits,
    response,
    ok: response !== 'quarantine'
  });
}

function honeyTrap(args, policy) {
  const apply = toBool(args.apply, false);
  const trapId = normalizeToken(args['trap-id'] || args.trap_id || '', 120);
  if (!trapId) return { ok: false, error: 'trap_id_required' };
  const touch = toBool(args.touch, false);

  const row = {
    ts: nowIso(),
    trap_id: trapId,
    touched: touch,
    confidence: touch ? 0.99 : 0.1,
    reason: touch ? 'honey_capability_invoked' : 'honey_capability_armed'
  };

  if (apply) {
    appendJsonl(policy.paths.honey_events_path, row);
    if (touch) {
      const state = loadState(policy);
      state.honey_hits += 1;
      saveState(policy, state);
      appendJsonl(policy.paths.forensic_path, {
        ts: nowIso(),
        type: 'honey_trap_touch',
        trap_id: trapId,
        confidence: 0.99
      });
    }
  }

  return receipt(policy, {
    type: 'cpy_honey_capability_trap',
    apply,
    ...row
  });
}

function cloneRiskScore(args, policy) {
  const apply = toBool(args.apply, false);
  const deviceId = cleanText(args['device-id'] || args.device_id || 'unknown', 120);
  const geo = cleanText(args.geo || 'unknown', 32).toUpperCase();
  const concurrency = clampInt(args.concurrency, 1, 10_000, 1);
  const leaseDrift = clampNumber(args['lease-drift'] || args.lease_drift, 0, 1, 0);

  let risk = 0;
  risk += Math.min(0.4, concurrency / 25);
  risk += leaseDrift * 0.5;
  if (deviceId === 'unknown') risk += 0.1;
  if (geo === 'UNKNOWN') risk += 0.05;
  risk = Math.min(1, Number(risk.toFixed(4)));

  let action = 'allow';
  if (risk >= 0.35) action = 'throttle';
  if (risk >= 0.6) action = 'restrict';
  if (risk >= 0.85) action = 'revoke';

  if (apply) {
    const state = loadState(policy);
    state.last_risk_score = risk;
    saveState(policy, state);
  }

  return receipt(policy, {
    type: 'cpy_clone_risk_behavioral_engine',
    apply,
    signals: { device_id: deviceId, geo, concurrency, lease_drift: leaseDrift },
    risk_score: risk,
    action,
    explainable_factors: ['concurrency', 'lease_drift', 'device_id_presence', 'geo_presence']
  });
}

function status(policy) {
  return {
    ok: true,
    type: 'copy_hardening_pack_status',
    shadow_only: policy.shadow_only,
    latest: readJson(policy.paths.latest_path, {}),
    state: loadState(policy)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'copy_hardening_pack_disabled' }, 1);

  if (cmd === 'diversify-build') emit(diversifyBuild(args, policy));
  if (cmd === 'watermark-mesh') {
    const out = watermarkMesh(args, policy);
    emit(out, out.ok === false ? 1 : 0);
  }
  if (cmd === 'trust-degrade') emit(trustDegrade(args, policy));
  if (cmd === 'module-seal') {
    const out = moduleSeal(args, policy);
    emit(out, out.ok === false ? 1 : 0);
  }
  if (cmd === 'module-unseal') {
    const out = moduleUnseal(args, policy);
    emit(out, out.ok === false ? 1 : 0);
  }
  if (cmd === 'instrumentation-scan') emit(instrumentationScan(args, policy));
  if (cmd === 'honey-trap') {
    const out = honeyTrap(args, policy);
    emit(out, out.ok === false ? 1 : 0);
  }
  if (cmd === 'clone-risk-score') emit(cloneRiskScore(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: 'unknown_command', cmd }, 2);
}

if (require.main === module) {
  main();
}
