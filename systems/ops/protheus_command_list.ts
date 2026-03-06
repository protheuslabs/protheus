#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { colorize, supportsColor } = require('./cli_ui.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const ROUTER_RS = path.join(ROOT, 'crates', 'ops', 'src', 'protheusctl.rs');
const CATALOG_PATH = path.join(ROOT, 'config', 'protheus_command_catalog.json');

function usage() {
  console.log('Usage:');
  console.log('  protheus list');
  console.log('  protheus --help');
  console.log('  node systems/ops/protheus_command_list.js [--mode=list|help] [--json=1]');
}

function cleanText(v: unknown, maxLen = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx >= 0) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(String(fs.readFileSync(filePath, 'utf8') || ''));
  } catch {
    return fallback;
  }
}

function extractCommandBlock(src: string) {
  const needles = ['let route = match cmd.as_str() {', 'let mut route = match cmd.as_str() {'];
  let start = -1;
  let startNeedle = '';
  for (const needle of needles) {
    start = src.indexOf(needle);
    if (start >= 0) {
      startNeedle = needle;
      break;
    }
  }
  if (start < 0) return '';
  const rest = src.slice(start + startNeedle.length);
  const end = rest.indexOf('\n    };');
  if (end < 0) return rest;
  return rest.slice(0, end);
}

function extractCommandsFromRouter(routerSource: string) {
  const block = extractCommandBlock(routerSource);
  const commands = new Set<string>();
  const lines = String(block || '').split('\n');
  for (const line of lines) {
    if (!/^\s{8}"/.test(line)) continue;
    if (!line.includes('=>')) continue;
    const lhs = line.split('=>')[0] || '';
    const lhsWithoutGuard = lhs.split(/\s+if\s+/)[0] || lhs;
    const literals = Array.from(lhsWithoutGuard.matchAll(/"([^"]+)"/g)).map((m: RegExpMatchArray) => cleanText(m[1], 80));
    for (const literal of literals) {
      const token = normalizeToken(literal, 80);
      if (!token) continue;
      if (token.startsWith('--') && token !== '--help') continue;
      if (token.startsWith('-') && token !== '-h') continue;
      commands.add(token);
    }
  }

  // Standard aliases even if routed together.
  commands.add('help');
  commands.add('--help');
  commands.add('-h');
  commands.add('list');
  return Array.from(commands).sort((a, b) => a.localeCompare(b));
}

function loadCatalog() {
  const fallback = {
    version: 'fallback',
    category_order: ['Core Commands', 'Other Commands'],
    commands: {}
  };
  const payload = readJson(CATALOG_PATH, fallback);
  const commands = payload && typeof payload.commands === 'object' ? payload.commands : {};
  const categoryOrder = Array.isArray(payload && payload.category_order)
    ? payload.category_order.map((v: unknown) => cleanText(v, 80)).filter(Boolean)
    : fallback.category_order;
  return {
    version: cleanText(payload && payload.version || fallback.version, 40) || 'fallback',
    category_order: categoryOrder,
    commands
  };
}

function buildManifest() {
  const routerSource = fs.existsSync(ROUTER_RS) ? String(fs.readFileSync(ROUTER_RS, 'utf8') || '') : '';
  const extracted = extractCommandsFromRouter(routerSource);
  const catalog = loadCatalog();
  const byCategory: Record<string, Array<{ command: string, usage: string, summary: string }>> = {};

  for (const cmd of extracted) {
    const meta = catalog.commands[cmd] || catalog.commands[cmd.replace(/^--?/, '')] || {};
    const category = cleanText(meta.category || 'Other Commands', 80) || 'Other Commands';
    const usage = cleanText(meta.usage || `protheus ${cmd}`, 200) || `protheus ${cmd}`;
    const summary = cleanText(meta.summary || 'Command route available in dispatcher.', 240) || 'Command route available in dispatcher.';
    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push({ command: cmd, usage, summary });
  }

  for (const key of Object.keys(byCategory)) {
    byCategory[key].sort((a, b) => a.command.localeCompare(b.command));
  }

  const orderedCategories = [
    ...catalog.category_order.filter((label: string) => byCategory[label] && byCategory[label].length),
    ...Object.keys(byCategory).filter((label) => !catalog.category_order.includes(label)).sort((a, b) => a.localeCompare(b))
  ];

  return {
    ok: true,
    type: 'protheus_command_manifest',
    catalog_version: catalog.version,
    generated_at: new Date().toISOString(),
    router_path: path.relative(ROOT, ROUTER_RS).replace(/\\/g, '/'),
    categories: orderedCategories.map((label) => ({
      label,
      commands: byCategory[label] || []
    }))
  };
}

function renderText(manifest: AnyObj, mode: 'list' | 'help') {
  const useColor = supportsColor();
  const lines: string[] = [];
  lines.push(colorize('accent', mode === 'help' ? 'Protheus CLI Help' : 'Protheus CLI Tools', useColor));
  lines.push('');
  for (const category of manifest.categories || []) {
    lines.push(colorize('info', `${category.label}:`, useColor));
    for (const row of category.commands || []) {
      lines.push(`  ${colorize('success', row.usage, useColor)}  — ${row.summary}`);
    }
    lines.push('');
  }
  lines.push('Type `protheus <command> --help` for command-specific details.');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }
  const modeRaw = normalizeToken(args.mode || args._[0] || 'list', 20);
  const mode = modeRaw === 'help' ? 'help' : 'list';
  const manifest = buildManifest();
  if (toBool(args.json, false)) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    process.exit(0);
  }
  process.stdout.write(`${renderText(manifest, mode)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  extractCommandsFromRouter,
  buildManifest,
  renderText
};
