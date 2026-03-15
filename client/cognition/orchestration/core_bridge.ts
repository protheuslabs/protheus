#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { parseArgs, parseJson } = require('./cli_shared.ts');
const { ROOT, resolveBinary } = require(path.join(__dirname, '..', '..', 'runtime', 'systems', 'ops', 'run_protheus_ops.js'));

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const candidate = lines.slice(index).join('\n').trim();
      if (!candidate.startsWith('{') || !candidate.endsWith('}')) continue;
      try {
        return JSON.parse(candidate);
      } catch {}
    }
  }
  return null;
}

function invokeOrchestration(op, payload = {}, options = {}) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const args = [
    'orchestration',
    'invoke',
    `--op=${String(op || '').trim()}`,
    `--payload-json=${JSON.stringify(safePayload)}`,
  ];

  let proc;
  try {
    const executable = (() => {
      const localDebug = path.join(ROOT, 'target', 'debug', process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops');
      if (fs.existsSync(localDebug)) return localDebug;
      const localRelease = path.join(ROOT, 'target', 'release', process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops');
      if (fs.existsSync(localRelease)) return localRelease;
      return resolveBinary();
    })();

    proc = spawnSync(executable, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PROTHEUS_ROOT: ROOT, ...(options.env || {}) },
    });
  } catch (error) {
    return {
      ok: false,
      type: 'orchestration_bridge_error',
      reason_code: `spawn_failed:${String(error && error.message ? error.message : error)}`,
    };
  }

  const parsed = parseJsonOutput(proc.stdout) || parseJsonOutput(proc.stderr);
  if (parsed && typeof parsed === 'object') {
    return parsed;
  }

  return {
    ok: false,
    type: 'orchestration_bridge_error',
    reason_code: `invoke_failed:${Number.isFinite(proc.status) ? proc.status : 1}`,
    stderr: String(proc.stderr || '').trim() || null,
  };
}

module.exports = {
  ROOT,
  parseArgs,
  parseJson,
  invokeOrchestration,
};
