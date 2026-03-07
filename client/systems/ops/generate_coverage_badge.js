#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function arg(name, fallback = '') {
  const found = process.argv.find((v) => v.startsWith(`${name}=`));
  if (!found) return fallback;
  return found.slice(name.length + 1);
}

function parseTsCoverage(tsPath) {
  const raw = fs.readFileSync(tsPath, 'utf8');
  const json = JSON.parse(raw);
  const pct = Number(json && json.total && json.total.lines && json.total.lines.pct);
  if (!Number.isFinite(pct)) {
    throw new Error(`ts_coverage_missing_lines_pct:${tsPath}`);
  }
  return pct;
}

function parseRustCoverage(rustPath) {
  const raw = fs.readFileSync(rustPath, 'utf8');
  const match = raw.match(/TOTAL\s+.*?([0-9]+(?:\.[0-9]+)?)%/);
  if (!match) {
    throw new Error(`rust_coverage_total_not_found:${rustPath}`);
  }
  return Number(match[1]);
}

function colorFor(pct) {
  if (pct >= 90) return '#2ea043';
  if (pct >= 80) return '#3fb950';
  if (pct >= 70) return '#9fbf3b';
  if (pct >= 60) return '#d4a72c';
  if (pct >= 50) return '#db6d28';
  return '#cf222e';
}

function badgeSvg(label, value, color) {
  const left = 78;
  const right = 92;
  const width = left + right;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${label}: ${value}">\n  <rect width="${left}" height="20" fill="#555"/>\n  <rect x="${left}" width="${right}" height="20" fill="${color}"/>\n  <rect width="${width}" height="20" fill="transparent"/>\n  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">\n    <text x="${left / 2}" y="14">${label}</text>\n    <text x="${left + right / 2}" y="14">${value}</text>\n  </g>\n</svg>\n`;
}

function main() {
  const tsPath = arg('--ts');
  const rustPath = arg('--rust');
  const outJson = arg('--out-json', 'coverage/combined-summary.json');
  const outBadge = arg('--out-badge', 'client/docs/badges/coverage.svg');

  if (!tsPath || !rustPath) {
    throw new Error('usage: --ts=<coverage-summary.json> --rust=<rust-summary.txt> [--out-json=...] [--out-badge=...]');
  }

  const tsPct = parseTsCoverage(tsPath);
  const rustPct = parseRustCoverage(rustPath);
  const combined = Number(((tsPct + rustPct) / 2).toFixed(2));

  const summary = {
    ts_lines_pct: Number(tsPct.toFixed(2)),
    rust_lines_pct: Number(rustPct.toFixed(2)),
    combined_lines_pct: combined,
    formula: 'average(ts_lines_pct,rust_lines_pct)',
    generated_at: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(summary, null, 2) + '\n');

  const svg = badgeSvg('coverage', `${combined}%`, colorFor(combined));
  fs.mkdirSync(path.dirname(outBadge), { recursive: true });
  fs.writeFileSync(outBadge, svg);

  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main();
