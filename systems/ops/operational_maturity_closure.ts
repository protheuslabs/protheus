#!/usr/bin/env node
'use strict';
export {};

/**
 * operational_maturity_closure.js
 *
 * V2-057 closure pack:
 * - Verify all required checks map to runbooks + owners.
 * - Verify escalation lane is working.
 * - Auto-remediate major classes (eyes, visualizer, alert transport) with bounded retries.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.OPS_MATURITY_CLOSURE_POLICY_PATH
  ? path.resolve(process.env.OPS_MATURITY_CLOSURE_POLICY_PATH)
  : path.join(ROOT, 'config', 'operational_maturity_closure_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function clean(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function normalizeList(v: unknown) {
  if (Array.isArray(v)) return v.map((row) => clean(row, 120)).filter(Boolean);
  const raw = clean(v, 400);
  if (!raw) return [];
  return raw.split(',').map((row) => clean(row, 120)).filter(Boolean);
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

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
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

function resolvePath(raw: unknown, fallbackRel: string) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

function parseJsonFromText(raw: unknown) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    runbook_map_path: 'config/autonomy_slo_runbook_map.json',
    state_path: 'state/ops/operational_maturity_closure/latest.json',
    history_path: 'state/ops/operational_maturity_closure/history.jsonl',
    escalation: {
      enabled: true,
      script: 'systems/ops/alert_transport_health.js',
      args: ['run', '--strict=1'],
      timeout_ms: 30000
    },
    classes: {
      eyes: {
        enabled: true,
        retries: 2,
        timeout_ms: 120000,
        health: {
          script: 'habits/scripts/external_eyes.js',
          args: ['preflight', '--strict']
        },
        remediate: {
          script: 'habits/scripts/external_eyes.js',
          args: ['preflight']
        }
      },
      visualizer: {
        enabled: true,
        retries: 1,
        timeout_ms: 40000,
        health: {
          script: 'systems/ops/system_visualizer_guard.js',
          args: ['check', '--strict=1']
        },
        remediate: {
          script: 'systems/ops/system_visualizer_guard.js',
          args: ['restart']
        }
      },
      alert_transport: {
        enabled: true,
        retries: 1,
        timeout_ms: 40000,
        health: {
          script: 'systems/ops/alert_transport_health.js',
          args: ['run', '--strict=1']
        },
        remediate: {
          script: 'systems/ops/alert_transport_health.js',
          args: ['run']
        }
      }
    }
  };
}

function normalizeCommand(raw: AnyObj, fallback: AnyObj) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  return {
    script: resolvePath(src.script, fb.script || ''),
    args: normalizeList(src.args).length > 0 ? normalizeList(src.args) : normalizeList(fb.args),
    timeout_ms: clampInt(src.timeout_ms, 200, 15 * 60 * 1000, Number(fb.timeout_ms || 30000))
  };
}

function normalizeClass(raw: AnyObj, fallback: AnyObj) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  return {
    enabled: toBool(src.enabled, fb.enabled !== false),
    retries: clampInt(src.retries, 0, 10, Number(fb.retries || 1)),
    timeout_ms: clampInt(src.timeout_ms, 200, 15 * 60 * 1000, Number(fb.timeout_ms || 30000)),
    health: normalizeCommand(src.health, fb.health),
    remediate: normalizeCommand(src.remediate, fb.remediate)
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const classes = raw && raw.classes && typeof raw.classes === 'object'
    ? raw.classes
    : {};
  return {
    version: clean(raw.version || base.version, 24) || '1.0',
    enabled: toBool(raw.enabled, true),
    runbook_map_path: resolvePath(raw.runbook_map_path, base.runbook_map_path),
    state_path: resolvePath(raw.state_path, base.state_path),
    history_path: resolvePath(raw.history_path, base.history_path),
    escalation: normalizeCommand(raw.escalation, base.escalation),
    classes: {
      eyes: normalizeClass(classes.eyes, base.classes.eyes),
      visualizer: normalizeClass(classes.visualizer, base.classes.visualizer),
      alert_transport: normalizeClass(classes.alert_transport, base.classes.alert_transport)
    }
  };
}

function runNodeCommand(cmd: AnyObj) {
  const scriptPath = String(cmd && cmd.script || '').trim();
  if (!scriptPath) {
    return {
      ok: false,
      code: 1,
      payload: null,
      stdout: '',
      stderr: '',
      error: 'script_missing'
    };
  }
  const args = Array.isArray(cmd && cmd.args) ? cmd.args : [];
  const timeoutMs = clampInt(cmd && cmd.timeout_ms, 200, 15 * 60 * 1000, 30000);
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const payload = parseJsonFromText(res && res.stdout);
  const status = Number.isInteger(res && res.status) ? Number(res.status) : 1;
  const parsedOk = payload && typeof payload === 'object'
    ? (payload.ok === true && (payload.pass == null || payload.pass === true) && (payload.healthy == null || payload.healthy === true))
    : null;
  const ok = status === 0 && (parsedOk !== false);
  return {
    ok,
    code: status,
    payload,
    stdout: clean(res && res.stdout || '', 1000),
    stderr: clean(res && res.stderr || '', 1000),
    error: res && res.error ? clean(res.error.message || res.error, 180) : null
  };
}

function evaluateRunbookCoverage(runbookMapPath: string) {
  const map = readJson(runbookMapPath, {});
  const requiredChecks = Array.isArray(map && map.required_checks) ? map.required_checks : [];
  const mappings = map && map.mappings && typeof map.mappings === 'object' ? map.mappings : {};
  const missing = [];
  for (const check of requiredChecks) {
    const key = String(check || '').trim();
    const row = mappings[key];
    if (!row || typeof row !== 'object') {
      missing.push({ check: key, reason: 'mapping_missing' });
      continue;
    }
    const owner = clean(row.owner || '', 80);
    const runbookId = clean(row.runbook_id || '', 80);
    const section = clean(row.section || '', 180);
    if (!owner) missing.push({ check: key, reason: 'owner_missing' });
    if (!runbookId) missing.push({ check: key, reason: 'runbook_id_missing' });
    if (!section) missing.push({ check: key, reason: 'section_missing' });
  }
  return {
    required_count: requiredChecks.length,
    missing,
    pass: missing.length === 0
  };
}

function runClassRemediation(name: string, cfg: AnyObj) {
  if (!cfg || cfg.enabled !== true) {
    return {
      class: name,
      enabled: false,
      pass: true,
      healthy_initial: true,
      healthy_final: true,
      attempts: []
    };
  }
  const attempts = [];
  const healthInitial = runNodeCommand({
    ...cfg.health,
    timeout_ms: cfg.timeout_ms
  });
  attempts.push({
    phase: 'health_initial',
    ok: healthInitial.ok,
    code: healthInitial.code,
    payload: healthInitial.payload || null,
    error: healthInitial.error || null
  });
  if (healthInitial.ok === true) {
    return {
      class: name,
      enabled: true,
      pass: true,
      healthy_initial: true,
      healthy_final: true,
      remediation_attempts: 0,
      attempts
    };
  }

  const maxRetries = clampInt(cfg.retries, 0, 10, 1);
  let healthyFinal = false;
  let remediationAttempts = 0;
  for (let i = 0; i < maxRetries; i += 1) {
    remediationAttempts += 1;
    const remediate = runNodeCommand({
      ...cfg.remediate,
      timeout_ms: cfg.timeout_ms
    });
    attempts.push({
      phase: 'remediate',
      index: i + 1,
      ok: remediate.ok,
      code: remediate.code,
      payload: remediate.payload || null,
      error: remediate.error || null
    });
    const healthAfter = runNodeCommand({
      ...cfg.health,
      timeout_ms: cfg.timeout_ms
    });
    attempts.push({
      phase: 'health_after_remediate',
      index: i + 1,
      ok: healthAfter.ok,
      code: healthAfter.code,
      payload: healthAfter.payload || null,
      error: healthAfter.error || null
    });
    if (healthAfter.ok === true) {
      healthyFinal = true;
      break;
    }
  }

  return {
    class: name,
    enabled: true,
    pass: healthyFinal,
    healthy_initial: false,
    healthy_final: healthyFinal,
    remediation_attempts: remediationAttempts,
    attempts
  };
}

function runClosure(policyPath: string, strict = false) {
  const policy = loadPolicy(policyPath);
  const runbookCoverage = evaluateRunbookCoverage(policy.runbook_map_path);
  const escalation = policy.enabled === true
    ? runNodeCommand(policy.escalation)
    : { ok: true, code: 0, payload: null, stdout: '', stderr: '', error: null };

  const classes = {
    eyes: runClassRemediation('eyes', policy.classes.eyes),
    visualizer: runClassRemediation('visualizer', policy.classes.visualizer),
    alert_transport: runClassRemediation('alert_transport', policy.classes.alert_transport)
  };
  const classRows = Object.values(classes);
  const remediationPass = classRows.every((row: AnyObj) => row && row.pass === true);
  const overallPass = policy.enabled === true
    ? (runbookCoverage.pass === true && escalation.ok === true && remediationPass)
    : true;

  const payload = {
    ok: overallPass || strict !== true,
    type: 'operational_maturity_closure',
    ts: nowIso(),
    strict,
    pass: overallPass,
    policy_path: relPath(policyPath),
    policy_version: policy.version,
    checks: {
      enabled: policy.enabled === true,
      runbook_coverage: runbookCoverage.pass === true,
      escalation_path: escalation.ok === true,
      remediation_classes: remediationPass
    },
    runbook_coverage: runbookCoverage,
    escalation: {
      ok: escalation.ok,
      code: escalation.code,
      payload: escalation.payload || null,
      error: escalation.error || null
    },
    remediation: classes
  };
  writeJsonAtomic(policy.state_path, payload);
  appendJsonl(policy.history_path, payload);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (strict === true && overallPass !== true) process.exit(1);
}

function statusCmd(policyPath: string) {
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.state_path, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'operational_maturity_closure_status',
      error: 'operational_maturity_closure_latest_missing',
      state_path: relPath(policy.state_path)
    })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'operational_maturity_closure_status',
    ts: payload.ts || null,
    pass: payload.pass === true,
    checks: payload.checks || {},
    state_path: relPath(policy.state_path),
    history_path: relPath(policy.history_path)
  })}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/operational_maturity_closure.js run [--policy=path] [--strict=1]');
  console.log('  node systems/ops/operational_maturity_closure.js status [--policy=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = clean(args._[0] || 'run', 20).toLowerCase();
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  if (cmd === 'run') return runClosure(policyPath, toBool(args.strict, false));
  if (cmd === 'status') return statusCmd(policyPath);
  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'operational_maturity_closure',
      error: clean(err && err.message ? err.message : err || 'operational_maturity_closure_failed', 240)
    })}\n`);
    process.exit(1);
  }
}

