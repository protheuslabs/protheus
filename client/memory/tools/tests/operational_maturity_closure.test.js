#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parsePayload(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function writeScript(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'ops', 'operational_maturity_closure.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-closure-'));
  const runbookMapPath = path.join(tmp, 'config', 'autonomy_slo_runbook_map.json');
  const policyPath = path.join(tmp, 'config', 'operational_maturity_closure_policy.json');
  const flagEyes = path.join(tmp, 'state', 'flags', 'eyes_healed.flag');

  const okScript = path.join(tmp, 'scripts', 'ok.js');
  const eyesHealthScript = path.join(tmp, 'scripts', 'eyes_health.js');
  const eyesRemediateScript = path.join(tmp, 'scripts', 'eyes_remediate.js');
  const escalationScript = path.join(tmp, 'scripts', 'escalation.js');

  writeScript(okScript, [
    '#!/usr/bin/env node',
    "console.log(JSON.stringify({ ok: true, pass: true, healthy: true }));"
  ]);
  writeScript(eyesHealthScript, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const flag = process.argv[2];",
    "const healthy = !!(flag && fs.existsSync(flag));",
    "console.log(JSON.stringify({ ok: healthy, healthy, pass: healthy }));",
    "process.exit(healthy ? 0 : 1);"
  ]);
  writeScript(eyesRemediateScript, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const path = require('path');",
    "const flag = process.argv[2];",
    "fs.mkdirSync(path.dirname(flag), { recursive: true });",
    "fs.writeFileSync(flag, 'healed\\n', 'utf8');",
    "console.log(JSON.stringify({ ok: true, healed: true }));"
  ]);
  writeScript(escalationScript, [
    '#!/usr/bin/env node',
    "console.log(JSON.stringify({ ok: true, pass: true, delivered: true, delivered_via: 'local_fallback' }));"
  ]);

  writeJson(runbookMapPath, {
    required_checks: ['proposal_starvation', 'queue_backlog'],
    mappings: {
      proposal_starvation: { owner: 'ops', runbook_id: 'INC-001', section: 'Incident 1' },
      queue_backlog: { owner: 'ops', runbook_id: 'INC-002', section: 'Incident 2' }
    }
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    runbook_map_path: runbookMapPath,
    state_path: path.join(tmp, 'state', 'ops', 'operational_maturity_closure', 'latest.json'),
    history_path: path.join(tmp, 'state', 'ops', 'operational_maturity_closure', 'history.jsonl'),
    escalation: {
      script: escalationScript,
      args: [],
      timeout_ms: 30000
    },
    classes: {
      eyes: {
        enabled: true,
        retries: 2,
        timeout_ms: 30000,
        health: { script: eyesHealthScript, args: [flagEyes] },
        remediate: { script: eyesRemediateScript, args: [flagEyes] }
      },
      visualizer: {
        enabled: true,
        retries: 0,
        timeout_ms: 30000,
        health: { script: okScript, args: [] },
        remediate: { script: okScript, args: [] }
      },
      alert_transport: {
        enabled: true,
        retries: 0,
        timeout_ms: 30000,
        health: { script: okScript, args: [] },
        remediate: { script: okScript, args: [] }
      }
    }
  });

  const passRun = spawnSync(process.execPath, [
    script,
    'run',
    `--policy=${policyPath}`,
    '--strict=1'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(passRun.status, 0, passRun.stderr || 'closure run should pass');
  const passPayload = parsePayload(passRun.stdout);
  assert.ok(passPayload && passPayload.pass === true, 'payload pass should be true');
  assert.strictEqual(passPayload.checks.runbook_coverage, true, 'runbook coverage should pass');
  assert.strictEqual(passPayload.checks.escalation_path, true, 'escalation check should pass');
  assert.strictEqual(passPayload.remediation.eyes.pass, true, 'eyes should pass after remediation');
  assert.ok(Number(passPayload.remediation.eyes.remediation_attempts || 0) >= 1, 'eyes remediation should be attempted');

  // Break runbook map and confirm strict failure.
  writeJson(runbookMapPath, {
    required_checks: ['proposal_starvation'],
    mappings: {
      proposal_starvation: { owner: '', runbook_id: 'INC-001', section: 'Incident 1' }
    }
  });
  const failRun = spawnSync(process.execPath, [
    script,
    'run',
    `--policy=${policyPath}`,
    '--strict=1'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(failRun.status, 1, 'strict run should fail when runbook owner is missing');
  const failPayload = parsePayload(failRun.stdout);
  assert.ok(failPayload && failPayload.pass === false, 'failing run should report pass=false');
  assert.strictEqual(failPayload.checks.runbook_coverage, false, 'runbook coverage check should fail');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('operational_maturity_closure.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`operational_maturity_closure.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

