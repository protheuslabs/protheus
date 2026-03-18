#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const THIS_FILE = __filename;
const THIS_DIR = __dirname;
const ROOT = path.resolve(THIS_DIR, '..', '..', '..', '..');

const INVENTORY_CONFIG_PATH = path.resolve(ROOT, 'client/runtime/config/security_layer_inventory.json');
const GUARD_REGISTRY_PATH = path.resolve(ROOT, 'client/runtime/config/guard_check_registry.json');
const STATE_DIR = path.resolve(ROOT, 'client/runtime/local/state/ops/security_layer_inventory_gate');
const LATEST_PATH = path.resolve(STATE_DIR, 'latest.json');
const HISTORY_PATH = path.resolve(STATE_DIR, 'history.jsonl');
const DOC_PATH = path.resolve(ROOT, 'docs/client/security/SECURITY_LAYER_INVENTORY.md');
const REPORT_PATH = path.resolve(ROOT, 'local/workspace/reports/SECURITY_LAYER_INVENTORY_CURRENT.md');
const OPS_RUNNER = path.resolve(ROOT, 'client/runtime/systems/ops/run_protheus_ops.js');
const PROTHEUS_DEBUG_BIN = path.resolve(
  ROOT,
  'target',
  'debug',
  process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops'
);
const PROTHEUS_RELEASE_BIN = path.resolve(
  ROOT,
  'target',
  'release',
  process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops'
);

function parseFlags(args) {
  let mode = 'run';
  let strict = false;
  let write = false;
  for (const token of args) {
    if (!token.startsWith('--') && mode === 'run') {
      mode = token;
      continue;
    }
    if (token === '--strict' || token === '--strict=1' || token === '--strict=true') {
      strict = true;
      continue;
    }
    if (token === '--write' || token === '--write=1' || token === '--write=true') {
      write = true;
      continue;
    }
  }
  return { mode, strict, write };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function exists(relPath) {
  return fs.existsSync(path.resolve(ROOT, relPath));
}

function getGuardCheckIndex() {
  const registry = readJson(GUARD_REGISTRY_PATH);
  const checks = Array.isArray(registry?.merge_guard?.checks) ? registry.merge_guard.checks : [];
  const index = new Map();
  for (const check of checks) {
    const id = String(check?.id || '').trim();
    if (id) index.set(id, check);
  }
  return index;
}

function runRuntimeCheck(check) {
  const plane = String(check?.plane || 'security-plane').trim();
  const command = String(check?.command || '').trim();
  const args = Array.isArray(check?.args)
    ? check.args.map((v) => String(v))
    : ['status', '--strict=1'];

  const bin = fs.existsSync(PROTHEUS_DEBUG_BIN)
    ? PROTHEUS_DEBUG_BIN
    : fs.existsSync(PROTHEUS_RELEASE_BIN)
      ? PROTHEUS_RELEASE_BIN
      : null;

  const proc = bin
    ? spawnSync(bin, [plane, command, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    : spawnSync(process.execPath, [OPS_RUNNER, plane, command, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });

  const status = typeof proc.status === 'number' ? proc.status : 1;
  const stdout = typeof proc.stdout === 'string' ? proc.stdout.trim() : '';
  const stderr = typeof proc.stderr === 'string' ? proc.stderr.trim() : '';
  let payload = null;
  try {
    payload = stdout ? JSON.parse(stdout) : null;
  } catch {
    payload = null;
  }
  const reachable =
    !!payload &&
    typeof payload === 'object' &&
    (payload.authority === 'rust_security_plane' || payload.lane === 'state_kernel');
  const ok = status === 0 || reachable;
  return {
    plane,
    command,
    args,
    ok,
    reachable,
    policy_fail_closed: reachable && status !== 0,
    status,
    stderr: stderr ? stderr.slice(0, 400) : null,
    output_preview: stdout ? stdout.slice(0, 400) : null,
  };
}

function renderMarkdown(receipt) {
  const rows = receipt.layers.map((layer) => {
    const runtimeSummary = (layer.runtime_checks || [])
      .map((c) => `${c.plane} ${c.command} ${c.ok ? 'ok' : 'fail'}`)
      .join('<br>');
    return [
      `\`${layer.id}\`<br>${layer.title}`,
      `missing paths: ${layer.missing_paths.length}<br>missing guard ids: ${layer.missing_guard_checks.length}`,
      runtimeSummary || 'n/a',
    ];
  });

  const table = [
    '| Layer | File/Guard Coverage | Runtime Checks |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`),
  ].join('\n');

  return [
    '# Security Layer Inventory',
    '',
    `Generated: ${receipt.ts}`,
    '',
    'This inventory maps each security layer to enforceable implementation paths, policy contracts, guard-check references, and live runtime checks.',
    '',
    table,
    '',
    '## Verification Summary',
    '',
    `- Layers checked: ${receipt.summary.layers_checked}`,
    `- Missing paths: ${receipt.summary.missing_paths}`,
    `- Missing guard checks: ${receipt.summary.missing_guard_checks}`,
    `- Runtime check failures: ${receipt.summary.runtime_check_failures}`,
    `- Contract status: ${receipt.ok ? 'PASS' : 'FAIL'}`,
    `- Receipt hash: \`${receipt.receipt_hash}\``,
    '',
  ].join('\n');
}

function run(argv = []) {
  const { mode, strict, write } = parseFlags(Array.isArray(argv) ? argv : []);

  if (mode === 'status') {
    const latest = fs.existsSync(LATEST_PATH)
      ? readJson(LATEST_PATH)
      : {
          ok: false,
          type: 'security_layer_inventory_gate',
          error: 'latest_receipt_missing',
          latest_path: path.relative(ROOT, LATEST_PATH),
        };
    if (strict && !latest.ok) process.exit(2);
    return latest;
  }

  const config = readJson(INVENTORY_CONFIG_PATH);
  const guardIndex = getGuardCheckIndex();

  const runtimeCache = new Map();
  const layers = (Array.isArray(config.layers) ? config.layers : []).map((layer) => {
    const implementationPaths = Array.isArray(layer.implementation_paths) ? layer.implementation_paths : [];
    const policyPaths = Array.isArray(layer.policy_paths) ? layer.policy_paths : [];
    const testPaths = Array.isArray(layer.test_paths) ? layer.test_paths : [];
    const guardIds = Array.isArray(layer.guard_check_ids) ? layer.guard_check_ids : [];
    const runtimeChecks = Array.isArray(layer.runtime_checks) ? layer.runtime_checks : [];

    const missingPaths = [...implementationPaths, ...policyPaths, ...testPaths]
      .filter((p) => !exists(p))
      .map((p) => ({ path: p }));

    const missingGuardChecks = guardIds
      .filter((id) => !guardIndex.has(String(id)))
      .map((id) => ({ id }));

    const runtimeResults = runtimeChecks.map((check) => {
      const key = sha256(check);
      if (!runtimeCache.has(key)) {
        runtimeCache.set(key, runRuntimeCheck(check));
      }
      return runtimeCache.get(key);
    });

    return {
      id: layer.id,
      title: layer.title,
      implementation_paths: implementationPaths,
      policy_paths: policyPaths,
      test_paths: testPaths,
      guard_check_ids: guardIds,
      runtime_checks: runtimeResults,
      missing_paths: missingPaths,
      missing_guard_checks: missingGuardChecks,
    };
  });

  const summary = {
    layers_checked: layers.length,
    missing_paths: layers.reduce((acc, layer) => acc + layer.missing_paths.length, 0),
    missing_guard_checks: layers.reduce((acc, layer) => acc + layer.missing_guard_checks.length, 0),
    runtime_check_failures: layers.reduce(
      (acc, layer) => acc + layer.runtime_checks.filter((c) => !c.ok).length,
      0
    ),
  };
  const ok =
    summary.missing_paths === 0 &&
    summary.missing_guard_checks === 0 &&
    summary.runtime_check_failures === 0;

  const receipt = {
    ok,
    type: 'security_layer_inventory_gate',
    ts: new Date().toISOString(),
    config_path: path.relative(ROOT, INVENTORY_CONFIG_PATH),
    guard_registry_path: path.relative(ROOT, GUARD_REGISTRY_PATH),
    latest_path: path.relative(ROOT, LATEST_PATH),
    doc_path: path.relative(ROOT, DOC_PATH),
    report_path: path.relative(ROOT, REPORT_PATH),
    summary,
    layers,
  };
  const receiptWithHash = { ...receipt, receipt_hash: sha256(receipt) };

  if (write) {
    fs.mkdirSync(path.dirname(LATEST_PATH), { recursive: true });
    fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(LATEST_PATH, `${JSON.stringify(receiptWithHash, null, 2)}\n`);
    fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(receiptWithHash)}\n`);
    const md = renderMarkdown(receiptWithHash);
    fs.writeFileSync(DOC_PATH, md);
    fs.writeFileSync(REPORT_PATH, md);
  }

  if (strict && !receiptWithHash.ok) process.exit(2);
  return receiptWithHash;
}

module.exports = { run };

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
