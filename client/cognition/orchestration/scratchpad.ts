#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs, invokeOrchestration } = require('./core_bridge.ts');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_SCRATCHPAD_DIR = path.join(ROOT, 'local', 'workspace', 'scratchpad');
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SCHEMA_VERSION = 'scratchpad/v1';

function taskIdFrom(parsed, fallback = '') {
  return String(
    parsed.flags['task-id']
      || parsed.flags.task_id
      || parsed.positional[1]
      || fallback
  ).trim();
}

function assertTaskId(taskId) {
  if (!TASK_ID_PATTERN.test(String(taskId || ''))) {
    throw new Error(`invalid_task_id:${taskId || '<empty>'}`);
  }
}

function scratchpadPath(taskId, options = {}) {
  assertTaskId(taskId);
  const rootDir = options.rootDir || options.root_dir || DEFAULT_SCRATCHPAD_DIR;
  return path.join(rootDir, `${taskId}.json`);
}

function mapScratchpadStatus(out, taskId, options = {}) {
  const fallbackPath = scratchpadPath(taskId, options);
  const scratchpad = out && out.scratchpad && typeof out.scratchpad === 'object'
    ? out.scratchpad
    : {
      schema_version: SCHEMA_VERSION,
      task_id: taskId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      progress: { processed: 0, total: 0 },
      findings: [],
      checkpoints: [],
    };

  return {
    ok: Boolean(out && out.ok),
    type: String(out && out.type ? out.type : 'orchestration_scratchpad_status'),
    task_id: taskId,
    file_path: String(out && out.file_path ? out.file_path : fallbackPath),
    filePath: String(out && out.file_path ? out.file_path : fallbackPath),
    exists: Boolean(out && out.exists),
    scratchpad,
    reason_code: out && out.reason_code ? String(out.reason_code) : undefined,
  };
}

function loadScratchpad(taskId, options = {}) {
  assertTaskId(taskId);
  const out = invokeOrchestration('scratchpad.status', {
    task_id: taskId,
    root_dir: options.rootDir || options.root_dir || undefined,
  });
  return mapScratchpadStatus(out, taskId, options);
}

function writeScratchpad(taskId, patch = {}, options = {}) {
  assertTaskId(taskId);
  const out = invokeOrchestration('scratchpad.write', {
    task_id: taskId,
    patch: patch && typeof patch === 'object' ? patch : {},
    root_dir: options.rootDir || options.root_dir || undefined,
  });
  if (!out || !out.ok) {
    return {
      ok: false,
      type: 'orchestration_scratchpad_write',
      reason_code: String(out && out.reason_code ? out.reason_code : 'orchestration_bridge_error'),
      task_id: taskId,
    };
  }
  return {
    ok: true,
    type: 'orchestration_scratchpad_write',
    task_id: taskId,
    file_path: out.file_path,
    filePath: out.file_path,
    scratchpad: out.scratchpad,
  };
}

function appendFinding(taskId, finding, options = {}) {
  assertTaskId(taskId);
  const out = invokeOrchestration('scratchpad.append_finding', {
    task_id: taskId,
    finding: finding && typeof finding === 'object' ? finding : {},
    root_dir: options.rootDir || options.root_dir || undefined,
  });
  if (!out || !out.ok) {
    return {
      ok: false,
      type: 'orchestration_scratchpad_append_finding',
      reason_code: String(out && out.reason_code ? out.reason_code : 'orchestration_bridge_error'),
      task_id: taskId,
    };
  }
  return {
    ok: true,
    type: 'orchestration_scratchpad_append_finding',
    task_id: taskId,
    file_path: out.file_path,
    filePath: out.file_path,
    scratchpad: out.scratchpad,
    finding_count: Number.isFinite(Number(out.finding_count)) ? Number(out.finding_count) : 0,
  };
}

function appendCheckpoint(taskId, checkpoint, options = {}) {
  assertTaskId(taskId);
  const out = invokeOrchestration('scratchpad.append_checkpoint', {
    task_id: taskId,
    checkpoint: checkpoint && typeof checkpoint === 'object' ? checkpoint : {},
    root_dir: options.rootDir || options.root_dir || undefined,
  });
  if (!out || !out.ok) {
    return {
      ok: false,
      type: 'orchestration_scratchpad_append_checkpoint',
      reason_code: String(out && out.reason_code ? out.reason_code : 'orchestration_bridge_error'),
      task_id: taskId,
    };
  }
  return {
    ok: true,
    type: 'orchestration_scratchpad_append_checkpoint',
    task_id: taskId,
    file_path: out.file_path,
    filePath: out.file_path,
    scratchpad: out.scratchpad,
    checkpoint_count: Number.isFinite(Number(out.checkpoint_count)) ? Number(out.checkpoint_count) : 0,
  };
}

function cleanupScratchpad(taskId, options = {}) {
  assertTaskId(taskId);
  const out = invokeOrchestration('scratchpad.cleanup', {
    task_id: taskId,
    root_dir: options.rootDir || options.root_dir || undefined,
  });
  if (!out || !out.ok) {
    return {
      ok: false,
      type: 'orchestration_scratchpad_cleanup',
      reason_code: String(out && out.reason_code ? out.reason_code : 'orchestration_bridge_error'),
      task_id: taskId,
    };
  }
  return {
    ok: true,
    type: 'orchestration_scratchpad_cleanup',
    task_id: taskId,
    file_path: out.file_path,
    filePath: out.file_path,
    removed: Boolean(out.removed),
  };
}

function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const command = String(parsed.positional[0] || 'status').trim().toLowerCase();
  const taskId = taskIdFrom(parsed);

  try {
    if (command === 'status' || command === 'read') {
      assertTaskId(taskId);
      return loadScratchpad(taskId);
    }

    if (command === 'write') {
      assertTaskId(taskId);
      const payload = parsed.flags['payload-json'] || parsed.flags.payload_json || '{}';
      let patch = {};
      try {
        patch = JSON.parse(String(payload));
      } catch {
        return {
          ok: false,
          type: 'orchestration_scratchpad_write',
          reason_code: 'invalid_payload_json',
        };
      }
      return writeScratchpad(taskId, patch);
    }

    if (command === 'append-finding') {
      assertTaskId(taskId);
      const payload = parsed.flags['finding-json'] || parsed.flags.finding_json || '{}';
      let finding = {};
      try {
        finding = JSON.parse(String(payload));
      } catch {
        return {
          ok: false,
          type: 'orchestration_scratchpad_append_finding',
          reason_code: 'invalid_finding_json',
        };
      }
      return appendFinding(taskId, finding);
    }

    if (command === 'checkpoint') {
      assertTaskId(taskId);
      const payload = parsed.flags['checkpoint-json'] || parsed.flags.checkpoint_json || '{}';
      let checkpoint = {};
      try {
        checkpoint = JSON.parse(String(payload));
      } catch {
        return {
          ok: false,
          type: 'orchestration_scratchpad_append_checkpoint',
          reason_code: 'invalid_checkpoint_json',
        };
      }
      return appendCheckpoint(taskId, checkpoint);
    }

    if (command === 'cleanup') {
      assertTaskId(taskId);
      return cleanupScratchpad(taskId);
    }

    return {
      ok: false,
      type: 'orchestration_scratchpad_command',
      reason_code: `unsupported_command:${command}`,
      commands: ['status', 'read', 'write', 'append-finding', 'checkpoint', 'cleanup'],
    };
  } catch (error) {
    return {
      ok: false,
      type: 'orchestration_scratchpad_command',
      reason_code: String(error && error.message ? error.message : error),
    };
  }
}

if (require.main === module) {
  const out = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.ok ? 0 : 1);
}

module.exports = {
  ROOT,
  DEFAULT_SCRATCHPAD_DIR,
  SCHEMA_VERSION,
  TASK_ID_PATTERN,
  parseArgs,
  taskIdFrom,
  scratchpadPath,
  loadScratchpad,
  writeScratchpad,
  appendFinding,
  appendCheckpoint,
  cleanupScratchpad,
  run,
};
