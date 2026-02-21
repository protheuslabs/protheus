#!/usr/bin/env node
'use strict';

/**
 * Moltbook-specific proposal template generator.
 * This stays in skills/ to avoid specialization in systems/.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const GENERIC_TEMPLATE = path.join(ROOT, 'systems', 'actuation', 'proposal_template.js');

function usage() {
  console.log('Usage:');
  console.log('  node skills/moltbook/proposal_template.js --title="..." --body="..." [--submolt=general]');
  console.log('  node skills/moltbook/proposal_template.js --help');
}

function parseArg(name, fallback = '') {
  const pref = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(pref));
  return a ? a.slice(pref.length) : fallback;
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.includes('help')) {
    usage();
    process.exit(0);
  }
  const title = String(parseArg('title', '')).trim();
  const body = String(parseArg('body', '')).trim();
  const submolt = String(parseArg('submolt', 'general')).trim();
  if (!title || !body) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'requires --title and --body' }) + '\n');
    process.exit(2);
  }

  const params = JSON.stringify({ title, body, submolt });
  const r = spawnSync('node', [
    GENERIC_TEMPLATE,
    'generic',
    '--kind=moltbook_publish',
    `--title=${title}`,
    `--params=${params}`
  ], { cwd: ROOT, encoding: 'utf8' });

  process.stdout.write(String(r.stdout || ''));
  if (String(r.stderr || '').trim()) process.stderr.write(String(r.stderr || ''));
  process.exit(r.status == null ? 1 : r.status);
}

main();

