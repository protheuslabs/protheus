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
const AUTONOMY_CONTROLLER_PATH = path.join(ROOT, 'systems', 'autonomy', 'autonomy_controller.js');

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
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
      // continue
    }
  }
  return null;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   AUTONOMY EVIDENCE PIPELINE INTEGRATION TEST');
  console.log('═══════════════════════════════════════════════════════════');

  const date = '2099-12-31';
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-evidence-pipeline-'));
  const sensoryDir = path.join(tmpRoot, 'state', 'sensory');
  const autonomyDir = path.join(tmpRoot, 'state', 'autonomy');
  const adaptersConfigPath = path.join(tmpRoot, 'config', 'actuation_adapters.json');
  const rootProposalPath = path.join(ROOT, 'state', 'sensory', 'proposals', `${date}.json`);

  const priorRootProposalExists = fs.existsSync(rootProposalPath);
  const priorRootProposal = priorRootProposalExists ? fs.readFileSync(rootProposalPath, 'utf8') : null;

  try {
    process.env.SENSORY_TEST_DIR = sensoryDir;
    process.env.SENSORY_QUEUE_TEST_DIR = tmpRoot;
    process.env.PROPOSAL_ENRICHER_EYES_REGISTRY = path.join(sensoryDir, 'eyes', 'registry.json');
    process.env.AUTONOMY_ALLOWED_RISKS = 'low,medium';
    process.env.SENSORY_MIN_DIRECTIVE_FIT = '0';
    process.env.SENSORY_MIN_ACTIONABILITY_SCORE = '40';
    process.env.AUTONOMY_MIN_SIGNAL_QUALITY = '35';
    process.env.AUTONOMY_MIN_SENSORY_SIGNAL_SCORE = '35';
    process.env.AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE = '35';
    process.env.AUTONOMY_MIN_DIRECTIVE_FIT = '20';
    process.env.AUTONOMY_MIN_ACTIONABILITY_SCORE = '35';
    process.env.AUTONOMY_MIN_COMPOSITE_ELIGIBILITY = '45';

    writeJson(adaptersConfigPath, {
      version: '1.0',
      adapters: {
        moltbook_publish: {
          module: 'skills/moltbook/actuation_adapter.js',
          description: 'Guarded Moltbook post publication with verification receipts.'
        }
      }
    });

    clearModule(EYES_INSIGHT_PATH);
    clearModule(SENSORY_QUEUE_PATH);
    clearModule(PROPOSAL_ENRICHER_PATH);

    const eyesInsight = require(EYES_INSIGHT_PATH);
    const sensoryQueue = require(SENSORY_QUEUE_PATH);
    const proposalEnricher = require(PROPOSAL_ENRICHER_PATH);

    writeJson(process.env.PROPOSAL_ENRICHER_EYES_REGISTRY, {
      version: '1.0',
      eyes: [
        {
          id: 'e2e_autonomy_eye',
          status: 'active',
          parser_type: 'hn_rss',
          score_ema: 88
        }
      ]
    });

    writeJsonl(path.join(sensoryDir, 'eyes', 'raw', `${date}.jsonl`), [
      {
        ts: `${date}T01:00:00.000Z`,
        type: 'external_item',
        item: {
          eye_id: 'e2e_autonomy_eye',
          url: 'https://example.com/e2e/autonomy-evidence',
          title: 'Deploy deterministic evidence pipeline checks for autonomy',
          topics: ['automation', 'testing', 'reliability'],
          content_preview: 'Add deterministic integration checks that validate evidence mode routing end-to-end.',
          collected_at: `${date}T01:00:00.000Z`
        }
      }
    ]);

    const merge = eyesInsight.mergeIntoDailyProposals(date, 3);
    assert.strictEqual(merge.ok, true, 'eyes_insight merge should succeed');
    assert.ok(Number(merge.added_count || 0) >= 1, `expected merge added_count >= 1, got ${merge.added_count}`);

    const enrich = proposalEnricher.runForDate(date, false);
    assert.strictEqual(enrich.ok, true, 'proposal_enricher should succeed');

    const tempProposalsPath = path.join(sensoryDir, 'proposals', `${date}.json`);
    const proposals = readJson(tempProposalsPath);
    assert.ok(Array.isArray(proposals) && proposals.length > 0, 'expected enriched proposal array');

    const first = proposals[0];
    first.risk = 'low';
    first.meta = {
      ...(first.meta || {}),
      source_eye: 'e2e_autonomy_eye',
      signal_quality_score: 86,
      relevance_score: 84,
      directive_fit_score: 82,
      actionability_score: 83,
      composite_eligibility_score: 85,
      actionability_pass: true,
      composite_eligibility_pass: true,
      actuation: {
        kind: 'moltbook_publish',
        params: {
          title: 'E2E Evidence Dry-Run',
          body: 'Deterministic evidence-mode integration test.',
          submolt: 'general'
        }
      }
    };
    writeJson(tempProposalsPath, proposals);

    const ingest = sensoryQueue.ingest(date);
    assert.ok(Number(ingest.ingested || 0) >= 1, `expected queue ingest >= 1, got ${JSON.stringify(ingest)}`);
    const queueEvents = readJsonl(path.join(tmpRoot, 'state', 'sensory', 'queue_log.jsonl'));
    assert.ok(queueEvents.some((e) => e.type === 'proposal_generated' && String(e.proposal_id) === String(first.id)), 'queue should generate proposal event');

    fs.mkdirSync(path.dirname(rootProposalPath), { recursive: true });
    fs.copyFileSync(tempProposalsPath, rootProposalPath);

    const evidenceRun = spawnSync(process.execPath, [AUTONOMY_CONTROLLER_PATH, 'evidence', date], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        AUTONOMY_STATE_DIR: autonomyDir,
        AUTONOMY_RUNS_DIR: path.join(autonomyDir, 'runs'),
        AUTONOMY_EXPERIMENTS_DIR: path.join(autonomyDir, 'experiments'),
        AUTONOMY_RECEIPTS_DIR: path.join(autonomyDir, 'receipts'),
        AUTONOMY_DAILY_BUDGET_DIR: path.join(autonomyDir, 'budget'),
        AUTONOMY_COOLDOWNS_PATH: path.join(autonomyDir, 'cooldowns.json'),
        AUTONOMY_SHORT_CIRCUIT_PATH: path.join(autonomyDir, 'short_circuit.json'),
        AUTONOMY_MODEL_CATALOG_ENABLED: '0',
        AUTONOMY_TIER1_GOVERNANCE_ENABLED: '0',
        AUTONOMY_DIRECTIVE_PULSE_ENABLED: '0',
        AUTONOMY_REQUIRE_READINESS_FOR_EXECUTE: '0',
        AUTONOMY_REQUIRE_SPC_FOR_EXECUTE: '0',
        AUTONOMY_SCORE_ONLY_REPEAT_PROPOSAL_LIMIT: '99',
        AUTONOMY_EVIDENCE_SAMPLE_WINDOW: '5',
        ACTUATION_ADAPTERS_CONFIG: adaptersConfigPath
      }
    });
    assert.strictEqual(evidenceRun.status, 0, `autonomy evidence failed: ${evidenceRun.stderr || evidenceRun.stdout}`);
    const out = parseLastJsonLine(evidenceRun.stdout);
    assert.ok(out && out.ok === true, `invalid autonomy output: ${evidenceRun.stdout}`);
    assert.strictEqual(String(out.result || ''), 'score_only_evidence', `expected score_only_evidence, got ${out && out.result}`);

    const runLogPath = path.join(autonomyDir, 'runs', `${date}.jsonl`);
    const runEvents = readJsonl(runLogPath);
    const evidenceEvent = [...runEvents].reverse().find((e) => e && e.type === 'autonomy_run' && e.result === 'score_only_evidence');
    assert.ok(evidenceEvent, 'expected autonomy_run score_only_evidence event');
    assert.ok(
      String(evidenceEvent.selection_mode || '').includes('evidence_sample')
      || String(evidenceEvent.selection_mode || '').includes('source_diversity_sample'),
      `expected deterministic evidence sampling mode, got ${String(evidenceEvent.selection_mode || '')}`
    );
    assert.strictEqual(String(evidenceEvent.proposal_id || ''), String(first.id), 'evidence run should execute generated proposal');

    console.log('   ✅ eyes -> queue -> enrich -> evidence pipeline is healthy');
  } finally {
    if (priorRootProposalExists) {
      fs.writeFileSync(rootProposalPath, priorRootProposal, 'utf8');
    } else if (fs.existsSync(rootProposalPath)) {
      fs.unlinkSync(rootProposalPath);
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
