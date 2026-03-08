#!/usr/bin/env node
'use strict';

/**
 * handoff_pack.js
 *
 * Deterministic maintainer handoff pack + simulation receipts.
 *
 * Usage:
 *   node systems/ops/handoff_pack.js build [YYYY-MM-DD]
 *   node systems/ops/handoff_pack.js simulate [YYYY-MM-DD] [--strict=1|0]
 *   node systems/ops/handoff_pack.js list [--limit=N]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.HANDOFF_POLICY_PATH
  ? path.resolve(process.env.HANDOFF_POLICY_PATH)
  : path.join(ROOT, 'config', 'handoff_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/handoff_pack.js build [YYYY-MM-DD]');
  console.log('  node systems/ops/handoff_pack.js simulate [YYYY-MM-DD] [--strict=1|0]');
  console.log('  node systems/ops/handoff_pack.js list [--limit=N]');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
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

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function resolveDate(args) {
  const first = String(args._[1] || '').trim();
  if (isDateStr(first)) return first;
  const alt = String(args.date || '').trim();
  if (isDateStr(alt)) return alt;
  return todayStr();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function toBool(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function normText(v, max = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function countFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  const stack = [dirPath];
  let count = 0;
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || !fs.existsSync(cur)) continue;
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      if (!e) continue;
      const fp = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dist') continue;
        stack.push(fp);
      } else if (e.isFile()) {
        count += 1;
      }
    }
  }
  return count;
}

function runCommand(cmd) {
  const normalized = String(cmd || '')
    .replace(/\bnode\s+client\//g, 'node ')
    .replace(/\bnpm\s+run\s+-s\s+/g, 'npm run -s ');
  const r = spawnSync('sh', ['-lc', normalized], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env }
  });
  return {
    command: cmd,
    normalized_command: normalized,
    ok: r.status === 0,
    status: Number(r.status || 0),
    stdout: String(r.stdout || '').trim().split('\n').slice(0, 30).join('\n'),
    stderr: String(r.stderr || '').trim().split('\n').slice(0, 30).join('\n')
  };
}

function loadPolicy() {
  const raw = readJson(POLICY_PATH, {});
  const ownership = Array.isArray(raw.ownership_matrix) ? raw.ownership_matrix : [];
  return {
    version: normText(raw.version || '1.0', 24),
    pack_dir: normText(raw.pack_dir || 'state/ops/handoff_pack', 240),
    receipts_path: normText(raw.receipts_path || 'state/ops/handoff_simulation_receipts.jsonl', 240),
    sla_target_minutes: Math.max(1, Number(raw.sla_target_minutes || 45)),
    required_docs: (Array.isArray(raw.required_docs) ? raw.required_docs : [])
      .map((x) => normText(x, 240))
      .filter(Boolean),
    critical_commands: (Array.isArray(raw.critical_commands) ? raw.critical_commands : [])
      .map((x) => normText(x, 300))
      .filter(Boolean),
    ownership_matrix: ownership
      .map((row) => ({
        path_prefix: normText(row && row.path_prefix, 120),
        primary_owner: normText(row && row.primary_owner, 80) || 'unassigned',
        secondary_owner: normText(row && row.secondary_owner, 80) || 'unassigned',
        service_level: normText(row && row.service_level, 40) || 'medium'
      }))
      .filter((row) => row.path_prefix)
  };
}

function policyPaths(policy) {
  return {
    packDir: path.resolve(ROOT, policy.pack_dir),
    receiptsPath: path.resolve(ROOT, policy.receipts_path)
  };
}

function defaultArchitectureMap() {
  const roots = ['systems', 'lib', 'adaptive', 'habits', 'skills', 'config', 'docs'];
  return roots.map((rel) => ({
    path: rel,
    files: countFiles(path.join(ROOT, rel))
  }));
}

function missingDocs(requiredDocs) {
  const out = [] as string[];
  for (const rel of requiredDocs || []) {
    if (!rel) continue;
    const fp = path.resolve(ROOT, rel);
    if (!fs.existsSync(fp)) out.push(rel);
  }
  return out;
}

function packPath(policy, dateStr) {
  const p = policyPaths(policy);
  return path.join(p.packDir, `${dateStr}.json`);
}

function latestPackPath(policy) {
  const p = policyPaths(policy);
  if (!fs.existsSync(p.packDir)) return null;
  const files = fs.readdirSync(p.packDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (files.length === 0) return null;
  return path.join(p.packDir, files[files.length - 1]);
}

function cmdBuild(args) {
  const policy = loadPolicy();
  const dateStr = resolveDate(args);
  const missDocs = missingDocs(policy.required_docs);
  const rows = policy.ownership_matrix;
  const covered = rows.filter((row) => row.primary_owner !== 'unassigned' || row.secondary_owner !== 'unassigned').length;
  const ownershipCoverage = rows.length > 0 ? Number((covered / rows.length).toFixed(3)) : 0;
  const pack = {
    ok: missDocs.length === 0,
    type: 'maintainer_handoff_pack',
    ts: nowIso(),
    date: dateStr,
    policy: {
      version: policy.version,
      sla_target_minutes: policy.sla_target_minutes
    },
    docs: {
      required: policy.required_docs,
      missing: missDocs
    },
    ownership: {
      rows,
      coverage: ownershipCoverage
    },
    architecture_map: defaultArchitectureMap(),
    critical_commands: policy.critical_commands
  };
  const fp = packPath(policy, dateStr);
  writeJson(fp, pack);
  process.stdout.write(`${JSON.stringify({
    ok: pack.ok,
    type: 'maintainer_handoff_pack_build',
    ts: nowIso(),
    date: dateStr,
    path: path.relative(ROOT, fp),
    missing_docs: missDocs.length,
    ownership_coverage: ownershipCoverage
  })}\n`);
}

function cmdSimulate(args) {
  const policy = loadPolicy();
  const strict = toBool(args.strict, true);
  const dateStr = resolveDate(args);
  const fp = fs.existsSync(packPath(policy, dateStr))
    ? packPath(policy, dateStr)
    : latestPackPath(policy);
  if (!fp) throw new Error('handoff_pack_missing');
  const pack = readJson(fp, null);
  if (!pack) throw new Error('handoff_pack_invalid');
  const startedMs = Date.now();
  const checks = [] as Record<string, any>[];
  for (const cmd of policy.critical_commands) {
    checks.push(runCommand(cmd));
  }
  const durationMinutes = Number(((Date.now() - startedMs) / 60000).toFixed(3));
  const commandsPass = checks.every((c) => c.ok === true);
  const slaPass = durationMinutes <= Number(policy.sla_target_minutes || 45);
  const docsPass = Array.isArray(pack.docs && pack.docs.missing) ? pack.docs.missing.length === 0 : false;
  const ownershipCoverage = Number(pack.ownership && pack.ownership.coverage);
  const ownershipPass = Number.isFinite(ownershipCoverage) && ownershipCoverage >= 0.5;
  const out = {
    ok: commandsPass && slaPass && docsPass && ownershipPass,
    type: 'maintainer_handoff_simulation',
    ts: nowIso(),
    date: dateStr,
    pack_path: path.relative(ROOT, fp),
    gates: {
      commands_pass: commandsPass,
      sla_pass: slaPass,
      docs_pass: docsPass,
      ownership_pass: ownershipPass
    },
    metrics: {
      duration_minutes: durationMinutes,
      sla_target_minutes: Number(policy.sla_target_minutes || 45),
      ownership_coverage: ownershipCoverage
    },
    checks,
    reasons: [
      !commandsPass ? 'critical_commands_failed' : null,
      !slaPass ? 'sla_exceeded' : null,
      !docsPass ? 'required_docs_missing' : null,
      !ownershipPass ? 'ownership_coverage_low' : null
    ].filter(Boolean)
  };
  appendJsonl(policyPaths(policy).receiptsPath, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (strict && out.ok !== true) process.exitCode = 1;
}

function cmdList(args) {
  const policy = loadPolicy();
  const limit = Math.max(1, Math.min(200, Number(args.limit || 20)));
  const rows = readJsonl(policyPaths(policy).receiptsPath).slice(-limit).reverse();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'maintainer_handoff_simulation_list',
    ts: nowIso(),
    count: rows.length,
    rows
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normText(args._[0], 64).toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  if (cmd === 'build') return cmdBuild(args);
  if (cmd === 'simulate') return cmdSimulate(args);
  if (cmd === 'list') return cmdList(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'handoff_pack_failed')
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  parseArgs
};
export {};
