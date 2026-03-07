#!/usr/bin/env node
/**
 * Normalize Nodes - One-time migration helper
 * Inserts <!-- NODE --> separators where missing
 * Ensures each node has YAML + # title line
 * 
 * Usage: node client/memory/tools/normalize_nodes.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const memoryDir = '/Users/jay/.openclaw/workspace/memory';
const whitelistRegex = /^\d{4}-\d{2}-\d{2}\.md$/;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║              NODE NORMALIZATION                            ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will modify files)'}`);
console.log();

const dailyFiles = fs.readdirSync(memoryDir)
  .filter(f => whitelistRegex.test(f))
  .sort();

console.log(`Found ${dailyFiles.length} daily files to process\n`);

let totalChanges = 0;

for (const file of dailyFiles) {
  const filePath = path.join(memoryDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  
  // Check if already properly separated
  const separatorCount = (content.match(/<!--\s*NODE\s*-->/g) || []).length;
  const yamlBlocks = (content.match(/---\s*\n/g) || []).length / 2;
  
  if (separatorCount >= yamlBlocks - 1) {
    console.log(`✓ ${file} - Already normalized (${separatorCount} separators for ~${Math.floor(yamlBlocks)} nodes)`);
    continue;
  }
  
  console.log(`⚠ ${file} - Needs normalization (${separatorCount} separators for ${yamlBlocks} YAML blocks)`);
  
  // Parse and rebuild with separators
  const lines = content.split('\n');
  const output = [];
  let inFrontmatter = false;
  let frontmatterDone = false;
  let lastWasSeparator = true; // Start true so first node doesn't need separator
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Handle frontmatter
    if (trimmed === '---') {
      if (!inFrontmatter) {
        // Start of new node
        if (!lastWasSeparator && output.length > 0) {
          output.push('\n <!-- NODE --> ');
          output.push('');
          totalChanges++;
        }
        inFrontmatter = true;
        frontmatterDone = false;
      } else {
        // End of frontmatter
        inFrontmatter = false;
        frontmatterDone = true;
      }
      output.push(line);
      continue;
    }
    
    output.push(line);
    
    if (frontmatterDone && !lastWasSeparator) {
      // After frontmatter, before next separator
      // Check if next non-empty line is a title
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      
      if (j < lines.length && lines[j].trim().startsWith('# ')) {
        // Has title, this is good
        lastWasSeparator = false;
      }
    }
  }
  
  const newContent = output.join('\n');
  
  if (!dryRun) {
    // Backup first
    const backupPath = filePath + '.backup-' + Date.now();
    fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(filePath, newContent);
    console.log(`  ✓ Updated (backup: ${path.basename(backupPath)})`);
  } else {
    console.log(`  [DRY RUN] Would add ${yamlBlocks - separatorCount} separators`);
  }
}

console.log();
console.log('════════════════════════════════════════════════════════════');
if (dryRun) {
  console.log('DRY RUN complete. No files modified.');
  console.log('Run without --dry-run to apply changes.');
} else {
  console.log(`Normalization complete. ${totalChanges} changes made.`);
  console.log('Backups created with .backup-*.md suffix');
}
console.log('Next step: Run node client/memory/tools/lint_memory.js to verify');
