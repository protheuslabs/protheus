#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-100
 * Causal validation gate for high-impact claims.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.CAUSAL_VALIDATION_GATE_POLICY_PATH
  ? path.resolve(process.env.CAUSAL_VALIDATION_GATE_POLICY_PATH)
  : path.join(ROOT, 'config', 'causal_validation_gate_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
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

function writeJsonAtomic(filePath: string, value: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function stableHash(v: unknown, len = 18) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    high_impact_threshold: 0.7,
    min_causal_confidence: 0.65,
    min_intervention_count: 1,
    weights: {
      replay_evidence: 0.45,
      intervention_evidence: 0.35,
      source_reliability: 0.2
    },
    paths: {
      claims_dir: 'state/sensory/analysis/high_impact_claims',
      output_dir: 'state/sensory/analysis/causal_validation_gate',
      latest_path: 'state/sensory/analysis/causal_validation_gate/latest.json',
      receipts_path: 'state/sensory/analysis/causal_validation_gate/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const weights = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    high_impact_threshold: clampNumber(raw.high_impact_threshold, 0, 1, base.high_impact_threshold),
    min_causal_confidence: clampNumber(raw.min_causal_confidence, 0, 1, base.min_causal_confidence),
    min_intervention_count: clampNumber(raw.min_intervention_count, 0, 100, base.min_intervention_count),
    weights: {
      replay_evidence: clampNumber(weights.replay_evidence, 0, 1, base.weights.replay_evidence),
      intervention_evidence: clampNumber(weights.intervention_evidence, 0, 1, base.weights.intervention_evidence),
      source_reliability: clampNumber(weights.source_reliability, 0, 1, base.weights.source_reliability)
    },
    paths: {
      claims_dir: resolvePath(paths.claims_dir, base.paths.claims_dir),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadClaims(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.claims_dir, `${dateStr}.json`);
  const src = readJson(fp, null);
  const rows = src && Array.isArray(src.claims) ? src.claims : [];
  return {
    file_path: fp,
    rows: rows.filter((row: any) => row && typeof row === 'object')
  };
}

function causalConfidence(claim: Record<string, any>, policy: Record<string, any>) {
  const replay = clampNumber(claim && claim.replay_evidence_confidence, 0, 1, 0);
  const interventions = clampNumber(claim && claim.intervention_count, 0, 100, 0);
  const interventionConfidence = interventions >= Number(policy.min_intervention_count || 1)
    ? clampNumber(claim && claim.intervention_evidence_confidence, 0, 1, 0)
    : 0;
  const sourceRel = clampNumber(claim && claim.source_reliability, 0, 1, 0.5);
  const score = clampNumber(
    (replay * Number(policy.weights.replay_evidence || 0.45))
    + (interventionConfidence * Number(policy.weights.intervention_evidence || 0.35))
    + (sourceRel * Number(policy.weights.source_reliability || 0.2)),
    0,
    1,
    0
  );
  return {
    replay,
    interventions,
    intervention_confidence: interventionConfidence,
    source_reliability: sourceRel,
    score: Number(score.toFixed(6))
  };
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const source = loadClaims(policy, dateStr);
  const validated = [];
  const blocked = [];

  for (const claim of source.rows) {
    const claimId = cleanText(claim && claim.claim_id || `claim_${stableHash(JSON.stringify(claim), 12)}`, 120);
    const impact = clampNumber(claim && claim.impact_score, 0, 1, 0);
    const highImpact = impact >= Number(policy.high_impact_threshold || 0.7);
    const cc = causalConfidence(claim, policy);

    const reasons = [];
    if (highImpact && cc.score < Number(policy.min_causal_confidence || 0.65)) {
      reasons.push('causal_confidence_below_threshold');
    }
    if (highImpact && cc.interventions < Number(policy.min_intervention_count || 1)) {
      reasons.push('insufficient_intervention_evidence');
    }

    const record = {
      claim_id: claimId,
      impact_score: Number(impact.toFixed(6)),
      high_impact: highImpact,
      causal_confidence: cc.score,
      evidence: {
        replay_evidence_confidence: cc.replay,
        intervention_count: cc.interventions,
        intervention_evidence_confidence: cc.intervention_confidence,
        source_reliability: cc.source_reliability
      },
      reasons
    };

    if (reasons.length > 0) {
      blocked.push({ ...record, decision: 'block' });
    } else {
      validated.push({ ...record, decision: 'allow' });
    }
  }

  const out = {
    ok: blocked.length === 0,
    type: 'causal_validation_gate_high_impact',
    ts: nowIso(),
    date: dateStr,
    source_claims_path: source.file_path,
    validated_count: validated.length,
    blocked_count: blocked.length,
    validated,
    blocked
  };

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'causal_validation_gate_receipt',
    date: dateStr,
    validated_count: validated.length,
    blocked_count: blocked.length,
    top_blocked_claim: blocked[0] ? blocked[0].claim_id : null
  });

  if (strict && blocked.length > 0) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.output_dir, `${dateStr}.json`);
  const payload = readJson(fp, {
    ok: true,
    type: 'causal_validation_gate_high_impact_status',
    date: dateStr,
    blocked_count: 0
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/causal_validation_gate_high_impact.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/causal_validation_gate_high_impact.js status [YYYY-MM-DD] [--policy=<path>]');
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase() || 'status';
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(args._[1] || '')) ? String(args._[1]) : todayStr();
  const strict = toBool(args.strict, false);
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'policy_disabled' }, null, 2)}\n`);
    process.exit(2);
  }
  if (cmd === 'run') return run(dateStr, policy, strict);
  if (cmd === 'status') return status(policy, dateStr);
  return usageAndExit(2);
}

module.exports = {
  run
};

if (require.main === module) {
  main();
}
