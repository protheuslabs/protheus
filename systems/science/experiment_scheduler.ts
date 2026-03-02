#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-SCI-005
 * Autonomous long-horizon experiment scheduler.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = process.env.EXPERIMENT_SCHEDULER_ROOT
  ? path.resolve(process.env.EXPERIMENT_SCHEDULER_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.EXPERIMENT_SCHEDULER_POLICY_PATH
  ? path.resolve(process.env.EXPERIMENT_SCHEDULER_POLICY_PATH)
  : path.join(ROOT, 'config', 'experiment_scheduler_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 360) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
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
  const x = Math.floor(n);
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
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

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function stableHash(v: unknown, len = 16) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    no_op_default: false,
    max_risk: 0.6,
    consent_timeout_minutes: 120,
    schedule_interval_minutes: 60,
    default_deny_without_consent: true,
    sandbox_required: true,
    paths: {
      hypotheses_path: 'state/science/hypothesis_forge/ranked.json',
      queue_path: 'state/science/experiment_scheduler/queue.jsonl',
      latest_path: 'state/science/experiment_scheduler/latest.json',
      history_path: 'state/science/experiment_scheduler/history.jsonl',
      no_op_state_path: 'state/science/experiment_scheduler/noop_state.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    no_op_default: raw.no_op_default === true,
    max_risk: clampNumber(raw.max_risk, 0, 1, base.max_risk),
    consent_timeout_minutes: clampInt(raw.consent_timeout_minutes, 1, 60 * 24 * 14, base.consent_timeout_minutes),
    schedule_interval_minutes: clampInt(raw.schedule_interval_minutes, 1, 60 * 24, base.schedule_interval_minutes),
    default_deny_without_consent: raw.default_deny_without_consent !== false,
    sandbox_required: raw.sandbox_required !== false,
    paths: {
      hypotheses_path: resolvePath(paths.hypotheses_path, base.paths.hypotheses_path),
      queue_path: resolvePath(paths.queue_path, base.paths.queue_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      no_op_state_path: resolvePath(paths.no_op_state_path, base.paths.no_op_state_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadHypotheses(filePath: string) {
  const parsed = readJson(filePath, []);
  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.ranked) ? parsed.ranked : []);
  const out = rows.map((row: AnyObj, idx: number) => ({
    id: cleanText(row && row.id, 80) || `hyp_${idx + 1}`,
    text: cleanText(row && row.text, 1600),
    score: Number.isFinite(Number(row && row.score)) ? Number(row.score) : 0,
    voi: clampNumber(row && row.voi, 0, 1, 0.5),
    risk: clampNumber(row && row.risk, 0, 1, 0.3),
    rank_receipt_id: cleanText(row && row.rank_receipt_id, 120) || null
  })).filter((row: AnyObj) => row.text);

  out.sort((a: AnyObj, b: AnyObj) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.id).localeCompare(String(b.id));
  });
  return out;
}

function loadConsentMap(consentFile: string | null) {
  if (!consentFile) return {};
  const abs = path.isAbsolute(consentFile) ? consentFile : path.join(ROOT, consentFile);
  const parsed = readJson(abs, {});
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function activeNoOp(policy: AnyObj) {
  const state = readJson(policy.paths.no_op_state_path, {});
  return state && state.active === true;
}

function evaluateConsent(id: string, consentRow: AnyObj, nowMs: number, timeoutMinutes: number) {
  if (!consentRow || typeof consentRow !== 'object') {
    return { ok: false, reason: 'consent_missing' };
  }
  if (consentRow.approved !== true) {
    return { ok: false, reason: 'consent_not_approved' };
  }
  const expiresMs = parseIsoMs(consentRow.expires_at);
  const fallbackExpires = nowMs + (timeoutMinutes * 60 * 1000);
  const effectiveExpires = Number.isFinite(expiresMs) ? Number(expiresMs) : fallbackExpires;
  if (effectiveExpires <= nowMs) {
    return { ok: false, reason: 'consent_expired' };
  }
  return {
    ok: true,
    reason: null,
    expires_at: new Date(effectiveExpires).toISOString(),
    consent_id: cleanText(consentRow.id || id, 80) || id
  };
}

function buildSchedule(rows: AnyObj[], policy: AnyObj, nowMs: number, consentMap: AnyObj) {
  const decisions: AnyObj[] = [];
  let slot = 0;
  for (const row of rows) {
    if (policy.sandbox_required === true && row.risk > policy.max_risk) {
      decisions.push({
        id: row.id,
        decision: 'denied',
        reason: 'risk_above_sandbox_threshold',
        risk: row.risk,
        score: row.score
      });
      continue;
    }

    const consent = evaluateConsent(row.id, consentMap[row.id], nowMs, policy.consent_timeout_minutes);
    if (policy.default_deny_without_consent === true && consent.ok !== true) {
      decisions.push({
        id: row.id,
        decision: 'denied',
        reason: String(consent.reason || 'consent_required'),
        risk: row.risk,
        score: row.score
      });
      continue;
    }

    const scheduleAt = new Date(nowMs + (slot * policy.schedule_interval_minutes * 60 * 1000)).toISOString();
    slot += 1;
    decisions.push({
      id: row.id,
      decision: 'scheduled',
      reason: 'approved',
      risk: row.risk,
      score: row.score,
      schedule_at: scheduleAt,
      consent_expires_at: consent.expires_at || null,
      receipt_id: `exp_sched_${stableHash(`${row.id}|${scheduleAt}|${row.score}`, 14)}`
    });
  }
  return decisions;
}

function cmdSchedule(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (!policy.enabled) {
    return {
      ok: true,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const noOp = activeNoOp(policy) || policy.no_op_default === true;
  const hypothesesFileRaw = cleanText(args['hypotheses-file'] || args.hypotheses_file, 520);
  const hypothesesPath = hypothesesFileRaw
    ? (path.isAbsolute(hypothesesFileRaw) ? hypothesesFileRaw : path.join(ROOT, hypothesesFileRaw))
    : policy.paths.hypotheses_path;
  const consentFile = cleanText(args['consent-map-file'] || args.consent_map_file, 520) || null;
  const apply = toBool(args.apply, false);
  const nowMs = parseIsoMs(args['now-iso'] || args.now_iso) || Date.now();

  const hypotheses = loadHypotheses(hypothesesPath);
  const consentMap = loadConsentMap(consentFile);
  const decisions = buildSchedule(hypotheses, policy, nowMs, consentMap);

  const scheduled = decisions.filter((d) => d.decision === 'scheduled');
  const denied = decisions.filter((d) => d.decision === 'denied');

  if (apply && !noOp) {
    for (const item of scheduled) {
      appendJsonl(policy.paths.queue_path, {
        ts: nowIso(),
        type: 'science_experiment_scheduled',
        hypothesis_id: item.id,
        schedule_at: item.schedule_at,
        risk: item.risk,
        score: item.score,
        receipt_id: item.receipt_id
      });
    }
  }

  const out = {
    ok: true,
    ts: nowIso(),
    type: 'experiment_scheduler_schedule',
    apply,
    no_op_mode: noOp,
    hypotheses_source: rel(hypothesesPath),
    total_hypotheses: hypotheses.length,
    scheduled_count: scheduled.length,
    denied_count: denied.length,
    decisions,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    apply,
    no_op_mode: noOp,
    total_hypotheses: out.total_hypotheses,
    scheduled_count: out.scheduled_count,
    denied_count: out.denied_count
  });

  return out;
}

function cmdRollback(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const reason = cleanText(args.reason || 'operator_requested_noop_rollback', 240) || 'operator_requested_noop_rollback';
  const out = {
    schema_id: 'experiment_scheduler_noop_state',
    ts: nowIso(),
    active: true,
    reason
  };
  writeJsonAtomic(policy.paths.no_op_state_path, out);

  const payload = {
    ok: true,
    ts: nowIso(),
    type: 'experiment_scheduler_rollback',
    no_op_mode: true,
    reason,
    no_op_state_path: rel(policy.paths.no_op_state_path),
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.paths.latest_path, payload);
  appendJsonl(policy.paths.history_path, {
    ts: payload.ts,
    type: payload.type,
    no_op_mode: true,
    reason
  });

  return payload;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'experiment_scheduler_status',
    latest: readJson(policy.paths.latest_path, null),
    no_op_state: readJson(policy.paths.no_op_state_path, { active: false }),
    latest_path: rel(policy.paths.latest_path),
    queue_path: rel(policy.paths.queue_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/science/experiment_scheduler.js schedule [--hypotheses-file=<path>] [--consent-map-file=<path>] [--apply=1] [--now-iso=<iso>] [--policy=<path>]');
  console.log('  node systems/science/experiment_scheduler.js rollback [--reason=<text>] [--policy=<path>]');
  console.log('  node systems/science/experiment_scheduler.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 80).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  try {
    const out = cmd === 'schedule'
      ? cmdSchedule(args)
      : cmd === 'rollback'
        ? cmdRollback(args)
        : cmd === 'status'
          ? cmdStatus(args)
          : null;
    if (!out) {
      usage();
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText(err && err.message ? err.message : err, 420) }, null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  loadHypotheses,
  buildSchedule,
  cmdSchedule,
  cmdRollback,
  cmdStatus
};
