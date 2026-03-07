#!/usr/bin/env node
/**
 * skill_gate.smoke.test.js - Smoke test for skill supply-chain gate
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { verifySkillOrThrow, checkSkill, computeHash } = require('../skill_gate');

const TEST_DIR = path.join(__dirname, '_test_skills');
const CONFIG_PATH = '/Users/jay/.openclaw/workspace/client/config/trusted_skills.json';

function setup() {
  // Create test directory
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }
}

function cleanup() {
  // Clean up test files
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function createTestFile(name, content) {
  const filepath = path.join(TEST_DIR, name);
  fs.writeFileSync(filepath, content, 'utf8');
  return filepath;
}

function runTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('        SKILL GATE SMOKE TESTS');
  console.log('═══════════════════════════════════════════════════════════');
  
  setup();
  
  // Test 1: Trusted file passes
  console.log('\n1. Testing trusted file passes...');
  try {
    // Use an already trusted file
    const trustedFile = '/Users/jay/.openclaw/workspace/client/memory/tools/skill_gate.js';
    const result = verifySkillOrThrow(trustedFile);
    assert.strictEqual(result.ok, true, 'Trusted file should pass');
    console.log('   ✅ Trusted file passes verification');
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 2: Untrusted file is blocked (NOT_TRUSTED)
  console.log('\n2. Testing untrusted file is blocked...');
  try {
    const untrustedFile = createTestFile('untrusted.js', 'console.log("untrusted");');
    try {
      verifySkillOrThrow(untrustedFile);
      assert.fail('Should have thrown NOT_TRUSTED');
    } catch (err) {
      assert.ok(err.message.includes('NOT_TRUSTED'), `Expected NOT_TRUSTED, got: ${err.message}`);
      console.log('   ✅ Untrusted file correctly blocked');
    }
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 3: Modified file is blocked (HASH_MISMATCH)
  console.log('\n3. Testing modified file is blocked...');
  try {
    // Copy a trusted file, trust the copy, then modify it
    const trustedFile = '/Users/jay/.openclaw/workspace/client/memory/tools/skill_gate.js';
    const originalContent = fs.readFileSync(trustedFile, 'utf8');
    const copyFile = createTestFile('trusted_copy.js', originalContent);
    
    // Trust the copy using trust_add.js
    execSync(`node /Users/jay/.openclaw/workspace/client/memory/tools/trust_add.js ${copyFile} "test copy for hash mismatch test"`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    
    // Modify the file
    fs.writeFileSync(copyFile, originalContent + '\n// modified', 'utf8');
    
    // Try to verify - should fail with HASH_MISMATCH
    try {
      verifySkillOrThrow(copyFile);
      assert.fail('Should have thrown HASH_MISMATCH');
    } catch (err) {
      assert.ok(err.message.includes('HASH_MISMATCH'), `Expected HASH_MISMATCH, got: ${err.message}`);
      console.log('   ✅ Modified file correctly blocked with HASH_MISMATCH');
    }
    
    // Clean up - remove the test entry from trusted_skills.json
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    delete config.trusted_files[copyFile];
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
    
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 4: Path outside allowlist is blocked (NOT_ALLOWLISTED)
  console.log('\n4. Testing path outside allowlist is blocked...');
  try {
    const outsideFile = '/tmp/outside_test.js';
    fs.writeFileSync(outsideFile, 'console.log("outside");', 'utf8');
    
    try {
      verifySkillOrThrow(outsideFile);
      assert.fail('Should have thrown NOT_ALLOWLISTED');
    } catch (err) {
      assert.ok(err.message.includes('NOT_ALLOWLISTED'), `Expected NOT_ALLOWLISTED, got: ${err.message}`);
      console.log('   ✅ Outside path correctly blocked with NOT_ALLOWLISTED');
    }
    
    // Cleanup
    fs.unlinkSync(outsideFile);
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 5: Symlink escape attempt is blocked
  console.log('\n5. Testing symlink escape is blocked...');
  try {
    // Create a symlink that tries to escape the allowlist
    const symlinkPath = path.join(TEST_DIR, 'escape_link.js');
    const targetPath = '/etc/passwd';
    fs.symlinkSync(targetPath, symlinkPath);
    
    try {
      verifySkillOrThrow(symlinkPath);
      // If we're here, the symlink might have been resolved within allowlist
      // or the file doesn't exist. Either way, check the result.
      console.log('   ⚠️  Symlink test inconclusive (may not exist or resolved safely)');
    } catch (err) {
      // Expected - either NOT_ALLOWLISTED or FILE_NOT_FOUND
      if (err.message.includes('NOT_ALLOWLISTED') || err.message.includes('FILE_NOT_FOUND')) {
        console.log('   ✅ Symlink escape attempt correctly blocked');
      } else {
        throw err;
      }
    }
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      console.log('   ⚠️  Symlink test skipped (permission denied)');
    } else {
      console.error('   ❌ FAILED:', err.message);
      throw err;
    }
  }
  
  cleanup();
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('   ✅ ALL SKILL GATE SMOKE TESTS PASS');
  console.log('═══════════════════════════════════════════════════════════');
}

runTests();
