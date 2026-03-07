#!/usr/bin/env node
/**
 * habit_list.js - List all habits with status and stats
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = '/Users/jay/.openclaw/workspace/client/habits/registry.json';
const TRUSTED_HABITS_PATH = '/Users/jay/.openclaw/workspace/client/config/trusted_habits.json';

function main() {
  const args = process.argv.slice(2);
  const showTrusted = args.includes('--trusted');
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                  HABIT REGISTRY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  
  console.log(`Version: ${registry.version}`);
  console.log(`Max active: ${registry.max_active}`);
  console.log(`GC: ${registry.gc.inactive_days}d inactive, ${registry.gc.min_uses_30d} uses/min`);
  console.log('');
  
  const active = registry.habits.filter(h => h.status === 'active');
  const archived = registry.habits.filter(h => h.status === 'archived');
  
  console.log(`Active: ${active.length} | Archived: ${archived.length} | Total: ${registry.habits.length}`);
  console.log('');
  
  if (active.length > 0) {
    console.log('ACTIVE HABITS:');
    console.log('─'.repeat(60));
    
    for (const habit of active) {
      console.log(`${habit.id}`);
      console.log(`  Name: ${habit.name}`);
      console.log(`  Desc: ${habit.description}`);
      console.log(`  Uses: ${habit.lifetime_uses} total, ${habit.uses_30d} last 30d`);
      console.log(`  Last used: ${habit.last_used_at || 'never'}`);
      console.log(`  Success rate: ${(habit.success_rate * 100).toFixed(0)}%`);
      console.log(`  Entrypoint: ${habit.entrypoint}`);
      console.log(`  Network: ${habit.permissions?.network || 'deny'}`);
      console.log(`  Est. tokens saved: ${habit.estimated_tokens_saved || 0}`);
      console.log('');
    }
  }
  
  if (archived.length > 0) {
    console.log('ARCHIVED HABITS:');
    console.log('─'.repeat(60));
    
    for (const habit of archived) {
      console.log(`${habit.id} [ARCHIVED]`);
      console.log(`  Name: ${habit.name}`);
      console.log(`  Lifetime uses: ${habit.lifetime_uses}`);
      console.log('');
    }
  }
  
  if (showTrusted) {
    console.log('');
    console.log('TRUSTED HABIT FILES:');
    console.log('─'.repeat(60));
    
    if (!fs.existsSync(TRUSTED_HABITS_PATH)) {
      console.log('  No trusted_habits.json found.');
    } else {
      const trusted = JSON.parse(fs.readFileSync(TRUSTED_HABITS_PATH, 'utf8'));
      const files = Object.entries(trusted.trusted_files || {});
      
      if (files.length === 0) {
        console.log('  No trusted habit files.');
      } else {
        for (const [filepath, info] of files) {
          console.log(`  ✅ ${filepath}`);
          console.log(`     SHA-256: ${info.sha256?.substring(0, 16)}...`);
          console.log(`     Approved: ${info.approved_by} on ${info.approved_at}`);
          console.log('');
        }
      }
    }
  }
  
  console.log('');
  console.log('USAGE:');
  console.log('  node client/habits/scripts/run_habit.js --list');
  console.log('  node client/habits/scripts/run_habit.js --id <habit_id> --json \'{}\'');
  console.log('  node client/habits/scripts/habit_list.js --trusted');
  console.log('');
}

main();
