#!/usr/bin/env node
'use strict';
export {};

/**
 * V5-RUST-HYB-001..010
 * Targeted Hybrid Rust migration execution runtime.
 *
 * This lane executes concrete Rust commands from systems/hybrid/rust
 * and records deterministic receipts/artifacts per backlog item.
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
  clampNumber,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

type LaneCtx = {
  id: string,
  item: AnyObj,
  policy: AnyObj,
  apply: boolean,
  strict: boolean,
  artifactDir: string,
};

const DEFAULT_POLICY_PATH = process.env.RUST_HYBRID_MIGRATION_PROGRAM_POLICY_PATH
  ? path.resolve(process.env.RUST_HYBRID_MIGRATION_PROGRAM_POLICY_PATH)
  : path.join(ROOT, 'config', 'rust_hybrid_migration_program_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/rust_hybrid_migration_program.js list [--policy=<path>]');
  console.log('  node systems/ops/rust_hybrid_migration_program.js run --id=<V5-RUST-HYB-XXX> [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust_hybrid_migration_program.js run-all [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust_hybrid_migration_program.js status [--id=<ID>] [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function normalizeId(v: unknown) {
  const id = cleanText(v || '', 120).replace(/`/g, '').toUpperCase();
  return /^V5-RUST-HYB-\d{3}$/.test(id) ? id : '';
}

function parseJson(text: string) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runRustCommand(args: string[], timeoutMs = 180000) {
  const cmd = ['cargo', 'run', '--quiet', '--manifest-path', 'systems/hybrid/rust/Cargo.toml', '--', ...args];
  const started = Date.now();
  const out = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs)
  });
  return {
    ok: Number(out.status || 0) === 0,
    status: Number.isFinite(Number(out.status)) ? Number(out.status) : 1,
    duration_ms: Math.max(0, Date.now() - started),
    stderr: cleanText(out.stderr || '', 500),
    payload: parseJson(String(out.stdout || '')),
    command: cmd
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    docs_required: [
      'docs/RUST_HYBRID_MIGRATION_IMPLEMENTATION.md'
    ],
    targets: {
      rust_share_min_pct: 15,
      rust_share_max_pct: 25,
      chaos_cycles: 200000
    },
    items: [
      { id: 'V5-RUST-HYB-001', title: '15-25% Rust Share Control Plan' },
      { id: 'V5-RUST-HYB-002', title: 'Memory Lane Rust Completion (Scheduler + Compression + SQLite Hot Paths)' },
      { id: 'V5-RUST-HYB-003', title: 'Execution Runtime Rust Cutover (Deterministic Receipts + Replay Core)' },
      { id: 'V5-RUST-HYB-004', title: 'Security + Vault Rust Core Hardening' },
      { id: 'V5-RUST-HYB-005', title: 'Pinnacle CRDT Rust Merge Engine' },
      { id: 'V5-RUST-HYB-006', title: 'Econ + Crypto Rust Safety Core' },
      { id: 'V5-RUST-HYB-007', title: 'Red Legion Chaos Engine Rust Acceleration' },
      { id: 'V5-RUST-HYB-008', title: 'Observability Telemetry Rust Emitter Core' },
      { id: 'V5-RUST-HYB-009', title: 'WASM Adapter Rust Bridge Expansion' },
      { id: 'V5-RUST-HYB-010', title: 'Hybrid Envelope Validation + Guardrail Gate' }
    ],
    paths: {
      latest_path: 'state/ops/rust_hybrid_migration_program/latest.json',
      receipts_path: 'state/ops/rust_hybrid_migration_program/receipts.jsonl',
      history_path: 'state/ops/rust_hybrid_migration_program/history.jsonl',
      state_dir: 'state/ops/rust_hybrid_migration_program/items',
      artifact_dir: 'state/ops/rust_hybrid_migration_program/artifacts'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const targets = raw.targets && typeof raw.targets === 'object' ? raw.targets : {};
  const docsRequired = Array.isArray(raw.docs_required) ? raw.docs_required : base.docs_required;
  const itemsRaw = Array.isArray(raw.items) ? raw.items : base.items;
  const items: AnyObj[] = [];
  const seen = new Set<string>();
  for (const row of itemsRaw) {
    const id = normalizeId(row && row.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, title: cleanText(row && row.title || id, 260) || id });
  }

  return {
    version: cleanText(raw.version || base.version, 24) || '1.0',
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    docs_required: docsRequired
      .map((v: unknown) => cleanText(v, 260))
      .filter(Boolean)
      .map((p: string) => (path.isAbsolute(p) ? p : path.join(ROOT, p))),
    targets: {
      rust_share_min_pct: clampNumber(targets.rust_share_min_pct, 0, 100, base.targets.rust_share_min_pct),
      rust_share_max_pct: clampNumber(targets.rust_share_max_pct, 0, 100, base.targets.rust_share_max_pct),
      chaos_cycles: clampInt(targets.chaos_cycles, 1000, 5000000, base.targets.chaos_cycles)
    },
    items,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      state_dir: resolvePath(paths.state_dir, base.paths.state_dir),
      artifact_dir: resolvePath(paths.artifact_dir, base.paths.artifact_dir)
    },
    policy_path: path.resolve(policyPath)
  };
}

function writeArtifact(filePath: string, payload: AnyObj, apply: boolean) {
  if (!apply) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonAtomic(filePath, payload);
}

function checkRustPayload(run: AnyObj, laneId: string) {
  return !!(run && run.ok === true && run.payload && run.payload.ok === true && String(run.payload.lane || '') === laneId);
}

function lane001(ctx: LaneCtx) {
  const run = runRustCommand([
    'hybrid-plan',
    `--root=${ROOT}`,
    `--min=${ctx.policy.targets.rust_share_min_pct}`,
    `--max=${ctx.policy.targets.rust_share_max_pct}`
  ]);
  const ok = checkRustPayload(run, 'V5-RUST-HYB-001');
  const artifactPath = path.join(ctx.artifactDir, 'v5_rust_hyb_001_plan.json');
  if (ok) writeArtifact(artifactPath, run.payload, ctx.apply);
  return {
    ok,
    checks: {
      rust_command_ok: run.ok,
      payload_ok: ok,
      rust_vs_ts_present: Number.isFinite(Number(run.payload && run.payload.rust_vs_ts_pct)),
      target_range_present: !!(run.payload && run.payload.target_range_pct)
    },
    summary: {
      rust_vs_ts_pct: run.payload && run.payload.rust_vs_ts_pct,
      within_target: run.payload && run.payload.within_target,
      command_status: run.status,
      duration_ms: run.duration_ms
    },
    artifacts: {
      plan_report_path: rel(artifactPath)
    },
    raw: run
  };
}

function lane002(ctx: LaneCtx) {
  const run = runRustCommand(['memory-hotpath']);
  const ok = checkRustPayload(run, 'V5-RUST-HYB-002');
  const ratio = Number(run.payload && run.payload.compression && run.payload.compression.ratio);
  const artifactPath = path.join(ctx.artifactDir, 'v5_rust_hyb_002_memory_hotpath.json');
  if (ok) writeArtifact(artifactPath, run.payload, ctx.apply);
  return {
    ok,
    checks: {
      rust_command_ok: run.ok,
      payload_ok: ok,
      scheduler_order_present: Array.isArray(run.payload && run.payload.scheduler_order),
      compression_ratio_valid: Number.isFinite(ratio) && ratio > 0
    },
    summary: {
      compression_ratio: ratio,
      duration_ms: run.duration_ms
    },
    artifacts: {
      memory_report_path: rel(artifactPath)
    },
    raw: run
  };
}

function lane003(ctx: LaneCtx) {
  const run = runRustCommand(['execution-replay', '--events=start,hydrate,execute,receipt,commit']);
  const digest = cleanText(run.payload && run.payload.digest || '', 128);
  const ok = checkRustPayload(run, 'V5-RUST-HYB-003') && digest.length === 64;
  const artifactPath = path.join(ctx.artifactDir, 'v5_rust_hyb_003_execution_replay.json');
  if (ok) writeArtifact(artifactPath, run.payload, ctx.apply);
  return {
    ok,
    checks: {
      rust_command_ok: run.ok,
      payload_ok: checkRustPayload(run, 'V5-RUST-HYB-003'),
      digest_sha256_length: digest.length === 64,
      replayable_flag: run.payload && run.payload.replayable === true
    },
    summary: {
      digest,
      duration_ms: run.duration_ms
    },
    artifacts: {
      execution_report_path: rel(artifactPath)
    },
    raw: run
  };
}

function lane004(ctx: LaneCtx) {
  const run = runRustCommand(['security-vault', '--tampered=0']);
  const ok = run.ok && run.payload && run.payload.ok === true && String(run.payload.lane || '') === 'V5-RUST-HYB-004';
  const artifactPath = path.join(ctx.artifactDir, 'v5_rust_hyb_004_security_vault.json');
  if (ok) writeArtifact(artifactPath, run.payload, ctx.apply);
  return {
    ok,
    checks: {
      rust_command_ok: run.ok,
      payload_ok: String(run.payload && run.payload.lane || '') === 'V5-RUST-HYB-004',
      fail_closed_allowed: !!(run.payload && run.payload.attestation && run.payload.attestation.allowed === true)
    },
    summary: {
      duration_ms: run.duration_ms
    },
    artifacts: {
      security_report_path: rel(artifactPath)
    },
    raw: run
  };
}

function lane005(ctx: LaneCtx) {
  const run = runRustCommand(['crdt-merge']);
  const ok = checkRustPayload(run, 'V5-RUST-HYB-005') && run.payload && run.payload.convergent === true;
  const artifactPath = path.join(ctx.artifactDir, 'v5_rust_hyb_005_crdt_merge.json');
  if (ok) writeArtifact(artifactPath, run.payload, ctx.apply);
  return {
    ok,
    checks: {
      rust_command_ok: run.ok,
      payload_ok: checkRustPayload(run, 'V5-RUST-HYB-005'),
      convergent: run.payload && run.payload.convergent === true
    },
    artifacts: {
      crdt_report_path: rel(artifactPath)
    },
    raw: run
  };
}

function lane006(ctx: LaneCtx) {
  const run = runRustCommand(['econ-crypto']);
  const margin = run.payload && run.payload.economics && run.payload.economics.margin_bps;
  const hash = cleanText(run.payload && run.payload.integrity && run.payload.integrity.ledger_hash || '', 128);
  const ok = checkRustPayload(run, 'V5-RUST-HYB-006') && Number.isFinite(Number(margin)) && hash.length === 64;
  const artifactPath = path.join(ctx.artifactDir, 'v5_rust_hyb_006_econ_crypto.json');
  if (ok) writeArtifact(artifactPath, run.payload, ctx.apply);
  return {
    ok,
    checks: {
      rust_command_ok: run.ok,
      payload_ok: checkRustPayload(run, 'V5-RUST-HYB-006'),
      margin_present: Number.isFinite(Number(margin)),
      hash_length_64: hash.length === 64
    },
    summary: {
      margin_bps: margin,
      duration_ms: run.duration_ms
    },
    artifacts: {
      econ_report_path: rel(artifactPath)
    },
    raw: run
  };
}

function lane007(ctx: LaneCtx) {
  const run = runRustCommand(['red-chaos', `--cycles=${ctx.policy.targets.chaos_cycles}`]);
  const throughput = Number(run.payload && run.payload.throughput_ops_sec);
  const ok = checkRustPayload(run, 'V5-RUST-HYB-007') && Number.isFinite(throughput) && throughput > 0;
  const artifactPath = path.join(ctx.artifactDir, 'v5_rust_hyb_007_red_chaos.json');
  if (ok) writeArtifact(artifactPath, run.payload, ctx.apply);
  return {
    ok,
    checks: {
      rust_command_ok: run.ok,
      payload_ok: checkRustPayload(run, 'V5-RUST-HYB-007'),
      throughput_positive: Number.isFinite(throughput) && throughput > 0
    },
    summary: {
      throughput_ops_sec: throughput,
      duration_ms: run.duration_ms
    },
    artifacts: {
      chaos_report_path: rel(artifactPath)
    },
    raw: run
  };
}

function lane008(ctx: LaneCtx) {
  const run = runRustCommand(['telemetry-emit']);
  const agg = run.payload && run.payload.aggregate ? run.payload.aggregate : {};
  const ok = checkRustPayload(run, 'V5-RUST-HYB-008')
    && Number.isFinite(Number(agg.latency_p95_ms))
    && Number.isFinite(Number(agg.latency_p99_ms));
  const artifactPath = path.join(ctx.artifactDir, 'v5_rust_hyb_008_telemetry.json');
  if (ok) writeArtifact(artifactPath, run.payload, ctx.apply);
  return {
    ok,
    checks: {
      rust_command_ok: run.ok,
      payload_ok: checkRustPayload(run, 'V5-RUST-HYB-008'),
      p95_present: Number.isFinite(Number(agg.latency_p95_ms)),
      p99_present: Number.isFinite(Number(agg.latency_p99_ms))
    },
    artifacts: {
      telemetry_report_path: rel(artifactPath)
    },
    raw: run
  };
}

function lane009(ctx: LaneCtx) {
  const run = runRustCommand(['wasm-bridge']);
  const ok = checkRustPayload(run, 'V5-RUST-HYB-009') && run.payload && run.payload.manifest_valid === true;
  const artifactPath = path.join(ctx.artifactDir, 'v5_rust_hyb_009_wasm_bridge.json');
  if (ok) writeArtifact(artifactPath, run.payload, ctx.apply);
  return {
    ok,
    checks: {
      rust_command_ok: run.ok,
      payload_ok: checkRustPayload(run, 'V5-RUST-HYB-009'),
      manifest_valid: run.payload && run.payload.manifest_valid === true
    },
    artifacts: {
      wasm_report_path: rel(artifactPath)
    },
    raw: run
  };
}

function lane010(ctx: LaneCtx) {
  const plan = runRustCommand([
    'hybrid-plan',
    `--root=${ROOT}`,
    `--min=${ctx.policy.targets.rust_share_min_pct}`,
    `--max=${ctx.policy.targets.rust_share_max_pct}`
  ]);
  const withinTarget = !!(plan.payload && plan.payload.within_target);
  const envRun = runRustCommand([
    'hybrid-envelope',
    `--within-target=${withinTarget ? '1' : '0'}`,
    '--completed=9'
  ]);
  const ok = checkRustPayload(envRun, 'V5-RUST-HYB-010') && Array.isArray(envRun.payload && envRun.payload.guardrails);
  const artifactPath = path.join(ctx.artifactDir, 'v5_rust_hyb_010_hybrid_envelope.json');
  if (ok) {
    writeArtifact(artifactPath, {
      plan: plan.payload || null,
      envelope: envRun.payload || null
    }, ctx.apply);
  }
  return {
    ok,
    checks: {
      plan_command_ok: plan.ok,
      envelope_command_ok: envRun.ok,
      envelope_payload_ok: checkRustPayload(envRun, 'V5-RUST-HYB-010'),
      guardrails_present: Array.isArray(envRun.payload && envRun.payload.guardrails) && envRun.payload.guardrails.length >= 3
    },
    summary: {
      within_target: withinTarget,
      envelope_status: envRun.payload && envRun.payload.status || null,
      duration_ms: Number(plan.duration_ms || 0) + Number(envRun.duration_ms || 0)
    },
    artifacts: {
      hybrid_envelope_report_path: rel(artifactPath)
    },
    raw: {
      plan,
      envelope: envRun
    }
  };
}

const HANDLERS: Record<string, (ctx: LaneCtx) => AnyObj> = {
  'V5-RUST-HYB-001': lane001,
  'V5-RUST-HYB-002': lane002,
  'V5-RUST-HYB-003': lane003,
  'V5-RUST-HYB-004': lane004,
  'V5-RUST-HYB-005': lane005,
  'V5-RUST-HYB-006': lane006,
  'V5-RUST-HYB-007': lane007,
  'V5-RUST-HYB-008': lane008,
  'V5-RUST-HYB-009': lane009,
  'V5-RUST-HYB-010': lane010
};

function runLaneById(policy: AnyObj, id: string, apply: boolean, strict: boolean) {
  const item = (policy.items as AnyObj[]).find((row) => row.id === id);
  if (!item) {
    return {
      ok: false,
      error: 'unknown_lane_id',
      id,
      type: 'rust_hybrid_migration_program'
    };
  }
  const handler = HANDLERS[id];
  if (!handler) {
    return {
      ok: false,
      error: 'handler_missing',
      id,
      type: 'rust_hybrid_migration_program'
    };
  }

  for (const docPath of policy.docs_required as string[]) {
    if (!fs.existsSync(docPath)) {
      return {
        ok: false,
        type: 'rust_hybrid_migration_program',
        id,
        error: 'required_doc_missing',
        required_doc: rel(docPath)
      };
    }
  }

  const ctx: LaneCtx = {
    id,
    item,
    policy,
    apply,
    strict,
    artifactDir: policy.paths.artifact_dir
  };

  const laneOut = handler(ctx);
  const ok = !!laneOut.ok;

  const receipt = {
    schema_id: 'rust_hybrid_migration_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    ok,
    type: 'rust_hybrid_migration_program',
    action: 'run',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    lane_id: id,
    title: item.title,
    strict,
    apply,
    checks: laneOut.checks || {},
    artifacts: laneOut.artifacts || {},
    summary: laneOut.summary || null,
    error: laneOut.error || null
  };

  if (apply) {
    const statePath = path.join(policy.paths.state_dir, `${id}.json`);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.mkdirSync(path.dirname(policy.paths.latest_path), { recursive: true });
    fs.mkdirSync(path.dirname(policy.paths.receipts_path), { recursive: true });
    fs.mkdirSync(path.dirname(policy.paths.history_path), { recursive: true });
    writeJsonAtomic(statePath, receipt);
    writeJsonAtomic(policy.paths.latest_path, receipt);
    appendJsonl(policy.paths.receipts_path, receipt);
    appendJsonl(policy.paths.history_path, receipt);
  }

  return receipt;
}

function cmdList(policy: AnyObj) {
  return {
    ok: true,
    type: 'rust_hybrid_migration_program',
    action: 'list',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    item_count: policy.items.length,
    items: policy.items
  };
}

function cmdRun(policy: AnyObj, args: AnyObj) {
  const id = normalizeId(args.id || '');
  if (!id) {
    return {
      ok: false,
      type: 'rust_hybrid_migration_program',
      action: 'run',
      ts: nowIso(),
      error: 'id_required'
    };
  }
  const apply = toBool(args.apply, true);
  const strict = args.strict != null ? toBool(args.strict, policy.strict_default) : policy.strict_default;
  return runLaneById(policy, id, apply, strict);
}

function cmdRunAll(policy: AnyObj, args: AnyObj) {
  const apply = toBool(args.apply, true);
  const strict = args.strict != null ? toBool(args.strict, policy.strict_default) : policy.strict_default;
  const receipts: AnyObj[] = [];
  for (const row of policy.items as AnyObj[]) {
    receipts.push(runLaneById(policy, row.id, apply, strict));
  }
  const failed = receipts.filter((row) => row.ok !== true);
  const out = {
    schema_id: 'rust_hybrid_migration_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    ok: failed.length === 0,
    type: 'rust_hybrid_migration_program',
    action: 'run-all',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    apply,
    strict,
    item_count: policy.items.length,
    completed_count: receipts.filter((row) => row.ok === true).length,
    failed_count: failed.length,
    failed_items: failed.map((row) => ({ id: row.lane_id || row.id || null, error: row.error || null })),
    lanes: receipts.map((row) => ({ id: row.lane_id || row.id || null, ok: row.ok === true }))
  };
  if (apply) {
    writeJsonAtomic(policy.paths.latest_path, out);
    appendJsonl(policy.paths.receipts_path, out);
    appendJsonl(policy.paths.history_path, out);
  }
  return out;
}

function cmdStatus(policy: AnyObj, args: AnyObj) {
  const id = normalizeId(args.id || '');
  if (id) {
    const statePath = path.join(policy.paths.state_dir, `${id}.json`);
    return {
      ok: true,
      type: 'rust_hybrid_migration_program',
      action: 'status',
      ts: nowIso(),
      policy_path: rel(policy.policy_path),
      id,
      state_path: rel(statePath),
      state: readJson(statePath, null)
    };
  }
  return {
    ok: true,
    type: 'rust_hybrid_migration_program',
    action: 'status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    latest: readJson(policy.paths.latest_path, null)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }

  const policyPath = args.policy
    ? (path.isAbsolute(String(args.policy)) ? String(args.policy) : path.join(ROOT, String(args.policy)))
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'policy_disabled' }, 1);

  if (cmd === 'list') emit(cmdList(policy), 0);
  if (cmd === 'run') {
    const out = cmdRun(policy, args);
    emit(out, out.ok ? 0 : 1);
  }
  if (cmd === 'run-all') {
    const out = cmdRunAll(policy, args);
    emit(out, out.ok ? 0 : 1);
  }
  if (cmd === 'status') emit(cmdStatus(policy, args), 0);

  usage();
  process.exit(1);
}

main();
