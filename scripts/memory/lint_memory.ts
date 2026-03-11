#!/usr/bin/env node
/**
 * Memory Lint - Validates node format before rebuild
 * Exit 0 = clean, Exit 1 = errors found
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const memoryDir = process.env.MEMORY_DIR || path.join(WORKSPACE_ROOT, 'memory');
const whitelistRegex = /^\d{4}-\d{2}-\d{2}\.md$/;
const UID_PATTERN = /^[A-Za-z0-9]+$/;
const UID_ENFORCE_SINCE = normalizeDate(process.env.MEMORY_UID_ENFORCE_SINCE || '2026-02-22');

const errors = [];
const filesScanned = [];
let totalNodes = 0;

function reportError(file, nodeId, reason) {
  errors.push({ file, node_id: nodeId || '(unknown)', reason });
}

function normalizeDate(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '2026-02-22';
}

function requiresUid(nodeDate) {
  const d = normalizeDate(nodeDate);
  return d >= UID_ENFORCE_SINCE;
}

// Get all whitelisted files
const dailyFiles = fs.readdirSync(memoryDir)
  .filter(f => whitelistRegex.test(f))
  .sort();

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║              MEMORY LINT REPORT                           ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log(`Scanning ${dailyFiles.length} whitelisted files...\n`);

const seenNodeIds = new Set();
const seenUids = new Set();

for (const file of dailyFiles) {
  const filePath = path.join(memoryDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  filesScanned.push(file);

  // Skip if content is empty
  if (!content.trim()) {
    reportError(file, null, 'EMPTY_FILE');
    continue;
  }

  // Split on NODE separator
  const chunks = content.split(/\s*<!--\s*NODE\s*-->\s*/).filter(c => c.trim());
  
  for (const [idx, chunk] of chunks.entries()) {
    totalNodes++;
    const trimmed = chunk.trim();
    
    // Check for YAML frontmatter
    const fmMatch = trimmed.match(/^(---\s*\n)([\s\S]*?)(\n---\s*\n)/);
    if (!fmMatch) {
      reportError(file, null, `NODE_${idx + 1}_MISSING_YAML_FRONTMATTER`);
      continue;
    }

    const fm = fmMatch[2];
    const afterYaml = trimmed.slice(fmMatch[0].length);

    // Check node_id exists
    const nodeIdMatch = fm.match(/node_id:\s*(\S+)/);
    const dateMatch = fm.match(/date:\s*(\d{4}-\d{2}-\d{2})/);
    const nodeDate = dateMatch ? dateMatch[1] : file.replace('.md', '');
    if (!nodeIdMatch) {
      reportError(file, null, `NODE_${idx + 1}_MISSING_NODE_ID`);
      continue;
    }
    const nodeId = nodeIdMatch[1];

    // Check node_id format (kebab-case)
    if (!nodeId.match(/^[a-z0-9-]+$/)) {
      reportError(file, nodeId, `NODE_ID_NOT_KEBAB"${nodeId}"`);
    }

    // Check node_id uniqueness
    if (seenNodeIds.has(nodeId)) {
      reportError(file, nodeId, 'DUPLICATE_NODE_ID');
    } else {
      seenNodeIds.add(nodeId);
    }

    // Enforce immutable alphanumeric uid for forward nodes (legacy before cutoff is allowed).
    const uidMatch = fm.match(/uid:\s*(\S+)/);
    const uidRequired = requiresUid(nodeDate);
    if (!uidMatch) {
      if (uidRequired) {
        reportError(file, nodeId, `NODE_${idx + 1}_MISSING_UID_REQUIRED`);
      }
    } else {
      const uid = String(uidMatch[1] || '').trim();
      if (!UID_PATTERN.test(uid)) {
        reportError(file, nodeId, `UID_NOT_ALPHANUM"${uid}"`);
      } else if (seenUids.has(uid)) {
        reportError(file, nodeId, 'DUPLICATE_UID');
      } else {
        seenUids.add(uid);
      }
    }

    // Check tags exists and is parseable
    const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/);
    if (!tagsMatch) {
      reportError(file, nodeId, 'MISSING_TAGS_OR_MALFORMED');
    } else {
      const tagsContent = tagsMatch[1];
      // Check individual tags are lowercase kebab
      const tagTokens = tagsContent.split(',').map(t => t.trim()).filter(t => t);
      for (const tag of tagTokens) {
        if (!tag.match(/^[a-z0-9-]+$/) && !tag.match(/^#[a-z0-9-]+$/)) {
          reportError(file, nodeId, `TAG_NOT_KEBAB"${tag}"`);
        }
      }
    }

    // Check for title line
    const titleMatch = afterYaml.match(/^#\s*(.+)$/m);
    if (!titleMatch) {
      reportError(file, nodeId, 'MISSING_TITLE_LINE_AFTER_YAML');
    }

    // Check edges if present
    if (fm.includes('edges_from:')) {
      const edgesFromMatch = fm.match(/edges_from:\s*\[([^\]]*)\]/);
      if (!edgesFromMatch) {
        reportError(file, nodeId, 'EDGES_FROM_MALFORMED');
      }
    }
    if (fm.includes('edges_to:')) {
      const edgesToMatch = fm.match(/edges_to:\s*\[([^\]]*)\]/);
      if (!edgesToMatch && !fm.includes('edges_to: []')) {
        reportError(file, nodeId, 'EDGES_TO_MALFORMED');
      }
    }
  }
}

// Print report
console.log(`FILES SCANNED: ${filesScanned.length}`);
console.log(`NODES FOUND: ${totalNodes}`);
console.log(`UNIQUE NODE IDs: ${seenNodeIds.size}`);
console.log(`UNIQUE UIDs: ${seenUids.size}`);
console.log(`UID ENFORCE SINCE: ${UID_ENFORCE_SINCE}`);
console.log();

if (errors.length > 0) {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║ ❌ ERRORS FOUND (REBUILD ABORTED)                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log();
  console.log('| File | Node ID | Reason |');
  console.log('|------|---------|--------|');
  for (const err of errors) {
    console.log(`| ${err.file} | ${err.node_id} | ${err.reason} |`);
  }
  console.log();
  console.log(`Total errors: ${errors.length}`);
  console.log('Lint FAILED. Indices NOT regenerated. Fix errors and retry.');
  process.exit(1);
} else {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║ ✅ LINT PASSED - All nodes valid                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log();
  console.log('- All files whitelisted and parseable');
  console.log('- All nodes have valid YAML frontmatter');
  console.log('- All node_ids unique and kebab-case');
  console.log('- All required uids present and alphanumeric');
  console.log('- All tags well-formed');
  console.log('- All titles present');
  console.log();
  console.log('Safe to proceed with rebuild.');
  process.exit(0);
}
