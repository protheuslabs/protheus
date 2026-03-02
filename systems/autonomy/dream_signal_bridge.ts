#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-039
 * Bridge dream signals into proposal ranking metadata with attribution.
 *
 * Usage:
 *   node systems/autonomy/dream_signal_bridge.js run [--apply=1|0] [--date=YYYY-MM-DD] [--strict=1|0]
 *   node systems/autonomy/dream_signal_bridge.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.DREAM_SIGNAL_BRIDGE_ROOT
  ? path.resolve(process.env.DREAM_SIGNAL_BRIDGE_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.DREAM_SIGNAL_BRIDGE_POLICY_PATH
  ? path.resolve(process.env.DREAM_SIGNAL_BRIDGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'dream_signal_bridge_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 360) {
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

function readJsonl(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const lines = String(fs.readFileSync(filePath, 'utf8') || '').split(/\r?\n/).filter(Boolean);
  const out: AnyObj[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') out.push(row);
    } catch {}
  }
  return out;
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

function tokenize(v: unknown) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 400);
}

function dateArgOrToday(v: unknown) {
  const s = cleanText(v, 20);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    dreams_path: 'state/memory/dreams',
    proposals_path: 'state/autonomy/dream_signal_bridge/proposals.jsonl',
    min_quality_score: 0.2,
    max_alignment_bonus: 6,
    outputs: {
      latest_path: 'state/autonomy/dream_signal_bridge/latest.json',
      history_path: 'state/autonomy/dream_signal_bridge/history.jsonl',
      enriched_output_path: 'state/autonomy/dream_signal_bridge/enriched_proposals.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    dreams_path: resolvePath(raw.dreams_path, base.dreams_path),
    proposals_path: resolvePath(raw.proposals_path, base.proposals_path),
    min_quality_score: clampNumber(raw.min_quality_score, 0, 1, base.min_quality_score),
    max_alignment_bonus: clampNumber(raw.max_alignment_bonus, 0, 100, base.max_alignment_bonus),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path),
      enriched_output_path: resolvePath(outputs.enriched_output_path, base.outputs.enriched_output_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadDreamSignals(dreamsRoot: string, date: string) {
  const dayPath = path.join(dreamsRoot, `${date}.json`);
  const remPath = path.join(dreamsRoot, 'rem', `${date}.json`);
  const day = readJson(dayPath, {});
  const rem = readJson(remPath, {});

  const tokens: string[] = [];
  const pushTokens = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const t = cleanText(item, 60).toLowerCase();
      if (!t) continue;
      if (!tokens.includes(t)) tokens.push(t);
    }
  };

  pushTokens(day.tokens);
  pushTokens(rem.tokens);

  const links = []
    .concat(Array.isArray(day.idle_links) ? day.idle_links : [])
    .concat(Array.isArray(rem.rem_links) ? rem.rem_links : []);
  for (const link of links) {
    if (!link || typeof link !== 'object') continue;
    pushTokens([link.token, link.topic, link.hint]);
  }

  const qualityCandidates = []
    .concat(Number(day.quality_score || 0))
    .concat(Number(rem.quality_score || 0))
    .filter(Number.isFinite)
    .map((n) => clampNumber(n, 0, 1, 0));
  const quality = qualityCandidates.length
    ? qualityCandidates.reduce((s, x) => s + x, 0) / qualityCandidates.length
    : 0;

  return {
    available: tokens.length > 0,
    date,
    tokens,
    quality_score: Number(quality.toFixed(4)),
    sources: [
      fs.existsSync(dayPath) ? rel(dayPath) : null,
      fs.existsSync(remPath) ? rel(remPath) : null
    ].filter(Boolean)
  };
}

function loadProposals(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    const parsed = readJson(filePath, []);
    return Array.isArray(parsed) ? parsed : [];
  }
  return readJsonl(filePath);
}

function scoreProposalWithDream(proposal: AnyObj, dream: AnyObj, policy: AnyObj) {
  const blob = [
    proposal.title,
    proposal.summary,
    proposal.description,
    proposal.type,
    JSON.stringify(proposal.evidence || []),
    JSON.stringify(proposal.meta || {})
  ].join(' ');
  const hay = new Set(tokenize(blob));
  const matched = (dream.tokens || []).filter((tok: string) => hay.has(tok));
  const quality = clampNumber(dream.quality_score, 0, 1, 0);
  const rawBonus = matched.length * (1 + quality);
  const bonus = quality >= Number(policy.min_quality_score || 0)
    ? Math.min(Number(policy.max_alignment_bonus || 0), rawBonus)
    : 0;
  const baseScore = Number(proposal.score || proposal.rank_score || 0);
  const rankScore = Number((baseScore + bonus).toFixed(4));

  return {
    ...proposal,
    rank_score: rankScore,
    meta: {
      ...(proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {}),
      dream_signal_available: dream.available === true,
      dream_signal_quality_score: quality,
      dream_alignment_tokens: matched,
      dream_alignment_bonus: Number(bonus.toFixed(4)),
      dream_hit: matched.length > 0,
      dream_bridge_date: dream.date
    }
  };
}

function cmdRun(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const apply = toBool(args.apply, false);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const date = dateArgOrToday(args.date);

  if (!policy.enabled) {
    return {
      ok: true,
      strict,
      apply,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const dream = loadDreamSignals(policy.dreams_path, date);
  const proposals = loadProposals(policy.proposals_path);
  const enriched = proposals.map((p) => scoreProposalWithDream(p && typeof p === 'object' ? p : {}, dream, policy));
  enriched.sort((a, b) => Number(b.rank_score || 0) - Number(a.rank_score || 0));

  const dreamHitCount = enriched.filter((row) => row && row.meta && row.meta.dream_hit === true).length;
  const attribution = {
    proposals_scored: enriched.length,
    dream_hit_count: dreamHitCount,
    dream_hit_ratio: enriched.length > 0 ? Number((dreamHitCount / enriched.length).toFixed(4)) : 0,
    total_bonus_applied: Number(enriched.reduce((s, row) => s + Number(row?.meta?.dream_alignment_bonus || 0), 0).toFixed(4)),
    top_dream_hits: enriched
      .filter((row) => row?.meta?.dream_hit === true)
      .slice(0, 5)
      .map((row) => ({
        proposal_id: cleanText(row.proposal_id || row.id || '', 80) || null,
        rank_score: Number(row.rank_score || 0),
        dream_alignment_bonus: Number(row?.meta?.dream_alignment_bonus || 0),
        dream_alignment_tokens: Array.isArray(row?.meta?.dream_alignment_tokens)
          ? row.meta.dream_alignment_tokens.slice(0, 8)
          : []
      }))
  };

  const out = {
    ok: true,
    ts: nowIso(),
    type: 'dream_signal_bridge',
    strict,
    apply,
    dream,
    attribution,
    top_ranked: enriched.slice(0, 10),
    policy_path: rel(policy.policy_path)
  };

  if (apply) {
    writeJsonAtomic(policy.outputs.enriched_output_path, {
      ts: out.ts,
      date,
      attribution,
      proposals: enriched
    });
  }

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    date,
    apply,
    proposals_scored: attribution.proposals_scored,
    dream_hit_count: attribution.dream_hit_count,
    total_bonus_applied: attribution.total_bonus_applied,
    ok: true
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'dream_signal_bridge_status',
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null),
    enriched_output_path: rel(policy.outputs.enriched_output_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/dream_signal_bridge.js run [--apply=1|0] [--date=YYYY-MM-DD] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/autonomy/dream_signal_bridge.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  try {
    const payload = cmd === 'run'
      ? cmdRun(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'dream_signal_bridge_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  cmdRun,
  cmdStatus
};
