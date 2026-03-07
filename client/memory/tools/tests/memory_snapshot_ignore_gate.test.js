#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'memory_snapshot_ignore_gate.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ignore-gate-'));
  const policyPath = path.join(tmp, 'config', 'memory_snapshot_ignore_gate_policy.json');
  const gitignorePath = path.join(tmp, '.gitignore');
  const mockBackupScript = path.join(tmp, 'mock_backup_integrity_check.js');

  writeText(mockBackupScript, [
    "#!/usr/bin/env node",
    "'use strict';",
    "const arg = process.argv.find((x) => String(x).startsWith('--channel=')) || '--channel=unknown';",
    "const channel = arg.split('=')[1];",
    "const fail = String(process.env.MOCK_FAIL_CHANNEL || '');",
    "const ok = !fail || fail !== channel;",
    "const payload = { ok, channel, type: 'mock_backup_integrity' };",
    "process.stdout.write(JSON.stringify(payload));",
    "process.exit(ok ? 0 : 1);"
  ].join('\n'));

  writeText(gitignorePath, '# existing\nnode_modules/\n');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    required_channels: ['state_backup', 'offsite_state_backup'],
    backup_integrity_script: mockBackupScript,
    gitignore_path: gitignorePath,
    snapshot_patterns: ['client/memory/_snapshots/', 'client/memory/*.backup.*'],
    outputs: {
      latest_path: path.join(tmp, 'state', 'ops', 'latest.json'),
      history_path: path.join(tmp, 'state', 'ops', 'history.jsonl')
    }
  });

  const env = {
    MEMORY_SNAPSHOT_IGNORE_GATE_ROOT: tmp,
    MEMORY_SNAPSHOT_IGNORE_GATE_POLICY_PATH: policyPath
  };

  let r = run(['verify-and-sync', '--apply=1', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'verify-and-sync should pass');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'payload should pass');
  const gitignore = fs.readFileSync(gitignorePath, 'utf8');
  assert.ok(gitignore.includes('# BL-020 memory snapshot ignore rules (backup-verified)'), 'gitignore should contain BL-020 marker');
  assert.ok(gitignore.includes('client/memory/_snapshots/'), 'gitignore should include snapshot ignore rule');

  r = run(['verify-and-sync', '--apply=1', '--strict=1'], { ...env, MOCK_FAIL_CHANNEL: 'offsite_state_backup' });
  assert.notStrictEqual(r.status, 0, 'strict run should fail when a channel check fails');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === false, 'payload should fail on channel error');
  assert.ok(Array.isArray(out.failed_channels) && out.failed_channels.includes('offsite_state_backup'), 'failed channel should be surfaced');

  console.log('memory_snapshot_ignore_gate.test.js: OK');
}

try { main(); } catch (err) { console.error(`memory_snapshot_ignore_gate.test.js: FAIL: ${err.message}`); process.exit(1); }
