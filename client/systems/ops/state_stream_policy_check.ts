#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-004
 * State stream policy + .gitignore alignment checker.
 *
 * Usage:
 *   node systems/ops/state_stream_policy_check.js check [--strict=1|0] [--policy=<path>]
 *   node systems/ops/state_stream_policy_check.js status [--policy=<path>]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.STATE_STREAM_POLICY_ROOT
  ? path.resolve(process.env.STATE_STREAM_POLICY_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.STATE_STREAM_POLICY_PATH
  ? path.resolve(process.env.STATE_STREAM_POLICY_PATH)
  : path.join(ROOT, 'config', 'state_stream_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
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

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function asStringArray(v: unknown) {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = cleanText(item, 260);
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    docs_path: 'docs/STATE_STREAM_POLICY.md',
    gitignore_path: '.gitignore',
    state_classes: [
      {
        id: 'source_of_truth',
        mode: 'tracked',
        paths: ['systems/**', 'lib/**', 'config/**', 'docs/**', 'memory/tools/**']
      },
      {
        id: 'runtime_state',
        mode: 'ignored',
        paths: ['state/**', 'tmp/**', 'logs/**']
      },
      {
        id: 'skills_local',
        mode: 'ignored',
        paths: ['skills/**']
      }
    ],
    required_ignore_patterns: ['state/**', 'tmp/', 'logs/tool_raw/'],
    required_unignore_patterns: ['!memory/tools/**', '!skills/mcp/*.ts', '!skills/mcp/*.js', '!skills/mcp/*.json'],
    outputs: {
      latest_path: 'state/ops/state_stream_policy_check/latest.json',
      history_path: 'state/ops/state_stream_policy_check/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const classesRaw = Array.isArray(raw.state_classes) ? raw.state_classes : base.state_classes;
  const stateClasses = classesRaw
    .map((row: AnyObj) => ({
      id: cleanText(row && row.id, 80),
      mode: cleanText(row && row.mode, 20).toLowerCase() === 'ignored' ? 'ignored' : 'tracked',
      paths: asStringArray(row && row.paths)
    }))
    .filter((row: AnyObj) => row.id && row.paths.length);

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    docs_path: resolvePath(raw.docs_path, base.docs_path),
    gitignore_path: resolvePath(raw.gitignore_path, base.gitignore_path),
    state_classes: stateClasses.length ? stateClasses : base.state_classes,
    required_ignore_patterns: asStringArray(raw.required_ignore_patterns || base.required_ignore_patterns),
    required_unignore_patterns: asStringArray(raw.required_unignore_patterns || base.required_unignore_patterns),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function readLines(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '').split(/\r?\n/);
}

function normalizeGitignoreEntry(v: unknown) {
  return cleanText(v, 300).replace(/\\/g, '/');
}

function loadGitignoreEntries(gitignorePath: string) {
  const entries: string[] = [];
  for (const rawLine of readLines(gitignorePath)) {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#')) continue;
    entries.push(normalizeGitignoreEntry(line));
  }
  return entries;
}

function checkPolicy(policy: AnyObj) {
  const findings: string[] = [];
  const gitignoreEntries = loadGitignoreEntries(policy.gitignore_path);
  const gitSet = new Set(gitignoreEntries);

  if (!fs.existsSync(policy.docs_path)) {
    findings.push('docs_missing');
  }

  const docsText = fs.existsSync(policy.docs_path)
    ? String(fs.readFileSync(policy.docs_path, 'utf8') || '')
    : '';

  for (const cls of policy.state_classes || []) {
    if (!docsText.includes(String(cls.id))) {
      findings.push(`docs_missing_class:${cls.id}`);
    }
    for (const p of cls.paths || []) {
      if (!docsText.includes(String(p))) findings.push(`docs_missing_path:${cls.id}:${p}`);
    }
  }

  for (const p of policy.required_ignore_patterns || []) {
    if (!gitSet.has(normalizeGitignoreEntry(p))) findings.push(`gitignore_missing_ignore:${p}`);
  }
  for (const p of policy.required_unignore_patterns || []) {
    if (!gitSet.has(normalizeGitignoreEntry(p))) findings.push(`gitignore_missing_unignore:${p}`);
  }

  return {
    ok: findings.length === 0,
    finding_count: findings.length,
    findings,
    stats: {
      classes: Number((policy.state_classes || []).length),
      gitignore_entries: gitignoreEntries.length
    }
  };
}

function cmdCheck(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const strict = toBool(args.strict, true);
  const policy = loadPolicy(policyPath);

  if (!policy.enabled) {
    return {
      ok: true,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const check = checkPolicy(policy);
  const out = {
    ok: check.ok,
    ts: nowIso(),
    type: 'state_stream_policy_check',
    strict,
    policy_path: rel(policy.policy_path),
    docs_path: rel(policy.docs_path),
    gitignore_path: rel(policy.gitignore_path),
    ...check
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    ok: out.ok,
    strict,
    finding_count: out.finding_count
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'state_stream_policy_status',
    latest: readJson(policy.outputs.latest_path, null),
    latest_path: rel(policy.outputs.latest_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/state_stream_policy_check.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/state_stream_policy_check.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 80).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  try {
    const out = cmd === 'check'
      ? cmdCheck(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : null;
    if (!out) {
      usage();
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (cmd === 'check' && toBool(args.strict, true) && out.ok !== true) process.exit(1);
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText(err && err.message ? err.message : err, 400) }, null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  checkPolicy,
  cmdCheck,
  cmdStatus
};
