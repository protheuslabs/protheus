#!/usr/bin/env node
/**
 * Quarterly Agent Health Check
 * Runs monthly on the 1st, but only executes in Jan/Apr/Jul/Oct (quarterly)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
  lintOutput = execSync(`node "${lintPath}"`, {
    cwd: '/Users/jay/.openclaw/workspace',
    encoding: 'utf8',
    timeout: 30000
  });
  lintPassed = true;
  console.log('✓ Lint passed - no formatting errors');
} catch (err) {
  console.error('✗ LINT FAILED');
  console.error(err.stdout || err.message);
  console.log();
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║ ❌ HEALTH CHECK ABORTED - Fix lint errors before rebuild   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  process.exit(1);
}

console.log();

// STEP 2: Rebuild
console.log('[2/4] Running index rebuild...');
console.log('───────────────────────────────────────────────');

try {
  const rebuildPath = path.join(__dirname, 'rebuild_exclusive.js');
  const result = execSync(`node "${rebuildPath}"`, {
    cwd: '/Users/jay/.openclaw/workspace',
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
  console.error('✗ Index rebuild failed:', err.message);
  process.exit(1);
}

console.log();

// STEP 3: Critical file check
console.log('[3/4] Checking critical files...');
console.log('───────────────────────────────────────────────');

const criticalFiles = [
  '~/.openclaw/workspace/client/config/model_adapters.json',
  '~/.openclaw/workspace/client/memory/MEMORY_INDEX.md',
  '~/.openclaw/workspace/client/memory/TAGS_INDEX.md',
  '~/.openclaw/workspace/client/memory/SNIPPET_INDEX.md',
  '~/.openclaw/workspace/client/memory/tools/lint_memory.js',
  '~/.openclaw/workspace/client/memory/tools/rebuild_exclusive.js'
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
console.log('  ☐ ~/.openclaw/workspace/client/memory/ (nodes + indices + tools)');
console.log('  ☐ ~/.openclaw/workspace/client/skills/ (if custom)');
console.log('  ☐ ~/.openclaw/workspace/client/config/ (model_adapters.json + credentials)');
console.log('  ☐ Cron list: openclaw cron list → save to file');
console.log();
console.log('Quick backup command:');
console.log('  tar -czf protheus-backup-$(date +%Y%m%d).tar.gz \\\
');
console.log('    ~/.openclaw/workspace/client/memory/ \\\
');
console.log('    ~/.openclaw/workspace/client/config/');
console.log();
console.log('Restore test:');
console.log('  1) Install OpenClaw + deps on new machine');
console.log('  2) Restore backup directories');
console.log('  3) Run: node client/memory/tools/lint_memory.js');
console.log('  4) Run: node client/memory/tools/rebuild_exclusive.js');
console.log('  5) Verify: indices correct, no bloat/format errors');
console.log();
console.log('════════════════════════════════════════════════════════════════');
console.log(`Health check complete. Status: ${filesOK === criticalFiles.length ? 'HEALTHY' : 'NEEDS ATTENTION'}`);
console.log('Next check: next quarterly month (Jan/Apr/Jul/Oct)');
