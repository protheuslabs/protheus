#!/usr/bin/env node
'use strict';
export {};

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function run(scriptName, args = []) {
  const scriptPath = path.join(ROOT, 'systems', 'memory', 'abstraction', `${scriptName}.js`);
  const out = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    ok: Number(out.status) === 0,
    status: Number(out.status),
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || '')
  };
}

const MemoryView = {
  query: (args = []) => run('memory_view', ['query', ...args]),
  get: (args = []) => run('memory_view', ['get', ...args]),
  snapshot: (args = []) => run('memory_view', ['snapshot', ...args]),
  status: (args = []) => run('memory_view', ['status', ...args])
};

const AnalyticsEngine = {
  run: (args = []) => run('analytics_engine', ['run', ...args]),
  baselineCapture: (args = []) => run('analytics_engine', ['baseline-capture', ...args]),
  status: (args = []) => run('analytics_engine', ['status', ...args])
};

const TestHarness = {
  run: (args = []) => run('test_harness', ['run', ...args]),
  baselineCapture: (args = []) => run('test_harness', ['baseline-capture', ...args]),
  status: (args = []) => run('test_harness', ['status', ...args])
};

module.exports = {
  MemoryView,
  AnalyticsEngine,
  TestHarness,
  runMemoryView: (args = []) => run('memory_view', args),
  runAnalyticsEngine: (args = []) => run('analytics_engine', args),
  runTestHarness: (args = []) => run('test_harness', args)
};
