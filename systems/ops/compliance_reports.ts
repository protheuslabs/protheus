#!/usr/bin/env node
'use strict';

/**
 * compliance_reports.js
 *
 * Compliance/reporting automation + SOC2 Type I readiness evidence index.
 *
 * Usage:
 *   node systems/ops/compliance_reports.js evidence-index [--days=30]
 *   node systems/ops/compliance_reports.js soc2-readiness [--days=30] [--strict=1|0]
 *   node systems/ops/compliance_reports.js status
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.COMPLIANCE_REPORT_POLICY_PATH
  ? path.resolve(process.env.COMPLIANCE_REPORT_POLICY_PATH)
  : path.join(ROOT, 'config', 'compliance_controls_map.json');
const OUT_DIR = process.env.COMPLIANCE_REPORT_OUT_DIR
  ? path.resolve(process.env.COMPLIANCE_REPORT_OUT_DIR)
  : path.join(ROOT, 'state', 'ops', 'compliance');
const HISTORY_PATH = process.env.COMPLIANCE_REPORT_HISTORY_PATH
  ? path.resolve(process.env.COMPLIANCE_REPORT_HISTORY_PATH)
  : path.join(OUT_DIR, 'history.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/compliance_reports.js evidence-index [--days=30]');
  console.log('  node systems/ops/compliance_reports.js soc2-readiness [--days=30] [--strict=1|0]');
  console.log('  node systems/ops/compliance_reports.js status');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function normalizeText(v, maxLen = 240) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = normalizeText(v, 24).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    strict_default: false,
    controls: [
      {
        id: 'CC6.1',
        title: 'Logical Access Security Controls',
        owner: 'security',
        frequency: 'daily',
        evidence: [
          { type: 'jsonl_min_rows', path: 'state/security/policy_root_decisions.jsonl', min_rows: 1 },
          { type: 'jsonl_min_rows', path: 'state/security/integrity_violations.jsonl', min_rows: 0 }
        ]
      },
      {
        id: 'CC7.2',
        title: 'Change Management + Detection',
        owner: 'ops',
        frequency: 'daily',
        evidence: [
          { type: 'jsonl_min_rows', path: 'state/autonomy/receipts.jsonl', min_rows: 1 },
          { type: 'file_exists', path: 'docs/OPERATOR_RUNBOOK.md' }
        ]
      },
      {
        id: 'CC8.1',
        title: 'Incident Response + Recovery',
        owner: 'ops',
        frequency: 'weekly',
        evidence: [
          { type: 'jsonl_min_rows', path: 'state/ops/postmortem_log.jsonl', min_rows: 0 },
          { type: 'file_exists', path: 'docs/THREAT_MODEL_V1.md' }
        ]
      }
    ]
  };
}

function normalizeEvidenceRule(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const type = normalizeText(src.type || 'file_exists', 80).toLowerCase();
  const rel = normalizeText(src.path || '', 320);
  if (!rel) return null;
  return {
    type,
    path: rel,
    min_rows: Math.max(0, Number(src.min_rows || 0)),
    key: normalizeText(src.key || '', 120) || null
  };
}

function normalizeControl(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = normalizeText(src.id || '', 48).toUpperCase();
  if (!id) return null;
  const evidence = (Array.isArray(src.evidence) ? src.evidence : [])
    .map(normalizeEvidenceRule)
    .filter(Boolean);
  return {
    id,
    title: normalizeText(src.title || '', 180) || id,
    owner: normalizeText(src.owner || 'unassigned', 80) || 'unassigned',
    frequency: normalizeText(src.frequency || 'weekly', 48) || 'weekly',
    evidence
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const controls = (Array.isArray(src.controls) && src.controls.length ? src.controls : base.controls)
    .map(normalizeControl)
    .filter(Boolean);
  return {
    version: normalizeText(src.version || base.version, 32) || '1.0',
    strict_default: src.strict_default === true,
    controls
  };
}

function rowWithinDays(ts, days) {
  const ms = Date.parse(String(ts || ''));
  if (!Number.isFinite(ms)) return false;
  const cutoff = Date.now() - (days * 86400000);
  return ms >= cutoff;
}

function evaluateEvidenceRule(rule, days) {
  const absPath = path.resolve(ROOT, rule.path);
  if (rule.type === 'file_exists') {
    return {
      ok: fs.existsSync(absPath),
      type: rule.type,
      path: rule.path,
      observed: fs.existsSync(absPath) ? 'present' : 'missing',
      min_rows: null,
      rows: null,
      latest_ts: null
    };
  }

  if (rule.type === 'jsonl_min_rows') {
    const rows = readJsonl(absPath).filter((row) => rowWithinDays(row && row.ts, days));
    let latestTs = null;
    for (const row of rows) {
      const ts = Date.parse(String(row.ts || ''));
      if (Number.isFinite(ts)) {
        latestTs = latestTs == null || ts > latestTs ? ts : latestTs;
      }
    }
    return {
      ok: rows.length >= Number(rule.min_rows || 0),
      type: rule.type,
      path: rule.path,
      observed: rows.length,
      min_rows: Number(rule.min_rows || 0),
      rows: rows.length,
      latest_ts: latestTs != null ? new Date(latestTs).toISOString() : null
    };
  }

  if (rule.type === 'json_key_exists') {
    const payload = readJson(absPath, null);
    const key = String(rule.key || '');
    const ok = !!(payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, key));
    return {
      ok,
      type: rule.type,
      path: rule.path,
      key,
      observed: ok ? 'present' : 'missing',
      min_rows: null,
      rows: null,
      latest_ts: null
    };
  }

  return {
    ok: false,
    type: rule.type,
    path: rule.path,
    observed: 'unsupported_rule_type',
    min_rows: null,
    rows: null,
    latest_ts: null
  };
}

function buildEvidenceIndex(policy, days) {
  const controls = [];
  let totalRules = 0;
  let passedRules = 0;

  for (const control of policy.controls) {
    const evidence = [];
    for (const rule of control.evidence) {
      const evalOut = evaluateEvidenceRule(rule, days);
      evidence.push(evalOut);
      totalRules += 1;
      if (evalOut.ok) passedRules += 1;
    }
    controls.push({
      id: control.id,
      title: control.title,
      owner: control.owner,
      frequency: control.frequency,
      evidence
    });
  }

  return {
    type: 'compliance_evidence_index',
    ts: nowIso(),
    window_days: days,
    policy_version: policy.version,
    total_rules: totalRules,
    passed_rules: passedRules,
    failed_rules: Math.max(0, totalRules - passedRules),
    pass_rate: totalRules > 0 ? Number((passedRules / totalRules).toFixed(4)) : null,
    controls
  };
}

function buildSoc2Readiness(policy, evidenceIndex) {
  const controls = [];
  let passCount = 0;
  for (const control of evidenceIndex.controls || []) {
    const failedEvidence = (control.evidence || []).filter((row) => row.ok !== true);
    const pass = failedEvidence.length === 0;
    if (pass) passCount += 1;
    controls.push({
      id: control.id,
      title: control.title,
      owner: control.owner,
      frequency: control.frequency,
      pass,
      failed_evidence: failedEvidence
    });
  }

  return {
    ok: controls.length > 0 ? passCount === controls.length : false,
    type: 'soc2_readiness',
    ts: nowIso(),
    policy_version: policy.version,
    controls_total: controls.length,
    controls_passed: passCount,
    controls_failed: Math.max(0, controls.length - passCount),
    pass_rate: controls.length > 0 ? Number((passCount / controls.length).toFixed(4)) : null,
    controls
  };
}

function outPaths(dateStr) {
  const dayDir = path.join(OUT_DIR, dateStr);
  return {
    day_dir: dayDir,
    evidence_index: path.join(dayDir, 'evidence_index.json'),
    soc2_readiness: path.join(dayDir, 'soc2_readiness.json')
  };
}

function cmdEvidenceIndex(args) {
  const policy = loadPolicy();
  const days = clampInt(args.days, 1, 365, 30);
  const evidence = buildEvidenceIndex(policy, days);
  const paths = outPaths(todayStr());
  writeJsonAtomic(paths.evidence_index, evidence);
  appendJsonl(HISTORY_PATH, {
    ts: nowIso(),
    type: 'compliance_evidence_index',
    pass_rate: evidence.pass_rate,
    failed_rules: evidence.failed_rules,
    path: relPath(paths.evidence_index)
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    ...evidence,
    output_path: relPath(paths.evidence_index)
  }, null, 2) + '\n');
}

function cmdSoc2Readiness(args) {
  const policy = loadPolicy();
  const days = clampInt(args.days, 1, 365, 30);
  const strict = toBool(args.strict, policy.strict_default);
  const evidence = buildEvidenceIndex(policy, days);
  const readiness = buildSoc2Readiness(policy, evidence);

  const paths = outPaths(todayStr());
  writeJsonAtomic(paths.evidence_index, evidence);
  writeJsonAtomic(paths.soc2_readiness, readiness);
  appendJsonl(HISTORY_PATH, {
    ts: nowIso(),
    type: 'soc2_readiness',
    ok: readiness.ok,
    controls_failed: readiness.controls_failed,
    path: relPath(paths.soc2_readiness)
  });

  process.stdout.write(JSON.stringify({
    ...readiness,
    evidence_index_path: relPath(paths.evidence_index),
    readiness_path: relPath(paths.soc2_readiness)
  }, null, 2) + '\n');
  if (strict && readiness.ok !== true) process.exit(1);
}

function cmdStatus() {
  const history = readJsonl(HISTORY_PATH).slice(-30);
  const soc2Rows = history.filter((row) => row && row.type === 'soc2_readiness');
  const fail = soc2Rows.filter((row) => row.ok !== true).length;
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'compliance_report_status',
    ts: nowIso(),
    history_path: relPath(HISTORY_PATH),
    recent_history_count: history.length,
    recent_soc2_runs: soc2Rows.length,
    recent_soc2_failures: fail,
    recent_soc2_pass_rate: soc2Rows.length > 0
      ? Number(((soc2Rows.length - fail) / soc2Rows.length).toFixed(4))
      : null,
    latest: history.length > 0 ? history[history.length - 1] : null
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeText(args._[0], 64).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'evidence-index') return cmdEvidenceIndex(args);
  if (cmd === 'soc2-readiness') return cmdSoc2Readiness(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  buildEvidenceIndex,
  buildSoc2Readiness
};
export {};
