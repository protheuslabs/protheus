#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { loadPrimitiveCatalog, describePrimitiveOpcode } = require('./primitive_catalog.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATION_PATH = process.env.PRIMITIVE_MIGRATION_CONTRACT_PATH
  ? path.resolve(process.env.PRIMITIVE_MIGRATION_CONTRACT_PATH)
  : path.join(ROOT, 'config', 'primitive_migration_contract.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .replace(/[^a-zA-Z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeUpperToken(v: unknown, maxLen = 120) {
  return normalizeToken(v, maxLen).toUpperCase();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[token.slice(2)] = true;
    else out[token.slice(2, idx)] = token.slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/primitives/primitive_registry.js status');
  console.log('  node systems/primitives/primitive_registry.js describe --opcode=<OPCODE>');
  console.log('  node systems/primitives/primitive_registry.js audit');
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function collectOpcodes(catalog: AnyObj) {
  const set = new Set<string>();
  const defaultOpcode = normalizeUpperToken(catalog.default_command_opcode || 'SHELL_EXECUTE', 80) || 'SHELL_EXECUTE';
  set.add(defaultOpcode);
  set.add('RECEIPT_VERIFY');
  set.add('FLOW_GATE');
  set.add('ACTUATION_ADAPTER');
  for (const row of Array.isArray(catalog.command_rules) ? catalog.command_rules : []) {
    const opcode = normalizeUpperToken(row && row.opcode ? row.opcode : '', 80);
    if (opcode) set.add(opcode);
  }
  const adapterOpcodeMap = catalog.adapter_opcode_map && typeof catalog.adapter_opcode_map === 'object'
    ? catalog.adapter_opcode_map
    : {};
  for (const v of Object.values(adapterOpcodeMap)) {
    const opcode = normalizeUpperToken(v, 80);
    if (opcode) set.add(opcode);
  }
  return Array.from(set).sort();
}

function activeMigrationOpcodes() {
  const migration = readJson(MIGRATION_PATH, {});
  const list = Array.isArray(migration.active_opcodes)
    ? migration.active_opcodes
    : Array.isArray(migration.opcodes) ? migration.opcodes : [];
  return new Set(list.map((row: unknown) => normalizeUpperToken(row, 80)).filter(Boolean));
}

function cmdStatus() {
  const catalog = loadPrimitiveCatalog();
  const opcodes = collectOpcodes(catalog);
  const migrationSet = activeMigrationOpcodes();
  const metadataMap = catalog.opcode_metadata && typeof catalog.opcode_metadata === 'object'
    ? catalog.opcode_metadata
    : {};
  const missingMetadata = opcodes.filter((opcode) => !metadataMap[opcode]);
  const missingMigration = opcodes.filter((opcode) => !migrationSet.has(opcode));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'primitive_registry_status',
    ts: nowIso(),
    catalog_version: catalog.schema_version || '1.0',
    opcode_count: opcodes.length,
    opcodes,
    metadata_coverage_ratio: opcodes.length > 0
      ? Number(((opcodes.length - missingMetadata.length) / opcodes.length).toFixed(6))
      : 1,
    migration_coverage_ratio: opcodes.length > 0
      ? Number(((opcodes.length - missingMigration.length) / opcodes.length).toFixed(6))
      : 1,
    missing_metadata: missingMetadata,
    missing_migration: missingMigration
  })}\n`);
}

function cmdDescribe(args: AnyObj) {
  const opcode = normalizeUpperToken(args.opcode || '', 80);
  if (!opcode) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'primitive_registry_describe', error: 'opcode_required' })}\n`);
    process.exit(1);
  }
  const catalog = loadPrimitiveCatalog();
  const desc = describePrimitiveOpcode(opcode, catalog);
  const migrationSet = activeMigrationOpcodes();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'primitive_registry_describe',
    opcode,
    descriptor: desc,
    migration_active: migrationSet.has(opcode)
  })}\n`);
}

function cmdAudit() {
  const statusPayload = JSON.parse(String((() => {
    const catalog = loadPrimitiveCatalog();
    const opcodes = collectOpcodes(catalog);
    const migrationSet = activeMigrationOpcodes();
    const metadataMap = catalog.opcode_metadata && typeof catalog.opcode_metadata === 'object'
      ? catalog.opcode_metadata
      : {};
    const missingMetadata = opcodes.filter((opcode) => !metadataMap[opcode]);
    const missingMigration = opcodes.filter((opcode) => !migrationSet.has(opcode));
    return JSON.stringify({
      ok: missingMetadata.length === 0 && missingMigration.length === 0,
      type: 'primitive_registry_audit',
      ts: nowIso(),
      missing_metadata: missingMetadata,
      missing_migration: missingMigration
    });
  })()));
  process.stdout.write(`${JSON.stringify(statusPayload)}\n`);
  if (statusPayload.ok !== true) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'describe') return cmdDescribe(args);
  if (cmd === 'audit') return cmdAudit();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
