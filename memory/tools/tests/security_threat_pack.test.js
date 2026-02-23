#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const threatDocPath = path.join(repoRoot, 'docs', 'THREAT_MODEL_V1.md');
  const doc = fs.readFileSync(threatDocPath, 'utf8');

  const required = [
    {
      threat: 'prompt_injection_ingress',
      tests: [
        'memory/tools/tests/request_envelope.test.js',
        'memory/tools/tests/guard_remote_gate.test.js',
        'memory/tools/tests/directive_gate.test.js'
      ]
    },
    {
      threat: 'unauthorized_mutation',
      tests: [
        'memory/tools/tests/adaptive_layer_boundary_guards.test.js',
        'memory/tools/tests/security_integrity.test.js'
      ]
    },
    {
      threat: 'egress_bypass',
      tests: [
        'memory/tools/tests/egress_gateway.test.js',
        'memory/tools/tests/egress_chokepoint_guard.test.js'
      ]
    },
    {
      threat: 'secret_exfiltration',
      tests: [
        'memory/tools/tests/secret_broker.test.js',
        'memory/tools/tests/secret_broker_isolation_guard.test.js'
      ]
    },
    {
      threat: 'policy_root_lease_misuse',
      tests: [
        'memory/tools/tests/policy_rootd_lease.test.js',
        'memory/tools/tests/improvement_controller_policy_root.test.js'
      ]
    },
    {
      threat: 'integrity_tamper',
      tests: [
        'memory/tools/tests/startup_attestation.test.js',
        'memory/tools/tests/startup_attestation_auto_issue.test.js',
        'memory/tools/tests/action_receipts_integrity.test.js'
      ]
    }
  ];

  for (const row of required) {
    for (const rel of row.tests) {
      const abs = path.join(repoRoot, rel);
      assert.ok(fs.existsSync(abs), `missing threat regression test: ${rel}`);
      const marker = `\`${rel}\``;
      assert.ok(doc.includes(marker), `threat model doc missing test mapping: ${marker}`);
    }
  }

  console.log('security_threat_pack.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`security_threat_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

