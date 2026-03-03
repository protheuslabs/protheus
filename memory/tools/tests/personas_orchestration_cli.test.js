#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');
const SOURCE_ORG = path.join(ROOT, 'personas', 'organization');

function run(args, extraEnv = {}) {
  const out = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || '')
  };
}

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function copyOrg() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-orch-cli-'));
  const org = path.join(tmp, 'organization');
  fs.mkdirSync(path.join(org, 'meetings'), { recursive: true });
  fs.mkdirSync(path.join(org, 'projects'), { recursive: true });
  const files = [
    'arbitration_rules.json',
    'routing_rules.json',
    'risk_policy.json',
    'telemetry_policy.json',
    'retention_policy.json',
    'arbitration_rules.schema.json',
    'routing_rules.schema.json',
    'meeting_artifact.schema.json',
    'project_artifact.schema.json'
  ];
  for (const fileName of files) {
    fs.copyFileSync(path.join(SOURCE_ORG, fileName), path.join(org, fileName));
  }
  return org;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

try {
  const orgDir = copyOrg();
  const env = { PROTHEUS_PERSONA_ORG_DIR: orgDir };

  let out = run(['orchestrate', 'status'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status should pass policy validation');

  out = run(['orchestrate', 'meeting', 'Prioritize security migration sequencing', '--approval-note=operator-reviewed'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'meeting should succeed');
  assert.ok(payload.artifact && payload.artifact.type === 'meeting_result', 'meeting should emit meeting_result artifact');
  assert.strictEqual(typeof payload.artifact.shadow_mode_active, 'boolean', 'meeting artifact should include shadow mode status');
  assert.ok(String(payload.markdown_summary || '').includes('# Orchestration Meeting:'), 'meeting should emit markdown summary');

  const meetingLedger = readJsonl(path.join(orgDir, 'meetings', 'ledger.jsonl'));
  assert.ok(meetingLedger.length >= 3, 'meeting ledger should contain selection/arbitration/result rows');
  assert.ok(meetingLedger.some((row) => row.type === 'selection_receipt'), 'meeting ledger should include selection_receipt');
  assert.ok(meetingLedger.some((row) => row.type === 'arbitration_receipt'), 'meeting ledger should include arbitration_receipt');
  assert.ok(meetingLedger.some((row) => row.type === 'meeting_result'), 'meeting ledger should include meeting_result');
  assert.ok(meetingLedger.every((row) => typeof row.hash === 'string' && row.hash.length > 10), 'every row should be hash-chained');

  out = run(['orchestrate', 'project', 'foundation_lock', 'Finish memory and security parity', '--approval-note=operator-reviewed'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'project create should succeed');
  assert.ok(payload.artifact && payload.artifact.type === 'project_state', 'project create should emit project_state artifact');
  assert.strictEqual(payload.artifact.status, 'proposed', 'new project should start in proposed state');

  const projectId = String(payload.artifact.project_id || '');
  assert.ok(projectId.startsWith('prj_'), 'project should emit deterministic project id');

  out = run(['orchestrate', 'project', `--id=${projectId}`, '--transition=active', '--approval-note=operator-reviewed'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'project transition should succeed');
  assert.ok(payload.artifact && payload.artifact.status === 'active', 'project transition should reach active');

  const projectLedger = readJsonl(path.join(orgDir, 'projects', 'ledger.jsonl'));
  assert.ok(projectLedger.some((row) => row.type === 'selection_receipt'), 'project ledger should include selection receipt');
  assert.ok(projectLedger.some((row) => row.type === 'arbitration_receipt'), 'project ledger should include arbitration receipt');
  assert.ok(projectLedger.some((row) => row.type === 'project_state' && row.status === 'active'), 'project ledger should include active state');
  assert.ok(projectLedger.every((row) => typeof row.hash === 'string' && row.hash.length > 10), 'project rows should be hash-chained');

  out = run(['orchestrate', 'meeting', 'Security policy migration validation'], env);
  assert.notStrictEqual(out.status, 0, 'high-risk meeting without approval should fail');
  assert.ok(out.stderr.includes('approval_required_for_risk_tier'), 'failure path should enforce risk approval gate');

  const telemetry = readJsonl(path.join(orgDir, 'telemetry.jsonl'));
  assert.ok(telemetry.length >= 2, 'telemetry rows should be written for meeting + project commands');

  console.log('personas_orchestration_cli.test.js: OK');
} catch (err) {
  console.error(`personas_orchestration_cli.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
