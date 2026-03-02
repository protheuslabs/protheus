#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-SCI-002
 * HypothesisForge background trend + hypothesis engine.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = process.env.HYPOTHESIS_FORGE_ROOT
  ? path.resolve(process.env.HYPOTHESIS_FORGE_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.HYPOTHESIS_FORGE_POLICY_PATH
  ? path.resolve(process.env.HYPOTHESIS_FORGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'hypothesis_forge_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 320) {
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

function parseJsonArg(raw: unknown, fallback: any = null) {
  const txt = String(raw == null ? '' : raw).trim();
  if (!txt) return fallback;
  try { return JSON.parse(txt); } catch { return fallback; }
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

function stableHash(v: unknown, len = 14) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    require_consent: true,
    score_weights: {
      prior: 0.4,
      voi: 0.35,
      disconfirm_value: 0.25,
      risk_penalty: 0.15
    },
    paths: {
      pending_signals_path: 'state/science/hypothesis_forge/pending_signals.jsonl',
      latest_path: 'state/science/hypothesis_forge/latest.json',
      history_path: 'state/science/hypothesis_forge/history.jsonl',
      ranked_path: 'state/science/hypothesis_forge/ranked.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const w = raw.score_weights && typeof raw.score_weights === 'object' ? raw.score_weights : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    require_consent: raw.require_consent !== false,
    score_weights: {
      prior: clampNumber(w.prior, 0, 2, base.score_weights.prior),
      voi: clampNumber(w.voi, 0, 2, base.score_weights.voi),
      disconfirm_value: clampNumber(w.disconfirm_value, 0, 2, base.score_weights.disconfirm_value),
      risk_penalty: clampNumber(w.risk_penalty, 0, 2, base.score_weights.risk_penalty)
    },
    paths: {
      pending_signals_path: resolvePath(paths.pending_signals_path, base.paths.pending_signals_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      ranked_path: resolvePath(paths.ranked_path, base.paths.ranked_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadJsonl(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function normalizeHypothesisRow(row: AnyObj, idx: number) {
  return {
    id: cleanText(row && row.id, 80) || `hyp_${idx + 1}`,
    text: cleanText(row && row.text, 2000),
    prior: clampNumber(row && row.prior, 0, 1, 0.5),
    voi: clampNumber(row && row.voi, 0, 1, 0.5),
    disconfirm_value: clampNumber(row && row.disconfirm_value, 0, 1, 0.5),
    risk: clampNumber(row && row.risk, 0, 1, 0.2)
  };
}

function rankHypotheses(rows: AnyObj[], policy: AnyObj) {
  const ranked = rows.map((raw, idx) => {
    const row = normalizeHypothesisRow(raw, idx);
    const w = policy.score_weights;
    const score = Number((
      (row.prior * Number(w.prior || 0))
      + (row.voi * Number(w.voi || 0))
      + (row.disconfirm_value * Number(w.disconfirm_value || 0))
      - (row.risk * Number(w.risk_penalty || 0))
    ).toFixed(6));
    return {
      ...row,
      score,
      rank_receipt_id: `hyp_rank_${stableHash(`${row.id}|${row.text}|${score}`, 12)}`
    };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.id).localeCompare(String(b.id));
  });
  return ranked;
}

function cmdRank(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (!policy.enabled) {
    return {
      ok: true,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const consent = toBool(args.consent, false);
  if (policy.require_consent === true && consent !== true) {
    return {
      ok: false,
      error: 'consent_required',
      policy_path: rel(policy.policy_path)
    };
  }

  const inputFile = cleanText(args['input-file'] || args.input_file, 520);
  const inline = parseJsonArg(args['hypotheses-json'] || args.hypotheses_json, null);
  let rows: AnyObj[] = [];
  if (Array.isArray(inline)) rows = inline;
  else if (inputFile) {
    const abs = path.isAbsolute(inputFile) ? inputFile : path.join(ROOT, inputFile);
    const parsed = readJson(abs, []);
    if (Array.isArray(parsed)) rows = parsed;
  }

  const ranked = rankHypotheses(rows, policy);
  const top = ranked.length ? ranked[0] : null;
  const out = {
    ok: true,
    ts: nowIso(),
    type: 'hypothesis_forge_rank',
    consent,
    count: ranked.length,
    top_hypothesis: top,
    ranked
  };

  writeJsonAtomic(policy.paths.ranked_path, out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    count: out.count,
    top_hypothesis_id: top ? top.id : null
  });

  return {
    ...out,
    output_paths: {
      ranked_path: rel(policy.paths.ranked_path),
      latest_path: rel(policy.paths.latest_path)
    },
    policy_path: rel(policy.policy_path)
  };
}

function cmdTick(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (!policy.enabled) {
    return {
      ok: true,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const consent = toBool(args.consent, false);
  if (policy.require_consent === true && consent !== true) {
    return {
      ok: false,
      error: 'consent_required',
      policy_path: rel(policy.policy_path)
    };
  }

  const rows = loadJsonl(policy.paths.pending_signals_path).map((row: AnyObj, idx: number) => ({
    id: cleanText(row && row.id, 80) || `pending_${idx + 1}`,
    text: cleanText(row && row.signal, 1400) || cleanText(row && row.text, 1400),
    prior: clampNumber(row && row.prior, 0, 1, 0.45),
    voi: clampNumber(row && row.voi, 0, 1, 0.55),
    disconfirm_value: clampNumber(row && row.disconfirm_value, 0, 1, 0.6),
    risk: clampNumber(row && row.risk, 0, 1, 0.3)
  })).filter((row: AnyObj) => row.text);

  const ranked = rankHypotheses(rows, policy);
  const out = {
    ok: true,
    ts: nowIso(),
    type: 'hypothesis_forge_tick',
    consent,
    source: rel(policy.paths.pending_signals_path),
    count: ranked.length,
    ranked
  };

  writeJsonAtomic(policy.paths.ranked_path, out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    count: out.count,
    source: out.source
  });

  return {
    ...out,
    output_paths: {
      ranked_path: rel(policy.paths.ranked_path),
      latest_path: rel(policy.paths.latest_path)
    },
    policy_path: rel(policy.policy_path)
  };
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'hypothesis_forge_status',
    latest: readJson(policy.paths.latest_path, null),
    latest_path: rel(policy.paths.latest_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/science/hypothesis_forge.js rank [--input-file=<path>|--hypotheses-json="[]"] --consent=1 [--policy=<path>]');
  console.log('  node systems/science/hypothesis_forge.js tick --consent=1 [--policy=<path>]');
  console.log('  node systems/science/hypothesis_forge.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 80).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  try {
    const out = cmd === 'rank'
      ? cmdRank(args)
      : cmd === 'tick'
        ? cmdTick(args)
        : cmd === 'status'
          ? cmdStatus(args)
          : null;
    if (!out) {
      usage();
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if ((cmd === 'rank' || cmd === 'tick') && out.ok !== true) process.exit(1);
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText(err && err.message ? err.message : err, 420) }, null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  rankHypotheses,
  cmdRank,
  cmdTick,
  cmdStatus
};
