#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/ops/organ_atrophy_controller.js
 *
 * Shadow-mode usefulness/atrophy scaffold:
 * - Scores organ usefulness from recent runtime activity.
 * - Emits candidate atrophy ledger rows (no live deactivation).
 * - Writes dormant endpoint payloads for fast future revive.
 * - Exposes manual revive endpoint for operator-driven wake requests.
 *
 * Usage:
 *   node systems/ops/organ_atrophy_controller.js scan [YYYY-MM-DD] [--policy=path] [--window-days=N] [--max-candidates=N] [--persist=1|0] [--write-endpoints=1|0]
 *   node systems/ops/organ_atrophy_controller.js status [latest|YYYY-MM-DD] [--policy=path]
 *   node systems/ops/organ_atrophy_controller.js revive --organ-id=<id> [--policy=path] [--reason=txt] [--persist=1|0]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'organ_atrophy_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/organ_atrophy_controller.js scan [YYYY-MM-DD] [--policy=path] [--window-days=N] [--max-candidates=N] [--persist=1|0] [--write-endpoints=1|0]');
  console.log('  node systems/ops/organ_atrophy_controller.js status [latest|YYYY-MM-DD] [--policy=path]');
  console.log('  node systems/ops/organ_atrophy_controller.js revive --organ-id=<id> [--policy=path] [--reason=txt] [--persist=1|0]');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
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

function nowIso() {
  return new Date().toISOString();
}

function toDate(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function shiftDate(dateStr: string, deltaDays: number) {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return dateStr;
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  return base.toISOString().slice(0, 10);
}

function windowDates(dateStr: string, days: number) {
  const out: string[] = [];
  const n = Math.max(1, Math.floor(Number(days || 1)));
  for (let i = n - 1; i >= 0; i -= 1) out.push(shiftDate(dateStr, -i));
  return out;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clamp01(v: unknown, fallback = 0) {
  return clampNumber(v, 0, 1, fallback);
}

function safeNumber(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function normalizeToken(v: unknown, maxLen = 120) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .trim()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseTsMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function sha256Text(text: string) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function stableId(prefix: string, seed: string) {
  const digest = sha256Text(seed).slice(0, 14);
  return `${prefix}_${digest}`;
}

function runtimePaths(policyPath: string) {
  const stateDir = process.env.ORGAN_ATROPHY_STATE_DIR
    ? path.resolve(process.env.ORGAN_ATROPHY_STATE_DIR)
    : path.join(ROOT, 'state', 'autonomy', 'organs', 'atrophy');
  const dormantDir = process.env.ORGAN_ATROPHY_DORMANT_DIR
    ? path.resolve(process.env.ORGAN_ATROPHY_DORMANT_DIR)
    : path.join(ROOT, 'state', 'autonomy', 'organs', 'dormant');
  return {
    policy_path: process.env.ORGAN_ATROPHY_POLICY_PATH
      ? path.resolve(process.env.ORGAN_ATROPHY_POLICY_PATH)
      : policyPath,
    state_dir: stateDir,
    runs_dir: path.join(stateDir, 'runs'),
    candidates_dir: path.join(stateDir, 'candidates'),
    latest_path: path.join(stateDir, 'latest.json'),
    history_path: path.join(stateDir, 'history.jsonl'),
    events_path: path.join(stateDir, 'events.jsonl'),
    revive_history_path: path.join(stateDir, 'revive_history.jsonl'),
    revive_queue_path: path.join(stateDir, 'revive_queue.jsonl'),
    dormant_dir: dormantDir,
    systems_root: process.env.ORGAN_ATROPHY_SYSTEMS_ROOT
      ? path.resolve(process.env.ORGAN_ATROPHY_SYSTEMS_ROOT)
      : path.join(ROOT, 'systems'),
    spine_runs_dir: process.env.ORGAN_ATROPHY_SPINE_RUNS_DIR
      ? path.resolve(process.env.ORGAN_ATROPHY_SPINE_RUNS_DIR)
      : path.join(ROOT, 'state', 'spine', 'runs'),
    autotest_registry_path: process.env.ORGAN_ATROPHY_AUTOTEST_REGISTRY_PATH
      ? path.resolve(process.env.ORGAN_ATROPHY_AUTOTEST_REGISTRY_PATH)
      : path.join(ROOT, 'state', 'ops', 'autotest', 'registry.json')
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_mode: true,
    window_days: 30,
    max_candidates: 8,
    min_observations: 1,
    usefulness_threshold: 0.32,
    min_inactive_days: 14,
    max_touch_count_for_candidate: 4,
    scoring: {
      activity_weight: 0.55,
      health_weight: 0.30,
      test_weight: 0.15,
      touch_norm: 24
    },
    exclusions: {
      organ_ids: [
        'spine',
        'security',
        'identity',
        'contracts'
      ],
      path_prefixes: [
        'systems/spine/',
        'systems/security/',
        'systems/identity/',
        'systems/contracts/'
      ]
    },
    endpoint: {
      enabled: true,
      max_files_sample: 120,
      max_manifest_chars: 180000
    },
    revive: {
      enabled: true,
      allow_manual: true,
      require_existing_endpoint: true,
      shadow_only: true
    },
    telemetry: {
      max_reasons: 8
    }
  };
}

function normalizeTokenList(v: unknown, maxLen = 120) {
  return (Array.isArray(v) ? v : [])
    .map((row) => normalizeToken(row, maxLen))
    .filter(Boolean);
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const scoring = raw.scoring && typeof raw.scoring === 'object' ? raw.scoring : {};
  const exclusions = raw.exclusions && typeof raw.exclusions === 'object' ? raw.exclusions : {};
  const endpoint = raw.endpoint && typeof raw.endpoint === 'object' ? raw.endpoint : {};
  const revive = raw.revive && typeof raw.revive === 'object' ? raw.revive : {};
  const telemetry = raw.telemetry && typeof raw.telemetry === 'object' ? raw.telemetry : {};

  const activityWeight = clampNumber(scoring.activity_weight, 0, 1, base.scoring.activity_weight);
  const healthWeight = clampNumber(scoring.health_weight, 0, 1, base.scoring.health_weight);
  const testWeight = clampNumber(scoring.test_weight, 0, 1, base.scoring.test_weight);
  const sum = activityWeight + healthWeight + testWeight || 1;

  return {
    version: cleanText(raw.version || base.version, 24) || '1.0',
    enabled: toBool(raw.enabled, base.enabled),
    shadow_mode: toBool(raw.shadow_mode, base.shadow_mode),
    window_days: clampInt(raw.window_days, 1, 365, base.window_days),
    max_candidates: clampInt(raw.max_candidates, 1, 128, base.max_candidates),
    min_observations: clampInt(raw.min_observations, 0, 5000000, base.min_observations),
    usefulness_threshold: clamp01(raw.usefulness_threshold, base.usefulness_threshold),
    min_inactive_days: clampInt(raw.min_inactive_days, 0, 3650, base.min_inactive_days),
    max_touch_count_for_candidate: clampInt(
      raw.max_touch_count_for_candidate,
      0,
      500000,
      base.max_touch_count_for_candidate
    ),
    scoring: {
      activity_weight: activityWeight / sum,
      health_weight: healthWeight / sum,
      test_weight: testWeight / sum,
      touch_norm: clampInt(scoring.touch_norm, 1, 10000, base.scoring.touch_norm)
    },
    exclusions: {
      organ_ids: normalizeTokenList(exclusions.organ_ids, 120),
      path_prefixes: normalizeTokenList(exclusions.path_prefixes, 240)
    },
    endpoint: {
      enabled: toBool(endpoint.enabled, base.endpoint.enabled),
      max_files_sample: clampInt(endpoint.max_files_sample, 1, 5000, base.endpoint.max_files_sample),
      max_manifest_chars: clampInt(endpoint.max_manifest_chars, 2048, 5000000, base.endpoint.max_manifest_chars)
    },
    revive: {
      enabled: toBool(revive.enabled, base.revive.enabled),
      allow_manual: toBool(revive.allow_manual, base.revive.allow_manual),
      require_existing_endpoint: toBool(revive.require_existing_endpoint, base.revive.require_existing_endpoint),
      shadow_only: toBool(revive.shadow_only, base.revive.shadow_only)
    },
    telemetry: {
      max_reasons: clampInt(telemetry.max_reasons, 1, 64, base.telemetry.max_reasons)
    }
  };
}

function listFilesRecursive(dirPath: string) {
  const out: string[] = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = String(stack.pop() || '');
    if (!current || !fs.existsSync(current)) continue;
    let entries: any[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = String(entry && entry.name || '');
      if (!name || name.startsWith('.')) continue;
      const full = path.join(current, name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

function discoverOrgans(systemsRoot: string) {
  if (!fs.existsSync(systemsRoot)) return [];
  let entries: any[] = [];
  try {
    entries = fs.readdirSync(systemsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry && entry.isDirectory && entry.isDirectory())
    .map((entry) => normalizeToken(entry.name, 120))
    .filter(Boolean)
    .sort();
}

function inferOrganFromFilePath(filePath: string) {
  const rel = normalizeToken(relPath(filePath), 260);
  if (!rel.startsWith('systems/')) return null;
  const parts = rel.split('/');
  if (parts.length < 2) return null;
  return normalizeToken(parts[1], 120) || null;
}

function inferOrganFromEventType(typeRaw: unknown) {
  const type = normalizeToken(typeRaw, 160);
  if (!type.startsWith('spine_')) return null;
  const body = type.slice('spine_'.length);
  if (!body) return null;
  if (body.includes('security') || body.includes('integrity') || body.includes('guard')) return 'security';
  if (body.includes('identity')) return 'identity';
  if (body.startsWith('fractal_')) return 'fractal';
  if (body.startsWith('workflow_') || body.includes('orchestron')) return 'workflow';
  if (body.includes('continuum')) return 'continuum';
  if (body.includes('autotest') || body.includes('backup') || body.includes('package')) return 'ops';
  if (body.includes('routing') || body.includes('router')) return 'routing';
  if (body.includes('budget')) return 'budget';
  if (body.includes('nursery') || body.includes('red_team')) return 'nursery';
  if (body.includes('memory')) return 'memory';
  if (body.includes('sensory') || body.includes('collector') || body.includes('eye')) return 'sensory';
  if (body.includes('actuation') || body.includes('claw')) return 'actuation';
  if (body.includes('strategy')) return 'strategy';
  if (body.includes('autonomy') || body.includes('alignment') || body.includes('trit') || body.includes('suggestion')) return 'autonomy';
  return null;
}

function ensureOrganSignals(map: AnyObj, organId: string) {
  if (!map[organId] || typeof map[organId] !== 'object') {
    map[organId] = {
      touches: 0,
      event_pass: 0,
      event_fail: 0,
      last_touch_ts: null,
      last_event_ts: null
    };
  }
  return map[organId];
}

function collectSpineSignals(spineRunsDir: string, dates: string[]) {
  const signals: AnyObj = {};
  const touchedFiles = new Set<string>();
  for (const dateStr of dates) {
    const filePath = path.join(spineRunsDir, `${dateStr}.jsonl`);
    for (const row of readJsonl(filePath)) {
      const ts = cleanText(row.ts || '', 64) || null;
      const files = Array.isArray(row.files_touched) ? row.files_touched : [];
      for (const fileRow of files) {
        const raw = cleanText(fileRow || '', 260);
        if (!raw) continue;
        touchedFiles.add(raw);
        const organ = inferOrganFromFilePath(path.resolve(ROOT, raw));
        if (!organ) continue;
        const slot = ensureOrganSignals(signals, organ);
        slot.touches += 1;
        if (ts && (!slot.last_touch_ts || parseTsMs(ts) > parseTsMs(slot.last_touch_ts))) slot.last_touch_ts = ts;
      }
      const eventOrgan = inferOrganFromEventType(row.type);
      if (eventOrgan) {
        const slot = ensureOrganSignals(signals, eventOrgan);
        const ok = row.ok === true || row.result === 'ok';
        const failed = row.ok === false;
        if (ok) slot.event_pass += 1;
        if (failed) slot.event_fail += 1;
        if (ts && (!slot.last_event_ts || parseTsMs(ts) > parseTsMs(slot.last_event_ts))) slot.last_event_ts = ts;
      }
    }
  }
  return {
    by_organ: signals,
    touched_files_total: touchedFiles.size
  };
}

function collectAutotestSignals(registryPath: string) {
  const registry = readJson(registryPath, {});
  const modules = registry.modules && typeof registry.modules === 'object' ? registry.modules : {};
  const byOrgan: AnyObj = {};
  for (const [modulePathRaw, infoRaw] of Object.entries(modules)) {
    const modulePath = normalizeToken(modulePathRaw, 260);
    if (!modulePath.startsWith('systems/')) continue;
    const parts = modulePath.split('/');
    if (parts.length < 2) continue;
    const organId = normalizeToken(parts[1], 120);
    if (!organId) continue;
    if (!byOrgan[organId]) byOrgan[organId] = { total: 0, checked: 0, stale: 0 };
    const slot = byOrgan[organId];
    slot.total += 1;
    const info = infoRaw && typeof infoRaw === 'object' ? infoRaw as AnyObj : {};
    if (info.tested === true || info.checked === true) slot.checked += 1;
    if (info.stale === true || info.needs_retest === true || info.last_status === 'untested') slot.stale += 1;
  }
  return byOrgan;
}

function organFileStats(systemsRoot: string, organId: string, maxSample = 40) {
  const organDir = path.join(systemsRoot, organId);
  const files = listFilesRecursive(organDir)
    .filter((filePath) => {
      const ext = String(path.extname(filePath || '')).toLowerCase();
      return ext === '.ts' || ext === '.js' || ext === '.json';
    });
  let totalBytes = 0;
  for (const filePath of files) {
    try {
      totalBytes += Number(fs.statSync(filePath).size || 0);
    } catch {}
  }
  const sampleFiles = files
    .slice(0, Math.max(1, Math.floor(maxSample)))
    .map((filePath) => relPath(filePath));
  return {
    exists: fs.existsSync(organDir),
    organ_dir: relPath(organDir),
    file_count: files.length,
    total_bytes: totalBytes,
    sample_files: sampleFiles
  };
}

function daysSince(ts: unknown, nowMs: number) {
  const ms = parseTsMs(ts);
  if (!ms) return 999999;
  return Math.max(0, (nowMs - ms) / (24 * 60 * 60 * 1000));
}

function scoreUsefulness(policy: AnyObj, row: AnyObj) {
  const touches = safeNumber(row.touches, 0);
  const pass = safeNumber(row.event_pass, 0);
  const fail = safeNumber(row.event_fail, 0);
  const inactiveDays = safeNumber(row.inactive_days, 999999);

  const activityRaw = Math.log1p(Math.max(0, touches)) / Math.log1p(Math.max(2, Number(policy.scoring.touch_norm || 24)));
  const activityScore = clamp01(activityRaw, 0);
  const healthScore = (pass + fail) > 0 ? pass / (pass + fail) : 0.7;
  const testScore = clamp01(row.test_checked_rate, 0.5);

  let usefulness = (
    activityScore * Number(policy.scoring.activity_weight || 0.55)
    + healthScore * Number(policy.scoring.health_weight || 0.3)
    + testScore * Number(policy.scoring.test_weight || 0.15)
  );
  if (inactiveDays > Number(policy.min_inactive_days || 14)) {
    const decay = Math.min(0.35, (inactiveDays - Number(policy.min_inactive_days || 14)) / Math.max(30, Number(policy.window_days || 30)));
    usefulness -= decay;
  }
  return {
    activity_score: Number(activityScore.toFixed(4)),
    health_score: Number(healthScore.toFixed(4)),
    test_score: Number(testScore.toFixed(4)),
    usefulness_score: Number(clamp01(usefulness, 0).toFixed(4))
  };
}

function isExcluded(policy: AnyObj, organId: string, organPrefix: string) {
  if (normalizeTokenList(policy.exclusions && policy.exclusions.organ_ids, 120).includes(organId)) return true;
  const prefix = normalizeToken(organPrefix, 260);
  const blockedPrefixes = normalizeTokenList(policy.exclusions && policy.exclusions.path_prefixes, 260);
  for (const blocked of blockedPrefixes) {
    if (!blocked) continue;
    if (prefix.startsWith(blocked)) return true;
  }
  return false;
}

function buildDormantEndpoint(policy: AnyObj, paths: AnyObj, dateStr: string, candidate: AnyObj, persist: boolean) {
  const manifest = {
    schema_id: 'organ_dormant_manifest',
    schema_version: '1.0',
    ts: nowIso(),
    date: dateStr,
    organ_id: candidate.organ_id,
    organ_prefix: candidate.organ_prefix,
    reasons: Array.isArray(candidate.reasons) ? candidate.reasons : [],
    stats: {
      file_count: Number(candidate.file_count || 0),
      total_bytes: Number(candidate.total_bytes || 0),
      touches: Number(candidate.touches || 0),
      inactive_days: Number(candidate.inactive_days || 0),
      usefulness_score: Number(candidate.usefulness_score || 0)
    },
    sample_files: Array.isArray(candidate.sample_files)
      ? candidate.sample_files.slice(0, Math.max(1, Number(policy.endpoint.max_files_sample || 120)))
      : []
  };
  const manifestText = JSON.stringify(manifest);
  const boundedText = manifestText.slice(0, Math.max(2048, Number(policy.endpoint.max_manifest_chars || 180000)));
  const manifestSha = sha256Text(boundedText);
  const gz = zlib.gzipSync(Buffer.from(boundedText, 'utf8'));
  const endpoint = {
    schema_id: 'organ_dormant_endpoint',
    schema_version: '1.0',
    ts: nowIso(),
    date: dateStr,
    organ_id: candidate.organ_id,
    status: 'shadow_candidate',
    shadow_mode: policy.shadow_mode === true,
    codec: 'gzip-base64',
    manifest_sha256: manifestSha,
    manifest_bytes: Buffer.byteLength(boundedText, 'utf8'),
    payload_bytes: gz.length,
    payload_base64: gz.toString('base64'),
    source: {
      scan_id: candidate.scan_id,
      usefulness_score: Number(candidate.usefulness_score || 0),
      inactive_days: Number(candidate.inactive_days || 0)
    }
  };
  const endpointPath = path.join(paths.dormant_dir, `${candidate.organ_id}.json`);
  if (persist) writeJsonAtomic(endpointPath, endpoint);
  return {
    endpoint_path: relPath(endpointPath),
    manifest_sha256: manifestSha,
    payload_bytes: Number(gz.length || 0)
  };
}

function decodeDormantEndpoint(endpoint: AnyObj) {
  const payload = cleanText(endpoint && endpoint.payload_base64 || '', 5000000);
  if (!payload) return null;
  const gz = Buffer.from(payload, 'base64');
  const raw = zlib.gunzipSync(gz).toString('utf8');
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function runScan(dateStr: string, opts: AnyObj) {
  const policyPath = path.resolve(String(opts.policy_path || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  const persist = opts.persist !== false;
  const writeEndpoints = opts.write_endpoints !== false;
  const nowMs = Date.now();
  const windowDays = clampInt(opts.window_days, 1, 365, policy.window_days);
  const maxCandidates = clampInt(opts.max_candidates, 1, 128, policy.max_candidates);
  const dates = windowDates(dateStr, windowDays);
  const scanId = stableId('atrophy', `${dateStr}|${Math.random()}|${process.pid}`);

  ensureDir(paths.state_dir);
  ensureDir(paths.runs_dir);
  ensureDir(paths.candidates_dir);
  ensureDir(path.dirname(paths.latest_path));
  ensureDir(path.dirname(paths.history_path));
  ensureDir(path.dirname(paths.events_path));
  ensureDir(path.dirname(paths.revive_history_path));
  ensureDir(path.dirname(paths.revive_queue_path));
  ensureDir(paths.dormant_dir);

  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'organ_atrophy_scan',
      ts: nowIso(),
      date: dateStr,
      scan_id: scanId,
      skipped: true,
      reason: 'policy_disabled',
      shadow_mode: policy.shadow_mode === true
    };
  }

  const organs = discoverOrgans(paths.systems_root);
  const spine = collectSpineSignals(paths.spine_runs_dir, dates);
  const autotestByOrgan = collectAutotestSignals(paths.autotest_registry_path);
  const rows = [];
  const excluded = [];

  for (const organId of organs) {
    const prefix = `systems/${organId}/`;
    const excludedByPolicy = isExcluded(policy, organId, prefix);
    if (excludedByPolicy) {
      excluded.push(organId);
      continue;
    }
    const fileStats = organFileStats(paths.systems_root, organId, 40);
    if (!fileStats.exists || fileStats.file_count <= 0) continue;
    const signal = spine.by_organ && spine.by_organ[organId] && typeof spine.by_organ[organId] === 'object'
      ? spine.by_organ[organId]
      : {};
    const test = autotestByOrgan && autotestByOrgan[organId] && typeof autotestByOrgan[organId] === 'object'
      ? autotestByOrgan[organId]
      : { total: 0, checked: 0, stale: 0 };
    const lastTs = signal.last_touch_ts || signal.last_event_ts || null;
    const inactiveDays = Number(daysSince(lastTs, nowMs).toFixed(2));
    const testCheckedRate = test.total > 0 ? Number((test.checked / test.total).toFixed(4)) : 0.5;
    const baseRow = {
      scan_id: scanId,
      date: dateStr,
      organ_id: organId,
      organ_prefix: prefix,
      touches: Number(signal.touches || 0),
      event_pass: Number(signal.event_pass || 0),
      event_fail: Number(signal.event_fail || 0),
      inactive_days: inactiveDays,
      last_seen_ts: lastTs,
      test_total: Number(test.total || 0),
      test_checked: Number(test.checked || 0),
      test_stale: Number(test.stale || 0),
      test_checked_rate: testCheckedRate,
      observation_count: Number(signal.touches || 0) + Number(signal.event_pass || 0) + Number(signal.event_fail || 0) + Number(test.total || 0),
      file_count: Number(fileStats.file_count || 0),
      total_bytes: Number(fileStats.total_bytes || 0),
      sample_files: fileStats.sample_files
    };
    rows.push({
      ...baseRow,
      ...scoreUsefulness(policy, baseRow)
    });
  }

  const candidates = [];
  for (const row of rows) {
    const reasons = [];
    if (safeNumber(row.observation_count, 0) < Number(policy.min_observations || 0)) continue;
    if (safeNumber(row.inactive_days, 0) >= Number(policy.min_inactive_days || 14)) reasons.push('inactive_window_met');
    if (safeNumber(row.touches, 0) <= Number(policy.max_touch_count_for_candidate || 4)) reasons.push('low_recent_touch');
    if (safeNumber(row.usefulness_score, 1) <= Number(policy.usefulness_threshold || 0.32)) reasons.push('usefulness_below_threshold');
    if (reasons.length < 3) continue;
    candidates.push({
      ...row,
      reasons
    });
  }
  candidates.sort((a, b) => {
    const scoreDiff = safeNumber(a.usefulness_score, 1) - safeNumber(b.usefulness_score, 1);
    if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
    return safeNumber(b.inactive_days, 0) - safeNumber(a.inactive_days, 0);
  });
  const selected = candidates.slice(0, maxCandidates);

  let endpointsWritten = 0;
  const endpointPaths = [];
  for (const candidate of selected) {
    if (!(policy.endpoint && policy.endpoint.enabled === true) || writeEndpoints !== true) continue;
    const endpoint = buildDormantEndpoint(policy, paths, dateStr, candidate, persist);
    endpointsWritten += 1;
    endpointPaths.push(endpoint.endpoint_path);
    candidate.endpoint_path = endpoint.endpoint_path;
    candidate.endpoint_manifest_sha256 = endpoint.manifest_sha256;
    candidate.endpoint_payload_bytes = endpoint.payload_bytes;
  }

  const out = {
    ok: true,
    type: 'organ_atrophy_scan',
    ts: nowIso(),
    date: dateStr,
    scan_id: scanId,
    policy: {
      path: relPath(policyPath),
      version: policy.version
    },
    shadow_mode: policy.shadow_mode === true,
    window_days: windowDays,
    total_organs: organs.length,
    scanned_organs: rows.length,
    excluded_organs: excluded.length,
    excluded_list: excluded.slice(0, 40),
    touched_files_total: Number(spine.touched_files_total || 0),
    candidates_count: selected.length,
    max_candidates: maxCandidates,
    endpoints_written: endpointsWritten,
    endpoint_paths: endpointPaths.slice(0, 40),
    candidates: selected.map((row) => ({
      organ_id: row.organ_id,
      usefulness_score: Number(row.usefulness_score || 0),
      activity_score: Number(row.activity_score || 0),
      health_score: Number(row.health_score || 0),
      test_score: Number(row.test_score || 0),
      inactive_days: Number(row.inactive_days || 0),
      touches: Number(row.touches || 0),
      event_fail: Number(row.event_fail || 0),
      file_count: Number(row.file_count || 0),
      total_bytes: Number(row.total_bytes || 0),
      reasons: Array.isArray(row.reasons) ? row.reasons.slice(0, policy.telemetry.max_reasons) : [],
      endpoint_path: row.endpoint_path || null
    }))
  };

  if (persist) {
    const runPath = path.join(paths.runs_dir, `${dateStr}.json`);
    const candidatePath = path.join(paths.candidates_dir, `${dateStr}.json`);
    writeJsonAtomic(runPath, out);
    writeJsonAtomic(candidatePath, {
      schema_id: 'organ_atrophy_candidates',
      schema_version: '1.0',
      ts: out.ts,
      date: out.date,
      scan_id: out.scan_id,
      candidates: selected
    });
    writeJsonAtomic(paths.latest_path, out);
    appendJsonl(paths.history_path, {
      ts: out.ts,
      type: out.type,
      date: out.date,
      scan_id: out.scan_id,
      total_organs: out.total_organs,
      scanned_organs: out.scanned_organs,
      candidates_count: out.candidates_count,
      endpoints_written: out.endpoints_written
    });
    appendJsonl(paths.events_path, {
      ts: out.ts,
      type: 'organ_atrophy_event',
      date: out.date,
      scan_id: out.scan_id,
      stage: 'scan',
      shadow_mode: out.shadow_mode,
      candidates_count: out.candidates_count,
      endpoints_written: out.endpoints_written
    });
    out.run_path = relPath(runPath);
    out.candidate_path = relPath(candidatePath);
    out.latest_path = relPath(paths.latest_path);
  }

  return out;
}

function runStatus(dateArg: string, opts: AnyObj) {
  const policyPath = path.resolve(String(opts.policy_path || DEFAULT_POLICY_PATH));
  const paths = runtimePaths(policyPath);
  const key = normalizeToken(dateArg || 'latest', 40) || 'latest';
  const payload = key === 'latest'
    ? readJson(paths.latest_path, null)
    : readJson(path.join(paths.runs_dir, `${toDate(key)}.json`), null);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      type: 'organ_atrophy_status',
      error: 'atrophy_snapshot_not_found',
      date: key === 'latest' ? 'latest' : toDate(key)
    };
  }
  return {
    ok: true,
    type: 'organ_atrophy_status',
    ts: payload.ts || null,
    date: payload.date || null,
    scan_id: payload.scan_id || null,
    shadow_mode: payload.shadow_mode === true,
    scanned_organs: Number(payload.scanned_organs || 0),
    candidates_count: Number(payload.candidates_count || 0),
    endpoints_written: Number(payload.endpoints_written || 0),
    run_path: payload.run_path || relPath(path.join(paths.runs_dir, `${payload.date || toDate(nowIso())}.json`)),
    latest_path: relPath(paths.latest_path)
  };
}

function runRevive(opts: AnyObj) {
  const policyPath = path.resolve(String(opts.policy_path || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  const organId = normalizeToken(opts.organ_id || '', 120);
  const persist = opts.persist !== false;
  const reason = cleanText(opts.reason || 'manual_revive', 180) || 'manual_revive';

  if (!organId) {
    return {
      ok: false,
      type: 'organ_atrophy_revive',
      error: 'organ_id_required'
    };
  }
  if (!(policy.revive && policy.revive.enabled === true && policy.revive.allow_manual === true)) {
    return {
      ok: false,
      type: 'organ_atrophy_revive',
      error: 'manual_revive_disabled',
      organ_id: organId
    };
  }

  const endpointPath = path.join(paths.dormant_dir, `${organId}.json`);
  const endpointExists = fs.existsSync(endpointPath);
  if (policy.revive.require_existing_endpoint === true && !endpointExists) {
    return {
      ok: false,
      type: 'organ_atrophy_revive',
      error: 'dormant_endpoint_not_found',
      organ_id: organId,
      endpoint_path: relPath(endpointPath)
    };
  }

  const endpoint = endpointExists ? readJson(endpointPath, null) : null;
  const manifest = endpoint ? decodeDormantEndpoint(endpoint) : null;
  const reviveId = stableId('revive', `${organId}|${Date.now()}|${Math.random()}`);
  const row = {
    ts: nowIso(),
    type: 'organ_atrophy_revive',
    revive_id: reviveId,
    organ_id: organId,
    reason,
    shadow_only: policy.shadow_mode === true || policy.revive.shadow_only === true,
    endpoint_found: endpointExists,
    endpoint_path: relPath(endpointPath),
    manifest_sha256: endpoint && endpoint.manifest_sha256 ? String(endpoint.manifest_sha256) : null,
    manifest_available: !!manifest
  };

  if (persist) {
    appendJsonl(paths.revive_history_path, row);
    appendJsonl(paths.revive_queue_path, {
      ...row,
      status: 'queued',
      source: 'manual_endpoint'
    });
    appendJsonl(paths.events_path, {
      ts: row.ts,
      type: 'organ_atrophy_event',
      stage: 'revive',
      revive_id: reviveId,
      organ_id: organId,
      shadow_only: row.shadow_only === true,
      endpoint_found: row.endpoint_found === true
    });
  }

  return {
    ok: true,
    type: 'organ_atrophy_revive',
    revive_id: reviveId,
    organ_id: organId,
    reason,
    shadow_only: row.shadow_only === true,
    endpoint_found: endpointExists,
    endpoint_path: row.endpoint_path,
    manifest_available: !!manifest,
    revive_history_path: relPath(paths.revive_history_path),
    revive_queue_path: relPath(paths.revive_queue_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(cmd ? 0 : 1);
    return;
  }

  if (cmd === 'scan') {
    const out = runScan(toDate(args._[1]), {
      policy_path: args.policy,
      window_days: args['window-days'],
      max_candidates: args['max-candidates'],
      persist: toBool(args.persist, true),
      write_endpoints: toBool(args['write-endpoints'], true)
    });
    console.log(JSON.stringify(out));
    process.exit(out.ok === true ? 0 : 1);
    return;
  }

  if (cmd === 'status') {
    const out = runStatus(args._[1] || 'latest', {
      policy_path: args.policy
    });
    console.log(JSON.stringify(out));
    process.exit(out.ok === true ? 0 : 1);
    return;
  }

  if (cmd === 'revive') {
    const out = runRevive({
      policy_path: args.policy,
      organ_id: args['organ-id'] || args.organ_id,
      reason: args.reason,
      persist: toBool(args.persist, true)
    });
    console.log(JSON.stringify(out));
    process.exit(out.ok === true ? 0 : 1);
    return;
  }

  usage();
  process.exit(1);
}

main();
