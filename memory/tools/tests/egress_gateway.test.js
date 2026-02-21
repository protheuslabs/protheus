#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

async function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_egress_gateway');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  const policyPath = path.join(tmpRoot, 'policy.json');
  const statePath = path.join(tmpRoot, 'state.json');
  const auditPath = path.join(tmpRoot, 'audit.jsonl');

  writeJson(policyPath, {
    version: '1.0',
    default_decision: 'deny',
    global_rate_caps: { per_hour: 10, per_day: 20 },
    scopes: {
      'test.scope': {
        methods: ['GET'],
        domains: ['example.com'],
        rate_caps: { per_hour: 2, per_day: 3 }
      },
      'test.runtime': {
        methods: ['GET'],
        domains: [],
        require_runtime_allowlist: true,
        rate_caps: { per_hour: 10, per_day: 10 }
      },
      'sensory.collector.dynamic': {
        methods: ['GET', 'POST'],
        domains: [],
        require_runtime_allowlist: true,
        rate_caps: { per_hour: 10, per_day: 10 }
      }
    }
  });

  process.env.EGRESS_GATEWAY_POLICY_PATH = policyPath;
  process.env.EGRESS_GATEWAY_STATE_PATH = statePath;
  process.env.EGRESS_GATEWAY_AUDIT_PATH = auditPath;

  const gw = require('../../../lib/egress_gateway.js');

  const allow1 = gw.authorizeEgress({
    scope: 'test.scope',
    url: 'https://api.example.com/v1/test',
    method: 'GET',
    caller: 'egress_test',
    apply: true,
    now_ms: Date.parse('2026-02-21T12:00:00.000Z')
  });
  assert.strictEqual(allow1.allow, true, 'first request should allow');

  const allow2 = gw.authorizeEgress({
    scope: 'test.scope',
    url: 'https://example.com/health',
    method: 'GET',
    caller: 'egress_test',
    apply: true,
    now_ms: Date.parse('2026-02-21T12:00:01.000Z')
  });
  assert.strictEqual(allow2.allow, true, 'second request should allow');

  const capped = gw.authorizeEgress({
    scope: 'test.scope',
    url: 'https://example.com/again',
    method: 'GET',
    caller: 'egress_test',
    apply: true,
    now_ms: Date.parse('2026-02-21T12:00:02.000Z')
  });
  assert.strictEqual(capped.allow, false, 'hour cap should deny');
  assert.strictEqual(capped.reason, 'scope_hour_cap_exceeded');

  const blockedDomain = gw.authorizeEgress({
    scope: 'test.scope',
    url: 'https://not-allowed.net/test',
    method: 'GET',
    caller: 'egress_test',
    apply: false,
    now_ms: Date.parse('2026-02-21T12:00:03.000Z')
  });
  assert.strictEqual(blockedDomain.allow, false, 'domain allowlist should deny');
  assert.strictEqual(blockedDomain.reason, 'domain_not_allowlisted');

  const missingRuntimeAllowlist = gw.authorizeEgress({
    scope: 'test.runtime',
    url: 'https://example.org/path',
    method: 'GET',
    caller: 'egress_test',
    apply: false,
    now_ms: Date.parse('2026-02-21T12:01:00.000Z')
  });
  assert.strictEqual(missingRuntimeAllowlist.allow, false, 'runtime allowlist should be required');
  assert.strictEqual(missingRuntimeAllowlist.reason, 'runtime_allowlist_required');

  const runtimeAllowed = gw.authorizeEgress({
    scope: 'test.runtime',
    url: 'https://example.org/path',
    method: 'GET',
    caller: 'egress_test',
    runtime_allowlist: ['example.org'],
    apply: false,
    now_ms: Date.parse('2026-02-21T12:01:01.000Z')
  });
  assert.strictEqual(runtimeAllowed.allow, true, 'runtime allowlist should allow');

  const dynamicCollectorFallback = gw.authorizeEgress({
    scope: 'sensory.collector.new_parser_type',
    url: 'https://example.org/new-source',
    method: 'GET',
    caller: 'egress_test',
    runtime_allowlist: ['example.org'],
    apply: false,
    now_ms: Date.parse('2026-02-21T12:01:02.000Z')
  });
  assert.strictEqual(dynamicCollectorFallback.allow, true, 'collector dynamic fallback should allow with runtime allowlist');

  let deniedErr = null;
  try {
    await gw.egressFetch('https://not-allowed.net/blocked', { method: 'GET' }, {
      scope: 'test.scope',
      caller: 'egress_test',
      apply: false,
      now_ms: Date.parse('2026-02-21T12:02:00.000Z')
    });
  } catch (err) {
    deniedErr = err;
  }
  assert.ok(deniedErr, 'egressFetch should throw for denied requests');
  assert.strictEqual(deniedErr.name, 'EgressGatewayError');

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(state.per_hour && Object.keys(state.per_hour).length >= 1, 'state counters should persist');

  console.log('egress_gateway.test.js: OK');
}

run().catch((err) => {
  console.error(`egress_gateway.test.js: FAIL: ${err.message}`);
  process.exit(1);
});
