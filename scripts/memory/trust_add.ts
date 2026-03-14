#!/usr/bin/env node
/**
 * trust_add.js - Add a skill to the trusted list
 * Usage: node trust_add.js /path/to/skill.js "approval note"
 */

const fs = require('fs');
const path = require('path');
const { computeHash, normalizePath, WORKSPACE_ROOT, CONFIG_PATH } = require('./skill_gate');

function toWorkspaceToken(filepath) {
  const normalizedRoot = path.resolve(WORKSPACE_ROOT);
  const normalizedPath = path.resolve(filepath);
  if (normalizedPath === normalizedRoot) return '${WORKSPACE_ROOT}';
  if (normalizedPath.startsWith(normalizedRoot + path.sep)) {
    return '${WORKSPACE_ROOT}/' + path.relative(normalizedRoot, normalizedPath).replace(/\\/g, '/');
  }
  return normalizedPath;
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node trust_add.js /path/to/skill.js "approval note"');
    console.error('Example: node trust_add.js ./scripts/memory/rebuild_exclusive.ts "Core memory index rebuild tool"');
    process.exit(1);
  }
  
  const targetPath = args[0];
  const note = args[1];
  const approvedBy = process.env.OPENCLAW_APPROVER || process.env.USER || 'operator';
  
  // Resolve path
  const resolvedPath = normalizePath(targetPath);
  
  // Check file exists
  if (!fs.existsSync(resolvedPath)) {
    console.error(`ERROR: File not found: ${resolvedPath}`);
    process.exit(1);
  }
  
  // Load config
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`ERROR: Failed to load config from ${CONFIG_PATH}: ${err.message}`);
    process.exit(1);
  }
  
  // Check allowlist
  let inAllowlist = false;
  for (const root of config.allowlist_roots) {
    const realRoot = fs.realpathSync(normalizePath(root));
    const realPath = fs.realpathSync(resolvedPath);
    
    if (realPath.startsWith(realRoot + path.sep) || realPath === realRoot) {
      inAllowlist = true;
      break;
    }
  }
  
  if (!inAllowlist) {
    console.error(`ERROR: ${resolvedPath} is not within any allowlist root.`);
    console.error('Allowlist roots:', config.allowlist_roots);
    console.error('To add a new root, edit', CONFIG_PATH);
    process.exit(1);
  }
  
  // Compute hash
  const sha256 = computeHash(resolvedPath);
  const trustedKey = toWorkspaceToken(resolvedPath);
  
  // Add/update trusted entry
  const now = new Date().toISOString().split('T')[0];
  const existing = config.trusted_files[trustedKey];
  
  config.trusted_files[trustedKey] = {
    sha256,
    approved_by: approvedBy,
    approved_at: now,
    note
  };
  
  // Save config
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  
  if (existing) {
    console.log(`✅ Updated trust for: ${resolvedPath}`);
    console.log(`   Previous hash: ${existing.sha256}`);
    console.log(`   New hash:      ${sha256}`);
    console.log(`   Approved by:   ${approvedBy} on ${now}`);
    console.log(`   Note:          ${note}`);
  } else {
    console.log(`✅ Added trust for: ${resolvedPath}`);
    console.log(`   SHA-256:       ${sha256}`);
    console.log(`   Approved by:   ${approvedBy} on ${now}`);
    console.log(`   Note:          ${note}`);
  }
}

main();
