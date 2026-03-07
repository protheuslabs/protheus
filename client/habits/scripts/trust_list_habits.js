#!/usr/bin/env node
/**
 * trust_list_habits.js - List trusted habits
 */

const fs = require('fs');

const TRUSTED_HABITS_PATH = '/Users/jay/.openclaw/workspace/client/config/trusted_habits.json';

function main() {
  const args = process.argv.slice(2);
  const showDiff = args.includes('--diff');
  
  if (!fs.existsSync(TRUSTED_HABITS_PATH)) {
    console.error('ERROR: trusted_habits.json not found');
    process.exit(1);
  }
  
  const config = JSON.parse(fs.readFileSync(TRUSTED_HABITS_PATH, 'utf8'));
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('             TRUSTED HABITS REGISTRY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('Allowlist roots:');
  config.allowlist_roots.forEach(root => {
    console.log(`  • ${root}`);
  });
  console.log('');
  
  const entries = Object.entries(config.trusted_files);
  
  if (entries.length === 0) {
    console.log('No trusted habits yet.');
    console.log('');
    console.log('To approve a habit:');
    console.log('  node client/habits/scripts/trust_add_habit.js client/habits/routines/<habit>.js "approval note"');
    return;
  }
  
  console.log(`Trusted habits: ${entries.length}`);
  console.log('');
  
  let changedCount = 0;
  const { computeHash } = require('/Users/jay/.openclaw/workspace/client/memory/tools/skill_gate');
  
  for (const [filepath, info] of entries) {
    const exists = fs.existsSync(filepath);
    let status = exists ? '✅' : '❌ MISSING';
    let diff = '';
    
    if (exists && showDiff) {
      const currentHash = computeHash(filepath);
      if (currentHash !== info.sha256) {
        status = '⚠️  CHANGED';
        diff = `\n   Current: ${currentHash}\n   Trusted: ${info.sha256}`;
        changedCount++;
      }
    }
    
    console.log(`${status} ${filepath}`);
    console.log(`   SHA-256: ${info.sha256.substring(0, 32)}...`);
    console.log(`   Approved: ${info.approved_by} on ${info.approved_at}`);
    console.log(`   Note: ${info.note}`);
    if (diff) console.log(diff);
    console.log('');
  }
  
  if (showDiff && changedCount > 0) {
    console.log(`⚠️  ${changedCount} habit(s) modified since approval.`);
  }
  
  console.log('═══════════════════════════════════════════════════════════');
}

main();
