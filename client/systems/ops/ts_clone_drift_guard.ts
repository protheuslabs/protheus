#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { buildReport } = require('./ts_clone_drift_report');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_BASELINE_PATH = path.join(ROOT, 'config', 'ts_clone_drift_baseline.json');

function parseArgs(argv) {
  const out = {
    baselinePath: DEFAULT_BASELINE_PATH,
    roots: ['lib', 'systems'],
    maxSimilarityDrop: Number(process.env.TS_CLONE_MAX_SIMILARITY_DROP || 0.01),
    minPairs: 1
  };

  for (const arg of argv) {
    if (arg.startsWith('--baseline=')) {
      const value = arg.slice('--baseline='.length);
      out.baselinePath = path.isAbsolute(value) ? value : path.join(ROOT, value);
      continue;
    }
    if (arg.startsWith('--roots=')) {
      const roots = arg.slice('--roots='.length).split(',').map((entry) => entry.trim()).filter(Boolean);
      if (roots.length > 0) {
        out.roots = roots;
      }
      continue;
    }
    if (arg.startsWith('--max-drop=')) {
      const value = Number(arg.slice('--max-drop='.length));
      if (Number.isFinite(value) && value >= 0) {
        out.maxSimilarityDrop = value;
      }
      continue;
    }
    if (arg.startsWith('--min-pairs=')) {
      const value = Number(arg.slice('--min-pairs='.length));
      if (Number.isFinite(value) && value > 0) {
        out.minPairs = Math.floor(value);
      }
      continue;
    }
  }

  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.baselinePath)) {
    throw new Error(`missing_baseline:${path.relative(ROOT, args.baselinePath)}`);
  }

  const baseline = readJson(args.baselinePath);
  const current = buildReport(args.roots);

  const baselinePairs = Array.isArray(baseline.pairs) ? baseline.pairs : [];
  const currentPairs = Array.isArray(current.pairs) ? current.pairs : [];

  if (baselinePairs.length < args.minPairs || currentPairs.length < args.minPairs) {
    throw new Error(`insufficient_pairs:baseline=${baselinePairs.length}:current=${currentPairs.length}:min=${args.minPairs}`);
  }

  const baselineByBase = new Map(baselinePairs.map((entry) => [entry.base, entry]));
  const currentByBase = new Map(currentPairs.map((entry) => [entry.base, entry]));

  const missing = [];
  const regressed = [];

  for (const [base, baselineEntry] of baselineByBase.entries()) {
    const currentEntry = currentByBase.get(base);
    if (!currentEntry) {
      missing.push(base);
      continue;
    }

    const baselineSimilarity = Number(baselineEntry.similarity || 0);
    const currentSimilarity = Number(currentEntry.similarity || 0);
    const drop = baselineSimilarity - currentSimilarity;
    if (drop > args.maxSimilarityDrop) {
      regressed.push({
        base,
        baseline: Number(baselineSimilarity.toFixed(4)),
        current: Number(currentSimilarity.toFixed(4)),
        drop: Number(drop.toFixed(4))
      });
    }
  }

  const baselineMean = Number(mean(baselinePairs.map((entry) => Number(entry.similarity || 0))).toFixed(4));
  const currentMean = Number(mean(currentPairs.map((entry) => Number(entry.similarity || 0))).toFixed(4));

  const payload = {
    ok: missing.length === 0 && regressed.length === 0,
    type: 'ts_clone_drift_guard',
    ts: new Date().toISOString(),
    baseline: path.relative(ROOT, args.baselinePath),
    total_pairs: currentPairs.length,
    baseline_mean_similarity: baselineMean,
    current_mean_similarity: currentMean,
    max_allowed_drop: args.maxSimilarityDrop,
    missing_pairs: missing.slice(0, 20),
    regressed_pairs: regressed.slice(0, 20)
  };

  process.stdout.write(JSON.stringify(payload) + '\n');
  if (!payload.ok) {
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`ts_clone_drift_guard.js: FAIL: ${err.message}\n`);
  process.exit(1);
}
