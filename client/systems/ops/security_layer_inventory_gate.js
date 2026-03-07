#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_INVENTORY_PATH = path.join(ROOT, 'config', 'security_layer_inventory.json');
const DEFAULT_GUARD_REGISTRY_PATH = path.join(ROOT, 'config', 'guard_check_registry.json');
const DEFAULT_DOC_PATH = path.join(ROOT, 'docs', 'security', 'SECURITY_LAYER_INVENTORY.md');
const DEFAULT_STATE_PATH = path.join(
  ROOT,
  'state',
  'ops',
  'security_layer_inventory_gate',
  'latest.json'
);

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
    if (!raw.startsWith('--')) continue;
    const [key, value = '1'] = raw.slice(2).split('=');
    if (key === 'strict') args.strict = value === '1' || value === 'true';
    if (key === 'write') args.write = value === '1' || value === 'true';
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

function pathExists(repoPath) {
  return fs.existsSync(path.join(ROOT, repoPath));
}

function toDigest(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function renderLinks(paths) {
  return paths.map((p) => `\`${p}\``).join('<br>');
}

function renderChecks(checks, checkMap) {
  return checks
    .map((id) => {
      const entry = checkMap.get(id);
      if (!entry) return `\`${id}\` (missing)`;
      const command = [entry.command, ...(entry.args || [])].join(' ');
      return `\`${id}\`: \`${command}\``;
    })
    .join('<br>');
}

function buildMarkdown(report, checkMap) {
  const lines = [];
  lines.push('# Security Layer Inventory');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push('');
  lines.push(
    'This inventory maps each security layer to enforceable implementation paths, policy contracts, runtime guard checks, and test evidence.'
  );
  lines.push('');
  lines.push('| Layer | Implementation | Policy | Guard Checks | Test Evidence |');
  lines.push('|---|---|---|---|---|');
  for (const layer of report.layers) {
    lines.push(
      `| \`${layer.id}\`<br>${layer.title} | ${renderLinks(layer.implementation_paths)} | ${renderLinks(layer.policy_paths)} | ${renderChecks(layer.guard_check_ids, checkMap)} | ${renderLinks(layer.test_paths)} |`
    );
  }
  lines.push('');
  lines.push('## Verification Summary');
  lines.push('');
  lines.push(`- Layers checked: ${report.summary.layer_count}`);
  lines.push(`- Missing paths: ${report.summary.missing_paths}`);
  lines.push(`- Missing guard checks: ${report.summary.missing_guard_checks}`);
  lines.push(`- Contract status: ${report.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`- Receipt hash: \`${report.receipt_hash}\``);
  lines.push('');
  return lines.join('\n');
}

function evaluateLayer(layer, guardChecks) {
  const missing = [];
  const allPaths = [
    ...(layer.implementation_paths || []),
    ...(layer.policy_paths || []),
    ...(layer.test_paths || [])
  ];
  for (const repoPath of allPaths) {
    if (!pathExists(repoPath)) {
      missing.push({ kind: 'path', value: repoPath });
    }
  }

  const missingChecks = [];
  for (const id of layer.guard_check_ids || []) {
    if (!guardChecks.has(id)) {
      missingChecks.push({ kind: 'guard_check', value: id });
    }
  }

  return {
    ...layer,
    missing: missing
      .concat(missingChecks)
      .map((entry) => ({ kind: entry.kind, value: entry.value }))
  };
}

function run(args) {
  const inventoryPath =
    process.env.SECURITY_LAYER_INVENTORY_PATH || DEFAULT_INVENTORY_PATH;
  const guardRegistryPath =
    process.env.GUARD_CHECK_REGISTRY_PATH || DEFAULT_GUARD_REGISTRY_PATH;
  const docPath = process.env.SECURITY_LAYER_INVENTORY_DOC_PATH || DEFAULT_DOC_PATH;
  const statePath = process.env.SECURITY_LAYER_INVENTORY_STATE_PATH || DEFAULT_STATE_PATH;

  const inventory = readJson(inventoryPath);
  const guardRegistry = readJson(guardRegistryPath);
  const checks = (((guardRegistry || {}).merge_guard || {}).checks || []).map((check) => [
    check.id,
    check
  ]);
  const checkMap = new Map(checks);

  const layers = (inventory.layers || []).map((layer) => evaluateLayer(layer, checkMap));
  const missingRefs = layers.flatMap((layer) =>
    layer.missing.map((missing) => ({
      layer_id: layer.id,
      ...missing
    }))
  );

  const report = {
    schema_id: 'security_layer_inventory_gate_result',
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    inventory_path: rel(inventoryPath),
    guard_registry_path: rel(guardRegistryPath),
    ok: missingRefs.length === 0,
    summary: {
      layer_count: layers.length,
      missing_paths: missingRefs.filter((item) => item.kind === 'path').length,
      missing_guard_checks: missingRefs.filter((item) => item.kind === 'guard_check').length
    },
    layers,
    missing_references: missingRefs
  };
  report.receipt_hash = toDigest(
    JSON.stringify({
      schema_id: report.schema_id,
      schema_version: report.schema_version,
      generated_at: report.generated_at,
      ok: report.ok,
      summary: report.summary,
      missing_references: report.missing_references
    })
  );

  if (args.write) {
    ensureDir(docPath);
    fs.writeFileSync(docPath, buildMarkdown(report, checkMap));
  }
  ensureDir(statePath);
  fs.writeFileSync(statePath, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.strict && !report.ok) {
    process.exit(1);
  }
}

function status() {
  const statePath = process.env.SECURITY_LAYER_INVENTORY_STATE_PATH || DEFAULT_STATE_PATH;
  if (!fs.existsSync(statePath)) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_id: 'security_layer_inventory_gate_result',
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
    `unknown_command:${args.command}\nusage: node client/systems/ops/security_layer_inventory_gate.js [run|status] [--strict=1] [--write=1]\n`
  );
  process.exit(1);
}

main();
