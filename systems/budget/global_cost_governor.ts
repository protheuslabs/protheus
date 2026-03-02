#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-038
 * Global cost governor + autopause guardrails across autonomy/reflex/focus/dream/spawn.
 *
 * Usage:
 *   node systems/budget/global_cost_governor.js evaluate --module=<id> --tokens=<n> [--date=YYYY-MM-DD] [--apply=1|0] [--strict=1|0]
 *   node systems/budget/global_cost_governor.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.GLOBAL_COST_GOVERNOR_ROOT
  ? path.resolve(process.env.GLOBAL_COST_GOVERNOR_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.GLOBAL_COST_GOVERNOR_POLICY_PATH
  ? path.resolve(process.env.GLOBAL_COST_GOVERNOR_POLICY_PATH)
  : path.join(ROOT, 'config', 'global_cost_governor_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 320) {
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

function dateArgOrToday(v: unknown) {
  const s = cleanText(v, 20);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function shiftDate(dateStr: string, deltaDays: number) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
}

function asStringArray(v: unknown) {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = cleanText(item, 80).toLowerCase();
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    modules: ['autonomy', 'reflex', 'focus', 'dream', 'spawn'],
    module_daily_token_caps: {
      autonomy: 4500,
      reflex: 1200,
      focus: 1200,
      dream: 1500,
      spawn: 1500
    },
    daily_token_cap_total: 9000,
    monthly_token_cap_total: 220000,
    burn_rate_multiplier: 1.5,
    min_baseline_days: 3,
    auto_clear_autopause: true,
    state_paths: {
      usage_path: 'state/budget/global_cost_governor/usage.json',
      autopause_path: 'state/autonomy/budget_autopause.json',
      latest_path: 'state/budget/global_cost_governor/latest.json',
      history_path: 'state/budget/global_cost_governor/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const paths = raw.state_paths && typeof raw.state_paths === 'object' ? raw.state_paths : {};
  const modules = asStringArray(raw.modules || base.modules);
  const capsRaw = raw.module_daily_token_caps && typeof raw.module_daily_token_caps === 'object'
    ? raw.module_daily_token_caps
    : base.module_daily_token_caps;
  const moduleCaps: AnyObj = {};
  for (const m of modules) {
    moduleCaps[m] = Math.max(0, Number(capsRaw[m] || base.module_daily_token_caps[m] || 0));
  }
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    modules,
    module_daily_token_caps: moduleCaps,
    daily_token_cap_total: Math.max(0, Number(raw.daily_token_cap_total || base.daily_token_cap_total)),
    monthly_token_cap_total: Math.max(0, Number(raw.monthly_token_cap_total || base.monthly_token_cap_total)),
    burn_rate_multiplier: clampNumber(raw.burn_rate_multiplier, 1, 10, base.burn_rate_multiplier),
    min_baseline_days: Math.max(1, Number(raw.min_baseline_days || base.min_baseline_days)),
    auto_clear_autopause: raw.auto_clear_autopause !== false,
    state_paths: {
      usage_path: resolvePath(paths.usage_path, base.state_paths.usage_path),
      autopause_path: resolvePath(paths.autopause_path, base.state_paths.autopause_path),
      latest_path: resolvePath(paths.latest_path, base.state_paths.latest_path),
      history_path: resolvePath(paths.history_path, base.state_paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadUsage(usagePath: string) {
  const base = readJson(usagePath, {
    schema_id: 'global_cost_governor_usage',
    version: 1,
    updated_at: null,
    by_day: {}
  });
  if (!base || typeof base !== 'object') {
    return {
      schema_id: 'global_cost_governor_usage',
      version: 1,
      updated_at: null,
      by_day: {}
    };
  }
  if (!base.by_day || typeof base.by_day !== 'object') base.by_day = {};
  return base;
}

function dayTotals(usage: AnyObj, day: string, modules: string[]) {
  const row = usage.by_day && usage.by_day[day] && typeof usage.by_day[day] === 'object' ? usage.by_day[day] : {};
  let total = 0;
  const byModule: AnyObj = {};
  for (const m of modules) {
    const n = Math.max(0, Number(row[m] || 0));
    byModule[m] = n;
    total += n;
  }
  return { total, byModule };
}

function monthPrefix(dateStr: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr.slice(0, 7) : '';
}

function cmdEvaluate(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const apply = toBool(args.apply, false);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (!policy.enabled) {
    return {
      ok: true,
      strict,
      apply,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const moduleId = cleanText(args.module || 'autonomy', 80).toLowerCase();
  if (!policy.modules.includes(moduleId)) {
    return {
      ok: false,
      type: 'global_cost_governor',
      error: `unknown_module:${moduleId}`,
      allowed_modules: policy.modules
    };
  }
  const date = dateArgOrToday(args.date);
  const tokens = Math.max(0, Number(args.tokens || 0));
  const usage = loadUsage(policy.state_paths.usage_path);

  if (!usage.by_day[date] || typeof usage.by_day[date] !== 'object') usage.by_day[date] = {};
  const today = usage.by_day[date];
  const beforeModule = Math.max(0, Number(today[moduleId] || 0));
  const projectedModule = beforeModule + tokens;

  const projectedDayByModule = { ...today, [moduleId]: projectedModule };
  let projectedDayTotal = 0;
  for (const m of policy.modules) projectedDayTotal += Math.max(0, Number(projectedDayByModule[m] || 0));

  const baselineDays: number[] = [];
  for (let i = 1; i <= 7; i += 1) {
    const day = shiftDate(date, -i);
    const totals = dayTotals(usage, day, policy.modules);
    if (totals.total > 0) baselineDays.push(totals.total);
  }
  const baselineAvg = baselineDays.length
    ? baselineDays.reduce((s, x) => s + x, 0) / baselineDays.length
    : 0;
  const burnRateRatio = baselineAvg > 0 ? projectedDayTotal / baselineAvg : null;

  const month = monthPrefix(date);
  let monthSpent = 0;
  for (const [day, row] of Object.entries(usage.by_day || {})) {
    if (!String(day).startsWith(month)) continue;
    for (const m of policy.modules) monthSpent += Math.max(0, Number((row as AnyObj)[m] || 0));
  }
  const monthProjected = monthSpent + tokens;

  const blockers: AnyObj[] = [];
  const moduleCap = Number(policy.module_daily_token_caps[moduleId] || 0);
  if (moduleCap > 0 && projectedModule > moduleCap) {
    blockers.push({ gate: 'module_cap', reason: 'module_daily_token_cap_exceeded', module: moduleId, cap: moduleCap, projected: projectedModule });
  }
  if (Number(policy.daily_token_cap_total || 0) > 0 && projectedDayTotal > Number(policy.daily_token_cap_total || 0)) {
    blockers.push({ gate: 'daily_cap', reason: 'daily_token_cap_total_exceeded', cap: Number(policy.daily_token_cap_total || 0), projected: projectedDayTotal });
  }
  if (Number(policy.monthly_token_cap_total || 0) > 0 && monthProjected > Number(policy.monthly_token_cap_total || 0)) {
    blockers.push({ gate: 'monthly_cap', reason: 'monthly_token_cap_total_exceeded', cap: Number(policy.monthly_token_cap_total || 0), projected: monthProjected });
  }
  if (baselineDays.length >= Number(policy.min_baseline_days || 3) && burnRateRatio != null && burnRateRatio > Number(policy.burn_rate_multiplier || 1.5)) {
    blockers.push({ gate: 'burn_rate', reason: 'burn_rate_multiplier_exceeded', ratio: Number(burnRateRatio.toFixed(3)), multiplier: Number(policy.burn_rate_multiplier || 1.5) });
  }

  const hardStop = blockers.length > 0;

  if (apply) {
    usage.by_day[date] = projectedDayByModule;
    usage.updated_at = nowIso();
    writeJsonAtomic(policy.state_paths.usage_path, usage);

    if (hardStop) {
      writeJsonAtomic(policy.state_paths.autopause_path, {
        schema_id: 'system_budget_autopause',
        ts: nowIso(),
        active: true,
        source: 'global_cost_governor',
        reason: blockers[0].reason,
        pressure: 'hard',
        blockers
      });
    } else if (policy.auto_clear_autopause) {
      const current = readJson(policy.state_paths.autopause_path, null);
      if (current && current.active === true) {
        writeJsonAtomic(policy.state_paths.autopause_path, {
          ...current,
          ts: nowIso(),
          active: false,
          source: 'global_cost_governor',
          reason: 'auto_clear_safe_budget_window'
        });
      }
    }
  }

  const autopause = readJson(policy.state_paths.autopause_path, null);
  const out = {
    ok: !hardStop,
    ts: nowIso(),
    type: 'global_cost_governor',
    strict,
    apply,
    module: moduleId,
    tokens,
    date,
    blockers,
    hard_stop: hardStop,
    projected: {
      module_tokens: projectedModule,
      module_cap: moduleCap || null,
      day_total_tokens: projectedDayTotal,
      day_total_cap: Number(policy.daily_token_cap_total || 0) || null,
      month_total_tokens: monthProjected,
      month_total_cap: Number(policy.monthly_token_cap_total || 0) || null,
      burn_rate_ratio: burnRateRatio == null ? null : Number(burnRateRatio.toFixed(3)),
      burn_rate_multiplier: Number(policy.burn_rate_multiplier || 1.5),
      baseline_days: baselineDays.length,
      baseline_avg_tokens: Number(baselineAvg.toFixed(3))
    },
    autopause: autopause && typeof autopause === 'object'
      ? {
        active: autopause.active === true,
        reason: autopause.reason || null,
        source: autopause.source || null
      }
      : null,
    usage_path: rel(policy.state_paths.usage_path),
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.state_paths.latest_path, out);
  appendJsonl(policy.state_paths.history_path, {
    ts: out.ts,
    type: out.type,
    module: moduleId,
    tokens,
    date,
    hard_stop: hardStop,
    blocker_reasons: blockers.map((b) => b.reason).slice(0, 6),
    apply,
    ok: out.ok
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const usage = loadUsage(policy.state_paths.usage_path);
  const date = dateArgOrToday(args.date);
  const today = dayTotals(usage, date, policy.modules);
  return {
    ok: true,
    ts: nowIso(),
    type: 'global_cost_governor_status',
    policy_path: rel(policy.policy_path),
    usage_path: rel(policy.state_paths.usage_path),
    latest_path: rel(policy.state_paths.latest_path),
    latest: readJson(policy.state_paths.latest_path, null),
    autopause: readJson(policy.state_paths.autopause_path, null),
    today
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/budget/global_cost_governor.js evaluate --module=<id> --tokens=<n> [--date=YYYY-MM-DD] [--apply=1|0] [--strict=1|0]');
  console.log('  node systems/budget/global_cost_governor.js status [--date=YYYY-MM-DD]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'evaluate').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  try {
    const payload = cmd === 'evaluate'
      ? cmdEvaluate(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (cmd === 'evaluate' && payload.ok === false && toBool(args.strict, true)) process.exit(1);
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'global_cost_governor_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  cmdEvaluate,
  cmdStatus
};
