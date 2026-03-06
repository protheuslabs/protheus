#!/usr/bin/env node
'use strict';
export {};

/**
 * autotest_doctor_watchdog.js
 *
 * V2-052 out-of-band verifier for repair-plane integrity.
 *
 * Usage:
 *   node systems/ops/autotest_doctor_watchdog.js run [--policy=path]
 *   node systems/ops/autotest_doctor_watchdog.js status [--policy=path]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'autotest_doctor_watchdog_policy.json');

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

function clean(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
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

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === 'object');
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

function resolvePath(raw: unknown, fallbackRel: string) {
  const s = clean(raw, 260);
  if (!s) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

function stableHash(rows: AnyObj[]) {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    force_disable_on_violation: true,
    auto_clear_block: true,
    paths: {
      latest: 'state/ops/autotest_doctor/latest.json',
      history: 'state/ops/autotest_doctor/history.jsonl',
      state: 'state/ops/autotest_doctor/state.json',
      watchdog_state: 'state/ops/autotest_doctor/watchdog_state.json',
      watchdog_history: 'state/ops/autotest_doctor/watchdog_history.jsonl',
      watchdog_block: 'state/ops/autotest_doctor/watchdog_block.json'
    }
  };
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: clean(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    force_disable_on_violation: raw.force_disable_on_violation !== false,
    auto_clear_block: raw.auto_clear_block !== false,
    paths: {
      latest: resolvePath(paths.latest, base.paths.latest),
      history: resolvePath(paths.history, base.paths.history),
      state: resolvePath(paths.state, base.paths.state),
      watchdog_state: resolvePath(paths.watchdog_state, base.paths.watchdog_state),
      watchdog_history: resolvePath(paths.watchdog_history, base.paths.watchdog_history),
      watchdog_block: resolvePath(paths.watchdog_block, base.paths.watchdog_block)
    }
  };
}

function evaluate(policy: AnyObj) {
  const latest = readJson(policy.paths.latest, null);
  const state = readJson(policy.paths.state, {});
  const history = readJsonl(policy.paths.history);
  const previous = readJson(policy.paths.watchdog_state, {});

  const violations = [] as AnyObj[];
  if (!latest || typeof latest !== 'object') {
    violations.push({ code: 'latest_missing', message: 'doctor latest snapshot missing' });
  }
  if (!state || typeof state !== 'object') {
    violations.push({ code: 'state_missing', message: 'doctor state missing' });
  }

  const latestRunId = clean(latest && latest.run_id || '', 120);
  if (latestRunId) {
    const hasRun = history.some((row) => String(row && row.run_id || '') === latestRunId);
    if (!hasRun) violations.push({ code: 'history_run_missing', message: 'latest run_id not present in doctor history', run_id: latestRunId });
  }

  const stateKill = !!(state && state.kill_switch && state.kill_switch.engaged === true);
  const latestKill = !!(latest && latest.kill_switch && latest.kill_switch.engaged === true);
  if (stateKill !== latestKill) {
    violations.push({
      code: 'kill_switch_state_mismatch',
      message: 'doctor state kill-switch does not match latest payload',
      state_kill_switch: stateKill,
      latest_kill_switch: latestKill
    });
  }

  if (latest && latest.apply === true) {
    const gateValid = !!(latest.recipe_release_gate && latest.recipe_release_gate.valid === true);
    if (!gateValid) {
      violations.push({
        code: 'recipe_release_gate_missing',
        message: 'apply run missing valid recipe release gate'
      });
    }
  }

  const actions = Array.isArray(latest && latest.actions) ? latest.actions : [];
  for (const action of actions) {
    const status = String(action && action.status || '');
    if (!['applied', 'rolled_back'].includes(status)) continue;
    if (!clean(action.recipe_id || '', 120)) {
      violations.push({ code: 'missing_recipe_id', message: 'applied/rolled_back action missing recipe_id' });
      break;
    }
    if (!(action.recipe_gate && typeof action.recipe_gate === 'object')) {
      violations.push({ code: 'missing_recipe_gate_attestation', message: 'applied/rolled_back action missing recipe gate attestation' });
      break;
    }
  }

  const historyHash = stableHash(history as AnyObj[]);
  const prevHash = clean(previous && previous.history_hash || '', 120) || null;
  if (prevHash && prevHash === historyHash && latestRunId && latestRunId !== clean(previous.last_run_id || '', 120)) {
    violations.push({
      code: 'history_hash_stalled',
      message: 'doctor history hash unchanged while run_id changed',
      previous_run_id: clean(previous.last_run_id || '', 120) || null,
      latest_run_id: latestRunId
    });
  }

  return {
    ok: violations.length === 0,
    ts: nowIso(),
    run_id: latestRunId || null,
    violations,
    history_hash: historyHash,
    state_kill_switch: stateKill,
    latest_kill_switch: latestKill,
    latest_path: relPath(policy.paths.latest),
    history_path: relPath(policy.paths.history),
    state_path: relPath(policy.paths.state)
  };
}

function runWatchdog(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'autotest_doctor_watchdog_run',
      ts: nowIso(),
      enabled: false,
      skipped: true,
      reason: 'watchdog_disabled'
    };
  }
  const out = evaluate(policy);
  const statePayload = {
    ts: out.ts,
    ok: out.ok,
    history_hash: out.history_hash,
    last_run_id: out.run_id,
    violations: out.violations
  };
  writeJsonAtomic(policy.paths.watchdog_state, statePayload);
  appendJsonl(policy.paths.watchdog_history, {
    ts: out.ts,
    ok: out.ok,
    run_id: out.run_id,
    violation_count: out.violations.length,
    history_hash: out.history_hash
  });

  if (out.ok !== true && policy.force_disable_on_violation === true) {
    writeJsonAtomic(policy.paths.watchdog_block, {
      ts: out.ts,
      active: true,
      reason: clean(out.violations[0] && out.violations[0].code || 'watchdog_violation', 120) || 'watchdog_violation',
      details: out
    });
  } else if (out.ok === true && policy.auto_clear_block === true) {
    writeJsonAtomic(policy.paths.watchdog_block, {
      ts: out.ts,
      active: false,
      reason: 'healthy',
      details: {
        run_id: out.run_id,
        history_hash: out.history_hash
      }
    });
  }

  return {
    ok: out.ok === true,
    type: 'autotest_doctor_watchdog_run',
    ts: out.ts,
    run_id: out.run_id,
    violations: out.violations,
    violation_count: out.violations.length,
    watchdog_state_path: relPath(policy.paths.watchdog_state),
    watchdog_history_path: relPath(policy.paths.watchdog_history),
    watchdog_block_path: relPath(policy.paths.watchdog_block)
  };
}

function status(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.paths.watchdog_state, null);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      type: 'autotest_doctor_watchdog_status',
      error: 'watchdog_state_missing',
      watchdog_state_path: relPath(policy.paths.watchdog_state)
    };
  }
  const block = readJson(policy.paths.watchdog_block, null);
  return {
    ok: true,
    type: 'autotest_doctor_watchdog_status',
    ts: clean(payload.ts || '', 64) || null,
    healthy: payload.ok === true,
    violation_count: Array.isArray(payload.violations) ? payload.violations.length : 0,
    block_active: !!(block && block.active === true),
    watchdog_state_path: relPath(policy.paths.watchdog_state),
    watchdog_block_path: relPath(policy.paths.watchdog_block)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/autotest_doctor_watchdog.js run [--policy=path]');
  console.log('  node systems/ops/autotest_doctor_watchdog.js status [--policy=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    process.stdout.write(`${JSON.stringify(runWatchdog(args))}\n`);
    return;
  }
  if (cmd === 'status') {
    const payload = status(args);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (payload.ok !== true) process.exitCode = 1;
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'autotest_doctor_watchdog',
      error: clean(err && err.message ? err.message : err || 'autotest_doctor_watchdog_failed', 220)
    })}\n`);
    process.exit(1);
  }
}

