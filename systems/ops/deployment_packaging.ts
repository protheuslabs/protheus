#!/usr/bin/env node
'use strict';

/**
 * deployment_packaging.js
 *
 * Deployment packaging gate for container + k8s readiness.
 *
 * Usage:
 *   node systems/ops/deployment_packaging.js run [--profile=dev|prod] [--strict=1|0]
 *   node systems/ops/deployment_packaging.js status [latest]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.DEPLOYMENT_PACKAGING_POLICY_PATH
  ? path.resolve(process.env.DEPLOYMENT_PACKAGING_POLICY_PATH)
  : path.join(ROOT, 'config', 'deployment_packaging_policy.json');
const OUT_DIR = process.env.DEPLOYMENT_PACKAGING_OUT_DIR
  ? path.resolve(process.env.DEPLOYMENT_PACKAGING_OUT_DIR)
  : path.join(ROOT, 'state', 'ops', 'deployment_packaging');
const HISTORY_PATH = path.join(OUT_DIR, 'history.jsonl');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/deployment_packaging.js run [--profile=dev|prod] [--strict=1|0]');
  console.log('  node systems/ops/deployment_packaging.js status [latest]');
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

function normalizeToken(v, maxLen = 80) {
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

function defaultPolicy() {
  return {
    version: '1.0',
    strict_default: true,
    profiles: {
      dev: {
        required_files: [
          'Dockerfile',
          '.dockerignore',
          'docker-compose.yml',
          'deploy/k8s/namespace.yaml',
          'deploy/k8s/configmap.yaml',
          'deploy/k8s/cronjob-daily.yaml',
          'deploy/k8s/networkpolicy.yaml'
        ],
        required_scripts: ['typecheck:systems', 'test:ci', 'guard:merge'],
        checks: {
          docker_require_user: true,
          docker_require_healthcheck: true,
          docker_forbid_latest_tag: true,
          k8s_require_run_as_non_root: true,
          k8s_require_no_privilege_escalation: true
        }
      }
    }
  };
}

function normalizeProfile(raw, fallbackProfile = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const checksRaw = src.checks && typeof src.checks === 'object' ? src.checks : {};
  const fallbackChecks = fallbackProfile.checks && typeof fallbackProfile.checks === 'object'
    ? fallbackProfile.checks
    : {};
  const checkVal = (key, fallback = false) => {
    if (Object.prototype.hasOwnProperty.call(checksRaw, key)) return checksRaw[key] === true;
    if (Object.prototype.hasOwnProperty.call(fallbackChecks, key)) return fallbackChecks[key] === true;
    return fallback;
  };
  return {
    required_files: Array.from(new Set(
      (Array.isArray(src.required_files) ? src.required_files : (Array.isArray(fallbackProfile.required_files) ? fallbackProfile.required_files : []))
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    )),
    required_scripts: Array.from(new Set(
      (Array.isArray(src.required_scripts) ? src.required_scripts : (Array.isArray(fallbackProfile.required_scripts) ? fallbackProfile.required_scripts : []))
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    )),
    checks: {
      docker_require_user: checkVal('docker_require_user', true),
      docker_require_healthcheck: checkVal('docker_require_healthcheck', true),
      docker_forbid_latest_tag: checkVal('docker_forbid_latest_tag', true),
      k8s_require_run_as_non_root: checkVal('k8s_require_run_as_non_root', false),
      k8s_require_no_privilege_escalation: checkVal('k8s_require_no_privilege_escalation', false),
      k8s_require_read_only_root_fs: checkVal('k8s_require_read_only_root_fs', false)
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const profilesRaw = raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {};
  const profiles = {};
  const profileNames = Array.from(new Set([
    ...Object.keys(base.profiles || {}),
    ...Object.keys(profilesRaw || {})
  ]));
  for (const profileName of profileNames) {
    const key = normalizeToken(profileName, 40);
    if (!key) continue;
    profiles[key] = normalizeProfile(profilesRaw[profileName], base.profiles[profileName] || base.profiles.dev || {});
  }
  if (!profiles.dev) {
    profiles.dev = normalizeProfile(base.profiles.dev, base.profiles.dev);
  }
  return {
    version: String(raw.version || base.version),
    strict_default: raw.strict_default !== false,
    profiles
  };
}

function dockerCheckRows(dockerBody, checks) {
  const body = String(dockerBody || '');
  const rows = [];

  if (checks.docker_require_user) {
    const userMatch = body.match(/^\s*USER\s+([^\s#]+)\s*$/im);
    const userValue = userMatch ? String(userMatch[1] || '').trim() : '';
    const pass = !!userValue && userValue !== 'root' && userValue !== '0';
    rows.push({
      id: 'docker_user_non_root',
      pass,
      expected: 'Dockerfile declares non-root USER',
      observed: userValue || 'missing'
    });
  }

  if (checks.docker_require_healthcheck) {
    const pass = /^\s*HEALTHCHECK\s+/im.test(body);
    rows.push({
      id: 'docker_healthcheck_present',
      pass,
      expected: 'Dockerfile declares HEALTHCHECK',
      observed: pass ? 'present' : 'missing'
    });
  }

  if (checks.docker_forbid_latest_tag) {
    const fromLines = [];
    for (const line of body.split('\n')) {
      const m = line.match(/^\s*FROM\s+([^\s]+)\s*/i);
      if (!m) continue;
      fromLines.push(String(m[1] || '').trim());
    }
    let badImage = null;
    for (const image of fromLines) {
      if (!image) continue;
      if (image.includes('@sha256:')) continue;
      const nameTag = image.split('/').pop() || image;
      const hasTag = nameTag.includes(':');
      const tag = hasTag ? nameTag.slice(nameTag.lastIndexOf(':') + 1).trim().toLowerCase() : '';
      if (!hasTag || tag === 'latest') {
        badImage = image;
        break;
      }
    }
    rows.push({
      id: 'docker_base_image_pinned',
      pass: !badImage,
      expected: 'Docker FROM images are pinned (no latest, no implicit latest)',
      observed: badImage || 'pinned'
    });
  }

  return rows;
}

function k8sCheckRows(k8sBody, checks) {
  const body = String(k8sBody || '');
  const rows = [];

  if (checks.k8s_require_run_as_non_root) {
    const pass = /runAsNonRoot:\s*true/i.test(body);
    rows.push({
      id: 'k8s_run_as_non_root',
      pass,
      expected: 'Kubernetes manifests enforce runAsNonRoot: true',
      observed: pass ? 'present' : 'missing'
    });
  }

  if (checks.k8s_require_no_privilege_escalation) {
    const pass = /allowPrivilegeEscalation:\s*false/i.test(body);
    rows.push({
      id: 'k8s_no_privilege_escalation',
      pass,
      expected: 'Kubernetes manifests enforce allowPrivilegeEscalation: false',
      observed: pass ? 'present' : 'missing'
    });
  }

  if (checks.k8s_require_read_only_root_fs) {
    const pass = /readOnlyRootFilesystem:\s*true/i.test(body);
    rows.push({
      id: 'k8s_read_only_root_fs',
      pass,
      expected: 'Kubernetes manifests enforce readOnlyRootFilesystem: true',
      observed: pass ? 'present' : 'missing'
    });
  }

  return rows;
}

function evaluateProfile(profileName, profile) {
  const p = profile && typeof profile === 'object' ? profile : normalizeProfile({}, {});
  const rows = [];

  const missingFiles = [];
  for (const rel of p.required_files || []) {
    const abs = path.resolve(ROOT, rel);
    const pass = fs.existsSync(abs);
    rows.push({
      id: `file:${rel}`,
      pass,
      expected: 'required file exists',
      observed: pass ? 'present' : 'missing'
    });
    if (!pass) missingFiles.push(rel);
  }

  const packageJson = readJson(path.join(ROOT, 'package.json'), {});
  const scripts = packageJson && packageJson.scripts && typeof packageJson.scripts === 'object'
    ? packageJson.scripts
    : {};
  const missingScripts = [];
  for (const scriptName of p.required_scripts || []) {
    const pass = typeof scripts[scriptName] === 'string' && String(scripts[scriptName]).trim().length > 0;
    rows.push({
      id: `script:${scriptName}`,
      pass,
      expected: 'required npm script exists',
      observed: pass ? 'present' : 'missing'
    });
    if (!pass) missingScripts.push(scriptName);
  }

  const dockerPath = path.join(ROOT, 'Dockerfile');
  const dockerBody = fs.existsSync(dockerPath) ? fs.readFileSync(dockerPath, 'utf8') : '';
  rows.push(...dockerCheckRows(dockerBody, p.checks || {}));

  const k8sBodies = [];
  for (const rel of p.required_files || []) {
    if (!String(rel).startsWith('deploy/k8s/')) continue;
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    k8sBodies.push(fs.readFileSync(abs, 'utf8'));
  }
  rows.push(...k8sCheckRows(k8sBodies.join('\n---\n'), p.checks || {}));

  const totalChecks = rows.length;
  const passedChecks = rows.filter((row) => row.pass === true).length;
  const passRate = totalChecks > 0 ? Number((passedChecks / totalChecks).toFixed(4)) : null;
  const failed = rows.filter((row) => row.pass !== true);

  return {
    profile: profileName,
    checks: rows,
    missing_files: missingFiles,
    missing_scripts: missingScripts,
    total_checks: totalChecks,
    passed_checks: passedChecks,
    failed_checks: failed.length,
    pass_rate: passRate,
    failed_check_ids: failed.map((row) => row.id)
  };
}

function verdictFor(passRate, failedChecks) {
  if (Number(failedChecks || 0) === 0) return 'pass';
  const rate = Number(passRate || 0);
  if (rate >= 0.8) return 'warn';
  return 'fail';
}

function runCmd(args) {
  const policyPath = path.resolve(String(args.policy || process.env.DEPLOYMENT_PACKAGING_POLICY_PATH || POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const profileName = normalizeToken(args.profile || 'prod', 40) || 'prod';
  const profile = policy.profiles[profileName] || policy.profiles.dev;
  const strict = toBool(args.strict, policy.strict_default === true);

  const evaluation = evaluateProfile(profileName, profile);
  const verdict = verdictFor(evaluation.pass_rate, evaluation.failed_checks);
  const ok = strict ? verdict === 'pass' : verdict !== 'fail';

  const payload = {
    ok,
    type: 'deployment_packaging',
    ts: nowIso(),
    date: todayStr(),
    strict,
    policy_version: policy.version,
    policy_path: relPath(policyPath),
    profile: evaluation.profile,
    verdict,
    pass_rate: evaluation.pass_rate,
    total_checks: evaluation.total_checks,
    passed_checks: evaluation.passed_checks,
    failed_checks: evaluation.failed_checks,
    failed_check_ids: evaluation.failed_check_ids,
    missing_files: evaluation.missing_files,
    missing_scripts: evaluation.missing_scripts,
    checks: evaluation.checks
  };

  ensureDir(OUT_DIR);
  const outPath = path.join(OUT_DIR, `${payload.date}.${evaluation.profile}.json`);
  writeJsonAtomic(outPath, payload);
  writeJsonAtomic(LATEST_PATH, payload);
  appendJsonl(HISTORY_PATH, {
    ts: payload.ts,
    type: payload.type,
    date: payload.date,
    profile: payload.profile,
    strict: payload.strict,
    verdict: payload.verdict,
    pass_rate: payload.pass_rate,
    failed_checks: payload.failed_checks
  });

  process.stdout.write(`${JSON.stringify({
    ok: payload.ok,
    type: payload.type,
    date: payload.date,
    profile: payload.profile,
    strict: payload.strict,
    verdict: payload.verdict,
    pass_rate: payload.pass_rate,
    failed_checks: payload.failed_checks,
    output_path: relPath(outPath)
  })}\n`);
  if (payload.ok !== true) process.exitCode = 1;
}

function statusCmd(dateArg) {
  const useLatest = String(dateArg || '').trim().toLowerCase() === 'latest' || !dateArg;
  const targetPath = useLatest
    ? LATEST_PATH
    : path.join(OUT_DIR, `${String(dateArg || '').trim()}.prod.json`);
  const payload = readJson(targetPath, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'deployment_packaging_status',
      error: 'packaging_snapshot_missing'
    })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'deployment_packaging_status',
    ts: payload.ts || null,
    date: payload.date || null,
    profile: payload.profile || null,
    strict: payload.strict === true,
    verdict: payload.verdict || null,
    pass_rate: payload.pass_rate == null ? null : Number(payload.pass_rate),
    failed_checks: Number(payload.failed_checks || 0)
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
      type: 'deployment_packaging',
      error: String(err && err.message ? err.message : err || 'deployment_packaging_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  evaluateProfile
};
export {};
