#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'personas', 'orchestration.js');
const SOURCE_ORG = path.join(ROOT, 'personas', 'organization');

function run(args, extraEnv = {}) {
  const out = spawnSync(process.execPath, [SCRIPT, ...args], {
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

function mkOrgDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-orch-policy-'));
  fs.mkdirSync(path.join(tmp, 'meetings'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
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
  for (const f of files) {
    fs.copyFileSync(path.join(SOURCE_ORG, f), path.join(tmp, f));
  }
  return tmp;
}

try {
  let org = mkOrgDir();
  let out = run(['status'], { PROTHEUS_PERSONA_ORG_DIR: org });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('"ok": true'), 'status should pass with valid policies');

  out = run(['meeting', 'General orchestration health check'], {
    PROTHEUS_PERSONA_ORG_DIR: org
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('"ok": true'), 'meeting should succeed with valid policies');

  org = mkOrgDir();
  fs.unlinkSync(path.join(org, 'routing_rules.json'));
  out = run(['meeting', 'General orchestration health check'], { PROTHEUS_PERSONA_ORG_DIR: org });
  assert.notStrictEqual(out.status, 0, 'missing policy should fail closed');
  assert.ok(out.stderr.includes('policy_validation_failed'), 'missing policy should surface validation failure');

  org = mkOrgDir();
  fs.writeFileSync(path.join(org, 'risk_policy.json'), '{bad json', 'utf8');
  out = run(['meeting', 'General orchestration health check'], { PROTHEUS_PERSONA_ORG_DIR: org });
  assert.notStrictEqual(out.status, 0, 'malformed policy should fail closed');
  assert.ok(out.stderr.includes('policy_validation_failed'), 'malformed policy should surface validation failure');

  org = mkOrgDir();
  const noEligibleRouting = {
    version: '1.0.0',
    default_domain: 'general',
    core_personas: ['nonexistent_persona'],
    topic_routes: [
      { domain: 'general', match_any: ['general'], specialists: ['nobody_here'] }
    ]
  };
  fs.writeFileSync(path.join(org, 'routing_rules.json'), `${JSON.stringify(noEligibleRouting, null, 2)}\n`, 'utf8');
  out = run(['meeting', 'General orchestration health check'], { PROTHEUS_PERSONA_ORG_DIR: org });
  assert.notStrictEqual(out.status, 0, 'no eligible personas should fail closed');
  assert.ok(out.stderr.includes('no_eligible_personas'), 'should report no eligible personas');

  org = mkOrgDir();
  const badArbitration = JSON.parse(fs.readFileSync(path.join(org, 'arbitration_rules.json'), 'utf8'));
  badArbitration.tie_break_priority = ['vikram_menon', 'vikram_menon'];
  fs.writeFileSync(path.join(org, 'arbitration_rules.json'), `${JSON.stringify(badArbitration, null, 2)}\n`, 'utf8');
  out = run(['meeting', 'General orchestration health check'], { PROTHEUS_PERSONA_ORG_DIR: org });
  assert.notStrictEqual(out.status, 0, 'conflicting arbitration rules should fail closed');
  assert.ok(out.stderr.includes('arbitration_rules_conflict'), 'should report arbitration conflict');

  org = mkOrgDir();
  out = run(['meeting', 'General orchestration health check'], {
    PROTHEUS_PERSONA_ORG_DIR: org,
    PERSONA_ORCH_FORCE_COVENANT_VIOLATION: '1'
  });
  assert.notStrictEqual(out.status, 0, 'covenant violation should fail closed');
  assert.ok(out.stderr.includes('sovereignty_gate_blocked'), 'should report sovereignty gate failure');

  console.log('personas_orchestration_policies.test.js: OK');
} catch (err) {
  console.error(`personas_orchestration_policies.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

