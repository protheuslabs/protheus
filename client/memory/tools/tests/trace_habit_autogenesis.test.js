#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'trace_habit_autogenesis.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-habit-autogenesis-'));
  const policyPath = path.join(tmp, 'config', 'trace_habit_autogenesis_policy.json');
  const tracesPath = path.join(tmp, 'state', 'observability', 'thought_action_trace.jsonl');
  const postmortemDir = path.join(tmp, 'state', 'ops', 'postmortems');
  const outputDir = path.join(tmp, 'state', 'ops', 'trace_habit_autogenesis');

  const traces = [];
  for (let i = 0; i < 10; i += 1) {
    traces.push({
      ts: `2026-03-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      trace_id: `t_a_${i}`,
      stage: 'execute',
      outcome: i < 8 ? 'error' : 'ok'
    });
  }
  for (let i = 0; i < 10; i += 1) {
    traces.push({
      ts: `2026-03-01T01:${String(i).padStart(2, '0')}:00.000Z`,
      trace_id: `t_b_${i}`,
      stage: 'execute',
      outcome: i < 2 ? 'error' : 'ok'
    });
  }
  writeJsonl(tracesPath, traces);

  writeJson(path.join(postmortemDir, 'INC-77.json'), {
    incident_id: 'INC-77',
    status: 'closed',
    actions: [
      {
        action_id: 'A2',
        type: 'preventive',
        status: 'resolved'
      }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    min_failure_events_per_class: 3,
    min_window_events: 4,
    min_regression_reduction: 0.3,
    failure_outcomes: ['error', 'fail', 'timeout', 'blocked'],
    paths: {
      trace_path: tracesPath,
      postmortem_dir: postmortemDir,
      queue_path: path.join(outputDir, 'queue.json'),
      latest_path: path.join(outputDir, 'latest.json'),
      receipts_path: path.join(outputDir, 'receipts.jsonl'),
      reports_dir: path.join(outputDir, 'reports')
    }
  });

  let out = run(['propose', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'propose should pass');
  assert.ok(Number(out.payload.created_count || 0) >= 1, 'should create at least one candidate');
  const traceCandidate = (out.payload.created || []).find((row) => String(row.failure_class || '').startsWith('trace:execute:error'));
  assert.ok(traceCandidate && traceCandidate.candidate_id, 'trace candidate should exist');
  const candidateId = traceCandidate.candidate_id;

  out = run(['trial', `--policy=${policyPath}`, `--candidate-id=${candidateId}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'trial should pass');
  assert.strictEqual(Number(out.payload.passed_count || 0), 1, 'trial should pass regression gate');

  out = run(['report', `--policy=${policyPath}`, `--candidate-id=${candidateId}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'report should pass');
  assert.strictEqual(Number(out.payload.promotable_count || 0), 1, 'candidate should be promotable');

  out = run(['promote', `--policy=${policyPath}`, `--candidate-id=${candidateId}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'promote should pass');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.counts && Number(out.payload.counts.promoted || 0) >= 1, 'status should report promoted candidate');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('trace_habit_autogenesis.test.js: OK');
} catch (err) {
  console.error(`trace_habit_autogenesis.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
