#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-175
 * protheus-core runtime envelope gate (<5MB, <200ms) with optional-flag matrix.
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
  clampNumber,
  readJson,
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.PROTHEUS_CORE_RUNTIME_ENVELOPE_POLICY_PATH
  ? path.resolve(process.env.PROTHEUS_CORE_RUNTIME_ENVELOPE_POLICY_PATH)
  : path.join(ROOT, 'config', 'protheus_core_runtime_envelope_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/protheus_core_runtime_envelope.js configure --owner=<owner_id>');
  console.log('  node systems/ops/protheus_core_runtime_envelope.js run --owner=<owner_id> [--strict=1] [--apply=1]');
  console.log('  node systems/ops/protheus_core_runtime_envelope.js status [--owner=<owner_id>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseJson(stdout: string) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function readMatrix(policy: any) {
  const matrix = policy.envelope && Array.isArray(policy.envelope.flag_matrix)
    ? policy.envelope.flag_matrix
    : [];
  const rows = matrix
    .map((row: any) => ({
      id: normalizeToken(row && row.id, 80),
      spine: row && row.spine === true,
      reflex: row && row.reflex === true,
      gates: row && row.gates === true
    }))
    .filter((row: any) => row.id);
  if (rows.length > 0) return rows;
  return [
    { id: 'minimal', spine: false, reflex: false, gates: false },
    { id: 'spine_only', spine: true, reflex: false, gates: false },
    { id: 'spine_reflex', spine: true, reflex: true, gates: false },
    { id: 'full', spine: true, reflex: true, gates: true }
  ];
}

function runContractCheck(maxMb: number, maxMs: number, row: any) {
  const starter = path.join(ROOT, 'packages', 'protheus-core', 'starter.js');
  const args = [
    starter,
    '--mode=contract',
    `--max-mb=${maxMb}`,
    `--max-ms=${maxMs}`,
    `--spine=${row.spine ? '1' : '0'}`,
    `--reflex=${row.reflex ? '1' : '0'}`,
    `--gates=${row.gates ? '1' : '0'}`
  ];
  const run = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
  const payload = parseJson(String(run.stdout || ''));
  return {
    id: row.id,
    flags: {
      spine: row.spine,
      reflex: row.reflex,
      gates: row.gates
    },
    ok: Number(run.status || 0) === 0 && payload && payload.ok === true,
    status: Number.isFinite(run.status) ? Number(run.status) : 1,
    payload,
    stderr: cleanText(run.stderr || '', 400)
  };
}

function readTrend(policy: any) {
  return readJson(policy.paths.trend_path, {
    schema_id: 'protheus_core_runtime_envelope_trend',
    schema_version: '1.0',
    runs: []
  });
}

function writeTrend(policy: any, trend: any) {
  ensureDir(policy.paths.trend_path);
  writeJsonAtomic(policy.paths.trend_path, trend);
}

runStandardLane({
  lane_id: 'V3-RACE-175',
  script_rel: 'systems/ops/protheus_core_runtime_envelope.js',
  policy_path: POLICY_PATH,
  stream: 'ops.protheus_core_envelope',
  paths: {
    memory_dir: 'memory/ops/protheus_core_runtime_envelope',
    adaptive_index_path: 'adaptive/ops/protheus_core_runtime_envelope/index.json',
    events_path: 'state/ops/protheus_core_runtime_envelope/events.jsonl',
    latest_path: 'state/ops/protheus_core_runtime_envelope/latest.json',
    receipts_path: 'state/ops/protheus_core_runtime_envelope/receipts.jsonl',
    trend_path: 'state/ops/protheus_core_runtime_envelope/trend.json'
  },
  usage,
  handlers: {
    run(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };

      const strict = toBool(args.strict, true);
      const apply = toBool(args.apply, true);
      const envelope = policy.envelope && typeof policy.envelope === 'object' ? policy.envelope : {};
      const maxMb = clampNumber(envelope.max_mb, 0.001, 500, 5);
      const maxMs = clampNumber(envelope.max_ms, 1, 120000, 200);
      const matrix = readMatrix(policy);
      const requiredProfiles = Array.isArray(envelope.required_profiles)
        ? envelope.required_profiles.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : matrix.map((row: any) => row.id);

      const checks = matrix.map((row: any) => runContractCheck(maxMb, maxMs, row));
      const byId = Object.fromEntries(checks.map((row: any) => [row.id, row]));
      const requiredFail = requiredProfiles
        .filter((id: string) => !byId[id] || byId[id].ok !== true);
      const allOk = requiredFail.length === 0;

      const trend = readTrend(policy);
      const runs = Array.isArray(trend.runs) ? trend.runs : [];
      runs.push({
        ts: nowIso(),
        owner_id: ownerId,
        max_mb: maxMb,
        max_ms: maxMs,
        required_profiles: requiredProfiles,
        checks: checks.map((row: any) => ({ id: row.id, ok: row.ok, status: row.status }))
      });
      while (runs.length > 400) runs.shift();
      if (apply) {
        trend.runs = runs;
        writeTrend(policy, trend);
      }

      const receipt = ctx.cmdRecord(policy, {
        ...args,
        event: 'protheus_core_runtime_envelope_run',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          strict,
          max_mb: maxMb,
          max_ms: maxMs,
          required_profiles: requiredProfiles,
          failed_required_profiles: requiredFail,
          checks: checks.map((row: any) => ({
            id: row.id,
            ok: row.ok,
            flags: row.flags,
            package_size_mb: row.payload && Number(row.payload.package_size_mb || 0),
            cold_start_ms: row.payload && Number(row.payload.cold_start_ms || 0)
          })),
          trend_path: rel(policy.paths.trend_path)
        })
      });

      if (strict && !allOk) {
        return {
          ...receipt,
          ok: false,
          error: 'runtime_envelope_failed',
          failed_required_profiles: requiredFail,
          checks: checks.map((row: any) => ({ id: row.id, ok: row.ok, status: row.status }))
        };
      }

      return {
        ...receipt,
        runtime_envelope_ok: allOk,
        failed_required_profiles: requiredFail,
        checks: checks.map((row: any) => ({ id: row.id, ok: row.ok, status: row.status }))
      };
    },

    status(policy: any, args: any, ctx: any) {
      const base = ctx.cmdStatus(policy, args);
      const trend = readTrend(policy);
      return {
        ...base,
        trend_runs: Array.isArray(trend.runs) ? trend.runs.length : 0,
        latest_run: Array.isArray(trend.runs) && trend.runs.length > 0 ? trend.runs[trend.runs.length - 1] : null,
        artifacts: {
          ...base.artifacts,
          trend_path: rel(policy.paths.trend_path)
        }
      };
    }
  }
});
