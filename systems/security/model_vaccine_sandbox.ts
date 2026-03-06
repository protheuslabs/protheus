#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.MODEL_VACCINE_POLICY_PATH
  ? path.resolve(process.env.MODEL_VACCINE_POLICY_PATH)
  : path.join(ROOT, 'config', 'model_vaccine_policy.json');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/model_vaccine_sandbox.js onboard --model-id=<id> [--provider=<id>] [--critical-findings=<n>] [--high-findings=<n>] [--sandbox-seed=<id>]');
  console.log('  node systems/security/model_vaccine_sandbox.js promote --model-id=<id> --approver-id=<id> --approval-note="..."');
  console.log('  node systems/security/model_vaccine_sandbox.js status [--model-id=<id>]');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq < 0) out[token.slice(2)] = true;
    else out[token.slice(2, eq)] = token.slice(eq + 1);
  }
  return out;
}

function cleanText(v: unknown, maxLen = 320) {
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    version: '1.0',
    state_dir: 'state/security/model_vaccine',
    max_high_findings: 1,
    max_critical_findings: 0,
    require_sandbox_snapshot: true,
    min_approval_note_chars: 12
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const base = defaultPolicy();
  const src = readJson(policyPath, {});
  return {
    version: cleanText(src.version || base.version, 32) || '1.0',
    state_dir: cleanText(src.state_dir || base.state_dir, 260) || base.state_dir,
    max_high_findings: clampInt(src.max_high_findings, 0, 100000, base.max_high_findings),
    max_critical_findings: clampInt(src.max_critical_findings, 0, 100000, base.max_critical_findings),
    require_sandbox_snapshot: src.require_sandbox_snapshot !== false,
    min_approval_note_chars: clampInt(src.min_approval_note_chars, 4, 200, base.min_approval_note_chars)
  };
}

function pathsForPolicy(policy: AnyObj) {
  const stateDir = path.isAbsolute(policy.state_dir)
    ? policy.state_dir
    : path.join(ROOT, policy.state_dir);
  return {
    state_dir: stateDir,
    models_path: path.join(stateDir, 'models.json'),
    snapshots_dir: path.join(stateDir, 'snapshots'),
    latest_path: path.join(stateDir, 'latest.json'),
    receipts_path: path.join(stateDir, 'receipts.jsonl')
  };
}

function loadModels(paths: AnyObj) {
  const src = readJson(paths.models_path, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'model_vaccine_models',
      schema_version: '1.0',
      updated_at: nowIso(),
      models: {}
    };
  }
  return {
    schema_id: 'model_vaccine_models',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    models: src.models && typeof src.models === 'object' ? src.models : {}
  };
}

function saveModels(paths: AnyObj, state: AnyObj) {
  writeJsonAtomic(paths.models_path, {
    schema_id: 'model_vaccine_models',
    schema_version: '1.0',
    updated_at: nowIso(),
    models: state && state.models && typeof state.models === 'object' ? state.models : {}
  });
}

function emit(paths: AnyObj, payload: AnyObj) {
  writeJsonAtomic(paths.latest_path, payload);
  appendJsonl(paths.receipts_path, payload);
}

function cmdOnboard(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const paths = pathsForPolicy(policy);
  const modelId = normalizeToken(args.model_id || args['model-id'] || '', 160);
  const provider = normalizeToken(args.provider || 'unknown', 80) || 'unknown';
  const criticalFindings = clampInt(args.critical_findings || args['critical-findings'], 0, 100000, 0);
  const highFindings = clampInt(args.high_findings || args['high-findings'], 0, 100000, 0);
  const sandboxSeed = normalizeToken(args.sandbox_seed || args['sandbox-seed'] || `seed_${Date.now().toString(36)}`, 120);
  if (!modelId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'model_vaccine_onboard', error: 'model_id_required' })}\n`);
    process.exit(1);
  }

  const snapshotDir = path.join(paths.snapshots_dir, `${modelId}_${Date.now().toString(36)}`);
  ensureDir(snapshotDir);
  const snapshotMeta = {
    model_id: modelId,
    provider,
    sandbox_seed: sandboxSeed,
    ts: nowIso(),
    critical_findings: criticalFindings,
    high_findings: highFindings
  };
  writeJsonAtomic(path.join(snapshotDir, 'snapshot.json'), snapshotMeta);

  const pass = criticalFindings <= policy.max_critical_findings && highFindings <= policy.max_high_findings;
  const models = loadModels(paths);
  models.models[modelId] = {
    model_id: modelId,
    provider,
    status: pass ? 'passed' : 'failed',
    latest_snapshot: path.relative(ROOT, path.join(snapshotDir, 'snapshot.json')).replace(/\\/g, '/'),
    critical_findings: criticalFindings,
    high_findings: highFindings,
    promoted: false,
    updated_at: nowIso()
  };
  saveModels(paths, models);

  const out = {
    ok: true,
    type: 'model_vaccine_onboard',
    ts: nowIso(),
    model_id: modelId,
    provider,
    pass,
    status: models.models[modelId].status,
    snapshot: models.models[modelId].latest_snapshot,
    findings: {
      critical: criticalFindings,
      high: highFindings
    }
  };
  emit(paths, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdPromote(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const paths = pathsForPolicy(policy);
  const modelId = normalizeToken(args.model_id || args['model-id'] || '', 160);
  const approverId = normalizeToken(args.approver_id || args['approver-id'] || '', 120);
  const note = cleanText(args.approval_note || args['approval-note'] || '', 320);
  if (!modelId || !approverId || note.length < policy.min_approval_note_chars) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'model_vaccine_promote', error: 'model_id_approver_id_and_note_required' })}\n`);
    process.exit(1);
  }
  const models = loadModels(paths);
  const row = models.models[modelId];
  if (!row) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'model_vaccine_promote', error: 'model_not_found' })}\n`);
    process.exit(1);
  }
  if (String(row.status || '') !== 'passed') {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'model_vaccine_promote', error: 'model_not_passed_vaccine' })}\n`);
    process.exit(1);
  }
  row.status = 'promoted';
  row.promoted = true;
  row.promotion = {
    ts: nowIso(),
    approver_id: approverId,
    note
  };
  row.updated_at = nowIso();
  models.models[modelId] = row;
  saveModels(paths, models);
  const out = {
    ok: true,
    type: 'model_vaccine_promote',
    ts: nowIso(),
    model_id: modelId,
    status: row.status,
    promotion: row.promotion
  };
  emit(paths, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const paths = pathsForPolicy(policy);
  const modelId = normalizeToken(args.model_id || args['model-id'] || '', 160);
  const models = loadModels(paths);
  const out = {
    ok: true,
    type: 'model_vaccine_status',
    ts: nowIso(),
    policy_version: policy.version,
    model_id: modelId || null,
    model: modelId ? (models.models[modelId] || null) : null,
    models: modelId ? undefined : models.models
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'onboard') return cmdOnboard(args);
  if (cmd === 'promote') return cmdPromote(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
