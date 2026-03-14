#!/usr/bin/env node
/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT_JSON = 'core/local/artifacts/simplicity_drift_audit_current.json';
const OUT_MD = 'local/workspace/reports/SIMPLICITY_DRIFT_AUDIT_CURRENT.md';
const CLIENT_TARGET_AUDIT = 'core/local/artifacts/client_target_contract_audit_current.json';

function parseArgs(argv) {
  return {
    strict: argv.includes('--strict=1') || argv.includes('--strict'),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function duplicateScriptCommands(scripts) {
  const byCmd = new Map();
  for (const [name, raw] of Object.entries(scripts ?? {})) {
    const cmd = String(raw ?? '').trim();
    if (!byCmd.has(cmd)) byCmd.set(cmd, []);
    byCmd.get(cmd).push(name);
  }
  return [...byCmd.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([cmd, names]) => ({ cmd, names: names.sort(), count: names.length }))
    .sort((a, b) => b.count - a.count || a.names[0].localeCompare(b.names[0]));
}

function toMarkdown(payload) {
  const lines = [];
  lines.push('# Simplicity Drift Audit (Current)');
  lines.push('');
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- pass: ${payload.summary.pass ? 'true' : 'false'}`);
  lines.push(`- strict: ${payload.summary.strict ? 'true' : 'false'}`);
  lines.push(`- duplicate_command_groups: ${payload.summary.duplicateCommandGroups}`);
  lines.push(`- client_target_hard_violations: ${payload.summary.clientTargetHardViolations}`);
  lines.push(`- client_target_gap_count: ${payload.summary.clientTargetGapCount}`);
  lines.push(`- client_wrapper_count: ${payload.summary.clientWrapperCount}`);
  lines.push(`- client_allowed_non_wrapper_count: ${payload.summary.clientAllowedNonWrapperCount}`);
  lines.push('');
  if (payload.duplicateCommands.length > 0) {
    lines.push('## Duplicate Script Commands');
    lines.push('| Count | Script Names | Command |');
    lines.push('| ---: | --- | --- |');
    for (const row of payload.duplicateCommands) {
      lines.push(`| ${row.count} | ${row.names.join(', ')} | \`${row.cmd.replaceAll('`', '\\`')}\` |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = readJson('package.json');
  const duplicateCommands = duplicateScriptCommands(pkg.scripts ?? {});
  const clientTarget = existsSync(resolve(CLIENT_TARGET_AUDIT)) ? readJson(CLIENT_TARGET_AUDIT) : null;
  const metrics = clientTarget?.metrics ?? {};

  const summary = {
    strict: args.strict,
    duplicateCommandGroups: duplicateCommands.length,
    clientTargetHardViolations: Number(clientTarget?.summary?.hard_violation_count ?? 0),
    clientTargetGapCount: Number(clientTarget?.summary?.target_gap_count ?? 0),
    clientWrapperCount: Number(metrics.wrapper_count ?? 0),
    clientAllowedNonWrapperCount: Number(metrics.allowed_non_wrapper_count ?? 0),
    pass:
      duplicateCommands.length === 0 &&
      Number(clientTarget?.summary?.hard_violation_count ?? 0) === 0 &&
      Number(clientTarget?.summary?.target_gap_count ?? 0) === 0,
  };

  const payload = {
    ok: true,
    type: 'simplicity_drift_audit',
    generatedAt: new Date().toISOString(),
    source: { package: 'package.json', clientTargetAudit: CLIENT_TARGET_AUDIT },
    summary,
    duplicateCommands,
  };

  mkdirSync(resolve('core/local/artifacts'), { recursive: true });
  mkdirSync(resolve('local/workspace/reports'), { recursive: true });
  writeFileSync(resolve(OUT_JSON), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(resolve(OUT_MD), toMarkdown(payload));

  if (args.strict && !summary.pass) {
    console.error(JSON.stringify({ ok: false, type: payload.type, out_json: OUT_JSON, summary }, null, 2));
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        type: payload.type,
        out_json: OUT_JSON,
        out_markdown: OUT_MD,
        summary,
      },
      null,
      2,
    ),
  );
}

main();
