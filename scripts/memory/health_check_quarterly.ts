#!/usr/bin/env node
/**
 * Quarterly Agent Health Check
 * Runs monthly on the 1st, but only executes in Jan/Apr/Jul/Oct (quarterly)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');

const now = new Date();
const month = now.getMonth() + 1;
const year = now.getFullYear();

const quarterlyMonths = [1, 4, 7, 10];

if (!quarterlyMonths.includes(month)) {
  console.log(`[Health Check] Skipping - month ${month} is not a quarterly check month.`);
  process.exit(0);
}

console.log(`╔════════════════════════════════════════════════════════════════╗`);
console.log(`║     QUARTERLY AGENT HEALTH CHECK - ${year} Q${Math.ceil(month/3)}           ║`);
console.log(`╚════════════════════════════════════════════════════════════════╝`);
console.log(`Date: ${now.toISOString()}`);
console.log();

// STEP 1: Lint
console.log('[1/4] Running lint check...');
console.log('───────────────────────────────────────────────');

let lintPassed = false;
let lintOutput = '';

try {
  const lintPath = path.join(__dirname, 'lint_memory.js');
  const lintTsPath = path.join(__dirname, 'lint_memory.ts');
  lintOutput = execSync(`node "${lintPath}"`, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 30000
  });
  lintPassed = true;
  console.log('✓ Lint passed - no formatting errors');
} catch (err) {
  try {
    const lintTsPath = path.join(__dirname, 'lint_memory.ts');
    lintOutput = execSync(`node "${lintTsPath}"`, {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      timeout: 30000
    });
    lintPassed = true;
    console.log('✓ Lint passed - no formatting errors');
  } catch (fallbackErr) {
  console.error('✗ LINT FAILED');
  console.error((fallbackErr && (fallbackErr.stdout || fallbackErr.message)) || err.stdout || err.message);
  console.log();
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║ ❌ HEALTH CHECK ABORTED - Fix lint errors before rebuild   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  process.exit(1);
  }
}

console.log();

// STEP 2: Rebuild
console.log('[2/4] Running index rebuild...');
console.log('───────────────────────────────────────────────');

try {
  const rebuildPath = path.join(__dirname, 'rebuild_exclusive.js');
  const rebuildTsPath = path.join(__dirname, 'rebuild_exclusive.ts');
  const result = execSync(`node "${rebuildPath}"`, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 60000
  });
  
  const output = result;
  
  // Extract key metrics
  const validNodesMatch = output.match(/Valid nodes: (\d+)/);
  const bloatMatch = output.match(/bloat: (\d+)/);
  const forcedChanges = output.match(/forced_changes: (\d+)/);
  const registryWarnings = output.match(/registry_warnings: (\d+)/);
  const tokenAvgMatch = output.match(/(\d+)\/node avg/);
  const snapshotsMatch = output.match(/Snapshots: (\d+) created/);
  
  console.log(`✓ Index rebuild completed`);
  console.log(`  • Valid nodes: ${validNodesMatch ? validNodesMatch[1] : 'unknown'}`);
  console.log(`  • Avg tokens/node: ${tokenAvgMatch ? tokenAvgMatch[1] : 'unknown'}`);
  console.log(`  • Bloat violations: ${bloatMatch ? bloatMatch[1] : '0'}`);
  console.log(`  • Registry warnings: ${registryWarnings ? registryWarnings[1] : '0'}`);
  console.log(`  • Forced changes: ${forcedChanges ? forcedChanges[1] : '0'}`);
  console.log(`  • Snapshots created: ${snapshotsMatch ? snapshotsMatch[1] : '0'}`);
  
  if (bloatMatch && parseInt(bloatMatch[1]) > 0) {
    console.log('\n⚠️  BLOAT VIOLATIONS DETECTED - review needed');
  }
  if (registryWarnings && parseInt(registryWarnings[1]) > 0) {
    console.log('\n⚠️  REGISTRY MISMATCHES DETECTED - review needed');
  }
  
} catch (err) {
  try {
    const rebuildTsPath = path.join(__dirname, 'rebuild_exclusive.ts');
    const result = execSync(`node "${rebuildTsPath}"`, {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      timeout: 60000
    });
    const output = result;

    const validNodesMatch = output.match(/Valid nodes: (\d+)/);
    const bloatMatch = output.match(/bloat: (\d+)/);
    const forcedChanges = output.match(/forced_changes: (\d+)/);
    const registryWarnings = output.match(/registry_warnings: (\d+)/);
    const tokenAvgMatch = output.match(/(\d+)\/node avg/);
    const snapshotsMatch = output.match(/Snapshots: (\d+) created/);

    console.log(`✓ Index rebuild completed`);
    console.log(`  • Valid nodes: ${validNodesMatch ? validNodesMatch[1] : 'unknown'}`);
    console.log(`  • Avg tokens/node: ${tokenAvgMatch ? tokenAvgMatch[1] : 'unknown'}`);
    console.log(`  • Bloat violations: ${bloatMatch ? bloatMatch[1] : '0'}`);
    console.log(`  • Registry warnings: ${registryWarnings ? registryWarnings[1] : '0'}`);
    console.log(`  • Forced changes: ${forcedChanges ? forcedChanges[1] : '0'}`);
    console.log(`  • Snapshots created: ${snapshotsMatch ? snapshotsMatch[1] : '0'}`);
  } catch (fallbackErr) {
    console.error('✗ Index rebuild failed:', (fallbackErr && (fallbackErr.stdout || fallbackErr.message)) || err.message);
    process.exit(1);
  }
}

console.log();

// STEP 3: Critical file check
console.log('[3/4] Checking critical files...');
console.log('───────────────────────────────────────────────');

const criticalFiles = [
  '~/.openclaw/workspace/client/runtime/config/model_adapters.json',
  '~/.openclaw/workspace/memory/MEMORY_INDEX.md',
  '~/.openclaw/workspace/memory/TAGS_INDEX.md',
  '~/.openclaw/workspace/memory/SNIPPET_INDEX.md',
  '~/.openclaw/workspace/scripts/memory/lint_memory.ts',
  '~/.openclaw/workspace/scripts/memory/rebuild_exclusive.ts'
];

let filesOK = 0;
for (const file of criticalFiles) {
  const resolvedPath = file.replace('~', process.env.HOME);
  if (fs.existsSync(resolvedPath)) {
    const stats = fs.statSync(resolvedPath);
    console.log(`✓ ${file} (${(stats.size / 1024).toFixed(1)} KB)`);
    filesOK++;
  } else {
    console.log(`✗ ${file} MISSING`);
  }
}

console.log();

// STEP 4: Cron check
console.log('[4/4] Checking cron jobs...');
console.log('───────────────────────────────────────────────');

try {
  const cronOutput = execSync('openclaw cron list', {
    encoding: 'utf8',
    timeout: 10000
  });
  const jobCount = (cronOutput.match(/\n/g) || []).length - 1;
  console.log(`✓ Active cron jobs: ${jobCount}`);
  console.log('  Run: openclaw cron list to see all jobs');
} catch (err) {
  console.log('⚠️ Could not query cron list (non-fatal)');
}

console.log();

// PORTABILITY CHECKLIST
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║     PORTABILITY CHECKLIST - Snapshot Reminder              ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log();
console.log('BACKUP THIS AGENT:');
console.log();
console.log('Required snapshots:');
console.log('  ☐ ~/.openclaw/workspace/memory/ (nodes + indices)');
console.log('  ☐ ~/.openclaw/workspace/local/state/memory/ (snapshots + rebuild cache)');
console.log('  ☐ ~/.openclaw/workspace/client/cognition/skills/ (if custom)');
console.log('  ☐ ~/.openclaw/workspace/client/runtime/config/ (model_adapters.json + credentials)');
console.log('  ☐ Cron list: openclaw cron list → save to file');
console.log();
console.log('Quick backup command:');
console.log('  tar -czf protheus-backup-$(date +%Y%m%d).tar.gz \\\
');
console.log('    ~/.openclaw/workspace/memory/ \\\
');
console.log('    ~/.openclaw/workspace/local/state/memory/ \\\
');
console.log('    ~/.openclaw/workspace/client/runtime/config/');
console.log();
console.log('Restore test:');
console.log('  1) Install OpenClaw + deps on new machine');
console.log('  2) Restore backup directories');
console.log('  3) Run: node scripts/memory/lint_memory.ts');
console.log('  4) Run: node scripts/memory/rebuild_exclusive.ts');
console.log('  5) Verify: indices correct, no bloat/format errors');
console.log();
console.log('════════════════════════════════════════════════════════════════');
console.log(`Health check complete. Status: ${filesOK === criticalFiles.length ? 'HEALTHY' : 'NEEDS ATTENTION'}`);
console.log('Next check: next quarterly month (Jan/Apr/Jul/Oct)');
