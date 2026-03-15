#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  parseArgs,
  parseJson,
  invokeOrchestration,
} = require('./core_bridge.ts');
const { slug, timestampToken, nonceToken } = require('./cli_shared.ts');
const { runTaskGroupCli } = require('./taskgroup_cli.ts');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_TASKGROUP_DIR = path.join(ROOT, 'local', 'workspace', 'scratchpad', 'taskgroups');
const TASKGROUP_SCHEMA_VERSION = 'taskgroup/v1';
const GROUP_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{5,127}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;
const ALLOWED_AGENT_STATUSES = new Set(['pending', 'running', 'done', 'failed', 'timeout']);
const TERMINAL_AGENT_STATUSES = new Set(['done', 'failed', 'timeout']);

function generateTaskGroupId(taskType = 'task', options = {}) {
  const nowMs = Number.isFinite(Number(options.now_ms)) ? Number(options.now_ms) : Date.now();
  const nonce = String(options.nonce || '').trim().toLowerCase() || nonceToken(6);
  const id = `${slug(taskType, 'task')}-${timestampToken(nowMs)}-${slug(nonce, nonceToken(6))}`;
  return id.slice(0, 127);
}

function taskGroupPath(taskGroupId, options = {}) {
  const id = String(taskGroupId || '').trim().toLowerCase();
  if (!GROUP_ID_PATTERN.test(id)) {
    throw new Error(`invalid_task_group_id:${taskGroupId || '<empty>'}`);
  }
  const rootDir = options.rootDir || options.root_dir || DEFAULT_TASKGROUP_DIR;
  return path.join(rootDir, `${id}.json`);
}

function statusCounts(group) {
  const counts = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    timeout: 0,
    total: 0,
  };
  const agents = Array.isArray(group && group.agents) ? group.agents : [];
  for (const agent of agents) {
    const status = String(agent && agent.status ? agent.status : 'pending').toLowerCase();
    if (!(status in counts)) continue;
    counts[status] += 1;
    counts.total += 1;
  }
  return counts;
}

function deriveGroupStatus(group) {
  const counts = statusCounts(group);
  if (counts.total === 0 || counts.pending === counts.total) return 'pending';
  if (counts.running > 0 || counts.pending > 0) return 'running';
  if (counts.failed > 0 && counts.done === 0 && counts.timeout === 0) return 'failed';
  if (counts.timeout > 0 && counts.done === 0 && counts.failed === 0) return 'timeout';
  if (counts.done === counts.total) return 'done';
  if (counts.done + counts.failed + counts.timeout === counts.total) return 'completed';
  return 'running';
}

function normalizeTaskGroupResponse(out, fallbackType) {
  if (!out || typeof out !== 'object') {
    return {
      ok: false,
      type: fallbackType,
      reason_code: 'orchestration_bridge_error',
    };
  }

  const response = {
    ok: Boolean(out.ok),
    type: String(out.type || fallbackType),
    reason_code: out.reason_code ? String(out.reason_code) : undefined,
  };

  if (typeof out.created === 'boolean') response.created = out.created;
  if (out.file_path) {
    response.file_path = String(out.file_path);
    response.filePath = String(out.file_path);
  }
  if (out.task_group && typeof out.task_group === 'object') response.task_group = out.task_group;
  if (out.counts && typeof out.counts === 'object') response.counts = out.counts;
  if (out.task_group_id) response.task_group_id = String(out.task_group_id);
  if (out.agent_id) response.agent_id = String(out.agent_id);
  if (out.status) response.status = String(out.status);
  if (out.previous_status) response.previous_status = String(out.previous_status);

  return response;
}

function loadTaskGroup(taskGroupId, options = {}) {
  const query = queryTaskGroup(taskGroupId, options);
  if (query.ok) {
    return {
      ok: true,
      exists: true,
      file_path: query.file_path,
      filePath: query.file_path,
      task_group: query.task_group,
    };
  }

  return {
    ok: true,
    exists: false,
    file_path: taskGroupPath(taskGroupId, options),
    filePath: taskGroupPath(taskGroupId, options),
    task_group: null,
  };
}

function saveTaskGroup(taskGroup, options = {}) {
  if (!taskGroup || typeof taskGroup !== 'object' || Array.isArray(taskGroup)) {
    return {
      ok: false,
      type: 'orchestration_taskgroup_save',
      reason_code: 'invalid_taskgroup',
    };
  }

  const ensured = ensureTaskGroup(taskGroup, options);
  if (!ensured.ok) return ensured;

  const taskGroupId = ensured.task_group && ensured.task_group.task_group_id
    ? ensured.task_group.task_group_id
    : taskGroup.task_group_id;

  const updates = Array.isArray(taskGroup.agents) ? taskGroup.agents : [];
  for (const agent of updates) {
    const status = String(agent && agent.status ? agent.status : 'pending').toLowerCase();
    if (!ALLOWED_AGENT_STATUSES.has(status)) continue;
    const out = updateAgentStatus(
      taskGroupId,
      String(agent && agent.agent_id ? agent.agent_id : ''),
      status,
      agent && typeof agent.details === 'object' ? agent.details : {},
      options,
    );
    if (!out.ok) return out;
  }

  const queried = queryTaskGroup(taskGroupId, options);
  if (!queried.ok) return queried;

  return {
    ok: true,
    type: 'orchestration_taskgroup_save',
    file_path: queried.file_path,
    filePath: queried.file_path,
    task_group: queried.task_group,
    counts: queried.counts,
  };
}

function ensureTaskGroup(input = {}, options = {}) {
  const out = invokeOrchestration('taskgroup.ensure', {
    ...(input && typeof input === 'object' ? input : {}),
    root_dir: options.rootDir || options.root_dir || undefined,
  });
  return normalizeTaskGroupResponse(out, 'orchestration_taskgroup_ensure');
}

function updateAgentStatus(taskGroupId, agentId, status, details = {}, options = {}) {
  const out = invokeOrchestration('taskgroup.update_status', {
    task_group_id: String(taskGroupId || '').trim().toLowerCase(),
    agent_id: String(agentId || '').trim(),
    status: String(status || '').trim().toLowerCase(),
    details: details && typeof details === 'object' && !Array.isArray(details) ? details : {},
    root_dir: options.rootDir || options.root_dir || undefined,
  });
  return normalizeTaskGroupResponse(out, 'orchestration_taskgroup_update_status');
}

function queryTaskGroup(taskGroupId, options = {}) {
  const out = invokeOrchestration('taskgroup.query', {
    task_group_id: String(taskGroupId || '').trim().toLowerCase(),
    root_dir: options.rootDir || options.root_dir || undefined,
  });
  return normalizeTaskGroupResponse(out, 'orchestration_taskgroup_query');
}

function run(argv = process.argv.slice(2)) {
  return runTaskGroupCli(argv, {
    ensureTaskGroup,
    queryTaskGroup,
    updateAgentStatus,
  });
}

if (require.main === module) {
  const out = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.ok ? 0 : 1);
}

module.exports = {
  ROOT,
  DEFAULT_TASKGROUP_DIR,
  TASKGROUP_SCHEMA_VERSION,
  GROUP_ID_PATTERN,
  AGENT_ID_PATTERN,
  ALLOWED_AGENT_STATUSES,
  TERMINAL_AGENT_STATUSES,
  parseArgs,
  parseJson,
  generateTaskGroupId,
  taskGroupPath,
  statusCounts,
  deriveGroupStatus,
  loadTaskGroup,
  saveTaskGroup,
  ensureTaskGroup,
  updateAgentStatus,
  queryTaskGroup,
  run,
};
