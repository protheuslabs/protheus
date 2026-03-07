#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

type CheckDef = {
  id: string,
  title: string,
  command: string[],
  action: string,
  optional?: boolean
};

type SectionDef = {
  key: string,
  title: string,
  checks: CheckDef[]
};

const ROOT = process.env.SYSTEM_HEALTH_AUDIT_RUNNER_ROOT
  ? path.resolve(process.env.SYSTEM_HEALTH_AUDIT_RUNNER_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.SYSTEM_HEALTH_AUDIT_RUNNER_POLICY_PATH
  ? path.resolve(process.env.SYSTEM_HEALTH_AUDIT_RUNNER_POLICY_PATH)
  : path.join(ROOT, 'config', 'system_health_audit_runner_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 320) {
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
  console.log('  node systems/ops/system_health_audit_runner.js run [--strict=1|0] [--full=1|0] [--quick=1|0] [--policy=<path>]');
  console.log('  node systems/ops/system_health_audit_runner.js status [--policy=<path>]');
}
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath: string, row: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || '', 600);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}
function rel(absPath: string) { return path.relative(ROOT, absPath).replace(/\\/g, '/'); }
function runJsonCommand(command: string[], timeoutMsOverride?: number) {
  const [bin, ...args] = command;
  const timeoutMs = Math.max(
    5000,
    Number(timeoutMsOverride || process.env.SYSTEM_HEALTH_AUDIT_CHECK_TIMEOUT_MS || 90_000)
  );
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs });
  const stdout = String(r.stdout || '').trim();
  let parsed = null;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch { parsed = null; }
  const timedOut = !!(r.error && String(r.error.code || '').toUpperCase() === 'ETIMEDOUT');
  const ok = !timedOut && r.status === 0 && (!parsed || parsed.ok !== false);
  return {
    ok,
    status: Number(r.status || 0),
    stdout,
    stderr: String(r.stderr || '').trim(),
    parsed,
    timed_out: timedOut,
    timeout_ms: timeoutMs
  };
}
function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    check_timeout_ms: 300000,
    report_dir: 'research/system_health_audits',
    latest_path: 'state/ops/system_health_audit/latest.json',
    receipts_path: 'state/ops/system_health_audit/receipts.jsonl',
    full_mode_runs_test_ci: false
  };
}
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    check_timeout_ms: clampInt(raw.check_timeout_ms, 5000, 3600_000, base.check_timeout_ms),
    report_dir: resolvePath(raw.report_dir || base.report_dir, base.report_dir),
    latest_path: resolvePath(raw.latest_path || base.latest_path, base.latest_path),
    receipts_path: resolvePath(raw.receipts_path || base.receipts_path, base.receipts_path),
    full_mode_runs_test_ci: toBool(raw.full_mode_runs_test_ci, base.full_mode_runs_test_ci),
    policy_path: path.resolve(policyPath)
  };
}

function buildSections(fullMode: boolean, quickMode: boolean): SectionDef[] {
  const maybeCiCheck: CheckDef[] = fullMode
    ? [{ id: 'ci_full', title: 'Full CI suite', command: ['npm', 'run', '-s', 'test:ci'], action: 'Resolve failing CI checks before autonomy resume.', optional: false }]
    : [];

  const sections: SectionDef[] = [
    {
      key: 'completeness',
      title: 'Completeness',
      checks: [
        { id: 'passport_status', title: 'Passport active chain', command: ['npm', 'run', '-s', 'passport:status'], action: 'Bootstrap passport signing key and issue active passport.' },
        { id: 'explanation_status', title: 'Explanation primitive status', command: ['npm', 'run', '-s', 'explanation:status'], action: 'Emit explanations for major decisions to close explainability gap.' },
        { id: 'foundation_contract', title: 'Foundation contract gate', command: ['npm', 'run', '-s', 'foundation:contract'], action: 'Fix missing required contracts and gates.' }
      ]
    },
    {
      key: 'efficiency',
      title: 'Efficiency & Resource Usage',
      checks: [
        { id: 'surface_budget', title: 'Surface budget status', command: ['npm', 'run', '-s', 'hardware:surface-budget:status'], action: 'Refresh stale surface budget and enforce runtime caps.' },
        { id: 'runtime_efficiency', title: 'Runtime efficiency lane', command: ['npm', 'run', '-s', 'ops:runtime-efficiency:status'], action: 'Patch top cost/latency regressions in runtime hot paths.' }
      ]
    },
    {
      key: 'wiring',
      title: 'Wiring & Architectural Integrity',
      checks: [
        { id: 'integrity', title: 'Integrity policy check', command: ['npm', 'run', '-s', 'integrity:check'], action: 'Reseal integrity policy for changed protected files.' },
        { id: 'contract_check', title: 'Contract check', command: ['node', 'systems/spine/contract_check.js'], action: 'Close contract check mismatches in core pathways.' }
      ]
    },
    {
      key: 'reliability',
      title: 'Bugs & Reliability',
      checks: [
        { id: 'execution_reliability', title: 'Execution reliability status', command: ['npm', 'run', '-s', 'ops:execution-reliability:status'], action: 'Resolve repeated execution failures and fallback dead-ends.' },
        { id: 'critical_formal', title: 'Critical path formal verifier', command: ['npm', 'run', '-s', 'test:critical:path:formal'], action: 'Resolve critical path formal invariant failures.' },
        ...maybeCiCheck
      ]
    },
    {
      key: 'purity',
      title: 'Primitive-First Purity',
      checks: [
        { id: 'simplicity', title: 'Simplicity budget gate', command: ['npm', 'run', '-s', 'foundation:simplicity:status'], action: 'Backfill offset receipts or reduce bespoke modules.' },
        { id: 'primitives_registry', title: 'Primitive registry status', command: ['npm', 'run', '-s', 'primitives:registry:status'], action: 'Register missing opcodes and remove special-case kernels.' }
      ]
    },
    {
      key: 'governance',
      title: 'Governance, Alignment & Duality',
      checks: [
        { id: 'echo_status', title: 'Heroic Echo status', command: ['npm', 'run', '-s', 'echo:status'], action: 'Repair Echo gate drift and rerun purification checks.' },
        { id: 'echo_anchor_status', title: 'Echo value-anchor status', command: ['npm', 'run', '-s', 'echo:value-anchor:status'], action: 'Repair value-anchor renewal drift and rerun governance checks.' }
      ]
    },
    {
      key: 'security',
      title: 'Security & Sovereignty',
      checks: [
        { id: 'helix_status', title: 'Helix status', command: ['npm', 'run', '-s', 'helix:status'], action: 'Fix helix attestation failures before any live execution.' },
        { id: 'redteam_status', title: 'Red team colony status', command: ['npm', 'run', '-s', 'redteam:colony:status'], action: 'Resolve unresolved quarantine or malice detections.' },
        { id: 'sandbox_status', title: 'Sandbox envelope status', command: ['npm', 'run', '-s', 'security:sandbox:status'], action: 'Seal any host-access bypasses in actuation lanes.' }
      ]
    },
    {
      key: 'observability',
      title: 'Observability & Explainability',
      checks: [
        { id: 'explanation_verify', title: 'Explanation verify status', command: ['npm', 'run', '-s', 'explanation:status'], action: 'Ensure explanation artifacts are emitted and verifiable.' },
        { id: 'siem_status', title: 'SIEM export status', command: ['npm', 'run', '-s', 'ops:siem:status'], action: 'Repair telemetry exports and alert routing.' }
      ]
    },
    {
      key: 'scalability',
      title: 'Scalability & Hardware Agnosticism',
      checks: [
        { id: 'embodiment_status', title: 'Embodiment layer status', command: ['npm', 'run', '-s', 'hardware:embodiment:status'], action: 'Refresh embodiment profile and parity checks.' },
        { id: 'scale_envelope', title: 'Scale envelope test', command: ['npm', 'run', '-s', 'foundation:scale-envelope'], action: 'Fix profile-invariant regressions across hardware envelopes.' }
      ]
    },
    {
      key: 'self_improvement',
      title: 'Self-Improvement Health',
      checks: [
        { id: 'self_improve_status', title: 'Self-improve loop status', command: ['npm', 'run', '-s', 'selfimprove:status'], action: 'Repair self-improvement gating or failed simulations.' },
        { id: 'gated_loop_status', title: 'Gated self-improvement status', command: ['npm', 'run', '-s', 'test:selfimprove:loop'], action: 'Fix failed long-horizon simulation gates before promoting changes.' }
      ]
    }
  ];
  if (!quickMode) return sections;
  return sections.map((section) => ({
    ...section,
    checks: section.checks.slice(0, 1)
  })).slice(0, 6);
}

function scoreSection(results: AnyObj[]) {
  const total = results.length;
  const passed = results.filter((row) => row.ok === true).length;
  if (total <= 0) return 0;
  return Number(((passed / total) * 10).toFixed(1));
}

function renderMarkdown(report: AnyObj) {
  const lines: string[] = [];
  lines.push(`# Protheus System Health Audit`);
  lines.push('');
  lines.push(`- Timestamp: ${report.ts}`);
  lines.push(`- Overall Score: ${report.overall_score}/10`);
  lines.push(`- Passed Checks: ${report.totals.passed}/${report.totals.total}`);
  lines.push('');
  lines.push('## Section Scores');
  lines.push('');
  for (const section of report.sections) {
    lines.push(`- ${section.title}: ${section.score}/10 (${section.passed}/${section.total})`);
  }
  lines.push('');
  lines.push('## Action Items');
  lines.push('');
  if (!report.action_items.length) {
    lines.push('- No immediate action items.');
  } else {
    for (const item of report.action_items) {
      lines.push(`- [${item.section}] ${item.check}: ${item.action}`);
    }
  }
  lines.push('');
  lines.push('## Detailed Checks');
  lines.push('');
  for (const section of report.sections) {
    lines.push(`### ${section.title}`);
    for (const row of section.checks) {
      lines.push(`- ${row.ok ? 'PASS' : 'FAIL'} ${row.title}`);
      if (!row.ok && row.reason) lines.push(`  - Reason: ${row.reason}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

function runAudit(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, false);
  const full = toBool(args.full, policy.full_mode_runs_test_ci);
  const quick = toBool(args.quick, false);
  const sectionsDef = buildSections(full, quick);

  const sections = [] as AnyObj[];
  const actionItems = [] as AnyObj[];

  for (const section of sectionsDef) {
    const checks = [] as AnyObj[];
    for (const check of section.checks) {
      const result = runJsonCommand(check.command, policy.check_timeout_ms);
      const ok = result.ok === true;
      const reason = ok
        ? null
        : cleanText(
          (result.timed_out ? `check_timeout_${result.timeout_ms}ms` : null)
          || (result.parsed && (result.parsed.reason || result.parsed.error))
          || result.stderr
          || result.stdout
          || `exit_${result.status}`,
          240
        ) || 'check_failed';
      checks.push({
        id: check.id,
        title: check.title,
        ok,
        command: check.command.join(' '),
        reason,
        status: result.status
      });
      if (!ok) {
        actionItems.push({
          section: section.title,
          check: check.title,
          action: check.action
        });
      }
    }
    sections.push({
      key: section.key,
      title: section.title,
      score: scoreSection(checks),
      passed: checks.filter((row) => row.ok === true).length,
      total: checks.length,
      checks
    });
  }

  const totalChecks = sections.reduce((acc, sec) => acc + Number(sec.total || 0), 0);
  const totalPassed = sections.reduce((acc, sec) => acc + Number(sec.passed || 0), 0);
  const overallScore = totalChecks > 0 ? Number(((totalPassed / totalChecks) * 10).toFixed(1)) : 0;

  const report = {
    ok: actionItems.length === 0,
    type: 'system_health_audit_runner',
    ts: nowIso(),
    strict,
    full,
    quick,
    overall_score: overallScore,
    totals: {
      total: totalChecks,
      passed: totalPassed,
      failed: totalChecks - totalPassed
    },
    sections,
    action_items: actionItems,
    paths: {
      latest_path: rel(policy.latest_path),
      receipts_path: rel(policy.receipts_path),
      report_dir: rel(policy.report_dir),
      policy_path: rel(policy.policy_path)
    }
  };

  ensureDir(policy.report_dir);
  const reportFile = path.join(policy.report_dir, `${nowIso().slice(0, 10)}_automated_health_audit.md`);
  fs.writeFileSync(reportFile, renderMarkdown(report), 'utf8');

  const out = {
    ...report,
    report_markdown_path: rel(reportFile)
  };

  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  if (strict && out.ok !== true) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
  }
  return out;
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  if (!latest || typeof latest !== 'object') {
    return {
      ok: false,
      type: 'system_health_audit_runner_status',
      reason: 'status_not_found',
      latest_path: rel(policy.latest_path)
    };
  }
  return {
    ok: true,
    type: 'system_health_audit_runner_status',
    ts: nowIso(),
    latest,
    latest_path: rel(policy.latest_path),
    receipts_path: rel(policy.receipts_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 64);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    const out = runAudit(args);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  if (cmd === 'status') {
    const out = cmdStatus(args);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (!out.ok) process.exit(1);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  runAudit,
  cmdStatus
};
