#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function main() {
  process.env.PROTHEUS_OPS_USE_PREBUILT = '0';
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = '120000';
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-response-compactor-'));

  const mod = resetModule(path.join(ROOT, 'client/runtime/lib/tool_response_compactor.ts'));

  const redacted = mod.redactSecrets(
    'Authorization: Bearer token-12345\nmoltbook_sk_abcdefghijklmnopqrstuvwxyz1234567890'
  );
  assert.match(redacted, /Authorization: Bearer \[REDACTED\]/);
  assert.match(redacted, /moltbook_sk_\*{4}7890/);

  const summary = mod.extractSummary({
    id: 'abcdef123456',
    url: 'https://example.com/some/path',
    total_count: 4,
    status: 'error'
  }, 'bridge');
  assert.ok(summary.some((row) => row.includes('IDs:')));
  assert.ok(summary.some((row) => row.includes('URLs:')));
  assert.ok(summary.some((row) => row.includes('Status: error')));

  const largeText = Array.from({ length: 60 }, (_, idx) => `line-${idx + 1} secret=moltbook_sk_abcdefghijklmnopqrstuvwxyz1234567890`).join('\n');
  const result = mod.compactToolResponse(largeText, {
    toolName: 'audit/tool',
    rootDir: tmpRoot
  });
  assert.equal(result.compacted, true);
  assert.match(result.content, /\[TOOL OUTPUT COMPACTED\]/);
  assert.ok(String(result.rawPath || '').endsWith('.txt'));
  assert.equal(fs.existsSync(result.rawPath), true);
  const saved = fs.readFileSync(result.rawPath, 'utf8');
  assert.match(saved, /moltbook_sk_\*{4}7890/);

  const small = mod.compactToolResponse('short output', { toolName: 'small' });
  assert.equal(small.compacted, false);
  assert.equal(small.content, 'short output');

  console.log(JSON.stringify({ ok: true, type: 'tool_response_compactor_rust_bridge_test' }));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
