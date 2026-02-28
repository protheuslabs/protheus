#!/usr/bin/env node
'use strict';
export {};

/**
 * genuine_creative_breakthrough_organ.js
 *
 * V3-CRT-001:
 * Bounded novelty generator for new skill/organ/strategy candidates.
 * Output is proposal-only and must pass downstream gates before grafting.
 *
 * Commands:
 *   node systems/autonomy/genuine_creative_breakthrough_organ.js run [--context-json="{...}"] [--max=<n>] [--apply=0|1]
 *   node systems/autonomy/genuine_creative_breakthrough_organ.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.GENUINE_CREATIVE_BREAKTHROUGH_POLICY_PATH
  ? path.resolve(process.env.GENUINE_CREATIVE_BREAKTHROUGH_POLICY_PATH)
  : path.join(ROOT, 'config', 'genuine_creative_breakthrough_organ_policy.json');
const MIRROR_ORGAN_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'mirror_organ.js');
const CONSTITUTION_GUARD_SCRIPT = path.join(ROOT, 'systems', 'security', 'constitution_guardian.js');

type AnyObj = Record<string, any>;

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 240) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}
function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v); if (!Number.isFinite(n)) return fallback; const i = Math.floor(n); if (i < lo) return lo; if (i > hi) return hi; return i;
}
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const idx = tok.indexOf('=');
    if (idx >= 0) { out[tok.slice(2, idx)] = tok.slice(idx + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
    out[key] = true;
  }
  return out;
}
function parseJsonArg(raw: unknown, fallback: any = {}) {
  const txt = String(raw == null ? '' : raw).trim();
  if (!txt) return fallback;
  try { const parsed = JSON.parse(txt); return parsed && typeof parsed === 'object' ? parsed : fallback; } catch { return fallback; }
}
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
}
function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 420);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}
function parseJsonOutput(raw: unknown) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { return JSON.parse(lines[i]); } catch {}
    }
  }
  return null;
}
function runNodeJson(scriptPath: string, args: string[], timeoutMs = 2200) {
  const proc = spawnSync(process.execPath, [scriptPath, ...args], { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs });
  return {
    ok: proc.status === 0,
    payload: parseJsonOutput(proc.stdout),
    timed_out: Boolean(proc.error && (proc.error as AnyObj).code === 'ETIMEDOUT')
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    max_candidates_per_run: 5,
    candidate_classes: ['new_primitive', 'primitive_upgrade', 'extension_profile'],
    novelty_floor: 0.65,
    state: {
      state_path: 'state/autonomy/genuine_creative_breakthrough/state.json',
      latest_path: 'state/autonomy/genuine_creative_breakthrough/latest.json',
      receipts_path: 'state/autonomy/genuine_creative_breakthrough/receipts.jsonl',
      candidates_path: 'state/autonomy/genuine_creative_breakthrough/candidates.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    max_candidates_per_run: clampInt(raw.max_candidates_per_run, 1, 128, base.max_candidates_per_run),
    candidate_classes: Array.from(new Set((Array.isArray(raw.candidate_classes) ? raw.candidate_classes : base.candidate_classes)
      .map((row: unknown) => normalizeToken(row, 60)).filter(Boolean))),
    novelty_floor: Number.isFinite(Number(raw.novelty_floor)) ? Math.max(0, Math.min(1, Number(raw.novelty_floor))) : base.novelty_floor,
    state: {
      state_path: resolvePath(state.state_path || base.state.state_path, base.state.state_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path),
      candidates_path: resolvePath(state.candidates_path || base.state.candidates_path, base.state.candidates_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState() {
  return {
    schema_id: 'genuine_creative_breakthrough_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    run_count: 0,
    accepted_count: 0,
    recent_candidate_hashes: [] as string[]
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state.state_path, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'genuine_creative_breakthrough_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 60) || nowIso(),
    run_count: clampInt(src.run_count, 0, 1_000_000_000, 0),
    accepted_count: clampInt(src.accepted_count, 0, 1_000_000_000, 0),
    recent_candidate_hashes: Array.isArray(src.recent_candidate_hashes)
      ? src.recent_candidate_hashes.map((row: unknown) => cleanText(row, 80)).filter(Boolean).slice(0, 500)
      : []
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state.state_path, {
    schema_id: 'genuine_creative_breakthrough_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    run_count: clampInt(state.run_count, 0, 1_000_000_000, 0),
    accepted_count: clampInt(state.accepted_count, 0, 1_000_000_000, 0),
    recent_candidate_hashes: Array.isArray(state.recent_candidate_hashes)
      ? state.recent_candidate_hashes.map((row: unknown) => cleanText(row, 80)).filter(Boolean).slice(0, 500)
      : []
  });
}

function persistLatest(policy: AnyObj, row: AnyObj) {
  writeJsonAtomic(policy.state.latest_path, row);
  appendJsonl(policy.state.receipts_path, row);
}

function makeCandidate(seed: AnyObj, idx: number, cls: string) {
  const objective = normalizeToken(seed.objective || seed.goal || 't1_growth', 120) || 't1_growth';
  const topic = normalizeToken(seed.topic || seed.domain || `theme_${idx + 1}`, 120) || `theme_${idx + 1}`;
  const hint = `${objective}_${topic}_${cls}_${idx + 1}`;
  const digest = crypto.createHash('sha256').update(hint, 'utf8').digest('hex');
  const novelty = Number((0.55 + ((parseInt(digest.slice(0, 2), 16) / 255) * 0.44)).toFixed(6));
  return {
    candidate_id: `crt_${digest.slice(0, 12)}`,
    class: cls,
    objective,
    topic,
    title: `${cls.replace(/_/g, ' ')} for ${topic}`,
    novelty_score: novelty,
    confidence: Number((0.45 + ((parseInt(digest.slice(2, 4), 16) / 255) * 0.45)).toFixed(6)),
    proposal: {
      summary: `Generate bounded ${cls} candidate on ${topic} to increase ${objective}.`,
      integration_hint: 'mirror_redteam_constitution_gate_required'
    }
  };
}

function run(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const context = parseJsonArg(args['context-json'] || args.context_json, {});
  const max = clampInt(args.max, 1, 128, policy.max_candidates_per_run);
  const classes = (policy.candidate_classes || []).slice(0, 8);
  const seeds = Array.isArray(context.seeds) ? context.seeds : [context];

  const mirror = runNodeJson(MIRROR_ORGAN_SCRIPT, ['status', 'latest']);
  const constitution = runNodeJson(CONSTITUTION_GUARD_SCRIPT, ['status']);
  const governance = {
    mirror_ok: mirror.ok,
    constitution_ok: constitution.ok,
    reason_codes: [] as string[]
  };
  if (!mirror.ok) governance.reason_codes.push(mirror.timed_out ? 'mirror_probe_timeout' : 'mirror_probe_failed');
  if (!constitution.ok) governance.reason_codes.push(constitution.timed_out ? 'constitution_probe_timeout' : 'constitution_probe_failed');

  const candidates: AnyObj[] = [];
  for (let i = 0; i < max; i += 1) {
    const cls = classes[i % Math.max(1, classes.length)] || 'extension_profile';
    const seed = seeds[i % Math.max(1, seeds.length)] || {};
    const candidate = makeCandidate(seed, i, cls);
    const hash = crypto.createHash('sha256').update(JSON.stringify(candidate), 'utf8').digest('hex').slice(0, 24);
    const duplicate = state.recent_candidate_hashes.includes(hash);
    if (duplicate) continue;
    if (Number(candidate.novelty_score || 0) < Number(policy.novelty_floor || 0.65)) continue;
    candidate.hash = hash;
    candidates.push(candidate);
    state.recent_candidate_hashes.unshift(hash);
    if (candidates.length >= max) break;
  }
  state.recent_candidate_hashes = state.recent_candidate_hashes.slice(0, 500);

  const accepted = candidates.length;
  state.run_count = clampInt(Number(state.run_count || 0) + 1, 0, 1_000_000_000, 0);
  state.accepted_count = clampInt(Number(state.accepted_count || 0) + accepted, 0, 1_000_000_000, 0);
  saveState(policy, state);

  for (const candidate of candidates) {
    appendJsonl(policy.state.candidates_path, {
      ts: nowIso(),
      type: 'creative_breakthrough_candidate',
      shadow_only: policy.shadow_only === true,
      governance,
      candidate
    });
  }

  const out = {
    ok: true,
    type: 'genuine_creative_breakthrough_run',
    ts: nowIso(),
    shadow_only: policy.shadow_only === true,
    governance,
    candidates_generated: accepted,
    candidates,
    paths: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.state.state_path),
      candidates_path: rel(policy.state.candidates_path),
      latest_path: rel(policy.state.latest_path)
    }
  };
  persistLatest(policy, out);
  return out;
}

function status(policy: AnyObj) {
  const state = loadState(policy);
  const latest = readJson(policy.state.latest_path, null);
  return {
    ok: true,
    type: 'genuine_creative_breakthrough_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      novelty_floor: policy.novelty_floor
    },
    state,
    latest: latest && typeof latest === 'object'
      ? {
        type: cleanText(latest.type || '', 80) || null,
        ts: cleanText(latest.ts || '', 60) || null,
        candidates_generated: clampInt(latest.candidates_generated, 0, 100000, 0)
      }
      : null,
    paths: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.state.state_path),
      latest_path: rel(policy.state.latest_path),
      receipts_path: rel(policy.state.receipts_path),
      candidates_path: rel(policy.state.candidates_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/genuine_creative_breakthrough_organ.js run [--context-json="{...}"] [--max=<n>] [--apply=0|1]');
  console.log('  node systems/autonomy/genuine_creative_breakthrough_organ.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  let out: AnyObj;
  if (!policy.enabled) {
    out = { ok: false, type: 'genuine_creative_breakthrough_organ', ts: nowIso(), error: 'policy_disabled' };
  } else if (cmd === 'run') {
    out = run(policy, args);
  } else if (cmd === 'status') {
    out = status(policy);
  } else if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
    return;
  } else {
    out = { ok: false, type: 'genuine_creative_breakthrough_organ', ts: nowIso(), error: `unknown_command:${cmd}` };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  run,
  status
};
