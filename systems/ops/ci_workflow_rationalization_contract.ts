#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  writeJsonAtomic,
  appendJsonl,
  emit
} = require('../../lib/queued_backlog_runtime');

const LATEST_PATH = path.join(ROOT, 'state', 'ops', 'ci_workflow_rationalization', 'latest.json');
const RECEIPTS_PATH = path.join(ROOT, 'state', 'ops', 'ci_workflow_rationalization', 'receipts.jsonl');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/ci_workflow_rationalization_contract.js check [--strict=1|0]');
  console.log('  node systems/ops/ci_workflow_rationalization_contract.js status');
}

function readFile(absPath: string) {
  try { return fs.readFileSync(absPath, 'utf8'); } catch { return ''; }
}

function parseTriggers(raw: string) {
  const lines = String(raw || '').split('\n');
  const out = new Set<string>();
  let inOn = false;
  for (const lineRaw of lines) {
    const line = String(lineRaw || '');
    if (/^on:\s*$/.test(line.trim())) {
      inOn = true;
      continue;
    }
    if (inOn && /^\S/.test(line) && !line.startsWith(' ')) {
      break;
    }
    if (!inOn) continue;
    const m = line.match(/^\s{2}([a-zA-Z_]+):\s*$/);
    if (m) out.add(m[1]);
  }
  return Array.from(out).sort();
}

function hasInstallStep(raw: string) {
  return /npm ci/.test(raw);
}

function runCheck(strict: boolean) {
  const ciPath = path.join(ROOT, '.github', 'workflows', 'ci.yml');
  const requiredChecksPath = path.join(ROOT, '.github', 'workflows', 'required-checks.yml');
  const testSuitePath = path.join(ROOT, '.github', 'workflows', 'test-suite.yml');

  const ciRaw = readFile(ciPath);
  const reqRaw = readFile(requiredChecksPath);
  const testRaw = readFile(testSuitePath);

  const ciTriggers = parseTriggers(ciRaw);
  const reqTriggers = parseTriggers(reqRaw);
  const testTriggers = parseTriggers(testRaw);

  const duplicatePushPr = (reqTriggers.includes('push') || reqTriggers.includes('pull_request') || testTriggers.includes('push') || testTriggers.includes('pull_request'));

  const checks = {
    primary_ci_has_push_pr: ciTriggers.includes('push') && ciTriggers.includes('pull_request'),
    secondary_workflows_no_push_pr_duplication: !duplicatePushPr,
    primary_ci_installs_dependencies: hasInstallStep(ciRaw)
  };

  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
  const pass = blocking.length === 0;
  const ok = strict ? pass : true;

  const out = {
    ok,
    pass,
    strict,
    type: 'ci_workflow_rationalization_contract',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    workflows: {
      ci: { path: '.github/workflows/ci.yml', triggers: ciTriggers },
      required_checks: { path: '.github/workflows/required-checks.yml', triggers: reqTriggers },
      test_suite: { path: '.github/workflows/test-suite.yml', triggers: testTriggers }
    }
  };

  writeJsonAtomic(LATEST_PATH, out);
  appendJsonl(RECEIPTS_PATH, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'check').toLowerCase();
  if (args.help || cmd === 'help' || cmd === '--help') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }

  if (cmd === 'status') {
    try {
      const payload = JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));
      return emit(payload, 0);
    } catch {
      return emit({ ok: true, status: 'no_status', type: 'ci_workflow_rationalization_contract' }, 0);
    }
  }

  if (cmd !== 'check') {
    usage();
    return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
  }

  const strict = toBool(args.strict, true);
  const out = runCheck(strict);
  return emit(out, out.ok ? 0 : 1);
}

main();
