#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  evaluateAccess,
  buildAccessContext
} = require('../security/enterprise_access_gate');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.TRAINING_QUARANTINE_POLICY_PATH
  ? path.resolve(process.env.TRAINING_QUARANTINE_POLICY_PATH)
  : path.join(ROOT, 'config', 'training_quarantine_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 140) {
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token || '').slice(2)] = true;
    else out[String(token || '').slice(2, idx)] = String(token || '').slice(idx + 1);
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj) {
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
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function stableId(seed: string) {
  return crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 12);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    canary: {
      min_score: 0.8,
      max_regression_rate: 0.2
    },
    paths: {
      pending_queue_path: 'state/nursery/training/workflow_learning_queue.jsonl',
      canary_queue_path: 'state/nursery/training/workflow_learning_canary.jsonl',
      master_queue_path: 'state/nursery/training/continuum_queue.jsonl',
      state_path: 'state/nursery/training/quarantine_state.json',
      receipts_path: 'state/nursery/training/quarantine_receipts.jsonl',
      latest_path: 'state/nursery/training/quarantine_latest.json'
    }
  };
}

function resolvePath(raw: unknown, fallback: string) {
  const txt = cleanText(raw || fallback, 320);
  if (path.isAbsolute(txt)) return txt;
  return path.join(ROOT, txt);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const canary = raw.canary && typeof raw.canary === 'object' ? raw.canary : {};
  const srcPaths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    canary: {
      min_score: clampNumber(canary.min_score, 0, 1, base.canary.min_score),
      max_regression_rate: clampNumber(
        canary.max_regression_rate,
        0,
        1,
        base.canary.max_regression_rate
      )
    },
    paths: {
      pending_queue_path: resolvePath(srcPaths.pending_queue_path, base.paths.pending_queue_path),
      canary_queue_path: resolvePath(srcPaths.canary_queue_path, base.paths.canary_queue_path),
      master_queue_path: resolvePath(srcPaths.master_queue_path, base.paths.master_queue_path),
      state_path: resolvePath(srcPaths.state_path, base.paths.state_path),
      receipts_path: resolvePath(srcPaths.receipts_path, base.paths.receipts_path),
      latest_path: resolvePath(srcPaths.latest_path, base.paths.latest_path)
    }
  };
}

function loadState(filePath: string) {
  const src = readJson(filePath, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'training_quarantine_state',
      schema_version: '1.0',
      updated_at: nowIso(),
      checkpoints: {}
    };
  }
  return {
    schema_id: 'training_quarantine_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    checkpoints: src.checkpoints && typeof src.checkpoints === 'object' ? src.checkpoints : {}
  };
}

function saveState(filePath: string, state: AnyObj) {
  writeJsonAtomic(filePath, {
    schema_id: 'training_quarantine_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    checkpoints: state && state.checkpoints && typeof state.checkpoints === 'object'
      ? state.checkpoints
      : {}
  });
}

function writeLatest(paths: AnyObj, out: AnyObj) {
  writeJsonAtomic(paths.latest_path, out);
  appendJsonl(paths.receipts_path, out);
}

function cmdStage(policy: AnyObj, args: AnyObj) {
  const apply = toBool(args.apply, false);
  const max = clampInt(args.max, 1, 10000, 2000);
  const state = loadState(policy.paths.state_path);
  const pendingRows = readJsonl(policy.paths.pending_queue_path).slice(0, max);
  const canaryRows = readJsonl(policy.paths.canary_queue_path);
  const canaryByEntry = new Set(
    canaryRows.map((row: AnyObj) => normalizeToken(row && row.entry_id || '', 120)).filter(Boolean)
  );

  let staged = 0;
  for (const row of pendingRows) {
    const entryId = normalizeToken(row && row.entry_id || '', 120);
    if (!entryId) continue;
    const existing = state.checkpoints[entryId];
    if (existing && String(existing.status || '').startsWith('canary')) continue;
    if (existing && String(existing.status || '') === 'promoted') continue;
    const checkpointId = `ckpt_${stableId(`${entryId}|${nowIso()}`)}`;
    const checkpoint = {
      checkpoint_id: checkpointId,
      entry_id: entryId,
      status: 'canary_running',
      staged_at: nowIso(),
      promoted_at: null,
      rolled_back_at: null,
      eval_history: []
    };
    state.checkpoints[entryId] = checkpoint;
    staged += 1;
    if (apply && !canaryByEntry.has(entryId)) {
      appendJsonl(policy.paths.canary_queue_path, {
        ...row,
        checkpoint_id: checkpointId,
        stage: 'canary'
      });
      canaryByEntry.add(entryId);
    }
  }

  saveState(policy.paths.state_path, state);
  const out = {
    ok: true,
    type: 'training_quarantine_stage',
    ts: nowIso(),
    apply,
    staged,
    scanned_pending: pendingRows.length,
    canary_queue_path: relPath(policy.paths.canary_queue_path),
    state_path: relPath(policy.paths.state_path)
  };
  writeLatest(policy.paths, out);
  return out;
}

function cmdEvaluate(policy: AnyObj, args: AnyObj) {
  const apply = toBool(args.apply, false);
  const accessDecision = apply
    ? evaluateAccess(
        'training_quarantine.evaluate_apply',
        buildAccessContext(args, {
          target_tenant_id: args['target-tenant-id']
            || args.target_tenant_id
            || args['tenant-id']
            || args.tenant_id
            || process.env.PROTHEUS_TARGET_TENANT_ID
            || process.env.PROTHEUS_TENANT_ID
            || null
        })
      )
    : null;
  if (apply && accessDecision && accessDecision.allow !== true) {
    return {
      ok: false,
      type: 'training_quarantine_evaluate',
      ts: nowIso(),
      error: 'enterprise_access_denied',
      access_decision: accessDecision
    };
  }
  const entryId = normalizeToken(args['entry-id'] || args.entry_id || '', 120);
  const checkpointId = normalizeToken(args['checkpoint-id'] || args.checkpoint_id || '', 120);
  const state = loadState(policy.paths.state_path);
  const checkpoints = state.checkpoints && typeof state.checkpoints === 'object' ? state.checkpoints : {};

  let selectedKey = '';
  let checkpoint: AnyObj = null;
  if (entryId && checkpoints[entryId]) {
    selectedKey = entryId;
    checkpoint = checkpoints[entryId];
  } else if (checkpointId) {
    for (const [key, row] of Object.entries(checkpoints)) {
      if (normalizeToken((row as AnyObj).checkpoint_id || '', 120) === checkpointId) {
        selectedKey = key;
        checkpoint = row;
        break;
      }
    }
  }
  if (!checkpoint) {
    return {
      ok: false,
      type: 'training_quarantine_evaluate',
      error: 'checkpoint_not_found'
    };
  }

  const score = clampNumber(args.score, 0, 1, 0);
  const sloPass = toBool(args['slo-pass'] != null ? args['slo-pass'] : args.slo_pass, false);
  const regressionRate = clampNumber(
    args['regression-rate'] != null ? args['regression-rate'] : args.regression_rate,
    0,
    1,
    0
  );
  const canPromote = sloPass === true
    && score >= Number(policy.canary.min_score || 0)
    && regressionRate <= Number(policy.canary.max_regression_rate || 1);

  checkpoint.eval_history = Array.isArray(checkpoint.eval_history) ? checkpoint.eval_history : [];
  checkpoint.eval_history.push({
    ts: nowIso(),
    slo_pass: sloPass,
    score,
    regression_rate: regressionRate,
    can_promote: canPromote
  });

  let promoted = 0;
  let rolledBack = 0;
  if (apply && canPromote && checkpoint.status !== 'promoted') {
    checkpoint.status = 'promoted';
    checkpoint.promoted_at = nowIso();
    appendJsonl(policy.paths.master_queue_path, {
      ts: nowIso(),
      type: 'training_checkpoint_promotion',
      stage: 'promoted',
      entry_id: checkpoint.entry_id,
      checkpoint_id: checkpoint.checkpoint_id,
      score,
      slo_pass: sloPass,
      regression_rate: regressionRate
    });
    promoted += 1;
  }

  if (
    apply
    && checkpoint.status === 'promoted'
    && (
      sloPass !== true
      || score < Number(policy.canary.min_score || 0)
      || regressionRate > Number(policy.canary.max_regression_rate || 1)
    )
  ) {
    checkpoint.status = 'rolled_back';
    checkpoint.rolled_back_at = nowIso();
    appendJsonl(policy.paths.master_queue_path, {
      ts: nowIso(),
      type: 'training_checkpoint_rollback',
      stage: 'rolled_back',
      entry_id: checkpoint.entry_id,
      checkpoint_id: checkpoint.checkpoint_id,
      score,
      slo_pass: sloPass,
      regression_rate: regressionRate,
      reason: 'canary_slo_regression'
    });
    rolledBack += 1;
  }

  checkpoints[selectedKey] = checkpoint;
  state.checkpoints = checkpoints;
  saveState(policy.paths.state_path, state);

  const out = {
    ok: true,
    type: 'training_quarantine_evaluate',
    ts: nowIso(),
    apply,
    access_decision: accessDecision,
    entry_id: checkpoint.entry_id,
    checkpoint_id: checkpoint.checkpoint_id,
    score,
    slo_pass: sloPass,
    regression_rate: regressionRate,
    can_promote: canPromote,
    status: checkpoint.status,
    promoted_count: promoted,
    rollback_count: rolledBack,
    master_queue_path: relPath(policy.paths.master_queue_path)
  };
  writeLatest(policy.paths, out);
  return out;
}

function cmdStatus(policy: AnyObj) {
  const state = loadState(policy.paths.state_path);
  const checkpoints = Object.values(state.checkpoints || {});
  return {
    ok: true,
    type: 'training_quarantine_status',
    ts: nowIso(),
    counts: {
      total: checkpoints.length,
      canary_running: checkpoints.filter((row: AnyObj) => row && row.status === 'canary_running').length,
      promoted: checkpoints.filter((row: AnyObj) => row && row.status === 'promoted').length,
      rolled_back: checkpoints.filter((row: AnyObj) => row && row.status === 'rolled_back').length
    },
    paths: {
      pending_queue_path: relPath(policy.paths.pending_queue_path),
      canary_queue_path: relPath(policy.paths.canary_queue_path),
      master_queue_path: relPath(policy.paths.master_queue_path),
      state_path: relPath(policy.paths.state_path),
      receipts_path: relPath(policy.paths.receipts_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/nursery/training_quarantine_loop.js stage [--apply=1|0] [--max=2000]');
  console.log('  node systems/nursery/training_quarantine_loop.js evaluate --entry-id=<id> [--score=0.9] [--slo-pass=1|0] [--regression-rate=0.1] [--apply=1|0]');
  console.log('  node systems/nursery/training_quarantine_loop.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  const policyPath = path.resolve(String(args.policy || process.env.TRAINING_QUARANTINE_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    const out = { ok: false, type: 'training_quarantine', error: 'training_quarantine_disabled' };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  }

  let out: AnyObj;
  if (cmd === 'stage') out = cmdStage(policy, args);
  else if (cmd === 'evaluate') out = cmdEvaluate(policy, args);
  else if (cmd === 'status') out = cmdStatus(policy);
  else {
    usage();
    process.exit(2);
    return;
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out && out.ok === false) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  defaultPolicy,
  loadPolicy
};
