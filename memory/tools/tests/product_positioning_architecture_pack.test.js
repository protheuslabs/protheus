#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DOC_PATH = path.join(ROOT, 'docs', 'PRODUCT_POSITIONING_ARCHITECTURE_PACK.md');

try {
  const body = fs.readFileSync(DOC_PATH, 'utf8');
  assert.ok(body.includes('## 7. Verification + Rollback Contract'), 'verification + rollback section missing');
  assert.ok(body.includes('mutation rollback receipts'), 'mutation rollback evidence mapping missing');
  assert.ok(body.includes('must map to a current repository artifact'), 'external claim constraint missing');
  console.log('product_positioning_architecture_pack.test.js: OK');
} catch (err) {
  console.error(`product_positioning_architecture_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

