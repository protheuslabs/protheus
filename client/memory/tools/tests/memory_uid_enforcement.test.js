#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function nodeBlock({ date, nodeId, uid }) {
  const uidLine = uid ? `uid: ${uid}\n` : '';
  return [
    '---',
    `date: ${date}`,
    `node_id: ${nodeId}`,
    uidLine ? uidLine.trimEnd() : null,
    'tags: [memory, test]',
    'edges_to: []',
    '---',
    '',
    `# ${nodeId}`,
    '',
    '- sample line'
  ].filter(Boolean).join('\n') + '\n';
}

function runLint(scriptPath, memoryDir) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORY_DIR: memoryDir,
      MEMORY_UID_ENFORCE_SINCE: '2026-02-22'
    }
  });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'memory', 'tools', 'lint_memory.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-uid-lint-'));
  const memoryDir = path.join(tmpRoot, 'memory');

  writeFile(
    path.join(memoryDir, '2026-02-20.md'),
    nodeBlock({ date: '2026-02-20', nodeId: 'legacy-node-no-uid', uid: null })
  );
  writeFile(
    path.join(memoryDir, '2026-02-22.md'),
    nodeBlock({ date: '2026-02-22', nodeId: 'new-node-missing-uid', uid: null })
  );

  const first = runLint(scriptPath, memoryDir);
  assert.strictEqual(first.status, 1, 'lint should fail for forward node missing uid');
  assert.ok(
    String(first.stdout || '').includes('MISSING_UID_REQUIRED') || String(first.stderr || '').includes('MISSING_UID_REQUIRED'),
    'expected missing uid error'
  );

  writeFile(
    path.join(memoryDir, '2026-02-22.md'),
    nodeBlock({ date: '2026-02-22', nodeId: 'new-node-missing-uid', uid: 'abc123DEF456' })
  );

  const second = runLint(scriptPath, memoryDir);
  assert.strictEqual(second.status, 0, `lint should pass once forward node has uid: ${second.stdout}\n${second.stderr}`);

  console.log('memory_uid_enforcement.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`memory_uid_enforcement.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

