#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'platform_path_contract_pack.js');

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
  const lines = text.split('\n').map((row) => row.trim()).filter(Boolean);
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

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-pack-'));
  const policyPath = path.join(tmp, 'config', 'platform_path_contract_policy.json');
  const stateDir = path.join(tmp, 'state');
  const platformDir = path.join(tmp, 'platform');

  const releasePackPath = path.join(stateDir, 'open_platform_release_pack', 'release_pack.json');
  const checklistPath = path.join(stateDir, 'open_platform_release_pack', 'checklist_evidence.json');
  const latestPath = path.join(stateDir, 'open_platform_release_pack', 'latest.json');
  writeJson(releasePackPath, {
    schema_id: 'open_platform_release_pack',
    schema_version: '1.0',
    license: 'Apache-2.0',
    compatibility_badges: [
      {
        integration: 'langgraph',
        ok: true,
        signed: true,
        badge_path: 'state/ops/open_platform_release_pack/badges/langgraph.json'
      },
      {
        integration: 'autogen',
        ok: true,
        signed: true,
        badge_path: 'state/ops/open_platform_release_pack/badges/autogen.json'
      }
    ]
  });
  writeJson(checklistPath, { ok: true, checks_total: 4, checks_passed: 4 });
  writeJson(latestPath, { ok: true, type: 'open_platform_release_pack_build' });

  writeText(path.join(platformDir, 'export_cli.js'), '#!/usr/bin/env node\nconsole.log("shim");\n');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    source: {
      release_pack_path: releasePackPath,
      checklist_path: checklistPath,
      latest_path: latestPath
    },
    output: {
      readme_path: path.join(platformDir, 'README.md'),
      license_carveout_path: path.join(platformDir, 'LICENSE_APACHE_2_0_CARVEOUT.md'),
      badges_index_path: path.join(platformDir, 'compatibility_badges.json'),
      export_manifest_path: path.join(platformDir, 'export_manifest.json'),
      export_cli_path: path.join(platformDir, 'export_cli.js'),
      latest_path: path.join(stateDir, 'platform_path_contract_pack', 'latest.json'),
      receipts_path: path.join(stateDir, 'platform_path_contract_pack', 'receipts.jsonl'),
      state_path: path.join(stateDir, 'platform_path_contract_pack', 'state.json')
    }
  });

  let out = run(['sync', `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'sync should pass');
  assert.strictEqual(out.payload.checks_total, 7);
  assert.strictEqual(out.payload.checks_passed, 7);

  const readme = fs.readFileSync(path.join(platformDir, 'README.md'), 'utf8');
  assert.ok(readme.includes('Canonical implementation remains in `client/systems/ops/open_platform_release_pack.ts`'));
  assert.ok(readme.includes('release pack:'), 'README should include source references');

  const badges = JSON.parse(fs.readFileSync(path.join(platformDir, 'compatibility_badges.json'), 'utf8'));
  assert.strictEqual(Array.isArray(badges.badges), true);
  assert.strictEqual(badges.badges.length, 2);

  const manifest = JSON.parse(fs.readFileSync(path.join(platformDir, 'export_manifest.json'), 'utf8'));
  assert.strictEqual(manifest.schema_id, 'platform_export_manifest');
  assert.strictEqual(!!manifest.signature, true);

  out = run(['verify', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'verify should pass');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.export_manifest, 'status should include export manifest');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('platform_path_contract_pack.test.js: OK');
} catch (err) {
  console.error(`platform_path_contract_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
