#!/usr/bin/env node
/**
 * trust_add_habit.js - Wrapper to trust habits using the skill gate system
 */

const { execSync } = require('child_process');
const fs = require('fs');

const TRUSTED_HABITS_PATH = '/Users/jay/.openclaw/workspace/client/config/trusted_habits.json';
const TRUST_ADD_PATH = '/Users/jay/.openclaw/workspace/client/memory/tools/trust_add.js';

function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node trust_add_habit.js /path/to/habit.js "approval note"');
    console.error('Example: node trust_add_habit.js client/habits/routines/rebuild_validate_memory.js "Core validation habit"');
    process.exit(1);
  }
  
  const targetPath = args[0];
  const note = args[1];
  
  // Check file is in client/habits/routines
  if (!targetPath.includes('client/habits/routines')) {
    console.error('ERROR: Habit must be in client/habits/routines/ directory');
    process.exit(1);
  }
  
  // Use trust_add.js but write to trusted_habits.json
  // Since trust_add.js writes to trusted_skills.json, we need a habit-specific approach
  
  const { computeHash } = require('/Users/jay/.openclaw/workspace/client/memory/tools/skill_gate');
  const path = require('path');
  
  const resolvedPath = path.resolve(targetPath);
  
  if (!fs.existsSync(resolvedPath)) {
    console.error(`ERROR: File not found: ${resolvedPath}`);
    process.exit(1);
  }
  
  // Load trusted_habits.json
  let config = JSON.parse(fs.readFileSync(TRUSTED_HABITS_PATH, 'utf8'));
  
  // Check allowlist
  let inAllowlist = false;
  for (const root of config.allowlist_roots) {
    const realRoot = fs.realpathSync(root);
    const realPath = fs.realpathSync(resolvedPath);
    
    if (realPath.startsWith(realRoot + path.sep) || realPath === realRoot) {
      inAllowlist = true;
      break;
    }
  }
  
  if (!inAllowlist) {
    console.error(`ERROR: ${resolvedPath} is not in allowlist`);
    console.error('Allowlist:', config.allowlist_roots);
    process.exit(1);
  }
  
  // Compute hash
  const sha256 = computeHash(resolvedPath);
  const now = new Date().toISOString().split('T')[0];
  
  // Add/update trusted entry
  const existing = config.trusted_files[resolvedPath];
  
  config.trusted_files[resolvedPath] = {
    sha256,
    approved_by: 'jay',
    approved_at: now,
    note
  };
  
  // Save
  fs.writeFileSync(TRUSTED_HABITS_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  
  if (existing) {
    console.log(`✅ Updated trust for habit: ${resolvedPath}`);
    console.log(`   Previous: ${existing.sha256.substring(0, 16)}...`);
    console.log(`   New:      ${sha256.substring(0, 16)}...`);
  } else {
    console.log(`✅ Added trust for habit: ${resolvedPath}`);
    console.log(`   SHA-256: ${sha256}`);
  }
  console.log(`   Approved by: jay on ${now}`);
  console.log(`   Note: ${note}`);
  console.log('');
  console.log('Habit is now trusted and can be executed.');
}

main();
