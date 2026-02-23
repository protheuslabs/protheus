#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EYES_INSIGHT_PATH = path.join(ROOT, 'habits', 'scripts', 'eyes_insight.js');
const SENSORY_QUEUE_PATH = path.join(ROOT, 'habits', 'scripts', 'sensory_queue.js');
const PROPOSAL_ENRICHER_PATH = path.join(ROOT, 'systems', 'autonomy', 'proposal_enricher.js');
const BRIDGE_SCRIPT_PATH = path.join(ROOT, 'systems', 'actuation', 'bridge_from_proposals.js');
const ACTUATION_EXECUTOR_PATH = path.join(ROOT, 'systems', 'actuation', 'actuation_executor.js');
const RECEIPT_SUMMARY_PATH = path.join(ROOT, 'systems', 'autonomy', 'receipt_summary.js');

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function runNode(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
}

function parseLastJsonLine(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep scanning
    }
  }
  return null;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   PIPELINE HANDOFFS E2E INTEGRATION TEST');
  console.log('═══════════════════════════════════════════════════════════');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-handoff-'));
  const adapterSandboxDir = fs.mkdtempSync(path.join(path.join(ROOT, 'tmp'), 'pipeline-handoff-adapter-'));
  const adapterSandboxFile = path.join(adapterSandboxDir, 'unstable_adapter.js');
  fs.writeFileSync(adapterSandboxFile, [
    "'use strict';",
    '',
    "module.exports.execute = async function execute(ctx) {",
    "  const params = ctx && ctx.params && typeof ctx.params === 'object' ? ctx.params : {};",
    "  const mode = String(params.mode || '').trim().toLowerCase();",
    "  if (mode === 'timeout') throw new Error('simulated_timeout');",
    "  if (mode === 'rate_limit') throw new Error('simulated_rate_limited');",
    "  if (mode === 'rollback') throw new Error('simulated_rollback_triggered');",
    "  return {",
    "    ok: true,",
    "    code: 0,",
    "    summary: { decision: 'ACTUATE', gate_decision: 'ALLOW', executable: true, verified: true }",
    "  };",
    "};",
    ''
  ].join('\n'), 'utf8');
  const sensoryDir = path.join(tmpRoot, 'state', 'sensory');
  const proposalsDir = path.join(sensoryDir, 'proposals');
  const date = '2026-02-19';
  const actuationReceiptsDir = path.join(tmpRoot, 'state', 'actuation', 'receipts');
  const actuationAdaptersConfig = path.join(tmpRoot, 'config', 'actuation_adapters.json');

  const env = {
    SENSORY_TEST_DIR: sensoryDir,
    SENSORY_QUEUE_TEST_DIR: tmpRoot,
    PROPOSAL_ENRICHER_EYES_REGISTRY: path.join(sensoryDir, 'eyes', 'registry.json'),
    ACTUATION_BRIDGE_PROPOSALS_DIR: proposalsDir,
    ACTUATION_RECEIPTS_DIR: actuationReceiptsDir,
    ACTUATION_ADAPTERS_CONFIG: actuationAdaptersConfig,
    SENSORY_MIN_DIRECTIVE_FIT: '0',
    SENSORY_MIN_ACTIONABILITY_SCORE: '40',
    AUTONOMY_ALLOWED_RISKS: 'low,medium',
    AUTONOMY_MIN_SIGNAL_QUALITY: '40',
    AUTONOMY_MIN_SENSORY_SIGNAL_SCORE: '35',
    AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE: '35',
    AUTONOMY_MIN_DIRECTIVE_FIT: '20',
    AUTONOMY_MIN_ACTIONABILITY_SCORE: '35',
    AUTONOMY_MIN_COMPOSITE_ELIGIBILITY: '45',
    SENSORY_QUEUE_MIN_SIGNAL_SCORE: '35',
    SENSORY_QUEUE_MIN_RELEVANCE_SCORE: '35',
    SENSORY_QUEUE_MIN_DIRECTIVE_FIT_SCORE: '20',
    SENSORY_QUEUE_MIN_ACTIONABILITY_SCORE: '35',
    SENSORY_QUEUE_MIN_COMPOSITE_SCORE: '45'
  };
  Object.assign(process.env, env);

  writeJson(actuationAdaptersConfig, {
    version: '1.0',
    adapters: {
      moltbook_publish: {
        module: 'skills/moltbook/actuation_adapter.js',
        description: 'Guarded Moltbook post publication with verification receipts.'
      },
      test_chaos: {
        module: path.relative(ROOT, adapterSandboxFile).replace(/\\/g, '/'),
        description: 'Deterministic adapter for timeout/rate-limit/rollback failure-path testing.'
      }
    }
  });

  clearModule(EYES_INSIGHT_PATH);
  clearModule(SENSORY_QUEUE_PATH);
  clearModule(PROPOSAL_ENRICHER_PATH);

  const eyesInsight = require(EYES_INSIGHT_PATH);
  const sensoryQueue = require(SENSORY_QUEUE_PATH);
  const proposalEnricher = require(PROPOSAL_ENRICHER_PATH);

  fs.mkdirSync(path.dirname(env.PROPOSAL_ENRICHER_EYES_REGISTRY), { recursive: true });
  writeJson(env.PROPOSAL_ENRICHER_EYES_REGISTRY, {
    version: '1.0',
    eyes: [
      {
        id: 'hn_frontpage',
        status: 'active',
        parser_type: 'hn_rss',
        score_ema: 81
      }
    ]
  });

  const rawPath = path.join(sensoryDir, 'eyes', 'raw', `${date}.jsonl`);
  writeJsonl(rawPath, [
    {
      ts: `${date}T01:00:00Z`,
      type: 'external_item',
      item: {
        eye_id: 'hn_frontpage',
        url: 'https://example.com/ops/opportunity-1',
        title: 'Implement deterministic pipeline handoff checks with receipts',
        topics: ['automation', 'quality', 'routing'],
        content_preview: 'Add stable tests for proposal handoffs and dry-run actuation receipts.',
        collected_at: `${date}T01:00:00Z`
      }
    }
  ]);

  const merge = eyesInsight.mergeIntoDailyProposals(date, 1);
  assert.strictEqual(merge.ok, true);
  assert.ok(merge.added_count >= 1, `expected at least 1 proposal, got ${merge.added_count}`);

  const proposalsPath = path.join(proposalsDir, `${date}.json`);
  const proposals = readJson(proposalsPath);
  assert.ok(Array.isArray(proposals) && proposals.length >= 1, 'eyes_insight should emit proposals');

  const happyProposal = proposals[0];
  const happyId = String(happyProposal.id || '');
  assert.ok(happyId, 'expected proposal id');
  happyProposal.meta = {
    ...(happyProposal.meta || {}),
    actuation_hint: {
      kind: 'moltbook_publish',
      params: {
        title: 'Dry-run integration test post',
        body: 'This is a deterministic dry-run from pipeline handoff integration test.',
        submolt: 'general'
      }
    }
  };

  const blockedId = 'EYE-BLOCKED-ACTION-SPEC';
  proposals.push({
    id: blockedId,
    type: 'external_intel',
    title: 'Blocked proposal should fail action-spec gate',
    summary: 'This proposal intentionally omits action_spec to verify queue filter behavior.',
    evidence: [{ evidence_ref: 'eye:hn_frontpage', url: 'https://example.com/block' }],
    meta: {
      source_eye: 'hn_frontpage',
      objective_id: 'T1_PIPELINE_QUALITY',
      directive_objective_id: 'T1_PIPELINE_QUALITY',
      relevance_score: 78,
      directive_fit_score: 74,
      signal_quality_score: 76,
      actionability_score: 70,
      composite_eligibility_score: 72,
      actionability_pass: true,
      composite_eligibility_pass: true
    }
  });
  writeJson(proposalsPath, proposals);

  const enrich = proposalEnricher.runForDate(date, false);
  assert.strictEqual(enrich.ok, true, 'proposal_enricher should succeed');

  const bridgeRun = runNode([BRIDGE_SCRIPT_PATH, 'run', date], env);
  assert.strictEqual(bridgeRun.status, 0, `bridge_from_proposals failed: ${bridgeRun.stderr || bridgeRun.stdout}`);
  const bridgeOut = parseLastJsonLine(bridgeRun.stdout);
  assert.ok(bridgeOut && bridgeOut.ok === true, `invalid bridge output: ${bridgeRun.stdout}`);

  const bridged = readJson(proposalsPath);
  const bridgedHappy = bridged.find((p) => String(p.id) === happyId);
  assert.ok(bridgedHappy, 'bridged happy proposal missing');
  assert.ok(bridgedHappy.meta && bridgedHappy.meta.actuation, 'bridge should attach actuation payload');
  assert.strictEqual(String(bridgedHappy.meta.actuation.kind || ''), 'moltbook_publish');
  assert.ok(bridgedHappy.action_spec && typeof bridgedHappy.action_spec === 'object', 'action_spec should be normalized');

  const ingest = sensoryQueue.ingest(date);
  assert.ok(Number(ingest.ingested || 0) >= 1, `expected ingest >= 1, got ${JSON.stringify(ingest)}`);
  assert.ok(Number(ingest.filtered || 0) >= 1, `expected filtered >= 1, got ${JSON.stringify(ingest)}`);

  const queueLogPath = path.join(tmpRoot, 'state', 'sensory', 'queue_log.jsonl');
  const queueEvents = readJsonl(queueLogPath);
  const generatedHappy = queueEvents.find((e) => e.type === 'proposal_generated' && String(e.proposal_id) === happyId);
  const filteredBlocked = queueEvents.find((e) => e.type === 'proposal_filtered' && String(e.proposal_id) === blockedId);
  assert.ok(generatedHappy, 'happy proposal should be generated into queue');
  assert.ok(filteredBlocked, 'blocked proposal should be filtered');
  assert.strictEqual(String(filteredBlocked.filter_reason || ''), 'action_spec_missing', 'blocked reason should be action_spec_missing');

  const paramsJson = JSON.stringify(bridgedHappy.meta.actuation.params || {});
  const execRun = runNode([
    ACTUATION_EXECUTOR_PATH,
    'run',
    '--kind=moltbook_publish',
    `--params=${paramsJson}`,
    '--dry-run'
  ], env);
  assert.strictEqual(execRun.status, 0, `actuation executor failed: ${execRun.stderr || execRun.stdout}`);
  const execOut = parseLastJsonLine(execRun.stdout);
  assert.ok(execOut && execOut.ok === true, `invalid actuation executor output: ${execRun.stdout}`);
  assert.ok(execOut.summary && execOut.summary.dry_run === true, 'expected dry-run summary');

  const receiptFile = path.join(actuationReceiptsDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const receipts = readJsonl(receiptFile);
  assert.ok(receipts.length >= 1, 'actuation receipt should be written');
  const lastReceipt = receipts[receipts.length - 1];
  assert.strictEqual(lastReceipt.type, 'actuation_execution');
  assert.strictEqual(lastReceipt.adapter, 'moltbook_publish');
  assert.strictEqual(lastReceipt.ok, true);
  assert.ok(lastReceipt.summary && lastReceipt.summary.dry_run === true);
  assert.ok(lastReceipt.receipt_contract && lastReceipt.receipt_contract.attempted === false);
  assert.ok(lastReceipt.receipt_contract && lastReceipt.receipt_contract.verified === false);
  assert.ok(lastReceipt.receipt_contract && lastReceipt.receipt_contract.recorded === true);

  const failureModes = [
    { mode: 'timeout', needle: 'simulated_timeout' },
    { mode: 'rate_limit', needle: 'simulated_rate_limited' },
    { mode: 'rollback', needle: 'simulated_rollback_triggered' }
  ];
  for (const row of failureModes) {
    const failRun = runNode([
      ACTUATION_EXECUTOR_PATH,
      'run',
      '--kind=test_chaos',
      `--params=${JSON.stringify({ mode: row.mode })}`
    ], env);
    assert.notStrictEqual(failRun.status, 0, `expected non-zero exit for ${row.mode}`);
    const failOut = parseLastJsonLine(failRun.stdout);
    assert.ok(failOut && failOut.ok === false, `expected failure payload for ${row.mode}`);
    const errText = String((failOut && failOut.error) || '');
    assert.ok(errText.includes(row.needle), `failure payload missing ${row.needle}: ${errText}`);
  }

  const receiptsAfterFailures = readJsonl(receiptFile);
  const chaosReceipts = receiptsAfterFailures.filter((r) => String(r && r.adapter || '') === 'test_chaos');
  assert.strictEqual(chaosReceipts.length, 3, 'expected 3 chaos adapter receipts');
  for (const row of chaosReceipts) {
    assert.strictEqual(row.ok, false, 'chaos receipt should be failed');
    assert.ok(row.receipt_contract && row.receipt_contract.attempted === true, 'chaos receipt should be attempted');
    assert.ok(row.receipt_contract && row.receipt_contract.verified === false, 'chaos receipt should be unverified');
  }

  const summaryRun = runNode([
    RECEIPT_SUMMARY_PATH,
    'run',
    new Date().toISOString().slice(0, 10),
    '--days=1'
  ], {
    ...env,
    AUTONOMY_SUMMARY_RECEIPTS_DIR: path.join(tmpRoot, 'state', 'autonomy', 'receipts'),
    ACTUATION_SUMMARY_RECEIPTS_DIR: actuationReceiptsDir
  });
  assert.strictEqual(summaryRun.status, 0, `receipt summary failed: ${summaryRun.stderr || summaryRun.stdout}`);
  const summaryOut = JSON.parse(String(summaryRun.stdout || '{}'));
  assert.ok(summaryOut && summaryOut.ok === true, 'receipt summary payload should be ok');
  const failureReasons = summaryOut
    && summaryOut.receipts
    && summaryOut.receipts.actuation
    && summaryOut.receipts.actuation.top_failure_reasons
    ? summaryOut.receipts.actuation.top_failure_reasons
    : {};
  assert.ok(Number(failureReasons.simulated_timeout || 0) >= 1, 'summary should include timeout failure reason');
  assert.ok(Number(failureReasons.simulated_rate_limited || 0) >= 1, 'summary should include rate-limit failure reason');
  assert.ok(Number(failureReasons.simulated_rollback_triggered || 0) >= 1, 'summary should include rollback failure reason');

  fs.rmSync(adapterSandboxDir, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('   ✅ handoffs verified: insight -> enrich -> bridge -> queue(generated/filtered) -> execute -> receipt');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
