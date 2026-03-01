#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'event_sourced_control_plane.js');

function writeFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (text) {
    try { return JSON.parse(text); } catch {}
  }
  const lines = String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number(proc.status || 0),
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'event-source-jetstream-'));
  const configDir = path.join(tmp, 'config');
  const stateDir = path.join(tmp, 'state');
  const invokePath = path.join(tmp, 'jetstream_invoke.json');
  const publisherPath = path.join(tmp, 'publisher_stub.js');

  writeFile(publisherPath, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
const subject = args[args.length - 2] || null;
const payload = args[args.length - 1] || null;
if (!outPath) {
  process.stderr.write('missing --out path');
  process.exit(2);
}
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ subject, payload }, null, 2) + '\\n', 'utf8');
process.stdout.write('ok\\n');
`);
  fs.chmodSync(publisherPath, 0o755);

  const policyPath = path.join(configDir, 'event_sourced_control_plane_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    jetstream: {
      enabled: true,
      shadow_only: false,
      allow_shadow_publish: true,
      subject_prefix: 'protheus.events',
      publish_command: [process.execPath, publisherPath, '--out', invokePath],
      timeout_ms: 5000
    },
    paths: {
      events_path: path.join(stateDir, 'events.jsonl'),
      views_path: path.join(stateDir, 'views.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl'),
      jetstream_latest_path: path.join(stateDir, 'jetstream_latest.json')
    }
  });

  const appendOut = run([
    'append',
    '--stream=control',
    '--event=mutation',
    '--payload_json={"delta":"ok"}'
  ], {
    EVENT_SOURCED_CONTROL_PLANE_POLICY_PATH: policyPath
  });
  assert.strictEqual(appendOut.status, 0, appendOut.stderr || 'append should succeed');
  assert.ok(appendOut.payload && appendOut.payload.ok === true, 'append payload should be ok');
  assert.ok(appendOut.payload.jetstream && appendOut.payload.jetstream.mirrored === true, 'jetstream mirror should publish');

  const invoke = JSON.parse(fs.readFileSync(invokePath, 'utf8'));
  assert.ok(String(invoke.subject || '').startsWith('protheus.events.control.mutation'), 'subject should include stream/event');
  const mirroredPayload = JSON.parse(String(invoke.payload || '{}'));
  assert.ok(mirroredPayload && mirroredPayload.event && mirroredPayload.event.event_id, 'mirrored payload should include event');

  const statusOut = run(['status'], {
    EVENT_SOURCED_CONTROL_PLANE_POLICY_PATH: policyPath
  });
  assert.strictEqual(statusOut.status, 0, statusOut.stderr || 'status should succeed');
  assert.ok(statusOut.payload && statusOut.payload.ok === true, 'status payload should be ok');
  assert.ok(statusOut.payload.jetstream_latest && statusOut.payload.jetstream_latest.mirrored === true, 'status should include latest jetstream mirror');

  console.log('event_sourced_control_plane_jetstream.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`event_sourced_control_plane_jetstream.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
