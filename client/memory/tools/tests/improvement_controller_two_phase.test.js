#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const mod = require(path.join(repoRoot, 'systems', 'autonomy', 'improvement_controller.js'));

  const defaults = mod.defaultVerifyPlan();
  assert.ok(Array.isArray(defaults) && defaults.length >= 2, 'default verify plan should include core checks');
  const ids = defaults.map((s) => String(s.id || ''));
  assert.ok(ids.includes('contract_check'), 'default verify plan should include contract_check');
  assert.ok(ids.includes('schema_contract_check'), 'default verify plan should include schema_contract_check');

  const success = mod.runVerificationPlan([
    { id: 'step_a', key: 'a', command: ['node', 'a.js'] },
    { id: 'step_b', key: 'b', command: ['node', 'b.js'] }
  ], {
    runner: () => ({ status: 0, stdout: 'ok', stderr: '' })
  });
  assert.strictEqual(success.ok, true, 'all-zero exit verification should pass');
  assert.strictEqual(success.steps.length, 2);
  assert.strictEqual(success.root_cause, null);

  const failed = mod.runVerificationPlan([
    { id: 'step_a', key: 'a', command: ['node', 'a.js'] },
    { id: 'step_b', key: 'b', command: ['node', 'b.js'] }
  ], {
    runner: (cmd, args, step) => {
      if (String(step.id) === 'step_a') return { status: 0, stdout: 'a-ok', stderr: '' };
      return { status: 2, stdout: '', stderr: 'b-failed' };
    }
  });
  assert.strictEqual(failed.ok, false, 'non-zero exit verification should fail');
  assert.strictEqual(failed.steps.length, 2, 'verification should stop at first failed step');
  assert.strictEqual(mod.rootCauseFromVerification(failed.steps), 'verify_step_failed:step_b:exit_2');
  assert.strictEqual(failed.root_cause, 'verify_step_failed:step_b:exit_2');

  console.log('improvement_controller_two_phase.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`improvement_controller_two_phase.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
