#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-169
 * Public modular API for spine/reflex/gates.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function runNodeScript(relScript: string, args: string[] = []) {
  const script = path.join(ROOT, relScript);
  const proc = spawnSync('node', [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    ok: Number(proc.status || 0) === 0,
    status: Number(proc.status || 0),
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function spineStatus(extraArgs: string[] = []) {
  return runNodeScript('systems/spine/spine.js', ['status', ...extraArgs]);
}

function reflexStatus(extraArgs: string[] = []) {
  return runNodeScript('habits/scripts/reflex_habit_bridge.js', ['status', ...extraArgs]);
}

function gateStatus(extraArgs: string[] = []) {
  return runNodeScript('systems/security/guard.js', ['status', ...extraArgs]);
}

module.exports = {
  spineStatus,
  reflexStatus,
  gateStatus
};
