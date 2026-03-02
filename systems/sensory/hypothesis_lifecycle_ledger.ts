#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-092
 * Hypothesis lifecycle ledger.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.HYPOTHESIS_LIFECYCLE_POLICY_PATH
  ? path.resolve(process.env.HYPOTHESIS_LIFECYCLE_POLICY_PATH)
  : path.join(ROOT, 'config', 'hypothesis_lifecycle_ledger_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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
    paths: {
      hypotheses_dir: 'state/sensory/cross_signal/hypotheses',
      challenger_dir: 'state/sensory/analysis/adversarial_challenger',
      outcomes_dir: 'state/sensory/analysis/hypothesis_outcomes',
      state_path: 'state/sensory/analysis/hypothesis_lifecycle/state.json',
      ledger_path: 'state/sensory/analysis/hypothesis_lifecycle/ledger.jsonl',
      output_dir: 'state/sensory/analysis/hypothesis_lifecycle',
      latest_path: 'state/sensory/analysis/hypothesis_lifecycle/latest.json',
      receipts_path: 'state/sensory/analysis/hypothesis_lifecycle/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    paths: {
      hypotheses_dir: resolvePath(paths.hypotheses_dir, base.paths.hypotheses_dir),
      challenger_dir: resolvePath(paths.challenger_dir, base.paths.challenger_dir),
      outcomes_dir: resolvePath(paths.outcomes_dir, base.paths.outcomes_dir),
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      ledger_path: resolvePath(paths.ledger_path, base.paths.ledger_path),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadHypotheses(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.hypotheses_dir, `${dateStr}.json`);
  const src = readJson(fp, null);
  const rows = src && Array.isArray(src.hypotheses) ? src.hypotheses : [];
  return {
    file_path: fp,
    rows: rows.filter((row: any) => row && typeof row === 'object')
  };
}

function loadChallenger(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.challenger_dir, `${dateStr}.json`);
  const src = readJson(fp, null);
  const rows = src && Array.isArray(src.challenges) ? src.challenges : [];
  const byHypothesis = new Map();
  for (const row of rows) {
    const hypothesisId = cleanText(row && row.source_hypothesis_id || '', 160);
    if (!hypothesisId) continue;
    byHypothesis.set(hypothesisId, {
      verification_outcome: normalizeToken(row && row.verification_outcome || '', 60),
      verification_reason: cleanText(row && row.verification_reason || '', 120) || null
    });
  }
  return {
    file_path: fp,
    byHypothesis
  };
}

function loadOutcomes(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.outcomes_dir, `${dateStr}.json`);
  const src = readJson(fp, null);
  const rows = src && Array.isArray(src.outcomes) ? src.outcomes : [];
  const map = new Map();
  for (const row of rows) {
    const id = cleanText(row && row.hypothesis_id || '', 160);
    if (!id) continue;
    map.set(id, normalizeToken(row && row.outcome || '', 80));
  }
  return {
    file_path: fp,
    byHypothesis: map
  };
}

function loadState(policy: Record<string, any>) {
  const src = readJson(policy.paths.state_path, {
    schema_id: 'hypothesis_lifecycle_state',
    version: '1.0',
    hypotheses: {}
  });
  const rows = src && src.hypotheses && typeof src.hypotheses === 'object' ? src.hypotheses : {};
  return rows;
}

function deriveStatus(outcome: string | null, challenger: Record<string, any> | null) {
  if (outcome && ['true_positive', 'accepted', 'validated', 'success'].includes(outcome)) return 'accepted';
  if (outcome && ['false_positive', 'false_negative', 'rejected', 'invalidated', 'failure'].includes(outcome)) return 'rejected';
  if (challenger && ['win', 'unresolved'].includes(String(challenger.verification_outcome || ''))) return 'tested';
  return 'proposed';
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const hypothesesSrc = loadHypotheses(policy, dateStr);
  const challengerSrc = loadChallenger(policy, dateStr);
  const outcomesSrc = loadOutcomes(policy, dateStr);
  const state = loadState(policy);
  const nextState = { ...state };
  const transitions = [];

  for (const row of hypothesesSrc.rows) {
    const hypothesisId = cleanText(row && row.id || '', 160);
    if (!hypothesisId) continue;

    const outcome = outcomesSrc.byHypothesis.get(hypothesisId) || null;
    const challenger = challengerSrc.byHypothesis.get(hypothesisId) || null;
    const status = deriveStatus(outcome, challenger);

    const prev = nextState[hypothesisId] || {
      hypothesis_id: hypothesisId,
      status: null,
      outcome: null,
      transition_count: 0
    };

    const changed = String(prev.status || '') !== String(status || '')
      || String(prev.outcome || '') !== String(outcome || '');

    if (changed) {
      const transition = {
        transition_id: `hll_${stableHash(`${dateStr}|${hypothesisId}|${prev.status}|${status}|${outcome}`, 20)}`,
        ts: nowIso(),
        date: dateStr,
        hypothesis_id: hypothesisId,
        topic: cleanText(row && row.topic || '', 120) || null,
        from_status: prev.status,
        to_status: status,
        outcome,
        challenger_outcome: challenger ? challenger.verification_outcome : null,
        challenger_reason: challenger ? challenger.verification_reason : null,
        transition_count: Number(prev.transition_count || 0) + 1
      };
      transitions.push(transition);
      appendJsonl(policy.paths.ledger_path, transition);
    }

    nextState[hypothesisId] = {
      hypothesis_id: hypothesisId,
      topic: cleanText(row && row.topic || '', 120) || null,
      status,
      outcome,
      challenger_outcome: challenger ? challenger.verification_outcome : null,
      updated_at: nowIso(),
      transition_count: Number(prev.transition_count || 0) + (changed ? 1 : 0)
    };
  }

  const summary = {
    proposed: 0,
    tested: 0,
    accepted: 0,
    rejected: 0
  };

  for (const row of Object.values(nextState) as any[]) {
    const status = normalizeToken(row && row.status || '', 40);
    if (status in summary) summary[status as keyof typeof summary] += 1;
  }

  const out = {
    ok: true,
    type: 'hypothesis_lifecycle_ledger',
    ts: nowIso(),
    date: dateStr,
    source_paths: {
      hypotheses: hypothesesSrc.file_path,
      challenger: challengerSrc.file_path,
      outcomes: outcomesSrc.file_path,
      ledger: policy.paths.ledger_path
    },
    hypothesis_count: Object.keys(nextState).length,
    transitions_emitted: transitions.length,
    status_summary: summary,
    transitions
  };

  ensureDir(path.dirname(policy.paths.state_path));
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'hypothesis_lifecycle_state',
    version: String(policy.version || '1.0'),
    updated_at: nowIso(),
    hypotheses: nextState
  });

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'hypothesis_lifecycle_receipt',
    date: dateStr,
    hypothesis_count: out.hypothesis_count,
    transitions_emitted: out.transitions_emitted,
    status_summary: out.status_summary
  });

  if (strict && transitions.length === 0) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.output_dir, `${dateStr}.json`);
  const payload = readJson(fp, {
    ok: true,
    type: 'hypothesis_lifecycle_ledger_status',
    date: dateStr,
    hypothesis_count: 0,
    transitions_emitted: 0
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/hypothesis_lifecycle_ledger.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/hypothesis_lifecycle_ledger.js status [YYYY-MM-DD] [--policy=<path>]');
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
