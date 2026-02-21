#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const COLLECTOR_PATH = path.join(ROOT, 'habits', 'scripts', 'eyes_collectors', 'bird_x.js');
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

async function withMockedExecSync(mockExecSync, fn) {
  const childProcess = require('child_process');
  const originalExecSync = childProcess.execSync;
  childProcess.execSync = mockExecSync;
  try {
    return await fn();
  } finally {
    childProcess.execSync = originalExecSync;
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    logPass(name);
  } catch (err) {
    logFail(name, err);
  }
}

function sampleTweet(id, text, author, extra = {}) {
  return {
    id,
    text,
    author: {
      handle: author,
      name: author
    },
    likes: 1,
    retweets: 0,
    replies: 0,
    created_at: '2026-02-19T12:00:00Z',
    ...extra
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   BIRD X COLLECTOR TESTS');
  console.log('═══════════════════════════════════════════════════════════');

  await runTest('collect dedupes tweet ids across multiple queries', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'birdx-cache-'));
    process.env.EYES_COLLECTOR_CACHE_DIR = cacheDir;
    clearCollectorModules();

    const mockExecSync = (cmd) => {
      if (cmd.includes('AI agent')) {
        return JSON.stringify([
          sampleTweet('1001', 'AI agent launch with strong revenue signal', 'alice'),
          sampleTweet('1002', 'OpenClaw automation update for developers', 'bob')
        ]);
      }
      if (cmd.includes('moltbook OR openclaw')) {
        return JSON.stringify([
          sampleTweet('1002', 'OpenClaw automation update for developers', 'bob'),
          sampleTweet('1003', 'Founder workflow: build and optimize weekly loops', 'carol')
        ]);
      }
      if (cmd.includes('local LLM ollama')) {
        const err = new Error('transient query failure');
        err.status = 1;
        throw err;
      }
      return JSON.stringify([]);
    };

    await withMockedExecSync(mockExecSync, async () => {
      const { collectBirdX } = require(COLLECTOR_PATH);
      const result = await collectBirdX({ timeoutMs: 1000, maxItemsPerQuery: 5, maxItems: 20 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.items.length, 3);
      assert.ok(result.items.every((i) => i.eye_id === 'bird_x'));
      assert.ok(result.items.every((i) => String(i.url || '').startsWith('https://x.com/')));
      assert.strictEqual(result.requests, 2);
    });
  });

  await runTest('preflight returns env_blocked when bird CLI is missing', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'birdx-cache-'));
    process.env.EYES_COLLECTOR_CACHE_DIR = cacheDir;
    clearCollectorModules();

    const mockExecSync = () => {
      const err = new Error('command not found: bird');
      err.status = 127;
      throw err;
    };

    await withMockedExecSync(mockExecSync, async () => {
      const { preflightBirdX } = require(COLLECTOR_PATH);
      const res = await preflightBirdX();
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'env_blocked');
    });
  });

  await runTest('collect marks success=false when all queries are empty', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'birdx-cache-'));
    process.env.EYES_COLLECTOR_CACHE_DIR = cacheDir;
    clearCollectorModules();

    await withMockedExecSync(() => JSON.stringify([]), async () => {
      const { collectBirdX } = require(COLLECTOR_PATH);
      const result = await collectBirdX({ timeoutMs: 1000, maxItemsPerQuery: 3 });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.items.length, 0);
      assert.strictEqual(result.requests, 3);
    });
  });

  if (failed) process.exit(1);
  console.log('   ✅ ALL BIRD X COLLECTOR TESTS PASS');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
