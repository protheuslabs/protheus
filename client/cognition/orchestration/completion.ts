#!/usr/bin/env node
'use strict';

const { parseArgs, parseJson, invokeOrchestration } = require('./core_bridge.ts');
const { statusCounts } = require('./taskgroup.ts');

function partialCountFromGroup(group) {
  const agents = Array.isArray(group && group.agents) ? group.agents : [];
  let total = 0;
  for (const agent of agents) {
    const details = agent && typeof agent === 'object' ? agent.details : null;
    if (!details || typeof details !== 'object') continue;
    const count = Number.isFinite(Number(details.partial_results_count))
      ? Number(details.partial_results_count)
      : Array.isArray(details.partial_results)
        ? details.partial_results.length
        : 0;
    if (count > 0) total += 1;
  }
  return total;
}

function completionSummary(taskGroup) {
  const counts = statusCounts(taskGroup || {});
  const terminalTotal = counts.done + counts.failed + counts.timeout;
  const complete = counts.total > 0 && terminalTotal === counts.total;
  return {
    task_group_id: String(taskGroup && taskGroup.task_group_id ? taskGroup.task_group_id : '').trim().toLowerCase(),
    status: String(taskGroup && taskGroup.status ? taskGroup.status : '').trim() || 'pending',
    completed_count: counts.done,
    failed_count: counts.failed,
    timeout_count: counts.timeout,
    pending_count: counts.pending,
    running_count: counts.running,
    partial_count: partialCountFromGroup(taskGroup),
    total_count: counts.total,
    complete,
    counts,
  };
}

function buildCompletionNotification(summary, taskGroup) {
  return {
    type: 'orchestration_completion_notification',
    task_group_id: summary.task_group_id,
    coordinator_session: taskGroup && taskGroup.coordinator_session ? taskGroup.coordinator_session : null,
    status: summary.status,
    completed_count: summary.completed_count,
    failed_count: summary.failed_count,
    timeout_count: summary.timeout_count,
    partial_count: summary.partial_count,
    total_count: summary.total_count,
    generated_at: new Date().toISOString(),
  };
}

function ensureAndSummarize(taskGroupId, options = {}) {
  const out = invokeOrchestration('completion.status', {
    task_group_id: String(taskGroupId || '').trim().toLowerCase(),
    root_dir: options.rootDir || options.root_dir || undefined,
  });
  if (!out || !out.ok) {
    return {
      ok: false,
      type: 'orchestration_completion_summary',
      reason_code: String(out && out.reason_code ? out.reason_code : 'orchestration_bridge_error'),
    };
  }
  return {
    ok: true,
    type: 'orchestration_completion_summary',
    task_group: out.task_group,
    summary: out.summary,
    notification: out.notification || null,
  };
}

function trackAgentCompletion(taskGroupId, update, options = {}) {
  const out = invokeOrchestration('completion.track', {
    task_group_id: String(taskGroupId || '').trim().toLowerCase(),
    update: update && typeof update === 'object' ? update : {},
    root_dir: options.rootDir || options.root_dir || undefined,
  });
  if (!out || !out.ok) {
    return {
      ok: false,
      type: 'orchestration_completion_track',
      reason_code: String(out && out.reason_code ? out.reason_code : 'orchestration_bridge_error'),
    };
  }
  return {
    ok: true,
    type: 'orchestration_completion_track',
    task_group: out.task_group,
    summary: out.summary,
    notification: out.notification || null,
  };
}

function trackBatchCompletion(taskGroupId, updates = [], options = {}) {
  const out = invokeOrchestration('completion.batch', {
    task_group_id: String(taskGroupId || '').trim().toLowerCase(),
    updates: Array.isArray(updates) ? updates : [],
    root_dir: options.rootDir || options.root_dir || undefined,
  });
  if (!out || !out.ok) {
    return {
      ok: false,
      type: 'orchestration_completion_track_batch',
      reason_code: String(out && out.reason_code ? out.reason_code : 'orchestration_bridge_error'),
      failed_update: out ? out.failed_update : null,
    };
  }
  return {
    ok: true,
    type: 'orchestration_completion_track_batch',
    task_group: out.task_group,
    summary: out.summary,
    updates_applied: Number.isFinite(Number(out.updates_applied)) ? Number(out.updates_applied) : 0,
    updates: Array.isArray(out.updates) ? out.updates : [],
    notification: out.notification || null,
  };
}

function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const command = String(parsed.positional[0] || 'status').trim().toLowerCase();
  const taskGroupId = String(
    parsed.flags['task-group-id']
      || parsed.flags.task_group_id
      || parsed.flags.id
      || parsed.positional[1]
      || ''
  ).trim().toLowerCase();

  if (!taskGroupId) {
    return {
      ok: false,
      type: 'orchestration_completion_command',
      reason_code: 'missing_task_group_id',
    };
  }

  if (command === 'status') {
    return ensureAndSummarize(taskGroupId);
  }

  if (command === 'track') {
    const detailsPayload = parseJson(parsed.flags['details-json'] || parsed.flags.details_json, {}, 'invalid_details_json');
    if (!detailsPayload.ok) {
      return {
        ok: false,
        type: 'orchestration_completion_track',
        reason_code: detailsPayload.reason_code,
      };
    }
    return trackAgentCompletion(taskGroupId, {
      agent_id: parsed.flags['agent-id'] || parsed.flags.agent_id || '',
      status: parsed.flags.status || '',
      details: detailsPayload.value,
    });
  }

  if (command === 'batch') {
    const updatesPayload = parseJson(parsed.flags['updates-json'] || parsed.flags.updates_json, [], 'invalid_updates_json');
    if (!updatesPayload.ok) {
      return {
        ok: false,
        type: 'orchestration_completion_track_batch',
        reason_code: updatesPayload.reason_code,
      };
    }
    return trackBatchCompletion(taskGroupId, updatesPayload.value);
  }

  return {
    ok: false,
    type: 'orchestration_completion_command',
    reason_code: `unsupported_command:${command}`,
    commands: ['status', 'track', 'batch'],
  };
}

if (require.main === module) {
  const out = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.ok ? 0 : 1);
}

module.exports = {
  completionSummary,
  buildCompletionNotification,
  ensureAndSummarize,
  trackAgentCompletion,
  trackBatchCompletion,
  run,
};
