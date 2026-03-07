#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-FCH-004
 * Backlog intake quality gate.
 *
 * Usage:
 *   node systems/ops/backlog_intake_quality_gate.js run [--strict=1|0]
 *   node systems/ops/backlog_intake_quality_gate.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.BACKLOG_INTAKE_QUALITY_ROOT
  ? path.resolve(process.env.BACKLOG_INTAKE_QUALITY_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.BACKLOG_INTAKE_QUALITY_POLICY_PATH
  ? path.resolve(process.env.BACKLOG_INTAKE_QUALITY_POLICY_PATH)
  : path.join(ROOT, 'config', 'backlog_intake_quality_policy.json');

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
  console.log('  node systems/ops/backlog_intake_quality_gate.js run [--strict=1|0] [--policy=path]');
  console.log('  node systems/ops/backlog_intake_quality_gate.js status [--policy=path]');
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

function resolvePath(raw: unknown, fallbackRel: string) {
  const token = cleanText(raw || '', 500);
  if (!token) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(token) ? token : path.join(ROOT, token);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    schema_id: 'backlog_intake_quality_policy',
    schema_version: '1.0',
    enabled: true,
    strict_default: true,
    backlog_path: 'SRS.md',
    target_sections: [],
    required_class_values: ['primitive', 'primitive-upgrade', 'extension', 'hardening'],
    require_dependency_notes: true,
    require_duplicate_mapping: true,
    outputs: {
      latest_path: 'state/ops/backlog_intake_quality/latest.json',
      history_path: 'state/ops/backlog_intake_quality/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const targetSections = Array.isArray(raw.target_sections)
    ? raw.target_sections.map((v: unknown) => cleanText(v, 220)).filter(Boolean)
    : base.target_sections;
  const classValues = Array.isArray(raw.required_class_values)
    ? raw.required_class_values.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
    : base.required_class_values;
  return {
    schema_id: 'backlog_intake_quality_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    backlog_path: resolvePath(raw.backlog_path, base.backlog_path),
    target_sections: targetSections,
    required_class_values: classValues,
    require_dependency_notes: toBool(raw.require_dependency_notes, base.require_dependency_notes),
    require_duplicate_mapping: toBool(raw.require_duplicate_mapping, base.require_duplicate_mapping),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function sectionBlocks(markdown: string) {
  const regex = /^##\s+(.+)$/gm;
  const rows: AnyObj[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(markdown)) !== null) {
    rows.push({
      heading: cleanText(m[1], 220),
      start: m.index,
      end: markdown.length
    });
  }
  for (let i = 0; i < rows.length - 1; i += 1) {
    rows[i].end = rows[i + 1].start;
  }
  return rows.map((row) => ({
    heading: row.heading,
    body: markdown.slice(row.start, row.end)
  }));
}

function evaluateSection(section: AnyObj, policy: AnyObj) {
  const body = String(section.body || '');
  const lines = body.split('\n');
  const violations: string[] = [];
  const info: AnyObj = {
    heading: section.heading,
    has_table: false,
    class_column_present: false,
    rows_checked: 0,
    row_violations: 0,
    has_dependency_notes: body.includes('Dependency notes:'),
    has_duplicate_mapping: /Duplicate\/hardening mapping/i.test(body)
  };

  let headerCols: string[] = [];
  let classIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    if (line.includes('| ID ') && line.includes('| Status ')) {
      info.has_table = true;
      headerCols = line.split('|').map((c) => cleanText(c, 80)).filter(Boolean);
      classIdx = headerCols.findIndex((c) => c.toLowerCase() === 'class');
      info.class_column_present = classIdx >= 0;
      break;
    }
  }

  if (!info.has_table) violations.push('table_missing');
  if (!info.class_column_present) violations.push('class_column_missing');
  if (policy.require_dependency_notes && !info.has_dependency_notes) violations.push('dependency_notes_missing');
  if (policy.require_duplicate_mapping && !info.has_duplicate_mapping) violations.push('duplicate_mapping_missing');

  if (info.has_table && info.class_column_present) {
    const allowed = new Set((policy.required_class_values || []).map((v: unknown) => normalizeToken(v, 80)));
    for (const line of lines) {
      if (!line.startsWith('| V') && !line.startsWith('| OBS') && !line.startsWith('| RM-') && !line.startsWith('| SEC-')) continue;
      const cols = line.split('|').map((c) => cleanText(c, 120)).filter(Boolean);
      if (cols.length < headerCols.length) continue;
      info.rows_checked += 1;
      const classVal = normalizeToken(cols[classIdx] || '', 80);
      if (!allowed.has(classVal)) {
        info.row_violations += 1;
        violations.push(`row_class_invalid:${classVal || 'missing'}`);
      }
    }
  }

  return {
    ...info,
    ok: violations.length === 0,
    violations: Array.from(new Set(violations))
  };
}

function evaluate(policy: AnyObj) {
  if (!fs.existsSync(policy.backlog_path)) {
    return {
      ok: false,
      error: 'backlog_missing',
      backlog_path: rel(policy.backlog_path),
      sections: []
    };
  }
  const text = fs.readFileSync(policy.backlog_path, 'utf8');
  const blocks = sectionBlocks(text);
  const targets = blocks.filter((row) => policy.target_sections.some((needle: string) => row.heading.includes(needle)));
  const sections = targets.map((row) => evaluateSection(row, policy));
  const failed = sections.filter((row: AnyObj) => row.ok !== true);
  return {
    ok: failed.length === 0,
    backlog_path: rel(policy.backlog_path),
    targeted_sections: sections.length,
    failed_sections: failed.length,
    sections
  };
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    const out = {
      ok: false,
      type: 'backlog_intake_quality_gate',
      ts: nowIso(),
      error: 'policy_disabled',
      policy_path: rel(policy.policy_path)
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, policy.strict_default);
  const gate = evaluate(policy);
  const out = {
    ok: gate.ok === true,
    type: 'backlog_intake_quality_gate',
    ts: nowIso(),
    strict,
    policy_path: rel(policy.policy_path),
    gate
  };
  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.outputs.latest_path, null);
  if (!latest || typeof latest !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'backlog_intake_quality_gate_status',
      error: 'latest_missing',
      latest_path: rel(policy.outputs.latest_path),
      policy_path: rel(policy.policy_path)
    })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'backlog_intake_quality_gate_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.outputs.latest_path),
    payload: latest
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
  loadPolicy,
  evaluate
};
