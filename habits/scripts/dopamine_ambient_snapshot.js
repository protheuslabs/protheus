#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const engine = require('./dopamine_engine.js');

function isoNow() {
  return new Date().toISOString();
}

function normalizeDate(raw) {
  const value = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return isoNow().slice(0, 10);
}

function hashObject(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function closeoutSnapshot(dateStr) {
  const date = normalizeDate(dateStr);
  const captured = engine.autocap('git');
  engine.updateRollingAverages();
  engine.updateStreak(date);
  const summary = engine.getCurrentSDS();
  const out = {
    ok: true,
    type: 'dopamine_snapshot',
    mode: 'closeout',
    ts: isoNow(),
    date,
    captured,
    summary
  };
  out.receipt_hash = hashObject(out);
  return out;
}

function statusSnapshot(dateStr) {
  const date = normalizeDate(dateStr);
  const summary = engine.getCurrentSDS();
  const out = {
    ok: true,
    type: 'dopamine_snapshot',
    mode: 'status',
    ts: isoNow(),
    date,
    summary
  };
  out.receipt_hash = hashObject(out);
  return out;
}

function parseDateArg(args) {
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || '').trim();
    if (token.startsWith('--date=')) return token.slice('--date='.length);
    if (token === '--date' && i + 1 < args.length) return args[i + 1];
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const command = String(args[0] || 'status').trim().toLowerCase();
  const date = parseDateArg(args);

  let payload;
  if (command === 'closeout') {
    payload = closeoutSnapshot(date);
  } else if (command === 'status') {
    payload = statusSnapshot(date);
  } else {
    payload = {
      ok: false,
      type: 'dopamine_snapshot_error',
      ts: isoNow(),
      error: 'unknown_command',
      command
    };
    payload.receipt_hash = hashObject(payload);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(2);
    return;
  }

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  closeoutSnapshot,
  statusSnapshot
};
