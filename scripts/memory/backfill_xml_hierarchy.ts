#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const MEMORY_DIR = path.join(ROOT, 'memory');

function parseArgs(argv) {
  const out = { apply: false, limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token.startsWith('--')) continue;
    if (token === '--apply' || token === '--apply=1') out.apply = true;
    else if (token === '--apply=0') out.apply = false;
    else if (token.startsWith('--limit=')) out.limit = Math.max(0, Number(token.slice(8)) || 0);
  }
  return out;
}

function dailyFiles() {
  return fs.readdirSync(MEMORY_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort()
    .map((name) => path.join(MEMORY_DIR, name));
}

function cleanText(v, max = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseFrontmatter(chunk) {
  const m = String(chunk || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return null;
  const fm = m[1];
  const nodeId = cleanText((fm.match(/^\s*node_id:\s*([^\n]+)$/m) || [])[1], 120);
  const uid = cleanText((fm.match(/^\s*uid:\s*([^\n]+)$/m) || [])[1], 120);
  const tagsRaw = (fm.match(/^\s*tags:\s*\[([^\]]*)\]/m) || [])[1] || '';
  const tags = String(tagsRaw)
    .split(',')
    .map((t) => cleanText(t, 60).replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  const body = chunk.slice(m[0].length);
  return { nodeId, uid, tags, body, frontmatter: m[0] };
}

function hexId(nodeId, uid) {
  const rawUid = cleanText(uid, 120).toLowerCase().replace(/[^a-f0-9]/g, '');
  if (rawUid.length >= 8) return rawUid.slice(0, 24);
  return crypto.createHash('sha256').update(cleanText(nodeId, 160)).digest('hex').slice(0, 24);
}

function classifyNode(nodeId, tags) {
  const id = String(nodeId || '').toLowerCase();
  const tokenSet = new Set((tags || []).map((t) => String(t || '').toLowerCase()));
  if (id.startsWith('jot-') || tokenSet.has('jot')) return { kind: 'jot', level: 3 };
  if (id.startsWith('tag-') || tokenSet.has('tag')) return { kind: 'tag', level: 2 };
  return { kind: 'node', level: 1 };
}

function hasXmlEnvelope(body) {
  const s = String(body || '');
  return /<node\b[^>]*>[\s\S]*<\/node>/i.test(s)
    || /<tag\b[^>]*>[\s\S]*<\/tag>/i.test(s)
    || /<jot\b[^>]*>[\s\S]*<\/jot>/i.test(s);
}

function wrapNodeChunk(chunk) {
  const parsed = parseFrontmatter(chunk);
  if (!parsed || !parsed.nodeId) return { changed: false, chunk };
  if (hasXmlEnvelope(parsed.body)) return { changed: false, chunk };

  const cls = classifyNode(parsed.nodeId, parsed.tags);
  const hid = hexId(parsed.nodeId, parsed.uid);
  const tagAttr = parsed.tags.length ? parsed.tags.join(',') : '';
  const uidAttr = parsed.uid ? ` uid="${parsed.uid}"` : '';
  const xmlOpen = `<${cls.kind} id="${parsed.nodeId}"${uidAttr} hex_id="${hid}" level="${cls.level}" tags="${tagAttr}">`;
  const xmlClose = `</${cls.kind}>`;

  const trimmedBody = String(parsed.body || '').replace(/^\s+/, '').replace(/\s+$/, '');
  const nextChunk = `${parsed.frontmatter}${xmlOpen}\n${trimmedBody}\n${xmlClose}\n`;
  return { changed: true, chunk: nextChunk, node_id: parsed.nodeId, level: cls.level, kind: cls.kind };
}

function convertFile(filePath, apply) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const chunks = raw.split(/\s*<!--\s*NODE\s*-->\s*/).filter((c) => c.trim());
  const results = chunks.map((chunk) => wrapNodeChunk(chunk));
  const changed = results.some((row) => row.changed);
  if (!changed) return { file: path.basename(filePath), changed: false, converted: 0, total: chunks.length };

  const next = results.map((row) => row.chunk.trimEnd()).join('\n\n<!-- NODE -->\n\n').trimEnd() + '\n';
  if (apply) fs.writeFileSync(filePath, next, 'utf8');
  return {
    file: path.basename(filePath),
    changed: true,
    converted: results.filter((row) => row.changed).length,
    total: chunks.length,
    nodes: results.filter((row) => row.changed).map((row) => ({ node_id: row.node_id, kind: row.kind, level: row.level }))
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = dailyFiles();
  const selected = args.limit > 0 ? files.slice(0, args.limit) : files;
  const report = selected.map((filePath) => convertFile(filePath, args.apply));
  const changedFiles = report.filter((row) => row.changed);
  const convertedNodes = changedFiles.reduce((sum, row) => sum + Number(row.converted || 0), 0);

  const payload = {
    ok: true,
    type: 'memory_xml_hierarchy_backfill',
    ts: new Date().toISOString(),
    apply: args.apply,
    files_scanned: selected.length,
    files_changed: changedFiles.length,
    converted_nodes: convertedNodes,
    report
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main();
