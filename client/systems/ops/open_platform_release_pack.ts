#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-016
 *
 * Open Platform Layer Release Pack:
 * - Apache-2.0 allowlisted module manifest
 * - signed compatibility badges for reference integrations
 * - metrics-first launch artifact (benchmark + drift + autonomy receipt summary)
 * - reproducible release checklist evidence
 */

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
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.OPEN_PLATFORM_RELEASE_PACK_POLICY_PATH
  ? path.resolve(process.env.OPEN_PLATFORM_RELEASE_PACK_POLICY_PATH)
  : path.join(ROOT, 'config', 'open_platform_release_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/open_platform_release_pack.js build [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/open_platform_release_pack.js verify [--policy=<path>]');
  console.log('  node systems/ops/open_platform_release_pack.js status [--policy=<path>]');
}

function parseJsonFromStdout(stdout: string) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((row) => row.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function normalizeList(v: unknown) {
  if (Array.isArray(v)) {
    return v.map((row) => cleanText(row, 320)).filter(Boolean);
  }
  const raw = cleanText(v || '', 4000);
  if (!raw) return [];
  return raw.split(',').map((row) => cleanText(row, 320)).filter(Boolean);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    license: 'Apache-2.0',
    allowlisted_modules: [
      'systems/ops/compatibility_conformance_program.ts',
      'systems/ops/event_sourced_control_plane.ts',
      'systems/ops/openfang_capability_pack.ts',
      'systems/observability/thought_action_trace_contract.ts'
    ],
    reference_integrations: ['langgraph', 'crewai', 'autogen'],
    release_checklist: [
      'allowlist_verified',
      'compatibility_badges_signed',
      'metrics_pack_compiled',
      'reproducibility_evidence_attached'
    ],
    scripts: {
      compatibility_script: 'systems/ops/compatibility_conformance_program.js',
      receipt_summary_script: 'systems/autonomy/receipt_summary.js',
      receipt_summary_days: 7
    },
    paths: {
      latest_path: 'state/ops/open_platform_release_pack/latest.json',
      receipts_path: 'state/ops/open_platform_release_pack/receipts.jsonl',
      state_path: 'state/ops/open_platform_release_pack/state.json',
      release_pack_path: 'state/ops/open_platform_release_pack/release_pack.json',
      checklist_path: 'state/ops/open_platform_release_pack/checklist_evidence.json',
      badges_dir: 'state/ops/open_platform_release_pack/badges',
      benchmark_latest_path: 'state/ops/public_benchmarks/latest.json',
      drift_latest_path: 'state/autonomy/simulations/latest.json',
      receipt_summary_latest_path: 'state/ops/open_platform_release_pack/receipt_summary_latest.json'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const scripts = raw.scripts && typeof raw.scripts === 'object' ? raw.scripts : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    license: cleanText(raw.license || base.license, 64) || base.license,
    allowlisted_modules: normalizeList(raw.allowlisted_modules || base.allowlisted_modules),
    reference_integrations: normalizeList(raw.reference_integrations || base.reference_integrations)
      .map((row) => normalizeToken(row, 80))
      .filter(Boolean),
    release_checklist: normalizeList(raw.release_checklist || base.release_checklist)
      .map((row) => normalizeToken(row, 120))
      .filter(Boolean),
    scripts: {
      compatibility_script: resolvePath(
        scripts.compatibility_script || base.scripts.compatibility_script,
        base.scripts.compatibility_script
      ),
      receipt_summary_script: resolvePath(
        scripts.receipt_summary_script || base.scripts.receipt_summary_script,
        base.scripts.receipt_summary_script
      ),
      receipt_summary_days: clampInt(
        scripts.receipt_summary_days,
        1,
        365,
        base.scripts.receipt_summary_days
      )
    },
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      release_pack_path: resolvePath(paths.release_pack_path, base.paths.release_pack_path),
      checklist_path: resolvePath(paths.checklist_path, base.paths.checklist_path),
      badges_dir: resolvePath(paths.badges_dir, base.paths.badges_dir),
      benchmark_latest_path: resolvePath(paths.benchmark_latest_path, base.paths.benchmark_latest_path),
      drift_latest_path: resolvePath(paths.drift_latest_path, base.paths.drift_latest_path),
      receipt_summary_latest_path: resolvePath(
        paths.receipt_summary_latest_path,
        base.paths.receipt_summary_latest_path
      )
    },
    policy_path: path.resolve(policyPath)
  };
}

function hashFile(absPath: string) {
  if (!fs.existsSync(absPath)) return null;
  const buf = fs.readFileSync(absPath);
  return stableHash(buf.toString('base64'), 40);
}

function collectAllowlist(policy: any) {
  const rows = [];
  for (const rawPath of policy.allowlisted_modules) {
    const abs = path.isAbsolute(rawPath) ? rawPath : path.join(ROOT, rawPath);
    const exists = fs.existsSync(abs);
    const insideRoot = abs === ROOT || abs.startsWith(`${ROOT}${path.sep}`);
    let sizeBytes = null;
    if (exists) {
      try {
        const st = fs.statSync(abs);
        sizeBytes = Number(st.size || 0);
      } catch {
        sizeBytes = null;
      }
    }
    rows.push({
      module_path: rel(abs),
      absolute_path: abs,
      exists,
      inside_repo_root: insideRoot,
      sha256_40: exists ? hashFile(abs) : null,
      size_bytes: sizeBytes
    });
  }
  return rows;
}

function runNodeJson(scriptPath: string, args: string[], timeoutMs = 30000) {
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, code: 127, payload: null, stderr: 'script_missing', stdout: '' };
  }
  const run = spawnSync('node', [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs)
  });
  return {
    ok: Number(run.status || 0) === 0,
    code: Number.isFinite(run.status) ? Number(run.status) : 1,
    payload: parseJsonFromStdout(run.stdout),
    stderr: cleanText(run.stderr || '', 800),
    stdout: cleanText(run.stdout || '', 800)
  };
}

function generateBadges(policy: any) {
  fs.mkdirSync(policy.paths.badges_dir, { recursive: true });
  const out = [];
  for (const integration of policy.reference_integrations) {
    const run = runNodeJson(
      policy.scripts.compatibility_script,
      ['run', `--integration=${integration}`],
      20000
    );
    const badge = run.payload && run.payload.badge && typeof run.payload.badge === 'object'
      ? run.payload.badge
      : null;
    const signed = !!(badge && badge.signature);
    const row = {
      integration,
      ok: run.ok && !!(run.payload && run.payload.ok === true),
      signed,
      badge: badge || null,
      code: run.code,
      stderr: run.stderr || null
    };
    const badgePath = path.join(policy.paths.badges_dir, `${integration}.json`);
    writeJsonAtomic(badgePath, row);
    out.push({
      ...row,
      badge_path: rel(badgePath)
    });
  }
  return out;
}

function loadBenchmark(policy: any) {
  const row = readJson(policy.paths.benchmark_latest_path, null);
  if (!row || typeof row !== 'object') return null;
  return {
    ts: row.ts || null,
    date: row.date || null,
    verdict: row.verdict || null,
    drift_rate: row.simulation ? Number(row.simulation.drift_rate || 0) : null,
    yield_rate: row.simulation ? Number(row.simulation.yield_rate || 0) : null,
    red_team_critical_fail_cases: row.red_team ? Number(row.red_team.critical_fail_cases || 0) : null
  };
}

function loadDriftSnapshot(policy: any, benchmark: any) {
  if (benchmark && Number.isFinite(Number(benchmark.drift_rate))) {
    return {
      source: rel(policy.paths.benchmark_latest_path),
      drift_rate: Number(benchmark.drift_rate),
      ts: benchmark.ts || null
    };
  }
  const row = readJson(policy.paths.drift_latest_path, null);
  if (!row || typeof row !== 'object') {
    return { source: rel(policy.paths.drift_latest_path), drift_rate: null, ts: null };
  }
  const checks = row.checks_effective && typeof row.checks_effective === 'object'
    ? row.checks_effective
    : (row.checks && typeof row.checks === 'object' ? row.checks : {});
  const driftValue = checks && checks.drift_rate && typeof checks.drift_rate === 'object'
    ? Number(checks.drift_rate.value || 0)
    : (Number.isFinite(Number(row.drift_rate)) ? Number(row.drift_rate) : null);
  return {
    source: rel(policy.paths.drift_latest_path),
    drift_rate: Number.isFinite(Number(driftValue)) ? Number(driftValue) : null,
    ts: row.ts || row.generated_at || null
  };
}

function loadReceiptSummary(policy: any) {
  const run = runNodeJson(
    policy.scripts.receipt_summary_script,
    ['run', `--days=${policy.scripts.receipt_summary_days}`],
    30000
  );
  const payload = run.payload && typeof run.payload === 'object' ? run.payload : null;
  if (payload) writeJsonAtomic(policy.paths.receipt_summary_latest_path, payload);
  return {
    ok: run.ok && !!(payload && payload.ok === true),
    payload,
    code: run.code,
    stderr: run.stderr || null,
    source_script: rel(policy.scripts.receipt_summary_script)
  };
}

function checklistRows(pack: any, policy: any) {
  const allowlistOk = Array.isArray(pack.allowlist)
    && pack.allowlist.length > 0
    && pack.allowlist.every((row: any) => row.exists === true && row.inside_repo_root === true);
  const badgesOk = Array.isArray(pack.compatibility_badges)
    && pack.compatibility_badges.length > 0
    && pack.compatibility_badges.every((row: any) => row.ok === true && row.signed === true);
  const metricsOk = !!(pack.metrics
    && pack.metrics.benchmark
    && Number.isFinite(Number(pack.metrics.drift && pack.metrics.drift.drift_rate))
    && pack.metrics.receipt_summary
    && pack.metrics.receipt_summary.ok === true);
  const reproducible = Array.isArray(pack.reproducibility && pack.reproducibility.commands)
    && pack.reproducibility.commands.length >= 3;

  const dictionary: Record<string, any> = {
    allowlist_verified: {
      check_id: 'allowlist_verified',
      passed: allowlistOk,
      evidence: {
        license: pack.license,
        module_count: Array.isArray(pack.allowlist) ? pack.allowlist.length : 0,
        missing_modules: (pack.allowlist || []).filter((row: any) => row.exists !== true).map((row: any) => row.module_path)
      }
    },
    compatibility_badges_signed: {
      check_id: 'compatibility_badges_signed',
      passed: badgesOk,
      evidence: {
        integrations: (pack.compatibility_badges || []).map((row: any) => ({
          integration: row.integration,
          ok: row.ok === true,
          signed: row.signed === true,
          badge_path: row.badge_path
        }))
      }
    },
    metrics_pack_compiled: {
      check_id: 'metrics_pack_compiled',
      passed: metricsOk,
      evidence: {
        benchmark_source: rel(policy.paths.benchmark_latest_path),
        drift_source: pack.metrics && pack.metrics.drift ? pack.metrics.drift.source : null,
        receipt_summary_source: rel(policy.paths.receipt_summary_latest_path)
      }
    },
    reproducibility_evidence_attached: {
      check_id: 'reproducibility_evidence_attached',
      passed: reproducible,
      evidence: {
        command_count: Array.isArray(pack.reproducibility && pack.reproducibility.commands)
          ? pack.reproducibility.commands.length
          : 0
      }
    }
  };

  const checks = [];
  for (const key of policy.release_checklist) {
    if (dictionary[key]) checks.push(dictionary[key]);
  }
  return checks;
}

function cmdBuild(args: any) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (!policy.enabled) emit({ ok: false, error: 'open_platform_release_pack_disabled' }, 1);

  const strict = toBool(args.strict, true);
  const allowlist = collectAllowlist(policy);
  const badges = generateBadges(policy);
  const benchmark = loadBenchmark(policy);
  const drift = loadDriftSnapshot(policy, benchmark);
  const receiptSummary = loadReceiptSummary(policy);

  const pack = {
    schema_id: 'open_platform_release_pack',
    schema_version: '1.0',
    ts: nowIso(),
    policy_version: policy.version,
    shadow_only: policy.shadow_only,
    license: policy.license,
    allowlist,
    compatibility_badges: badges,
    metrics: {
      benchmark,
      drift,
      receipt_summary: receiptSummary
    },
    reproducibility: {
      generated_by: 'systems/ops/open_platform_release_pack.js',
      policy_path: rel(policy.policy_path),
      commands: [
        `node ${rel(policy.scripts.compatibility_script)} run --integration=<id>`,
        `node ${rel(policy.scripts.receipt_summary_script)} run --days=${policy.scripts.receipt_summary_days}`,
        `node systems/ops/open_platform_release_pack.js build --policy=${rel(policy.policy_path)}`
      ]
    }
  } as any;

  pack.release_pack_signature = stableHash(JSON.stringify({
    license: pack.license,
    allowlist: pack.allowlist.map((row: any) => [row.module_path, row.sha256_40]),
    badges: pack.compatibility_badges.map((row: any) => [row.integration, row.badge && row.badge.signature]),
    metrics: {
      benchmark_date: pack.metrics.benchmark ? pack.metrics.benchmark.date : null,
      drift_rate: pack.metrics.drift ? pack.metrics.drift.drift_rate : null
    }
  }), 32);

  const checks = checklistRows(pack, policy);
  const allPassed = checks.length > 0 && checks.every((row: any) => row.passed === true);
  const checklist = {
    schema_id: 'open_platform_release_checklist',
    schema_version: '1.0',
    ts: nowIso(),
    release_pack_signature: pack.release_pack_signature,
    checks,
    all_passed: allPassed
  };

  writeJsonAtomic(policy.paths.release_pack_path, pack);
  writeJsonAtomic(policy.paths.checklist_path, checklist);

  const latest = {
    ok: allPassed,
    type: 'open_platform_release_pack_build',
    ts: nowIso(),
    strict,
    shadow_only: policy.shadow_only,
    license: policy.license,
    checklist_passed: allPassed,
    checks_total: checks.length,
    checks_passed: checks.filter((row: any) => row.passed === true).length,
    release_pack_path: rel(policy.paths.release_pack_path),
    checklist_path: rel(policy.paths.checklist_path),
    badges_dir: rel(policy.paths.badges_dir),
    release_pack_signature: pack.release_pack_signature
  };
  writeJsonAtomic(policy.paths.latest_path, latest);
  appendJsonl(policy.paths.receipts_path, latest);
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'open_platform_release_pack_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    last_build: latest
  });

  if (strict && allPassed !== true) emit(latest, 1);
  emit(latest);
}

function cmdVerify(args: any) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const checklist = readJson(policy.paths.checklist_path, null);
  if (!checklist || typeof checklist !== 'object') {
    emit({ ok: false, type: 'open_platform_release_pack_verify', error: 'checklist_missing' }, 1);
  }
  emit({
    ok: checklist.all_passed === true,
    type: 'open_platform_release_pack_verify',
    ts: nowIso(),
    checklist_path: rel(policy.paths.checklist_path),
    release_pack_path: rel(policy.paths.release_pack_path),
    checks: checklist.checks || [],
    all_passed: checklist.all_passed === true
  });
}

function cmdStatus(args: any) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  emit({
    ok: true,
    type: 'open_platform_release_pack_status',
    latest: readJson(policy.paths.latest_path, null),
    checklist: readJson(policy.paths.checklist_path, null),
    release_pack: readJson(policy.paths.release_pack_path, null),
    paths: {
      latest_path: rel(policy.paths.latest_path),
      receipts_path: rel(policy.paths.receipts_path),
      release_pack_path: rel(policy.paths.release_pack_path),
      checklist_path: rel(policy.paths.checklist_path),
      badges_dir: rel(policy.paths.badges_dir)
    }
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'build') return cmdBuild(args);
  if (cmd === 'verify') return cmdVerify(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(1);
}

main();
