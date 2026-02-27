#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CATALOG_PATH = process.env.PRIMITIVE_CATALOG_PATH
  ? path.resolve(process.env.PRIMITIVE_CATALOG_PATH)
  : path.join(ROOT, 'config', 'primitive_catalog.json');

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .replace(/[^a-zA-Z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeLowerToken(v: unknown, maxLen = 80) {
  return normalizeToken(v, maxLen).toLowerCase();
}

function readJson(filePath: string, fallback: AnyObj) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function defaultCatalog() {
  return {
    schema_id: 'primitive_catalog',
    schema_version: '1.0',
    default_command_opcode: 'SHELL_EXECUTE',
    default_command_effect: 'compute',
    command_rules: [],
    adapter_opcode_map: {},
    adapter_effect_map: {},
    opcode_metadata: {}
  };
}

function normalizeRule(raw: AnyObj) {
  const contains = normalizeLowerToken(raw && raw.contains ? raw.contains : '', 180);
  const prefix = normalizeLowerToken(raw && raw.prefix ? raw.prefix : '', 180);
  const opcode = normalizeToken(raw && raw.opcode ? raw.opcode : '', 80).toUpperCase();
  const effect = normalizeLowerToken(raw && raw.effect ? raw.effect : '', 80);
  if ((!contains && !prefix) || !opcode) return null;
  return {
    contains: contains || null,
    prefix: prefix || null,
    opcode,
    effect: effect || null
  };
}

function normalizeMap(raw: AnyObj, toUpper = false) {
  const out: AnyObj = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [k, v] of Object.entries(src)) {
    const key = normalizeLowerToken(k, 80);
    if (!key) continue;
    const value = toUpper
      ? normalizeToken(v, 80).toUpperCase()
      : normalizeLowerToken(v, 80);
    if (!value) continue;
    out[key] = value;
  }
  return out;
}

function normalizeStringList(src: unknown, maxItems = 32, maxLen = 120) {
  if (!Array.isArray(src)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of src) {
    const value = normalizeLowerToken(raw, maxLen);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeOpcodeMetadataMap(raw: AnyObj) {
  const out: AnyObj = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [k, v] of Object.entries(src)) {
    const opcode = normalizeToken(k, 80).toUpperCase();
    if (!opcode) continue;
    const entry = v && typeof v === 'object' ? v as AnyObj : {};
    const invariants = normalizeStringList(entry.invariants, 64, 120);
    const costClass = normalizeLowerToken(entry.cost_class || '', 40) || null;
    const safetyClass = normalizeLowerToken(entry.safety_class || '', 40) || null;
    out[opcode] = {
      invariants,
      cost_class: costClass,
      safety_class: safetyClass
    };
  }
  return out;
}

function loadPrimitiveCatalog() {
  const base = defaultCatalog();
  const raw = readJson(DEFAULT_CATALOG_PATH, base);
  const rules = Array.isArray(raw.command_rules)
    ? raw.command_rules.map((row: AnyObj) => normalizeRule(row)).filter(Boolean)
    : [];
  return {
    schema_id: 'primitive_catalog',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || '1.0',
    default_command_opcode: normalizeToken(
      raw.default_command_opcode || base.default_command_opcode,
      80
    ).toUpperCase() || 'SHELL_EXECUTE',
    default_command_effect: normalizeLowerToken(
      raw.default_command_effect || base.default_command_effect,
      80
    ) || 'compute',
    command_rules: rules,
    adapter_opcode_map: normalizeMap(raw.adapter_opcode_map, true),
    adapter_effect_map: normalizeMap(raw.adapter_effect_map, false),
    opcode_metadata: normalizeOpcodeMetadataMap(raw.opcode_metadata),
    catalog_path: path.resolve(DEFAULT_CATALOG_PATH)
  };
}

function describePrimitiveOpcode(opcodeRaw: unknown, catalogRaw: AnyObj = null) {
  const catalog = catalogRaw && typeof catalogRaw === 'object' ? catalogRaw : loadPrimitiveCatalog();
  const opcode = normalizeToken(opcodeRaw || '', 80).toUpperCase();
  if (!opcode) return null;
  const metadata = catalog.opcode_metadata && typeof catalog.opcode_metadata === 'object'
    ? catalog.opcode_metadata[opcode]
    : null;
  return {
    opcode,
    metadata: metadata && typeof metadata === 'object'
      ? {
        invariants: Array.isArray(metadata.invariants) ? metadata.invariants : [],
        cost_class: metadata.cost_class || null,
        safety_class: metadata.safety_class || null
      }
      : {
        invariants: [],
        cost_class: null,
        safety_class: null
      },
    catalog_version: catalog.schema_version || '1.0'
  };
}

function classifyCommandPrimitive(commandRaw: unknown, opts: AnyObj = {}) {
  const catalog = loadPrimitiveCatalog();
  const command = cleanText(commandRaw || '', 4000);
  const stepType = normalizeLowerToken(opts.step_type || opts.stepType || 'command', 40) || 'command';
  if (stepType === 'receipt') {
    return {
      opcode: 'RECEIPT_VERIFY',
      effect: 'filesystem_read',
      confidence: 1,
      source: 'step_type',
      runtime_kind: 'command',
      step_type: stepType,
      command
    };
  }
  if (stepType === 'gate') {
    return {
      opcode: 'FLOW_GATE',
      effect: 'governance',
      confidence: 1,
      source: 'step_type',
      runtime_kind: 'command',
      step_type: stepType,
      command
    };
  }
  const lower = command.toLowerCase();
  for (const rule of catalog.command_rules) {
    if (!rule) continue;
    if (rule.contains && lower.includes(rule.contains)) {
      return {
        opcode: rule.opcode,
        effect: rule.effect || catalog.default_command_effect,
        confidence: 0.95,
        source: `rule:contains:${rule.contains}`,
        runtime_kind: 'command',
        step_type: stepType,
        command
      };
    }
    if (rule.prefix && lower.startsWith(rule.prefix)) {
      return {
        opcode: rule.opcode,
        effect: rule.effect || catalog.default_command_effect,
        confidence: 0.92,
        source: `rule:prefix:${rule.prefix}`,
        runtime_kind: 'command',
        step_type: stepType,
        command
      };
    }
  }
  return {
    opcode: catalog.default_command_opcode,
    effect: catalog.default_command_effect,
    confidence: 0.6,
    source: 'default',
    runtime_kind: 'command',
    step_type: stepType,
    command
  };
}

function classifyActuationPrimitive(kindRaw: unknown, opts: AnyObj = {}) {
  const catalog = loadPrimitiveCatalog();
  const kind = normalizeLowerToken(kindRaw || '', 80) || 'unknown_adapter';
  const effect = catalog.adapter_effect_map[kind] || 'actuation';
  const opcode = catalog.adapter_opcode_map[kind] || 'ACTUATION_ADAPTER';
  return {
    opcode,
    effect,
    confidence: catalog.adapter_effect_map[kind] || catalog.adapter_opcode_map[kind] ? 0.95 : 0.55,
    source: catalog.adapter_effect_map[kind] || catalog.adapter_opcode_map[kind]
      ? 'adapter_map'
      : 'adapter_default',
    runtime_kind: 'adapter',
    adapter_kind: kind,
    params: opts && opts.params && typeof opts.params === 'object' ? opts.params : {}
  };
}

module.exports = {
  DEFAULT_CATALOG_PATH,
  loadPrimitiveCatalog,
  classifyCommandPrimitive,
  classifyActuationPrimitive,
  describePrimitiveOpcode
};
