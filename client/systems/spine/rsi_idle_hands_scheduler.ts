#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-183
 * Always-on idle RSI scheduler with freshness and budget gates.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.RSI_IDLE_HANDS_SCHEDULER_POLICY_PATH
  ? path.resolve(process.env.RSI_IDLE_HANDS_SCHEDULER_POLICY_PATH)
  : path.join(ROOT, 'config', 'rsi_idle_hands_scheduler_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/spine/rsi_idle_hands_scheduler.js configure --owner=<owner_id>');
  console.log('  node systems/spine/rsi_idle_hands_scheduler.js run --owner=<owner_id> [--mock=1] [--strict=1] [--apply=0|1] [--force=1]');
  console.log('  node systems/spine/rsi_idle_hands_scheduler.js status [--owner=<owner_id>]');
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runNode(scriptPath, args, timeoutMs, mock, label) {
  if (mock) {
    return {
      ok: true,
      status: 0,
      payload: { ok: true, type: `${normalizeToken(label || 'mock', 80) || 'mock'}_mock` },
      stderr: ''
    };
  }
  const run = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  return {
    ok: Number(run.status || 0) === 0,
    status: Number.isFinite(run.status) ? Number(run.status) : 1,
    payload: parseJson(run.stdout || ''),
    stderr: cleanText(run.stderr || '', 400)
  };
}

function resolveMaybe(rawPath, fallbackRel) {
  const txt = cleanText(rawPath || '', 420);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}

function rel(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readState(policy) {
  return readJson(policy.paths.scheduler_state_path, {
    schema_id: 'rsi_idle_hands_scheduler_state',
    schema_version: '1.0',
    runs: 0,
    updated_at: null,
    last_run_at: null,
    last_ok: null,
    suppressed_quiet_hours: 0
  });
}

function writeState(policy, state) {
  ensureDir(policy.paths.scheduler_state_path);
  writeJsonAtomic(policy.paths.scheduler_state_path, {
    schema_id: 'rsi_idle_hands_scheduler_state',
    schema_version: '1.0',
    runs: Number(state.runs || 0),
    updated_at: state.updated_at || nowIso(),
    last_run_at: state.last_run_at || null,
    last_ok: state.last_ok === true,
    suppressed_quiet_hours: Number(state.suppressed_quiet_hours || 0),
    last_result: state.last_result || null
  });
}

function minutesSince(ts) {
  const t = Date.parse(String(ts || ''));
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

function inQuietHours(policy) {
  const start = clampInt(policy.quiet_hours_start, 0, 23, 23);
  const end = clampInt(policy.quiet_hours_end, 0, 23, 8);
  const hour = new Date().getHours();
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

runStandardLane({
  lane_id: 'V3-RACE-183',
  script_rel: 'systems/spine/rsi_idle_hands_scheduler.js',
  policy_path: POLICY_PATH,
  stream: 'spine.rsi_idle_hands_scheduler',
  paths: {
    memory_dir: 'memory/spine/rsi_idle_hands_scheduler',
    adaptive_index_path: 'adaptive/spine/rsi_idle_hands_scheduler/index.json',
    events_path: 'state/spine/rsi_idle_hands_scheduler/events.jsonl',
    latest_path: 'state/spine/rsi_idle_hands_scheduler/latest.json',
    receipts_path: 'state/spine/rsi_idle_hands_scheduler/receipts.jsonl',
    scheduler_state_path: 'state/spine/rsi_idle_hands_scheduler/state.json'
  },
  usage,
  handlers: {
    run(policy, args, ctx) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };

      const strict = toBool(args.strict, true);
      const apply = toBool(args.apply, false);
      const mock = toBool(args.mock, false);
      const force = toBool(args.force, false);
      const intervalMinutes = clampInt(args['interval-minutes'] || args.interval_minutes, 1, 24 * 60, clampInt(policy.min_interval_minutes, 1, 24 * 60, 15));

      const state = readState(policy);
      const sinceLast = minutesSince(state.last_run_at);
      const quiet = inQuietHours(policy);
      const throttled = sinceLast < intervalMinutes;

      const rsiScript = resolveMaybe(policy.rsi_script, 'adaptive/rsi/rsi_bootstrap.js');
      const rsiPolicy = resolveMaybe(policy.rsi_policy_path, 'config/rsi_bootstrap_policy.json');
      const handsScript = resolveMaybe(policy.background_hands_script, 'systems/spine/background_hands_scheduler.js');
      const freshnessScript = resolveMaybe(policy.freshness_script, 'systems/research/world_model_freshness_loop.js');
      const budgetScript = resolveMaybe(policy.budget_gate_script, 'systems/ops/complexity_budget_gate.js');

      const freshnessRun = runNode(freshnessScript, ['check', `--owner=${ownerId}`], 120000, mock, 'world_model_freshness_check');
      const budgetRun = runNode(budgetScript, ['check', `--owner=${ownerId}`], 120000, mock, 'complexity_budget_check');

      let schedulerRun = { ok: false, status: 1, payload: null };
      let rsiRun = { ok: false, status: 1, payload: null };
      const suppressed = (!force && (quiet || throttled));
      if (!suppressed) {
        schedulerRun = runNode(handsScript, ['schedule', `--owner=${ownerId}`, '--task=rsi_idle_hands', '--risk-tier=2'], 120000, mock, 'background_hands_schedule');
        const rsiArgs = ['hands-loop', `--owner=${ownerId}`, '--iterations=1', '--interval-sec=0', `--policy=${rsiPolicy}`];
        if (mock) rsiArgs.push('--mock=1');
        rsiRun = runNode(rsiScript, rsiArgs, 240000, false, 'rsi_hands_loop');
      }

      const gateOk = freshnessRun.ok && budgetRun.ok;
      const runOk = gateOk && (suppressed || (schedulerRun.ok && rsiRun.ok));

      if (apply) {
        writeState(policy, {
          runs: Number(state.runs || 0) + (suppressed ? 0 : 1),
          updated_at: nowIso(),
          last_run_at: suppressed ? state.last_run_at : nowIso(),
          last_ok: runOk,
          suppressed_quiet_hours: Number(state.suppressed_quiet_hours || 0) + (suppressed && quiet ? 1 : 0),
          last_result: {
            owner_id: ownerId,
            ts: nowIso(),
            suppressed,
            quiet,
            throttled,
            gate_ok: gateOk,
            run_ok: runOk
          }
        });
      }

      const receipt = ctx.cmdRecord(policy, {
        ...args,
        event: 'rsi_idle_hands_scheduler_run',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          strict,
          suppressed,
          quiet_hours: quiet,
          throttled,
          min_interval_minutes: intervalMinutes,
          minutes_since_last_run: Number.isFinite(sinceLast) ? sinceLast : null,
          gate_ok: gateOk,
          freshness_ok: freshnessRun.ok,
          budget_ok: budgetRun.ok,
          scheduler_ok: schedulerRun.ok,
          rsi_ok: rsiRun.ok,
          scripts: {
            freshness: rel(freshnessScript),
            budget: rel(budgetScript),
            hands: rel(handsScript),
            rsi: rel(rsiScript)
          }
        })
      });

      if (strict && !runOk) {
        return {
          ...receipt,
          ok: false,
          error: 'rsi_idle_hands_scheduler_failed',
          suppressed,
          gate_ok: gateOk
        };
      }

      return {
        ...receipt,
        rsi_idle_scheduler_ok: runOk,
        suppressed,
        gate_ok: gateOk
      };
    },

    status(policy, args, ctx) {
      const base = ctx.cmdStatus(policy, args);
      const state = readState(policy);
      return {
        ...base,
        scheduler_state: state,
        artifacts: {
          ...base.artifacts,
          scheduler_state_path: rel(policy.paths.scheduler_state_path)
        }
      };
    }
  }
});
