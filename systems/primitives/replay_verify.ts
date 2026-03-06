#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { verifyCanonicalEvents, DEFAULT_LOG_DIR } = require('./canonical_event_log.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const REPORT_DIR = process.env.PRIMITIVE_REPLAY_REPORT_DIR
  ? path.resolve(process.env.PRIMITIVE_REPLAY_REPORT_DIR)
  : path.join(ROOT, 'state', 'runtime', 'canonical_events', 'replay_reports');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/primitives/replay_verify.js run [--date=YYYY-MM-DD] [--path=<dir|file>] [--strict=1|0]');
  console.log('  node systems/primitives/replay_verify.js status [latest|YYYY-MM-DD]');
}

function reportPathForDate(date: string) {
  return path.join(REPORT_DIR, `${date}.json`);
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function cmdRun(args: AnyObj) {
  const date = cleanText(args.date || '', 10) || nowIso().slice(0, 10);
  const target = cleanText(args.path || '', 420)
    || path.join(DEFAULT_LOG_DIR, `${date}.jsonl`);
  const strict = boolFlag(args.strict, false);
  const verified = verifyCanonicalEvents(target);
  const report = {
    schema_id: 'primitive_replay_verify',
    schema_version: '1.0',
    ts: nowIso(),
    date,
    target: path.isAbsolute(target) ? path.relative(ROOT, target) : target,
    ok: verified.ok === true,
    checked_files: verified.checked_files || [],
    total_events: Number(verified.total_events || 0),
    last_hash: verified.last_hash || null,
    failures: Array.isArray(verified.failures) ? verified.failures : []
  };
  const fp = reportPathForDate(date);
  writeJsonAtomic(fp, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (strict && report.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const target = String(args._[1] || 'latest').trim().toLowerCase();
  const resolved = target === 'latest' || !target
    ? nowIso().slice(0, 10)
    : cleanText(target, 10);
  const fp = reportPathForDate(resolved);
  if (!fs.existsSync(fp)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: 'status_not_found',
      report_path: path.relative(ROOT, fp)
    }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${fs.readFileSync(fp, 'utf8')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
