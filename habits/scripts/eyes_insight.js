#!/usr/bin/env node
/**
 * eyes_insight.js - Eyes → Proposals bridge (deterministic)
 *
 * Reads ONLY:
 *   state/sensory/eyes/raw/YYYY-MM-DD.jsonl
 *
 * Writes/merges:
 *   state/sensory/proposals/YYYY-MM-DD.json
 *
 * Goals:
 * - Deterministic, no LLM
 * - Produce a small number of proposals from external_item events
 * - Add explicit eye attribution for outcome loops:
 *   evidence_ref includes "eye:<id>"
 *
 * Commands:
 *   node habits/scripts/eyes_insight.js run [YYYY-MM-DD] [--max=N]
 *
 * Env overrides (for tests):
 *   SENSORY_TEST_DIR=/path/to/temp_state_sensory
 *
 * Notes:
 * - This script does NOT execute anything. It only proposes.
 * - It tolerates proposals files that are either:
 *   [ ... ] (array)
 *   { proposals: [ ... ] } (wrapper)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const testDir = process.env.SENSORY_TEST_DIR;
const SENSORY_DIR = testDir || path.join(__dirname, '..', '..', 'state', 'sensory');
const EYES_RAW_DIR = path.join(SENSORY_DIR, 'eyes', 'raw');
const PROPOSALS_DIR = path.join(SENSORY_DIR, 'proposals');

function ensureDirs() {
  [EYES_RAW_DIR, PROPOSALS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function sha16(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 16);
}

function readJsonlSafe(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      // ignore malformed lines (append-only logs sometimes include partial lines on crash)
    }
  }
  return out;
}

function loadExistingProposals(dateStr) {
  const p = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(p)) return { path: p, proposals: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(raw)) return { path: p, proposals: raw };
    if (raw && Array.isArray(raw.proposals)) return { path: p, proposals: raw.proposals };
    // Unknown shape – treat as empty (but don't delete it; we overwrite with array for correctness)
    return { path: p, proposals: [] };
  } catch (_) {
    return { path: p, proposals: [] };
  }
}

function saveProposalsArray(dateStr, proposals) {
  ensureDirs();
  const p = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  fs.writeFileSync(p, JSON.stringify(proposals, null, 2));
  return p;
}

function normalizeText(s) {
  return String(s || '').trim();
}

// Simple deterministic "usefulness" heuristics
function scoreItem(item) {
  // 0..100
  let score = 0;
  const title = normalizeText(item.title);
  const url = normalizeText(item.url);
  const topics = Array.isArray(item.topics) ? item.topics : [];
  const preview = normalizeText(item.content_preview);

  if (url.startsWith('http')) score += 10;
  if (title.length >= 12) score += 15;
  if (title.length >= 24) score += 10;
  if (topics.length > 0) score += Math.min(20, topics.length * 5);
  if (preview.length >= 40) score += 10;

  // penalize obviously noisy stub markers if any
  if (/\[stub\]/i.test(title)) score -= 10;
  if (/lorem ipsum/i.test(preview)) score -= 20;

  // clamp
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return score;
}

function buildProposalFromItem(item) {
  const source = normalizeText(item.eye_id) || 'unknown_eye';
  const url = normalizeText(item.url);
  const title = normalizeText(item.title) || 'External item';
  const topics = Array.isArray(item.topics) ? item.topics : [];
  const preview = normalizeText(item.content_preview);
  // Stable ID: use eye_id + item_hash (external_eyes already computes this)
  // Titles can change; item_hash is already a sha256(url) or content hash
  const h = sha16(`${source}:${item.item_hash || url}`);

  // Proposal ID is deterministic per item hash (stable across runs)
  const id = `EYE-${h}`;

  return {
    id,
    type: 'external_intel',
    title: `[Eyes:${source}] ${title}`.slice(0, 120),
    evidence: [
      {
        source: 'eyes_raw',
        path: `state/sensory/eyes/raw/${item.collected_at ? String(item.collected_at).slice(0, 10) : 'YYYY-MM-DD'}.jsonl`,
        match: `${title} | ${url}`.slice(0, 200),
        // Include URL when available so outcome attribution has richer evidence
        evidence_ref: url ? `eye:${source} url:${url}` : `eye:${source}`
      }
    ],
    expected_impact: scoreItem(item) >= 60 ? 'medium' : 'low',
    risk: scoreItem(item) >= 80 ? 'low' : 'medium',
    validation: [
      'Verify relevance to current goals',
      'Check source link and summarize in 1 sentence',
      'If actionable, convert into a concrete task'
    ],
    suggested_next_command: `open "${url}"`,
    meta: {
      source_eye: source,
      url,
      topics,
      score: scoreItem(item),
      preview: preview.slice(0, 200)
    }
  };
}

function dedupeById(existing, incoming) {
  const seen = new Set(existing.map(p => p && p.id).filter(Boolean));
  const out = [];
  for (const p of incoming) {
    if (!p || !p.id) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

function generateEyeProposals(dateStr, maxCount = 5) {
  ensureDirs();
  const rawPath = path.join(EYES_RAW_DIR, `${dateStr}.jsonl`);
  const events = readJsonlSafe(rawPath);

  const items = events
    .filter(e => e && e.type === 'external_item')
    .map(e => e.item || e)
    .filter(i => i && typeof i === 'object');

  // Deduplicate by URL hash to avoid spamming same link
  const byUrl = new Map();
  for (const item of items) {
    const url = normalizeText(item.url);
    if (!url) continue;
    const key = sha16(url);
    const prev = byUrl.get(key);
    if (!prev) {
      byUrl.set(key, item);
    } else {
      // keep the higher scored one deterministically
      if (scoreItem(item) > scoreItem(prev)) byUrl.set(key, item);
    }
  }

  const deduped = Array.from(byUrl.values());
  deduped.sort((a, b) => {
    const sa = scoreItem(a);
    const sb = scoreItem(b);
    if (sb !== sa) return sb - sa;
    // stable tie-breakers
    const ua = normalizeText(a.url);
    const ub = normalizeText(b.url);
    return ua.localeCompare(ub);
  });

  const proposals = deduped.slice(0, maxCount).map(buildProposalFromItem);
  return { rawPath, proposals };
}

function mergeIntoDailyProposals(dateStr, maxCount = 5) {
  const { proposals: existing, path: proposalsPath } = loadExistingProposals(dateStr);
  const { proposals: newOnes, rawPath } = generateEyeProposals(dateStr, maxCount);

  const toAdd = dedupeById(existing, newOnes);
  const merged = existing.concat(toAdd);

  const savedPath = saveProposalsArray(dateStr, merged);
  return {
    ok: true,
    date: dateStr,
    eyes_raw: rawPath,
    proposals_path: savedPath,
    existing_count: existing.length,
    added_count: toAdd.length,
    total_count: merged.length
  };
}

function parseArgs(argv) {
  const out = { cmd: null, date: null, max: 5 };
  const args = argv.slice(2);
  out.cmd = args[0] || null;
  // date can be second arg if not a flag
  if (args[1] && !String(args[1]).startsWith('--')) out.date = args[1];
  for (const a of args) {
    if (a.startsWith('--max=')) out.max = Number(a.split('=')[1]) || 5;
  }
  return out;
}

function main() {
  const { cmd, date, max } = parseArgs(process.argv);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Eyes Insight (deterministic) - Eyes → Proposals bridge');
    console.log('');
    console.log('Usage:');
    console.log('  node habits/scripts/eyes_insight.js run [YYYY-MM-DD] [--max=N]');
    console.log('');
    console.log('Reads: state/sensory/eyes/raw/YYYY-MM-DD.jsonl');
    console.log('Writes: state/sensory/proposals/YYYY-MM-DD.json (array)');
    process.exit(0);
  }

  const dateStr = date || todayStr();
  if (cmd === 'run') {
    const res = mergeIntoDailyProposals(dateStr, max);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('EYES INSIGHT - MERGE');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Date: ${res.date}`);
    console.log(`Eyes raw: ${res.eyes_raw}`);
    console.log(`Proposals: ${res.proposals_path}`);
    console.log(`Existing: ${res.existing_count}`);
    console.log(`Added: ${res.added_count}`);
    console.log(`Total: ${res.total_count}`);
    console.log('═══════════════════════════════════════════════════════════');
    process.exit(0);
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  scoreItem,
  buildProposalFromItem,
  generateEyeProposals,
  mergeIntoDailyProposals,
  loadExistingProposals,
  saveProposalsArray,
  readJsonlSafe
};
