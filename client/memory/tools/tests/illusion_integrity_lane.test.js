#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'self_audit', 'illusion_integrity_lane.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function run(args, env) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return {
    status: Number.isFinite(res.status) ? res.status : 1,
    payload,
    stderr: String(res.stderr || '')
  };
}

function seedWorkspace(rootDir) {
  const files = [
    'README.md',
    'CHANGELOG.md',
    'client/docs/ONBOARDING_PLAYBOOK.md',
    'client/docs/UI_SURFACE_MATURITY_MATRIX.md',
    'client/docs/HISTORY_CLEANLINESS.md',
    'client/docs/CLAIM_EVIDENCE_POLICY.md',
    'client/docs/PUBLIC_COLLABORATION_TRIAGE.md',
    '.github/ISSUE_TEMPLATE/bug_report.md',
    '.github/ISSUE_TEMPLATE/feature_request.md',
    '.github/ISSUE_TEMPLATE/security_report.md',
    'client/systems/research/research_organ.ts',
    'client/systems/forge/forge_organ.ts',
    'client/systems/workflow/orchestron_controller.ts'
  ];
  for (const rel of files) {
    const abs = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `# ${path.basename(rel)}\n`, 'utf8');
  }
}

try {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'illusion-audit-'));
  const workspace = path.join(tmpRoot, 'workspace');
  const stateDir = path.join(tmpRoot, 'state');
  fs.mkdirSync(workspace, { recursive: true });
  seedWorkspace(workspace);

  const backlogCheckScript = path.join(tmpRoot, 'backlog_check.js');
  fs.writeFileSync(
    backlogCheckScript,
    "process.stdout.write(JSON.stringify({ok:true,drift_count:0})+'\\n');",
    'utf8'
  );

  const mockRustPath = path.join(tmpRoot, 'mock_rust.json');
  writeJson(mockRustPath, {
    ok: true,
    findings: [
      {
        id: 'mock_rust_signal',
        category: 'engine_health',
        title: 'Mock rust signal',
        severity: 'low',
        summary: 'mock',
        evidence: ['mock=true'],
        safe_autofix: false
      }
    ],
    metrics: {},
    summary: {
      finding_count: 1,
      high_count: 0,
      medium_count: 0,
      low_count: 1,
      average_score: 35,
      max_score: 35
    }
  });

  const policyPath = path.join(tmpRoot, 'policy.json');
  writeJson(policyPath, {
    enabled: true,
    strict_default: false,
    signing_secret: 'test_secret',
    paths: {
      state_path: path.join(stateDir, 'state.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl'),
      history_path: path.join(stateDir, 'history.jsonl'),
      reports_dir: path.join(stateDir, 'reports'),
      patches_dir: path.join(stateDir, 'patches')
    },
    engine: {
      mode: 'ts_only',
      allow_ts_fallback: true
    },
    backlog_check: {
      script: backlogCheckScript
    },
    autofix: {
      allow_apply: true,
      require_human_consent: true,
      required_approval_min_len: 8,
      required_token_prefix: 'consent_'
    },
    checks: {
      suspicious_root_names: []
    },
    thresholds: {
      fail_score: 90,
      max_high_findings_before_fail: 10,
      min_ui_score: 50,
      min_scientific_score: 50
    }
  });

  let out = run([
    'run',
    '--trigger=manual',
    `--policy=${policyPath}`,
    `--root=${workspace}`,
    `--mock-rust-file=${mockRustPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.payload && out.payload.ok === true, 'expected successful audit');
  assert.ok(typeof out.payload.signature === 'string' && out.payload.signature.length > 10, 'signature missing');

  out = run([
    'run',
    '--trigger=manual',
    '--apply=1',
    `--policy=${policyPath}`,
    `--root=${workspace}`,
    `--mock-rust-file=${mockRustPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.payload && out.payload.autofix, 'expected autofix payload');
  assert.strictEqual(out.payload.autofix.consent_satisfied, false, 'consent should be unsatisfied');
  assert.ok(Array.isArray(out.payload.autofix.skipped) && out.payload.autofix.skipped.length >= 1, 'expected skipped autofix reason');

  // Force strict failure by removing UI artifacts.
  fs.rmSync(path.join(workspace, 'docs', 'UI_SURFACE_MATURITY_MATRIX.md'), { force: true });
  fs.rmSync(path.join(workspace, 'docs', 'ONBOARDING_PLAYBOOK.md'), { force: true });
  writeJson(policyPath, {
    ...readJsonSafe(policyPath),
    thresholds: {
      fail_score: 50,
      max_high_findings_before_fail: 0,
      min_ui_score: 90,
      min_scientific_score: 50
    }
  });
  out = run([
    'run',
    '--trigger=manual',
    '--strict=1',
    `--policy=${policyPath}`,
    `--root=${workspace}`,
    `--mock-rust-file=${mockRustPath}`
  ]);
  assert.strictEqual(out.status, 2, 'strict run should fail');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('illusion_integrity_lane.test.js: OK');
} catch (err) {
  console.error(`illusion_integrity_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
