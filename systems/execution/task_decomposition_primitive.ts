#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/execution/task_decomposition_primitive.js
 *
 * V3-TASK-001: Task Decomposition Primitive ("digestive system")
 * - Decomposes high-level goals into standardized 1-5 minute micro-task profiles.
 * - Emits parallel routing candidates for autonomous micro-agents + Storm human lane.
 * - Applies Heroic Echo purification + constitution gate checks per micro-task.
 * - Links receipts/actions into the agent passport chain.
 * - Emits subtle duality indicators for receipts/IDE projection.
 *
 * Usage:
 *   node systems/execution/task_decomposition_primitive.js run [YYYY-MM-DD] --goal="..." [--objective-id=<id>] [--apply=1|0]
 *   node systems/execution/task_decomposition_primitive.js run [YYYY-MM-DD] --goal-json='{"goal":"..."}' [--apply=1|0]
 *   node systems/execution/task_decomposition_primitive.js status [latest|YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mergeGatePolicy, purifyInputs } = require('../echo/input_purification_gate.js');
const { evaluateTask: evaluateDirectiveTask } = require('../security/directive_gate.js');
const { issuePassport, appendAction } = require('../security/agent_passport.js');
const { writeContractReceipt } = require('../../lib/action_receipts.js');
let recordAttribution = null;
try {
  ({ recordAttribution } = require('../attribution/value_attribution_primitive.js'));
} catch {
  recordAttribution = null;
}

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

type Segment = {
  text: string;
  depth: number;
  parent_id: string | null;
};

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.TASK_DECOMPOSITION_POLICY_PATH
  ? path.resolve(process.env.TASK_DECOMPOSITION_POLICY_PATH)
  : path.join(ROOT, 'config', 'task_decomposition_primitive_policy.json');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'execution', 'task_decomposition_primitive');

function usage() {
  console.log('Usage:');
  console.log('  node systems/execution/task_decomposition_primitive.js run [YYYY-MM-DD] --goal="..." [--objective-id=<id>] [--goal-id=<id>] [--apply=1|0] [--policy=path]');
  console.log('  node systems/execution/task_decomposition_primitive.js run [YYYY-MM-DD] --goal-json=\'{"goal":"..."}\' [--apply=1|0] [--policy=path]');
  console.log('  node systems/execution/task_decomposition_primitive.js run [YYYY-MM-DD] --goal-file=path [--apply=1|0] [--policy=path]');
  console.log('  node systems/execution/task_decomposition_primitive.js status [latest|YYYY-MM-DD] [--policy=path]');
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

function cleanText(v: unknown, maxLen = 240) {
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
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function sha16(seed: string) {
  return crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 16);
}

function parseJsonArg(raw: unknown, fallback: any) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return fallback;
  const payload = text.startsWith('@')
    ? String(fs.readFileSync(path.resolve(ROOT, text.slice(1)), 'utf8') || '')
    : text;
  try {
    return JSON.parse(payload);
  } catch {
    return fallback;
  }
}

function readGoalFile(filePathRaw: unknown) {
  const filePath = cleanText(filePathRaw, 500);
  if (!filePath) return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ROOT, filePath);
  if (!fs.existsSync(abs)) return null;
  const text = String(fs.readFileSync(abs, 'utf8') || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // fallthrough
  }
  return { goal: text, source: 'goal_file', goal_file_path: relPath(abs) };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    decomposition: {
      max_depth: 4,
      max_micro_tasks: 96,
      max_words_per_leaf: 18,
      min_minutes: 1,
      max_minutes: 5
    },
    parallel: {
      max_groups: 8,
      default_lane: 'autonomous_micro_agent',
      storm_lane: 'storm_human_lane',
      human_lane_keywords: [
        'brainstorm', 'creative', 'design', 'negotiate', 'judge', 'taste', 'style', 'relationship', 'call', 'human review'
      ],
      autonomous_lane_keywords: [
        'fetch', 'parse', 'summarize', 'compile', 'test', 'verify', 'check', 'generate', 'transform', 'analyze'
      ],
      min_storm_share: 0.15
    },
    gates: {
      heroic_echo_enabled: true,
      constitution_enabled: true,
      block_on_destructive: true,
      block_on_constitution_deny: true
    },
    attribution: {
      enabled: true,
      issue_passport: true,
      passport_source: 'task_decomposition_primitive',
      actor: {
        actor: 'task_decomposition_primitive',
        role: 'execution',
        model: 'task_decomposer',
        framework: 'openclaw',
        org: 'protheus',
        tenant: 'local'
      }
    },
    outputs: {
      persist_profiles: true,
      emit_events: true,
      emit_ide_events: true,
      emit_obsidian_projection: false
    },
    state: {
      root: 'state/execution/task_decomposition_primitive',
      runs_dir: 'state/execution/task_decomposition_primitive/runs',
      latest_path: 'state/execution/task_decomposition_primitive/latest.json',
      history_path: 'state/execution/task_decomposition_primitive/history.jsonl',
      events_path: 'state/execution/task_decomposition_primitive/events.jsonl',
      ide_events_path: 'state/execution/task_decomposition_primitive/ide_events.jsonl',
      receipts_path: 'state/execution/task_decomposition_primitive/receipts.jsonl',
      profiles_dir: 'state/execution/task_decomposition_primitive/profiles',
      weaver_queue_path: 'state/autonomy/weaver/task_decomposition_queue.jsonl',
      storm_queue_path: 'state/storm/micro_tasks_queue.jsonl',
      obsidian_queue_path: 'state/execution/task_decomposition_primitive/obsidian_projection.jsonl'
    }
  };
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const text = cleanText(raw, 500);
  if (!text) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const dec = raw.decomposition && typeof raw.decomposition === 'object' ? raw.decomposition : {};
  const parallel = raw.parallel && typeof raw.parallel === 'object' ? raw.parallel : {};
  const gates = raw.gates && typeof raw.gates === 'object' ? raw.gates : {};
  const attribution = raw.attribution && typeof raw.attribution === 'object' ? raw.attribution : {};
  const actor = attribution.actor && typeof attribution.actor === 'object' ? attribution.actor : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    allow_apply: toBool(raw.allow_apply, base.allow_apply),
    decomposition: {
      max_depth: clampInt(dec.max_depth, 1, 8, base.decomposition.max_depth),
      max_micro_tasks: clampInt(dec.max_micro_tasks, 4, 512, base.decomposition.max_micro_tasks),
      max_words_per_leaf: clampInt(dec.max_words_per_leaf, 4, 80, base.decomposition.max_words_per_leaf),
      min_minutes: clampInt(dec.min_minutes, 1, 10, base.decomposition.min_minutes),
      max_minutes: clampInt(dec.max_minutes, 1, 15, base.decomposition.max_minutes)
    },
    parallel: {
      max_groups: clampInt(parallel.max_groups, 1, 64, base.parallel.max_groups),
      default_lane: normalizeToken(parallel.default_lane || base.parallel.default_lane, 80) || base.parallel.default_lane,
      storm_lane: normalizeToken(parallel.storm_lane || base.parallel.storm_lane, 80) || base.parallel.storm_lane,
      human_lane_keywords: Array.isArray(parallel.human_lane_keywords)
        ? parallel.human_lane_keywords.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : base.parallel.human_lane_keywords,
      autonomous_lane_keywords: Array.isArray(parallel.autonomous_lane_keywords)
        ? parallel.autonomous_lane_keywords.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : base.parallel.autonomous_lane_keywords,
      min_storm_share: clampNumber(parallel.min_storm_share, 0, 1, base.parallel.min_storm_share)
    },
    gates: {
      heroic_echo_enabled: toBool(gates.heroic_echo_enabled, base.gates.heroic_echo_enabled),
      constitution_enabled: toBool(gates.constitution_enabled, base.gates.constitution_enabled),
      block_on_destructive: toBool(gates.block_on_destructive, base.gates.block_on_destructive),
      block_on_constitution_deny: toBool(gates.block_on_constitution_deny, base.gates.block_on_constitution_deny)
    },
    attribution: {
      enabled: toBool(attribution.enabled, base.attribution.enabled),
      issue_passport: toBool(attribution.issue_passport, base.attribution.issue_passport),
      passport_source: normalizeToken(attribution.passport_source || base.attribution.passport_source, 120) || base.attribution.passport_source,
      actor: {
        actor: normalizeToken(actor.actor || base.attribution.actor.actor, 120) || base.attribution.actor.actor,
        role: normalizeToken(actor.role || base.attribution.actor.role, 80) || base.attribution.actor.role,
        model: normalizeToken(actor.model || base.attribution.actor.model, 120) || base.attribution.actor.model,
        framework: normalizeToken(actor.framework || base.attribution.actor.framework, 120) || base.attribution.actor.framework,
        org: normalizeToken(actor.org || base.attribution.actor.org, 120) || base.attribution.actor.org,
        tenant: normalizeToken(actor.tenant || base.attribution.actor.tenant, 120) || base.attribution.actor.tenant
      }
    },
    outputs: {
      persist_profiles: toBool(outputs.persist_profiles, base.outputs.persist_profiles),
      emit_events: toBool(outputs.emit_events, base.outputs.emit_events),
      emit_ide_events: toBool(outputs.emit_ide_events, base.outputs.emit_ide_events),
      emit_obsidian_projection: toBool(outputs.emit_obsidian_projection, base.outputs.emit_obsidian_projection)
    },
    state: {
      root: resolvePath(state.root || base.state.root, base.state.root),
      runs_dir: resolvePath(state.runs_dir || base.state.runs_dir, base.state.runs_dir),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      history_path: resolvePath(state.history_path || base.state.history_path, base.state.history_path),
      events_path: resolvePath(state.events_path || base.state.events_path, base.state.events_path),
      ide_events_path: resolvePath(state.ide_events_path || base.state.ide_events_path, base.state.ide_events_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path),
      profiles_dir: resolvePath(state.profiles_dir || base.state.profiles_dir, base.state.profiles_dir),
      weaver_queue_path: resolvePath(state.weaver_queue_path || base.state.weaver_queue_path, base.state.weaver_queue_path),
      storm_queue_path: resolvePath(state.storm_queue_path || base.state.storm_queue_path, base.state.storm_queue_path),
      obsidian_queue_path: resolvePath(state.obsidian_queue_path || base.state.obsidian_queue_path, base.state.obsidian_queue_path)
    }
  };
}

function splitCandidates(text: string) {
  const punct = text
    .split(/[\n;]+/)
    .map((row) => cleanText(row, 800))
    .filter(Boolean);
  const rows = punct.length ? punct : [text];
  const out: string[] = [];
  const connectors = /\b(?:and then|then|and|after|before|while|plus|also|with)\b/gi;
  for (const row of rows) {
    const split = row.split(connectors).map((part) => cleanText(part, 600)).filter(Boolean);
    if (split.length > 1) out.push(...split);
    else out.push(row);
  }
  return out;
}

function wordCount(text: string) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

function recursiveDecompose(text: string, depth: number, policy: AnyObj, parentId: string | null = null): Segment[] {
  const trimmed = cleanText(text, 1200);
  if (!trimmed) return [];
  const maxDepth = Number(policy.decomposition.max_depth || 4);
  const maxWordsLeaf = Number(policy.decomposition.max_words_per_leaf || 18);
  const words = wordCount(trimmed);
  if (depth >= maxDepth || words <= maxWordsLeaf) {
    return [{ text: trimmed, depth, parent_id: parentId }];
  }
  const candidates = splitCandidates(trimmed)
    .map((row) => cleanText(row, 1000))
    .filter(Boolean)
    .filter((row) => row !== trimmed);
  if (!candidates.length) {
    return [{ text: trimmed, depth, parent_id: parentId }];
  }
  const currentId = `seg_${sha16(`${depth}|${trimmed.slice(0, 120)}`)}`;
  const out: Segment[] = [];
  for (const cand of candidates) {
    const nested = recursiveDecompose(cand, depth + 1, policy, currentId);
    if (nested.length) out.push(...nested);
  }
  if (!out.length) return [{ text: trimmed, depth, parent_id: parentId }];
  return out;
}

function dedupeSegments(rows: Segment[], maxItems: number) {
  const out: Segment[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = normalizeToken(row.text, 220);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= maxItems) break;
  }
  return out;
}

function estimateMinutes(text: string, policy: AnyObj) {
  const words = wordCount(text);
  const minM = Number(policy.decomposition.min_minutes || 1);
  const maxM = Number(policy.decomposition.max_minutes || 5);
  let minutes = 1;
  if (words > 8) minutes = 2;
  if (words > 14) minutes = 3;
  if (words > 24) minutes = 4;
  if (words > 34) minutes = 5;
  return clampInt(minutes, minM, maxM, minM);
}

function inferCapability(text: string) {
  const lower = String(text || '').toLowerCase();
  if (/\b(email|slack|discord|message|notify|outreach)\b/.test(lower)) {
    return { capability_id: 'comms_message', adapter_kind: 'email_message', source_type: 'comms' };
  }
  if (/\b(browser|web|site|ui|form|click|navigate)\b/.test(lower)) {
    return { capability_id: 'browser_task', adapter_kind: 'browser_task', source_type: 'web_ui' };
  }
  if (/\b(api|http|endpoint|request|json|graphql|webhook)\b/.test(lower)) {
    return { capability_id: 'api_request', adapter_kind: 'http_request', source_type: 'api' };
  }
  if (/\b(file|document|write|save|edit|patch|code)\b/.test(lower)) {
    return { capability_id: 'filesystem_task', adapter_kind: 'filesystem_task', source_type: 'filesystem' };
  }
  if (/\b(test|verify|assert|validate|check)\b/.test(lower)) {
    return { capability_id: 'quality_check', adapter_kind: 'shell_task', source_type: 'analysis' };
  }
  if (/\b(research|analyze|summarize|read|investigate)\b/.test(lower)) {
    return { capability_id: 'analysis_task', adapter_kind: 'shell_task', source_type: 'analysis' };
  }
  return { capability_id: 'general_task', adapter_kind: 'shell_task', source_type: 'analysis' };
}

function titleForTask(text: string) {
  const words = String(text || '').split(/\s+/).filter(Boolean).slice(0, 9);
  if (!words.length) return 'Micro Task';
  const joined = words.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function successCriteria(text: string) {
  return [
    `Execute: ${cleanText(text, 180)}`,
    'Capture a receipt and link outcome to objective context.'
  ];
}

function normalizeTextKeywordRows(rows: string[]) {
  return rows.map((row) => normalizeToken(row, 80)).filter(Boolean);
}

function laneForTask(taskText: string, constitution: AnyObj, policy: AnyObj) {
  const lower = normalizeToken(taskText, 500);
  const humanHits = normalizeTextKeywordRows(policy.parallel.human_lane_keywords || []).filter((kw) => lower.includes(kw)).length;
  const autoHits = normalizeTextKeywordRows(policy.parallel.autonomous_lane_keywords || []).filter((kw) => lower.includes(kw)).length;
  if (constitution && constitution.decision === 'MANUAL') return policy.parallel.storm_lane;
  if (humanHits > autoHits) return policy.parallel.storm_lane;
  return policy.parallel.default_lane;
}

function collectGoalInput(args: AnyObj, dateStr: string) {
  const payload = parseJsonArg(args.goal_json || args['goal-json'] || '', null)
    || readGoalFile(args.goal_file || args['goal-file'])
    || {};
  const goalText = cleanText(
    args.goal
      || payload.goal
      || payload.text
      || payload.objective
      || '',
    4000
  );
  if (!goalText) return null;
  const goalId = normalizeToken(args.goal_id || args['goal-id'] || payload.goal_id || '', 120)
    || `goal_${sha16(`${dateStr}|${goalText.slice(0, 160)}`)}`;
  const objectiveId = normalizeToken(args.objective_id || args['objective-id'] || payload.objective_id || '', 120) || null;
  const source = normalizeToken(args.source || payload.source || 'manual_goal', 120) || 'manual_goal';
  const valueMetrics = Array.isArray(payload.value_metrics)
    ? payload.value_metrics.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
    : [];
  return {
    goal_id: goalId,
    goal_text: goalText,
    objective_id: objectiveId,
    source,
    value_metrics: valueMetrics,
    creator_id: normalizeToken(payload.creator_id || args.creator_id || '', 120) || null,
    metadata: payload && typeof payload === 'object' ? payload : {}
  };
}

function evaluateHeroicGate(taskText: string, policy: AnyObj, context: AnyObj) {
  if (policy.gates.heroic_echo_enabled !== true) {
    return {
      classification: 'gate_disabled',
      decision: 'gate_disabled',
      blocked: false,
      reason_codes: ['heroic_echo_gate_disabled']
    };
  }
  const gatePolicyRaw = readJson(path.join(ROOT, 'config', 'echo_policy.json'), {});
  const mergedGate = mergeGatePolicy(gatePolicyRaw.gate && typeof gatePolicyRaw.gate === 'object' ? gatePolicyRaw.gate : {});
  const purified = purifyInputs([
    {
      id: context.task_id,
      text: taskText,
      source: 'task_decomposition_primitive',
      objective_id: context.objective_id
    }
  ], mergedGate, {
    source: 'task_decomposition_primitive',
    objective_id: context.objective_id,
    run_id: context.run_id
  });
  const row = purified && Array.isArray(purified.rows) ? purified.rows[0] : null;
  const localDestructive = /(?:\bdisable\s+(?:all\s+)?guards?\b|\bbypass\b.*\b(?:guard|policy|safety)\b|\bself[\s_-]*terminate\b|\bexfiltrate\b|\bwipe\s+data\b)/i
    .test(String(taskText || ''));
  if (!row || typeof row !== 'object') {
    return {
      classification: localDestructive ? 'destructive_instruction' : 'unknown',
      decision: localDestructive ? 'blocked_destructive_local_pattern' : 'purification_missing',
      blocked: localDestructive,
      reason_codes: localDestructive
        ? ['heroic_echo_row_missing', 'local_destructive_pattern']
        : ['heroic_echo_row_missing']
    };
  }
  const blockedByDestructive = policy.gates.block_on_destructive === true
    && (
      String(row.classification || '') === 'destructive_instruction'
      || localDestructive
    );
  return {
    classification: localDestructive
      ? 'destructive_instruction'
      : String(row.classification || 'unknown'),
    decision: localDestructive
      ? 'blocked_destructive_local_pattern'
      : String(row.decision || 'unknown'),
    blocked: blockedByDestructive || row.blocked === true,
    reason_codes: Array.isArray(row.reason_codes)
      ? Array.from(new Set([
        ...row.reason_codes,
        ...(localDestructive ? ['local_destructive_pattern'] : [])
      ])).slice(0, 8)
      : (localDestructive ? ['local_destructive_pattern'] : [])
  };
}

function evaluateConstitutionGate(taskText: string, policy: AnyObj) {
  if (policy.gates.constitution_enabled !== true) {
    return {
      decision: 'ALLOW',
      risk: 'low',
      reasons: ['constitution_gate_disabled']
    };
  }
  try {
    const evaluated = evaluateDirectiveTask(String(taskText || ''));
    if (!evaluated || typeof evaluated !== 'object') {
      return {
        decision: 'ALLOW',
        risk: 'low',
        reasons: ['constitution_gate_unavailable']
      };
    }
    return {
      decision: String(evaluated.decision || 'ALLOW'),
      risk: String(evaluated.risk || 'low'),
      reasons: Array.isArray(evaluated.reasons) ? evaluated.reasons.slice(0, 8) : []
    };
  } catch {
    return {
      decision: 'ALLOW',
      risk: 'low',
      reasons: ['constitution_gate_error']
    };
  }
}

function dualitySignalForTask(goal: AnyObj, task: AnyObj) {
  if (typeof dualityEvaluate !== 'function') {
    return {
      enabled: false,
      indicator: {
        subtle_hint: 'duality_unavailable'
      }
    };
  }
  try {
    const signal = dualityEvaluate({
      lane: 'task_decomposition',
      source: 'task_decomposition_primitive',
      objective_id: goal.objective_id,
      goal_id: goal.goal_id,
      goal_text: goal.goal_text,
      task_id: task.micro_task_id,
      task_text: task.task_text,
      candidate_lane: task.route && task.route.lane
    }, {
      source: 'task_decomposition_primitive'
    });
    return signal && typeof signal === 'object'
      ? signal
      : {
        enabled: false,
        indicator: {
          subtle_hint: 'duality_signal_missing'
        }
      };
  } catch {
    return {
      enabled: false,
      indicator: {
        subtle_hint: 'duality_error'
      }
    };
  }
}

function buildMicroTasks(goal: AnyObj, policy: AnyObj, runId: string) {
  const rawSegments = recursiveDecompose(goal.goal_text, 0, policy, null);
  const segments = dedupeSegments(rawSegments, Number(policy.decomposition.max_micro_tasks || 96));
  const tasks = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const taskText = cleanText(seg.text, 1000);
    if (!taskText) continue;
    const microTaskId = `mt_${sha16(`${runId}|${i}|${taskText}`)}`;
    const capability = inferCapability(taskText);
    const constitution = evaluateConstitutionGate(taskText, policy);
    const heroic = evaluateHeroicGate(taskText, policy, {
      run_id: runId,
      task_id: microTaskId,
      objective_id: goal.objective_id
    });
    const lane = laneForTask(taskText, constitution, policy);
    const duality = dualitySignalForTask(goal, {
      micro_task_id: microTaskId,
      task_text: taskText,
      route: { lane }
    });
    const blockedByConstitution = policy.gates.block_on_constitution_deny === true
      && constitution.decision === 'DENY';
    const blocked = heroic.blocked === true || blockedByConstitution;
    const requiresManualReview = constitution.decision === 'MANUAL' || lane === policy.parallel.storm_lane;

    const minutes = estimateMinutes(taskText, policy);
    const profileId = `task_micro_${sha16(`${goal.goal_id}|${microTaskId}`)}`;

    const microTask = {
      micro_task_id: microTaskId,
      goal_id: goal.goal_id,
      objective_id: goal.objective_id,
      parent_id: seg.parent_id,
      depth: seg.depth,
      index: i,
      title: titleForTask(taskText),
      task_text: taskText,
      estimated_minutes: minutes,
      success_criteria: successCriteria(taskText),
      required_capability: capability.capability_id,
      profile_id: profileId,
      profile: {
        schema_id: 'task_micro_profile',
        schema_version: '1.0',
        profile_id: profileId,
        source: {
          source_type: capability.source_type,
          capability_id: capability.capability_id,
          objective_id: goal.objective_id,
          origin_lane: 'task_decomposition_primitive'
        },
        intent: {
          id: 'micro_task_execute',
          description: taskText,
          success_criteria: successCriteria(taskText)
        },
        execution: {
          adapter_kind: capability.adapter_kind,
          estimated_minutes: minutes,
          dry_run_default: true
        },
        routing: {
          preferred_lane: lane,
          requires_manual_review: requiresManualReview
        },
        governance: {
          heroic_echo: {
            classification: heroic.classification,
            decision: heroic.decision,
            reason_codes: heroic.reason_codes
          },
          constitution: {
            decision: constitution.decision,
            risk: constitution.risk,
            reasons: constitution.reasons
          }
        },
        attribution: {
          source_goal_id: goal.goal_id,
          source_goal_hash: sha16(goal.goal_text),
          creator_id: goal.creator_id,
          influence_score: 1,
          lineage: [goal.goal_id, microTaskId]
        },
        duality: {
          enabled: duality.enabled === true,
          score_trit: Number(duality.score_trit || 0),
          score_label: cleanText(duality.score_label || 'unknown', 40) || 'unknown',
          zero_point_harmony_potential: Number(duality.zero_point_harmony_potential || 0),
          recommended_adjustment: cleanText(duality.recommended_adjustment || '', 120) || null,
          indicator: duality.indicator && typeof duality.indicator === 'object'
            ? duality.indicator
            : { subtle_hint: 'duality_signal_absent' }
        }
      },
      route: {
        lane,
        parallel_group: i % Math.max(1, Number(policy.parallel.max_groups || 8)),
        parallel_priority: Number((1 / Math.max(1, minutes)).toFixed(4)),
        blocked,
        requires_manual_review: requiresManualReview
      },
      governance: {
        blocked,
        block_reasons: [
          ...(heroic.blocked ? ['heroic_echo_blocked'] : []),
          ...(blockedByConstitution ? ['constitution_denied'] : [])
        ],
        heroic_echo: heroic,
        constitution
      },
      duality: {
        enabled: duality.enabled === true,
        score_trit: Number(duality.score_trit || 0),
        score_label: cleanText(duality.score_label || 'unknown', 40) || 'unknown',
        zero_point_harmony_potential: Number(duality.zero_point_harmony_potential || 0),
        recommended_adjustment: cleanText(duality.recommended_adjustment || '', 120) || null,
        indicator: duality.indicator && typeof duality.indicator === 'object'
          ? duality.indicator
          : { subtle_hint: 'duality_signal_absent' }
      }
    };

    tasks.push(microTask);
  }

  // Ensure at least one human-lane candidate for crowd routing when requested by policy.
  const humanShare = tasks.length
    ? tasks.filter((row) => row.route && row.route.lane === policy.parallel.storm_lane).length / tasks.length
    : 0;
  if (tasks.length > 2 && humanShare < Number(policy.parallel.min_storm_share || 0)) {
    const best = tasks.find((row) => row.governance && row.governance.constitution
      && row.governance.constitution.decision !== 'DENY');
    if (best) {
      best.route.lane = policy.parallel.storm_lane;
      best.route.requires_manual_review = true;
      best.profile.routing.preferred_lane = policy.parallel.storm_lane;
      best.profile.routing.requires_manual_review = true;
    }
  }

  return tasks;
}

function ensurePassport(policy: AnyObj, goal: AnyObj) {
  if (policy.attribution.enabled !== true || policy.attribution.issue_passport !== true) return null;
  const actor = policy.attribution.actor || {};
  const issued = issuePassport({
    actor: actor.actor || 'task_decomposition_primitive',
    role: actor.role || 'execution',
    model: actor.model || 'task_decomposer',
    framework: actor.framework || 'openclaw',
    org: actor.org || 'protheus',
    tenant: actor.tenant || 'local',
    objective_id: goal.objective_id
  });
  if (!issued || issued.ok !== true || !issued.passport_id) return null;
  return String(issued.passport_id);
}

function emitPassportAction(policy: AnyObj, passportId: string | null, goal: AnyObj, task: AnyObj) {
  if (!passportId || policy.attribution.enabled !== true) return null;
  const action = appendAction({
    source: policy.attribution.passport_source || 'task_decomposition_primitive',
    passport_id: passportId,
    action: {
      action_type: 'task_micro_profile_emitted',
      objective_id: goal.objective_id,
      target: task.micro_task_id,
      status: task.governance && task.governance.blocked ? 'blocked' : 'ready',
      attempted: true,
      verified: task.governance && task.governance.blocked !== true,
      metadata: {
        goal_id: goal.goal_id,
        profile_id: task.profile_id,
        lane: task.route && task.route.lane,
        estimated_minutes: task.estimated_minutes,
        duality_score_trit: task.duality && Number(task.duality.score_trit || 0)
      }
    }
  });
  return action && action.ok === true
    ? {
      action_id: action.action_id || null,
      seq: action.seq || null,
      hash: action.hash || null
    }
    : null;
}

function persistProfiles(policy: AnyObj, runId: string, tasks: AnyObj[]) {
  if (policy.outputs.persist_profiles !== true) return [];
  const outPaths: string[] = [];
  for (const task of tasks) {
    const fp = path.join(policy.state.profiles_dir, `${task.profile_id}.json`);
    writeJsonAtomic(fp, {
      ...task.profile,
      decomposition: {
        run_id: runId,
        micro_task_id: task.micro_task_id,
        goal_id: task.goal_id
      }
    });
    outPaths.push(fp);
  }
  return outPaths;
}

function emitEvent(policy: AnyObj, row: AnyObj) {
  if (policy.outputs.emit_events !== true) return;
  appendJsonl(policy.state.events_path, row);
}

function emitIdeEvent(policy: AnyObj, row: AnyObj) {
  if (policy.outputs.emit_ide_events !== true) return;
  appendJsonl(policy.state.ide_events_path, row);
}

function emitObsidian(policy: AnyObj, row: AnyObj) {
  if (policy.outputs.emit_obsidian_projection !== true) return;
  appendJsonl(policy.state.obsidian_queue_path, row);
}

function emitQueues(policy: AnyObj, payload: AnyObj) {
  const queuedWeaver: AnyObj[] = [];
  const queuedStorm: AnyObj[] = [];
  for (const task of payload.micro_tasks) {
    const route = task.route || {};
    const weaverRow = {
      ts: nowIso(),
      type: 'task_micro_route_candidate',
      run_id: payload.run_id,
      goal_id: payload.goal.goal_id,
      objective_id: payload.goal.objective_id,
      micro_task_id: task.micro_task_id,
      profile_id: task.profile_id,
      lane: route.lane,
      parallel_group: route.parallel_group,
      parallel_priority: route.parallel_priority,
      blocked: route.blocked === true,
      requires_manual_review: route.requires_manual_review === true,
      shadow_only: payload.shadow_only === true,
      passport_id: payload.passport_id || null,
      duality_indicator: task.duality && task.duality.indicator ? task.duality.indicator : { subtle_hint: 'duality_signal_absent' },
      attribution: task.profile && task.profile.attribution ? task.profile.attribution : {}
    };
    appendJsonl(policy.state.weaver_queue_path, weaverRow);
    queuedWeaver.push(weaverRow);

    if (route.lane === policy.parallel.storm_lane && route.blocked !== true) {
      const stormRow = {
        ts: nowIso(),
        type: 'storm_micro_task_offer',
        run_id: payload.run_id,
        goal_id: payload.goal.goal_id,
        objective_id: payload.goal.objective_id,
        micro_task_id: task.micro_task_id,
        title: task.title,
        task_text: task.task_text,
        estimated_minutes: task.estimated_minutes,
        success_criteria: task.success_criteria,
        profile_id: task.profile_id,
        shadow_only: payload.shadow_only === true,
        passport_id: payload.passport_id || null,
        duality_indicator: task.duality && task.duality.indicator ? task.duality.indicator : { subtle_hint: 'duality_signal_absent' }
      };
      appendJsonl(policy.state.storm_queue_path, stormRow);
      queuedStorm.push(stormRow);
    }
  }
  return {
    weaver: queuedWeaver,
    storm: queuedStorm
  };
}

function summarizeTasks(tasks: AnyObj[], shadowOnly: boolean, applyExecuted: boolean) {
  const byLane: Record<string, number> = {};
  for (const row of tasks) {
    const lane = String(row.route && row.route.lane || 'unknown');
    byLane[lane] = Number(byLane[lane] || 0) + 1;
  }
  return {
    total_micro_tasks: tasks.length,
    ready: tasks.filter((row) => row.governance && row.governance.blocked !== true).length,
    blocked: tasks.filter((row) => row.governance && row.governance.blocked === true).length,
    manual_review: tasks.filter((row) => row.route && row.route.requires_manual_review === true).length,
    autonomous_lane: tasks.filter((row) => row.route && row.route.lane === 'autonomous_micro_agent').length,
    storm_lane: tasks.filter((row) => row.route && row.route.lane === 'storm_human_lane').length,
    lane_breakdown: byLane,
    shadow_only: shadowOnly,
    apply_executed: applyExecuted
  };
}

function cmdRun(args: AnyObj, dateStr: string, policyPath: string) {
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'task_decomposition_primitive', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }

  const goal = collectGoalInput(args, dateStr);
  if (!goal || !goal.goal_text) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'task_decomposition_primitive', error: 'goal_required' })}\n`);
    process.exit(1);
  }

  const runId = normalizeToken(args.run_id || args['run-id'] || '', 120)
    || `tdp_${dateStr}_${sha16(`${goal.goal_id}|${goal.goal_text.slice(0, 160)}`)}`;
  const applyRequested = toBool(args.apply, false);
  const applyExecuted = applyRequested && policy.allow_apply === true && policy.shadow_only !== true;
  const shadowOnly = policy.shadow_only === true || !applyExecuted;
  const tasks = buildMicroTasks(goal, policy, runId);
  const passportId = ensurePassport(policy, goal);

  for (const task of tasks) {
    const link = emitPassportAction(policy, passportId, goal, task);
    if (link) {
      task.attribution = {
        ...(task.attribution && typeof task.attribution === 'object' ? task.attribution : {}),
        passport_link: link
      };
      task.profile.attribution.passport_link = link;
      task.profile.attribution.passport_id = passportId;
    }
    if (typeof recordAttribution === 'function') {
      try {
        const attrOut = recordAttribution({
          source_type: 'task_decomposition_goal',
          source_id: goal.goal_id,
          source_url: goal.metadata && goal.metadata.source_url ? goal.metadata.source_url : null,
          creator_id: goal.creator_id || 'unknown_creator',
          creator_alias: goal.metadata && goal.metadata.creator_alias ? goal.metadata.creator_alias : null,
          creator_opt_in: goal.metadata && goal.metadata.creator_opt_in === true,
          license: goal.metadata && goal.metadata.license ? goal.metadata.license : 'unknown',
          objective_id: goal.objective_id,
          task_id: task.micro_task_id,
          run_id: runId,
          lane: task.route && task.route.lane ? task.route.lane : 'autonomous_micro_agent',
          weight: Number((1 / Math.max(1, Number(task.estimated_minutes || 1))).toFixed(6)),
          confidence: task.governance && task.governance.blocked === true ? 0.5 : 0.9,
          impact_score: task.governance && task.governance.blocked === true ? 0.1 : 0.7,
          influence_score: task.governance && task.governance.blocked === true ? 0.05 : 0.4,
          capability_id: task.required_capability
        }, {
          apply: false
        });
        if (attrOut && attrOut.ok === true) {
          task.profile.attribution.value_attribution_id = attrOut.attribution_id || null;
          task.profile.attribution.value_attribution_shadow_only = attrOut.shadow_only === true;
          task.attribution_record = {
            attribution_id: attrOut.attribution_id || null,
            influence_score: Number(attrOut.influence_score || 0),
            creator_id: attrOut.creator_id || null
          };
        }
      } catch {
        // Attribution lane is additive and must not block decomposition output.
      }
    }
  }

  const profilePaths = persistProfiles(policy, runId, tasks);
  const summary = summarizeTasks(tasks, shadowOnly, applyExecuted);
  const payload = {
    ok: true,
    type: 'task_decomposition_primitive',
    ts: nowIso(),
    date: dateStr,
    run_id: runId,
    policy_version: policy.version,
    policy_path: relPath(policyPath),
    shadow_only: shadowOnly,
    apply_requested: applyRequested,
    apply_executed: applyExecuted,
    dependencies: ['V3-DUAL-001', 'V3-ATTR-001'],
    goal,
    passport_id: passportId,
    summary,
    micro_tasks: tasks,
    profile_paths: profilePaths.map((fp) => relPath(fp))
  };

  const queueWrites = emitQueues(policy, payload);
  payload.summary.weaver_queue_enqueued = queueWrites.weaver.length;
  payload.summary.storm_queue_enqueued = queueWrites.storm.length;

  if (typeof registerDualityObservation === 'function') {
    for (const task of tasks) {
      if (!task.duality || task.duality.enabled !== true) continue;
      try {
        registerDualityObservation({
          lane: 'task_decomposition',
          source: 'task_decomposition_primitive',
          run_id: runId,
          task_id: task.micro_task_id,
          predicted_trit: Number(task.duality.score_trit || 0),
          observed_trit: task.governance && task.governance.blocked === true ? -1 : 1
        });
      } catch {
        // Best effort only.
      }
    }
  }

  const runPath = path.join(policy.state.runs_dir, `${dateStr}.json`);
  writeJsonAtomic(runPath, payload);
  writeJsonAtomic(policy.state.latest_path, payload);
  appendJsonl(policy.state.history_path, payload);
  writeContractReceipt(policy.state.receipts_path, {
    ts: payload.ts,
    type: 'task_decomposition_run',
    objective_id: goal.objective_id,
    status: shadowOnly ? 'shadow_only' : 'applied',
    summary: `micro_tasks=${summary.total_micro_tasks};blocked=${summary.blocked};storm=${summary.storm_lane}`,
    run_id: runId,
    passport_id: passportId,
    lane: 'task_decomposition'
  }, {
    attempted: true,
    verified: shadowOnly !== true
  });

  emitEvent(policy, {
    ts: nowIso(),
    type: 'task_decomposition_run_complete',
    run_id: runId,
    goal_id: goal.goal_id,
    objective_id: goal.objective_id,
    summary,
    shadow_only: shadowOnly,
    duality: {
      enabled: tasks.some((row) => row.duality && row.duality.enabled === true),
      avg_score_trit: tasks.length
        ? Number((tasks.reduce((sum, row) => sum + Number(row.duality && row.duality.score_trit || 0), 0) / tasks.length).toFixed(4))
        : 0
    }
  });

  for (const task of tasks) {
    emitIdeEvent(policy, {
      event: 'task_micro_profile_emitted',
      ts: nowIso(),
      run_id: runId,
      goal_id: goal.goal_id,
      objective_id: goal.objective_id,
      micro_task_id: task.micro_task_id,
      title: task.title,
      lane: task.route && task.route.lane,
      blocked: task.governance && task.governance.blocked === true,
      duality_indicator: task.duality && task.duality.indicator
        ? task.duality.indicator
        : { subtle_hint: 'duality_signal_absent' },
      zero_point_harmony_potential: task.duality ? Number(task.duality.zero_point_harmony_potential || 0) : 0
    });
  }

  emitObsidian(policy, {
    ts: nowIso(),
    run_id: runId,
    title: 'Task Decomposition Receipt',
    goal_id: goal.goal_id,
    objective_id: goal.objective_id,
    summary,
    shadow_only: shadowOnly
  });

  process.stdout.write(`${JSON.stringify({
    ...payload,
    run_path: relPath(runPath),
    latest_path: relPath(policy.state.latest_path)
  })}\n`);
}

function cmdStatus(args: AnyObj, dateArg: string, policyPath: string) {
  const policy = loadPolicy(policyPath);
  const fp = dateArg === 'latest'
    ? policy.state.latest_path
    : path.join(policy.state.runs_dir, `${dateArg}.json`);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'task_decomposition_status',
      error: 'status_missing',
      date: dateArg
    })}\n`);
    process.exit(1);
  }

  const weaverQueueRows = readJsonl(policy.state.weaver_queue_path);
  const stormQueueRows = readJsonl(policy.state.storm_queue_path);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'task_decomposition_status',
    date: payload.date || dateArg,
    run_id: payload.run_id || null,
    shadow_only: payload.shadow_only === true,
    summary: payload.summary || {},
    micro_tasks: Array.isArray(payload.micro_tasks) ? payload.micro_tasks.length : 0,
    latest_path: relPath(policy.state.latest_path),
    queue_sizes: {
      weaver_candidates: weaverQueueRows.length,
      storm_candidates: stormQueueRows.length
    }
  })}\n`);
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

  if (cmd === 'run') {
    cmdRun(args, toDate(args._[1]), policyPath);
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
  buildMicroTasks,
  collectGoalInput,
  summarizeTasks
};
