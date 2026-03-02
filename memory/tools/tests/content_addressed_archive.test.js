#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'archival', 'content_addressed_archive.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cid-archive-'));
  const policyPath = path.join(tmp, 'config', 'content_addressed_archive_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'archival.content_addressed' },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'archival', 'content_addressed'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'archival', 'index.json'),
      events_path: path.join(tmp, 'state', 'archival', 'content_addressed', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'archival', 'content_addressed', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'archival', 'content_addressed', 'receipts.jsonl'),
      cid_index_path: path.join(tmp, 'state', 'archival', 'content_addressed', 'cid_index.json')
    }
  });

  let out = run(['configure', '--owner=jay', '--pin-policy=hot', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  out = run(['archive', '--owner=jay', '--payload=hello_world_payload', '--label=note_1', '--risk-tier=2', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'content_archive');
  assert.ok(fs.existsSync(path.join(tmp, 'state', 'archival', 'content_addressed', 'cid_index.json')));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('content_addressed_archive.test.js: OK');
} catch (err) {
  console.error(`content_addressed_archive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
