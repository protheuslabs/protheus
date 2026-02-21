#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { run } = require('../../../skills/moltbook/moltbook_publish_guard');
const { MoltbookApiError } = require('../../../skills/moltbook/moltbook_api');

function makeReceiptWriter(receipts) {
  return (record, meta = {}) => {
    receipts.push({
      ...record,
      receipt_contract: {
        version: '1.0',
        attempted: meta.attempted === true,
        verified: meta.verified === true,
        recorded: true
      }
    });
  };
}

async function testSuccess() {
  const receipts = [];
  const res = await run(['--title=T', '--body=B'], {
    loadApiKey: () => ({ apiKey: 'k', source: '/tmp/creds.json' }),
    createPost: async () => ({ verified: true, post_id: 'p1', post_url: 'https://www.moltbook.com/p/p1', verification: { method: 'id_lookup' } }),
    verifyVisible: async () => ({ verified: true, method: 'post_id_refetch' }),
    appendReceipt: makeReceiptWriter(receipts)
  });
  assert.strictEqual(res.exitCode, 0);
  assert.strictEqual(receipts.length, 1);
  assert.strictEqual(receipts[0].result, 'success');
  assert.strictEqual(receipts[0].receipt_contract.verified, true);
}

async function testCreateUnverified() {
  const receipts = [];
  const res = await run(['--title=T', '--body=B'], {
    loadApiKey: () => ({ apiKey: 'k', source: '/tmp/creds.json' }),
    createPost: async () => ({ verified: false, post_id: null, post_url: null, verification: { method: 'feed_lookup' } }),
    verifyVisible: async () => ({ verified: true }),
    appendReceipt: makeReceiptWriter(receipts)
  });
  assert.strictEqual(res.exitCode, 1);
  assert.strictEqual(receipts[0].error, 'CREATE_UNVERIFIED_OR_MISSING_ID');
  assert.strictEqual(receipts[0].receipt_contract.verified, false);
}

async function testEndpointDrift404() {
  const receipts = [];
  const res = await run(['--title=T', '--body=B'], {
    loadApiKey: () => ({ apiKey: 'k', source: '/tmp/creds.json' }),
    createPost: async () => {
      throw new MoltbookApiError('404', { code: 'ENDPOINT_UNSUPPORTED', status: 404, method: 'POST', path: '/posts' });
    },
    appendReceipt: makeReceiptWriter(receipts)
  });
  assert.strictEqual(res.exitCode, 1);
  assert.strictEqual(receipts[0].error.code, 'ENDPOINT_UNSUPPORTED');
  assert.strictEqual(receipts[0].error.status, 404);
}

async function testRateLimit429() {
  const receipts = [];
  const res = await run(['--title=T', '--body=B'], {
    loadApiKey: () => ({ apiKey: 'k', source: '/tmp/creds.json' }),
    createPost: async () => {
      throw new MoltbookApiError('429', { code: 'HTTP_ERROR', status: 429, method: 'POST', path: '/posts' });
    },
    appendReceipt: makeReceiptWriter(receipts)
  });
  assert.strictEqual(res.exitCode, 1);
  assert.strictEqual(receipts[0].error.status, 429);
}

async function main() {
  await testSuccess();
  await testCreateUnverified();
  await testEndpointDrift404();
  await testRateLimit429();
  console.log('moltbook_publish_guard.test.js: OK');
}

main().catch((err) => {
  console.error('moltbook_publish_guard.test.js: FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
