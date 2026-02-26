#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const os = require('os');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'red_team_policy.json');

const { decideMorphState } = require('./morph_manager');
const { buildSwarmTactics } = require('./swarm_tactics');
const { distillWisdom } = require('./wisdom_distiller');

function nowIso() {
  return new Date().toISOString();
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

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
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

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
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

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackAbs: string) {
  const text = cleanText(raw, 500);
  if (!text) return fallbackAbs;
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function defaultColonyPolicy() {
  return {
    enabled: true,
    shadow_only: true,
    state_root: '',
    peacetime: {
      min_intensity: 0.12,
      base_intensity: 0.28,
      max_intensity: 0.82,
      phone_seed_cap: 0.25
    },
    war_mode: {
      enabled: true,
      confidence_threshold: 0.95,
      target_activation_ms: 50,
      aggression: 'high',
      false_positive_budget_per_30d: 0
    },
    consensus: {
      require_helix_tamper: true,
      require_sentinel_agreement: true,
      require_soul_mismatch: false
    },
    assimilation_priority: {
      enabled: true,
      hours_since_graft: 72,
      max_targets: 16
    },
    loyalty_binding: {
      enabled: true,
      require_soul_token_presence: true
    },
    outputs: {
      emit_events: true,
      emit_obsidian_projection: true,
      emit_visualization: true
    },
    paths: {
      helix_latest_path: 'state/helix/latest.json',
      helix_sentinel_state_path: 'state/helix/sentinel_state.json',
      soul_token_state_path: 'state/security/soul_token_guard.json',
      soul_biometric_latest_path: 'state/security/soul_biometric/latest.json',
      assimilation_ledger_path: 'state/assimilation/ledger.json',
      weaver_latest_path: 'state/autonomy/weaver/latest.json'
    }
  };
}

function resolveColonyPolicy(fullPolicy: AnyObj = {}) {
  const base = defaultColonyPolicy();
  const src = fullPolicy && fullPolicy.ant_colony && typeof fullPolicy.ant_colony === 'object'
    ? fullPolicy.ant_colony
    : {};
  const peace = src.peacetime && typeof src.peacetime === 'object' ? src.peacetime : {};
  const war = src.war_mode && typeof src.war_mode === 'object' ? src.war_mode : {};
  const consensus = src.consensus && typeof src.consensus === 'object' ? src.consensus : {};
  const assimilation = src.assimilation_priority && typeof src.assimilation_priority === 'object'
    ? src.assimilation_priority
    : {};
  const loyalty = src.loyalty_binding && typeof src.loyalty_binding === 'object' ? src.loyalty_binding : {};
  const outputs = src.outputs && typeof src.outputs === 'object' ? src.outputs : {};
  const paths = src.paths && typeof src.paths === 'object' ? src.paths : {};
  return {
    ...base,
    enabled: src.enabled !== false,
    shadow_only: src.shadow_only !== false,
    state_root: cleanText(src.state_root || '', 300),
    peacetime: {
      min_intensity: clampNumber(peace.min_intensity, 0, 1, base.peacetime.min_intensity),
      base_intensity: clampNumber(peace.base_intensity, 0, 1, base.peacetime.base_intensity),
      max_intensity: clampNumber(peace.max_intensity, 0, 1, base.peacetime.max_intensity),
      phone_seed_cap: clampNumber(peace.phone_seed_cap, 0, 1, base.peacetime.phone_seed_cap)
    },
    war_mode: {
      enabled: war.enabled !== false,
      confidence_threshold: clampNumber(war.confidence_threshold, 0, 1, base.war_mode.confidence_threshold),
      target_activation_ms: clampInt(war.target_activation_ms, 1, 60000, base.war_mode.target_activation_ms),
      aggression: normalizeToken(war.aggression || base.war_mode.aggression, 32) || base.war_mode.aggression,
      false_positive_budget_per_30d: clampInt(
        war.false_positive_budget_per_30d,
        0,
        1000000,
        base.war_mode.false_positive_budget_per_30d
      )
    },
    consensus: {
      require_helix_tamper: consensus.require_helix_tamper !== false,
      require_sentinel_agreement: consensus.require_sentinel_agreement !== false,
      require_soul_mismatch: consensus.require_soul_mismatch === true
    },
    assimilation_priority: {
      enabled: assimilation.enabled !== false,
      hours_since_graft: clampInt(assimilation.hours_since_graft, 1, 24 * 365, base.assimilation_priority.hours_since_graft),
      max_targets: clampInt(assimilation.max_targets, 1, 256, base.assimilation_priority.max_targets)
    },
    loyalty_binding: {
      enabled: loyalty.enabled !== false,
      require_soul_token_presence: loyalty.require_soul_token_presence !== false
    },
    outputs: {
      emit_events: outputs.emit_events !== false,
      emit_obsidian_projection: outputs.emit_obsidian_projection !== false,
      emit_visualization: outputs.emit_visualization !== false
    },
    paths: {
      helix_latest_path: cleanText(paths.helix_latest_path || base.paths.helix_latest_path, 300) || base.paths.helix_latest_path,
      helix_sentinel_state_path: cleanText(paths.helix_sentinel_state_path || base.paths.helix_sentinel_state_path, 300) || base.paths.helix_sentinel_state_path,
      soul_token_state_path: cleanText(paths.soul_token_state_path || base.paths.soul_token_state_path, 300) || base.paths.soul_token_state_path,
      soul_biometric_latest_path: cleanText(
        paths.soul_biometric_latest_path || base.paths.soul_biometric_latest_path,
        300
      ) || base.paths.soul_biometric_latest_path,
      assimilation_ledger_path: cleanText(paths.assimilation_ledger_path || base.paths.assimilation_ledger_path, 300) || base.paths.assimilation_ledger_path,
      weaver_latest_path: cleanText(paths.weaver_latest_path || base.paths.weaver_latest_path, 300) || base.paths.weaver_latest_path
    }
  };
}

function resolveStateRoot(colonyPolicy: AnyObj, parentStateRoot: string) {
  const explicit = cleanText(colonyPolicy && colonyPolicy.state_root || '', 300);
  if (explicit) return resolvePath(explicit, path.join(ROOT, 'state', 'security', 'red_team', 'ant_colony'));
  if (parentStateRoot && path.isAbsolute(parentStateRoot)) return path.join(parentStateRoot, 'ant_colony');
  if (parentStateRoot) return path.join(resolvePath(parentStateRoot, path.join(ROOT, 'state', 'security', 'red_team')), 'ant_colony');
  return path.join(ROOT, 'state', 'security', 'red_team', 'ant_colony');
}

function colonyPaths(colonyRoot: string) {
  return {
    root: colonyRoot,
    runtime_state_path: path.join(colonyRoot, 'runtime_state.json'),
    events_path: path.join(colonyRoot, 'events.jsonl'),
    history_path: path.join(colonyRoot, 'history.jsonl'),
    battle_reports_path: path.join(colonyRoot, 'battle_reports.jsonl'),
    wisdom_nodes_path: path.join(colonyRoot, 'wisdom_nodes.jsonl'),
    obsidian_projection_path: path.join(colonyRoot, 'obsidian_projection.jsonl'),
    latest_path: path.join(colonyRoot, 'latest.json')
  };
}

function computeRedConfidence(input: AnyObj = {}) {
  if (input.red_confidence != null) {
    return clampNumber(input.red_confidence, 0, 1, 0);
  }
  const summary = input.summary && typeof input.summary === 'object' ? input.summary : {};
  const executed = clampInt(summary.executed_cases, 0, 1000000, 0);
  const failed = clampInt(summary.fail_cases, 0, 1000000, 0);
  const critical = clampInt(summary.critical_fail_cases, 0, 1000000, 0);
  const failRate = executed > 0 ? failed / executed : 0;
  const confidence = 0.2 + Math.min(0.5, critical * 0.2) + Math.min(0.3, failRate * 0.5);
  return Number(clampNumber(confidence, 0, 1, 0).toFixed(6));
}

function computeAdaptiveIntensity(colonyPolicy: AnyObj = {}, input: AnyObj = {}) {
  const peace = colonyPolicy && colonyPolicy.peacetime && typeof colonyPolicy.peacetime === 'object'
    ? colonyPolicy.peacetime
    : {};
  const min = clampNumber(peace.min_intensity, 0, 1, 0.12);
  const base = clampNumber(peace.base_intensity, 0, 1, 0.28);
  const max = clampNumber(peace.max_intensity, 0, 1, 0.82);
  const phoneCap = clampNumber(peace.phone_seed_cap, 0, 1, 0.25);

  const cpus = Math.max(1, Number(os.cpus().length || 1));
  const load1 = Number((os.loadavg && os.loadavg()[0]) || 0);
  const loadPerCpu = load1 / cpus;
  const loadPenalty = clampNumber(loadPerCpu / 1.5, 0, 1, 0);
  const maturity = clampNumber(
    input.maturity_score != null ? input.maturity_score : process.env.PROTHEUS_MATURITY_SCORE,
    0,
    1,
    0.5
  );
  let intensity = base + (maturity * 0.25) - (loadPenalty * 0.35);
  intensity = clampNumber(intensity, min, max, base);
  const isPhoneSeed = String(process.env.PROTHEUS_PROFILE || '').trim().toLowerCase() === 'phone_seed';
  if (isPhoneSeed) intensity = Math.min(intensity, phoneCap);
  return Number(clampNumber(intensity, min, max, base).toFixed(6));
}

function parseHelixSignals(colonyPolicy: AnyObj = {}) {
  const p = colonyPolicy && colonyPolicy.paths ? colonyPolicy.paths : {};
  const helixLatestPath = resolvePath(p.helix_latest_path, path.join(ROOT, 'state', 'helix', 'latest.json'));
  const sentinelStatePath = resolvePath(p.helix_sentinel_state_path, path.join(ROOT, 'state', 'helix', 'sentinel_state.json'));
  const helixLatest = readJson(helixLatestPath, null);
  const sentinelState = readJson(sentinelStatePath, null);
  const mismatchCount = Number(
    helixLatest
    && helixLatest.verifier
    && Number.isFinite(Number(helixLatest.verifier.mismatch_count))
      ? Number(helixLatest.verifier.mismatch_count)
      : 0
  );
  const attestationDecision = String(helixLatest && helixLatest.attestation_decision || '').trim().toLowerCase();
  const helixTier = String(
    (helixLatest && helixLatest.sentinel && helixLatest.sentinel.tier)
    || ''
  ).trim().toLowerCase();
  const sentinelTier = String(
    (sentinelState && sentinelState.current_tier)
    || helixTier
    || ''
  ).trim().toLowerCase();
  const helixTamper = mismatchCount > 0 || (attestationDecision && attestationDecision !== 'allow');
  const sentinelAgreement = ['stasis', 'confirmed_malice'].includes(sentinelTier)
    || ['stasis', 'confirmed_malice'].includes(helixTier);
  const codexReasons = Array.isArray(helixLatest && helixLatest.codex_verification && helixLatest.codex_verification.reason_codes)
    ? helixLatest.codex_verification.reason_codes
    : [];
  const soulMismatchFromCodex = codexReasons.some((row: unknown) => String(row || '').includes('signature_mismatch'));
  return {
    helix_tamper: helixTamper,
    sentinel_agreement: sentinelAgreement,
    soul_mismatch_from_codex: soulMismatchFromCodex,
    helix_latest: helixLatest,
    sentinel_state: sentinelState,
    paths: {
      helix_latest_path: helixLatestPath,
      sentinel_state_path: sentinelStatePath
    }
  };
}

function parseSoulSignals(colonyPolicy: AnyObj = {}) {
  const p = colonyPolicy && colonyPolicy.paths ? colonyPolicy.paths : {};
  const soulPath = resolvePath(p.soul_token_state_path, path.join(ROOT, 'state', 'security', 'soul_token_guard.json'));
  const soulState = readJson(soulPath, null);
  const soulBiometricPath = resolvePath(
    p.soul_biometric_latest_path,
    path.join(ROOT, 'state', 'security', 'soul_biometric', 'latest.json')
  );
  const soulBiometric = readJson(soulBiometricPath, null);
  const fingerprint = cleanText(soulState && soulState.fingerprint || '', 260);
  const expectedFingerprint = cleanText(process.env.SOUL_TOKEN_GUARD_FINGERPRINT || '', 260);
  const mismatch = !!(expectedFingerprint && fingerprint && expectedFingerprint !== fingerprint);
  const biometricMismatch = !!(
    soulBiometric
    && typeof soulBiometric === 'object'
    && soulBiometric.checked === true
    && (
      soulBiometric.match !== true
      || soulBiometric.liveness_ok !== true
      || Number(soulBiometric.confidence || 0) < Number(soulBiometric.min_confidence || 0)
    )
  );
  return {
    soul_mismatch: mismatch,
    soul_biometric_mismatch: biometricMismatch,
    soul_present: !!soulState,
    biometric_present: !!soulBiometric,
    path: soulPath,
    biometric_path: soulBiometricPath
  };
}

function recentAssimilationTargets(colonyPolicy: AnyObj = {}, nowTs = nowIso()) {
  const p = colonyPolicy && colonyPolicy.paths ? colonyPolicy.paths : {};
  const ledgerPath = resolvePath(p.assimilation_ledger_path, path.join(ROOT, 'state', 'assimilation', 'ledger.json'));
  const ledger = readJson(ledgerPath, {});
  const capabilities = ledger && ledger.capabilities && typeof ledger.capabilities === 'object'
    ? ledger.capabilities
    : {};
  const cfg = colonyPolicy && colonyPolicy.assimilation_priority && typeof colonyPolicy.assimilation_priority === 'object'
    ? colonyPolicy.assimilation_priority
    : {};
  if (cfg.enabled === false) return [];
  const maxTargets = clampInt(cfg.max_targets, 1, 256, 16);
  const maxAgeMs = clampInt(cfg.hours_since_graft, 1, 24 * 365, 72) * 60 * 60 * 1000;
  const nowMs = parseIsoMs(nowTs) || Date.now();
  const rows: AnyObj[] = [];
  for (const [id, row] of Object.entries(capabilities)) {
    const item = row && typeof row === 'object' ? row : {};
    const status = String(item.status || '').trim().toLowerCase();
    const stamp = parseIsoMs(item.last_assimilation_ts) || parseIsoMs(item.last_attempt_ts);
    if (stamp == null) continue;
    if ((nowMs - stamp) > maxAgeMs) continue;
    if (!status || !['assimilated_ttl', 'shadow_candidate'].includes(status)) continue;
    rows.push({
      capability_id: String(id),
      status,
      age_hours: Number(((nowMs - stamp) / (60 * 60 * 1000)).toFixed(3))
    });
  }
  rows.sort((a, b) => Number(a.age_hours || 0) - Number(b.age_hours || 0));
  return rows.slice(0, maxTargets).map((row) => String(row.capability_id || ''));
}

function renderObsidianMarkdown(out: AnyObj = {}) {
  const mode = String(out.mode || 'peacetime');
  const summary = out.summary && typeof out.summary === 'object' ? out.summary : {};
  return [
    '# Red Team Ant Colony',
    '',
    `- Mode: \`${mode}\``,
    `- Transition: \`${String(out.transition || 'steady')}\``,
    `- Confidence: \`${Number(out.red_confidence || 0).toFixed(3)}\``,
    `- Intensity: \`${Number(out.intensity || 0).toFixed(3)}\``,
    `- Consensus: \`${out.consensus_pass === true ? 'pass' : 'not_met'}\``,
    `- Cases: executed=\`${Number(summary.executed_cases || 0)}\` fail=\`${Number(summary.fail_cases || 0)}\` critical=\`${Number(summary.critical_fail_cases || 0)}\``,
    `- Priority targets (72h): \`${Number(out.priority_targets_count || 0)}\``
  ].join('\n');
}

function runAntColony(input: AnyObj = {}, opts: AnyObj = {}) {
  const fullPolicy = input.policy && typeof input.policy === 'object' ? input.policy : readJson(
    resolvePath(input.policy_path || process.env.RED_TEAM_POLICY_PATH, DEFAULT_POLICY_PATH),
    {}
  );
  const colonyPolicy = resolveColonyPolicy(fullPolicy);
  const parentStateRoot = cleanText(input.state_root || fullPolicy.state_root || '', 320);
  const stateRoot = resolveStateRoot(colonyPolicy, parentStateRoot);
  const paths = colonyPaths(stateRoot);
  const persist = opts.persist !== false;
  const nowTs = String(input.ts || nowIso());

  if (colonyPolicy.enabled !== true) {
    return {
      ok: true,
      type: 'redteam_ant_colony',
      ts: nowTs,
      skipped: true,
      reason: 'ant_colony_disabled'
    };
  }

  const prev = readJson(paths.runtime_state_path, {});
  const helixSignals = parseHelixSignals(colonyPolicy);
  const soulSignals = parseSoulSignals(colonyPolicy);
  const redConfidence = computeRedConfidence(input);
  const signals = {
    helix_tamper: helixSignals.helix_tamper === true,
    sentinel_agreement: helixSignals.sentinel_agreement === true,
    soul_mismatch: (
      soulSignals.soul_mismatch === true
      || soulSignals.soul_biometric_mismatch === true
      || helixSignals.soul_mismatch_from_codex === true
    ),
    red_confidence: redConfidence
  };
  const intensity = computeAdaptiveIntensity(colonyPolicy, input);
  const priorityTargets = recentAssimilationTargets(colonyPolicy, nowTs);
  const morph = decideMorphState(signals, colonyPolicy, prev);
  const tactics = buildSwarmTactics({
    mode: morph.mode,
    shadow_only: colonyPolicy.shadow_only !== false,
    intensity,
    priority_targets: priorityTargets
  }, colonyPolicy);
  const summary = input.summary && typeof input.summary === 'object' ? input.summary : {};
  const wisdom = distillWisdom({
    mode: morph.mode,
    red_confidence: redConfidence,
    summary,
    results: Array.isArray(input.results) ? input.results : []
  });

  const out = {
    ok: true,
    type: 'redteam_ant_colony',
    ts: nowTs,
    mode: morph.mode,
    prior_mode: morph.prior_mode,
    transition: morph.transition,
    consensus_pass: morph.consensus_pass === true,
    reason_codes: morph.reasons,
    red_confidence: redConfidence,
    intensity,
    summary,
    shadow_only: colonyPolicy.shadow_only !== false,
    priority_targets_count: priorityTargets.length,
    priority_targets: priorityTargets,
    tactics,
    wisdom_node_id: wisdom && wisdom.node ? wisdom.node.node_id : null,
    war_mode: morph.mode === 'war',
    signals: {
      helix_tamper: signals.helix_tamper,
      sentinel_agreement: signals.sentinel_agreement,
      soul_mismatch: signals.soul_mismatch,
      soul_biometric_mismatch: soulSignals.soul_biometric_mismatch === true
    },
    paths: {
      state_root: relPath(paths.root),
      runtime_state_path: relPath(paths.runtime_state_path),
      events_path: relPath(paths.events_path)
    }
  };

  if (persist) {
    writeJsonAtomic(paths.runtime_state_path, out);
    writeJsonAtomic(paths.latest_path, out);
    appendJsonl(paths.events_path, {
      ts: nowTs,
      type: 'redteam_ant_colony_event',
      mode: out.mode,
      transition: out.transition,
      reason_codes: out.reason_codes,
      consensus_pass: out.consensus_pass,
      red_confidence: out.red_confidence,
      intensity: out.intensity
    });
    appendJsonl(paths.history_path, {
      ts: nowTs,
      type: 'redteam_ant_colony_history',
      mode: out.mode,
      transition: out.transition,
      consensus_pass: out.consensus_pass,
      summary
    });
    if (out.mode === 'war') {
      appendJsonl(paths.battle_reports_path, {
        ts: nowTs,
        type: 'redteam_ant_colony_battle_report',
        mode: out.mode,
        reason_codes: out.reason_codes,
        tactics: out.tactics && out.tactics.actions ? out.tactics.actions : []
      });
    }
    if (wisdom && wisdom.node) {
      appendJsonl(paths.wisdom_nodes_path, wisdom.node);
    }
    if (colonyPolicy.outputs.emit_obsidian_projection === true && wisdom && wisdom.markdown) {
      appendJsonl(paths.obsidian_projection_path, {
        ts: nowTs,
        type: 'redteam_ant_colony_obsidian',
        markdown: renderObsidianMarkdown(out),
        wisdom_markdown: String(wisdom.markdown || '')
      });
    }
  }
  return out;
}

function statusAntColony(input: AnyObj = {}) {
  const fullPolicy = input.policy && typeof input.policy === 'object' ? input.policy : readJson(
    resolvePath(input.policy_path || process.env.RED_TEAM_POLICY_PATH, DEFAULT_POLICY_PATH),
    {}
  );
  const colonyPolicy = resolveColonyPolicy(fullPolicy);
  const parentStateRoot = cleanText(input.state_root || fullPolicy.state_root || '', 320);
  const stateRoot = resolveStateRoot(colonyPolicy, parentStateRoot);
  const paths = colonyPaths(stateRoot);
  const latest = readJson(paths.latest_path, null);
  if (!latest || typeof latest !== 'object') {
    return {
      ok: false,
      type: 'redteam_ant_colony_status',
      error: 'ant_colony_snapshot_missing',
      state_root: relPath(paths.root)
    };
  }
  return {
    ok: true,
    type: 'redteam_ant_colony_status',
    ts: String(latest.ts || ''),
    mode: String(latest.mode || 'unknown'),
    transition: String(latest.transition || 'unknown'),
    consensus_pass: latest.consensus_pass === true,
    red_confidence: Number(latest.red_confidence || 0),
    intensity: Number(latest.intensity || 0),
    state_root: relPath(paths.root)
  };
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

function dateOrToday(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/redteam/ant_colony_controller.js run [YYYY-MM-DD] [--policy=path] [--state-root=path] [--red-confidence=0.95] [--critical-fail-cases=0] [--executed-cases=1]');
  console.log('  node systems/redteam/ant_colony_controller.js status [--policy=path] [--state-root=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    return;
  }
  if (cmd === 'run') {
    const date = dateOrToday(args._[1]);
    const out = runAntColony({
      ts: nowIso(),
      date,
      source: cleanText(args.source || 'manual_probe', 80) || 'manual_probe',
      policy_path: args.policy || process.env.RED_TEAM_POLICY_PATH || DEFAULT_POLICY_PATH,
      state_root: args['state-root'] || args.state_root,
      red_confidence: args['red-confidence'] || args.red_confidence,
      summary: {
        selected_cases: clampInt(args['selected-cases'] || args.selected_cases, 0, 1000000, 0),
        executed_cases: clampInt(args['executed-cases'] || args.executed_cases, 0, 1000000, 0),
        fail_cases: clampInt(args['fail-cases'] || args.fail_cases, 0, 1000000, 0),
        critical_fail_cases: clampInt(args['critical-fail-cases'] || args.critical_fail_cases, 0, 1000000, 0)
      },
      results: []
    }, { persist: true });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  if (cmd === 'status') {
    const out = statusAntColony({
      policy_path: args.policy || process.env.RED_TEAM_POLICY_PATH || DEFAULT_POLICY_PATH,
      state_root: args['state-root'] || args.state_root
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    if (!out.ok) process.exitCode = 1;
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
      type: 'redteam_ant_colony',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'ant_colony_failed', 260)
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  resolveColonyPolicy,
  runAntColony,
  statusAntColony
};
