#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const COLLECTOR_PATH = path.join(ROOT, 'habits', 'scripts', 'eyes_collectors', 'ollama_search.js');
const CACHE_STORE_PATH = path.join(ROOT, 'habits', 'scripts', 'eyes_collectors', 'cache_store.js');

let failed = false;

function logPass(name) {
  console.log(`   ✅ ${name}`);
}

function logFail(name, err) {
  failed = true;
  console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
}

function clearCollectorModules() {
  delete require.cache[require.resolve(COLLECTOR_PATH)];
  delete require.cache[require.resolve(CACHE_STORE_PATH)];
}

async function withMockedHttpsGet(mockGet, fn) {
  const https = require('https');
  const originalGet = https.get;
  https.get = mockGet;
  try {
    return await fn();
  } finally {
    https.get = originalGet;
  }
}

function makeGetResponder({ statusCode = 200, body = '' }) {
  return (_url, _opts, onResponse) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    response.resume = () => {};

    process.nextTick(() => {
      onResponse(response);
      if (statusCode >= 400) {
        response.emit('end');
        return;
      }
      response.emit('data', Buffer.from(body, 'utf8'));
      response.emit('end');
    });

    return {
      on() { return this; },
      setTimeout() { return this; },
      destroy() {}
    };
  };
}

async function runTest(name, fn) {
  try {
    await fn();
    logPass(name);
  } catch (err) {
    logFail(name, err);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   OLLAMA SEARCH COLLECTOR TESTS');
  console.log('═══════════════════════════════════════════════════════════');

  const sampleHtml = [
    '<a href="/library/qwen3-4b" data-testid="model-card">',
    '<h2>qwen3:4b</h2>',
    '<p>Code-friendly local model with tools support</p>',
    '<span>4B</span><span>code</span>',
    '</a>',
    '<a href="/library/gemma3-4b" data-testid="model-card">',
    '<h2>gemma3:4b</h2>',
    '<p>Small multimodal model for edge inference</p>',
    '<span>4B</span><span>vision</span>',
    '</a>'
  ].join('');

  await runTest('collect parses model cards and cache dedupe works', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-cache-'));
    process.env.EYES_COLLECTOR_CACHE_DIR = cacheDir;
    clearCollectorModules();

    await withMockedHttpsGet(makeGetResponder({ body: sampleHtml }), async () => {
      const { collectOllamaSearchNewest } = require(COLLECTOR_PATH);
      const first = await collectOllamaSearchNewest({ timeoutMs: 1000 });
      assert.strictEqual(first.ok, true);
      assert.strictEqual(first.success, true);
      assert.strictEqual(first.items.length, 2);
      assert.ok(first.items.every((i) => i.eye_id === 'ollama_search'));
      assert.ok(first.items.every((i) => String(i.url || '').startsWith('https://ollama.com/library/')));

      const second = await collectOllamaSearchNewest({ timeoutMs: 1000 });
      assert.strictEqual(second.ok, true);
      assert.strictEqual(second.success, true);
      assert.strictEqual(second.items.length, 0);
    });
  });

  await runTest('collect reports parse_failed on empty page', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-cache-'));
    process.env.EYES_COLLECTOR_CACHE_DIR = cacheDir;
    clearCollectorModules();

    await withMockedHttpsGet(makeGetResponder({ body: '<html><body>none</body></html>' }), async () => {
      const { collectOllamaSearchNewest } = require(COLLECTOR_PATH);
      const res = await collectOllamaSearchNewest({ timeoutMs: 1000 });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error.code, 'parse_failed');
      assert.strictEqual(res.items.length, 0);
    });
  });

  await runTest('collect classifies HTTP 429 as rate_limited', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-cache-'));
    process.env.EYES_COLLECTOR_CACHE_DIR = cacheDir;
    clearCollectorModules();

    await withMockedHttpsGet(makeGetResponder({ statusCode: 429 }), async () => {
      const { collectOllamaSearchNewest } = require(COLLECTOR_PATH);
      const res = await collectOllamaSearchNewest({ timeoutMs: 1000 });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error.code, 'rate_limited');
    });
  });

  if (failed) process.exit(1);
  console.log('   ✅ ALL OLLAMA SEARCH COLLECTOR TESTS PASS');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
