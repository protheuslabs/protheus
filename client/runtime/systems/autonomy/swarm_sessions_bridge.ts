#!/usr/bin/env node
'use strict';

// Layer ownership: client/runtime/systems/autonomy (thin bridge over core/layer0/ops swarm-runtime).
// Purpose: compatibility surface for OpenClaw-style sessions_* swarm operations.

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const OPS_WRAPPER = path.join(
  ROOT,
  'client',
  'runtime',
  'systems',
  'ops',
  'run_protheus_ops.js'
);
const DEFAULT_STATE_PATH = path.join(ROOT, 'local', 'state', 'ops', 'swarm_runtime', 'latest.json');

function parseArgs(argv) {
  const out = { _: [] };
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

function normalizedOptions(options) {
  if (options && typeof options === 'object' && !Array.isArray(options)) return options;
  return {};
}

function parseLastJson(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

function statePath(parsed) {
  const explicit = String(parsed['state-path'] || parsed.state_path || '').trim();
  return explicit || DEFAULT_STATE_PATH;
}

function asInt(value, fallback, min = 0) {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function asFloat(value, fallback, min = 0, max = 1) {
  const parsed = Number.parseFloat(String(value == null ? '' : value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function asBool(value) {
  if (value === true) return true;
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return false;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function cleanString(value) {
  return String(value == null ? '' : value).trim();
}

function sessionIdFromKey(value) {
  const raw = cleanString(value);
  if (!raw) return '';
  if (!raw.includes(':')) return raw;
  const parts = raw.split(':').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return raw;
  return parts[parts.length - 1];
}

function asSessionKey(sessionId) {
  const id = cleanString(sessionId);
  if (!id) return '';
  return `agent:main:subagent:${id}`;
}

function execOps(args, env = {}) {
  const run = spawnSync(process.execPath, [OPS_WRAPPER].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const status = Number.isFinite(Number(run.status)) ? Number(run.status) : 1;
  return {
    status,
    stdout: String(run.stdout || ''),
    stderr: String(run.stderr || ''),
    payload: parseLastJson(run.stdout),
  };
}

function printOpsOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function requireOk(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label}_failed:status=${result.status}:${result.stderr || result.stdout}`);
  }
  if (!result.payload || result.payload.ok !== true) {
    throw new Error(`${label}_invalid_payload`);
  }
  return result.payload;
}

function normalizeSpawnPayload(payload) {
  const sessionId =
    (payload && payload.payload && payload.payload.session_id) ||
    (payload && payload.session_id) ||
    '';
  const toolAccess =
    (payload
      && payload.payload
      && payload.payload.session_state
      && payload.payload.session_state.tool_access)
    || ['sessions_spawn', 'sessions_send', 'sessions_receive', 'sessions_ack', 'sessions_query', 'sessions_state', 'sessions_tick'];
  const toolManifest =
    (payload
      && payload.payload
      && payload.payload.session_state
      && payload.payload.session_state.tool_manifest)
    || null;
  return {
    ok: true,
    type: 'sessions_spawn',
    session_id: sessionId,
    session_key: asSessionKey(sessionId),
    tool_access: Array.isArray(toolAccess) ? toolAccess : [],
    tool_manifest: toolManifest,
    payload,
  };
}

function normalizeSendPayload(payload) {
  return {
    ok: true,
    type: 'sessions_send',
    message_id: payload.message_id || null,
    delivery: payload.delivery || null,
    attempts: payload.attempts || null,
    payload,
  };
}

function normalizeReceivePayload(payload, sessionId) {
  return {
    ok: true,
    type: 'sessions_receive',
    session_id: sessionId,
    session_key: asSessionKey(sessionId),
    message_count: payload.message_count || 0,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    payload,
  };
}

function normalizeStatePayload(payload, sessionId) {
  return {
    ok: true,
    type: 'sessions_state',
    session_id: sessionId,
    session_key: asSessionKey(sessionId),
    payload,
  };
}

function sessionsSpawn(options = {}) {
  const parsed = normalizedOptions(options);
  const args = ['swarm-runtime', 'spawn'];
  const task = cleanString(
    parsed.task || parsed.objective || parsed.prompt || parsed.message || 'swarm-session-task'
  );
  args.push(`--task=${task}`);

  const parent = sessionIdFromKey(
    parsed.session_id || parsed.sessionId || parsed.parent_session_id || parsed.parentSessionId
  );
  if (parent) args.push(`--session-id=${parent}`);

  if (asBool(parsed.recursive)) args.push('--recursive=1');
  if (parsed.levels != null) args.push(`--levels=${asInt(parsed.levels, 2, 1)}`);
  if (parsed.max_depth != null || parsed.maxDepth != null) {
    args.push(`--max-depth=${asInt(parsed.max_depth ?? parsed.maxDepth, 8, 1)}`);
  }

  const tokenBudget = cleanString(
    parsed.token_budget
      ?? parsed['token-budget']
      ?? parsed.max_tokens
      ?? parsed.maxTokens
      ?? parsed['max-tokens']
  );
  if (tokenBudget) args.push(`--token-budget=${asInt(tokenBudget, 1, 1)}`);
  const tokenWarningAt = cleanString(parsed.token_warning_at ?? parsed['token-warning-at']);
  if (tokenWarningAt) args.push(`--token-warning-at=${asFloat(tokenWarningAt, 0.8, 0, 1)}`);
  const budgetMode = cleanString(parsed.on_budget_exhausted ?? parsed['on-budget-exhausted']).toLowerCase();
  if (budgetMode === 'fail' || budgetMode === 'warn' || budgetMode === 'compact') {
    args.push(`--on-budget-exhausted=${budgetMode}`);
  } else if (tokenBudget) {
    // Fail-closed by default whenever a budget is explicitly requested.
    args.push('--on-budget-exhausted=fail');
  }
  if (parsed.adaptive_complexity != null || parsed['adaptive-complexity'] != null) {
    args.push(`--adaptive-complexity=${asBool(parsed.adaptive_complexity ?? parsed['adaptive-complexity']) ? 1 : 0}`);
  }

  const role = cleanString(parsed.agentRole || parsed.role);
  if (role) args.push(`--role=${role}`);
  const label = cleanString(parsed.agentLabel || parsed.agent_label || parsed.label);
  if (label) args.push(`--agent-label=${label}`);
  const capabilities = cleanString(parsed.capabilities);
  if (capabilities) args.push(`--capabilities=${capabilities}`);

  const sessionType = cleanString(parsed.sessionType || parsed.session_type).toLowerCase();
  if (sessionType === 'persistent' || sessionType === 'background') {
    args.push(`--execution-mode=${sessionType}`);
    const ttlMinutes = asInt(parsed.ttlMinutes ?? parsed.ttl_minutes, 60, 1);
    args.push(`--lifespan-sec=${ttlMinutes * 60}`);
    const checkpointSec = asInt(
      parsed.checkpointInterval ?? parsed.checkpoint_interval_sec,
      60,
      1
    );
    args.push(`--check-in-interval-sec=${checkpointSec}`);
  }

  const autoPublish = parsed.auto_publish_results ?? parsed.autoPublishResults;
  if (autoPublish != null) args.push(`--auto-publish-results=${asBool(autoPublish) ? 1 : 0}`);

  const testMode = cleanString(parsed.testMode || parsed.test_mode).toLowerCase();
  if (testMode === 'byzantine' || asBool(parsed.byzantine)) {
    const enable = execOps(['swarm-runtime', 'byzantine-test', 'enable', `--state-path=${statePath(parsed)}`]);
    requireOk(enable, 'byzantine_test_enable');
    args.push('--byzantine=1');
    let corruptionType = cleanString(parsed.corruption_type || parsed.corruptionType);
    if (!corruptionType && parsed.faultPattern) {
      try {
        const pattern =
          typeof parsed.faultPattern === 'string'
            ? JSON.parse(parsed.faultPattern)
            : parsed.faultPattern;
        corruptionType = cleanString(pattern.type || pattern.value);
      } catch {}
    }
    if (corruptionType) args.push(`--corruption-type=${corruptionType}`);
  }

  args.push(`--state-path=${statePath(parsed)}`);
  const run = execOps(args);
  const payload = requireOk(run, 'sessions_spawn');
  return normalizeSpawnPayload(payload);
}

function sessionsSend(options = {}) {
  const parsed = normalizedOptions(options);
  const sessionId = sessionIdFromKey(
    parsed.sessionKey || parsed.session_key || parsed.session_id || parsed.sessionId
  );
  const senderId = sessionIdFromKey(
    parsed.sender_session_key ||
      parsed.sender_session_id ||
      parsed.senderSessionKey ||
      parsed.senderSessionId ||
      parsed.sender ||
      'coordinator'
  );
  const message = cleanString(parsed.message || parsed.payload);
  const delivery = cleanString(parsed.delivery || 'at_least_once');
  const ttlMs = asInt(parsed.ttl_ms ?? parsed.ttlMs, 300000, 1);
  const args = [
    'swarm-runtime',
    'sessions',
    'send',
    `--sender-id=${senderId || 'coordinator'}`,
    `--session-id=${sessionId}`,
    `--message=${message}`,
    `--delivery=${delivery || 'at_least_once'}`,
    `--ttl-ms=${ttlMs}`,
    `--state-path=${statePath(parsed)}`,
  ];
  const run = execOps(args);
  const payload = requireOk(run, 'sessions_send');
  return normalizeSendPayload(payload);
}

function sessionsResume(options = {}) {
  const parsed = normalizedOptions(options);
  const sessionId = sessionIdFromKey(
    parsed.sessionKey || parsed.session_key || parsed.session_id || parsed.sessionId
  );
  const run = execOps([
    'swarm-runtime',
    'sessions',
    'resume',
    `--session-id=${sessionId}`,
    `--state-path=${statePath(parsed)}`,
  ]);
  const payload = requireOk(run, 'sessions_resume');
  return {
    ok: true,
    type: 'sessions_resume',
    session_id: sessionId,
    payload,
  };
}

function sessionsDeadLetters(options = {}) {
  const parsed = normalizedOptions(options);
  const args = ['swarm-runtime', 'sessions', 'dead-letter'];
  const sessionId = sessionIdFromKey(
    parsed.sessionKey || parsed.session_key || parsed.session_id || parsed.sessionId
  );
  if (sessionId) args.push(`--session-id=${sessionId}`);
  if (parsed.retryable != null) args.push(`--retryable=${asBool(parsed.retryable) ? 1 : 0}`);
  args.push(`--state-path=${statePath(parsed)}`);
  const run = execOps(args);
  const payload = requireOk(run, 'sessions_dead_letter');
  return {
    ok: true,
    type: 'sessions_dead_letter',
    payload,
  };
}

function sessionsRetryDeadLetter(options = {}) {
  const parsed = normalizedOptions(options);
  const messageId = cleanString(parsed.message_id || parsed.messageId);
  const run = execOps([
    'swarm-runtime',
    'sessions',
    'retry-dead-letter',
    `--message-id=${messageId}`,
    `--state-path=${statePath(parsed)}`,
  ]);
  const payload = requireOk(run, 'sessions_retry_dead_letter');
  return {
    ok: true,
    type: 'sessions_retry_dead_letter',
    message_id: messageId,
    payload,
  };
}

function sessionsReceive(options = {}) {
  const parsed = normalizedOptions(options);
  const sessionId = sessionIdFromKey(
    parsed.sessionKey || parsed.session_key || parsed.session_id || parsed.sessionId
  );
  const limit = asInt(parsed.limit, 10, 1);
  const args = [
    'swarm-runtime',
    'sessions',
    'receive',
    `--session-id=${sessionId}`,
    `--limit=${limit}`,
    '--mark-read=0',
    `--state-path=${statePath(parsed)}`,
  ];
  const run = execOps(args);
  const payload = requireOk(run, 'sessions_receive');
  return normalizeReceivePayload(payload, sessionId);
}

function sessionsAck(options = {}) {
  const parsed = normalizedOptions(options);
  const sessionId = sessionIdFromKey(
    parsed.sessionKey || parsed.session_key || parsed.session_id || parsed.sessionId
  );
  const messageId = cleanString(parsed.message_id || parsed.messageId);
  const run = execOps([
    'swarm-runtime',
    'sessions',
    'ack',
    `--session-id=${sessionId}`,
    `--message-id=${messageId}`,
    `--state-path=${statePath(parsed)}`,
  ]);
  const payload = requireOk(run, 'sessions_ack');
  return {
    ok: true,
    type: 'sessions_ack',
    session_id: sessionId,
    message_id: messageId,
    payload,
  };
}

function sessionsState(options = {}) {
  const parsed = normalizedOptions(options);
  const sessionId = sessionIdFromKey(
    parsed.sessionKey || parsed.session_key || parsed.session_id || parsed.sessionId
  );
  const timeline = asBool(parsed.timeline) ? 1 : 0;
  const toolHistoryLimit = asInt(parsed.tool_history_limit ?? parsed.toolHistoryLimit, 32, 1);
  const run = execOps([
    'swarm-runtime',
    'sessions',
    'state',
    `--session-id=${sessionId}`,
    `--timeline=${timeline}`,
    `--tool-history-limit=${toolHistoryLimit}`,
    `--state-path=${statePath(parsed)}`,
  ]);
  const payload = requireOk(run, 'sessions_state');
  return normalizeStatePayload(payload, sessionId);
}

function sessionsQuery(options = {}) {
  const parsed = normalizedOptions(options);
  const role = cleanString(parsed.agentRole || parsed.role);
  const label = cleanString(parsed.agentLabel || parsed.agent_label || parsed.label);
  const taskId = cleanString(parsed.testId || parsed.task_id || parsed.taskId);
  const sessionId = sessionIdFromKey(parsed.session_id || parsed.sessionId);
  const wait = asBool(parsed.wait);
  const args = ['swarm-runtime', 'results', wait ? 'wait' : 'query'];
  if (role) args.push(`--role=${role}`);
  if (label) args.push(`--label-pattern=${label}`);
  if (taskId) args.push(`--task-id=${taskId}`);
  if (sessionId) args.push(`--session-id=${sessionId}`);
  if (wait) {
    args.push(`--min-count=${asInt(parsed.min_count ?? parsed.minCount, 1, 1)}`);
    args.push(`--timeout-sec=${asInt(parsed.timeout_sec ?? parsed.timeoutSec, 10, 1)}`);
  }
  args.push(`--state-path=${statePath(parsed)}`);
  const run = execOps(args);
  const payload = requireOk(run, 'sessions_query');

  let discovery = null;
  if (role) {
    const discoverRun = execOps([
      'swarm-runtime',
      'sessions',
      'discover',
      `--role=${role}`,
      `--state-path=${statePath(parsed)}`,
    ]);
    if (discoverRun.status === 0) {
      discovery = discoverRun.payload || null;
    }
  }

  return {
    ok: true,
    type: 'sessions_query',
    result_count: payload.result_count || 0,
    results: Array.isArray(payload.results) ? payload.results : [],
    discovery,
    payload,
  };
}

function sessionsTick(options = {}) {
  const parsed = normalizedOptions(options);
  const args = [
    'swarm-runtime',
    'tick',
    `--advance-ms=${asInt(parsed.advance_ms ?? parsed.advanceMs, 1000, 1)}`,
    `--max-check-ins=${asInt(parsed.max_check_ins ?? parsed.maxCheckIns, 32, 1)}`,
    `--state-path=${statePath(parsed)}`,
  ];
  const run = execOps(args);
  const payload = requireOk(run, 'sessions_tick');
  return {
    ok: true,
    type: 'sessions_tick',
    payload,
  };
}

function printUsage() {
  process.stdout.write(
    [
      'Usage:',
      '  node client/runtime/systems/autonomy/swarm_sessions_bridge.ts sessions_spawn --task=<text> [--session-id=<parent>] [--sessionType=persistent|background] [--ttlMinutes=<n>] [--checkpointInterval=<sec>] [--token-budget=<n>|--max-tokens=<n>] [--testMode=byzantine] [--faultPattern=\'{\"type\":\"corruption\"}\'] [--state-path=<path>]',
      '  node client/runtime/systems/autonomy/swarm_sessions_bridge.ts sessions_send --sessionKey=<key|id> --message=<text> [--sender=<key|id>] [--delivery=<at_most_once|at_least_once|exactly_once>] [--state-path=<path>]',
      '  node client/runtime/systems/autonomy/swarm_sessions_bridge.ts sessions_receive --sessionKey=<key|id> [--limit=<n>] [--state-path=<path>]',
      '  node client/runtime/systems/autonomy/swarm_sessions_bridge.ts sessions_ack --sessionKey=<key|id> --message-id=<id> [--state-path=<path>]',
      '  node client/runtime/systems/autonomy/swarm_sessions_bridge.ts sessions_resume --sessionKey=<key|id> [--state-path=<path>]',
      '  node client/runtime/systems/autonomy/swarm_sessions_bridge.ts sessions_dead_letter [--sessionKey=<key|id>] [--retryable=1|0] [--state-path=<path>]',
      '  node client/runtime/systems/autonomy/swarm_sessions_bridge.ts sessions_retry_dead_letter --message-id=<id> [--state-path=<path>]',
      '  node client/runtime/systems/autonomy/swarm_sessions_bridge.ts sessions_query [--agentRole=<role>] [--agentLabel=<label>] [--testId=<task>] [--wait=1] [--state-path=<path>]',
      '  node client/runtime/systems/autonomy/swarm_sessions_bridge.ts sessions_state --sessionKey=<key|id> [--timeline=1] [--tool-history-limit=<n>] [--state-path=<path>]',
      '  node client/runtime/systems/autonomy/swarm_sessions_bridge.ts sessions_tick [--advance-ms=<n>] [--max-check-ins=<n>] [--state-path=<path>]',
      '',
      'Aliases: spawn/send/receive/ack/resume/query/state/tick',
      '',
    ].join('\n')
  );
}

function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const command = cleanString(parsed._[0] || 'sessions_spawn').toLowerCase();

  let payload;
  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return 0;
  }
  if (command === 'sessions_spawn' || command === 'spawn') payload = sessionsSpawn(parsed);
  else if (command === 'sessions_send' || command === 'send') payload = sessionsSend(parsed);
  else if (command === 'sessions_receive' || command === 'receive') payload = sessionsReceive(parsed);
  else if (command === 'sessions_ack' || command === 'ack') payload = sessionsAck(parsed);
  else if (command === 'sessions_resume' || command === 'resume') payload = sessionsResume(parsed);
  else if (command === 'sessions_dead_letter' || command === 'dead-letter') payload = sessionsDeadLetters(parsed);
  else if (command === 'sessions_retry_dead_letter' || command === 'retry-dead-letter') payload = sessionsRetryDeadLetter(parsed);
  else if (command === 'sessions_query' || command === 'query') payload = sessionsQuery(parsed);
  else if (command === 'sessions_state' || command === 'state') payload = sessionsState(parsed);
  else if (command === 'sessions_tick' || command === 'tick') payload = sessionsTick(parsed);
  else {
    process.stderr.write(`unknown_command:${command}\n`);
    printUsage();
    return 2;
  }

  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${String((err && err.message) || err)}\n`);
    process.exit(1);
  }
}

module.exports = {
  ROOT,
  DEFAULT_STATE_PATH,
  parseArgs,
  sessionsSpawn,
  sessionsSend,
  sessionsReceive,
  sessionsAck,
  sessionsResume,
  sessionsDeadLetters,
  sessionsRetryDeadLetter,
  sessionsQuery,
  sessionsState,
  sessionsTick,
  run,
};
