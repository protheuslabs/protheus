#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');
const { loadPolicyRuntime } = require('../../lib/policy_runtime');
const { writeArtifactSet, appendArtifactHistory } = require('../../lib/state_artifact_contract');

const POLICY_PATH = process.env.MEMORY_INDEX_FRESHNESS_POLICY_PATH
  ? path.resolve(process.env.MEMORY_INDEX_FRESHNESS_POLICY_PATH)
  : path.join(ROOT, 'config', 'memory_index_freshness_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/memory_index_freshness_gate.js run [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/memory/memory_index_freshness_gate.js status [--policy=<path>]');
}

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v == null ? '' : v));
  return Number.isFinite(ms) ? ms : 0;
}

function statFile(absPath: string) {
  if (!fs.existsSync(absPath)) return null;
  try {
    const st = fs.statSync(absPath);
    return {
      mtime_ms: Number(st.mtimeMs || 0),
      size: Number(st.size || 0)
    };
  } catch {
    return null;
  }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    auto_rebuild_on_violation: true,
    thresholds: {
      max_index_age_hours: 24 * 7,
      max_daily_files_since_rebuild: 5
    },
    paths: {
      memory_dir: 'memory',
      memory_index_path: 'memory/MEMORY_INDEX.md',
      tags_index_path: 'memory/TAGS_INDEX.md',
      rebuild_script: 'memory/tools/rebuild_exclusive.js',
      latest_path: 'state/memory/index_freshness/latest.json',
      receipts_path: 'state/memory/index_freshness/receipts.jsonl',
      rebuild_history_path: 'state/memory/index_freshness/rebuild_history.jsonl',
      last_rebuild_state_path: 'state/memory/index_freshness/last_rebuild.json'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const base = defaultPolicy();
  const loaded = loadPolicyRuntime({
    policyPath,
    defaults: base
  });
  const raw = loaded.raw;
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    auto_rebuild_on_violation: toBool(raw.auto_rebuild_on_violation, base.auto_rebuild_on_violation),
    thresholds: {
      max_index_age_hours: clampInt(
        thresholds.max_index_age_hours,
        1,
        24 * 365,
        base.thresholds.max_index_age_hours
      ),
      max_daily_files_since_rebuild: clampInt(
        thresholds.max_daily_files_since_rebuild,
        1,
        100000,
        base.thresholds.max_daily_files_since_rebuild
      )
    },
    paths: {
      memory_dir: resolvePath(paths.memory_dir || base.paths.memory_dir, base.paths.memory_dir),
      memory_index_path: resolvePath(paths.memory_index_path || base.paths.memory_index_path, base.paths.memory_index_path),
      tags_index_path: resolvePath(paths.tags_index_path || base.paths.tags_index_path, base.paths.tags_index_path),
      rebuild_script: resolvePath(paths.rebuild_script || base.paths.rebuild_script, base.paths.rebuild_script),
      latest_path: resolvePath(paths.latest_path || base.paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path || base.paths.receipts_path, base.paths.receipts_path),
      rebuild_history_path: resolvePath(paths.rebuild_history_path || base.paths.rebuild_history_path, base.paths.rebuild_history_path),
      last_rebuild_state_path: resolvePath(paths.last_rebuild_state_path || base.paths.last_rebuild_state_path, base.paths.last_rebuild_state_path)
    }
  };
}

function listDailyFiles(memoryDir: string) {
  if (!fs.existsSync(memoryDir)) return [];
  try {
    return fs.readdirSync(memoryDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(String(name || '')))
      .map((name) => path.join(memoryDir, name))
      .sort();
  } catch {
    return [];
  }
}

function loadLastRebuildState(policy: any) {
  const src = readJson(policy.paths.last_rebuild_state_path, {});
  return {
    last_rebuild_ts: cleanText(src.last_rebuild_ts || '', 40) || null,
    last_rebuild_daily_file_count: clampInt(src.last_rebuild_daily_file_count, 0, 1000000, 0),
    last_rebuild_reason: cleanText(src.last_rebuild_reason || '', 120) || null
  };
}

function saveLastRebuildState(policy: any, payload: any) {
  writeJsonAtomic(policy.paths.last_rebuild_state_path, {
    schema_version: '1.0',
    last_rebuild_ts: cleanText(payload.last_rebuild_ts || nowIso(), 40) || nowIso(),
    last_rebuild_daily_file_count: clampInt(payload.last_rebuild_daily_file_count, 0, 1000000, 0),
    last_rebuild_reason: cleanText(payload.last_rebuild_reason || '', 120) || null
  });
}

function evaluateFreshness(policy: any) {
  const nowMs = parseIsoMs(nowIso());
  const memoryIndexStat = statFile(policy.paths.memory_index_path);
  const tagsIndexStat = statFile(policy.paths.tags_index_path);
  const indexMtimeMs = memoryIndexStat && tagsIndexStat
    ? Math.min(memoryIndexStat.mtime_ms, tagsIndexStat.mtime_ms)
    : 0;
  const indexAgeHours = indexMtimeMs > 0
    ? Number(((Math.max(0, nowMs - indexMtimeMs)) / (60 * 60 * 1000)).toFixed(6))
    : null;

  const dailyFiles = listDailyFiles(policy.paths.memory_dir);
  const newerThanIndex = indexMtimeMs > 0
    ? dailyFiles.filter((absPath) => {
      const stat = statFile(absPath);
      return !!stat && Number(stat.mtime_ms || 0) > indexMtimeMs;
    })
    : dailyFiles.slice(0);
  const lastRebuild = loadLastRebuildState(policy);
  const lastCount = clampInt(lastRebuild.last_rebuild_daily_file_count, 0, 1000000, 0);
  const deltaSinceLast = Math.max(0, dailyFiles.length - lastCount);
  const hasRebuildAnchor = !!(lastRebuild.last_rebuild_ts && parseIsoMs(lastRebuild.last_rebuild_ts) > 0);

  const staleReasons: string[] = [];
  if (!memoryIndexStat) staleReasons.push('memory_index_missing');
  if (!tagsIndexStat) staleReasons.push('tags_index_missing');
  if (indexAgeHours != null && indexAgeHours > Number(policy.thresholds.max_index_age_hours || 0)) {
    staleReasons.push('index_age_exceeded');
  }
  if (newerThanIndex.length >= Number(policy.thresholds.max_daily_files_since_rebuild || 0)) {
    staleReasons.push('daily_file_threshold_exceeded');
  }
  if (hasRebuildAnchor && deltaSinceLast >= Number(policy.thresholds.max_daily_files_since_rebuild || 0)) {
    staleReasons.push('daily_delta_since_last_rebuild_exceeded');
  }

  return {
    now_ms: nowMs,
    stale: staleReasons.length > 0,
    stale_reasons: staleReasons,
    memory_index_exists: !!memoryIndexStat,
    tags_index_exists: !!tagsIndexStat,
    index_age_hours: indexAgeHours,
    newer_daily_files_count: newerThanIndex.length,
    daily_files_count: dailyFiles.length,
    daily_delta_since_last_rebuild: deltaSinceLast,
    has_rebuild_anchor: hasRebuildAnchor,
    last_rebuild: lastRebuild
  };
}

function runRebuild(policy: any) {
  if (!fs.existsSync(policy.paths.rebuild_script)) {
    return { ok: false, status: 1, error: 'rebuild_script_missing' };
  }
  const proc = spawnSync('node', [policy.paths.rebuild_script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
  return {
    ok: Number(proc.status || 0) === 0,
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: cleanText(proc.stdout || '', 400),
    stderr: cleanText(proc.stderr || '', 400),
    error: Number(proc.status || 0) === 0 ? null : cleanText(proc.stderr || proc.stdout || 'rebuild_failed', 180)
  };
}

function runGate(args: any, policy: any) {
  const apply = toBool(args.apply, false);
  const strict = toBool(args.strict, false);
  const before = evaluateFreshness(policy);
  let rebuild = null;
  let after = before;

  if (before.stale === true && apply && policy.shadow_only !== true && policy.auto_rebuild_on_violation === true) {
    rebuild = runRebuild(policy);
    if (rebuild.ok === true) {
      saveLastRebuildState(policy, {
        last_rebuild_ts: nowIso(),
        last_rebuild_daily_file_count: before.daily_files_count,
        last_rebuild_reason: before.stale_reasons.join(',')
      });
    }
    after = evaluateFreshness(policy);
    appendArtifactHistory(
      policy.paths.rebuild_history_path,
      {
        ts: nowIso(),
        type: 'memory_index_freshness_rebuild',
        ok: rebuild.ok === true,
        status: rebuild.status,
        stale_reasons: before.stale_reasons,
        after_stale: after.stale === true,
        error: rebuild.error || null
      },
      {
        schemaId: 'memory_index_freshness_rebuild_history',
        schemaVersion: '1.0',
        artifactType: 'history'
      }
    );
  }

  const out = {
    ts: nowIso(),
    type: 'memory_index_freshness_gate',
    ok: after.stale !== true,
    strict,
    apply,
    shadow_only: policy.shadow_only,
    auto_rebuild_on_violation: policy.auto_rebuild_on_violation,
    thresholds: policy.thresholds,
    before,
    after,
    rebuild
  };

  writeArtifactSet(
    {
      latestPath: policy.paths.latest_path,
      receiptsPath: policy.paths.receipts_path
    },
    out,
    {
      schemaId: 'memory_index_freshness_receipt',
      schemaVersion: '1.0',
      artifactType: 'receipt'
    }
  );
  if (strict && out.ok !== true) emit(out, 1);
  return out;
}

function status(policy: any) {
  return {
    ok: true,
    type: 'memory_index_freshness_status',
    policy: {
      version: policy.version,
      shadow_only: policy.shadow_only,
      auto_rebuild_on_violation: policy.auto_rebuild_on_violation,
      thresholds: policy.thresholds
    },
    latest: readJson(policy.paths.latest_path, null),
    last_rebuild: loadLastRebuildState(policy)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (!policy.enabled) emit({ ok: false, error: 'memory_index_freshness_disabled' }, 1);

  if (cmd === 'run') emit(runGate(args, policy));
  if (cmd === 'status') emit(status(policy));

  usage();
  process.exit(1);
}

main();
