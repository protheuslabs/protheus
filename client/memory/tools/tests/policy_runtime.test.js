#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const runtime = require(path.join(ROOT, 'lib', 'policy_runtime.js'));

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-runtime-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  writeJson(policyPath, {
    enabled: false,
    nested: {
      limit: 9,
      tags: ['x']
    },
    lane: {
      mode: 'live'
    }
  });

  const loaded = runtime.loadPolicyRuntime({
    policyPath,
    defaults: {
      enabled: true,
      nested: {
        limit: 3,
        tags: ['a', 'b'],
        keep: 'yes'
      },
      lane: {
        mode: 'shadow',
        retries: 2
      }
    }
  });

  assert.strictEqual(loaded.policy.enabled, false, 'override should apply');
  assert.strictEqual(loaded.policy.nested.limit, 9, 'nested numeric override should apply');
  assert.deepStrictEqual(loaded.policy.nested.tags, ['x'], 'arrays should replace');
  assert.strictEqual(loaded.policy.nested.keep, 'yes', 'default nested fields should persist');
  assert.strictEqual(loaded.policy.lane.mode, 'live', 'nested override should apply');
  assert.strictEqual(loaded.policy.lane.retries, 2, 'default nested sibling should persist');

  const transitionSrc = fs.readFileSync(path.join(ROOT, 'systems', 'memory', 'rust_memory_transition_lane.ts'), 'utf8');
  const supervisorSrc = fs.readFileSync(path.join(ROOT, 'systems', 'memory', 'rust_memory_daemon_supervisor.ts'), 'utf8');
  const freshnessSrc = fs.readFileSync(path.join(ROOT, 'systems', 'memory', 'memory_index_freshness_gate.ts'), 'utf8');

  assert.ok(transitionSrc.includes('loadPolicyRuntime'), 'transition lane should use policy runtime primitive');
  assert.ok(supervisorSrc.includes('loadPolicyRuntime'), 'daemon supervisor should use policy runtime primitive');
  assert.ok(freshnessSrc.includes('loadPolicyRuntime'), 'freshness gate should use policy runtime primitive');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('policy_runtime.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`policy_runtime.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
