#!/usr/bin/env node
'use strict';
export {};

const {
  normalizeIntent,
  clampNumber,
  cleanText,
  nowIso
} = require('./contracts');

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = arg.indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
  }
  return out;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function keywordCount(tokens, set) {
  let hits = 0;
  for (const token of tokens) {
    if (set.has(token)) hits += 1;
  }
  return hits;
}

const SPEED_WORDS = new Set([
  'fast', 'faster', 'quick', 'quickly', 'rapid', 'immediate', 'immediately', 'realtime', 'instant', 'ship'
]);

const ROBUST_WORDS = new Set([
  'safe', 'safety', 'secure', 'stability', 'stable', 'reliable', 'robust', 'quality', 'deterministic', 'guarded'
]);

const COST_WORDS = new Set([
  'cheap', 'budget', 'efficient', 'efficiency', 'token', 'cost', 'frugal', 'lowcost', 'optimize', 'savings'
]);

const UNCERTAINTY_WORDS = new Set([
  'maybe', 'possibly', 'unclear', 'unknown', 'explore', 'experiment', 'idea', 'brainstorm', 'optional'
]);

const EXTERNAL_RISK_WORDS = new Set([
  'publish', 'payment', 'payments', 'deploy', 'production', 'customer', 'email', 'external', 'api', 'browser'
]);

const NOVELTY_WORDS = new Set([
  'new', 'novel', 'invent', 'creative', 'fractal', 'emergent', 'adaptive', 'dynamic', 'self', 'evolve'
]);

function buildConstraintWeights(tokens) {
  const speedHits = keywordCount(tokens, SPEED_WORDS);
  const robustHits = keywordCount(tokens, ROBUST_WORDS);
  const costHits = keywordCount(tokens, COST_WORDS);
  const baseline = { speed_weight: 0.34, robustness_weight: 0.33, cost_weight: 0.33 };
  const totalHits = speedHits + robustHits + costHits;
  if (totalHits <= 0) return baseline;

  const speed = 0.2 + (speedHits / totalHits) * 0.8;
  const robustness = 0.2 + (robustHits / totalHits) * 0.8;
  const cost = 0.2 + (costHits / totalHits) * 0.8;
  const total = speed + robustness + cost;
  return {
    speed_weight: Number((speed / total).toFixed(4)),
    robustness_weight: Number((robustness / total).toFixed(4)),
    cost_weight: Number((cost / total).toFixed(4))
  };
}

function inferUncertaintyBand(tokens, text) {
  const uncertain = keywordCount(tokens, UNCERTAINTY_WORDS);
  const hasNumeric = /\d/.test(String(text || ''));
  if (uncertain >= 2) return 'high';
  if (uncertain === 1) return hasNumeric ? 'medium' : 'high';
  if (hasNumeric) return 'low';
  return 'medium';
}

function inferSignals(tokens, constraints, uncertainty) {
  const externalRisk = keywordCount(tokens, EXTERNAL_RISK_WORDS);
  const noveltyHits = keywordCount(tokens, NOVELTY_WORDS);
  const feasibilityRaw = (constraints.robustness_weight * 0.7) - (constraints.speed_weight * 0.2) - (uncertainty === 'high' ? 0.4 : 0);
  const riskRaw = (externalRisk > 0 ? -0.7 : 0.2) - (constraints.robustness_weight * 0.2);
  const noveltyRaw = noveltyHits > 0 ? 0.7 : (uncertainty === 'high' ? 0.3 : -0.2);
  return {
    feasibility: Number(clampNumber(feasibilityRaw, -1, 1, 0).toFixed(4)),
    risk: Number(clampNumber(riskRaw, -1, 1, 0).toFixed(4)),
    novelty: Number(clampNumber(noveltyRaw, -1, 1, 0).toFixed(4))
  };
}

function analyzeIntent(intentText, opts = {}) {
  const strategy = opts.strategy && typeof opts.strategy === 'object' ? opts.strategy : {};
  const objectiveText = cleanText(
    intentText
      || opts.intent
      || (strategy.objective && strategy.objective.primary)
      || 'Generate adaptive workflows that improve verified outcomes under active directives.',
    280
  );
  const tokens = tokenize(objectiveText);
  const constraints = buildConstraintWeights(tokens);
  const uncertainty = inferUncertaintyBand(tokens, objectiveText);
  const signals = inferSignals(tokens, constraints, uncertainty);
  return normalizeIntent({
    objective: objectiveText,
    uncertainty_band: uncertainty,
    constraints,
    signals,
    source: opts.source || 'orchestron_intent_analyzer',
    ts: nowIso()
  }, strategy);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/orchestron/intent_analyzer.js run --intent="..."');
}

function runCli(args) {
  const out = analyzeIntent(args.intent || args._[1] || '');
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'orchestron_intent', intent: out })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').trim().toLowerCase();
  if (args.help === true || args.h === true || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  if (!args._.length) {
    usage();
    return;
  }
  if (cmd === 'run') {
    runCli(args);
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'orchestron_intent',
      error: String(err && err.message ? err.message : err || 'intent_analyzer_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  analyzeIntent
};
