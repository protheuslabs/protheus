#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const { detectCandidate } = require('./proactive_assimilation.js');

type AnyObj = Record<string, any>;

type SuggestionPolicy = {
  version: string,
  enabled: boolean,
  tutorial_mode_default_new_users: boolean,
  cooldown_seconds: number,
  max_suggestions_per_hour: number,
  core5_review_required: boolean,
  triggers: {
    drift_keywords: string[],
    planning_keywords: string[],
    external_detection_enabled: boolean,
    first_use_orchestration_hint: boolean
  }
};

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.PROTHEUS_CLI_SUGGESTION_POLICY_PATH
  ? path.resolve(process.env.PROTHEUS_CLI_SUGGESTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'cli_suggestion_policy.json');
const STATE_DIR = process.env.PROTHEUS_CLI_SUGGESTION_STATE_DIR
  ? path.resolve(process.env.PROTHEUS_CLI_SUGGESTION_STATE_DIR)
  : path.join(ROOT, 'state', 'tools', 'cli_suggestions');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const RECEIPTS_PATH = path.join(STATE_DIR, 'receipts.jsonl');
const PERSONA_CLI = path.join(ROOT, 'systems', 'personas', 'cli.js');
const PROTHEUS_BIN = path.join(ROOT, 'bin', 'protheus');

const CORE_FIVE = ['vikram_menon', 'rohan_kapoor', 'priya_venkatesh', 'aarav_singh', 'li_wei'];

function usage() {
  console.log('Usage:');
  console.log('  node systems/tools/cli_suggestion_engine.js suggest --cmd=<command> [--argv-json="{\"args\":[...]}"] [--text="..."] [--auto-confirm=1|0] [--auto-reject=1|0] [--dry-run=1] [--json=1] [--origin=main_cli]');
  console.log('  node systems/tools/cli_suggestion_engine.js tutorial [status|on|off] [--json=1]');
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 400) {
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
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(raw)) return false;
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

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx >= 0) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    const key = token.slice(2);
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

function parseJsonText(raw: unknown): AnyObj | null {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
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
  const tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function parseCommandTokens(command: string) {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function normalizeList(src: unknown, fallback: string[]) {
  if (!Array.isArray(src)) return fallback;
  return Array.from(new Set(src.map((v) => normalizeToken(v, 120)).filter(Boolean)));
}

function defaultPolicy(): SuggestionPolicy {
  return {
    version: '1.0',
    enabled: true,
    tutorial_mode_default_new_users: true,
    cooldown_seconds: 30,
    max_suggestions_per_hour: 20,
    core5_review_required: true,
    triggers: {
      drift_keywords: ['drift', 'regression', 'violation', 'fail', 'degrade', 'downgrade'],
      planning_keywords: ['plan', 'sprint', 'next', 'roadmap', 'backlog'],
      external_detection_enabled: true,
      first_use_orchestration_hint: true
    }
  };
}

function loadPolicy(): SuggestionPolicy {
  const raw = readJson(POLICY_PATH, {});
  const base = defaultPolicy();
  const triggers = raw.triggers && typeof raw.triggers === 'object' ? raw.triggers : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    tutorial_mode_default_new_users: raw.tutorial_mode_default_new_users !== false,
    cooldown_seconds: clampInt(raw.cooldown_seconds, 0, 3600, base.cooldown_seconds),
    max_suggestions_per_hour: clampInt(raw.max_suggestions_per_hour, 1, 500, base.max_suggestions_per_hour),
    core5_review_required: raw.core5_review_required !== false,
    triggers: {
      drift_keywords: normalizeList(triggers.drift_keywords, base.triggers.drift_keywords),
      planning_keywords: normalizeList(triggers.planning_keywords, base.triggers.planning_keywords),
      external_detection_enabled: triggers.external_detection_enabled !== false,
      first_use_orchestration_hint: triggers.first_use_orchestration_hint !== false
    }
  };
}

function defaultState() {
  return {
    tutorial_mode: null,
    command_counts: {},
    recent_actions: [],
    suggestion_history: []
  };
}

function loadState() {
  return readJson(STATE_PATH, defaultState());
}

function saveState(state: AnyObj) {
  writeJsonAtomic(STATE_PATH, state);
}

function pushRecentAction(state: AnyObj, action: AnyObj) {
  const rows = Array.isArray(state.recent_actions) ? state.recent_actions : [];
  rows.push(action);
  state.recent_actions = rows.slice(-40);
}

function recordSuggestionHistory(state: AnyObj, row: AnyObj) {
  const rows = Array.isArray(state.suggestion_history) ? state.suggestion_history : [];
  rows.push(row);
  const cutoff = Date.now() - (1000 * 60 * 60 * 24);
  state.suggestion_history = rows
    .filter((item) => Date.parse(String(item.ts || '')) >= cutoff)
    .slice(-400);
}

function effectiveTutorialMode(policy: SuggestionPolicy, state: AnyObj) {
  const envMode = normalizeToken(process.env.PROTHEUS_TUTORIAL_MODE || '', 20);
  if (envMode === 'on' || envMode === 'true' || envMode === '1') return true;
  if (envMode === 'off' || envMode === 'false' || envMode === '0') return false;
  if (typeof state.tutorial_mode === 'boolean') return state.tutorial_mode;
  return policy.tutorial_mode_default_new_users === true;
}

function shouldThrottle(policy: SuggestionPolicy, state: AnyObj) {
  const history = Array.isArray(state.suggestion_history) ? state.suggestion_history : [];
  const now = Date.now();
  const last = history.length ? Date.parse(String(history[history.length - 1].ts || '')) : NaN;
  if (Number.isFinite(last) && (now - last) < (Number(policy.cooldown_seconds || 0) * 1000)) {
    return {
      throttle: true,
      reason: 'cooldown_active'
    };
  }
  const oneHour = now - (60 * 60 * 1000);
  const inHour = history.filter((row) => {
    const ts = Date.parse(String(row.ts || ''));
    return Number.isFinite(ts) && ts >= oneHour;
  }).length;
  if (inHour >= Number(policy.max_suggestions_per_hour || 20)) {
    return {
      throttle: true,
      reason: 'hourly_cap_reached'
    };
  }
  return {
    throttle: false,
    reason: 'ok'
  };
}

function buildContextText(cmd: string, args: string[], explicitText: string) {
  if (explicitText) return explicitText;
  return cleanText([cmd, ...args].join(' '), 4000);
}

function detectSuggestion(cmd: string, args: string[], text: string, state: AnyObj, policy: SuggestionPolicy) {
  const cmdNorm = normalizeToken(cmd, 60);
  const raw = String(text || '');
  const lower = raw.toLowerCase();

  if (policy.triggers.external_detection_enabled) {
    const external = detectCandidate(raw);
    if (external && external.detected && external.target) {
      return {
        detected: true,
        trigger: 'external_tool',
        command: `protheus assimilate ${external.target}`,
        explanation: `I noticed you using ${external.label || external.target}. Assimilation can convert it into a governed sprint prompt.`,
        target: external.target
      };
    }
  }

  const hasDrift = policy.triggers.drift_keywords.some((kw) => kw && lower.includes(kw));
  if (hasDrift || ['drift', 'inversion', 'autogenesis'].includes(cmdNorm)) {
    return {
      detected: true,
      trigger: 'drift_signal',
      command: 'protheus lens vikram "Review this drift signal before merge."',
      explanation: 'I noticed drift-like signals. Vikram can run a safety-focused review before changes proceed.',
      target: null
    };
  }

  const hasPlanning = policy.triggers.planning_keywords.some((kw) => kw && lower.includes(kw));
  if (hasPlanning) {
    return {
      detected: true,
      trigger: 'planning_intent',
      command: 'protheus orchestrate meeting "Plan next sprint" --dry-run=1',
      explanation: 'This looks like planning context. A deterministic orchestration meeting can capture options and arbitration.',
      target: null
    };
  }

  if (policy.triggers.first_use_orchestration_hint) {
    const counts = state.command_counts && typeof state.command_counts === 'object' ? state.command_counts : {};
    const orchestrateCount = Number(counts.orchestrate || 0);
    if (orchestrateCount === 0 && ['status', 'toolkit', 'research', 'lens'].includes(cmdNorm)) {
      return {
        detected: true,
        trigger: 'first_use_orchestration_hint',
        command: 'protheus orchestrate meeting "Plan next sprint" --dry-run=1',
        explanation: 'New to orchestration? This command previews a deterministic planning meeting with Core-5 arbitration.',
        target: null
      };
    }
  }

  return {
    detected: false,
    trigger: 'none',
    command: null,
    explanation: null,
    target: null
  };
}

function preparePersonaSandbox() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-cli-suggestion-personas-'));
  const srcPersonasDir = path.join(ROOT, 'personas');
  const dstPersonasDir = path.join(tmpRoot, 'personas');
  fs.mkdirSync(dstPersonasDir, { recursive: true });
  if (fs.existsSync(path.join(srcPersonasDir, 'organization'))) {
    fs.cpSync(path.join(srcPersonasDir, 'organization'), path.join(dstPersonasDir, 'organization'), { recursive: true });
  }
  for (const personaId of CORE_FIVE) {
    const src = path.join(srcPersonasDir, personaId);
    const dst = path.join(dstPersonasDir, personaId);
    if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
  }
  return tmpRoot;
}

function runCoreFiveSafetyReview(suggestion: AnyObj, contextText: string) {
  if (!fs.existsSync(PERSONA_CLI)) {
    return {
      ok: false,
      error: 'persona_cli_missing'
    };
  }

  const query = [
    'Light safety review for proactive CLI suggestion.',
    `Suggestion command: ${suggestion.command}`,
    `Trigger: ${suggestion.trigger}`,
    `Explanation: ${suggestion.explanation}`,
    `Context: ${cleanText(contextText, 500)}`,
    'Respond with deterministic approval guidance.'
  ].join('\n');

  const sandboxRoot = preparePersonaSandbox();
  const run = spawnSync(process.execPath, [
    PERSONA_CLI,
    'all',
    query,
    '--schema=json',
    '--context-budget-mode=trim',
    '--max-context-tokens=900'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 25 * 1024 * 1024,
    env: {
      ...process.env,
      OPENCLAW_WORKSPACE: sandboxRoot
    }
  });

  try {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {}

  const payload = parseJsonText(run.stdout);
  if (Number.isFinite(run.status) && Number(run.status) === 0 && payload) {
    return {
      ok: true,
      winner: cleanText(payload.winner || payload?.arbitration?.winner || '', 120),
      disagreement: payload.disagreement === true,
      arbitration_rule: cleanText(payload?.arbitration?.rule || '', 220),
      suggested_resolution: cleanText(payload.suggested_resolution || '', 600),
      confidence: Number(payload?.persona_outputs?.[0]?.confidence || 0)
    };
  }

  return {
    ok: false,
    error: cleanText(run.stderr || run.stdout || 'core5_safety_review_failed', 500)
  };
}

async function askYesNo(promptText: string) {
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${promptText} `, (value) => resolve(String(value || '').trim()));
  });
  rl.close();
  const norm = answer.toLowerCase();
  if (['y', 'yes'].includes(norm)) return true;
  if (['n', 'no'].includes(norm)) return false;
  return null;
}

function appendCorrespondenceLog(personaId: string, entry: string) {
  const filePath = path.join(ROOT, 'personas', personaId, 'correspondence.md');
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      persona_id: personaId,
      reason: 'correspondence_file_missing'
    };
  }
  const base = fs.readFileSync(filePath, 'utf8').replace(/\s+$/, '');
  fs.writeFileSync(filePath, `${base}\n${entry}\n`, 'utf8');
  return {
    ok: true,
    persona_id: personaId,
    correspondence_path: path.relative(ROOT, filePath).replace(/\\/g, '/')
  };
}

function appendPersonaFeed(personaId: string, snippet: string, dryRun = false) {
  if (!fs.existsSync(PERSONA_CLI)) {
    return {
      ok: false,
      persona_id: personaId,
      reason: 'persona_cli_missing'
    };
  }
  const args = [
    PERSONA_CLI,
    'feed',
    personaId,
    snippet,
    '--source=cli_suggestion_engine',
    '--tags=suggestion,tutorial'
  ];
  if (dryRun) args.push('--dry-run=1');

  const run = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  const payload = parseJsonText(run.stdout);
  return {
    ok: Number.isFinite(run.status) && Number(run.status) === 0,
    persona_id: personaId,
    payload: payload || null,
    reason: Number.isFinite(run.status) && Number(run.status) === 0
      ? null
      : cleanText(run.stderr || run.stdout || 'feed_append_failed', 300)
  };
}

function runSuggestedCommand(command: string) {
  const tokens = parseCommandTokens(command);
  if (!tokens.length || normalizeToken(tokens[0], 30) !== 'protheus') {
    return {
      ok: false,
      error: 'unsupported_suggested_command'
    };
  }
  const run = spawnSync(PROTHEUS_BIN, tokens.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024,
    env: {
      ...process.env,
      PROTHEUS_SUGGESTION_ACTIVE: '1',
      PROTHEUS_PROACTIVE_ASSIMILATE: '0'
    }
  });
  const payload = parseJsonText(run.stdout) || parseJsonText(run.stderr);
  return {
    ok: Number.isFinite(run.status) && Number(run.status) === 0,
    status: Number.isFinite(run.status) ? Number(run.status) : 1,
    payload: payload || null,
    stdout_preview: cleanText(run.stdout, 1000),
    stderr_preview: cleanText(run.stderr, 1000)
  };
}

async function cmdSuggest(args: AnyObj) {
  const policy = loadPolicy();
  const state = loadState();
  const dryRun = toBool(args['dry-run'] ?? args.dry_run, false);
  const forceJson = toBool(args.json, false);

  const cmd = normalizeToken(args.cmd || '', 80);
  const argvJson = parseJsonText(args['argv-json'] || args.argv_json || null);
  const cmdArgs = Array.isArray(argvJson?.args) ? argvJson.args.map((row: unknown) => cleanText(row, 240)) : [];
  const text = buildContextText(cmd, cmdArgs, cleanText(args.text || '', 4000));

  const response: AnyObj = {
    ok: true,
    type: 'cli_suggestion',
    ts: nowIso(),
    origin: cleanText(args.origin || 'main_cli', 40),
    tutorial_mode_enabled: false,
    skipped: false,
    skip_reason: null,
    context: {
      cmd,
      args: cmdArgs,
      text: cleanText(text, 500)
    },
    suggestion: null,
    core5_review: null,
    decision: {
      prompted: false,
      confirmed: false,
      mode: 'none'
    },
    execution: null,
    logs: {
      correspondence: [],
      feed: []
    }
  };

  if (!policy.enabled) {
    response.skipped = true;
    response.skip_reason = 'policy_disabled';
    if (forceJson) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return response;
  }

  if (process.env.PROTHEUS_SUGGESTION_ACTIVE === '1') {
    response.skipped = true;
    response.skip_reason = 'suggestion_recursion_guard';
    if (forceJson) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return response;
  }

  const tutorialMode = effectiveTutorialMode(policy, state);
  response.tutorial_mode_enabled = tutorialMode;
  if (!tutorialMode) {
    response.skipped = true;
    response.skip_reason = 'tutorial_mode_off';
    if (forceJson) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return response;
  }

  const throttle = shouldThrottle(policy, state);
  if (throttle.throttle) {
    response.skipped = true;
    response.skip_reason = throttle.reason;
    if (forceJson) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return response;
  }

  const skipCmds = new Set(['assimilate', 'research', 'tutorial', 'list', 'help', '--help', '-h']);
  if (!cmd || skipCmds.has(cmd)) {
    response.skipped = true;
    response.skip_reason = !cmd ? 'no_command' : `skip_command:${cmd}`;
    if (forceJson) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return response;
  }

  const counts = state.command_counts && typeof state.command_counts === 'object' ? state.command_counts : {};
  counts[cmd] = Number(counts[cmd] || 0) + 1;
  state.command_counts = counts;
  pushRecentAction(state, {
    ts: nowIso(),
    cmd,
    args: cmdArgs.slice(0, 8)
  });

  const suggestion = detectSuggestion(cmd, cmdArgs, text, state, policy);
  if (!suggestion.detected) {
    response.skipped = true;
    response.skip_reason = 'no_trigger_match';
    saveState(state);
    if (forceJson) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return response;
  }

  response.suggestion = suggestion;

  const review = policy.core5_review_required
    ? runCoreFiveSafetyReview(suggestion, text)
    : { ok: true, winner: 'policy_bypass', disagreement: false, arbitration_rule: 'none', suggested_resolution: 'n/a', confidence: 1 };

  response.core5_review = {
    ok: review.ok === true,
    winner: review.winner || null,
    disagreement: review.disagreement === true,
    arbitration_rule: review.arbitration_rule || null,
    suggested_resolution: review.suggested_resolution || null,
    confidence: Number(review.confidence || 0),
    error: review.ok ? null : review.error || 'core5_review_failed'
  };

  if (review.ok !== true) {
    response.skipped = true;
    response.skip_reason = 'core5_review_failed';
    recordSuggestionHistory(state, {
      ts: nowIso(),
      trigger: suggestion.trigger,
      command: suggestion.command,
      outcome: 'blocked_core5'
    });
    saveState(state);
    appendJsonl(RECEIPTS_PATH, {
      ts: nowIso(),
      type: 'cli_suggestion',
      cmd,
      trigger: suggestion.trigger,
      outcome: 'blocked_core5'
    });
    if (forceJson) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return response;
  }

  const promptText = `Would you like to run \`${suggestion.command}\`? (y/n) — ${suggestion.explanation}`;

  let confirmed: boolean | null = null;
  if (toBool(args['auto-confirm'] ?? args.auto_confirm, false)) {
    confirmed = true;
    response.decision.mode = 'auto_confirm';
  } else if (toBool(args['auto-reject'] ?? args.auto_reject, false)) {
    confirmed = false;
    response.decision.mode = 'auto_reject';
  } else if (process.stdin.isTTY) {
    response.decision.prompted = true;
    response.decision.mode = 'interactive';
    process.stdout.write(`${promptText}\n`);
    confirmed = await askYesNo(promptText);
  } else {
    response.decision.mode = 'non_interactive_default_reject';
    confirmed = false;
  }

  response.decision.confirmed = confirmed === true;

  const note = cleanText(
    `CLI suggestion trigger=${suggestion.trigger} cmd=${cmd} suggested=${suggestion.command} confirmed=${confirmed === true ? 'yes' : 'no'} origin=${response.origin}`,
    420
  );

  if (!dryRun) {
    const ts = nowIso().slice(0, 10);
    const correspondenceEntry = [
      '',
      `## ${ts} - Re: cli suggestion`,
      '',
      note,
      `Core-5 winner: ${review.winner || 'n/a'}.`,
      ''
    ].join('\n');
    for (const personaId of CORE_FIVE) {
      response.logs.correspondence.push(appendCorrespondenceLog(personaId, correspondenceEntry));
    }
  }

  for (const personaId of CORE_FIVE) {
    response.logs.feed.push(appendPersonaFeed(personaId, note, dryRun));
  }

  if (confirmed === true) {
    response.execution = runSuggestedCommand(suggestion.command);
  }

  const outcome = confirmed === true
    ? (response.execution && response.execution.ok ? 'accepted_executed' : 'accepted_failed')
    : 'declined';

  recordSuggestionHistory(state, {
    ts: nowIso(),
    trigger: suggestion.trigger,
    command: suggestion.command,
    outcome
  });
  saveState(state);

  appendJsonl(RECEIPTS_PATH, {
    ts: nowIso(),
    type: 'cli_suggestion',
    origin: response.origin,
    cmd,
    trigger: suggestion.trigger,
    suggested_command: suggestion.command,
    confirmed: confirmed === true,
    outcome
  });

  if (forceJson) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  }
  return response;
}

function cmdTutorial(args: AnyObj) {
  const policy = loadPolicy();
  const state = loadState();
  const sub = normalizeToken(args._[1] || 'status', 30) || 'status';
  const forceJson = toBool(args.json, false);

  if (sub === 'on') {
    state.tutorial_mode = true;
    saveState(state);
  } else if (sub === 'off') {
    state.tutorial_mode = false;
    saveState(state);
  }

  const payload = {
    ok: true,
    type: 'cli_tutorial_mode',
    ts: nowIso(),
    mode: effectiveTutorialMode(policy, state) ? 'on' : 'off',
    explicit_state: typeof state.tutorial_mode === 'boolean' ? state.tutorial_mode : null,
    default_new_user_mode: policy.tutorial_mode_default_new_users === true
  };

  if (forceJson || sub !== 'status') {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`Tutorial mode: ${payload.mode}\n`);
  }
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'suggest', 40) || 'suggest';
  if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'suggest') {
    await cmdSuggest(args);
    return;
  }
  if (cmd === 'tutorial') {
    cmdTutorial(args);
    return;
  }
  process.stderr.write(`${JSON.stringify({ ok: false, type: 'cli_suggestion', error: `unknown_command:${cmd}` }, null, 2)}\n`);
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      type: 'cli_suggestion',
      error: cleanText(err && err.message, 300)
    }, null, 2)}\n`);
    process.exit(1);
  });
}

module.exports = {
  detectSuggestion,
  effectiveTutorialMode,
  cmdSuggest,
  cmdTutorial
};
