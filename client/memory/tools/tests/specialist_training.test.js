#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'nursery', 'specialist_training.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p, obj) {
  mkDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function writeJsonl(p, rows) {
  mkDir(path.dirname(p));
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(p, body + (body ? '\n' : ''), 'utf8');
}

function writeText(p, text) {
  mkDir(path.dirname(p));
  fs.writeFileSync(p, String(text || ''), 'utf8');
}

function parsePayload(stdout) {
  const out = String(stdout || '').trim();
  try { return JSON.parse(out); } catch {}
  const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
    payload: parsePayload(r.stdout)
  };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specialist-training-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const outDir = path.join(tmp, 'state', 'nursery', 'training');
  const hardwarePlanPath = path.join(tmp, 'state', 'routing', 'hardware_plan.json');
  const valueAttributionPolicyPath = path.join(tmp, 'config', 'value_attribution_primitive_policy.json');
  const valueAttributionRecordsPath = path.join(tmp, 'state', 'assimilation', 'value_attribution', 'records.jsonl');
  const mockAxolotlScriptPath = path.join(tmp, 'mock_axolotl_trainer.js');
  const date = '2026-02-25';

  writeText(mockAxolotlScriptPath, [
    '#!/usr/bin/env node',
    '\'use strict\';',
    'const fs = require(\'fs\');',
    'const path = require(\'path\');',
    'const args = process.argv.slice(2);',
    'let outputDir = \'\';',
    'for (let i = 0; i < args.length; i += 1) {',
    '  if (args[i] === \'--output-dir\' && args[i + 1]) outputDir = args[i + 1];',
    '}',
    'outputDir = outputDir || process.env.NURSERY_TRAINER_OUTPUT_DIR || \'\';',
    'if (!outputDir) {',
    '  console.log(JSON.stringify({ ok: false, error: \'output_dir_required\' }));',
    '  process.exit(2);',
    '}',
    'fs.mkdirSync(outputDir, { recursive: true });',
    'const checkpointArtifactPath = path.join(outputDir, \'model.safetensors\');',
    'fs.writeFileSync(checkpointArtifactPath, \'axolotl-mock-checkpoint\\n\', \'utf8\');',
    'const payload = {',
    '  ok: true,',
    '  train_loss: 0.31,',
    '  eval_loss: 0.29,',
    '  quality: 0.91,',
    '  safety: 0.97,',
    '  regression_rate: 0.04,',
    '  tokens_seen: 40960,',
    '  training_minutes: 4.25,',
    '  checkpoint_artifact_path: checkpointArtifactPath',
    '};',
    'const resultPath = process.env.NURSERY_TRAINER_RESULT_PATH || \'\';',
    'if (resultPath) {',
    '  fs.mkdirSync(path.dirname(resultPath), { recursive: true });',
    '  fs.writeFileSync(resultPath, JSON.stringify(payload, null, 2) + \'\\n\', \'utf8\');',
    '}',
    'console.log(JSON.stringify(payload));'
  ].join('\n'));
  fs.chmodSync(mockAxolotlScriptPath, 0o755);

  writeJson(policyPath, {
    version: '1.1',
    seed_id_default: 'tinyllama_seed',
    curation: {
      min_rows: 2,
      max_rows: 50,
      include_outcomes: ['shipped', 'no_change', 'reverted']
    },
    profiles: {
      small: {
        adapter: 'lora',
        rank: 8,
        alpha: 16,
        batch_size: 4,
        epochs: 1,
        max_train_minutes: 10,
        max_ram_gb: 8,
        max_gpu_vram_gb: 0
      }
    },
    promotion_thresholds: {
      min_quality: 0.8,
      min_safety: 0.9,
      max_cost_per_1k: 0.05,
      max_latency_ms: 150
    },
    promotion_controls: {
      min_eval_samples: 8,
      min_dataset_rows: 2,
      max_drift_delta: 0.2,
      max_regression_rate: 0.3,
      cooldown_hours: 1,
      require_checkpoint_parent: true
    },
    training_backend: {
      default_backend: 'native',
      auto_select_by_hardware_class: true,
      allow_backend_fallback: false,
      backend_by_hardware_class: {
        small: 'native',
        medium: 'axolotl',
        large: 'axolotl'
      },
      native: {
        enabled: true
      },
      axolotl: {
        enabled: true,
        command: process.execPath,
        args: [mockAxolotlScriptPath],
        config_arg: '--config',
        output_arg: '--output-dir',
        timeout_ms: 120000,
        attribution_creator_id: 'axolotl',
        attribution_license: 'apache-2.0'
      }
    }
  });

  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    {
      ts: `${date}T00:00:00.000Z`,
      type: 'autonomy_run',
      outcome: 'shipped',
      proposal_type: 'external_intel',
      objective_id: 'objective_a',
      strategy_rank: { components: { value_currency: 'delivery' } }
    },
    {
      ts: `${date}T01:00:00.000Z`,
      type: 'autonomy_run',
      outcome: 'no_change',
      proposal_type: 'external_intel',
      objective_id: 'objective_a',
      strategy_rank: { components: { value_currency: 'delivery' } }
    }
  ]);

  writeJson(hardwarePlanPath, {
    summary: {
      class: 'small'
    }
  });

  writeJson(valueAttributionPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    scoring: {
      default_weight: 1,
      default_confidence: 0.8,
      default_impact: 0.7
    },
    passport: {
      enabled: false,
      source: 'value_attribution_primitive'
    },
    helix: {
      enabled: false,
      events_path: path.join(tmp, 'state', 'helix', 'events.jsonl')
    },
    state: {
      root: path.join(tmp, 'state', 'assimilation', 'value_attribution'),
      records_path: valueAttributionRecordsPath,
      latest_path: path.join(tmp, 'state', 'assimilation', 'value_attribution', 'latest.json'),
      history_path: path.join(tmp, 'state', 'assimilation', 'value_attribution', 'history.jsonl'),
      receipts_path: path.join(tmp, 'state', 'assimilation', 'value_attribution', 'receipts.jsonl')
    }
  });

  const evalPath = path.join(tmp, 'eval.json');
  writeJson(evalPath, {
    quality: 0.91,
    safety: 0.97,
    cost_per_1k: 0.02,
    latency_ms: 90,
    eval_samples: 12,
    training_dataset_rows: 4,
    drift_delta: 0.03,
    regression_rate: 0.08,
    checkpoint_parent: 'seed_base'
  });

  const env = {
    NURSERY_TRAINING_POLICY_PATH: policyPath,
    NURSERY_TRAINING_RUNS_DIR: runsDir,
    NURSERY_TRAINING_OUT_DIR: outDir,
    NURSERY_TRAINING_HARDWARE_PLAN_PATH: hardwarePlanPath,
    VALUE_ATTRIBUTION_POLICY_PATH: valueAttributionPolicyPath
  };

  try {
    let r = run(['curate', date, '--days=1', '--write=1'], env);
    assert.strictEqual(r.status, 0, `curate should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'curate should pass min rows');
    assert.ok(r.payload.dataset_path, 'curate should write dataset path');
    const datasetPath = path.join(ROOT, r.payload.dataset_path);
    const datasetRows = String(fs.readFileSync(datasetPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(datasetRows.length >= 1, 'curated dataset should contain rows');
    const firstDatasetRow = datasetRows[0];
    assert.ok(firstDatasetRow.training_conduit, 'dataset rows should include training conduit metadata');
    assert.strictEqual(
      firstDatasetRow.training_conduit && firstDatasetRow.training_conduit.validation && firstDatasetRow.training_conduit.validation.ok,
      true,
      'training conduit metadata should validate'
    );
    assert.ok(firstDatasetRow.trainability, 'dataset rows should include trainability decision');
    assert.strictEqual(firstDatasetRow.trainability.allow, true, 'internal curated rows should be trainable by default matrix');

    r = run(['plan', '--profile=small', '--seed=tinyllama_seed'], env);
    assert.strictEqual(r.status, 0, `plan should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'plan should pass');
    assert.strictEqual(r.payload.plan.adapter, 'lora', 'small profile should use lora');

    r = run(['train', '--date=2026-02-25', '--days=1', '--profile=small', '--seed=tinyllama_seed'], env);
    assert.strictEqual(r.status, 0, `train should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'train should produce checkpoint');
    assert.ok(r.payload && r.payload.checkpoint_path, 'train should emit checkpoint path');
    assert.ok(r.payload && r.payload.trainer_backend, 'train should include trainer backend');
    assert.strictEqual(
      String(r.payload.trainer_backend.selected_backend || ''),
      'native',
      'default small hardware run should use native trainer backend'
    );
    assert.ok(r.payload && r.payload.training_metrics, 'train should emit backend metrics');
    assert.ok(Number(r.payload.training_metrics.train_loss || 0) > 0, 'train metrics should include train_loss');
    assert.ok(r.payload && r.payload.checkpoints_index_path, 'train should emit checkpoints index');
    assert.ok(r.payload && r.payload.promotion_manifest_path, 'train should emit promotion manifest');
    const trainCheckpointPath = path.join(ROOT, r.payload.checkpoint_path);
    const checkpointsIndexPath = path.join(ROOT, r.payload.checkpoints_index_path);
    const promotionManifestPath = path.join(ROOT, r.payload.promotion_manifest_path);
    const quarantineStatePath = path.join(outDir, 'quarantine_state.json');
    assert.ok(fs.existsSync(trainCheckpointPath), 'train checkpoint artifact should exist');
    assert.ok(fs.existsSync(checkpointsIndexPath), 'checkpoints index should exist');
    assert.ok(fs.existsSync(promotionManifestPath), 'promotion manifest should exist');
    assert.ok(fs.existsSync(quarantineStatePath), 'quarantine state should be produced');
    const queueRows = String(fs.readFileSync(path.join(outDir, 'workflow_learning_queue.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(queueRows.length >= 1, 'training queue should include at least one row');
    const latestQueue = queueRows[queueRows.length - 1];
    assert.ok(Number(latestQueue.score || 0) > 0, 'queue score should be backend-derived');
    assert.ok(
      latestQueue.metrics && Number(latestQueue.metrics.train_loss || 0) > 0,
      'queue metrics should include backend-derived train_loss'
    );
    const checkpointsIndex = JSON.parse(fs.readFileSync(checkpointsIndexPath, 'utf8'));
    assert.ok(
      checkpointsIndex
      && checkpointsIndex.checkpoints
      && Object.keys(checkpointsIndex.checkpoints).length >= 1,
      'checkpoints index should have at least one checkpoint'
    );
    const quarantineState = JSON.parse(fs.readFileSync(quarantineStatePath, 'utf8'));
    assert.ok(
      quarantineState
      && quarantineState.checkpoints
      && Object.keys(quarantineState.checkpoints).length >= 1,
      'quarantine state should include staged checkpoints'
    );

    r = run([
      'train',
      '--date=2026-02-25',
      '--days=1',
      '--profile=small',
      '--seed=tinyllama_seed',
      '--backend=axolotl'
    ], env);
    assert.strictEqual(r.status, 0, `axolotl train should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'axolotl train should succeed');
    assert.strictEqual(
      String(r.payload && r.payload.trainer_backend && r.payload.trainer_backend.selected_backend || ''),
      'axolotl',
      'explicit backend selection should use axolotl'
    );
    assert.ok(
      r.payload && r.payload.trainer_backend && r.payload.trainer_backend.config_path,
      'axolotl run should emit generated config path'
    );
    assert.ok(
      r.payload && r.payload.value_attribution && r.payload.value_attribution.attribution_id,
      'axolotl run should emit attribution record'
    );
    const attributionRows = String(fs.readFileSync(valueAttributionRecordsPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(
      attributionRows.some((row) => {
        const sourceId = String(
          row
          && row.provenance
          && row.provenance.source
          && row.provenance.source.source_id
          || ''
        );
        return sourceId === 'axolotl';
      }),
      'attribution ledger should include axolotl-tagged record'
    );

    const blockedPolicyPath = path.join(tmp, 'policy_blocked_axolotl.json');
    const blockedPolicy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    blockedPolicy.training_backend.allow_backend_fallback = false;
    blockedPolicy.training_backend.axolotl.command = path.join(tmp, 'missing_axolotl_binary');
    blockedPolicy.training_backend.axolotl.args = ['train'];
    writeJson(blockedPolicyPath, blockedPolicy);
    r = run([
      'train',
      '--date=2026-02-25',
      '--days=1',
      '--profile=small',
      '--seed=tinyllama_seed',
      '--backend=axolotl'
    ], {
      ...env,
      NURSERY_TRAINING_POLICY_PATH: blockedPolicyPath
    });
    assert.notStrictEqual(r.status, 0, 'axolotl command missing should fail closed');
    assert.ok(
      r.payload && (r.payload.error === 'trainer_backend_blocked' || r.payload.error === 'trainer_backend_failed'),
      'missing backend command should report backend error'
    );

    r = run(['evaluate', `--eval-file=${evalPath}`], env);
    assert.strictEqual(r.status, 0, `evaluate should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'evaluation should pass thresholds');

    r = run([
      'promote',
      '--checkpoint=ckpt_001',
      '--parent=seed_base',
      `--eval-file=${evalPath}`,
      '--actor-id=ml_ops_test',
      '--actor-roles=ml_operator',
      '--mfa-token=otp_222222',
      '--tenant-id=tenant_alpha'
    ], env);
    assert.strictEqual(r.status, 0, `promote should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.promoted === true, 'promote should be true for passing eval');
    assert.ok(r.payload && r.payload.promotion_manifest_path, 'promotion should emit manifest path');

    r = run([
      'promote',
      '--checkpoint=ckpt_002',
      '--parent=seed_base',
      `--eval-file=${evalPath}`,
      '--actor-id=ml_ops_test',
      '--actor-roles=ml_operator',
      '--mfa-token=otp_222222',
      '--tenant-id=tenant_alpha'
    ], env);
    assert.notStrictEqual(r.status, 0, 'cooldown should block immediate second promotion');
    assert.ok(r.payload && r.payload.ok === false, 'cooldown block should fail promotion');

    writeJson(evalPath, {
      quality: 0.6,
      safety: 0.8,
      cost_per_1k: 0.1,
      latency_ms: 300,
      eval_samples: 3,
      training_dataset_rows: 1,
      drift_delta: 0.5,
      regression_rate: 0.6,
      checkpoint_parent: ''
    });
    r = run([
      'promote',
      '--checkpoint=ckpt_bad',
      '--parent=',
      `--eval-file=${evalPath}`,
      '--actor-id=ml_ops_test',
      '--actor-roles=ml_operator',
      '--mfa-token=otp_222222',
      '--tenant-id=tenant_alpha'
    ], env);
    assert.notStrictEqual(r.status, 0, 'promote should fail strict defaults on bad eval');
    assert.ok(r.payload && r.payload.ok === false, 'bad evaluation should fail');

    console.log('specialist_training.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`specialist_training.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
