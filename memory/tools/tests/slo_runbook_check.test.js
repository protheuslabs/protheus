#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'slo_runbook_check.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeText(filePath, body) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, body, 'utf8');
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  const out = String(r.stdout || '').trim();
  let payload = null;
  if (out) {
    const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        payload = JSON.parse(lines[i]);
        break;
      } catch {}
    }
  }
  return { status: r.status, stdout: out, stderr: String(r.stderr || '').trim(), payload };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slo-runbook-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  const runbookPath = path.join(tmp, 'runbook.md');
  const healthStub = path.join(tmp, 'health_stub.js');

  writeText(runbookPath, [
    '# Runbook',
    '## Incident 3: Sensory Starvation',
    '## Incident 4: Autonomy Stall',
    '## Incident 5: Queue Backlog / Churn',
    '## Incident 6: Dream Degradation',
    '## Incident 7: Budget Pressure / Autopause'
  ].join('\n'));

  writeText(healthStub, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  ok: true,
  slo: {
    checks: {
      proposal_starvation: { status: 'warn' },
      queue_backlog: { status: 'ok' },
      dark_eyes: { status: 'ok' },
      loop_stall: { status: 'ok' },
      drift: { status: 'ok' },
      budget_guard: { status: 'ok' },
      dream_degradation: { status: 'ok' }
    }
  }
}) + '\\n');
`);

  writeText(policyPath, JSON.stringify({
    version: '1.0',
    required_checks: [
      'proposal_starvation',
      'queue_backlog',
      'dark_eyes',
      'loop_stall',
      'drift',
      'budget_pressure',
      'dream_degradation'
    ],
    runbook: {
      path: path.relative(ROOT, runbookPath)
    },
    mappings: {
      proposal_starvation: { section: 'Incident 3: Sensory Starvation' },
      queue_backlog: { section: 'Incident 5: Queue Backlog / Churn' },
      dark_eyes: { section: 'Incident 3: Sensory Starvation' },
      loop_stall: { section: 'Incident 4: Autonomy Stall' },
      drift: { section: 'Incident 4: Autonomy Stall' },
      budget_pressure: { section: 'Incident 7: Budget Pressure / Autopause', health_check: 'budget_guard' },
      dream_degradation: { section: 'Incident 6: Dream Degradation' }
    }
  }, null, 2));

  const baseEnv = {
    SLO_RUNBOOK_POLICY_PATH: policyPath,
    SLO_RUNBOOK_HEALTH_SCRIPT: healthStub
  };

  try {
    let r = run(['run', '2026-02-23'], baseEnv);
    assert.strictEqual(r.status, 0, `expected success run: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'success payload should be ok');
    assert.deepStrictEqual(r.payload.missing_checks, [], 'missing checks should be empty');
    assert.deepStrictEqual(r.payload.missing_mappings, [], 'missing mappings should be empty');
    assert.deepStrictEqual(r.payload.missing_runbook_sections, [], 'missing sections should be empty');

    // Remove one runbook section and ensure detector fails deterministically.
    writeText(runbookPath, [
      '# Runbook',
      '## Incident 3: Sensory Starvation',
      '## Incident 4: Autonomy Stall',
      '## Incident 5: Queue Backlog / Churn'
    ].join('\n'));

    r = run(['run', '2026-02-23'], baseEnv);
    assert.strictEqual(r.status, 1, 'expected failure status when runbook sections are missing');
    assert.ok(r.payload && r.payload.ok === false, 'failure payload should be false');
    assert.ok(Array.isArray(r.payload.missing_runbook_sections), 'missing sections should be array');
    assert.ok(r.payload.missing_runbook_sections.includes('budget_pressure'), 'budget_pressure section should be missing');
    assert.ok(r.payload.missing_runbook_sections.includes('dream_degradation'), 'dream_degradation section should be missing');

    console.log('slo_runbook_check.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`slo_runbook_check.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
