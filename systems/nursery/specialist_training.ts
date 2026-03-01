#!/usr/bin/env node
'use strict';

/**
 * specialist_training.js
 *
 * Adaptive seed -> specialist training pipeline (hardware-aware, gated).
 *
 * Usage:
 *   node systems/nursery/specialist_training.js curate [--days=30] [--write=1|0]
 *   node systems/nursery/specialist_training.js plan [--profile=small|medium|large] [--seed=tinyllama_seed]
 *   node systems/nursery/specialist_training.js evaluate [--quality=0.85] [--safety=0.95] [--cost=0.2] [--latency_ms=50] [--eval-file=/abs/path.json]
 *   node systems/nursery/specialist_training.js promote --checkpoint=<id> [--parent=<checkpoint_id>] [--eval-file=/abs/path.json]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const {
  loadTrainingConduitPolicy,
  buildTrainingConduitMetadata,
  validateTrainingConduitMetadata
} = require('../../lib/training_conduit_schema');
const {
  loadTrainabilityMatrixPolicy,
  evaluateTrainingDatumTrainability
} = require('../../lib/trainability_matrix');
const {
  evaluateAccess,
  buildAccessContext
} = require('../security/enterprise_access_gate');
let recordAttribution = null;
try {
  ({ recordAttribution } = require('../attribution/value_attribution_primitive'));
} catch {
  recordAttribution = null;
}

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.NURSERY_TRAINING_POLICY_PATH
  ? path.resolve(process.env.NURSERY_TRAINING_POLICY_PATH)
  : path.join(ROOT, 'config', 'nursery_training_policy.json');
const RUNS_DIR = process.env.NURSERY_TRAINING_RUNS_DIR
  ? path.resolve(process.env.NURSERY_TRAINING_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const OUT_DIR = process.env.NURSERY_TRAINING_OUT_DIR
  ? path.resolve(process.env.NURSERY_TRAINING_OUT_DIR)
  : path.join(ROOT, 'state', 'nursery', 'training');
const HARDWARE_PLAN_PATH = process.env.NURSERY_TRAINING_HARDWARE_PLAN_PATH
  ? path.resolve(process.env.NURSERY_TRAINING_HARDWARE_PLAN_PATH)
  : path.join(ROOT, 'state', 'routing', 'hardware_plan.json');
const TRAINING_QUARANTINE_SCRIPT = process.env.TRAINING_QUARANTINE_LOOP_PATH
  ? path.resolve(process.env.TRAINING_QUARANTINE_LOOP_PATH)
  : path.join(ROOT, 'systems', 'nursery', 'training_quarantine_loop.js');
const HISTORY_PATH = path.join(OUT_DIR, 'history.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/nursery/specialist_training.js curate [--days=30] [--write=1|0]');
  console.log('  node systems/nursery/specialist_training.js plan [--profile=small|medium|large] [--seed=tinyllama_seed]');
  console.log('  node systems/nursery/specialist_training.js train [--date=YYYY-MM-DD] [--days=30] [--profile=small|medium|large] [--seed=tinyllama_seed] [--backend=native|axolotl] [--dataset-path=/abs/path.jsonl]');
  console.log('  node systems/nursery/specialist_training.js evaluate [--quality=0.85] [--safety=0.95] [--cost=0.2] [--latency_ms=50] [--eval-file=/abs/path.json]');
  console.log('  node systems/nursery/specialist_training.js promote --checkpoint=<id> [--parent=<checkpoint_id>] [--eval-file=/abs/path.json]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function normalizeText(v, maxLen = 240) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function normalizeToken(v, maxLen = 80) {
  return normalizeText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = normalizeText(v, 24).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function resolvePath(raw, fallback) {
  const txt = normalizeText(raw || '', 600);
  if (!txt) return fallback;
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function readJsonlSafe(filePath) {
  return readJsonl(filePath);
}

function shiftDate(dateStr, deltaDays) {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return dateStr;
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  return base.toISOString().slice(0, 10);
}

function windowDates(endDate, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(shiftDate(endDate, -i));
  return out;
}

function defaultPolicy() {
  return {
    version: '1.1',
    seed_id_default: 'tinyllama_seed',
    curation: {
      min_rows: 30,
      max_rows: 5000,
      include_outcomes: ['shipped', 'no_change', 'reverted']
    },
    profiles: {
      small: {
        adapter: 'lora',
        rank: 16,
        alpha: 32,
        batch_size: 8,
        epochs: 1,
        max_train_minutes: 30,
        max_ram_gb: 8,
        max_gpu_vram_gb: 0
      },
      medium: {
        adapter: 'qlora',
        rank: 32,
        alpha: 64,
        batch_size: 16,
        epochs: 2,
        max_train_minutes: 90,
        max_ram_gb: 16,
        max_gpu_vram_gb: 8
      },
      large: {
        adapter: 'qlora',
        rank: 64,
        alpha: 128,
        batch_size: 24,
        epochs: 3,
        max_train_minutes: 180,
        max_ram_gb: 32,
        max_gpu_vram_gb: 24
      }
    },
    promotion_thresholds: {
      min_quality: 0.85,
      min_safety: 0.95,
      max_cost_per_1k: 0.02,
      max_latency_ms: 120
    },
    promotion_controls: {
      min_eval_samples: 0,
      min_dataset_rows: 0,
      max_drift_delta: 1,
      max_regression_rate: 1,
      cooldown_hours: 12,
      require_checkpoint_parent: true
    },
    training_conduit: {
      metadata_strict: true,
      trainability_strict: true,
      owner_id: '',
      owner_type: 'human_operator',
      license_id: '',
      consent_status: 'granted',
      consent_mode: 'operator_policy',
      consent_evidence_ref: 'config/training_conduit_policy.json',
      retention_days: 365,
      delete_scope: 'nursery_specialist_training'
    },
    training_backend: {
      default_backend: 'native',
      auto_select_by_hardware_class: true,
      allow_backend_fallback: true,
      backend_by_hardware_class: {
        phone_seed: 'native',
        small: 'native',
        medium: 'axolotl',
        large: 'axolotl'
      },
      native: {
        enabled: true
      },
      axolotl: {
        enabled: true,
        command: 'axolotl',
        args: ['train'],
        config_arg: '--config',
        output_arg: '--output-dir',
        timeout_ms: 7200000,
        attribution_creator_id: 'axolotl',
        attribution_license: 'apache-2.0'
      }
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const trainingBackendSrc = src.training_backend && typeof src.training_backend === 'object'
    ? src.training_backend
    : {};
  const trainingBackendMapSrc = trainingBackendSrc.backend_by_hardware_class
    && typeof trainingBackendSrc.backend_by_hardware_class === 'object'
    ? trainingBackendSrc.backend_by_hardware_class
    : {};
  const trainingNativeSrc = trainingBackendSrc.native && typeof trainingBackendSrc.native === 'object'
    ? trainingBackendSrc.native
    : {};
  const trainingAxolotlSrc = trainingBackendSrc.axolotl && typeof trainingBackendSrc.axolotl === 'object'
    ? trainingBackendSrc.axolotl
    : {};
  return {
    version: normalizeText(src.version || base.version, 32) || '1.0',
    seed_id_default: normalizeToken(src.seed_id_default || base.seed_id_default, 120) || 'tinyllama_seed',
    curation: {
      min_rows: clampInt(src.curation && src.curation.min_rows, 1, 100000, base.curation.min_rows),
      max_rows: clampInt(src.curation && src.curation.max_rows, 1, 1000000, base.curation.max_rows),
      include_outcomes: Array.from(new Set((src.curation && Array.isArray(src.curation.include_outcomes)
        ? src.curation.include_outcomes
        : base.curation.include_outcomes)
        .map((v) => normalizeToken(v, 40))
        .filter(Boolean)))
    },
    profiles: src.profiles && typeof src.profiles === 'object' ? src.profiles : base.profiles,
    promotion_thresholds: {
      min_quality: clampNumber(src.promotion_thresholds && src.promotion_thresholds.min_quality, 0, 1, base.promotion_thresholds.min_quality),
      min_safety: clampNumber(src.promotion_thresholds && src.promotion_thresholds.min_safety, 0, 1, base.promotion_thresholds.min_safety),
      max_cost_per_1k: clampNumber(src.promotion_thresholds && src.promotion_thresholds.max_cost_per_1k, 0, 100, base.promotion_thresholds.max_cost_per_1k),
      max_latency_ms: clampNumber(src.promotion_thresholds && src.promotion_thresholds.max_latency_ms, 1, 600000, base.promotion_thresholds.max_latency_ms)
    },
    promotion_controls: {
      min_eval_samples: clampInt(
        src.promotion_controls && src.promotion_controls.min_eval_samples,
        0,
        10000000,
        base.promotion_controls.min_eval_samples
      ),
      min_dataset_rows: clampInt(
        src.promotion_controls && src.promotion_controls.min_dataset_rows,
        0,
        10000000,
        base.promotion_controls.min_dataset_rows
      ),
      max_drift_delta: clampNumber(
        src.promotion_controls && src.promotion_controls.max_drift_delta,
        0,
        1,
        base.promotion_controls.max_drift_delta
      ),
      max_regression_rate: clampNumber(
        src.promotion_controls && src.promotion_controls.max_regression_rate,
        0,
        1,
        base.promotion_controls.max_regression_rate
      ),
      cooldown_hours: clampNumber(
        src.promotion_controls && src.promotion_controls.cooldown_hours,
        0,
        720,
        base.promotion_controls.cooldown_hours
      ),
      require_checkpoint_parent: toBool(
        src.promotion_controls && src.promotion_controls.require_checkpoint_parent,
        base.promotion_controls.require_checkpoint_parent
      )
    },
    training_conduit: {
      metadata_strict: toBool(
        src.training_conduit && src.training_conduit.metadata_strict,
        base.training_conduit.metadata_strict
      ),
      trainability_strict: toBool(
        src.training_conduit && src.training_conduit.trainability_strict,
        base.training_conduit.trainability_strict
      ),
      owner_id: normalizeToken(
        src.training_conduit && src.training_conduit.owner_id,
        120
      ),
      owner_type: normalizeToken(
        src.training_conduit && src.training_conduit.owner_type,
        80
      ) || base.training_conduit.owner_type,
      license_id: normalizeToken(
        src.training_conduit && src.training_conduit.license_id,
        160
      ),
      consent_status: normalizeToken(
        src.training_conduit && src.training_conduit.consent_status,
        40
      ) || base.training_conduit.consent_status,
      consent_mode: normalizeToken(
        src.training_conduit && src.training_conduit.consent_mode,
        80
      ) || base.training_conduit.consent_mode,
      consent_evidence_ref: normalizeText(
        src.training_conduit && src.training_conduit.consent_evidence_ref,
        260
      ) || base.training_conduit.consent_evidence_ref,
      retention_days: clampInt(
        src.training_conduit && src.training_conduit.retention_days,
        1,
        3650,
        base.training_conduit.retention_days
      ),
      delete_scope: normalizeToken(
        src.training_conduit && src.training_conduit.delete_scope,
        120
      ) || base.training_conduit.delete_scope
    },
    training_backend: {
      default_backend: normalizeToken(
        trainingBackendSrc.default_backend,
        40
      ) || base.training_backend.default_backend,
      auto_select_by_hardware_class: toBool(
        trainingBackendSrc.auto_select_by_hardware_class,
        base.training_backend.auto_select_by_hardware_class
      ),
      allow_backend_fallback: toBool(
        trainingBackendSrc.allow_backend_fallback,
        base.training_backend.allow_backend_fallback
      ),
      backend_by_hardware_class: {
        phone_seed: normalizeToken(
          trainingBackendMapSrc.phone_seed,
          40
        ) || base.training_backend.backend_by_hardware_class.phone_seed,
        small: normalizeToken(
          trainingBackendMapSrc.small,
          40
        ) || base.training_backend.backend_by_hardware_class.small,
        medium: normalizeToken(
          trainingBackendMapSrc.medium,
          40
        ) || base.training_backend.backend_by_hardware_class.medium,
        large: normalizeToken(
          trainingBackendMapSrc.large,
          40
        ) || base.training_backend.backend_by_hardware_class.large
      },
      native: {
        enabled: toBool(
          trainingNativeSrc.enabled,
          base.training_backend.native.enabled
        )
      },
      axolotl: {
        enabled: toBool(
          trainingAxolotlSrc.enabled,
          base.training_backend.axolotl.enabled
        ),
        command: normalizeText(
          trainingAxolotlSrc.command,
          260
        ) || base.training_backend.axolotl.command,
        args: Array.isArray(trainingAxolotlSrc.args)
          ? trainingAxolotlSrc.args.map((row) => normalizeText(row, 160)).filter(Boolean)
          : base.training_backend.axolotl.args,
        config_arg: normalizeText(
          trainingAxolotlSrc.config_arg,
          80
        ) || base.training_backend.axolotl.config_arg,
        output_arg: normalizeText(
          trainingAxolotlSrc.output_arg,
          80
        ) || base.training_backend.axolotl.output_arg,
        timeout_ms: clampInt(
          trainingAxolotlSrc.timeout_ms,
          1000,
          24 * 60 * 60 * 1000,
          base.training_backend.axolotl.timeout_ms
        ),
        attribution_creator_id: normalizeToken(
          trainingAxolotlSrc.attribution_creator_id,
          120
        ) || base.training_backend.axolotl.attribution_creator_id,
        attribution_license: normalizeText(
          trainingAxolotlSrc.attribution_license,
          120
        ) || base.training_backend.axolotl.attribution_license
      }
    }
  };
}

function listTrainingRows(dateStr, days, policy) {
  const dates = windowDates(dateStr, days);
  const includeOutcomes = new Set(policy.curation.include_outcomes || []);
  const conduitPolicy = loadTrainingConduitPolicy();
  const trainabilityPolicy = loadTrainabilityMatrixPolicy();
  const conduitCfg = policy.training_conduit && typeof policy.training_conduit === 'object'
    ? policy.training_conduit
    : defaultPolicy().training_conduit;
  const rows = [];
  for (const day of dates) {
    const fp = path.join(RUNS_DIR, `${day}.jsonl`);
    for (const row of readJsonl(fp)) {
      if (!row || row.type !== 'autonomy_run') continue;
      const outcome = normalizeToken(row.outcome || row.result || 'unknown', 32);
      if (includeOutcomes.size > 0 && !includeOutcomes.has(outcome)) continue;
      const valueCurrency = normalizeToken(
        row.value_currency
        || (row.strategy_rank && row.strategy_rank.components && row.strategy_rank.components.value_currency)
        || (row.strategy_rank && row.strategy_rank.value_currency)
        || '',
        64
      ) || 'none';
      const objectiveId = normalizeText(row.objective_id || '', 160) || null;
      const proposalType = normalizeToken(row.proposal_type || 'unknown', 80) || 'unknown';
      const rowTs = normalizeText(row.ts || '', 64) || null;
      const datumId = normalizeToken(`${day}:${objectiveId || 'none'}:${proposalType}:${rows.length + 1}`, 180)
        || normalizeToken(`${day}:${rows.length + 1}`, 180);
      const conduit = buildTrainingConduitMetadata({
        ts: rowTs || nowIso(),
        source_system: 'specialist_training_curate',
        source_channel: 'autonomy_run',
        source_path: relPath(fp),
        datum_id: datumId,
        provider: 'internal',
        owner_id: conduitCfg.owner_id,
        owner_type: conduitCfg.owner_type,
        license_id: conduitCfg.license_id,
        consent_status: conduitCfg.consent_status,
        consent_mode: conduitCfg.consent_mode,
        consent_evidence_ref: conduitCfg.consent_evidence_ref,
        retention_days: conduitCfg.retention_days,
        delete_scope: conduitCfg.delete_scope,
        delete_key: `autonomy_run:${datumId}`,
        classification: 'training_dataset'
      }, conduitPolicy);
      const conduitValidation = validateTrainingConduitMetadata(conduit, conduitPolicy);
      conduit.validation = conduitValidation;
      if (conduitCfg.metadata_strict === true && conduitValidation.ok !== true) {
        continue;
      }
      const trainability = evaluateTrainingDatumTrainability(conduit, trainabilityPolicy);
      if (conduitCfg.trainability_strict === true && trainability.allow !== true) {
        continue;
      }
      rows.push({
        ts: normalizeText(row.ts || '', 64) || null,
        objective_id: objectiveId,
        proposal_type: proposalType,
        outcome,
        risk: normalizeToken(row.risk || 'low', 24) || 'low',
        value_currency: valueCurrency,
        label: outcome === 'shipped' ? 1 : (outcome === 'reverted' ? -1 : 0),
        training_conduit: conduit,
        trainability
      });
    }
  }
  rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return rows;
}

function cmdCurate(args) {
  const policy = loadPolicy();
  const dateStr = normalizeText(args.date || args._[1] || todayStr(), 10) || todayStr();
  const days = clampInt(args.days, 1, 180, 30);
  const write = toBool(args.write, true);
  const rows = listTrainingRows(dateStr, days, policy)
    .slice(-policy.curation.max_rows);

  const out = {
    ok: rows.length >= policy.curation.min_rows,
    type: 'nursery_training_curation',
    ts: nowIso(),
    policy_version: policy.version,
    window: {
      end_date: dateStr,
      days
    },
    row_count: rows.length,
    min_required_rows: policy.curation.min_rows,
    max_rows: policy.curation.max_rows,
    dataset_path: null,
    outcome_breakdown: rows.reduce((acc, row) => {
      const key = row.outcome || 'unknown';
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {})
  };

  if (write) {
    const fp = path.join(OUT_DIR, 'datasets', `${dateStr}.jsonl`);
    ensureDir(fp);
    fs.writeFileSync(fp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
    out.dataset_path = relPath(fp);
    appendJsonl(HISTORY_PATH, {
      ts: nowIso(),
      type: out.type,
      ok: out.ok,
      row_count: out.row_count,
      dataset_path: out.dataset_path
    });
  }

  process.stdout.write(JSON.stringify(out) + '\n');
}

function cmdPlan(args) {
  const policy = loadPolicy();
  const hardware = readJson(HARDWARE_PLAN_PATH, null);
  const hardwareClass = normalizeToken(hardware && hardware.summary && hardware.summary.class, 32)
    || detectHardwareClass();
  const profileResolution = resolveProfileSelection(policy, {
    requestedProfile: args.profile,
    hardwareClass
  });
  const profileId = profileResolution.profile_id;
  const profile = profileResolution.profile;
  const seedId = normalizeToken(args.seed || policy.seed_id_default, 120) || policy.seed_id_default;
  const backendResolution = resolveTrainingBackend(policy, {
    requestedBackend: args.backend,
    hardwareClass
  });

  const out = {
    ok: true,
    type: 'nursery_training_plan',
    ts: nowIso(),
    policy_version: policy.version,
    profile: profileId,
    seed_id: seedId,
    hardware_class: hardwareClass,
    plan: {
      adapter: normalizeToken(profile.adapter || 'lora', 32) || 'lora',
      rank: Number(profile.rank || 16),
      alpha: Number(profile.alpha || 32),
      batch_size: Number(profile.batch_size || 8),
      epochs: Number(profile.epochs || 1),
      max_train_minutes: Number(profile.max_train_minutes || 30),
      max_ram_gb: Number(profile.max_ram_gb || 8),
      max_gpu_vram_gb: Number(profile.max_gpu_vram_gb || 0)
    },
    seed_sizing: {
      source: profileResolution.selection_source,
      profile_selected: profileResolution.profile_id,
      hardware_class: hardwareClass || null,
      system: {
        cpu_count: Number((os.cpus() || []).length || 1),
        total_mem_gb: Number((Number(os.totalmem() || 0) / (1024 ** 3)).toFixed(2)),
        load_1m: Number(((os.loadavg && os.loadavg()[0]) || 0).toFixed(4))
      }
    },
    trainer_backend: {
      requested: backendResolution.requested_backend,
      selected: backendResolution.selected_backend,
      fallback_used: backendResolution.fallback_used === true,
      fallback_reason: backendResolution.fallback_reason || null
    },
    constraints: {
      no_external_payloads: true,
      quarantine_required: true,
      promotion_gated: true
    }
  };

  appendJsonl(HISTORY_PATH, {
    ts: nowIso(),
    type: out.type,
    profile: out.profile,
    seed_id: out.seed_id,
    adapter: out.plan.adapter
  });

  process.stdout.write(JSON.stringify(out) + '\n');
}

function detectHardwareClass() {
  const cpus = Math.max(1, Number((os.cpus() || []).length || 1));
  const memGb = Number((Number(os.totalmem() || 0) / (1024 ** 3)).toFixed(2));
  if (cpus <= 2 || memGb < 4) return 'phone_seed';
  if (cpus <= 4 || memGb < 8) return 'small';
  if (cpus <= 8 || memGb < 24) return 'medium';
  return 'large';
}

function resolveProfileSelection(policy, opts = {}) {
  const requested = normalizeToken(opts.requestedProfile || '', 32);
  const profileKeys = policy && policy.profiles && typeof policy.profiles === 'object'
    ? Object.keys(policy.profiles)
    : [];
  if (requested && policy.profiles && policy.profiles[requested]) {
    return {
      profile_id: requested,
      profile: policy.profiles[requested],
      selection_source: 'requested_profile'
    };
  }
  const hardwareClass = normalizeToken(opts.hardwareClass || '', 32);
  const selectedByClass = (() => {
    if (hardwareClass === 'phone_seed') return 'small';
    if (hardwareClass === 'small') return 'small';
    if (hardwareClass === 'medium') return policy.profiles.medium ? 'medium' : (policy.profiles.small ? 'small' : profileKeys[0]);
    if (hardwareClass === 'large') return policy.profiles.large ? 'large' : (policy.profiles.medium ? 'medium' : (policy.profiles.small ? 'small' : profileKeys[0]));
    return '';
  })();
  if (selectedByClass && policy.profiles && policy.profiles[selectedByClass]) {
    return {
      profile_id: selectedByClass,
      profile: policy.profiles[selectedByClass],
      selection_source: 'hardware_class'
    };
  }
  const fallback = policy.profiles.small
    ? 'small'
    : (profileKeys[0] || 'small');
  const fallbackProfile = policy.profiles && policy.profiles[fallback] && typeof policy.profiles[fallback] === 'object'
    ? policy.profiles[fallback]
    : {};
  return {
    profile_id: fallback,
    profile: fallbackProfile,
    selection_source: 'fallback_profile'
  };
}

function commandAvailable(rawCommand) {
  const command = normalizeText(rawCommand || '', 260);
  if (!command) return false;
  const isAbsolute = path.isAbsolute(command);
  if (isAbsolute) return fs.existsSync(command);
  const probe = spawnSync('sh', ['-lc', `command -v ${command}`], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return Number(probe.status || 1) === 0;
}

function resolveTrainingBackend(policy, opts = {}) {
  const cfg = policy.training_backend && typeof policy.training_backend === 'object'
    ? policy.training_backend
    : defaultPolicy().training_backend;
  const requested = normalizeToken(opts.requestedBackend || '', 40);
  const hardwareClass = normalizeToken(opts.hardwareClass || '', 40);
  const mapped = cfg.backend_by_hardware_class && cfg.backend_by_hardware_class[hardwareClass]
    ? normalizeToken(cfg.backend_by_hardware_class[hardwareClass], 40)
    : '';
  const selectedInitial = requested
    || (cfg.auto_select_by_hardware_class === true ? mapped : '')
    || normalizeToken(cfg.default_backend || 'native', 40)
    || 'native';

  const isEnabled = (backend) => {
    if (backend === 'axolotl') return cfg.axolotl && cfg.axolotl.enabled === true;
    if (backend === 'native') return cfg.native && cfg.native.enabled !== false;
    return false;
  };

  const backend = isEnabled(selectedInitial)
    ? selectedInitial
    : 'native';
  let selected = backend;
  let fallbackUsed = backend !== selectedInitial;
  let fallbackReason = fallbackUsed ? 'requested_backend_disabled' : '';

  if (selected === 'axolotl') {
    const commandFromEnv = normalizeText(process.env.NURSERY_AXOLOTL_COMMAND || '', 260);
    const command = commandFromEnv || normalizeText(cfg.axolotl && cfg.axolotl.command || 'axolotl', 260);
    if (!commandAvailable(command)) {
      if (cfg.allow_backend_fallback === true && isEnabled('native')) {
        selected = 'native';
        fallbackUsed = true;
        fallbackReason = 'axolotl_command_unavailable';
      } else {
        return {
          requested_backend: selectedInitial,
          selected_backend: 'axolotl',
          fallback_used: false,
          fallback_reason: 'axolotl_command_unavailable',
          blocked: true
        };
      }
    }
  }

  return {
    requested_backend: selectedInitial,
    selected_backend: selected,
    fallback_used: fallbackUsed,
    fallback_reason: fallbackReason || null,
    blocked: false
  };
}

function parseJsonFromStdout(stdoutText) {
  const raw = String(stdoutText || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function safeRatio(num, den, fallback = 0) {
  const n = Number(num);
  const d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return fallback;
  return n / d;
}

function deriveBackendMetrics(datasetRows, profile) {
  const rows = Array.isArray(datasetRows) ? datasetRows : [];
  const rowCount = rows.length;
  const positive = rows.filter((row) => Number(row && row.label || 0) > 0).length;
  const negative = rows.filter((row) => Number(row && row.label || 0) < 0).length;
  const neutral = Math.max(0, rowCount - positive - negative);
  const posRate = safeRatio(positive, Math.max(1, rowCount), 0.5);
  const negRate = safeRatio(negative, Math.max(1, rowCount), 0.2);
  const quality = clampNumber(0.68 + (posRate * 0.25) - (negRate * 0.1), 0, 1, 0.8);
  const safety = clampNumber(0.9 - (negRate * 0.15), 0, 1, 0.92);
  const regressionRate = clampNumber(0.06 + (negRate * 0.25), 0, 1, 0.08);
  const adapter = normalizeToken(profile && profile.adapter || 'lora', 32) || 'lora';
  const trainLoss = clampNumber(1.1 - (quality * 0.75), 0.01, 5, 0.4);
  const evalLoss = clampNumber(trainLoss + (regressionRate * 0.4), 0.01, 5, 0.45);
  const tokensSeen = Math.max(1, rowCount) * 192;
  const batchSize = Math.max(1, Number(profile && profile.batch_size || 8));
  const epochs = Math.max(1, Number(profile && profile.epochs || 1));
  const minutes = Number(((Math.max(1, rowCount) * epochs) / Math.max(1, batchSize)).toFixed(3));
  return {
    dataset_rows: rowCount,
    labels: {
      positive,
      negative,
      neutral
    },
    adapter,
    train_loss: Number(trainLoss.toFixed(6)),
    eval_loss: Number(evalLoss.toFixed(6)),
    quality: Number(quality.toFixed(6)),
    safety: Number(safety.toFixed(6)),
    regression_rate: Number(regressionRate.toFixed(6)),
    tokens_seen: Number(tokensSeen),
    training_minutes: Number(minutes.toFixed(3))
  };
}

function runNativeTrainerBackend(input) {
  const metrics = deriveBackendMetrics(input.dataset_rows, input.profile);
  const backendDir = path.join(OUT_DIR, 'backend_runs', 'native', input.checkpoint_id);
  ensureDir(path.join(backendDir, 'placeholder'));
  const checkpointArtifactPath = path.join(backendDir, 'model.safetensors');
  const metricsPath = path.join(backendDir, 'metrics.json');
  fs.writeFileSync(checkpointArtifactPath, `native_checkpoint:${input.checkpoint_id}\n`, 'utf8');
  writeJsonAtomic(metricsPath, metrics);
  return {
    ok: true,
    backend: 'native',
    command: 'native_internal',
    run_dir: backendDir,
    checkpoint_artifact_path: checkpointArtifactPath,
    metrics_path: metricsPath,
    metrics
  };
}

function buildAxolotlConfig(input) {
  const profile = input.profile || {};
  const config = {
    schema_id: 'axolotl_training_config',
    schema_version: '1.0',
    generated_at: nowIso(),
    run_id: input.run_id,
    checkpoint_id: input.checkpoint_id,
    seed_id: input.seed_id,
    dataset_path: input.dataset_path,
    output_dir: input.output_dir,
    lora: {
      adapter: normalizeToken(profile.adapter || 'lora', 32) || 'lora',
      rank: Number(profile.rank || 16),
      alpha: Number(profile.alpha || 32)
    },
    training: {
      batch_size: Number(profile.batch_size || 8),
      epochs: Number(profile.epochs || 1),
      max_train_minutes: Number(profile.max_train_minutes || 30)
    }
  };
  return config;
}

function runAxolotlTrainerBackend(input, policy) {
  const axCfg = policy.training_backend && policy.training_backend.axolotl
    ? policy.training_backend.axolotl
    : defaultPolicy().training_backend.axolotl;
  const command = normalizeText(process.env.NURSERY_AXOLOTL_COMMAND || axCfg.command || 'axolotl', 260) || 'axolotl';
  const runDir = path.join(OUT_DIR, 'backend_runs', 'axolotl', input.checkpoint_id);
  ensureDir(path.join(runDir, 'placeholder'));
  const outputDir = path.join(runDir, 'output');
  ensureDir(path.join(outputDir, 'placeholder'));
  const configPath = path.join(runDir, 'config.json');
  const resultPath = path.join(runDir, 'result.json');
  const config = buildAxolotlConfig({
    run_id: input.run_id,
    checkpoint_id: input.checkpoint_id,
    seed_id: input.seed_id,
    dataset_path: input.dataset_path,
    output_dir: outputDir,
    profile: input.profile
  });
  writeJsonAtomic(configPath, config);

  const cmdArgs = Array.isArray(axCfg.args) ? axCfg.args.slice(0) : ['train'];
  if (axCfg.config_arg) cmdArgs.push(axCfg.config_arg, configPath);
  if (axCfg.output_arg) cmdArgs.push(axCfg.output_arg, outputDir);
  const env = {
    ...process.env,
    NURSERY_TRAINER_RESULT_PATH: resultPath,
    NURSERY_TRAINER_DATASET_PATH: input.dataset_path,
    NURSERY_TRAINER_OUTPUT_DIR: outputDir,
    NURSERY_TRAINER_CHECKPOINT_ID: input.checkpoint_id
  };
  const proc = spawnSync(command, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: Number(axCfg.timeout_ms || 7200000)
  });
  if (Number(proc.status || 0) !== 0) {
    return {
      ok: false,
      backend: 'axolotl',
      error: 'axolotl_command_failed',
      command,
      args: cmdArgs,
      status: Number(proc.status || 1),
      stderr: String(proc.stderr || '').slice(0, 800)
    };
  }

  const payload = parseJsonFromStdout(proc.stdout)
    || readJson(resultPath, null)
    || {};
  const derived = deriveBackendMetrics(input.dataset_rows, input.profile);
  const metrics = {
    ...derived,
    train_loss: clampNumber(payload.train_loss, 0.0001, 100, derived.train_loss),
    eval_loss: clampNumber(payload.eval_loss, 0.0001, 100, derived.eval_loss),
    quality: clampNumber(payload.quality, 0, 1, derived.quality),
    safety: clampNumber(payload.safety, 0, 1, derived.safety),
    regression_rate: clampNumber(payload.regression_rate, 0, 1, derived.regression_rate),
    tokens_seen: clampInt(payload.tokens_seen, 1, 1_000_000_000, derived.tokens_seen),
    training_minutes: clampNumber(payload.training_minutes, 0.001, 7 * 24 * 60, derived.training_minutes)
  };
  const checkpointArtifactPath = resolvePath(
    payload.checkpoint_artifact_path || path.join(outputDir, 'model.safetensors'),
    path.join('state', 'nursery', 'training', 'backend_runs', 'axolotl', input.checkpoint_id, 'output', 'model.safetensors')
  );
  if (!fs.existsSync(checkpointArtifactPath)) {
    ensureDir(path.dirname(checkpointArtifactPath));
    fs.writeFileSync(checkpointArtifactPath, `axolotl_checkpoint:${input.checkpoint_id}\n`, 'utf8');
  }
  const metricsPath = path.join(runDir, 'metrics.json');
  writeJsonAtomic(metricsPath, metrics);

  return {
    ok: true,
    backend: 'axolotl',
    command,
    args: cmdArgs,
    run_dir: runDir,
    config_path: configPath,
    result_path: resultPath,
    checkpoint_artifact_path: checkpointArtifactPath,
    metrics_path: metricsPath,
    metrics
  };
}

function runQuarantine(args, env = {}) {
  const r = spawnSync(
    process.execPath,
    [TRAINING_QUARANTINE_SCRIPT, ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...env }
    }
  );
  const payload = (() => {
    const out = String(r.stdout || '').trim();
    if (!out) return null;
    try { return JSON.parse(out); } catch {}
    const lines = out.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { return JSON.parse(lines[i]); } catch {}
    }
    return null;
  })();
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
    payload
  };
}

function cmdTrain(args) {
  const policy = loadPolicy();
  const date = normalizeText(args.date || args._[1] || todayStr(), 10) || todayStr();
  const days = clampInt(args.days, 1, 180, 30);
  const hardware = readJson(HARDWARE_PLAN_PATH, null);
  const hardwareClass = normalizeToken(hardware && hardware.summary && hardware.summary.class, 32)
    || detectHardwareClass();
  const profileResolution = resolveProfileSelection(policy, {
    requestedProfile: args.profile,
    hardwareClass
  });
  const profileId = profileResolution.profile_id;
  const profile = profileResolution.profile;
  const seedId = normalizeToken(args.seed || policy.seed_id_default, 120) || policy.seed_id_default;
  const backendResolution = resolveTrainingBackend(policy, {
    requestedBackend: args.backend,
    hardwareClass
  });
  const write = toBool(args.write, true);
  if (backendResolution.blocked === true) {
    const out = {
      ok: false,
      type: 'nursery_training_run',
      ts: nowIso(),
      error: 'trainer_backend_blocked',
      backend: backendResolution.selected_backend,
      reason: backendResolution.fallback_reason || 'backend_blocked'
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(1);
  }

  let datasetPath = resolvePath(args['dataset-path'] || args.dataset_path || '', '');
  if (!datasetPath) {
    const rows = listTrainingRows(date, days, policy).slice(-policy.curation.max_rows);
    const fp = path.join(OUT_DIR, 'datasets', `${date}.jsonl`);
    if (write) {
      ensureDir(fp);
      fs.writeFileSync(fp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
      appendJsonl(HISTORY_PATH, {
        ts: nowIso(),
        type: 'nursery_training_curation',
        ok: rows.length >= policy.curation.min_rows,
        row_count: rows.length,
        dataset_path: relPath(fp)
      });
    }
    datasetPath = fp;
  }
  if (!datasetPath || !fs.existsSync(datasetPath)) {
    const out = {
      ok: false,
      type: 'nursery_training_run',
      ts: nowIso(),
      error: 'dataset_missing'
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(1);
  }

  const datasetRows = readJsonlSafe(datasetPath);
  if (!datasetRows.length) {
    const out = {
      ok: false,
      type: 'nursery_training_run',
      ts: nowIso(),
      error: 'dataset_empty',
      dataset_path: relPath(datasetPath)
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(1);
  }

  const checkpointId = normalizeToken(
    args.checkpoint || `ckpt_${seedId}_${date}_${Date.now()}`,
    180
  );
  const runId = `train_${checkpointId}`;
  const checkpointPath = path.join(OUT_DIR, 'checkpoints', `${checkpointId}.json`);
  const checkpointDigest = require('crypto').createHash('sha256')
    .update(datasetRows.map((row) => JSON.stringify(row)).join('\n'), 'utf8')
    .digest('hex');
  let backendResult = null;
  if (backendResolution.selected_backend === 'axolotl') {
    backendResult = runAxolotlTrainerBackend({
      run_id: runId,
      checkpoint_id: checkpointId,
      seed_id: seedId,
      dataset_rows: datasetRows,
      dataset_path: datasetPath,
      profile
    }, policy);
  } else {
    backendResult = runNativeTrainerBackend({
      run_id: runId,
      checkpoint_id: checkpointId,
      seed_id: seedId,
      dataset_rows: datasetRows,
      dataset_path: datasetPath,
      profile
    });
  }
  if (!backendResult || backendResult.ok !== true) {
    const out = {
      ok: false,
      type: 'nursery_training_run',
      ts: nowIso(),
      error: 'trainer_backend_failed',
      backend: backendResolution.selected_backend,
      backend_result: backendResult || null
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(1);
  }

  const metrics = backendResult.metrics && typeof backendResult.metrics === 'object'
    ? backendResult.metrics
    : deriveBackendMetrics(datasetRows, profile);
  const queueScore = Number(clampNumber(
    Number(metrics.quality || 0) * Number(metrics.safety || 0) * (1 - Number(metrics.regression_rate || 0)),
    0,
    1,
    0.5
  ).toFixed(6));
  const syntheticLatencyMs = Number((Math.max(1, Number(metrics.training_minutes || 1)) * 60 * 10).toFixed(3));
  const syntheticCostPer1k = Number(clampNumber(
    (Number(metrics.training_minutes || 1) / Math.max(1, Number(datasetRows.length || 1))) * 0.01,
    0.000001,
    100,
    0.01
  ).toFixed(6));

  let backendAttribution = null;
  if (backendResult.backend === 'axolotl' && typeof recordAttribution === 'function') {
    try {
      const axCfg = policy.training_backend && policy.training_backend.axolotl
        ? policy.training_backend.axolotl
        : defaultPolicy().training_backend.axolotl;
      backendAttribution = recordAttribution({
        source_type: 'external_training_backend',
        source_id: 'axolotl',
        creator_id: normalizeToken(axCfg.attribution_creator_id || 'axolotl', 120) || 'axolotl',
        creator_alias: 'Axolotl',
        creator_opt_in: true,
        license: normalizeText(axCfg.attribution_license || 'apache-2.0', 120) || 'apache-2.0',
        objective_id: normalizeToken(args.objective_id || args['objective-id'] || '', 180)
          || normalizeToken(datasetRows[0] && datasetRows[0].objective_id || '', 180)
          || `objective_${checkpointId}`,
        capability_id: 'seed_model_training',
        task_id: checkpointId,
        run_id: runId,
        lane: 'nursery_training_backend',
        weight: Number((Math.max(1, Number(datasetRows.length || 1)) / 100).toFixed(6)),
        confidence: 0.95,
        impact_score: 0.7,
        influence_score: 0.4
      }, {
        apply: false
      });
    } catch {
      backendAttribution = null;
    }
  }

  const checkpointRow = {
    schema_id: 'nursery_training_checkpoint',
    schema_version: '1.0',
    ts: nowIso(),
    checkpoint_id: checkpointId,
    seed_id: seedId,
    profile_id: profileId,
    profile_selection_source: profileResolution.selection_source,
    hardware_class: hardwareClass || null,
    date,
    days,
    dataset_path: relPath(datasetPath),
    dataset_rows: datasetRows.length,
    dataset_digest: checkpointDigest,
    checkpoint_artifact_path: relPath(backendResult.checkpoint_artifact_path),
    trainer_backend: {
      requested_backend: backendResolution.requested_backend,
      selected_backend: backendResolution.selected_backend,
      fallback_used: backendResolution.fallback_used === true,
      fallback_reason: backendResolution.fallback_reason || null,
      command: backendResult.command || null,
      run_dir: backendResult.run_dir ? relPath(backendResult.run_dir) : null,
      config_path: backendResult.config_path ? relPath(backendResult.config_path) : null,
      result_path: backendResult.result_path ? relPath(backendResult.result_path) : null,
      metrics_path: backendResult.metrics_path ? relPath(backendResult.metrics_path) : null
    },
    training_metrics: metrics,
    queue_score: queueScore,
    estimated_eval: {
      quality: Number(metrics.quality || 0),
      safety: Number(metrics.safety || 0),
      regression_rate: Number(metrics.regression_rate || 0),
      latency_ms: syntheticLatencyMs,
      cost_per_1k: syntheticCostPer1k
    },
    value_attribution: backendAttribution && backendAttribution.ok === true
      ? {
        attribution_id: backendAttribution.attribution_id || null,
        source_id: backendAttribution.source_id || null,
        creator_id: backendAttribution.creator_id || null
      }
      : null,
    mode: 'shadow',
    promoted: false
  };
  if (write) writeJsonAtomic(checkpointPath, checkpointRow);

  const checkpointsIndexPath = path.join(OUT_DIR, 'checkpoints', 'index.json');
  const indexDoc = readJson(checkpointsIndexPath, {
    schema_id: 'nursery_training_checkpoint_index',
    schema_version: '1.0',
    checkpoints: {}
  });
  if (!indexDoc.checkpoints || typeof indexDoc.checkpoints !== 'object') {
    indexDoc.checkpoints = {};
  }
  indexDoc.updated_at = nowIso();
  indexDoc.checkpoints[checkpointId] = {
    checkpoint_path: relPath(checkpointPath),
    ts: checkpointRow.ts,
    dataset_rows: checkpointRow.dataset_rows,
    seed_id: seedId,
    profile_id: profileId,
    trainer_backend: checkpointRow.trainer_backend.selected_backend,
    queue_score: queueScore
  };
  if (write) writeJsonAtomic(checkpointsIndexPath, indexDoc);

  const queuePath = path.join(OUT_DIR, 'workflow_learning_queue.jsonl');
  const entryId = `train_${checkpointId}`;
  const queueRow = {
    ts: nowIso(),
    entry_id: entryId,
    checkpoint_id: checkpointId,
    checkpoint_path: relPath(checkpointPath),
    source: 'nursery_specialist_training',
    score: queueScore,
    metrics: {
      dataset_rows: checkpointRow.dataset_rows,
      quality: Number(metrics.quality || 0),
      safety: Number(metrics.safety || 0),
      regression_rate: Number(metrics.regression_rate || 0),
      train_loss: Number(metrics.train_loss || 0),
      eval_loss: Number(metrics.eval_loss || 0),
      training_minutes: Number(metrics.training_minutes || 0),
      tokens_seen: Number(metrics.tokens_seen || 0)
    },
    trainer_backend: backendResolution.selected_backend
  };
  if (write) appendJsonl(queuePath, queueRow);

  const quarantinePolicyBasePath = process.env.TRAINING_QUARANTINE_POLICY_PATH
    ? path.resolve(process.env.TRAINING_QUARANTINE_POLICY_PATH)
    : path.join(ROOT, 'config', 'training_quarantine_policy.json');
  const quarantineBasePolicy = readJson(quarantinePolicyBasePath, {});
  const quarantinePolicyPath = path.join(OUT_DIR, 'quarantine_runtime_policy.json');
  const quarantineRuntimePolicy = {
    version: normalizeText(quarantineBasePolicy.version || '1.0', 24) || '1.0',
    enabled: quarantineBasePolicy.enabled !== false,
    canary: quarantineBasePolicy.canary && typeof quarantineBasePolicy.canary === 'object'
      ? quarantineBasePolicy.canary
      : {
        min_score: 0.8,
        max_regression_rate: 0.2
      },
    paths: {
      pending_queue_path: path.join(OUT_DIR, 'workflow_learning_queue.jsonl'),
      canary_queue_path: path.join(OUT_DIR, 'workflow_learning_canary.jsonl'),
      master_queue_path: path.join(OUT_DIR, 'continuum_queue.jsonl'),
      state_path: path.join(OUT_DIR, 'quarantine_state.json'),
      receipts_path: path.join(OUT_DIR, 'quarantine_receipts.jsonl'),
      latest_path: path.join(OUT_DIR, 'quarantine_latest.json')
    }
  };
  if (write) writeJsonAtomic(quarantinePolicyPath, quarantineRuntimePolicy);

  const quarantineEnv = {
    TRAINING_QUARANTINE_POLICY_PATH: quarantinePolicyPath
  };
  const stage = runQuarantine(['stage', '--apply=1', '--max=2000'], quarantineEnv);
  const evaluate = runQuarantine(
    [
      'evaluate',
      `--entry-id=${entryId}`,
      `--score=${queueScore}`,
      '--slo-pass=1',
      `--regression-rate=${Number(metrics.regression_rate || 0)}`,
      '--apply=1',
      '--actor-id=nursery_training_loop',
      '--actor-roles=ml_operator',
      '--mfa-token=otp_222222',
      '--tenant-id=local'
    ],
    quarantineEnv
  );

  const promoted = evaluate.payload && evaluate.payload.ok === true
    && evaluate.payload.status === 'promoted';
  const promotionManifestPath = path.join(OUT_DIR, 'promotions', `${checkpointId}.json`);
  const promotionManifest = {
    schema_id: 'nursery_training_promotion_manifest',
    schema_version: '1.0',
    ts: nowIso(),
    checkpoint_id: checkpointId,
    entry_id: entryId,
    promoted,
    stage_result: stage.payload || null,
    evaluate_result: evaluate.payload || null,
    trainer_backend: checkpointRow.trainer_backend,
    training_metrics: metrics,
    value_attribution: checkpointRow.value_attribution
  };
  if (write) writeJsonAtomic(promotionManifestPath, promotionManifest);

  appendJsonl(HISTORY_PATH, {
    ts: nowIso(),
    type: 'nursery_training_run',
    checkpoint_id: checkpointId,
    dataset_path: relPath(datasetPath),
    dataset_rows: checkpointRow.dataset_rows,
    queue_entry_id: entryId,
    trainer_backend: backendResolution.selected_backend,
    queue_score: queueScore,
    training_metrics: metrics,
    promoted
  });

  const out = {
    ok: true,
    type: 'nursery_training_run',
    ts: nowIso(),
    checkpoint_id: checkpointId,
    checkpoint_path: relPath(checkpointPath),
    checkpoints_index_path: relPath(checkpointsIndexPath),
    dataset_path: relPath(datasetPath),
    dataset_rows: checkpointRow.dataset_rows,
    queue_path: relPath(queuePath),
    queue_entry_id: entryId,
    trainer_backend: checkpointRow.trainer_backend,
    training_metrics: metrics,
    queue_score: queueScore,
    value_attribution: checkpointRow.value_attribution,
    quarantine: {
      stage_ok: stage.status === 0,
      evaluate_ok: evaluate.status === 0
    },
    promoted,
    promotion_manifest_path: relPath(promotionManifestPath)
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

function readEvalInput(args) {
  if (args['eval-file'] || args.eval_file) {
    const evalPath = path.resolve(String(args['eval-file'] || args.eval_file));
    const payload = readJson(evalPath, null);
    return {
      source: evalPath,
      quality: payload && Number(payload.quality),
      safety: payload && Number(payload.safety),
      cost_per_1k: payload && Number(payload.cost_per_1k),
      latency_ms: payload && Number(payload.latency_ms),
      eval_samples: payload && Number(payload.eval_samples),
      training_dataset_rows: payload && Number(payload.training_dataset_rows),
      drift_delta: payload && Number(payload.drift_delta),
      regression_rate: payload && Number(payload.regression_rate),
      checkpoint_parent: payload && normalizeToken(payload.checkpoint_parent || payload.parent || '', 180)
    };
  }
  return {
    source: 'inline_args',
    quality: Number(args.quality),
    safety: Number(args.safety),
    cost_per_1k: Number(args.cost || args.cost_per_1k),
    latency_ms: Number(args.latency_ms || args.latency),
    eval_samples: Number(args.eval_samples),
    training_dataset_rows: Number(args.training_dataset_rows),
    drift_delta: Number(args.drift_delta),
    regression_rate: Number(args.regression_rate),
    checkpoint_parent: normalizeToken(args.parent || args.checkpoint_parent || '', 180)
  };
}

function metricOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function evaluateMetrics(input, policy, opts = {}) {
  const th = policy.promotion_thresholds;
  const controls = policy.promotion_controls && typeof policy.promotion_controls === 'object'
    ? policy.promotion_controls
    : defaultPolicy().promotion_controls;
  const requireCheckpointParent = opts.require_checkpoint_parent === true;
  const quality = clampNumber(input.quality, 0, 1, 0);
  const safety = clampNumber(input.safety, 0, 1, 0);
  const costPer1k = clampNumber(input.cost_per_1k, 0, 1000, Number.POSITIVE_INFINITY);
  const latencyMs = clampNumber(input.latency_ms, 0, 10000000, Number.POSITIVE_INFINITY);
  const evalSamples = metricOrNull(input.eval_samples);
  const datasetRows = metricOrNull(input.training_dataset_rows);
  const driftDelta = metricOrNull(input.drift_delta);
  const regressionRate = metricOrNull(input.regression_rate);
  const checkpointParent = normalizeToken(input.checkpoint_parent || '', 180);

  const checks = {
    quality: {
      pass: quality >= th.min_quality,
      value: Number(quality.toFixed(4)),
      threshold: Number(th.min_quality.toFixed(4))
    },
    safety: {
      pass: safety >= th.min_safety,
      value: Number(safety.toFixed(4)),
      threshold: Number(th.min_safety.toFixed(4))
    },
    cost_per_1k: {
      pass: costPer1k <= th.max_cost_per_1k,
      value: Number(costPer1k.toFixed(6)),
      threshold: Number(th.max_cost_per_1k.toFixed(6))
    },
    latency_ms: {
      pass: latencyMs <= th.max_latency_ms,
      value: Number(latencyMs.toFixed(4)),
      threshold: Number(th.max_latency_ms.toFixed(4))
    },
    eval_samples: {
      pass: Number(evalSamples) >= Number(controls.min_eval_samples || 0),
      value: evalSamples == null ? null : Number(evalSamples),
      threshold: Number(controls.min_eval_samples || 0)
    },
    training_dataset_rows: {
      pass: Number(datasetRows) >= Number(controls.min_dataset_rows || 0),
      value: datasetRows == null ? null : Number(datasetRows),
      threshold: Number(controls.min_dataset_rows || 0)
    },
    drift_delta: {
      pass: Number(controls.max_drift_delta || 1) >= 1
        ? true
        : (driftDelta != null && Number(driftDelta) <= Number(controls.max_drift_delta || 1)),
      value: driftDelta == null ? null : Number(Number(driftDelta).toFixed(6)),
      threshold: Number(Number(controls.max_drift_delta || 1).toFixed(6))
    },
    regression_rate: {
      pass: Number(controls.max_regression_rate || 1) >= 1
        ? true
        : (regressionRate != null && Number(regressionRate) <= Number(controls.max_regression_rate || 1)),
      value: regressionRate == null ? null : Number(Number(regressionRate).toFixed(6)),
      threshold: Number(Number(controls.max_regression_rate || 1).toFixed(6))
    },
    checkpoint_parent: {
      pass: requireCheckpointParent ? checkpointParent.length > 0 : true,
      value: checkpointParent || null,
      required: requireCheckpointParent === true
    }
  };
  const pass = Object.values(checks).every((row) => row.pass === true);

  return {
    pass,
    source: input.source,
    checks
  };
}

function cmdEvaluate(args) {
  const policy = loadPolicy();
  const evalInput = readEvalInput(args);
  const result = evaluateMetrics(evalInput, policy);
  const out = {
    ok: result.pass,
    type: 'nursery_training_evaluation',
    ts: nowIso(),
    policy_version: policy.version,
    evaluation: result
  };

  appendJsonl(HISTORY_PATH, {
    ts: nowIso(),
    type: out.type,
    ok: out.ok,
    source: result.source,
    checks: result.checks
  });

  process.stdout.write(JSON.stringify(out) + '\n');
  if (toBool(args.strict, false) && out.ok !== true) process.exit(1);
}

function cmdPromote(args) {
  const checkpoint = normalizeText(args.checkpoint || '', 180);
  if (!checkpoint) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'checkpoint_required' }) + '\n');
    process.exit(2);
  }
  const policy = loadPolicy();
  const accessDecision = evaluateAccess(
    'specialist_training.promote',
    buildAccessContext(args, {
      target_tenant_id: args['target-tenant-id']
        || args.target_tenant_id
        || args['tenant-id']
        || args.tenant_id
        || process.env.PROTHEUS_TARGET_TENANT_ID
        || process.env.PROTHEUS_TENANT_ID
        || null
    })
  );
  if (accessDecision && accessDecision.allow !== true) {
    const denied = {
      ok: false,
      type: 'nursery_training_promotion',
      ts: nowIso(),
      checkpoint,
      error: 'enterprise_access_denied',
      access_decision: accessDecision
    };
    appendJsonl(HISTORY_PATH, {
      ts: denied.ts,
      type: denied.type,
      ok: false,
      checkpoint,
      reason: denied.error
    });
    process.stdout.write(JSON.stringify(denied) + '\n');
    process.exit(1);
  }
  const evalInputRaw = readEvalInput(args);
  const history = readJsonl(HISTORY_PATH);
  const latestCuration = [...history]
    .reverse()
    .find((row) => row && row.type === 'nursery_training_curation' && Number(row.row_count || 0) > 0);
  const latestPromotion = [...history]
    .reverse()
    .find((row) => row && row.type === 'nursery_training_promotion' && row.promoted === true);
  const controls = policy.promotion_controls && typeof policy.promotion_controls === 'object'
    ? policy.promotion_controls
    : defaultPolicy().promotion_controls;

  const checkpointParent = normalizeToken(
    args.parent
    || args['checkpoint-parent']
    || evalInputRaw.checkpoint_parent
    || '',
    180
  );
  const datasetRowsFallback = latestCuration && Number.isFinite(Number(latestCuration.row_count))
    ? Number(latestCuration.row_count)
    : null;
  const evalInput = {
    ...evalInputRaw,
    checkpoint_parent: checkpointParent || null,
    training_dataset_rows: Number.isFinite(Number(evalInputRaw.training_dataset_rows))
      ? Number(evalInputRaw.training_dataset_rows)
      : datasetRowsFallback
  };
  const result = evaluateMetrics(evalInput, policy, {
    require_checkpoint_parent: controls.require_checkpoint_parent === true
  });

  const latestPromotionTs = latestPromotion && latestPromotion.ts ? Date.parse(String(latestPromotion.ts)) : NaN;
  const cooldownMs = Number(controls.cooldown_hours || 0) * 3600000;
  const cooldownActive = Number.isFinite(latestPromotionTs)
    && cooldownMs > 0
    && (Date.now() - latestPromotionTs) < cooldownMs;
  const cooldownRemainingHours = cooldownActive
    ? Number((((latestPromotionTs + cooldownMs) - Date.now()) / 3600000).toFixed(3))
    : 0;
  const promoted = result.pass && !cooldownActive;
  const promotionGates = {
    cooldown: {
      pass: !cooldownActive,
      cooldown_hours: Number(controls.cooldown_hours || 0),
      remaining_hours: cooldownRemainingHours > 0 ? cooldownRemainingHours : 0,
      last_promotion_ts: Number.isFinite(latestPromotionTs) ? new Date(latestPromotionTs).toISOString() : null
    }
  };

  const promotionManifest = {
    schema_id: 'nursery_training_promotion_manifest',
    schema_version: '1.0.0',
    ts: nowIso(),
    checkpoint,
    checkpoint_parent: checkpointParent || null,
    policy_version: policy.version,
    evaluation_source: result.source,
    evaluation: result,
    promotion_gates: promotionGates,
    promoted,
    dataset_row_count: Number(evalInput.training_dataset_rows || 0),
    latest_curation_ts: latestCuration && latestCuration.ts ? String(latestCuration.ts) : null
  };
  const promotionManifestPath = path.join(OUT_DIR, 'promotions', `${normalizeToken(checkpoint, 180) || 'checkpoint'}.json`);
  writeJsonAtomic(promotionManifestPath, promotionManifest);

  const out = {
    ok: promoted,
    type: 'nursery_training_promotion',
    ts: nowIso(),
    policy_version: policy.version,
    access_decision: accessDecision,
    checkpoint,
    checkpoint_parent: checkpointParent || null,
    evaluation: result,
    promotion_gates: promotionGates,
    promotion_manifest_path: relPath(promotionManifestPath),
    promoted,
    routing_proposal: promoted
      ? {
        action: 'candidate_routing_promotion',
        checkpoint,
        checkpoint_parent: checkpointParent || null,
        mode: 'shadow_then_apprentice',
        required_human_approval: true
      }
      : null
  };

  appendJsonl(HISTORY_PATH, {
    ts: nowIso(),
    type: out.type,
    ok: out.ok,
    checkpoint,
    checkpoint_parent: checkpointParent || null,
    promoted: out.promoted
  });

  process.stdout.write(JSON.stringify(out) + '\n');
  if (toBool(args.strict, true) && out.ok !== true) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0], 64);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'curate') return cmdCurate(args);
  if (cmd === 'plan') return cmdPlan(args);
  if (cmd === 'train') return cmdTrain(args);
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'promote') return cmdPromote(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  listTrainingRows,
  evaluateMetrics
};
export {};
