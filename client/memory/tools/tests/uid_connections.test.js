#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body + (body ? '\n' : ''), 'utf8');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'memory', 'uid_connections.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uid-connections-'));
  const eyesDir = path.join(tmpRoot, 'state', 'memory', 'eyes_pointers');
  const adaptivePointers = path.join(tmpRoot, 'state', 'memory', 'adaptive_pointers.jsonl');
  const connectionsPath = path.join(tmpRoot, 'state', 'memory', 'uid_connections.jsonl');
  const indexPath = path.join(tmpRoot, 'state', 'memory', 'uid_connection_index.json');
  const suggestionsDir = path.join(tmpRoot, 'state', 'adaptive', 'suggestions');
  const dateStr = '2026-02-21';

  writeJsonl(path.join(eyesDir, `${dateStr}.jsonl`), [
    {
      ts: `${dateStr}T01:00:00Z`,
      uid: 'memabc123',
      proposal_id: 'EYE-1',
      eye_id: 'hn_frontpage',
      title: 'Arbitrage signal in AI tooling market',
      topics: ['arbitrage', 'ai', 'market']
    },
    {
      ts: `${dateStr}T01:10:00Z`,
      uid: 'memdef456',
      proposal_id: 'EYE-2',
      eye_id: 'moltbook_feed',
      title: 'AI market arbitrage opportunity for agents',
      topics: ['arbitrage', 'ai', 'agents']
    }
  ]);

  writeJsonl(adaptivePointers, [
    {
      ts: `${dateStr}T00:30:00Z`,
      uid: 'adpzzz999',
      kind: 'adaptive_eye',
      layer: 'sensory',
      tags: ['adaptive', 'sensory', 'trend'],
      summary: 'Existing adaptive trend eye',
      path_ref: 'client/adaptive/sensory/eyes/catalog.json'
    }
  ]);

  const env = {
    ...process.env,
    UID_CONNECTIONS_EYES_POINTERS_DIR: eyesDir,
    UID_CONNECTIONS_ADAPTIVE_POINTERS_PATH: adaptivePointers,
    UID_CONNECTIONS_LOG_PATH: connectionsPath,
    UID_CONNECTIONS_INDEX_PATH: indexPath,
    UID_CONNECTIONS_SUGGESTIONS_DIR: suggestionsDir,
    UID_CONNECTIONS_SUGGESTION_MIN_CONNECTIONS: '1'
  };

  const build = spawnSync(process.execPath, [scriptPath, 'build', dateStr, '--days=1', '--top=50'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(build.status, 0, build.stderr || 'build should succeed');
  const out = JSON.parse(String(build.stdout || '{}').trim());
  assert.strictEqual(out.ok, true);
  assert.ok(Number(out.new_connections || 0) >= 1, 'should create at least one connection');
  assert.ok(Number(out.new_adaptive_suggestions || 0) >= 1, 'should create at least one adaptive suggestion');

  const status = spawnSync(process.execPath, [scriptPath, 'status', dateStr], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(status.status, 0, status.stderr || 'status should succeed');
  const st = JSON.parse(String(status.stdout || '{}').trim());
  assert.strictEqual(st.ok, true);
  assert.ok(Number(st.connections_today || 0) >= 1);
  assert.ok(Number(st.suggestions_today || 0) >= 1);

  console.log('uid_connections.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`uid_connections.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

