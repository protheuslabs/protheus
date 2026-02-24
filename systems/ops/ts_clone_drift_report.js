#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ROOTS = ['lib', 'systems'];

function listSources(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.ts'))) {
        out.push(abs);
      }
    }
  }
  return out;
}

function normalizeCode(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/^#!.*\n/, '')
    .replace(/\/\/# sourceMappingURL=.*\n?/g, '')
    .split('\n');

  const cleaned = [];
  for (const line of lines) {
    const trimmedRight = line.replace(/\s+$/g, '');
    if (trimmedRight === "'use strict';" || trimmedRight === '"use strict";') {
      continue;
    }
    if (trimmedRight.trim().startsWith('//')) {
      continue;
    }
    cleaned.push(trimmedRight);
  }

  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function tokenize(value) {
  const matches = String(value || '').match(/[A-Za-z_$][A-Za-z0-9_$]*/g);
  return matches ? matches : [];
}

function jaccard(left, right) {
  const setA = new Set(left);
  const setB = new Set(right);
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function transpileTs(tsCode, tsPath) {
  const result = ts.transpileModule(tsCode, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: false,
      allowSyntheticDefaultImports: false,
      declaration: false,
      sourceMap: false,
      removeComments: false
    },
    fileName: tsPath,
    reportDiagnostics: false
  });
  return result.outputText || '';
}

function parseArgs(argv) {
  const parsed = {
    roots: DEFAULT_ROOTS,
    writePath: null,
    jsonOnly: false,
    strict: false,
    maxDivergent: Number.POSITIVE_INFINITY
  };

  for (const arg of argv) {
    if (arg === '--json') {
      parsed.jsonOnly = true;
      continue;
    }
    if (arg === '--strict') {
      parsed.strict = true;
      parsed.maxDivergent = 0;
      continue;
    }
    if (arg.startsWith('--max-divergent=')) {
      const raw = Number(arg.split('=')[1]);
      if (Number.isFinite(raw) && raw >= 0) {
        parsed.maxDivergent = raw;
      }
      continue;
    }
    if (arg.startsWith('--write=')) {
      parsed.writePath = arg.slice('--write='.length);
      continue;
    }
    if (arg.startsWith('--roots=')) {
      const roots = arg.slice('--roots='.length)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (roots.length > 0) {
        parsed.roots = roots;
      }
      continue;
    }
  }

  return parsed;
}

function buildReport(roots) {
  const pairMap = new Map();

  for (const relRoot of roots) {
    const absRoot = path.join(ROOT, relRoot);
    if (!fs.existsSync(absRoot)) {
      continue;
    }
    const files = listSources(absRoot);
    for (const absFile of files) {
      const ext = path.extname(absFile);
      if (ext !== '.js' && ext !== '.ts') {
        continue;
      }
      const rel = path.relative(ROOT, absFile);
      const base = rel.slice(0, -ext.length);
      const existing = pairMap.get(base) || {};
      existing[ext.slice(1)] = rel;
      pairMap.set(base, existing);
    }
  }

  const pairs = [];
  const skipped = [];

  for (const [base, entry] of pairMap.entries()) {
    if (!entry.js || !entry.ts) {
      skipped.push(base);
      continue;
    }

    const jsPath = path.join(ROOT, entry.js);
    const tsPath = path.join(ROOT, entry.ts);
    const jsCode = fs.readFileSync(jsPath, 'utf8');
    const tsCode = fs.readFileSync(tsPath, 'utf8');
    let transpiledTs = '';
    let transpileError = null;

    try {
      transpiledTs = transpileTs(tsCode, tsPath);
    } catch (err) {
      transpileError = err instanceof Error ? err.message : String(err);
    }

    const normalizedJs = normalizeCode(jsCode);
    const normalizedTsJs = normalizeCode(transpiledTs);
    const similarity = transpileError
      ? 0
      : Number(jaccard(tokenize(normalizedJs), tokenize(normalizedTsJs)).toFixed(4));
    const exact = !transpileError && normalizedJs === normalizedTsJs;

    pairs.push({
      base,
      js: entry.js,
      ts: entry.ts,
      exact,
      similarity,
      transpile_error: transpileError,
      js_hash: digest(normalizedJs),
      ts_hash: digest(normalizedTsJs),
      js_size: normalizedJs.length,
      ts_size: normalizedTsJs.length
    });
  }

  pairs.sort((a, b) => {
    if (a.exact && !b.exact) return -1;
    if (!a.exact && b.exact) return 1;
    if (a.similarity !== b.similarity) return b.similarity - a.similarity;
    return a.base.localeCompare(b.base);
  });

  const exactPairs = pairs.filter((pair) => pair.exact);
  const divergentPairs = pairs.filter((pair) => !pair.exact && !pair.transpile_error);
  const transpileErrors = pairs.filter((pair) => Boolean(pair.transpile_error));

  return {
    generated_at: new Date().toISOString(),
    roots,
    summary: {
      total_pairs: pairs.length,
      exact_pairs: exactPairs.length,
      divergent_pairs: divergentPairs.length,
      transpile_errors: transpileErrors.length,
      skipped_solo_files: skipped.length
    },
    exact_candidates: exactPairs.map((pair) => pair.base),
    highest_drift: divergentPairs
      .slice()
      .sort((a, b) => a.similarity - b.similarity)
      .slice(0, 25)
      .map((pair) => ({
        base: pair.base,
        similarity: pair.similarity
      })),
    pairs
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args.roots);
  const output = JSON.stringify(report, null, 2);

  if (args.writePath) {
    const target = path.isAbsolute(args.writePath)
      ? args.writePath
      : path.join(ROOT, args.writePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, output + '\n', 'utf8');
  }

  if (args.jsonOnly) {
    process.stdout.write(output + '\n');
  } else {
    const summary = report.summary;
    process.stdout.write(JSON.stringify({
      ok: summary.divergent_pairs <= args.maxDivergent && summary.transpile_errors === 0,
      type: 'ts_clone_drift_report',
      generated_at: report.generated_at,
      total_pairs: summary.total_pairs,
      exact_pairs: summary.exact_pairs,
      divergent_pairs: summary.divergent_pairs,
      transpile_errors: summary.transpile_errors,
      strict_limit: Number.isFinite(args.maxDivergent) ? args.maxDivergent : null
    }) + '\n');
    if (report.highest_drift.length > 0) {
      process.stdout.write(JSON.stringify({
        highest_drift: report.highest_drift
      }) + '\n');
    }
  }

  const { divergent_pairs: divergentPairs, transpile_errors: transpileErrors } = report.summary;
  if (transpileErrors > 0 || divergentPairs > args.maxDivergent) {
    process.exit(1);
  }
}

main();
