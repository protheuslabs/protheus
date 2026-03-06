#!/usr/bin/env node
'use strict';

/**
 * compliance_posture.js
 *
 * Aggregate compliance posture signal across controls + deployment hardening.
 *
 * Usage:
 *   node systems/ops/compliance_posture.js run [--days=30] [--profile=dev|prod] [--strict=1|0]
 *   node systems/ops/compliance_posture.js status [latest]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.COMPLIANCE_POSTURE_POLICY_PATH
  ? path.resolve(process.env.COMPLIANCE_POSTURE_POLICY_PATH)
  : path.join(ROOT, 'config', 'compliance_posture_policy.json');
const OUT_DIR = process.env.COMPLIANCE_POSTURE_OUT_DIR
  ? path.resolve(process.env.COMPLIANCE_POSTURE_OUT_DIR)
  : path.join(ROOT, 'state', 'ops', 'compliance_posture');
const HISTORY_PATH = path.join(OUT_DIR, 'history.jsonl');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');

const DEFAULT_SCRIPTS = {
  soc2: process.env.COMPLIANCE_POSTURE_SOC2_SCRIPT || 'systems/ops/compliance_reports.js',
  integrity: process.env.COMPLIANCE_POSTURE_INTEGRITY_SCRIPT || 'systems/security/integrity_kernel.js',
  startupAttestation: process.env.COMPLIANCE_POSTURE_STARTUP_ATTESTATION_SCRIPT || 'systems/security/startup_attestation.js',
  deploymentPackaging: process.env.COMPLIANCE_POSTURE_DEPLOYMENT_SCRIPT || 'systems/ops/deployment_packaging.js',
  contractCheck: process.env.COMPLIANCE_POSTURE_CONTRACT_CHECK_SCRIPT || 'systems/spine/contract_check.js'
};

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/compliance_posture.js run [--days=30] [--profile=dev|prod] [--strict=1|0]');
  console.log('  node systems/ops/compliance_posture.js status [latest]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = arg.indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
  }
  return out;
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeToken(v, maxLen = 40) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return payload == null ? fallback : payload;
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function parseJsonFromStdout(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runNodeScript(relOrAbsScript, args = [], extraEnv = {}) {
  const target = path.isAbsolute(String(relOrAbsScript || ''))
    ? String(relOrAbsScript)
    : path.join(ROOT, String(relOrAbsScript || ''));
  const run = spawnSync('node', [target, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv }
  });
  return {
    ok: run.status === 0,
    status: run.status == null ? 1 : run.status,
    stdout: String(run.stdout || '').trim(),
    stderr: String(run.stderr || '').trim(),
    payload: parseJsonFromStdout(run.stdout),
    script: path.isAbsolute(target) ? target : relPath(target)
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    strict_default: false,
    default_days: 30,
    weights: {
      soc2_readiness: 0.35,
      integrity_kernel: 0.2,
      startup_attestation: 0.15,
      deployment_packaging: 0.2,
      contract_surface: 0.1
    },
    thresholds: {
      pass: 0.8,
      warn: 0.65
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const weightsRaw = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
  const thresholdsRaw = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  return {
    version: String(raw.version || base.version),
    strict_default: raw.strict_default === true,
    default_days: clampInt(raw.default_days, 1, 365, base.default_days),
    weights: {
      soc2_readiness: clampNumber(weightsRaw.soc2_readiness, 0, 1, base.weights.soc2_readiness),
      integrity_kernel: clampNumber(weightsRaw.integrity_kernel, 0, 1, base.weights.integrity_kernel),
      startup_attestation: clampNumber(weightsRaw.startup_attestation, 0, 1, base.weights.startup_attestation),
      deployment_packaging: clampNumber(weightsRaw.deployment_packaging, 0, 1, base.weights.deployment_packaging),
      contract_surface: clampNumber(weightsRaw.contract_surface, 0, 1, base.weights.contract_surface)
    },
    thresholds: {
      pass: clampNumber(thresholdsRaw.pass, 0, 1, base.thresholds.pass),
      warn: clampNumber(thresholdsRaw.warn, 0, 1, base.thresholds.warn)
    }
  };
}

function scoreSoc2(run) {
  const payload = run && run.payload && typeof run.payload === 'object' ? run.payload : {};
  if (payload.pass_rate != null) return clampNumber(payload.pass_rate, 0, 1, 0);
  if (payload.controls_total && payload.controls_passed != null) {
    const total = Number(payload.controls_total || 0);
    const passed = Number(payload.controls_passed || 0);
    return total > 0 ? clampNumber(passed / total, 0, 1, 0) : 0;
  }
  return run.ok ? 0.7 : 0;
}

function scoreIntegrity(run) {
  const payload = run && run.payload && typeof run.payload === 'object' ? run.payload : {};
  const violations = Array.isArray(payload.violations) ? payload.violations.length : (run.ok ? 0 : 3);
  return clampNumber(1 - (violations / 5), 0, 1, 0);
}

function scoreStartupAttestation(run) {
  const payload = run && run.payload && typeof run.payload === 'object' ? run.payload : {};
  const state = payload.state && typeof payload.state === 'object' ? payload.state : {};
  const expiresAt = Date.parse(String(state.expires_at || ''));
  const valid = Number.isFinite(expiresAt) && expiresAt > Date.now();
  return valid ? 1 : 0;
}

function scoreDeploymentPackaging(run) {
  const payload = run && run.payload && typeof run.payload === 'object' ? run.payload : {};
  if (payload.pass_rate != null) return clampNumber(payload.pass_rate, 0, 1, 0);
  return run.ok ? 0.8 : 0;
}

function scoreContractSurface(run) {
  if (run.ok) return 1;
  const text = `${String(run.stdout || '')}\n${String(run.stderr || '')}`.toLowerCase();
  if (text.includes('contract_check: ok')) return 1;
  return 0;
}

function scoreWeighted(components, weights) {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const row of components) {
    const weight = Number(weights[row.id] || 0);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    weightedSum += weight * Number(row.score || 0);
    totalWeight += weight;
  }
  if (totalWeight <= 0) return 0;
  return Number((weightedSum / totalWeight).toFixed(4));
}

function verdictFor(score, thresholds) {
  const passThreshold = Number(thresholds.pass || 0.8);
  const warnThreshold = Number(thresholds.warn || 0.65);
  if (score >= passThreshold) return 'pass';
  if (score >= warnThreshold) return 'warn';
  return 'fail';
}

function runCmd(args) {
  const policyPath = path.resolve(String(args.policy || process.env.COMPLIANCE_POSTURE_POLICY_PATH || POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, policy.strict_default === true);
  const days = clampInt(args.days, 1, 365, policy.default_days);
  const profile = normalizeToken(args.profile || 'prod', 20) || 'prod';

  const soc2Run = runNodeScript(DEFAULT_SCRIPTS.soc2, ['soc2-readiness', `--days=${days}`, '--strict=0']);
  const integrityRun = runNodeScript(DEFAULT_SCRIPTS.integrity, ['run']);
  const startupRun = runNodeScript(DEFAULT_SCRIPTS.startupAttestation, ['status']);
  const deploymentRun = runNodeScript(DEFAULT_SCRIPTS.deploymentPackaging, ['run', `--profile=${profile}`, '--strict=0']);
  const contractRun = runNodeScript(DEFAULT_SCRIPTS.contractCheck, []);

  const components = [
    {
      id: 'soc2_readiness',
      score: scoreSoc2(soc2Run),
      ok: soc2Run.ok,
      source: soc2Run.script,
      status: soc2Run.status,
      detail: soc2Run.payload || null
    },
    {
      id: 'integrity_kernel',
      score: scoreIntegrity(integrityRun),
      ok: integrityRun.ok,
      source: integrityRun.script,
      status: integrityRun.status,
      detail: integrityRun.payload || null
    },
    {
      id: 'startup_attestation',
      score: scoreStartupAttestation(startupRun),
      ok: startupRun.ok,
      source: startupRun.script,
      status: startupRun.status,
      detail: startupRun.payload || null
    },
    {
      id: 'deployment_packaging',
      score: scoreDeploymentPackaging(deploymentRun),
      ok: deploymentRun.ok,
      source: deploymentRun.script,
      status: deploymentRun.status,
      detail: deploymentRun.payload || null
    },
    {
      id: 'contract_surface',
      score: scoreContractSurface(contractRun),
      ok: contractRun.ok,
      source: contractRun.script,
      status: contractRun.status,
      detail: {
        stdout: String(contractRun.stdout || '').slice(0, 200),
        stderr: String(contractRun.stderr || '').slice(0, 200)
      }
    }
  ];

  const postureScore = scoreWeighted(components, policy.weights || {});
  const verdict = verdictFor(postureScore, policy.thresholds || {});
  const ok = strict ? verdict === 'pass' : verdict !== 'fail';

  const payload = {
    ok,
    type: 'compliance_posture',
    ts: nowIso(),
    date: todayStr(),
    days,
    profile,
    strict,
    policy_version: policy.version,
    policy_path: relPath(policyPath),
    posture_score: postureScore,
    verdict,
    thresholds: policy.thresholds,
    weights: policy.weights,
    components
  };

  ensureDir(OUT_DIR);
  const outPath = path.join(OUT_DIR, `${payload.date}.json`);
  writeJsonAtomic(outPath, payload);
  writeJsonAtomic(LATEST_PATH, payload);
  appendJsonl(HISTORY_PATH, {
    ts: payload.ts,
    type: payload.type,
    date: payload.date,
    strict: payload.strict,
    profile: payload.profile,
    verdict: payload.verdict,
    posture_score: payload.posture_score
  });

  process.stdout.write(`${JSON.stringify({
    ok: payload.ok,
    type: payload.type,
    date: payload.date,
    strict: payload.strict,
    profile: payload.profile,
    posture_score: payload.posture_score,
    verdict: payload.verdict,
    output_path: relPath(outPath)
  })}\n`);
  if (payload.ok !== true) process.exitCode = 1;
}

function statusCmd(dateArg) {
  const useLatest = String(dateArg || '').trim().toLowerCase() === 'latest' || !dateArg;
  const fp = useLatest ? LATEST_PATH : path.join(OUT_DIR, `${String(dateArg || '').trim()}.json`);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'compliance_posture_status',
      error: 'compliance_posture_snapshot_missing'
    })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'compliance_posture_status',
    ts: payload.ts || null,
    date: payload.date || null,
    verdict: payload.verdict || null,
    posture_score: payload.posture_score == null ? null : Number(payload.posture_score),
    strict: payload.strict === true
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') return runCmd(args);
  if (cmd === 'status') return statusCmd(args._[1] || 'latest');
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'compliance_posture',
      error: String(err && err.message ? err.message : err || 'compliance_posture_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  scoreWeighted
};
export {};
