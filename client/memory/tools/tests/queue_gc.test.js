#!/usr/bin/env node
/**
 * queue_gc.test.js
 * Truthful tests: exit 1 on failure
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function banner(title) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(title);
  console.log('═══════════════════════════════════════════════════════════');
}

function mkDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  mkDir(path.dirname(filePath));
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function runNode(args, env) {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const r = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return r;
}

function makeProposal(i, dateStr) {
  return {
    id: `QGC-${String(i).padStart(3, '0')}`,
    type: 'cross_signal_opportunity',
    title: `Queue GC proposal ${i}`,
    expected_impact: 'high',
    status: 'open',
    ts: `${dateStr}T${String((i % 12) + 10).padStart(2, '0')}:00:00.000Z`,
    action_spec: {
      version: 1,
      objective: 'Keep queue pressure bounded with deterministic hygiene.',
      target: `queue_gc:${i}`,
      next_command: `node client/habits/scripts/queue_gc.js run ${dateStr}`,
      verify: ['Queue open count within cap per eye'],
      rollback: 'Restore previous queue dispositions from queue log history'
    },
    meta: {
      source_eye: 'cross_signal_engine',
      signal_quality_score: 78,
      relevance_score: 74,
      directive_fit_score: 56,
      actionability_score: 80,
      composite_eligibility_score: 84,
      actionability_pass: true,
      composite_eligibility_pass: true
    },
    evidence: [
      {
        source: 'cross_signal',
        path: `state/sensory/eyes/raw/${dateStr}.jsonl`,
        evidence_ref: 'eye:cross_signal_engine'
      }
    ]
  };
}

function testDefaultParsingAndIdempotence() {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const dateStr = '2026-02-22';
  const tmp = fs.mkdtempSync(path.join(__dirname, 'temp_queue_gc_'));
  const sensoryRoot = tmp;
  const queueRoot = path.join(tmp, 'state', 'queue');
  const sensoryProposals = path.join(sensoryRoot, 'state', 'sensory', 'proposals', `${dateStr}.json`);
  const queueProposals = path.join(queueRoot, 'proposals.jsonl');
  const queueLog = path.join(sensoryRoot, 'state', 'sensory', 'queue_log.jsonl');

  const proposals = [];
  for (let i = 1; i <= 11; i += 1) proposals.push(makeProposal(i, dateStr));
  writeJson(sensoryProposals, proposals);
  writeJsonl(queueProposals, proposals);

  const generatedEvents = proposals.map((p, idx) => ({
    ts: `${dateStr}T00:${String(idx).padStart(2, '0')}:00.000Z`,
    type: 'proposal_generated',
    date: dateStr,
    proposal_id: p.id,
    proposal_hash: `hash_${p.id}`,
    title: p.title,
    status_after: 'open',
    source: 'sensory_queue'
  }));
  writeJsonl(queueLog, generatedEvents);

  const baseEnv = {
    SENSORY_QUEUE_TEST_DIR: sensoryRoot,
    QUEUE_DIR: path.relative(repoRoot, queueRoot),
    QUEUE_GC_BUDGET_TUNING_ENABLED: '0'
  };

  // Explicit empty args should still use safe defaults (cap=10, ttl=48), rejecting exactly one overflow item.
  const first = runNode(
    ['client/habits/scripts/queue_gc.js', 'run', dateStr, '--cap-per-eye=', '--ttl-hours='],
    baseEnv
  );
  assert.strictEqual(first.status, 0, `queue_gc first run failed: ${String(first.stderr || first.stdout)}`);

  const afterFirst = readJsonl(queueLog);
  const rejectedFirst = afterFirst.filter((e) => e && e.type === 'proposal_rejected');
  assert.strictEqual(rejectedFirst.length, 1, 'queue_gc should reject exactly one overflow proposal at default cap=10');
  assert.ok(String(rejectedFirst[0].reason || '').includes('auto:queue_gc cap>10'), 'reject reason should use default cap=10');

  // Second run should be idempotent: no additional reject events.
  const second = runNode(
    ['client/habits/scripts/queue_gc.js', 'run', dateStr],
    baseEnv
  );
  assert.strictEqual(second.status, 0, `queue_gc second run failed: ${String(second.stderr || second.stdout)}`);

  const afterSecond = readJsonl(queueLog);
  const rejectedSecond = afterSecond.filter((e) => e && e.type === 'proposal_rejected');
  assert.strictEqual(rejectedSecond.length, 1, 'queue_gc second run must not emit duplicate rejects');

  fs.rmSync(tmp, { recursive: true, force: true });
}

function testBudgetAwareHardPressureTuning() {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const dateStr = '2026-02-22';
  const tmp = fs.mkdtempSync(path.join(__dirname, 'temp_queue_gc_budget_'));
  const sensoryRoot = tmp;
  const queueRoot = path.join(tmp, 'state', 'queue');
  const sensoryProposals = path.join(sensoryRoot, 'state', 'sensory', 'proposals', `${dateStr}.json`);
  const queueProposals = path.join(queueRoot, 'proposals.jsonl');
  const queueLog = path.join(sensoryRoot, 'state', 'sensory', 'queue_log.jsonl');

  const proposals = [];
  for (let i = 1; i <= 11; i += 1) proposals.push(makeProposal(i, dateStr));
  writeJson(sensoryProposals, proposals);
  writeJsonl(queueProposals, proposals);
  writeJsonl(queueLog, proposals.map((p, idx) => ({
    ts: `${dateStr}T01:${String(idx).padStart(2, '0')}:00.000Z`,
    type: 'proposal_generated',
    date: dateStr,
    proposal_id: p.id,
    proposal_hash: `hash_${p.id}`,
    title: p.title,
    status_after: 'open',
    source: 'sensory_queue'
  })));

  const env = {
    SENSORY_QUEUE_TEST_DIR: sensoryRoot,
    QUEUE_DIR: path.relative(repoRoot, queueRoot),
    QUEUE_GC_BUDGET_PRESSURE: 'hard'
  };

  const run = runNode(['client/habits/scripts/queue_gc.js', 'run', dateStr], env);
  assert.strictEqual(run.status, 0, `queue_gc hard-pressure run failed: ${String(run.stderr || run.stdout)}`);

  const after = readJsonl(queueLog).filter((e) => e && e.type === 'proposal_rejected');
  assert.strictEqual(after.length, 6, 'hard pressure should reduce cap_per_eye to 5 (11 open => 6 rejects)');
  assert.ok(String(after[0].reason || '').includes('auto:queue_gc cap>5'), 'hard pressure reject reason should include tuned cap>5');

  fs.rmSync(tmp, { recursive: true, force: true });
}

function testAdaptiveEscalationSalvagePath() {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const dateStr = '2026-02-22';
  const tmp = fs.mkdtempSync(path.join(__dirname, 'temp_queue_gc_salvage_'));
  const sensoryRoot = tmp;
  const queueRoot = path.join(tmp, 'state', 'queue');
  const sensoryProposals = path.join(sensoryRoot, 'state', 'sensory', 'proposals', `${dateStr}.json`);
  const queueProposals = path.join(queueRoot, 'proposals.jsonl');
  const queueLog = path.join(sensoryRoot, 'state', 'sensory', 'queue_log.jsonl');
  const salvagePath = path.join(tmp, 'state', 'queue', 'salvage', `${dateStr}.jsonl`);

  const proposals = [
    {
      id: 'ESC-HIGH-01',
      type: 'pain_escalation',
      title: 'Escalation high score salvage',
      expected_impact: 'high',
      status: 'open',
      ts: '2026-02-20T00:00:00.000Z',
      execution_worthiness_score: 92,
      action_spec: {
        version: 1,
        objective: 'Salvage high-score escalation',
        target: 'queue_gc:esc-high',
        next_command: `node client/habits/scripts/queue_gc.js run ${dateStr}`,
        verify: ['proposal parked'],
        rollback: 'unsnooze escalation proposal'
      },
      meta: {
        source_eye: 'eye_escalation',
        signal_quality_score: 90,
        relevance_score: 89,
        actionability_score: 92,
        composite_eligibility_score: 90
      },
      evidence: [{ source: 'test', path: `state/sensory/eyes/raw/${dateStr}.jsonl`, evidence_ref: 'eye:eye_escalation' }]
    },
    {
      id: 'ESC-LOW-01',
      type: 'pain_escalation',
      title: 'Escalation low score reject',
      expected_impact: 'high',
      status: 'open',
      ts: '2026-02-20T00:10:00.000Z',
      execution_worthiness_score: 35,
      action_spec: {
        version: 1,
        objective: 'Reject low-score escalation',
        target: 'queue_gc:esc-low',
        next_command: `node client/habits/scripts/queue_gc.js run ${dateStr}`,
        verify: ['proposal rejected'],
        rollback: 'restore proposal status open'
      },
      meta: {
        source_eye: 'eye_escalation',
        signal_quality_score: 35,
        relevance_score: 34,
        actionability_score: 32,
        composite_eligibility_score: 33
      },
      evidence: [{ source: 'test', path: `state/sensory/eyes/raw/${dateStr}.jsonl`, evidence_ref: 'eye:eye_escalation' }]
    }
  ];
  writeJson(sensoryProposals, proposals);
  writeJsonl(queueProposals, proposals);
  writeJsonl(queueLog, proposals.map((p, idx) => ({
    ts: `${dateStr}T01:${String(idx).padStart(2, '0')}:00.000Z`,
    type: 'proposal_generated',
    date: dateStr,
    proposal_id: p.id,
    proposal_hash: `hash_${p.id}`,
    title: p.title,
    status_after: 'open',
    source: 'sensory_queue'
  })));

  const env = {
    SENSORY_QUEUE_TEST_DIR: sensoryRoot,
    QUEUE_DIR: path.relative(repoRoot, queueRoot),
    QUEUE_GC_BUDGET_TUNING_ENABLED: '0',
    QUEUE_GC_ESCALATION_SALVAGE_PATH: salvagePath
  };

  const run = runNode(
    [
      'client/habits/scripts/queue_gc.js',
      'run',
      dateStr,
      '--cap-per-eye=10',
      '--cap-per-type=10',
      '--ttl-hours=999',
      '--escalation-ttl-hours=16',
      '--cross-signal-ttl-hours=999'
    ],
    env
  );
  assert.strictEqual(run.status, 0, `queue_gc adaptive escalation run failed: ${String(run.stderr || run.stdout)}`);

  const queueRows = readJsonl(queueLog);
  assert.ok(
    queueRows.some((e) => e && e.type === 'proposal_snoozed' && e.proposal_id === 'ESC-HIGH-01'),
    'high-score escalation should be salvaged via snooze'
  );
  assert.ok(
    queueRows.some((e) => e && e.type === 'proposal_rejected' && e.proposal_id === 'ESC-LOW-01'),
    'low-score escalation should be rejected after adaptive ttl'
  );
  const salvageRows = readJsonl(salvagePath);
  assert.ok(
    salvageRows.some((row) => row && row.type === 'queue_gc_escalation_salvage' && row.proposal_id === 'ESC-HIGH-01'),
    'salvage ledger should record high-score escalation'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

function testDeterministicNowOverrideForDefaultDate() {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const overriddenDate = '2024-01-15';
  const tmp = fs.mkdtempSync(path.join(__dirname, 'temp_queue_gc_now_'));
  const sensoryRoot = tmp;
  const queueRoot = path.join(tmp, 'state', 'queue');
  const sensoryProposals = path.join(sensoryRoot, 'state', 'sensory', 'proposals', `${overriddenDate}.json`);
  const queueProposals = path.join(queueRoot, 'proposals.jsonl');
  const queueLog = path.join(sensoryRoot, 'state', 'sensory', 'queue_log.jsonl');

  const proposals = [];
  for (let i = 1; i <= 11; i += 1) proposals.push(makeProposal(i, overriddenDate));
  writeJson(sensoryProposals, proposals);
  writeJsonl(queueProposals, proposals);
  writeJsonl(queueLog, proposals.map((p, idx) => ({
    ts: `${overriddenDate}T01:${String(idx).padStart(2, '0')}:00.000Z`,
    type: 'proposal_generated',
    date: overriddenDate,
    proposal_id: p.id,
    proposal_hash: `hash_${p.id}`,
    title: p.title,
    status_after: 'open',
    source: 'sensory_queue'
  })));

  const env = {
    SENSORY_QUEUE_TEST_DIR: sensoryRoot,
    QUEUE_DIR: path.relative(repoRoot, queueRoot),
    QUEUE_GC_BUDGET_TUNING_ENABLED: '0',
    QUEUE_GC_NOW_ISO: `${overriddenDate}T12:00:00.000Z`
  };

  const run = runNode(['client/habits/scripts/queue_gc.js', 'run'], env);
  assert.strictEqual(run.status, 0, `queue_gc now-override run failed: ${String(run.stderr || run.stdout)}`);

  const rejected = readJsonl(queueLog).filter((e) => e && e.type === 'proposal_rejected');
  assert.strictEqual(rejected.length, 1, 'now override should make no-date run deterministic against overridden date');
  assert.ok(String(rejected[0].reason || '').includes('auto:queue_gc cap>10'), 'default cap logic should still apply');

  fs.rmSync(tmp, { recursive: true, force: true });
}

function main() {
  banner('QUEUE_GC TESTS defaults + idempotence');
  testDefaultParsingAndIdempotence();
  testBudgetAwareHardPressureTuning();
  testAdaptiveEscalationSalvagePath();
  testDeterministicNowOverrideForDefaultDate();
  banner('✅ QUEUE_GC TESTS PASS');
}

try {
  main();
} catch (err) {
  console.error(`❌ queue_gc.test failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
