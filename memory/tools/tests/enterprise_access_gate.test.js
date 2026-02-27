#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const {
  evaluateAccess,
  buildAccessContext
} = require(path.join(ROOT, 'systems', 'security', 'enterprise_access_gate.js'));

function run() {
  const allowDecision = evaluateAccess(
    'learning_conduit.promote',
    buildAccessContext({
      'actor-id': 'ml_ops_test',
      'actor-roles': 'ml_operator',
      'mfa-token': 'otp_123456',
      'tenant-id': 'tenant_alpha'
    })
  );
  assert.strictEqual(allowDecision.allow, true, 'ml operator with mfa and tenant should be allowed');

  const roleDenied = evaluateAccess(
    'learning_conduit.promote',
    buildAccessContext({
      'actor-id': 'viewer_test',
      'actor-roles': 'viewer',
      'mfa-token': 'otp_123456',
      'tenant-id': 'tenant_alpha'
    })
  );
  assert.strictEqual(roleDenied.allow, false, 'viewer role should be denied');
  assert.ok(Array.isArray(roleDenied.reasons) && roleDenied.reasons.includes('role_not_allowed'));

  const tenantDenied = evaluateAccess(
    'data_rights.process_apply',
    buildAccessContext({
      'actor-id': 'privacy_test',
      'actor-roles': 'privacy_officer',
      'mfa-token': 'otp_999999',
      'tenant-id': 'tenant_alpha',
      'target-tenant-id': 'tenant_beta'
    })
  );
  assert.strictEqual(tenantDenied.allow, false, 'tenant mismatch should be denied');
  assert.ok(Array.isArray(tenantDenied.reasons) && tenantDenied.reasons.includes('tenant_boundary_violation'));

  console.log('enterprise_access_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`enterprise_access_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
