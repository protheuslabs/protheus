#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'memory_recall.js');

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
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

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-burn-'));
  writeFile(
    path.join(root, 'memory', 'MEMORY_INDEX.md'),
    [
      '# MEMORY_INDEX.md',
      '| node_id | uid | tags | file | summary |',
      '|---------|-----|------|------|---------|',
      '| burn-node | memtoken1 | #memory #burn | 2026-03-09.md | low burn |',
      ''
    ].join('\n')
  );
  writeFile(
    path.join(root, 'memory', 'TAGS_INDEX.md'),
    [
      '# TAGS_INDEX.md',
      '#memory -> burn-node',
      '#burn -> burn-node',
      ''
    ].join('\n')
  );
  writeFile(
    path.join(root, 'memory', '2026-03-09.md'),
    [
      '---',
      'date: 2026-03-09',
      'node_id: burn-node',
      'uid: memtoken1',
      'tags: [memory, burn]',
      'edges_to: []',
      '---',
      '# burn-node',
      '- keep reads tiny',
      ''
    ].join('\n')
  );
  return root;
}

try {
  const workspace = makeWorkspace();
  const telemetryPath = path.join(workspace, 'state', 'ops', 'token_burn', 'memory_recall.jsonl');
  const out = spawnSync(
    process.execPath,
    [SCRIPT, 'query', '--q=burn', '--top=1', '--expand=none'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        MEMORY_RECALL_ROOT: workspace,
        PROTHEUS_MEMORY_BURN_TELEMETRY_PATH: telemetryPath
      }
    }
  );

  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  const payload = parseJson(out.stdout);
  assert.ok(payload && payload.token_telemetry, 'response should include token telemetry');
  assert.ok(Number(payload.token_telemetry.total_tokens_est) <= 200, 'default retrieval path should remain under 200-token estimate');

  assert.ok(fs.existsSync(telemetryPath), 'telemetry file should be written');
  const lines = fs.readFileSync(telemetryPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, 'telemetry log should contain at least one entry');
  const latest = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(latest.type, 'memory_recall_token_telemetry');
  assert.strictEqual(latest.over_threshold, false, 'guard should report non-regressed burn for baseline query');

  fs.rmSync(workspace, { recursive: true, force: true });
  console.log('memory_burn_slo_guard.test.js: OK');
} catch (err) {
  console.error(`memory_burn_slo_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
