#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  loadActiveDirectives,
  validateTier1DirectiveQuality
} = require('../../../lib/directive_resolver.js');

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const t1Path = path.join(repoRoot, 'config', 'directives', 'T1_make_jay_billionaire_v1.yaml');
  const t1Content = fs.readFileSync(t1Path, 'utf8');
  const good = validateTier1DirectiveQuality(t1Content, 'T1_make_jay_billionaire_v1');
  assert.strictEqual(good.ok, true, `expected active T1 to pass, missing=${good.missing.join(',')}`);

  const weakDirective = [
    'metadata:',
    '  id: T1_weak_example',
    '  tier: 1',
    'intent:',
    '  primary: "Make progress"',
    'constraints:',
    '  operational:',
    '    only_proven_strategies: true',
    'scope:',
    '  included:',
    '    - "automation"',
    'approval_policy:',
    '  inherits: T0_invariants'
  ].join('\n');

  const weak = validateTier1DirectiveQuality(weakDirective, 'T1_weak_example');
  assert.strictEqual(weak.ok, false, 'weak tier1 directive should fail quality gate');
  assert.ok(
    weak.missing.includes('intent.timebound_signal') || weak.missing.includes('intent.definitions_timebound')
  );
  assert.ok(weak.missing.includes('scope.excluded'));
  assert.ok(weak.missing.includes('constraints.risk_limits'));
  assert.ok(weak.missing.includes('success_metrics.leading'));
  assert.ok(weak.missing.includes('success_metrics.lagging'));
  assert.ok(weak.missing.includes('approval_policy.additional_gates'));
  assert.ok(Array.isArray(weak.questions) && weak.questions.length >= 3);

  const loaded = loadActiveDirectives();
  assert.ok(Array.isArray(loaded) && loaded.length >= 1, 'active directives should load');

  console.log('directive_tier1_quality.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`directive_tier1_quality.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
