#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'open_platform_release_pack.js');

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

function makeScript(filePath, body) {
  writeText(filePath, body);
  fs.chmodSync(filePath, 0o755);
}

try {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'tmp', 'open-platform-release-pack-'));
  const policyPath = path.join(tmp, 'config', 'open_platform_release_pack_policy.json');
  const stateDir = path.join(tmp, 'state');
  const stubsDir = path.join(tmp, 'stubs');

  const moduleA = path.join(tmp, 'modules', 'compat.ts');
  const moduleB = path.join(tmp, 'modules', 'stream.ts');
  writeText(moduleA, 'export const a = 1;\n');
  writeText(moduleB, 'export const b = 2;\n');

  const benchmarkPath = path.join(stateDir, 'benchmarks', 'latest.json');
  writeJson(benchmarkPath, {
    ts: '2026-03-01T00:00:00.000Z',
    date: '2026-03-01',
    verdict: 'pass',
    simulation: {
      drift_rate: 0.02,
      yield_rate: 0.88
    },
    red_team: {
      critical_fail_cases: 0
    }
  });

  const driftPath = path.join(stateDir, 'drift', 'latest.json');
  writeJson(driftPath, {
    ts: '2026-03-01T00:00:00.000Z',
    checks_effective: {
      drift_rate: {
        value: 0.03
      }
    }
  });

  const compatibilityScript = path.join(stubsDir, 'compatibility_stub.js');
  makeScript(compatibilityScript, `#!/usr/bin/env node
'use strict';
const integrationArg = process.argv.find((row) => String(row).startsWith('--integration=')) || '--integration=unknown';
const integration = integrationArg.slice('--integration='.length);
console.log(JSON.stringify({
  ok: true,
  type: 'compatibility_conformance_run',
  integration,
  badge: {
    schema_version: '1.0',
    generated_at: '2026-03-01T00:00:00.000Z',
    integration,
    pass: true,
    checks: {
      policy_root_preserved: true
    },
    signature: 'sig_' + integration
  }
}));
`);

  const receiptSummaryScript = path.join(stubsDir, 'receipt_summary_stub.js');
  makeScript(receiptSummaryScript, `#!/usr/bin/env node
'use strict';
console.log(JSON.stringify({
  ok: true,
  type: 'receipt_summary_run',
  window_days: 7,
  verification_pass_rate: 0.94,
  total_receipts: 17
}));
`);

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    license: 'Apache-2.0',
    allowlisted_modules: [moduleA, moduleB],
    reference_integrations: ['langgraph', 'autogen'],
    release_checklist: [
      'allowlist_verified',
      'compatibility_badges_signed',
      'metrics_pack_compiled',
      'reproducibility_evidence_attached'
    ],
    scripts: {
      compatibility_script: compatibilityScript,
      receipt_summary_script: receiptSummaryScript,
      receipt_summary_days: 7
    },
    paths: {
      latest_path: path.join(stateDir, 'open_platform_release_pack', 'latest.json'),
      receipts_path: path.join(stateDir, 'open_platform_release_pack', 'receipts.jsonl'),
      state_path: path.join(stateDir, 'open_platform_release_pack', 'state.json'),
      release_pack_path: path.join(stateDir, 'open_platform_release_pack', 'release_pack.json'),
      checklist_path: path.join(stateDir, 'open_platform_release_pack', 'checklist.json'),
      badges_dir: path.join(stateDir, 'open_platform_release_pack', 'badges'),
      benchmark_latest_path: benchmarkPath,
      drift_latest_path: driftPath,
      receipt_summary_latest_path: path.join(stateDir, 'open_platform_release_pack', 'receipt_summary_latest.json')
    }
  });

  let out = run(['build', `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'build should pass');
  assert.strictEqual(out.payload.license, 'Apache-2.0');
  assert.strictEqual(out.payload.checks_total, 4);
  assert.strictEqual(out.payload.checks_passed, 4);

  const releasePack = JSON.parse(fs.readFileSync(path.join(stateDir, 'open_platform_release_pack', 'release_pack.json'), 'utf8'));
  assert.strictEqual(releasePack.license, 'Apache-2.0');
  assert.strictEqual(releasePack.allowlist.length, 2, 'allowlist should include two modules');
  assert.strictEqual(releasePack.compatibility_badges.length, 2, 'badges should include two integrations');
  assert.ok(releasePack.release_pack_signature, 'release pack should include signature');

  out = run(['verify', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'verify should pass');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.release_pack, 'status should include release pack');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('open_platform_release_pack.test.js: OK');
} catch (err) {
  console.error(`open_platform_release_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
