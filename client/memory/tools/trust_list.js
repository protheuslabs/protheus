#!/usr/bin/env node
/**
 * trust_list.js - List all trusted skills
 * Usage: node trust_list.js [--diff]
 */

const fs = require('fs');
const path = require('path');
const { computeHash, expandHome, CONFIG_PATH } = require('./skill_gate');

function main() {
  const args = process.argv.slice(2);
  const showDiff = args.includes('--diff');
  
  // Load config
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`ERROR: Failed to load config from ${CONFIG_PATH}: ${err.message}`);
    process.exit(1);
  }
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('             TRUSTED SKILLS REGISTRY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();
  console.log('Allowlist roots:');
  config.allowlist_roots.forEach(root => {
    console.log(`  • ${expandHome(root)}`);
  });
  console.log();
  
  const entries = Object.entries(config.trusted_files);
  
  if (entries.length === 0) {
    console.log('No trusted files yet.');
    console.log();
    console.log('To add a skill:');
    console.log('  node trust_add.js /path/to/skill.js "approval note"');
    return;
  }
  
  console.log(`Trusted files: ${entries.length}`);
  console.log();
  
  let changedCount = 0;
  
  for (const [filepath, info] of entries) {
    const exists = fs.existsSync(filepath);
    let status = exists ? '✅' : '❌ MISSING';
    let diff = '';
    
    if (exists && showDiff) {
      const currentHash = computeHash(filepath);
      if (currentHash !== info.sha256) {
        status = '⚠️  CHANGED';
        diff = `\n   Current hash:  ${currentHash}\n   Trusted hash:  ${info.sha256}`;
        changedCount++;
      }
    }
    
    console.log(`${status} ${filepath}`);
    console.log(`   SHA-256:      ${info.sha256}`);
    console.log(`   Approved by:  ${info.approved_by} on ${info.approved_at}`);
    console.log(`   Note:         ${info.note}`);
    if (diff) console.log(diff);
    console.log();
  }
  
  if (showDiff && changedCount > 0) {
    console.log(`⚠️  ${changedCount} file(s) have been modified since approval.`);
    console.log('   Run trust_add.js to re-approve if the changes are intentional.');
  }
  
  console.log('═══════════════════════════════════════════════════════════');
}

main();
