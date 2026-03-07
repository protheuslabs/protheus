#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-026
 * Ops visibility dashboard + SLO alerts for autonomy health.
 *
 * Usage:
 *   node systems/ops/autonomy_health_visibility_dashboard.js daily [--strict=1|0]
 *   node systems/ops/autonomy_health_visibility_dashboard.js weekly [--strict=1|0]
 *   node systems/ops/autonomy_health_visibility_dashboard.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.AUTONOMY_HEALTH_DASHBOARD_ROOT
  ? path.resolve(process.env.AUTONOMY_HEALTH_DASHBOARD_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.AUTONOMY_HEALTH_DASHBOARD_POLICY_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_DASHBOARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'autonomy_health_visibility_dashboard_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 360) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const eq = tok.indexOf('=');
    if (eq >= 0) { out[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
    out[key] = true;
  }
  return out;
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
  const x = Math.trunc(n);
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = null) {
  try { if (!fs.existsSync(filePath)) return fallback; const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); return parsed == null ? fallback : parsed; } catch { return fallback; }
}
function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
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
function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}
function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    thresholds: {
      dark_eye_hours: 24,
      proposal_starvation_hours: 12,
      loop_stall_hours: 6,
      drift_ratio_warn: 0.4
    },
    inputs: {
      eyes_registry_path: 'state/sensory/eyes/registry.json',
      queue_log_path: 'state/sensory/queue_log.jsonl',
      autonomy_runs_path: 'state/autonomy/runs',
      receipt_summary_path: 'state/autonomy/receipt_summary/latest.json'
    },
    outputs: {
      daily_path: 'state/ops/autonomy_health_visibility_dashboard/daily.json',
      weekly_path: 'state/ops/autonomy_health_visibility_dashboard/weekly.json',
      alerts_path: 'state/ops/autonomy_health_visibility_dashboard/alerts.jsonl',
      latest_path: 'state/ops/autonomy_health_visibility_dashboard/latest.json',
      history_path: 'state/ops/autonomy_health_visibility_dashboard/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const inputs = raw.inputs && typeof raw.inputs === 'object' ? raw.inputs : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    thresholds: {
      dark_eye_hours: clampInt(thresholds.dark_eye_hours, 1, 24 * 30, base.thresholds.dark_eye_hours),
      proposal_starvation_hours: clampInt(thresholds.proposal_starvation_hours, 1, 24 * 30, base.thresholds.proposal_starvation_hours),
      loop_stall_hours: clampInt(thresholds.loop_stall_hours, 1, 24 * 30, base.thresholds.loop_stall_hours),
      drift_ratio_warn: Math.max(0, Math.min(1, Number(thresholds.drift_ratio_warn || base.thresholds.drift_ratio_warn)))
    },
    inputs: {
      eyes_registry_path: resolvePath(inputs.eyes_registry_path, base.inputs.eyes_registry_path),
      queue_log_path: resolvePath(inputs.queue_log_path, base.inputs.queue_log_path),
      autonomy_runs_path: resolvePath(inputs.autonomy_runs_path, base.inputs.autonomy_runs_path),
      receipt_summary_path: resolvePath(inputs.receipt_summary_path, base.inputs.receipt_summary_path)
    },
    outputs: {
      daily_path: resolvePath(outputs.daily_path, base.outputs.daily_path),
      weekly_path: resolvePath(outputs.weekly_path, base.outputs.weekly_path),
      alerts_path: resolvePath(outputs.alerts_path, base.outputs.alerts_path),
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function ageHours(ts: string | null) {
  if (!ts) return null;
  const ms = Date.parse(String(ts));
  if (!Number.isFinite(ms)) return null;
  return Number(((Date.now() - ms) / (1000 * 60 * 60)).toFixed(3));
}

function latestRunTs(runsPath: string) {
  if (!fs.existsSync(runsPath)) return null;
  const files = fs.readdirSync(runsPath).filter((name) => name.endsWith('.jsonl')).sort().reverse();
  for (const file of files.slice(0, 7)) {
    const rows = readJsonl(path.join(runsPath, file));
    if (!rows.length) continue;
    const tail = rows[rows.length - 1];
    const ts = cleanText(tail && (tail.ts || tail.updated_at || tail.created_at), 64);
    if (ts) return ts;
  }
  return null;
}

function buildHealthSnapshot(policy: AnyObj, window: 'daily' | 'weekly') {
  const registry = readJson(policy.inputs.eyes_registry_path, {});
  const eyes = Array.isArray(registry.eyes) ? registry.eyes : [];
  const queueEvents = readJsonl(policy.inputs.queue_log_path);
  const receiptSummary = readJson(policy.inputs.receipt_summary_path, {});

  const activeEyes = eyes.filter((row: AnyObj) => row && row.status !== 'disabled');
  const darkEyes = activeEyes.filter((row: AnyObj) => {
    const age = ageHours(cleanText(row && (row.last_seen_at || row.last_run_at || row.updated_at), 64) || null);
    if (age == null) return true;
    return age > Number(policy.thresholds.dark_eye_hours || 24);
  });

  const lastProposalTs = (() => {
    for (let i = queueEvents.length - 1; i >= 0; i -= 1) {
      const row = queueEvents[i];
      if (String(row && row.type || '') === 'proposal_generated') return cleanText(row && row.ts, 64) || null;
    }
    return null;
  })();

  const lastLoopTs = latestRunTs(policy.inputs.autonomy_runs_path);
  const proposalStarvationHours = ageHours(lastProposalTs);
  const loopStallHours = ageHours(lastLoopTs);

  const queueGenerated = queueEvents.filter((row: AnyObj) => String(row && row.type || '') === 'proposal_generated').length;
  const queueFiltered = queueEvents.filter((row: AnyObj) => String(row && row.type || '') === 'proposal_filtered').length;
  const driftRatio = queueGenerated > 0 ? Number((queueFiltered / Math.max(1, queueGenerated)).toFixed(6)) : 0;

  const alerts: AnyObj[] = [];
  if (darkEyes.length > 0) alerts.push({ key: 'dark_eye', severity: darkEyes.length >= 3 ? 'high' : 'medium', value: darkEyes.length });
  if (proposalStarvationHours != null && proposalStarvationHours > Number(policy.thresholds.proposal_starvation_hours || 12)) alerts.push({ key: 'proposal_starvation', severity: 'high', value: proposalStarvationHours });
  if (loopStallHours != null && loopStallHours > Number(policy.thresholds.loop_stall_hours || 6)) alerts.push({ key: 'loop_stall', severity: 'high', value: loopStallHours });
  if (driftRatio >= Number(policy.thresholds.drift_ratio_warn || 0.4)) alerts.push({ key: 'drift_warn', severity: 'medium', value: driftRatio });

  return {
    ts: nowIso(),
    type: `autonomy_health_visibility_dashboard_${window}`,
    window,
    metrics: {
      active_eyes: activeEyes.length,
      dark_eyes: darkEyes.length,
      queue_generated: queueGenerated,
      queue_filtered: queueFiltered,
      drift_ratio: driftRatio,
      proposal_starvation_hours: proposalStarvationHours,
      loop_stall_hours: loopStallHours,
      verification_pass_rate: Number(receiptSummary && receiptSummary.pass_rate || 0)
    },
    alerts,
    sources: {
      eyes_registry_path: rel(policy.inputs.eyes_registry_path),
      queue_log_path: rel(policy.inputs.queue_log_path),
      autonomy_runs_path: rel(policy.inputs.autonomy_runs_path),
      receipt_summary_path: rel(policy.inputs.receipt_summary_path)
    }
  };
}

function emitReport(policy: AnyObj, snapshot: AnyObj) {
  const reportPath = snapshot.window === 'weekly' ? policy.outputs.weekly_path : policy.outputs.daily_path;
  writeJsonAtomic(reportPath, snapshot);
  writeJsonAtomic(policy.outputs.latest_path, snapshot);
  appendJsonl(policy.outputs.history_path, {
    ts: snapshot.ts,
    type: snapshot.type,
    alert_count: Array.isArray(snapshot.alerts) ? snapshot.alerts.length : 0,
    active_eyes: snapshot.metrics.active_eyes,
    dark_eyes: snapshot.metrics.dark_eyes,
    ok: true
  });
  if (Array.isArray(snapshot.alerts) && snapshot.alerts.length > 0) {
    appendJsonl(policy.outputs.alerts_path, {
      ts: snapshot.ts,
      type: 'autonomy_health_alert_batch',
      window: snapshot.window,
      alerts: snapshot.alerts
    });
  }
}

function cmdDaily(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const snapshot = buildHealthSnapshot(policy, 'daily');
  emitReport(policy, snapshot);
  return { ok: true, strict, ...snapshot, policy_path: rel(policy.policy_path) };
}

function cmdWeekly(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const snapshot = buildHealthSnapshot(policy, 'weekly');
  emitReport(policy, snapshot);
  return { ok: true, strict, ...snapshot, policy_path: rel(policy.policy_path) };
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'autonomy_health_visibility_dashboard_status',
    latest: readJson(policy.outputs.latest_path, null),
    latest_path: rel(policy.outputs.latest_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/autonomy_health_visibility_dashboard.js daily [--strict=1|0]');
  console.log('  node systems/ops/autonomy_health_visibility_dashboard.js weekly [--strict=1|0]');
  console.log('  node systems/ops/autonomy_health_visibility_dashboard.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  const payload = cmd === 'daily' ? cmdDaily(args)
    : cmd === 'weekly' ? cmdWeekly(args)
      : cmd === 'status' ? cmdStatus(args)
        : { ok: false, error: `unknown_command:${cmd}` };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
  if (payload.ok === false) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'autonomy_health_visibility_dashboard_failed', 260) })}\n`);
    process.exit(1);
  }
}

module.exports = { loadPolicy, cmdDaily, cmdWeekly, cmdStatus, buildHealthSnapshot };
