#!/usr/bin/env node
'use strict';

/**
 * external_security_cycle.js
 *
 * V2-012 support lane:
 * - ingest external assessor findings
 * - track remediation closure progress
 * - emit readiness status for audit trail
 *
 * Usage:
 *   node systems/security/external_security_cycle.js ingest --report-file=/abs/report.json --assessor="Vendor"
 *   node systems/security/external_security_cycle.js status
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.EXTERNAL_SECURITY_CYCLE_POLICY_PATH
  ? path.resolve(process.env.EXTERNAL_SECURITY_CYCLE_POLICY_PATH)
  : path.join(ROOT, 'config', 'external_security_cycle_policy.json');
const STATE_DIR = process.env.EXTERNAL_SECURITY_CYCLE_STATE_DIR
  ? path.resolve(process.env.EXTERNAL_SECURITY_CYCLE_STATE_DIR)
  : path.join(ROOT, 'state', 'security', 'external_assessment');
const ASSESSMENTS_PATH = path.join(STATE_DIR, 'assessments.jsonl');
const FINDINGS_PATH = path.join(STATE_DIR, 'findings.json');

function nowIso() {
  return new Date().toISOString();
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

function normalizeToken(v, maxLen = 64) {
  return normalizeText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function writeJsonAtomic(filePath, payload) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  return {
    version: normalizeText(src.version || '1.0', 32) || '1.0',
    required_fields: Array.isArray(src.required_fields)
      ? src.required_fields.map((k) => normalizeToken(k, 64)).filter(Boolean)
      : ['id', 'severity', 'title', 'status'],
    status_closed_values: Array.isArray(src.status_closed_values)
      ? src.status_closed_values.map((k) => normalizeToken(k, 64)).filter(Boolean)
      : ['closed', 'resolved', 'verified'],
    severity_order: Array.isArray(src.severity_order)
      ? src.severity_order.map((k) => normalizeToken(k, 32)).filter(Boolean)
      : ['critical', 'high', 'medium', 'low', 'info']
  };
}

function normalizeFinding(raw, policy) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const finding = {
    id: normalizeText(row.id || row.finding_id || row.key, 120),
    severity: normalizeToken(row.severity || 'medium', 24) || 'medium',
    title: normalizeText(row.title || row.summary || row.name, 240),
    status: normalizeToken(row.status || row.state || 'open', 32) || 'open',
    owner: normalizeText(row.owner || row.assignee || '', 120) || null,
    remediation_plan: normalizeText(row.remediation_plan || row.plan || '', 400) || null,
    evidence_ref: normalizeText(row.evidence_ref || row.reference || '', 240) || null,
    updated_at: normalizeText(row.updated_at || row.ts || nowIso(), 80)
  };
  for (const field of policy.required_fields) {
    if (!normalizeText(finding[field], 8)) return null;
  }
  if (!policy.severity_order.includes(finding.severity)) finding.severity = 'medium';
  return finding;
}

function scoreSeverity(severity, order) {
  const idx = order.indexOf(normalizeToken(severity, 24));
  return idx === -1 ? order.length + 1 : idx;
}

function cmdIngest(args) {
  const policy = loadPolicy();
  const reportFile = normalizeText(args['report-file'] || args.report_file || '', 400);
  const assessor = normalizeText(args.assessor || args.vendor || 'external_assessor', 120) || 'external_assessor';
  if (!reportFile) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'report_file_required' }) + '\n');
    process.exit(2);
  }

  const payload = readJson(path.resolve(reportFile), null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'report_file_invalid' }) + '\n');
    process.exit(2);
  }

  const rows = Array.isArray(payload.findings)
    ? payload.findings
    : (Array.isArray(payload.issues) ? payload.issues : []);
  const findings = rows
    .map((row) => normalizeFinding(row, policy))
    .filter(Boolean);

  const merged = readJson(FINDINGS_PATH, { findings: [] });
  const table = new Map();
  for (const row of Array.isArray(merged.findings) ? merged.findings : []) {
    if (!row || typeof row !== 'object') continue;
    const id = normalizeText(row.id, 120);
    if (!id) continue;
    table.set(id, row);
  }
  for (const row of findings) {
    table.set(row.id, row);
  }

  const mergedRows = Array.from(table.values())
    .sort((a, b) => scoreSeverity(a.severity, policy.severity_order) - scoreSeverity(b.severity, policy.severity_order)
      || String(a.id || '').localeCompare(String(b.id || '')));

  writeJsonAtomic(FINDINGS_PATH, {
    schema_id: 'external_security_findings',
    schema_version: '1.0',
    ts: nowIso(),
    findings: mergedRows
  });

  const closedSet = new Set(policy.status_closed_values || []);
  const openCount = mergedRows.filter((row) => !closedSet.has(normalizeToken(row.status, 32))).length;

  const receipt = {
    ts: nowIso(),
    type: 'external_security_assessment_ingest',
    assessor,
    report_file: path.relative(ROOT, path.resolve(reportFile)).replace(/\\/g, '/'),
    ingested_findings: findings.length,
    merged_findings: mergedRows.length,
    open_findings: openCount,
    policy_version: policy.version
  };
  appendJsonl(ASSESSMENTS_PATH, receipt);

  process.stdout.write(JSON.stringify({ ok: true, ...receipt }) + '\n');
}

function cmdStatus() {
  const policy = loadPolicy();
  const findingsPayload = readJson(FINDINGS_PATH, { findings: [] });
  const findings = Array.isArray(findingsPayload.findings) ? findingsPayload.findings : [];
  const rows = readJsonl(ASSESSMENTS_PATH);
  const closedSet = new Set(policy.status_closed_values || []);

  const severityCounts = {};
  let open = 0;
  for (const row of findings) {
    const severity = normalizeToken(row && row.severity || 'medium', 24) || 'medium';
    severityCounts[severity] = Number(severityCounts[severity] || 0) + 1;
    const closed = closedSet.has(normalizeToken(row && row.status || 'open', 32));
    if (!closed) open += 1;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'external_security_assessment_status',
    ts: nowIso(),
    policy_version: policy.version,
    findings_total: findings.length,
    findings_open: open,
    findings_closed: Math.max(0, findings.length - open),
    severity_counts: severityCounts,
    last_ingest: rows.length ? rows[rows.length - 1] : null,
    evidence_paths: {
      findings_path: path.relative(ROOT, FINDINGS_PATH).replace(/\\/g, '/'),
      assessments_path: path.relative(ROOT, ASSESSMENTS_PATH).replace(/\\/g, '/')
    }
  }) + '\n');
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/external_security_cycle.js ingest --report-file=/abs/report.json --assessor="Vendor"');
  console.log('  node systems/security/external_security_cycle.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0], 32);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'ingest') return cmdIngest(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
