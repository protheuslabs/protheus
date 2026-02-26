#!/usr/bin/env node
'use strict';

/**
 * llm_gateway_guard.js
 *
 * Enforces model-call centralization:
 * - runtime code must not call model providers directly
 * - direct local model invocation is only allowed in routing gateway files
 *
 * Usage:
 *   node systems/security/llm_gateway_guard.js run [--strict]
 *   node systems/security/llm_gateway_guard.js --help
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.env.LLM_GATEWAY_GUARD_ROOT
  ? path.resolve(String(process.env.LLM_GATEWAY_GUARD_ROOT))
  : path.resolve(__dirname, '..', '..');
const CODE_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.py']);
const SCAN_ROOTS = ['systems', 'habits', 'skills', 'lib'];
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'state',
  'adaptive',
  'memory/tools/tests',
  'skills/openclaw-token-optimizer/assets',
  'skills/openclaw-token-optimizer/references'
]);
const ALLOWED_OLLAMA_SPAWN = new Set([
  'systems/routing/model_router.js',
  'systems/routing/model_router.ts',
  'systems/routing/llm_gateway.js',
  'systems/routing/llm_gateway.ts'
]);

const RULES = [
  {
    id: 'direct_ollama_spawn',
    re: /spawnSync\s*\(\s*['"]ollama['"]/g,
    allow: ALLOWED_OLLAMA_SPAWN
  },
  {
    id: 'direct_exec_ollama_run',
    re: /execSync\s*\(\s*['"`][^'"`\n]*\bollama\s+run\b/gi,
    allow: new Set()
  },
  {
    id: 'direct_local_generate_api',
    re: /127\.0\.0\.1:11434\/api\/generate/gi,
    allow: new Set()
  },
  {
    id: 'direct_openai_sdk',
    re: /\bnew\s+OpenAI\s*\(/g,
    allow: new Set()
  },
  {
    id: 'direct_anthropic_sdk',
    re: /\bnew\s+Anthropic\s*\(/g,
    allow: new Set()
  }
];

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/llm_gateway_guard.js run [--strict]');
  console.log('  node systems/security/llm_gateway_guard.js --help');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const arg of argv) {
    if (!arg.startsWith('--')) out._.push(arg);
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function rel(abs) {
  return path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
}

function shouldSkip(absPath) {
  const r = rel(absPath);
  if (!r || r.startsWith('../')) return true;
  for (const skip of SKIP_DIRS) {
    if (r === skip || r.startsWith(`${skip}/`)) return true;
  }
  return false;
}

function walkFiles(dirPath, out = []) {
  if (!fs.existsSync(dirPath)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const abs = path.join(dirPath, e.name);
    if (shouldSkip(abs)) continue;
    if (e.isDirectory()) walkFiles(abs, out);
    else if (e.isFile() && CODE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(abs);
  }
  return out;
}

function lineNumberAt(text, index) {
  if (index <= 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function snippetAt(text, index) {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + 120);
  return String(text.slice(start, end))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function evaluate() {
  const violations = [];
  const files = [];
  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    walkFiles(absRoot, files);
  }

  for (const abs of files) {
    const file = rel(abs);
    let text = '';
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let match = rule.re.exec(text);
      while (match) {
        if (!rule.allow.has(file)) {
          const idx = match.index || 0;
          violations.push({
            type: rule.id,
            file,
            line: lineNumberAt(text, idx),
            snippet: snippetAt(text, idx)
          });
        }
        match = rule.re.exec(text);
      }
    }
  }

  const counts = {};
  for (const v of violations) {
    counts[v.type] = Number(counts[v.type] || 0) + 1;
  }

  return {
    ok: violations.length === 0,
    checked_files: files.length,
    policy: {
      scan_roots: SCAN_ROOTS.slice(),
      allowed_ollama_spawn: Array.from(ALLOWED_OLLAMA_SPAWN).sort()
    },
    violation_count: violations.length,
    violation_counts: Object.fromEntries(Object.entries(counts).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || a[0].localeCompare(b[0]))),
    violations: violations.sort((a, b) => String(a.file).localeCompare(String(b.file)) || Number(a.line || 0) - Number(b.line || 0))
  };
}

function run(strict = false) {
  const out = evaluate();
  const payload = {
    ok: out.ok,
    strict: strict === true,
    checked_files: out.checked_files,
    policy: out.policy,
    violation_count: out.violation_count,
    violation_counts: out.violation_counts,
    violations: out.violations
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  if (!payload.ok) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }
  run(args.strict === true);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluate
};
export {};
