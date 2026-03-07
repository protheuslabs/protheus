#!/usr/bin/env node
/**
 * check_versions.js - Protheus Layer Version Tracker
 * 
 * Usage: node client/habits/scripts/check_versions.js
 *        node client/habits/scripts/check_versions.js --check <layer>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSIONS_FILE = path.join(__dirname, '..', '..', 'config', 'layer_versions.json');

function loadVersions() {
  if (!fs.existsSync(VERSIONS_FILE)) {
    console.error('❌ Layer versions file not found:', VERSIONS_FILE);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8'));
}

function getFileHash(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch (e) {
    return 'NOT_FOUND';
  }
}

function formatVersion(versions, layerName) {
  const layer = versions.layers.find(l => l.name === layerName);
  if (!layer) return `❌ ${layerName}: not found`;
  
  const fullPath = path.join(__dirname, '..', '..', layer.path);
  const hash = getFileHash(fullPath);
  const exists = fs.existsSync(fullPath) ? '✅' : '❌';
  
  return `${exists} ${layer.name} @ ${layer.current_version} (${hash})`;
}

function printAllVersions() {
  const versions = loadVersions();
  
  console.log('═══════════════════════════════════════');
  console.log('  PROTHEUS LAYER VERSIONS');
  console.log('  Last updated:', versions.last_updated);
  console.log('═══════════════════════════════════════\n');
  
  for (const layer of versions.layers) {
    console.log(formatVersion(versions, layer.name));
    console.log('   Path:', layer.path);
    console.log('   Features:', layer.features.length);
    
    // Show changelog
    const changes = Object.entries(layer.changelog)
      .map(([v, desc]) => `     ${v}: ${desc}`)
      .join('\n');
    console.log('   Changelog:\n' + changes);
    console.log();
  }
  
  console.log('═══════════════════════════════════════');
  console.log('To update a layer: edit file, then update client/config/layer_versions.json');
}

function checkLayer(layerName) {
  const versions = loadVersions();
  const layer = versions.layers.find(l => l.name === layerName);
  
  if (!layer) {
    console.error(`❌ Layer "${layerName}" not found in version registry`);
    console.log('Available layers:', versions.layers.map(l => l.name).join(', '));
    process.exit(1);
  }
  
  const fullPath = path.join(__dirname, '..', '..', layer.path);
  const exists = fs.existsSync(fullPath);
  const hash = exists ? getFileHash(fullPath) : 'MISSING';
  
  console.log(JSON.stringify({
    name: layer.name,
    version: layer.current_version,
    path: layer.path,
    exists: exists,
    hash: hash,
    features: layer.features,
    changelog: layer.changelog
  }, null, 2));
}

// CLI
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--all') {
  printAllVersions();
} else if (args[0] === '--check' && args[1]) {
  checkLayer(args[1]);
} else if (args[0] === '--help') {
  console.log('Usage: node check_versions.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --all          Show all layers (default)');
  console.log('  --check NAME   Check specific layer');
  console.log('  --help         Show this help');
} else {
  console.error('Unknown command:', args[0]);
  process.exit(1);
}
