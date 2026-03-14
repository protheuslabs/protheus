#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const OUT_JSON_DEFAULT = 'core/local/artifacts/module_cohesion_audit_current.json';
const OUT_MD_DEFAULT = 'local/workspace/reports/MODULE_COHESION_AUDIT_CURRENT.md';

function parseArgs(argv) {
  const out = {
    policy: 'client/runtime/config/module_cohesion_policy.json',
    outJson: OUT_JSON_DEFAULT,
    outMarkdown: OUT_MD_DEFAULT,
    strict: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--policy=')) out.policy = arg.slice('--policy='.length);
    else if (arg.startsWith('--out-json=')) out.outJson = arg.slice('--out-json='.length);
    else if (arg.startsWith('--out-markdown=')) out.outMarkdown = arg.slice('--out-markdown='.length);
    else if (arg.startsWith('--strict=')) {
      const value = String(arg.slice('--strict='.length)).toLowerCase();
      out.strict = ['1', 'true', 'yes', 'on'].includes(value);
    } else if (arg === '--strict') out.strict = true;
  }
  return out;
}

function normalizePath(value) {
  return String(value).replace(/\\/g, '/');
}

function hasAnyPrefix(value, prefixes) {
  return prefixes.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

function readJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function countLines(absPath) {
  const buf = fs.readFileSync(absPath);
  if (buf.length === 0) return 0;
  let lf = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 10) lf += 1;
  }
  return buf[buf.length - 1] === 10 ? lf : lf + 1;
}

function determineHardCap(filePath, defaultCap, byPrefix) {
  const entries = Object.entries(byPrefix || {}).sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, cap] of entries) {
    const normalized = normalizePath(prefix).replace(/\/+$/, '');
    if (filePath === normalized || filePath.startsWith(`${normalized}/`)) {
      return Number(cap);
    }
  }
  return Number(defaultCap);
}

function rel(absPath) {
  return normalizePath(path.relative(ROOT, absPath));
}

function loadBaseline(policy) {
  const baselinePathRel = normalizePath(policy.legacy_baseline_path || '').trim();
  if (!baselinePathRel) return { path: null, files: {} };
  const baselinePathAbs = path.resolve(ROOT, baselinePathRel);
  if (!fs.existsSync(baselinePathAbs)) return { path: baselinePathRel, files: {} };
  const raw = readJson(baselinePathAbs);
  if (raw && typeof raw === 'object' && raw.files && typeof raw.files === 'object') {
    return { path: baselinePathRel, files: raw.files };
  }
  return { path: baselinePathRel, files: raw && typeof raw === 'object' ? raw : {} };
}

function trackedFiles() {
  const out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean);
}

function sortByLinesDesc(rows) {
  return rows.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
}

function toMarkdown(payload) {
  const lines = [];
  lines.push('# Module Cohesion Audit (Current)');
  lines.push('');
  lines.push(`Generated: ${payload.generated_at}`);
  lines.push(`Revision: \`${payload.revision}\``);
  lines.push(`Policy: \`${payload.policy_path}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- pass: ${payload.summary.pass ? 'true' : 'false'}`);
  lines.push(`- scanned_files: ${payload.summary.scanned_files}`);
  lines.push(`- violations: ${payload.summary.violation_count}`);
  lines.push(`- new_over_cap: ${payload.summary.new_over_cap_count}`);
  lines.push(`- legacy_growth_violations: ${payload.summary.legacy_growth_violation_count}`);
  lines.push(`- legacy_debt_files: ${payload.summary.legacy_debt_count}`);
  lines.push(`- warning_attention_files(>${payload.summary.warning_threshold_lines}): ${payload.summary.warning_attention_count}`);
  lines.push(`- exempt_over_cap_files: ${payload.summary.exempt_over_cap_count}`);
  lines.push('');

  if (payload.violations.length > 0) {
    lines.push('## Violations');
    lines.push('| File | Lines | Cap | Kind | Detail |');
    lines.push('| --- | ---: | ---: | --- | --- |');
    for (const row of payload.violations) {
      lines.push(
        `| \`${row.file}\` | ${row.lines} | ${row.hard_cap} | ${row.kind} | ${String(row.detail || '').replaceAll('|', '\\|')} |`,
      );
    }
    lines.push('');
  }

  if (payload.warning_attention.length > 0) {
    lines.push('## Warning Attention (>800 lines)');
    lines.push('| File | Lines | Cap |');
    lines.push('| --- | ---: | ---: |');
    for (const row of payload.warning_attention.slice(0, 100)) {
      lines.push(`| \`${row.file}\` | ${row.lines} | ${row.hard_cap} |`);
    }
    lines.push('');
  }

  if (payload.legacy_debt.length > 0) {
    lines.push('## Legacy Debt (Tracked, Not New)');
    lines.push('| File | Current | Baseline | Allowed Max | Cap |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const row of payload.legacy_debt.slice(0, 120)) {
      lines.push(`| \`${row.file}\` | ${row.lines} | ${row.baseline_lines} | ${row.allowed_max_lines} | ${row.hard_cap} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policyPathAbs = path.resolve(ROOT, args.policy);
  const policyPathRel = rel(policyPathAbs);
  const policy = readJson(policyPathAbs);

  let revision = 'unknown';
  try {
    revision = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {}

  const scanRoots = (policy.scan_roots || []).map((v) => normalizePath(v).replace(/\/+$/, ''));
  const includeExts = new Set((policy.include_extensions || []).map((v) => String(v).toLowerCase()));
  const ignorePathPrefixes = (policy.ignore_path_prefixes || []).map((v) => normalizePath(v).replace(/\/+$/, ''));
  const ignoreExactPaths = new Set((policy.ignore_exact_paths || []).map((v) => normalizePath(v)));
  const exemptPrefixes = (policy.stable_simple_exempt_prefixes || []).map((v) => normalizePath(v).replace(/\/+$/, ''));
  const exemptPaths = new Set((policy.stable_simple_exempt_paths || []).map((v) => normalizePath(v)));

  const hardCapDefault = Number(policy.hard_cap_lines_default || 600);
  const warningThreshold = Number(policy.warning_threshold_lines || 800);
  const legacySlack = Number(policy.legacy_growth_slack_lines || 0);
  const baseline = loadBaseline(policy);

  const files = trackedFiles()
    .filter((file) => hasAnyPrefix(file, scanRoots))
    .filter((file) => !hasAnyPrefix(file, ignorePathPrefixes))
    .filter((file) => !ignoreExactPaths.has(file))
    .filter((file) => includeExts.has(path.extname(file).toLowerCase()))
    .filter((file) => fs.existsSync(path.resolve(ROOT, file)));

  const warningAttention = [];
  const legacyDebt = [];
  const legacyRetired = [];
  const exemptOverCap = [];
  const violations = [];
  const scannedLineMap = new Map();

  for (const file of files) {
    const abs = path.resolve(ROOT, file);
    const lines = countLines(abs);
    const hardCap = determineHardCap(file, hardCapDefault, policy.hard_cap_lines_by_prefix || {});
    scannedLineMap.set(file, { lines, hardCap });

    if (lines > warningThreshold) {
      warningAttention.push({ file, lines, hard_cap: hardCap });
    }

    if (lines <= hardCap) continue;

    const isExempt = exemptPaths.has(file) || hasAnyPrefix(file, exemptPrefixes);
    const baselineLinesRaw = baseline.files[file];
    const baselineLines = Number.isFinite(Number(baselineLinesRaw)) ? Number(baselineLinesRaw) : null;

    if (isExempt) {
      exemptOverCap.push({ file, lines, hard_cap: hardCap, reason: 'stable_simple_exception' });
      continue;
    }

    if (baselineLines !== null) {
      const allowedMax = baselineLines + legacySlack;
      if (lines > allowedMax) {
        violations.push({
          file,
          lines,
          hard_cap: hardCap,
          kind: 'legacy_growth_exceeds_slack',
          detail: `baseline=${baselineLines}, allowed_max=${allowedMax}, slack=${legacySlack}`,
        });
      } else {
        legacyDebt.push({
          file,
          lines,
          baseline_lines: baselineLines,
          allowed_max_lines: allowedMax,
          hard_cap: hardCap,
        });
      }
      continue;
    }

    violations.push({
      file,
      lines,
      hard_cap: hardCap,
      kind: 'new_over_hard_cap',
      detail: `new file over hard cap (${hardCap})`,
    });
  }

  for (const [file, baselineLinesRaw] of Object.entries(baseline.files)) {
    const baselineLines = Number(baselineLinesRaw);
    if (!Number.isFinite(baselineLines)) continue;
    const scanned = scannedLineMap.get(file);
    if (!scanned) continue;
    if (scanned.lines <= scanned.hardCap) {
      legacyRetired.push({
        file,
        lines: scanned.lines,
        baseline_lines: baselineLines,
        hard_cap: scanned.hardCap,
      });
    }
  }

  sortByLinesDesc(violations);
  sortByLinesDesc(warningAttention);
  sortByLinesDesc(legacyDebt);
  sortByLinesDesc(exemptOverCap);
  sortByLinesDesc(legacyRetired);

  const payload = {
    type: 'module_cohesion_policy_audit',
    generated_at: new Date().toISOString(),
    revision,
    policy_path: policyPathRel,
    legacy_baseline_path: baseline.path,
    summary: {
      pass: violations.length === 0,
      scanned_files: files.length,
      hard_cap_lines_default: hardCapDefault,
      warning_threshold_lines: warningThreshold,
      legacy_growth_slack_lines: legacySlack,
      violation_count: violations.length,
      new_over_cap_count: violations.filter((v) => v.kind === 'new_over_hard_cap').length,
      legacy_growth_violation_count: violations.filter((v) => v.kind === 'legacy_growth_exceeds_slack').length,
      legacy_debt_count: legacyDebt.length,
      legacy_retired_count: legacyRetired.length,
      warning_attention_count: warningAttention.length,
      exempt_over_cap_count: exemptOverCap.length,
    },
    violations,
    warning_attention: warningAttention,
    legacy_debt: legacyDebt,
    exempt_over_cap: exemptOverCap,
    legacy_retired: legacyRetired,
  };

  if (args.outJson) {
    const outJsonAbs = path.resolve(ROOT, args.outJson);
    fs.mkdirSync(path.dirname(outJsonAbs), { recursive: true });
    fs.writeFileSync(outJsonAbs, `${JSON.stringify(payload, null, 2)}\n`);
  }

  if (args.outMarkdown) {
    const outMdAbs = path.resolve(ROOT, args.outMarkdown);
    fs.mkdirSync(path.dirname(outMdAbs), { recursive: true });
    fs.writeFileSync(outMdAbs, toMarkdown(payload));
  }

  console.log(
    JSON.stringify(
      {
        ok: payload.summary.pass,
        type: payload.type,
        out_json: args.outJson,
        out_markdown: args.outMarkdown,
        summary: payload.summary,
      },
      null,
      2,
    ),
  );

  if (args.strict && violations.length > 0) process.exit(1);
}

main();
