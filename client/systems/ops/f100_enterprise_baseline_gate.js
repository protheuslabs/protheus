#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    const cargo = path.join(dir, 'Cargo.toml');
    const layer0 = path.join(dir, 'core', 'layer0', 'ops', 'Cargo.toml');
    const legacy = path.join(dir, 'crates', 'ops', 'Cargo.toml');
    if (fs.existsSync(cargo) && (fs.existsSync(layer0) || fs.existsSync(legacy))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(startDir || process.cwd());
    }
    dir = parent;
  }
}

const CLIENT_ROOT = path.resolve(__dirname, '..', '..');
const ROOT = findRepoRoot(CLIENT_ROOT);
const DEFAULT_CONTRACT_PATH = path.join(CLIENT_ROOT, 'config', 'f100_enterprise_baseline_contract.json');
const DEFAULT_DOC_PATH = path.join(CLIENT_ROOT, 'docs', 'ops', 'F100_ENTERPRISE_BASELINE_STATUS.md');
const DEFAULT_STATE_PATH = path.join(CLIENT_ROOT, 'state', 'ops', 'f100_enterprise_baseline_gate', 'latest.json');

function parseArgs(argv) {
  const args = {
    command: 'run',
    strict: false,
    write: true
  };
  const parts = argv.slice(2);
  if (parts.length > 0 && !parts[0].startsWith('--')) {
    args.command = parts[0];
  }
  for (const raw of parts) {
    if (!raw.startsWith('--')) {
      continue;
    }
    const [key, value = '1'] = raw.slice(2).split('=');
    if (key === 'strict') {
      args.strict = value === '1' || value === 'true';
    } else if (key === 'write') {
      args.write = value === '1' || value === 'true';
    }
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function digest(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function evaluateCheck(check) {
  const absolutePath = path.join(ROOT, check.path);
  if (check.type === 'file_exists') {
    const ok = fs.existsSync(absolutePath);
    return {
      ...check,
      ok,
      reason: ok ? 'ok' : 'missing_file'
    };
  }

  if (check.type === 'file_contains') {
    if (!fs.existsSync(absolutePath)) {
      return {
        ...check,
        ok: false,
        reason: 'missing_file'
      };
    }
    const body = fs.readFileSync(absolutePath, 'utf8');
    const ok = body.includes(check.pattern);
    return {
      ...check,
      ok,
      reason: ok ? 'ok' : 'missing_pattern'
    };
  }

  return {
    ...check,
    ok: false,
    reason: `unsupported_type:${check.type}`
  };
}

function buildMarkdown(report) {
  const lines = [];
  lines.push('# F100 Enterprise Baseline Status');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push('');
  lines.push('| Check | Type | Path | Status | Reason |');
  lines.push('|---|---|---|---|---|');
  for (const check of report.checks) {
    lines.push(
      `| \`${check.id}\` | \`${check.type}\` | \`${check.path}\` | ${check.ok ? 'PASS' : 'FAIL'} | \`${check.reason}\` |`
    );
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total checks: ${report.summary.total_checks}`);
  lines.push(`- Passed checks: ${report.summary.passed_checks}`);
  lines.push(`- Failed checks: ${report.summary.failed_checks}`);
  lines.push(`- Contract status: ${report.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`- Receipt hash: \`${report.receipt_hash}\``);
  lines.push('');
  return lines.join('\n');
}

function run(args) {
  const contractPath = process.env.F100_BASELINE_CONTRACT_PATH || DEFAULT_CONTRACT_PATH;
  const docPath = process.env.F100_BASELINE_DOC_PATH || DEFAULT_DOC_PATH;
  const statePath = process.env.F100_BASELINE_STATE_PATH || DEFAULT_STATE_PATH;

  const contract = readJson(contractPath);
  const checks = (contract.checks || []).map((check) => evaluateCheck(check));
  const passedChecks = checks.filter((check) => check.ok).length;
  const failedChecks = checks.length - passedChecks;

  const report = {
    schema_id: 'f100_enterprise_baseline_gate_result',
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    contract_path: rel(contractPath),
    ok: failedChecks === 0,
    summary: {
      total_checks: checks.length,
      passed_checks: passedChecks,
      failed_checks: failedChecks
    },
    checks
  };

  report.receipt_hash = digest(
    JSON.stringify({
      schema_id: report.schema_id,
      schema_version: report.schema_version,
      generated_at: report.generated_at,
      contract_path: report.contract_path,
      summary: report.summary,
      checks: report.checks.map((check) => ({ id: check.id, ok: check.ok, reason: check.reason }))
    })
  );

  if (args.write) {
    ensureDir(docPath);
    fs.writeFileSync(docPath, buildMarkdown(report));
  }
  ensureDir(statePath);
  fs.writeFileSync(statePath, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.strict && !report.ok) {
    process.exit(1);
  }
}

function status() {
  const statePath = process.env.F100_BASELINE_STATE_PATH || DEFAULT_STATE_PATH;
  if (!fs.existsSync(statePath)) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_id: 'f100_enterprise_baseline_gate_result',
          schema_version: '1.0.0',
          ok: false,
          reason: 'state_missing',
          state_path: rel(statePath)
        },
        null,
        2
      )}\n`
    );
    process.exit(1);
  }

  process.stdout.write(fs.readFileSync(statePath, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv);
  if (args.command === 'run') {
    run(args);
    return;
  }
  if (args.command === 'status') {
    status();
    return;
  }

  process.stderr.write(
    `unknown_command:${args.command}\nusage: node client/systems/ops/f100_enterprise_baseline_gate.js [run|status] [--strict=1] [--write=1]\n`
  );
  process.exit(1);
}

main();
