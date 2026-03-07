#!/usr/bin/env node
'use strict';
export {};

/**
 * dream_warden_guard.js
 *
 * Conservative Dream Warden:
 * - Passive observer + patch recommender only.
 * - Shadow-first by default.
 * - Never mutates runtime state outside deterministic receipts/proposals.
 *
 * Usage:
 *   node systems/security/dream_warden_guard.js run [YYYY-MM-DD] [--apply=1|0] [--policy=/abs/path.json]
 *   node systems/security/dream_warden_guard.js status [latest|YYYY-MM-DD] [--policy=/abs/path.json]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.DREAM_WARDEN_POLICY_PATH
  ? path.resolve(process.env.DREAM_WARDEN_POLICY_PATH)
  : path.join(ROOT, 'config', 'dream_warden_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function toDate(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
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

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/dream_warden_guard.js run [YYYY-MM-DD] [--apply=1|0] [--policy=/abs/path.json]');
  console.log('  node systems/security/dream_warden_guard.js status [latest|YYYY-MM-DD] [--policy=/abs/path.json]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = {}) {
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
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || fallbackRel, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    passive_only: true,
    activation: {
      min_successful_self_improvement_cycles: 5,
      min_symbiosis_score: 0.82,
      min_hours_between_runs: 1
    },
    thresholds: {
      critical_fail_cases_trigger: 1,
      red_team_fail_rate_trigger: 0.15,
      mirror_hold_rate_trigger: 0.4,
      low_symbiosis_score_trigger: 0.75,
      max_patch_candidates: 6
    },
    signals: {
      collective_shadow_latest_path: 'state/autonomy/collective_shadow/latest.json',
      observer_mirror_latest_path: 'state/autonomy/observer_mirror/latest.json',
      red_team_latest_path: 'state/security/red_team/latest.json',
      symbiosis_latest_path: 'state/symbiosis/coherence/latest.json',
      gated_self_improvement_state_path: 'state/autonomy/gated_self_improvement/state.json'
    },
    outputs: {
      latest_path: 'state/security/dream_warden/latest.json',
      history_path: 'state/security/dream_warden/history.jsonl',
      receipts_path: 'state/security/dream_warden/receipts.jsonl',
      patch_proposals_path: 'state/security/dream_warden/patch_proposals.jsonl',
      ide_events_path: 'state/security/dream_warden/ide_events.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const activation = raw.activation && typeof raw.activation === 'object' ? raw.activation : {};
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const signals = raw.signals && typeof raw.signals === 'object' ? raw.signals : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    passive_only: toBool(raw.passive_only, base.passive_only),
    activation: {
      min_successful_self_improvement_cycles: clampInt(
        activation.min_successful_self_improvement_cycles,
        0,
        10000,
        base.activation.min_successful_self_improvement_cycles
      ),
      min_symbiosis_score: clampNumber(
        activation.min_symbiosis_score,
        0,
        1,
        base.activation.min_symbiosis_score
      ),
      min_hours_between_runs: clampInt(
        activation.min_hours_between_runs,
        0,
        720,
        base.activation.min_hours_between_runs
      )
    },
    thresholds: {
      critical_fail_cases_trigger: clampInt(
        thresholds.critical_fail_cases_trigger,
        0,
        100000,
        base.thresholds.critical_fail_cases_trigger
      ),
      red_team_fail_rate_trigger: clampNumber(
        thresholds.red_team_fail_rate_trigger,
        0,
        1,
        base.thresholds.red_team_fail_rate_trigger
      ),
      mirror_hold_rate_trigger: clampNumber(
        thresholds.mirror_hold_rate_trigger,
        0,
        1,
        base.thresholds.mirror_hold_rate_trigger
      ),
      low_symbiosis_score_trigger: clampNumber(
        thresholds.low_symbiosis_score_trigger,
        0,
        1,
        base.thresholds.low_symbiosis_score_trigger
      ),
      max_patch_candidates: clampInt(
        thresholds.max_patch_candidates,
        1,
        64,
        base.thresholds.max_patch_candidates
      )
    },
    signals: {
      collective_shadow_latest_path: resolvePath(
        signals.collective_shadow_latest_path || base.signals.collective_shadow_latest_path,
        base.signals.collective_shadow_latest_path
      ),
      observer_mirror_latest_path: resolvePath(
        signals.observer_mirror_latest_path || base.signals.observer_mirror_latest_path,
        base.signals.observer_mirror_latest_path
      ),
      red_team_latest_path: resolvePath(
        signals.red_team_latest_path || base.signals.red_team_latest_path,
        base.signals.red_team_latest_path
      ),
      symbiosis_latest_path: resolvePath(
        signals.symbiosis_latest_path || base.signals.symbiosis_latest_path,
        base.signals.symbiosis_latest_path
      ),
      gated_self_improvement_state_path: resolvePath(
        signals.gated_self_improvement_state_path || base.signals.gated_self_improvement_state_path,
        base.signals.gated_self_improvement_state_path
      )
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path || base.outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path || base.outputs.history_path, base.outputs.history_path),
      receipts_path: resolvePath(outputs.receipts_path || base.outputs.receipts_path, base.outputs.receipts_path),
      patch_proposals_path: resolvePath(
        outputs.patch_proposals_path || base.outputs.patch_proposals_path,
        base.outputs.patch_proposals_path
      ),
      ide_events_path: resolvePath(outputs.ide_events_path || base.outputs.ide_events_path, base.outputs.ide_events_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function countSuccessfulCycles(gatedState: AnyObj) {
  const proposals = gatedState && gatedState.proposals && typeof gatedState.proposals === 'object'
    ? Object.values(gatedState.proposals)
    : [];
  let count = 0;
  for (const row of proposals) {
    const status = normalizeToken(row && (row as AnyObj).status || '', 40);
    if (['gated_pass', 'live_ready', 'live_merged'].includes(status)) count += 1;
  }
  return count;
}

function lastRunInfo(historyPath: string) {
  const rows = readJsonl(historyPath);
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    row: last && typeof last === 'object' ? last : null,
    hours_since: last && last.ts
      ? Math.max(0, (Date.now() - Date.parse(String(last.ts))) / (1000 * 60 * 60))
      : null
  };
}

function buildPatchProposals(policy: AnyObj, signals: AnyObj, runId: string) {
  const out: AnyObj[] = [];
  const redTeam = signals.collective_shadow && signals.collective_shadow.red_team
    ? signals.collective_shadow.red_team
    : {};
  const mirror = signals.observer_mirror && signals.observer_mirror.summary
    ? signals.observer_mirror.summary
    : {};
  const mirrorObserver = signals.observer_mirror && signals.observer_mirror.observer
    ? signals.observer_mirror.observer
    : {};
  const symbiosis = signals.symbiosis && typeof signals.symbiosis === 'object'
    ? signals.symbiosis
    : {};

  const criticalFails = Math.max(0, Number(redTeam.critical_fail_cases || 0) || 0);
  const redFailRate = clampNumber(redTeam.fail_rate, 0, 1, 0);
  const mirrorHoldRate = clampNumber(mirror && mirror.rates && mirror.rates.hold_rate, 0, 1, 0);
  const mirrorMood = normalizeToken(mirrorObserver.mood || '', 40) || 'unknown';
  const symbiosisScore = clampNumber(symbiosis.coherence_score, 0, 1, 0);

  if (criticalFails >= Number(policy.thresholds.critical_fail_cases_trigger || 1)) {
    out.push({
      type: 'dream_warden_patch_proposal',
      proposal_id: `dwp_${Date.now().toString(36)}_${out.length + 1}`,
      run_id: runId,
      severity: 'high',
      target_lane: 'red_team_harness',
      reason_codes: ['critical_fail_cases_triggered'],
      evidence: {
        critical_fail_cases: criticalFails,
        fail_rate: redFailRate
      },
      suggested_patch: {
        action: 'tighten_redteam_case_admission',
        path_hint: 'config/red_team_policy.json',
        change_hint: 'increase critical-case quarantine strictness and enforce post-failure regression cases'
      }
    });
  }

  if (redFailRate >= Number(policy.thresholds.red_team_fail_rate_trigger || 0.15)) {
    out.push({
      type: 'dream_warden_patch_proposal',
      proposal_id: `dwp_${Date.now().toString(36)}_${out.length + 1}`,
      run_id: runId,
      severity: 'medium',
      target_lane: 'execution_sandbox_envelope',
      reason_codes: ['red_team_fail_rate_triggered'],
      evidence: {
        fail_rate: redFailRate,
        threshold: Number(policy.thresholds.red_team_fail_rate_trigger || 0.15)
      },
      suggested_patch: {
        action: 'raise_sandbox_assertion_coverage',
        path_hint: 'config/execution_sandbox_envelope_policy.json',
        change_hint: 'expand denial heuristics and require additional allowlist annotations'
      }
    });
  }

  if (mirrorMood === 'strained' || mirrorHoldRate >= Number(policy.thresholds.mirror_hold_rate_trigger || 0.4)) {
    out.push({
      type: 'dream_warden_patch_proposal',
      proposal_id: `dwp_${Date.now().toString(36)}_${out.length + 1}`,
      run_id: runId,
      severity: 'medium',
      target_lane: 'weaver_guardrails',
      reason_codes: ['observer_pressure_triggered'],
      evidence: {
        mood: mirrorMood,
        hold_rate: mirrorHoldRate
      },
      suggested_patch: {
        action: 'tighten_medium_risk_admission',
        path_hint: 'config/weaver_policy.json',
        change_hint: 'reduce exploration share while observer mood remains strained'
      }
    });
  }

  if (symbiosisScore < Number(policy.thresholds.low_symbiosis_score_trigger || 0.75)) {
    out.push({
      type: 'dream_warden_patch_proposal',
      proposal_id: `dwp_${Date.now().toString(36)}_${out.length + 1}`,
      run_id: runId,
      severity: 'high',
      target_lane: 'recursion_guard',
      reason_codes: ['symbiosis_low_score_triggered'],
      evidence: {
        coherence_score: symbiosisScore,
        coherence_tier: cleanText(symbiosis.coherence_tier || 'unknown', 24)
      },
      suggested_patch: {
        action: 'hold_recursive_depth_growth',
        path_hint: 'config/symbiosis_coherence_policy.json',
        change_hint: 'keep recursion depth bounded and prioritize coherence signal repair'
      }
    });
  }

  return out.slice(0, Number(policy.thresholds.max_patch_candidates || 6));
}

function evaluateRun(dateStr: string, policy: AnyObj, applyRequested: boolean) {
  const startedAt = Date.now();
  const gatedState = readJson(policy.signals.gated_self_improvement_state_path, {});
  const collectiveShadow = readJson(policy.signals.collective_shadow_latest_path, {});
  const observerMirror = readJson(policy.signals.observer_mirror_latest_path, {});
  const redTeamLatest = readJson(policy.signals.red_team_latest_path, {});
  const symbiosis = readJson(policy.signals.symbiosis_latest_path, {});
  const successfulCycles = countSuccessfulCycles(gatedState);
  const symbiosisScore = clampNumber(symbiosis && symbiosis.coherence_score, 0, 1, 0);
  const lastRun = lastRunInfo(policy.outputs.history_path);
  const runThrottleHours = Number(policy.activation.min_hours_between_runs || 0);
  const throttled = lastRun.hours_since != null && lastRun.hours_since < runThrottleHours;
  const activationReady = (
    successfulCycles >= Number(policy.activation.min_successful_self_improvement_cycles || 0)
    && symbiosisScore >= Number(policy.activation.min_symbiosis_score || 0)
  );
  const runId = `dwd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  if (applyRequested && policy.passive_only === true) {
    return {
      ok: false,
      type: 'dream_warden_run',
      ts: nowIso(),
      date: dateStr,
      run_id: runId,
      error: 'passive_mode_violation_apply_requested',
      stasis_recommendation: true,
      shadow_only: policy.shadow_only === true,
      passive_only: true
    };
  }

  if (throttled) {
    return {
      ok: true,
      skipped: true,
      type: 'dream_warden_run',
      ts: nowIso(),
      date: dateStr,
      run_id: runId,
      reason: 'min_interval_not_elapsed',
      min_hours_between_runs: runThrottleHours,
      hours_since_last_run: Number((lastRun.hours_since || 0).toFixed(6)),
      activation_ready: activationReady,
      shadow_only: policy.shadow_only === true,
      passive_only: policy.passive_only === true
    };
  }

  const patchProposals = activationReady
    ? buildPatchProposals(policy, {
      collective_shadow: collectiveShadow,
      observer_mirror: observerMirror,
      red_team_latest: redTeamLatest,
      symbiosis
    }, runId)
    : [];
  const out = {
    ok: true,
    type: 'dream_warden_run',
    ts: nowIso(),
    date: dateStr,
    run_id: runId,
    mode: activationReady ? 'active_shadow_observer' : 'dormant_seed',
    activation_ready: activationReady,
    shadow_only: policy.shadow_only === true,
    passive_only: policy.passive_only === true,
    apply_requested: applyRequested,
    apply_executed: false,
    patch_proposals_count: patchProposals.length,
    patch_proposals: patchProposals,
    activation_signals: {
      successful_self_improvement_cycles: successfulCycles,
      min_successful_self_improvement_cycles: Number(policy.activation.min_successful_self_improvement_cycles || 0),
      symbiosis_score: symbiosisScore,
      min_symbiosis_score: Number(policy.activation.min_symbiosis_score || 0)
    },
    source_paths: {
      collective_shadow_latest_path: relPath(policy.signals.collective_shadow_latest_path),
      observer_mirror_latest_path: relPath(policy.signals.observer_mirror_latest_path),
      red_team_latest_path: relPath(policy.signals.red_team_latest_path),
      symbiosis_latest_path: relPath(policy.signals.symbiosis_latest_path),
      gated_self_improvement_state_path: relPath(policy.signals.gated_self_improvement_state_path)
    },
    duration_ms: Date.now() - startedAt
  };
  return out;
}

function persistRun(policy: AnyObj, payload: AnyObj) {
  writeJsonAtomic(policy.outputs.latest_path, payload);
  appendJsonl(policy.outputs.history_path, payload);
  appendJsonl(policy.outputs.receipts_path, payload);
  appendJsonl(policy.outputs.ide_events_path, {
    ts: payload.ts || nowIso(),
    type: 'dream_warden_ide_event',
    run_id: payload.run_id || null,
    mode: payload.mode || null,
    activation_ready: payload.activation_ready === true,
    patch_proposals_count: Number(payload.patch_proposals_count || 0),
    shadow_only: payload.shadow_only === true,
    passive_only: payload.passive_only === true
  });
  if (Array.isArray(payload.patch_proposals) && payload.patch_proposals.length) {
    for (const row of payload.patch_proposals) {
      appendJsonl(policy.outputs.patch_proposals_path, {
        ts: payload.ts || nowIso(),
        ...row
      });
    }
  }
}

function cmdRun(args: AnyObj) {
  const date = toDate(args._[1] || args.date);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    const out = {
      ok: true,
      skipped: true,
      type: 'dream_warden_run',
      ts: nowIso(),
      date,
      reason: 'policy_disabled',
      policy: { path: relPath(policyPath), version: policy.version }
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  const out = evaluateRun(date, policy, toBool(args.apply, false));
  persistRun(policy, out);
  process.stdout.write(`${JSON.stringify({
    ...out,
    policy: {
      path: relPath(policyPath),
      version: policy.version
    },
    latest_path: relPath(policy.outputs.latest_path),
    receipts_path: relPath(policy.outputs.receipts_path),
    patch_proposals_path: relPath(policy.outputs.patch_proposals_path)
  })}\n`);
  if (out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const key = cleanText(args._[1] || args.date || 'latest', 40);
  let payload = null;
  if (key === 'latest') payload = readJson(policy.outputs.latest_path, null);
  else {
    const day = toDate(key);
    const rows = readJsonl(policy.outputs.history_path).filter((row: AnyObj) => String(row && row.date || '') === day);
    payload = rows.length ? rows[rows.length - 1] : null;
  }
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'dream_warden_status',
      error: 'snapshot_missing',
      date: key
    })}\n`);
    process.exit(1);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'dream_warden_status',
    ts: payload.ts || null,
    date: payload.date || null,
    run_id: payload.run_id || null,
    mode: payload.mode || null,
    activation_ready: payload.activation_ready === true,
    patch_proposals_count: Number(payload.patch_proposals_count || 0),
    shadow_only: payload.shadow_only === true,
    passive_only: payload.passive_only === true,
    latest_path: relPath(policy.outputs.latest_path),
    receipts_path: relPath(policy.outputs.receipts_path),
    policy: {
      path: relPath(policyPath),
      version: policy.version
    }
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
    return;
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  evaluateRun
};

