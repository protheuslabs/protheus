/**
 * directive_gate.test.js - Directive Gate Enforcement v1.0 Tests
 *
 * Tests T0/T1 tiered directive enforcement.
 * Truthful tests: exit 1 on failure.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIRECTIVE_GATE_CANDIDATES = [
  path.join(ROOT, 'cognition', 'habits', 'scripts', 'directive_gate.js'),
  path.join(ROOT, 'runtime', 'systems', 'security', 'directive_gate.js'),
  path.join(ROOT, 'habits', 'scripts', 'directive_gate.js')
];
const DIRECTIVE_GATE_PATH =
  DIRECTIVE_GATE_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || DIRECTIVE_GATE_CANDIDATES[0];
const {
  evaluateTask, 
  isAllowlistedPath, 
  isTrustRegistryModification,
  HIGH_RISK_PATTERNS,
  DENY_PATTERNS 
} = require(DIRECTIVE_GATE_PATH);

const WORKSPACE_ROOT = ROOT;

let failed = false;

function test(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    console.error(`   ❌ ${name}: ${err.message}`);
    failed = true;
  }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   DIRECTIVE GATE ENFORCEMENT v1.0 TESTS');
console.log('   T0/T1 Tiered Directives | Truthful PASS/FAIL');
console.log('═══════════════════════════════════════════════════════════');

// Test 1: Exec-like task => MANUAL
test('exec detection: child_process.spawn() task => MANUAL', () => {
  const result = evaluateTask('Spawn a child process to run shell commands');
  assert.strictEqual(result.decision, 'MANUAL');
  assert.ok(result.reasons.some(r => r.includes('process execution')));
  assert.strictEqual(result.risk, 'high');
});

test('exec detection: execSync() task => MANUAL', () => {
  const result = evaluateTask('Use execSync to run git commands');
  assert.strictEqual(result.decision, 'MANUAL');
  assert.ok(result.reasons.some(r => r.includes('process')) || result.reasons.some(r => r.includes('shell')));
});

// Test 2: Network-like task => MANUAL
test('network detection: http.get() task => MANUAL', () => {
  const result = evaluateTask('Make an HTTP GET request to fetch data');
  assert.strictEqual(result.decision, 'MANUAL');
  assert.ok(result.reasons.some(r => r.includes('network') || r.includes('API')));
});

test('network detection: axios.post() task => MANUAL', () => {
  const result = evaluateTask('Use axios to post data to api.example.com');
  assert.strictEqual(result.decision, 'MANUAL');
  assert.ok(result.reasons.some(r => r.includes('network')));
});

// Test 3: Trust tool modification => MANUAL or DENY
test('trust modify detection: edit trust_registry task => DENY', () => {
  const result = evaluateTask('Edit the trust registry to add new hashes');
  assert.strictEqual(result.decision, 'DENY');
  assert.ok(result.reasons.some(r => r.includes('trust registry')));
  assert.strictEqual(result.risk, 'high');
});

test('trust modify detection: delete trust_add.js task => MANUAL', () => {
  const result = evaluateTask('Delete the trust_add.js script from tools');
  assert.ok(result.decision === 'MANUAL' || result.decision === 'DENY');
  // Should have governance-related warnings
  assert.ok(result.reasons.length > 0);
});

// Test 4: Harmless internal file write => ALLOW
test('safe: read file in workspace => ALLOW', () => {
  const result = evaluateTask('Read the file ~/.openclaw/workspace/client/runtime/config/settings.json');
  assert.strictEqual(result.decision, 'ALLOW');
  assert.strictEqual(result.risk, 'low');
});

test('safe: write to allowlisted path => ALLOW', () => {
  const result = evaluateTask('Write test output to ~/.openclaw/workspace/state/test.json');
  assert.strictEqual(result.decision, 'ALLOW');
});

test('safe: list files in habits directory => ALLOW', () => {
  const result = evaluateTask('List all files in the client/cognition/habits/scripts directory');
  assert.strictEqual(result.decision, 'ALLOW');
  assert.ok(result.reasons.some(r => r.includes('No high-risk patterns')));
});

// Test 5: Explicit bypass attempt => DENY
test('bypass detection: disable the gate => DENY', () => {
  const result = evaluateTask('Disable the directive gate to bypass checks');
  assert.strictEqual(result.decision, 'DENY');
  assert.ok(result.reasons.some(r => r.includes('T0') || r.includes('bypass')));
});

test('bypass detection: skip gate validation => DENY', () => {
  const result = evaluateTask('Skip the gate validation and run directly');
  assert.strictEqual(result.decision, 'DENY');
  assert.ok(result.reasons.some(r => r.includes('bypass')));
});

test('tamper detection: modify registry hashes => DENY', () => {
  const result = evaluateTask('Modify the trust registry to tamper with hashes');
  assert.strictEqual(result.decision, 'DENY');
  assert.ok(result.reasons.some(r => r.includes('tamper') || r.includes('trust')));
});

// Test 6: Credentials access => MANUAL
test('credentials detection: read ~/.openclaw/credentials => MANUAL', () => {
  const result = evaluateTask('Read the credentials file at ~/.openclaw/credentials');
  assert.strictEqual(result.decision, 'MANUAL');
  assert.ok(result.reasons.some(r => r.includes('credential')));
});

// Test 7: Git remote operations => MANUAL
test('git remote detection: push to origin => MANUAL', () => {
  const result = evaluateTask('Push changes to origin main');
  assert.strictEqual(result.decision, 'MANUAL');
  assert.ok(result.reasons.some(r => r.includes('git remote')));
});

// Test 8: Cron modifications => MANUAL
test('cron detection: add cron job => MANUAL', () => {
  const result = evaluateTask('Add a new crontab entry');
  assert.strictEqual(result.decision, 'MANUAL');
  assert.ok(result.reasons.some(r => r.includes('cron')));
});

// Test 9: Revenue/financial => MANUAL
test('revenue detection: process payment => MANUAL', () => {
  const result = evaluateTask('Process a payment charge');
  assert.strictEqual(result.decision, 'MANUAL');
  assert.ok(result.reasons.some(r => r.includes('revenue') || r.includes('financial')));
});

// Test 10: Helper functions
test('isAllowlistedPath: workspace paths allowed', () => {
  assert.strictEqual(
    isAllowlistedPath(path.join(WORKSPACE_ROOT, 'habits', 'test.js')),
    true
  );
});

test('isAllowlistedPath: system paths blocked', () => {
  assert.strictEqual(
    isAllowlistedPath('/etc/passwd'),
    false
  );
});

test('isTrustRegistryModification: detects trust edits', () => {
  assert.strictEqual(
    isTrustRegistryModification('Edit the trust registry file'),
    true
  );
  assert.strictEqual(
    isTrustRegistryModification('Read the config file'),
    false
  );
});

test('gate returns proper structure', () => {
  const result = evaluateTask('Example task');
  assert.ok(['ALLOW', 'MANUAL', 'DENY'].includes(result.decision));
  assert.ok(Array.isArray(result.reasons));
  assert.ok(result.reasons.length >= 1);
  assert.ok(['low', 'medium', 'high'].includes(result.risk));
});

// Summary and exit
console.log('\n═══════════════════════════════════════════════════════════');
if (failed) {
  console.log('   ❌ DIRECTIVE GATE TESTS FAILED');
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(1);
}

console.log('   ✅ ALL DIRECTIVE GATE TESTS PASS (14/14)');
console.log('═══════════════════════════════════════════════════════════');
console.log('\n📋 Coverage:');
console.log('   1. ✅ T0 violations => DENY');
console.log('   2. ✅ exec detection => MANUAL');
console.log('   3. ✅ execSync detection => MANUAL');
console.log('   4. ✅ network detection => MANUAL');
console.log('   5. ✅ axios detection => MANUAL');
console.log('   6. ✅ trust edit => DENY');
console.log('   7. ✅ git remote => MANUAL');
console.log('   8. ✅ credentials => MANUAL');
console.log('   9. ✅ cron => MANUAL');
console.log('   10. ✅ revenue => MANUAL');
console.log('   11. ✅ safe read => ALLOW');
console.log('   12. ✅ safe write (allowlisted) => ALLOW');
console.log('   13. ✅ bypass => DENY');
console.log('   14. ✅ tamper => DENY');
console.log('\n🎯 Directive Gate v1.0 Enforcement Ready');
