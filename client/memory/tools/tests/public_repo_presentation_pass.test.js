#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'public_repo_presentation_pass.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-presentation-'));
  const policyPath = path.join(tmp, 'config', 'public_repo_presentation_pass_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'public_repo_presentation_pass', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'public_repo_presentation_pass', 'history.jsonl');
  const bundlePath = path.join(tmp, 'state', 'ops', 'public_repo_presentation_pass', 'verification_bundle.json');

  const rootContract = path.join(tmp, 'systems', 'ops', 'root_surface_contract.js');
  const docsContract = path.join(tmp, 'systems', 'ops', 'docs_surface_contract.js');

  writeText(rootContract, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,type:'root_surface_contract'}));\n");
  writeText(docsContract, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,type:'docs_surface_contract'}));\n");

  writeText(path.join(tmp, 'README.md'), 'client/docs/README.md\nclient/docs/PUBLIC_OPERATOR_PROFILE.md\nclient/docs/ONBOARDING_PLAYBOOK.md\n');
  writeText(path.join(tmp, '.gitattributes'), '*.ts linguist-language=TypeScript\n');
  writeText(path.join(tmp, 'docs', 'PUBLIC_REPO_PRESENTATION_CHECKLIST.md'), 'commit --amend\npush --force\nreset --hard\n');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    checklist_path: path.join(tmp, 'docs', 'PUBLIC_REPO_PRESENTATION_CHECKLIST.md'),
    gitattributes_path: path.join(tmp, '.gitattributes'),
    root_contract_script: rootContract,
    docs_contract_script: docsContract,
    readme_path: path.join(tmp, 'README.md'),
    readme_required_links: [
      'client/docs/README.md',
      'client/docs/PUBLIC_OPERATOR_PROFILE.md',
      'client/docs/ONBOARDING_PLAYBOOK.md'
    ],
    forbidden_history_rewrite_tokens: ['commit --amend', 'push --force', 'reset --hard'],
    paths: {
      latest_path: latestPath,
      history_path: historyPath,
      verification_bundle_path: bundlePath
    }
  });

  let out = run(['verify', '--strict=1', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'verify should pass when checklist and contracts pass');
  assert.ok(fs.existsSync(bundlePath), 'verification bundle should be written');

  out = run(['status', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should include latest payload');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('public_repo_presentation_pass.test.js: OK');
} catch (err) {
  console.error(`public_repo_presentation_pass.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
