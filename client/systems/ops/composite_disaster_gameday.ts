#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-FCH-003
 * Composite disaster gameday orchestrator.
 *
 * Usage:
 *   node systems/ops/composite_disaster_gameday.js run [--strict=1|0]
 *   node systems/ops/composite_disaster_gameday.js status
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = process.env.COMPOSITE_GAMEDAY_ROOT
  ? path.resolve(process.env.COMPOSITE_GAMEDAY_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.COMPOSITE_GAMEDAY_POLICY_PATH
  ? path.resolve(process.env.COMPOSITE_GAMEDAY_POLICY_PATH)
  : path.join(ROOT, 'config', 'composite_disaster_gameday_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
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

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/composite_disaster_gameday.js run [--strict=1|0] [--policy=path]');
  console.log('  node systems/ops/composite_disaster_gameday.js status [--policy=path]');
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

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const token = cleanText(raw || '', 500);
  if (!token) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(token) ? token : path.join(ROOT, token);
}

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function id16(seed: string) {
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}

function defaultPolicy() {
  return {
    schema_id: 'composite_disaster_gameday_policy',
    schema_version: '1.0',
    enabled: true,
    strict_default: false,
    cadence_hours: 168,
    max_total_duration_ms: 600000,
    require_postmortem: true,
    scenarios: [],
    outputs: {
      latest_path: 'state/ops/composite_disaster_gameday/latest.json',
      history_path: 'state/ops/composite_disaster_gameday/history.jsonl',
      postmortem_dir: 'state/ops/composite_disaster_gameday/postmortems'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const scenarioRows = Array.isArray(raw.scenarios) ? raw.scenarios : [];
  const scenarios = scenarioRows
    .map((row: AnyObj) => {
      const command = Array.isArray(row && row.command)
        ? row.command.map((v: unknown) => cleanText(v, 320)).filter(Boolean)
        : [];
      return {
        id: normalizeToken(row && row.id || '', 120),
        stage: normalizeToken(row && row.stage || '', 80) || 'unknown',
        required: row && row.required !== false,
        timeout_ms: clampInt(row && row.timeout_ms, 1000, 24 * 60 * 60 * 1000, 120000),
        command
      };
    })
    .filter((row: AnyObj) => !!row.id && row.command.length >= 2);
  return {
    schema_id: 'composite_disaster_gameday_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    cadence_hours: clampInt(raw.cadence_hours, 1, 24 * 365, base.cadence_hours),
    max_total_duration_ms: clampInt(raw.max_total_duration_ms, 1000, 24 * 60 * 60 * 1000, base.max_total_duration_ms),
    require_postmortem: toBool(raw.require_postmortem, base.require_postmortem),
    scenarios,
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path),
      postmortem_dir: resolvePath(outputs.postmortem_dir, base.outputs.postmortem_dir)
    },
    policy_path: path.resolve(policyPath)
  };
}

function execScenario(row: AnyObj) {
  const command = row.command[0] === 'node'
    ? process.execPath
    : row.command[0];
  const args = row.command[0] === 'node' ? row.command.slice(1) : row.command.slice(1);
  const started = Date.now();
  const run = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: row.timeout_ms
  });
  const durationMs = Date.now() - started;
  const timedOut = !!(run.error && String(run.error.code || '').toUpperCase() === 'ETIMEDOUT');
  return {
    scenario_id: row.id,
    stage: row.stage,
    required: row.required === true,
    command: [command, ...args].join(' '),
    timeout_ms: row.timeout_ms,
    ok: run.status === 0 && !timedOut,
    status: Number(run.status || 0),
    timed_out: timedOut,
    duration_ms: durationMs,
    stdout_tail: String(run.stdout || '').trim().split('\n').slice(-8).join('\n'),
    stderr_tail: String(run.stderr || '').trim().split('\n').slice(-8).join('\n')
  };
}

function writePostmortem(policy: AnyObj, payload: AnyObj) {
  ensureDir(policy.outputs.postmortem_dir);
  const drillId = String(payload.drill_id || id16(payload.ts || nowIso()));
  const mdPath = path.join(policy.outputs.postmortem_dir, `${drillId}.md`);
  const lines = [
    `# Composite Disaster Gameday ${drillId}`,
    '',
    `- ts: ${payload.ts}`,
    `- ok: ${payload.ok === true ? 'true' : 'false'}`,
    `- total_duration_ms: ${Number(payload.total_duration_ms || 0)}`,
    `- max_total_duration_ms: ${Number(payload.max_total_duration_ms || 0)}`,
    `- sla_ok: ${payload.sla_ok === true ? 'true' : 'false'}`,
    `- policy_path: ${cleanText(payload.policy_path || '', 240) || 'unknown'}`,
    '',
    '## Scenarios',
    '',
    '| id | stage | required | ok | status | duration_ms |',
    '|---|---|---|---|---|---|'
  ];
  const rows = Array.isArray(payload.scenarios) ? payload.scenarios : [];
  for (const row of rows) {
    lines.push(`| ${cleanText(row.scenario_id || '', 80)} | ${cleanText(row.stage || '', 40)} | ${row.required === true ? 'true' : 'false'} | ${row.ok === true ? 'true' : 'false'} | ${Number(row.status || 0)} | ${Number(row.duration_ms || 0)} |`);
  }
  lines.push('', '## Reasons', '');
  const reasons = Array.isArray(payload.reasons) ? payload.reasons : [];
  if (!reasons.length) lines.push('- none');
  else reasons.forEach((r) => lines.push(`- ${cleanText(r, 240)}`));
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
  return mdPath;
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    const out = {
      ok: false,
      type: 'composite_disaster_gameday',
      ts: nowIso(),
      error: 'policy_disabled',
      policy_path: rel(policy.policy_path)
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, policy.strict_default);
  const started = Date.now();
  const scenarioResults = policy.scenarios.map((row: AnyObj) => execScenario(row));
  const totalDuration = Date.now() - started;

  const reasons: string[] = [];
  for (const row of scenarioResults) {
    if (row.required === true && row.ok !== true) {
      reasons.push(`required_scenario_failed:${row.scenario_id}`);
    }
  }
  const slaOk = totalDuration <= Number(policy.max_total_duration_ms || 0);
  if (!slaOk) reasons.push('max_total_duration_exceeded');

  const out = {
    ok: reasons.length === 0,
    type: 'composite_disaster_gameday',
    ts: nowIso(),
    drill_id: `cdg_${id16(`${nowIso()}|${scenarioResults.length}|${totalDuration}`)}`,
    strict,
    policy_path: rel(policy.policy_path),
    total_duration_ms: totalDuration,
    max_total_duration_ms: Number(policy.max_total_duration_ms || 0),
    sla_ok: slaOk,
    scenarios: scenarioResults,
    reasons
  };

  let postmortemPath = '';
  if (policy.require_postmortem !== false) {
    postmortemPath = writePostmortem(policy, out);
    (out as AnyObj).postmortem_path = rel(postmortemPath);
  }

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.outputs.latest_path, null);
  const latestTs = latest && latest.ts ? parseIsoMs(latest.ts) : null;
  const nextDueMs = latestTs == null
    ? null
    : latestTs + (Number(policy.cadence_hours || 0) * 60 * 60 * 1000);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'composite_disaster_gameday_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    cadence_hours: Number(policy.cadence_hours || 0),
    latest,
    latest_path: rel(policy.outputs.latest_path),
    history_path: rel(policy.outputs.history_path),
    postmortem_dir: rel(policy.outputs.postmortem_dir),
    next_due_at: nextDueMs == null ? null : new Date(nextDueMs).toISOString()
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 80);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy
};
