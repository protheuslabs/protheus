#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'public_docs_developer_experience_overhaul.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
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

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-dx-'));
  const policyPath = path.join(tmp, 'config', 'public_docs_developer_experience_overhaul_policy.json');
  const flagsPath = path.join(tmp, 'config', 'feature_flags.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'public_docs_developer_experience_overhaul', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'public_docs_developer_experience_overhaul', 'history.jsonl');
  const snapshotRoot = path.join(tmp, 'state', 'ops', 'public_docs_developer_experience_overhaul', 'snapshots');

  const onboardingScript = path.join(tmp, 'systems', 'ops', 'first_run_onboarding_wizard.js');
  writeText(onboardingScript, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,type:'first_run_onboarding_wizard_status'}));\n");

  writeText(path.join(tmp, 'README.md'), [
    'See ARCHITECTURE.md',
    'See client/docs/DEVELOPER_LANE_QUICKSTART.md',
    'See client/docs/HELP.md'
  ].join('\n'));
  writeText(path.join(tmp, 'ARCHITECTURE.md'), 'Hub: client/docs/README.md\n');
  writeText(path.join(tmp, 'CONTRIBUTING.md'), 'Use client/docs/DEVELOPER_LANE_QUICKSTART.md\n');
  writeText(path.join(tmp, 'docs', 'README.md'), 'Guide: DEVELOPER_LANE_QUICKSTART.md\n');
  writeText(path.join(tmp, 'docs', 'HELP.md'), 'help\n');
  writeText(path.join(tmp, 'docs', 'ONBOARDING_PLAYBOOK.md'), 'onboarding\n');
  writeText(path.join(tmp, 'docs', 'DEVELOPER_LANE_QUICKSTART.md'), 'under 10 minutes\nfirst custom lane\nrollback\n');

  writeJson(flagsPath, {
    phase1_docs_dx_overhaul: false
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    feature_flag_name: 'phase1_docs_dx_overhaul',
    feature_flag_default: false,
    required_docs: [
      'README.md',
      'ARCHITECTURE.md',
      'CONTRIBUTING.md',
      'client/docs/README.md',
      'client/docs/HELP.md',
      'client/docs/DEVELOPER_LANE_QUICKSTART.md',
      'client/docs/ONBOARDING_PLAYBOOK.md'
    ],
    required_links: [
      { source: 'README.md', target: 'ARCHITECTURE.md' },
      { source: 'README.md', target: 'client/docs/DEVELOPER_LANE_QUICKSTART.md' },
      { source: 'README.md', target: 'client/docs/HELP.md' },
      { source: 'ARCHITECTURE.md', target: 'client/docs/README.md' },
      { source: 'CONTRIBUTING.md', target: 'client/docs/DEVELOPER_LANE_QUICKSTART.md' },
      { source: 'client/docs/README.md', target: 'DEVELOPER_LANE_QUICKSTART.md' }
    ],
    quickstart_requirements: {
      path: path.join(tmp, 'docs', 'DEVELOPER_LANE_QUICKSTART.md'),
      required_phrases: ['under 10 minutes', 'first custom lane', 'rollback']
    },
    onboarding_check: {
      script: onboardingScript,
      args: ['status']
    },
    paths: {
      feature_flags_path: flagsPath,
      latest_path: latestPath,
      history_path: historyPath,
      snapshot_root: snapshotRoot
    }
  });

  let out = run(['snapshot', '--label=pre_release', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'snapshot should succeed');
  assert.ok(Array.isArray(out.payload.copied_docs) && out.payload.copied_docs.length >= 5, 'snapshot should copy docs');

  out = run(['verify', '--strict=1', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'verify should pass with complete docs contract');

  out = run(['enable', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.enabled, true, 'enable should set feature flag');

  out = run(['disable', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.enabled, false, 'disable should clear feature flag');

  out = run(['status', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should expose latest verification payload');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('public_docs_developer_experience_overhaul.test.js: OK');
} catch (err) {
  console.error(`public_docs_developer_experience_overhaul.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
