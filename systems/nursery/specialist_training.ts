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
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
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
  const profileId = normalizeToken(args.profile || 'small', 32) || 'small';
  const profile = policy.profiles && policy.profiles[profileId] && typeof policy.profiles[profileId] === 'object'
    ? policy.profiles[profileId]
    : policy.profiles.small;
  const seedId = normalizeToken(args.seed || policy.seed_id_default, 120) || policy.seed_id_default;
  const hardware = readJson(HARDWARE_PLAN_PATH, null);
  const hardwareClass = normalizeToken(hardware && hardware.summary && hardware.summary.class, 32) || null;

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
