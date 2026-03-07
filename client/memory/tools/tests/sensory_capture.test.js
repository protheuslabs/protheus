#!/usr/bin/env node
/**
 * sensory_capture.test.js - Tests for Sensory Layer v1.0
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Test directory setup
const TEST_DIR = path.join(__dirname, '..', '..', '..', 'state', 'sensory_test');

function setup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  
  // Create test work root
  const tempRoot = path.join(TEST_DIR, 'work_root');
  fs.mkdirSync(tempRoot, { recursive: true });
  
  // Create test files with recent mtime
  for (let i = 0; i < 5; i++) {
    const filePath = path.join(tempRoot, `testfile${i}.js`);
    fs.writeFileSync(filePath, `// test file ${i}`);
    const now = new Date();
    fs.utimesSync(filePath, now, now);
  }
  
  // Create test config
  const testConfig = {
    version: '1.0',
    roots: [tempRoot],
    ignore_patterns: ['node_modules', '.git'],
    limits: {
      max_events_per_run: 10,
      max_files_per_root: 5,
      lookback_hours_default: 24
    }
  };
  
  fs.writeFileSync(
    path.join(TEST_DIR, 'test_config.json'),
    JSON.stringify(testConfig, null, 2)
  );
}

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// Create temp sensory directory for testing actual module
const SENSORY_TEST_DIR = path.join(__dirname, '..', '..', '..', 'state', 'sensory');

function runTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   SENSORY LAYER v1.0 TESTS');
  console.log('═══════════════════════════════════════════════════════════');
  
  // Ensure real sensory dir exists
  const rawDir = path.join(SENSORY_TEST_DIR, 'raw');
  if (!fs.existsSync(rawDir)) {
    fs.mkdirSync(rawDir, { recursive: true });
  }
  
  setup();
  
  // Test 1: note command writes single event
  console.log('\n1. Testing note command...');
  try {
    // Clear today's log first
    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(rawDir, `${today}.jsonl`);
    if (fs.existsSync(logPath)) {
      fs.rmSync(logPath);
    }
    
    // Run note via CLI
    const { execSync } = require('child_process');
    execSync('node client/habits/scripts/sensory_capture.js note "Test note from sensory capture test"', {
      cwd: path.join(__dirname, '..', '..', '..'),
      encoding: 'utf8'
    });
    
    assert.ok(fs.existsSync(logPath), 'Log file should exist after note');
    
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(l => l);
    assert.ok(lines.length >= 1, 'Should have at least 1 line in JSONL');
    
    const event = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(event.type, 'note', 'Should be note type');
    assert.strictEqual(event.source, 'manual', 'Should have manual source');
    assert.ok(event.ts, 'Should have timestamp');
    
    console.log('   ✅ Note command writes single JSONL event');
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 2: JSONL format is valid and append-only
  console.log('\n2. Testing JSONL format validity...');
  try {
    const { execSync } = require('child_process');
    
    // Add more notes
    execSync('node client/habits/scripts/sensory_capture.js note "Second note"', {
      cwd: path.join(__dirname, '..', '..', '..'),
      encoding: 'utf8'
    });
    execSync('node client/habits/scripts/sensory_capture.js note "Third note"', {
      cwd: path.join(__dirname, '..', '..', '..'),
      encoding: 'utf8'
    });
    
    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(rawDir, `${today}.jsonl`);
    
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l);
    
    // Each line must be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.ts, 'Each event must have timestamp');
      assert.ok(parsed.type, 'Each event must have type');
      assert.ok(parsed.source, 'Each event must have source');
    }
    
    console.log(`   ✅ JSONL format valid: ${lines.length} lines, all parseable`);
    
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 3: show command returns correct structure
  console.log('\n3. Testing show command...');
  try {
    const { execSync } = require('child_process');
    
    const output = execSync('node client/habits/scripts/sensory_capture.js show --days=1', {
      cwd: path.join(__dirname, '..', '..', '..'),
      encoding: 'utf8'
    });
    
    assert.ok(output.includes('SENSORY LAYER SUMMARY'), 'Show output should have header');
    assert.ok(output.includes('note:'), 'Show output should mention note type');
    
    console.log('   ✅ Show command produces valid summary');
    console.log(`      Output preview: ${output.split('\n')[0]}...`);
    
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 4: capture command with config
  console.log('\n4. Testing capture command with work_roots config...');
  try {
    const { execSync } = require('child_process');
    
    // Create a temp config file that points to our test root
    const tempConfig = path.join(TEST_DIR, 'temp_work_roots.json');
    const tempRoot = path.join(TEST_DIR, 'work_root');
    
    // Create more files in test root
    for (let i = 0; i < 3; i++) {
      const filePath = path.join(tempRoot, `capture${i}.txt`);
      fs.writeFileSync(filePath, `capture test ${i}`);
      const now = new Date();
      fs.utimesSync(filePath, now, now);
    }
    
    const testConfig = {
      version: '1.0',
      roots: [tempRoot],
      ignore_patterns: ['node_modules', '.git'],
      limits: {
        max_events_per_run: 5,
        max_files_per_root: 3,
        lookback_hours_default: 24
      }
    };
    
    fs.writeFileSync(tempConfig, JSON.stringify(testConfig, null, 2));
    
    // Copy to real location temporarily
    const realConfig = path.join(__dirname, '..', '..', '..', 'config', 'work_roots.json');
    const backupConfig = path.join(TEST_DIR, 'backup_work_roots.json');
    
    if (fs.existsSync(realConfig)) {
      fs.copyFileSync(realConfig, backupConfig);
    }
    fs.copyFileSync(tempConfig, realConfig);
    
    try {
      const output = execSync('node client/habits/scripts/sensory_capture.js capture', {
        cwd: path.join(__dirname, '..', '..', '..'),
        encoding: 'utf8'
      });
      
      assert.ok(output.includes('Captured') || output.includes('events'), 'Capture should report events');
      console.log(`   ✅ Capture command works: ${output.trim()}`);
      
    } finally {
      // Restore original config
      if (fs.existsSync(backupConfig)) {
        fs.copyFileSync(backupConfig, realConfig);
      }
    }
    
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('   ✅ ALL SENSORY LAYER TESTS PASS (4 tests)');
  console.log('═══════════════════════════════════════════════════════════');
  
  cleanup();
}

// Run tests
try {
  runTests();
} catch (err) {
  console.error('\nTest suite failed:', err.message);
  cleanup();
  process.exit(1);
}
