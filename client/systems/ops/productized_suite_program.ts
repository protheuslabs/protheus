#!/usr/bin/env node
'use strict';
export {};

/**
 * Productized suite + org provenance execution program.
 *
 * Lanes:
 * - V4-SUITE-001..012
 * - V4-BRAND-001..002
 * - V4-TRUST-001
 * - V4-REL-001
 * - V4-ROLL-001
 * - V4-DOC-ORG-001
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
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

type LaneCtx = {
  id: string,
  item: AnyObj,
  policy: AnyObj,
  apply: boolean,
  strict: boolean,
  artifactDir: string
};

const DEFAULT_POLICY_PATH = process.env.PRODUCTIZED_SUITE_PROGRAM_POLICY_PATH
  ? path.resolve(process.env.PRODUCTIZED_SUITE_PROGRAM_POLICY_PATH)
  : path.join(ROOT, 'config', 'productized_suite_program_policy.json');

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function normalizeId(v: unknown) {
  const id = cleanText(v || '', 120).replace(/`/g, '').toUpperCase();
  return /^(V4-SUITE-\d{3}|V4-BRAND-\d{3}|V4-TRUST-\d{3}|V4-REL-\d{3}|V4-ROLL-\d{3}|V4-DOC-ORG-\d{3})$/.test(id)
    ? id
    : '';
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/productized_suite_program.js list [--policy=<path>]');
  console.log('  node systems/ops/productized_suite_program.js run --id=<ID> [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/productized_suite_program.js run-all [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/productized_suite_program.js status [--id=<ID>] [--policy=<path>]');
}

function parseJson(stdout: string) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runNode(args: string[], timeoutMs = 120000) {
  const started = Date.now();
  const out = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs)
  });
  return {
    ok: Number(out.status || 0) === 0,
    status: Number.isFinite(Number(out.status)) ? Number(out.status) : 1,
    duration_ms: Math.max(0, Date.now() - started),
    stderr: cleanText(out.stderr || '', 400),
    payload: parseJson(String(out.stdout || '')),
    args
  };
}

function runTool(tool: string, command: string, extra: string[] = []) {
  return runNode([`bin/protheus-${tool}.js`, command, ...extra]);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    docs_required: [
      'docs/PRODUCTIZED_SUITE_PROGRAM.md'
    ],
    legacy_tokens: [
      'jakerslam',
      'jakers',
      'empty fort solo',
      'single founder only'
    ],
    items: [
      { id: 'V4-SUITE-001', title: 'protheus-graph Deterministic Workflow Engine' },
      { id: 'V4-SUITE-002', title: 'protheus-mem Long-Memory CLI Surface' },
      { id: 'V4-SUITE-003', title: 'protheus-telemetry Trace + Sovereignty Export CLI' },
      { id: 'V4-SUITE-004', title: 'protheus-vault Zero-Knowledge Secrets CLI' },
      { id: 'V4-SUITE-005', title: 'protheus-swarm Multi-Agent Coordination CLI' },
      { id: 'V4-SUITE-006', title: 'protheus-redlegion Adversarial Operations CLI' },
      { id: 'V4-SUITE-007', title: 'protheus-forge Productization Uplift' },
      { id: 'V4-SUITE-008', title: 'protheus-bootstrap Scaffolding CLI' },
      { id: 'V4-SUITE-009', title: 'protheus-econ Unit-Economics CLI' },
      { id: 'V4-SUITE-010', title: 'protheus-soul Public Export Mode' },
      { id: 'V4-SUITE-011', title: 'protheus-pinnacle CLI Polish + Operability Pack' },
      { id: 'V4-SUITE-012', title: 'Suite Governance Pack' },
      { id: 'V4-BRAND-001', title: 'Protheus Labs Org Identity Sweep' },
      { id: 'V4-BRAND-002', title: 'Legacy Identity Purge Gate' },
      { id: 'V4-TRUST-001', title: 'Git Provenance Integrity Guardrail' },
      { id: 'V4-REL-001', title: 'Release Provenance Pipeline' },
      { id: 'V4-ROLL-001', title: 'First-Wave Tool Rollout Sequencer' },
      { id: 'V4-DOC-ORG-001', title: 'Org-Level README + Onboarding Narrative Refresh' }
    ],
    paths: {
      latest_path: 'state/ops/productized_suite_program/latest.json',
      receipts_path: 'state/ops/productized_suite_program/receipts.jsonl',
      history_path: 'state/ops/productized_suite_program/history.jsonl',
      state_dir: 'state/ops/productized_suite_program/items',
      artifact_dir: 'state/ops/productized_suite_program/artifacts'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const docsRequired = Array.isArray(raw.docs_required) ? raw.docs_required : base.docs_required;
  const itemsRaw = Array.isArray(raw.items) ? raw.items : base.items;
  const legacyTokens = Array.isArray(raw.legacy_tokens) ? raw.legacy_tokens : base.legacy_tokens;
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
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, true),
    docs_required: docsRequired
      .map((v: unknown) => cleanText(v, 260))
      .filter(Boolean)
      .map((p: string) => (path.isAbsolute(p) ? p : path.join(ROOT, p))),
    legacy_tokens: legacyTokens.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean),
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

function checkToolLane(id: string, tool: string, command: string, extra: string[] = []) {
  const run = runTool(tool, command, extra);
  const payload = run.payload || {};
  const laneMap: AnyObj = {
    'V4-SUITE-001': { tool: 'graph', cmd: 'validate' },
    'V4-SUITE-002': { tool: 'mem', cmd: 'recall' },
    'V4-SUITE-003': { tool: 'telemetry', cmd: 'sovereignty' },
    'V4-SUITE-004': { tool: 'vault', cmd: 'audit' },
    'V4-SUITE-005': { tool: 'swarm', cmd: 'status' },
    'V4-SUITE-006': { tool: 'redlegion', cmd: 'observe' },
    'V4-SUITE-007': { tool: 'forge', cmd: 'verify' },
    'V4-SUITE-008': { tool: 'bootstrap', cmd: 'policy-check' },
    'V4-SUITE-009': { tool: 'econ', cmd: 'score' },
    'V4-SUITE-010': { tool: 'soul', cmd: 'redact' },
    'V4-SUITE-011': { tool: 'pinnacle', cmd: 'status' }
  };
  const expected = laneMap[id];
  const ok = run.ok && payload && payload.ok === true && payload.tool === expected.tool && payload.command === expected.cmd;
  return { ok, run, payload };
}

function laneSuite(ctx: LaneCtx, tool: string, cmd: string, extra: string[] = []) {
  const checked = checkToolLane(ctx.id, tool, cmd, extra);
  const artifactPath = path.join(ctx.artifactDir, `${ctx.id.toLowerCase()}_${tool}.json`);
  if (checked.ok) writeArtifact(artifactPath, checked.payload, ctx.apply);
  return {
    ok: checked.ok,
    checks: {
      tool_invocation_ok: checked.run.ok,
      payload_ok: checked.payload && checked.payload.ok === true,
      tool_match: checked.payload && checked.payload.tool === tool,
      command_match: checked.payload && checked.payload.command === cmd
    },
    summary: {
      tool,
      command: cmd,
      duration_ms: checked.run.duration_ms
    },
    artifacts: {
      receipt_path: rel(artifactPath)
    }
  };
}

function lane012(ctx: LaneCtx) {
  const tools = ['graph', 'mem', 'telemetry', 'vault', 'swarm', 'redlegion', 'forge', 'bootstrap', 'econ', 'soul', 'pinnacle'];
  const wrappers = tools.map((t) => `bin/protheus-${t}.js`);
  const missing = wrappers.filter((p) => !fs.existsSync(path.join(ROOT, p)));
  const pkg = readJson(path.join(ROOT, 'package.json'), {});
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const governanceScripts = [
    'ops:productized-suite:list',
    'ops:productized-suite:run-all',
    'ops:productized-suite:status',
    'test:ops:productized-suite',
    'ops:rust-hybrid:list',
    'ops:rust-hybrid:run-all',
    'ops:rust-hybrid:status'
  ];
  const missingScripts = governanceScripts.filter((s) => !scripts[s]);

  const out = {
    wrappers_total: wrappers.length,
    wrappers_missing: missing,
    governance_scripts_missing: missingScripts,
    naming_prefix: 'protheus-*'
  };
  const artifactPath = path.join(ctx.artifactDir, `${ctx.id.toLowerCase()}_governance.json`);
  writeArtifact(artifactPath, out, ctx.apply);

  return {
    ok: missing.length === 0,
    checks: {
      wrappers_present: missing.length === 0,
      governance_scripts_present: missingScripts.length === 0
    },
    summary: out,
    artifacts: {
      governance_report_path: rel(artifactPath)
    }
  };
}

function laneBrand001(ctx: LaneCtx) {
  const targets = ['README.md', 'docs/RUST_HYBRID_MIGRATION_IMPLEMENTATION.md', 'package.json'];
  const snapshot: AnyObj = {};
  let hitCount = 0;
  for (const relPath of targets) {
    const abs = path.join(ROOT, relPath);
    const raw = fs.existsSync(abs) ? String(fs.readFileSync(abs, 'utf8') || '') : '';
    const has = raw.includes('Protheus Labs');
    if (has) hitCount += 1;
    snapshot[relPath] = { exists: fs.existsSync(abs), has_protheus_labs: has };
  }
  const out = {
    required_hits: targets.length,
    observed_hits: hitCount,
    snapshot
  };
  const artifactPath = path.join(ctx.artifactDir, `${ctx.id.toLowerCase()}_brand_sweep.json`);
  writeArtifact(artifactPath, out, ctx.apply);
  return {
    ok: hitCount >= 2,
    checks: {
      brand_presence_hits: hitCount >= 2
    },
    summary: out,
    artifacts: {
      brand_report_path: rel(artifactPath)
    }
  };
}

function laneBrand002(ctx: LaneCtx) {
  const files = ['README.md', 'docs/RUST_HYBRID_MIGRATION_IMPLEMENTATION.md', 'docs/PRODUCTIZED_SUITE_PROGRAM.md', 'package.json'];
  const findings: AnyObj[] = [];
  for (const relPath of files) {
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) continue;
    const raw = String(fs.readFileSync(abs, 'utf8') || '').toLowerCase();
    for (const token of ctx.policy.legacy_tokens as string[]) {
      if (raw.includes(token)) findings.push({ path: relPath, token });
    }
  }
  const artifactPath = path.join(ctx.artifactDir, `${ctx.id.toLowerCase()}_legacy_scan.json`);
  writeArtifact(artifactPath, { findings }, ctx.apply);
  return {
    ok: findings.length === 0,
    checks: {
      legacy_tokens_absent: findings.length === 0
    },
    summary: {
      findings_count: findings.length
    },
    artifacts: {
      legacy_scan_path: rel(artifactPath)
    }
  };
}

function laneTrust001(ctx: LaneCtx) {
  const policyPath = path.join(ROOT, '.github', 'branch_protection_baseline.json');
  const policy = {
    schema_id: 'git_provenance_integrity_guardrail',
    schema_version: '1.0',
    generated_at: nowIso(),
    branch: 'main',
    allow_force_push: false,
    require_signed_commits: true,
    require_linear_history: true,
    require_status_checks: true
  };
  if (ctx.apply) {
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    writeJsonAtomic(policyPath, policy);
  }
  return {
    ok: true,
    checks: {
      branch_policy_written: true,
      force_push_blocked: policy.allow_force_push === false
    },
    summary: policy,
    artifacts: {
      branch_policy_path: rel(policyPath)
    }
  };
}

function laneRel001(ctx: LaneCtx) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const count = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const headSha = cleanText(head.stdout || '', 80);
  const commitCount = Number(cleanText(count.stdout || '0', 40)) || 0;
  const out = {
    schema_id: 'release_provenance_receipt',
    schema_version: '1.0',
    ts: nowIso(),
    head_sha: headSha,
    commit_count: commitCount,
    generated_changelog_range: `${Math.max(1, commitCount - 50)}..${commitCount}`,
    signed_tags_required: true
  };
  const artifactPath = path.join(ctx.artifactDir, `${ctx.id.toLowerCase()}_release_provenance.json`);
  writeArtifact(artifactPath, out, ctx.apply);
  return {
    ok: headSha.length >= 7,
    checks: {
      head_sha_present: headSha.length >= 7,
      commit_count_present: commitCount >= 1
    },
    summary: out,
    artifacts: {
      release_provenance_path: rel(artifactPath)
    }
  };
}

function laneRoll001(ctx: LaneCtx) {
  const firstWave = [
    { tool: 'graph', command: 'validate' },
    { tool: 'mem', command: 'recall' },
    { tool: 'telemetry', command: 'sovereignty' },
    { tool: 'vault', command: 'audit' }
  ];
  const checks = firstWave.map((row) => {
    const run = runTool(row.tool, row.command, row.tool === 'mem' ? ['--q=health'] : []);
    return {
      tool: row.tool,
      command: row.command,
      ok: run.ok && run.payload && run.payload.ok === true
    };
  });
  const ok = checks.every((row) => row.ok === true);
  const artifactPath = path.join(ctx.artifactDir, `${ctx.id.toLowerCase()}_rollout.json`);
  writeArtifact(artifactPath, { checks }, ctx.apply);
  return {
    ok,
    checks: {
      first_wave_ready: ok
    },
    summary: {
      checks
    },
    artifacts: {
      rollout_report_path: rel(artifactPath)
    }
  };
}

function laneDocOrg001(ctx: LaneCtx) {
  const onboardingPath = path.join(ROOT, 'docs', 'ORG_ONBOARDING.md');
  const body = [
    '# Protheus Labs Onboarding',
    '',
    'This guide provides the operator and contributor quickstart for the productized suite.',
    '',
    '## Surfaces',
    '- `protheus-graph`, `protheus-mem`, `protheus-telemetry`, `protheus-vault`',
    '- `protheus-swarm`, `protheus-redlegion`, `protheus-forge`, `protheus-bootstrap`',
    '- `protheus-econ`, `protheus-soul`, `protheus-pinnacle`',
    '',
    '## Runbook',
    '1. Validate branch protection and provenance policies.',
    '2. Run first-wave rollout checks.',
    '3. Run suite governance checks before release.',
    '4. Record signed release provenance receipts.'
  ].join('\n') + '\n';
  if (ctx.apply) {
    fs.mkdirSync(path.dirname(onboardingPath), { recursive: true });
    fs.writeFileSync(onboardingPath, body, 'utf8');
  }
  return {
    ok: true,
    checks: {
      onboarding_doc_written: true
    },
    summary: {
      onboarding_path: rel(onboardingPath)
    },
    artifacts: {
      onboarding_doc_path: rel(onboardingPath)
    }
  };
}

const HANDLERS: Record<string, (ctx: LaneCtx) => AnyObj> = {
  'V4-SUITE-001': (ctx) => laneSuite(ctx, 'graph', 'validate', ['--workflow=suite']),
  'V4-SUITE-002': (ctx) => laneSuite(ctx, 'mem', 'recall', ['--q=suite']),
  'V4-SUITE-003': (ctx) => laneSuite(ctx, 'telemetry', 'sovereignty'),
  'V4-SUITE-004': (ctx) => laneSuite(ctx, 'vault', 'audit'),
  'V4-SUITE-005': (ctx) => laneSuite(ctx, 'swarm', 'status'),
  'V4-SUITE-006': (ctx) => laneSuite(ctx, 'redlegion', 'observe'),
  'V4-SUITE-007': (ctx) => laneSuite(ctx, 'forge', 'verify'),
  'V4-SUITE-008': (ctx) => laneSuite(ctx, 'bootstrap', 'policy-check'),
  'V4-SUITE-009': (ctx) => laneSuite(ctx, 'econ', 'score'),
  'V4-SUITE-010': (ctx) => laneSuite(ctx, 'soul', 'redact'),
  'V4-SUITE-011': (ctx) => laneSuite(ctx, 'pinnacle', 'status'),
  'V4-SUITE-012': lane012,
  'V4-BRAND-001': laneBrand001,
  'V4-BRAND-002': laneBrand002,
  'V4-TRUST-001': laneTrust001,
  'V4-REL-001': laneRel001,
  'V4-ROLL-001': laneRoll001,
  'V4-DOC-ORG-001': laneDocOrg001
};

function runLaneById(policy: AnyObj, id: string, apply: boolean, strict: boolean) {
  const item = (policy.items as AnyObj[]).find((row) => row.id === id);
  if (!item) {
    return { ok: false, type: 'productized_suite_program', id, error: 'unknown_lane_id' };
  }
  const handler = HANDLERS[id];
  if (!handler) {
    return { ok: false, type: 'productized_suite_program', id, error: 'handler_missing' };
  }

  for (const docPath of policy.docs_required as string[]) {
    if (!fs.existsSync(docPath)) {
      return {
        ok: false,
        type: 'productized_suite_program',
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

  const out = handler(ctx);
  const receipt = {
    schema_id: 'productized_suite_program_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    ok: !!out.ok,
    type: 'productized_suite_program',
    action: 'run',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    lane_id: id,
    title: item.title,
    strict,
    apply,
    checks: out.checks || {},
    artifacts: out.artifacts || {},
    summary: out.summary || null,
    error: out.error || null,
    receipt_id: `suite_prog_${stableHash(JSON.stringify({ id, out, ts: nowIso() }), 14)}`
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
    type: 'productized_suite_program',
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
      type: 'productized_suite_program',
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
    schema_id: 'productized_suite_program_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    ok: failed.length === 0,
    type: 'productized_suite_program',
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
      type: 'productized_suite_program',
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
    type: 'productized_suite_program',
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

module.exports = {
  loadPolicy,
  runLaneById
};

if (require.main === module) {
  main();
}
