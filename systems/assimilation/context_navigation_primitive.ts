#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = process.env.CONTEXT_NAVIGATION_ROOT
  ? path.resolve(process.env.CONTEXT_NAVIGATION_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.CONTEXT_NAVIGATION_POLICY_PATH
  ? path.resolve(process.env.CONTEXT_NAVIGATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'context_navigation_primitive_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 280) {
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

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/assimilation/context_navigation_primitive.js run --input-json="{...}" [--policy=<path>] [--apply=1|0]');
  console.log('  node systems/assimilation/context_navigation_primitive.js status [--policy=<path>]');
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

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || fallbackRel, 500);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function parseJsonArg(raw: unknown, fallback: any = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function tokenize(v: unknown) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
}

function hashId(seed: string, prefix = 'ctx') {
  const digest = crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 12);
  return `${prefix}_${digest}`;
}

function defaultPolicy() {
  return {
    schema_id: 'context_navigation_primitive_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: true,
    recursion: {
      max_depth: 4,
      max_segments_per_depth: 10,
      max_selected_segments: 24,
      min_relevance_score: 1
    },
    context: {
      max_chars_per_segment: 360,
      max_total_chars: 64000
    },
    state: {
      latest_path: 'state/assimilation/context_navigation/latest.json',
      receipts_path: 'state/assimilation/context_navigation/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const recursion = raw.recursion && typeof raw.recursion === 'object' ? raw.recursion : {};
  const context = raw.context && typeof raw.context === 'object' ? raw.context : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    schema_id: base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    recursion: {
      max_depth: clampInt(recursion.max_depth, 1, 12, base.recursion.max_depth),
      max_segments_per_depth: clampInt(
        recursion.max_segments_per_depth,
        1,
        200,
        base.recursion.max_segments_per_depth
      ),
      max_selected_segments: clampInt(recursion.max_selected_segments, 1, 500, base.recursion.max_selected_segments),
      min_relevance_score: clampInt(recursion.min_relevance_score, 0, 100, base.recursion.min_relevance_score)
    },
    context: {
      max_chars_per_segment: clampInt(context.max_chars_per_segment, 80, 4000, base.context.max_chars_per_segment),
      max_total_chars: clampInt(context.max_total_chars, 1024, 1000000, base.context.max_total_chars)
    },
    state: {
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function gatherContextRows(input: AnyObj, policy: AnyObj) {
  const rows: string[] = [];
  if (Array.isArray(input.context_rows)) {
    for (const row of input.context_rows) {
      const text = cleanText(row, policy.context.max_total_chars);
      if (text) rows.push(text);
    }
  }
  if (input.context_text != null) {
    const text = cleanText(input.context_text, policy.context.max_total_chars);
    if (text) rows.push(text);
  }
  if (Array.isArray(input.context_files)) {
    for (const rawPath of input.context_files) {
      const fpRaw = cleanText(rawPath, 500);
      if (!fpRaw) continue;
      const fp = path.isAbsolute(fpRaw) ? fpRaw : path.join(ROOT, fpRaw);
      if (!fs.existsSync(fp)) continue;
      const text = cleanText(fs.readFileSync(fp, 'utf8'), policy.context.max_total_chars);
      if (text) rows.push(text);
    }
  }
  return rows;
}

function splitSegments(text: string, maxChars: number) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((line) => cleanText(line, maxChars))
    .filter(Boolean);
  if (lines.length) return lines;
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((line) => cleanText(line, maxChars))
    .filter(Boolean);
}

function scoreSegment(segment: string, objectiveTokens: string[]) {
  if (!segment) return 0;
  const tokens = tokenize(segment);
  let score = 0;
  for (const tok of objectiveTokens) {
    if (tokens.includes(tok)) score += 2;
    else if (segment.toLowerCase().includes(tok)) score += 1;
  }
  return score;
}

function runContextNavigation(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(opts.policyPath || opts.policy_path || DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'context_navigation_primitive',
      error: 'policy_disabled'
    };
  }

  const ts = nowIso();
  const apply = toBool(opts.apply, false);
  const objective = cleanText(inputRaw.objective || inputRaw.task || 'unknown_objective', 280) || 'unknown_objective';
  const objectiveTokens = tokenize(objective);
  const rawRows = gatherContextRows(inputRaw, policy).slice(0, 512);

  const navigationSteps: AnyObj[] = [];
  let current = rawRows.map((text, idx) => ({
    id: `raw_${idx + 1}`,
    text,
    score: scoreSegment(text, objectiveTokens),
    depth: 0
  }));

  navigationSteps.push({
    op: 'ingest',
    depth: 0,
    input_rows: rawRows.length,
    objective_tokens: objectiveTokens.slice(0, 32)
  });

  for (let depth = 1; depth <= policy.recursion.max_depth; depth += 1) {
    const expanded: AnyObj[] = [];
    for (const row of current) {
      const segments = splitSegments(row.text, policy.context.max_chars_per_segment);
      for (const segment of segments) {
        expanded.push({
          id: hashId(`${depth}|${row.id}|${segment}`),
          parent_id: row.id,
          text: segment,
          score: scoreSegment(segment, objectiveTokens),
          depth
        });
      }
    }

    expanded.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    current = expanded
      .filter((row) => Number(row.score || 0) >= policy.recursion.min_relevance_score)
      .slice(0, policy.recursion.max_segments_per_depth);

    navigationSteps.push({
      op: 'decompose_filter',
      depth,
      produced: expanded.length,
      selected: current.length,
      min_relevance_score: policy.recursion.min_relevance_score
    });

    if (!current.length) break;
  }

  const selected = current.slice(0, policy.recursion.max_selected_segments).map((row, idx) => ({
    segment_id: row.id,
    rank: idx + 1,
    depth: row.depth,
    relevance_score: Number(row.score || 0),
    excerpt: cleanText(row.text, 220)
  }));

  const inputChars = rawRows.reduce((acc, row) => acc + String(row || '').length, 0);
  const selectedChars = selected.reduce((acc, row) => acc + String(row.excerpt || '').length, 0);
  const reductionRatio = inputChars > 0 ? Number((1 - (selectedChars / inputChars)).toFixed(6)) : 0;

  const out = {
    ok: true,
    type: 'context_navigation_primitive',
    ts,
    shadow_only: policy.shadow_only === true,
    apply_requested: apply,
    objective,
    profile_id: hashId(`${objective}|${ts}`, 'ctx_nav'),
    navigation_steps: navigationSteps,
    selected_segments: selected,
    executor_profile: {
      schema_id: 'context_navigation_profile',
      schema_version: '1.0',
      objective,
      operations: [
        { op: 'ingest_context', lane: 'universal_execution_primitive' },
        { op: 'recursive_decompose', max_depth: policy.recursion.max_depth },
        { op: 'score_filter', metric: 'objective_relevance' },
        { op: 'emit_condensed_context', max_segments: policy.recursion.max_selected_segments }
      ],
      token_bloat_guard: {
        input_chars: inputChars,
        output_chars: selectedChars,
        reduction_ratio: reductionRatio
      }
    },
    metrics: {
      input_rows: rawRows.length,
      input_chars: inputChars,
      selected_count: selected.length,
      selected_chars: selectedChars,
      reduction_ratio: reductionRatio
    },
    policy: {
      path: rel(policy.policy_path || DEFAULT_POLICY_PATH),
      version: policy.schema_version
    }
  };

  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.receipts_path, out);
  return out;
}

function status(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  return {
    ok: true,
    type: 'context_navigation_status',
    latest: readJson(policy.state.latest_path, null)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'run', 32) || 'run';
  try {
    if (cmd === 'status') {
      process.stdout.write(`${JSON.stringify(status(args))}\n`);
      return;
    }
    if (cmd === 'run') {
      const input = parseJsonArg(args['input-json'] || args.input_json || '{}', {});
      const out = runContextNavigation(input, {
        policyPath: args.policy,
        apply: args.apply
      });
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exit(out && out.ok === true ? 0 : 1);
      return;
    }
    if (cmd === 'help') {
      usage();
      return;
    }
    throw new Error(`unknown_command:${cmd}`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'context_navigation_primitive',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'context_navigation_failed', 220)
    })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  loadPolicy,
  runContextNavigation
};
