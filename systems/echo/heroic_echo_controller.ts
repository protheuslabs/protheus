#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/echo/heroic_echo_controller.js
 *
 * Heroic Echo controller (shadow-first):
 * - Routes user input through the Input Purification Gate.
 * - Emits auditable receipts and review queues.
 * - Integrates with mirror suggestions, doctor intake, training quarantine, and weaver hints.
 *
 * Usage:
 *   node systems/echo/heroic_echo_controller.js run [YYYY-MM-DD] [--policy=path] [--input-text="..."] [--input-json='[...]'] [--input-file=path] [--apply=1|0] [--source=<id>] [--objective-id=<id>]
 *   node systems/echo/heroic_echo_controller.js status [latest|YYYY-MM-DD] [--policy=path]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  defaultGatePolicy,
  mergeGatePolicy,
  purifyInputs
} = require('./input_purification_gate');
let dualityEvaluate = null;
let registerDualityObservation = null;
try {
  const duality = require('../../lib/duality_seed.js');
  dualityEvaluate = duality.duality_evaluate || duality.evaluateDualitySignal || null;
  registerDualityObservation = duality.registerDualityObservation || null;
} catch {
  dualityEvaluate = null;
  registerDualityObservation = null;
}

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'echo_policy.json');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'autonomy', 'echo');
const DEFAULT_RUNS_DIR = path.join(DEFAULT_STATE_DIR, 'runs');
const DEFAULT_LATEST_PATH = path.join(DEFAULT_STATE_DIR, 'latest.json');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_STATE_DIR, 'history.jsonl');
const DEFAULT_EVENTS_PATH = path.join(DEFAULT_STATE_DIR, 'events.jsonl');
const DEFAULT_OBSIDIAN_PATH = path.join(DEFAULT_STATE_DIR, 'obsidian_projection.jsonl');
const DEFAULT_IDE_EVENTS_PATH = path.join(DEFAULT_STATE_DIR, 'ide_events.jsonl');

function usage() {
  console.log('Usage:');
  console.log('  node systems/echo/heroic_echo_controller.js run [YYYY-MM-DD] [--policy=path] [--input-text="..."] [--input-json=\'[...]\' ] [--input-file=path] [--apply=1|0] [--source=<id>] [--objective-id=<id>]');
  console.log('  node systems/echo/heroic_echo_controller.js status [latest|YYYY-MM-DD] [--policy=path]');
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

function cleanText(v: unknown, maxLen = 220) {
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
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readStdinUtf8() {
  try {
    if (process.stdin.isTTY) return '';
    return String(fs.readFileSync(0, 'utf8') || '');
  } catch {
    return '';
  }
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function parseJsonPayload(raw: unknown) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function resolvePath(raw: unknown, fallback: string) {
  const text = cleanText(raw, 500);
  if (!text) return fallback;
  return path.isAbsolute(text) ? text : path.resolve(ROOT, text);
}

function sha16(seed: string) {
  return crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 16);
}

function defaultTrainingQuarantinePath() {
  const nurseryPolicyPath = path.join(ROOT, 'config', 'nursery_policy.json');
  const nurseryPolicy = readJson(nurseryPolicyPath, {});
  const fallbackRoot = cleanText(
    nurseryPolicy && nurseryPolicy.fallback_repo_root_dir || 'state/nursery/containment',
    260
  ) || 'state/nursery/containment';
  const quarantineDir = cleanText(
    nurseryPolicy && nurseryPolicy.directories && nurseryPolicy.directories.quarantine_training_data
      ? nurseryPolicy.directories.quarantine_training_data
      : 'quarantine/training-data',
    260
  ) || 'quarantine/training-data';
  return path.resolve(ROOT, fallbackRoot, quarantineDir, 'echo_input_queue.jsonl');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    input: {
      max_rows_per_run: 96,
      allow_stdin_json: true,
      allow_empty_run: true
    },
    gate: defaultGatePolicy(),
    governance: {
      enforce_user_sovereignty: true,
      allow_auto_belief_apply: false,
      require_explicit_belief_review: true
    },
    routes: {
      emit_shadow_routes: true,
      mirror_suggestions_dir: 'state/autonomy/mirror_organ/suggestions',
      doctor_queue_path: 'state/ops/autotest_doctor/echo_intake.jsonl',
      security_queue_path: 'state/security/echo_purification_queue.jsonl',
      belief_review_queue_path: 'state/autonomy/echo/belief_review.jsonl',
      belief_update_queue_path: 'state/autonomy/echo/belief_updates/pending.jsonl',
      training_quarantine_queue_path: relPath(defaultTrainingQuarantinePath()),
      weaver_hint_queue_path: 'state/autonomy/weaver/echo_value_hints.jsonl'
    },
    outputs: {
      emit_events: true,
      emit_ide_events: true,
      emit_obsidian_projection: true,
      write_run_receipt: true
    }
  };
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const input = raw.input && typeof raw.input === 'object' ? raw.input : {};
  const governance = raw.governance && typeof raw.governance === 'object' ? raw.governance : {};
  const routes = raw.routes && typeof raw.routes === 'object' ? raw.routes : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 32) || '1.0',
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    allow_apply: toBool(raw.allow_apply, base.allow_apply),
    input: {
      max_rows_per_run: clampInt(input.max_rows_per_run, 1, 5000, base.input.max_rows_per_run),
      allow_stdin_json: toBool(input.allow_stdin_json, base.input.allow_stdin_json),
      allow_empty_run: toBool(input.allow_empty_run, base.input.allow_empty_run)
    },
    gate: mergeGatePolicy(raw.gate && typeof raw.gate === 'object' ? raw.gate : base.gate),
    governance: {
      enforce_user_sovereignty: toBool(
        governance.enforce_user_sovereignty,
        base.governance.enforce_user_sovereignty
      ),
      allow_auto_belief_apply: toBool(
        governance.allow_auto_belief_apply,
        base.governance.allow_auto_belief_apply
      ),
      require_explicit_belief_review: toBool(
        governance.require_explicit_belief_review,
        base.governance.require_explicit_belief_review
      )
    },
    routes: {
      emit_shadow_routes: toBool(routes.emit_shadow_routes, base.routes.emit_shadow_routes),
      mirror_suggestions_dir: cleanText(routes.mirror_suggestions_dir || base.routes.mirror_suggestions_dir, 260)
        || base.routes.mirror_suggestions_dir,
      doctor_queue_path: cleanText(routes.doctor_queue_path || base.routes.doctor_queue_path, 260)
        || base.routes.doctor_queue_path,
      security_queue_path: cleanText(routes.security_queue_path || base.routes.security_queue_path, 260)
        || base.routes.security_queue_path,
      belief_review_queue_path: cleanText(routes.belief_review_queue_path || base.routes.belief_review_queue_path, 260)
        || base.routes.belief_review_queue_path,
      belief_update_queue_path: cleanText(routes.belief_update_queue_path || base.routes.belief_update_queue_path, 260)
        || base.routes.belief_update_queue_path,
      training_quarantine_queue_path: cleanText(
        routes.training_quarantine_queue_path || base.routes.training_quarantine_queue_path,
        260
      ) || base.routes.training_quarantine_queue_path,
      weaver_hint_queue_path: cleanText(routes.weaver_hint_queue_path || base.routes.weaver_hint_queue_path, 260)
        || base.routes.weaver_hint_queue_path
    },
    outputs: {
      emit_events: toBool(outputs.emit_events, base.outputs.emit_events),
      emit_ide_events: toBool(outputs.emit_ide_events, base.outputs.emit_ide_events),
      emit_obsidian_projection: toBool(outputs.emit_obsidian_projection, base.outputs.emit_obsidian_projection),
      write_run_receipt: toBool(outputs.write_run_receipt, base.outputs.write_run_receipt)
    }
  };
}

function runtimePaths(policyPath: string, policy: AnyObj) {
  const stateDir = process.env.ECHO_STATE_DIR
    ? path.resolve(process.env.ECHO_STATE_DIR)
    : DEFAULT_STATE_DIR;
  return {
    policy_path: policyPath,
    state_dir: stateDir,
    runs_dir: process.env.ECHO_RUNS_DIR ? path.resolve(process.env.ECHO_RUNS_DIR) : DEFAULT_RUNS_DIR,
    latest_path: process.env.ECHO_LATEST_PATH ? path.resolve(process.env.ECHO_LATEST_PATH) : DEFAULT_LATEST_PATH,
    history_path: process.env.ECHO_HISTORY_PATH ? path.resolve(process.env.ECHO_HISTORY_PATH) : DEFAULT_HISTORY_PATH,
    events_path: process.env.ECHO_EVENTS_PATH ? path.resolve(process.env.ECHO_EVENTS_PATH) : DEFAULT_EVENTS_PATH,
    ide_events_path: process.env.ECHO_IDE_EVENTS_PATH ? path.resolve(process.env.ECHO_IDE_EVENTS_PATH) : DEFAULT_IDE_EVENTS_PATH,
    obsidian_path: process.env.ECHO_OBSIDIAN_PATH ? path.resolve(process.env.ECHO_OBSIDIAN_PATH) : DEFAULT_OBSIDIAN_PATH,
    mirror_suggestions_dir: resolvePath(policy.routes.mirror_suggestions_dir, path.join(ROOT, 'state', 'autonomy', 'mirror_organ', 'suggestions')),
    doctor_queue_path: resolvePath(policy.routes.doctor_queue_path, path.join(ROOT, 'state', 'ops', 'autotest_doctor', 'echo_intake.jsonl')),
    security_queue_path: resolvePath(policy.routes.security_queue_path, path.join(ROOT, 'state', 'security', 'echo_purification_queue.jsonl')),
    belief_review_queue_path: resolvePath(policy.routes.belief_review_queue_path, path.join(stateDir, 'belief_review.jsonl')),
    belief_update_queue_path: resolvePath(policy.routes.belief_update_queue_path, path.join(stateDir, 'belief_updates', 'pending.jsonl')),
    training_quarantine_queue_path: resolvePath(
      policy.routes.training_quarantine_queue_path,
      defaultTrainingQuarantinePath()
    ),
    weaver_hint_queue_path: resolvePath(policy.routes.weaver_hint_queue_path, path.join(ROOT, 'state', 'autonomy', 'weaver', 'echo_value_hints.jsonl'))
  };
}

function emitEvent(paths: AnyObj, policy: AnyObj, stage: string, payload: AnyObj = {}) {
  if (policy.outputs.emit_events !== true) return;
  appendJsonl(paths.events_path, {
    ts: nowIso(),
    type: 'heroic_echo_event',
    stage,
    ...payload
  });
}

function emitIdeEvent(paths: AnyObj, policy: AnyObj, payload: AnyObj = {}) {
  if (policy.outputs.emit_ide_events !== true) return;
  appendJsonl(paths.ide_events_path, {
    ts: nowIso(),
    type: 'heroic_echo_ide_projection',
    ...payload
  });
}

function emitObsidian(paths: AnyObj, policy: AnyObj, payload: AnyObj = {}) {
  if (policy.outputs.emit_obsidian_projection !== true) return;
  appendJsonl(paths.obsidian_path, {
    ts: nowIso(),
    type: 'heroic_echo_obsidian_receipt',
    ...payload
  });
}

function toInputRows(args: AnyObj, policy: AnyObj) {
  const rows: AnyObj[] = [];
  const pushRows = (payload: unknown) => {
    if (Array.isArray(payload)) {
      for (const row of payload) rows.push(row && typeof row === 'object' ? row : { text: String(row || '') });
      return;
    }
    if (payload && typeof payload === 'object') rows.push(payload);
  };

  if (args['input-json']) {
    pushRows(parseJsonPayload(args['input-json']));
  }
  if (args['input-file']) {
    const fp = path.resolve(ROOT, String(args['input-file']));
    if (fs.existsSync(fp)) {
      const raw = String(fs.readFileSync(fp, 'utf8') || '');
      const parsed = parseJsonPayload(raw);
      if (parsed != null) pushRows(parsed);
      else {
        for (const line of raw.split('\n').map((x) => x.trim()).filter(Boolean)) {
          const row = parseJsonPayload(line);
          if (row && typeof row === 'object') rows.push(row);
        }
      }
    }
  }
  if (args['input-text']) {
    rows.push({
      text: cleanText(args['input-text'], 2000),
      source: args.source || 'manual',
      modality: args.modality || 'text',
      objective_id: args['objective-id'] || args.objective_id || null
    });
  }
  if (policy.input.allow_stdin_json === true && rows.length === 0) {
    const stdinRaw = readStdinUtf8();
    if (stdinRaw) {
      const parsed = parseJsonPayload(stdinRaw);
      if (parsed != null) pushRows(parsed);
    }
  }

  const maxRows = Number(policy.input.max_rows_per_run || 96);
  const out = rows.slice(0, maxRows).map((row: AnyObj, idx: number) => ({
    ...row,
    id: normalizeToken(row && row.id || '', 120) || `ei_${sha16(`${Date.now()}|${idx}|${row && (row.text || row.content || row.message) || ''}`)}`
  }));
  return out;
}

function appendMirrorSuggestions(mirrorDir: string, dateStr: string, rows: AnyObj[]) {
  if (!rows.length) return 0;
  ensureDir(mirrorDir);
  const fp = path.join(mirrorDir, `${dateStr}.json`);
  const existing = readJson(fp, []);
  const src = Array.isArray(existing) ? existing.slice(0) : [];
  const seen = new Set(src.map((row: AnyObj) => String(row && row.id || '').trim()).filter(Boolean));
  let appended = 0;
  for (const row of rows) {
    const id = String(row && row.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    src.push(row);
    appended += 1;
  }
  writeJsonAtomic(fp, src);
  return appended;
}

function detectMetricSwitch(text: string) {
  const blob = String(text || '').toLowerCase();
  const explicit = blob.match(/\b(primary metric|prioritize|focus on|value metric)\s*[:=-]?\s*([a-z0-9 _-]+)/i);
  if (explicit && explicit[2]) {
    const metric = normalizeToken(explicit[2], 80);
    if (metric) return metric;
  }
  if (/\b(learning|wisdom|research)\b/.test(blob)) return 'learning';
  if (/\b(quality|safety|truth)\b/.test(blob)) return 'quality';
  if (/\b(revenue|income|profit|money)\b/.test(blob)) return 'revenue';
  if (/\b(joy|beauty|creative|play)\b/.test(blob)) return 'user_value';
  return null;
}

function buildRoutePayloads(rows: AnyObj[], runMeta: AnyObj) {
  const trainingRows: AnyObj[] = [];
  const mirrorRows: AnyObj[] = [];
  const doctorRows: AnyObj[] = [];
  const securityRows: AnyObj[] = [];
  const beliefReviewRows: AnyObj[] = [];
  const beliefUpdateRows: AnyObj[] = [];
  const weaverHints: AnyObj[] = [];

  for (const row of rows) {
    const metricSwitch = detectMetricSwitch(row.text);
    if (metricSwitch) {
      weaverHints.push({
        ts: row.ts,
        type: 'echo_metric_switch_suggestion',
        source: 'heroic_echo',
        run_id: runMeta.run_id,
        input_id: row.id,
        metric_id: metricSwitch,
        objective_id: row.objective_id || null,
        reason: 'user_declared_metric_signal',
        shadow_only: runMeta.shadow_only
      });
    }
    if (row.route && row.route.training === true) {
      trainingRows.push({
        ts: row.ts,
        schema_id: 'echo_training_candidate',
        source: 'heroic_echo',
        run_id: runMeta.run_id,
        input_id: row.id,
        objective_id: row.objective_id || null,
        modality: row.modality || 'text',
        classification: row.classification,
        decision: row.decision,
        text: row.text,
        governance: {
          shadow_only: runMeta.shadow_only,
          sovereignty_guard: true
        }
      });
    }
    if (row.route && row.route.mirror_support === true) {
      mirrorRows.push({
        id: `echo_mir_${sha16(`${runMeta.run_id}|${row.id}`)}`,
        type: 'mirror_self_critique_suggestion',
        kind: 'echo_support_reflection',
        source: 'heroic_echo',
        title: 'Gentle support reflection',
        summary: `Support request detected for input ${row.id}. Route to reflective guidance, not training.`,
        confidence: Number(Math.max(0, Math.min(1, Number(row.scores && row.scores.distress || 0))).toFixed(4)),
        pressure_score: Number(Math.max(0, Math.min(1, Number(row.scores && row.scores.distress || 0))).toFixed(4)),
        objective_id: row.objective_id || null,
        evidence_refs: [row.id],
        action: {
          mode: 'support_reflection',
          recommendation: 'mirror_gentle_support_prompt'
        }
      });
    }
    if (row.route && row.route.doctor_review === true) {
      doctorRows.push({
        ts: row.ts,
        type: 'echo_doctor_review',
        source: 'heroic_echo',
        run_id: runMeta.run_id,
        input_id: row.id,
        classification: row.classification,
        severity: row.classification === 'destructive_instruction' ? 'high' : 'medium',
        decision: row.decision,
        reason_codes: row.reason_codes || [],
        shadow_only: runMeta.shadow_only
      });
    }
    if (row.route && row.route.security_review === true) {
      securityRows.push({
        ts: row.ts,
        type: 'echo_security_review',
        source: 'heroic_echo',
        run_id: runMeta.run_id,
        input_id: row.id,
        classification: row.classification,
        blocked: row.blocked === true,
        reason_codes: row.reason_codes || [],
        text_excerpt: cleanText(row.text || '', 220),
        shadow_only: runMeta.shadow_only
      });
    }
    if (row.route && row.route.belief_review === true) {
      beliefReviewRows.push({
        ts: row.ts,
        type: 'echo_belief_review',
        source: 'heroic_echo',
        run_id: runMeta.run_id,
        input_id: row.id,
        objective_id: row.objective_id || null,
        classification: row.classification,
        text: cleanText(row.text || '', 600),
        reason_codes: row.reason_codes || [],
        review_required: true,
        shadow_only: runMeta.shadow_only
      });
    }
    if (row.route && row.route.belief_update === true) {
      for (const candidate of Array.isArray(row.belief_candidates) ? row.belief_candidates : []) {
        beliefUpdateRows.push({
          ts: row.ts,
          type: 'echo_belief_update_proposal',
          source: 'heroic_echo',
          run_id: runMeta.run_id,
          input_id: row.id,
          objective_id: row.objective_id || null,
          belief_id: candidate.belief_id,
          belief_statement: candidate.belief_statement,
          confidence: Number(candidate.confidence || 0),
          trit_label: normalizeToken(candidate.trit_label || 'true', 16) || 'true',
          default_integration: candidate.default_integration === true,
          status: 'proposed',
          reversible: true,
          audit_required: true,
          shadow_only: runMeta.shadow_only
        });
      }
    }
  }

  return {
    trainingRows,
    mirrorRows,
    doctorRows,
    securityRows,
    beliefReviewRows,
    beliefUpdateRows,
    weaverHints
  };
}

function cmdRun(args: AnyObj, dateStr: string, policyPath: string) {
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  ensureDir(paths.state_dir);
  ensureDir(paths.runs_dir);

  const applyRequested = toBool(args.apply, false);
  const applyExecuted = applyRequested && policy.allow_apply === true && policy.shadow_only !== true;
  const shadowOnly = !applyExecuted;

  const inputs = toInputRows(args, policy);
  if (!inputs.length && policy.input.allow_empty_run !== true) {
    process.stdout.write(JSON.stringify({
      ok: false,
      type: 'heroic_echo_run',
      ts: nowIso(),
      date: dateStr,
      error: 'no_inputs'
    }) + '\n');
    process.exitCode = 1;
    return;
  }

  const runId = normalizeToken(args['run-id'] || args.run_id || '', 120)
    || `echo_${dateStr}_${sha16(`${Date.now()}|${Math.random()}`)}`;
  const dualitySignal = typeof dualityEvaluate === 'function'
    ? dualityEvaluate({
      lane: 'heroic_echo_filtering',
      source: 'heroic_echo_controller',
      run_id: runId,
      objective_id: args['objective-id'] || args.objective_id || null,
      source_id: args.source || 'manual',
      input_preview: inputs.slice(0, 20).map((row) => ({
        id: row.id,
        source: row.source,
        modality: row.modality,
        text: cleanText(row.text || '', 180)
      }))
    }, {
      lane: 'heroic_echo_filtering',
      source: 'heroic_echo_controller',
      run_id: runId,
      persist: true
    })
    : null;
  const purified = purifyInputs(inputs, policy.gate, {
    date: dateStr,
    run_id: runId,
    source: args.source || 'manual',
    objective_id: args['objective-id'] || args.objective_id || null
  });

  const routePayloads = buildRoutePayloads(purified.rows || [], {
    run_id: runId,
    shadow_only: shadowOnly
  });
  if (dualitySignal && dualitySignal.enabled === true) {
    routePayloads.weaverHints.push({
      ts: nowIso(),
      type: 'echo_weaver_duality_hint',
      source: 'heroic_echo',
      run_id: runId,
      metric_id: String(dualitySignal.recommended_adjustment || 'hold_balance_near_zero_point'),
      intensity_hint: Number(dualitySignal.zero_point_harmony_potential || 0),
      confidence: Number(dualitySignal.confidence || 0),
      reason_codes: ['duality_advisory']
    });
  }

  const routeAllowed = applyExecuted || policy.routes.emit_shadow_routes === true;
  let mirrorAppended = 0;
  if (routeAllowed) {
    mirrorAppended = appendMirrorSuggestions(paths.mirror_suggestions_dir, dateStr, routePayloads.mirrorRows);
    for (const row of routePayloads.trainingRows) appendJsonl(paths.training_quarantine_queue_path, row);
    for (const row of routePayloads.doctorRows) appendJsonl(paths.doctor_queue_path, row);
    for (const row of routePayloads.securityRows) appendJsonl(paths.security_queue_path, row);
    for (const row of routePayloads.beliefReviewRows) appendJsonl(paths.belief_review_queue_path, row);
    for (const row of routePayloads.beliefUpdateRows) appendJsonl(paths.belief_update_queue_path, row);
    for (const row of routePayloads.weaverHints) appendJsonl(paths.weaver_hint_queue_path, row);
  }

  const routeCounts = {
    training: routePayloads.trainingRows.length,
    mirror_support: routePayloads.mirrorRows.length,
    doctor_review: routePayloads.doctorRows.length,
    security_review: routePayloads.securityRows.length,
    belief_review: routePayloads.beliefReviewRows.length,
    belief_update: routePayloads.beliefUpdateRows.length,
    weaver_hints: routePayloads.weaverHints.length
  };

  const payload = {
    ok: true,
    type: 'heroic_echo_run',
    ts: nowIso(),
    date: dateStr,
    run_id: runId,
    policy_version: policy.version,
    shadow_only: shadowOnly,
    apply_requested: applyRequested,
    apply_executed: applyExecuted,
    route_emitted: routeAllowed,
    inputs_seen: inputs.length,
    summary: purified.summary,
    route_counts: routeCounts,
    mirror_suggestions_appended: mirrorAppended,
    quality_metrics: {
      blocked_ratio: Number(
        (
          Number((purified.summary && purified.summary.blocked) || 0)
          / Math.max(1, Number((purified.summary && purified.summary.total) || 0))
        ).toFixed(6)
      ),
      contradictory_ratio: Number(
        (
          Number((purified.summary && purified.summary.contradictory_belief) || 0)
          / Math.max(1, Number((purified.summary && purified.summary.total) || 0))
        ).toFixed(6)
      )
    },
    duality: dualitySignal
      ? {
        enabled: dualitySignal.enabled === true,
        score_trit: Number(dualitySignal.score_trit || 0),
        score_label: cleanText(dualitySignal.score_label || 'unknown', 32),
        zero_point_harmony_potential: Number(dualitySignal.zero_point_harmony_potential || 0),
        recommended_adjustment: cleanText(dualitySignal.recommended_adjustment || '', 120) || null,
        confidence: Number(dualitySignal.confidence || 0),
        effective_weight: Number(dualitySignal.effective_weight || 0),
        indicator: dualitySignal.indicator && typeof dualitySignal.indicator === 'object'
          ? dualitySignal.indicator
          : null,
        zero_point_insight: cleanText(dualitySignal.zero_point_insight || '', 220) || null
      }
      : {
        enabled: false
      },
    routes: {
      mirror_suggestions_dir: relPath(paths.mirror_suggestions_dir),
      training_quarantine_queue_path: relPath(paths.training_quarantine_queue_path),
      doctor_queue_path: relPath(paths.doctor_queue_path),
      security_queue_path: relPath(paths.security_queue_path),
      belief_review_queue_path: relPath(paths.belief_review_queue_path),
      belief_update_queue_path: relPath(paths.belief_update_queue_path),
      weaver_hint_queue_path: relPath(paths.weaver_hint_queue_path)
    },
    sovereign_invariant: policy.governance.enforce_user_sovereignty === true
      && policy.governance.allow_auto_belief_apply !== true
  };

  const runPath = path.join(paths.runs_dir, `${dateStr}.json`);
  if (policy.outputs.write_run_receipt === true) writeJsonAtomic(runPath, payload);
  writeJsonAtomic(paths.latest_path, payload);
  appendJsonl(paths.history_path, payload);

  emitEvent(paths, policy, 'run_complete', {
    run_id: runId,
    inputs_seen: inputs.length,
    summary: payload.summary,
    route_counts: routeCounts,
    shadow_only: shadowOnly,
    duality: payload.duality
  });
  emitIdeEvent(paths, policy, {
    event: 'echo_purification_summary',
    run_id: runId,
    summary: payload.summary,
    route_counts: routeCounts,
    shadow_only: shadowOnly,
    duality: payload.duality
  });
  emitObsidian(paths, policy, {
    run_id: runId,
    title: 'Heroic Echo Purification Receipt',
    summary: payload.summary,
    route_counts: routeCounts,
    decision: shadowOnly ? 'shadow_only' : 'applied',
    duality: payload.duality
  });
  if (dualitySignal && dualitySignal.enabled === true && typeof registerDualityObservation === 'function') {
    try {
      const blockedRatio = Number(payload.quality_metrics && payload.quality_metrics.blocked_ratio || 0);
      const observedTrit = blockedRatio >= 0.5
        ? -1
        : (
          Number((payload.summary && payload.summary.constructive_aligned) || 0) > 0
            ? 1
            : 0
        );
      registerDualityObservation({
        lane: 'heroic_echo_filtering',
        source: 'heroic_echo_controller',
        run_id: runId,
        predicted_trit: Number(dualitySignal.score_trit || 0),
        observed_trit: observedTrit
      });
    } catch {
      // Do not fail purification flow on advisory observation write issues.
    }
  }

  process.stdout.write(JSON.stringify({
    ...payload,
    latest_path: relPath(paths.latest_path),
    run_path: relPath(runPath)
  }) + '\n');
}

function cmdStatus(args: AnyObj, dateArg: string, policyPath: string) {
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const fp = dateArg === 'latest'
    ? paths.latest_path
    : path.join(paths.runs_dir, `${dateArg}.json`);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(JSON.stringify({
      ok: false,
      type: 'heroic_echo_status',
      date: dateArg,
      error: 'echo_status_missing'
    }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'heroic_echo_status',
    date: payload.date || dateArg,
    run_id: payload.run_id || null,
    shadow_only: payload.shadow_only === true,
    inputs_seen: Number(payload.inputs_seen || 0),
    summary: payload.summary || {},
    route_counts: payload.route_counts || {},
    apply_executed: payload.apply_executed === true,
    latest_path: relPath(paths.latest_path)
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help === true) {
    usage();
    return;
  }
  const policyPath = args.policy
    ? path.resolve(ROOT, String(args.policy))
    : DEFAULT_POLICY_PATH;
  const dateStr = toDate(args._[1]);
  if (cmd === 'run') {
    cmdRun(args, dateStr, policyPath);
    return;
  }
  if (cmd === 'status') {
    const target = String(args._[1] || 'latest').trim().toLowerCase();
    cmdStatus(args, target === 'latest' ? 'latest' : toDate(target), policyPath);
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}

module.exports = {
  defaultPolicy,
  loadPolicy,
  buildRoutePayloads,
  toInputRows
};
