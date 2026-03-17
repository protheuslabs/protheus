#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function main() {
  process.env.PROTHEUS_OPS_USE_PREBUILT = '0';
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = '120000';

  const mod = resetModule(path.join(ROOT, 'client/runtime/lib/action_envelope.ts'));
  const classification = mod.classifyAction({
    toolName: 'gh',
    commandText: 'publish release notes to blog'
  });
  assert.equal(classification.type, mod.ACTION_TYPES.PUBLISH_PUBLICLY);
  assert.equal(classification.risk, mod.RISK_LEVELS.HIGH);

  const irreversible = mod.detectIrreversible('git reset --hard HEAD~1');
  assert.equal(irreversible.is_irreversible, true);
  assert.equal(irreversible.severity, 'critical');

  const envelope = mod.autoClassifyAndCreate({
    toolName: 'bash',
    commandText: 'rm -rf build/tmp',
    payload: { cwd: '/tmp/example' }
  });
  assert.equal(envelope.type, mod.ACTION_TYPES.DELETE_DATA);
  assert.equal(envelope.risk, mod.RISK_LEVELS.HIGH);
  assert.equal(mod.requiresApprovalByDefault(envelope.type), true);
  assert.match(String(envelope.action_id), /^act_[0-9a-z]+_[0-9a-f]{8}$/);
  assert.equal(Array.isArray(envelope.tags), true);
  assert.equal(envelope.tags[0], mod.ACTION_TYPES.DELETE_DATA);

  const created = mod.createActionEnvelope({
    summary: 'research: search docs',
    type: mod.ACTION_TYPES.RESEARCH,
    risk: mod.RISK_LEVELS.LOW,
    payload: { source: 'docs' }
  });
  assert.equal(created.type, mod.ACTION_TYPES.RESEARCH);
  assert.equal(created.risk, mod.RISK_LEVELS.LOW);

  console.log(JSON.stringify({ ok: true, type: 'action_envelope_rust_bridge_test' }));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
