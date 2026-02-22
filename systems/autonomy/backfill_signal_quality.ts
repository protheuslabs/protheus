#!/usr/bin/env node
// @ts-nocheck
/**
 * backfill_signal_quality.js
 *
 * One-time safe migration:
 * - Reads proposals under state/sensory/proposals/*.json
 * - Copies legacy meta.score -> meta.signal_quality_score when missing
 * - Adds meta.signal_quality_tier (high|medium|low) when missing
 *
 * Default is dry-run. Use --write to persist.
 *
 * Usage:
 *   node systems/autonomy/backfill_signal_quality.js
 *   node systems/autonomy/backfill_signal_quality.js --write
 *   node systems/autonomy/backfill_signal_quality.js --date=YYYY-MM-DD --write
 *   node systems/autonomy/backfill_signal_quality.js --dir=state/sensory/proposals --write
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PROPOSALS_DIR = path.join(REPO_ROOT, 'state', 'sensory', 'proposals');

function parseArg(name) {
  const pref = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(pref));
  return a ? a.slice(pref.length) : null;
}

function qualityTier(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  if (s >= 75) return 'high';
  if (s >= 50) return 'medium';
  return 'low';
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/backfill_signal_quality.js [--write]');
  console.log('  node systems/autonomy/backfill_signal_quality.js --date=YYYY-MM-DD [--write]');
  console.log('  node systems/autonomy/backfill_signal_quality.js --dir=state/sensory/proposals [--write]');
  console.log('');
  console.log('Flags:');
  console.log('  --write             Persist changes (default: dry-run)');
  console.log('  --date=YYYY-MM-DD   Limit to one proposals file');
  console.log('  --dir=PATH          Override proposals directory');
}

function readDoc(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return { kind: 'array', proposals: parsed, doc: parsed };
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.proposals)) {
    return { kind: 'wrapper', proposals: parsed.proposals, doc: parsed };
  }
  return null;
}

function writeDoc(filePath, shaped) {
  if (shaped.kind === 'array') {
    fs.writeFileSync(filePath, JSON.stringify(shaped.proposals, null, 2) + '\n');
    return;
  }
  shaped.doc.proposals = shaped.proposals;
  fs.writeFileSync(filePath, JSON.stringify(shaped.doc, null, 2) + '\n');
}

function backfillOne(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    return { touched: false, copied_score: false, wrote_tier: false };
  }

  if (!proposal.meta || typeof proposal.meta !== 'object' || Array.isArray(proposal.meta)) {
    return { touched: false, copied_score: false, wrote_tier: false };
  }

  const meta = proposal.meta;
  const legacyScore = Number(meta.score);
  const existingSignalScore = Number(meta.signal_quality_score);
  let copiedScore = false;
  let wroteTier = false;

  if (!Number.isFinite(existingSignalScore) && Number.isFinite(legacyScore)) {
    meta.signal_quality_score = legacyScore;
    copiedScore = true;
  }

  const finalScore = Number(meta.signal_quality_score);
  if (!meta.signal_quality_tier && Number.isFinite(finalScore)) {
    const tier = qualityTier(finalScore);
    if (tier) {
      meta.signal_quality_tier = tier;
      wroteTier = true;
    }
  }

  return {
    touched: copiedScore || wroteTier,
    copied_score: copiedScore,
    wrote_tier: wroteTier
  };
}

function main() {
  const cmd = process.argv[2] || '';
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }

  const write = process.argv.includes('--write');
  const date = parseArg('date');
  const dirArg = parseArg('dir');
  const proposalsDir = dirArg ? path.resolve(REPO_ROOT, dirArg) : DEFAULT_PROPOSALS_DIR;

  if (!fs.existsSync(proposalsDir)) {
    console.error(`proposals dir missing: ${proposalsDir}`);
    process.exit(2);
  }

  const names = fs.readdirSync(proposalsDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .filter(f => !date || f === `${date}.json`)
    .sort();

  const summary = {
    ok: true,
    mode: write ? 'write' : 'dry-run',
    dir: proposalsDir,
    files_scanned: names.length,
    files_changed: 0,
    proposals_scanned: 0,
    proposals_touched: 0,
    copied_score: 0,
    wrote_tier: 0,
    per_file: []
  };

  for (const name of names) {
    const filePath = path.join(proposalsDir, name);
    let shaped;
    try {
      shaped = readDoc(filePath);
    } catch (err) {
      summary.per_file.push({
        file: name,
        ok: false,
        error: `parse_error:${String((err && err.message) || err).slice(0, 120)}`
      });
      continue;
    }

    if (!shaped) {
      summary.per_file.push({ file: name, ok: false, error: 'unsupported_shape' });
      continue;
    }

    let touchedInFile = 0;
    let copiedInFile = 0;
    let tierInFile = 0;
    summary.proposals_scanned += shaped.proposals.length;

    for (const p of shaped.proposals) {
      const r = backfillOne(p);
      if (r.touched) touchedInFile += 1;
      if (r.copied_score) copiedInFile += 1;
      if (r.wrote_tier) tierInFile += 1;
    }

    if (touchedInFile > 0 && write) {
      writeDoc(filePath, shaped);
      summary.files_changed += 1;
    }

    summary.proposals_touched += touchedInFile;
    summary.copied_score += copiedInFile;
    summary.wrote_tier += tierInFile;
    summary.per_file.push({
      file: name,
      ok: true,
      proposals: shaped.proposals.length,
      touched: touchedInFile,
      copied_score: copiedInFile,
      wrote_tier: tierInFile,
      changed: touchedInFile > 0
    });
  }

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

if (require.main === module) {
  main();
}

