#!/usr/bin/env node
'use strict';

const { parseArgs, parseJson, invokeOrchestration } = require('./core_bridge.ts');

function normalizeDecision(rawDecision, hasPartialResults) {
  const out = invokeOrchestration('partial.normalize_decision', {
    decision: String(rawDecision || ''),
    has_partial_results: Boolean(hasPartialResults),
  });
  if (out && out.ok && out.decision) {
    return String(out.decision);
  }
  const value = String(rawDecision || '').trim().toLowerCase();
  if (value === 'retry' || value === 'continue' || value === 'abort') return value;
  return hasPartialResults ? 'continue' : 'retry';
}

function retrievePartialResults(input = {}) {
  const out = invokeOrchestration('partial.fetch', {
    ...(input && typeof input === 'object' ? input : {}),
  });
  if (!out || typeof out.ok !== 'boolean') {
    return {
      ok: false,
      type: 'orchestration_partial_retrieval',
      reason_code: 'orchestration_bridge_error',
    };
  }
  return out;
}

function extractPartialFromSessionEntry(entry) {
  const out = retrievePartialResults({
    task_id: 'partial-extract-probe',
    session_history: [entry],
    decision: 'continue',
  });
  if (!out.ok || out.source !== 'session_history' || !Array.isArray(out.findings_sofar)) {
    return null;
  }
  return {
    partial_results: out.findings_sofar,
    items_completed: Number.isFinite(Number(out.items_completed)) ? Number(out.items_completed) : out.findings_sofar.length,
    checkpoint_path: out.checkpoint_path || null,
    source_session_id: out.source_session_id || null,
  };
}

function fromSessionHistory(history = []) {
  const out = retrievePartialResults({
    task_id: 'partial-session-history-probe',
    session_history: Array.isArray(history) ? history : [],
    decision: 'continue',
  });
  if (out.ok && out.source === 'session_history') {
    return {
      ok: true,
      type: 'orchestration_partial_from_session_history',
      source: 'session_history',
      items_completed: out.items_completed,
      findings_sofar: Array.isArray(out.findings_sofar) ? out.findings_sofar : [],
      checkpoint_path: out.checkpoint_path || null,
      source_session_id: out.source_session_id || null,
    };
  }
  return {
    ok: false,
    type: 'orchestration_partial_from_session_history',
    reason_code: 'session_history_no_partial_results',
  };
}

function latestCheckpointFromScratchpad(taskId, options = {}) {
  const out = retrievePartialResults({
    task_id: String(taskId || '').trim(),
    session_history: [],
    root_dir: options.rootDir || options.root_dir || undefined,
  });
  if (!out.ok || out.source !== 'checkpoint') {
    return {
      ok: false,
      type: 'orchestration_partial_checkpoint_fallback',
      reason_code: out && out.checkpoint_reason ? out.checkpoint_reason : 'checkpoint_no_partial_results',
      task_id: String(taskId || '').trim(),
      checkpoint_path: out && out.checkpoint_path ? out.checkpoint_path : null,
    };
  }
  return {
    ok: true,
    type: 'orchestration_partial_checkpoint_fallback',
    source: 'checkpoint',
    task_id: String(taskId || '').trim(),
    checkpoint_path: out.checkpoint_path,
    items_completed: out.items_completed,
    findings_sofar: Array.isArray(out.findings_sofar) ? out.findings_sofar : [],
    retry_allowed: Boolean(out.retry_allowed),
  };
}

function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const command = String(parsed.positional[0] || 'fetch').trim().toLowerCase();
  if (command !== 'fetch' && command !== 'status') {
    return {
      ok: false,
      type: 'orchestration_partial_command',
      reason_code: `unsupported_command:${command}`,
      commands: ['fetch', 'status'],
    };
  }

  const taskId = String(
    parsed.flags['task-id']
      || parsed.flags.task_id
      || parsed.positional[1]
      || ''
  ).trim();

  const sessionPayload = parseJson(
    parsed.flags['session-history-json'] || parsed.flags.session_history_json,
    [],
    'invalid_session_history_json'
  );
  if (!sessionPayload.ok) {
    return {
      ok: false,
      type: 'orchestration_partial_retrieval',
      reason_code: sessionPayload.reason_code,
    };
  }

  return retrievePartialResults({
    task_id: taskId,
    session_history: sessionPayload.value,
    decision: parsed.flags.decision || '',
    root_dir: parsed.flags['root-dir'] || parsed.flags.root_dir || '',
  });
}

if (require.main === module) {
  const out = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.ok ? 0 : 1);
}

module.exports = {
  normalizeDecision,
  extractPartialFromSessionEntry,
  fromSessionHistory,
  latestCheckpointFromScratchpad,
  retrievePartialResults,
  run,
};
