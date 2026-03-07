#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'sensory', 'eyes_intake.js');
  const configPath = path.join(repoRoot, 'adaptive', 'sensory', 'eyes', 'catalog.json');
  const registryPath = path.join(repoRoot, 'state', 'sensory', 'eyes', 'registry.json');
  const configBefore = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
  const registryBefore = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, 'utf8') : null;
  const stamp = Date.now();
  const eyeName = `Test Eye ${stamp}`;
  const eyeId = `test_eye_${stamp}`;

  try {
    // Ensure deterministic baseline for test assertions.
    writeJson(configPath, {
      version: '1.0',
      eyes: [],
      global_limits: { max_concurrent_runs: 3, global_max_requests_per_day: 50, global_max_bytes_per_day: 5242880 },
      scoring: { ema_alpha: 0.3, score_threshold_high: 70, score_threshold_low: 30, score_threshold_dormant: 20, cadence_min_hours: 1, cadence_max_hours: 168 }
    });
    writeJson(registryPath, { version: '1.0', last_updated: new Date().toISOString(), eyes: [] });

    const env = {
      ...process.env,
      EYES_INTAKE_SKIP_GUARD: '1',
      EYES_INTAKE_ALLOWED_DIRECTIVES: 'T1_make_jay_billionaire_v1'
    };

    const ok = spawnSync(process.execPath, [
      scriptPath,
      'create',
      `--name=${eyeName}`,
      '--parser=hn_rss',
      '--directive=T1_make_jay_billionaire_v1',
      '--domains=example.com,news.ycombinator.com',
      '--topics=market,signal',
      '--strategy=strategy_alpha',
      '--campaigns=camp_launch,camp_scale'
    ], { cwd: repoRoot, encoding: 'utf8', env });
    assert.strictEqual(ok.status, 0, `create should pass: ${ok.stderr}`);

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(Array.isArray(cfg.eyes), true);
    assert.strictEqual(cfg.eyes.length, 1);
    assert.strictEqual(cfg.eyes[0].id, eyeId);
    assert.strictEqual(cfg.eyes[0].directive_ref, 'T1_make_jay_billionaire_v1');
    assert.strictEqual(cfg.eyes[0].status, 'probation');
    assert.strictEqual(cfg.eyes[0].strategy_id, 'strategy_alpha');
    assert.deepStrictEqual(cfg.eyes[0].campaign_ids, ['camp_launch', 'camp_scale']);

    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.strictEqual(Array.isArray(reg.eyes), true);
    assert.strictEqual(reg.eyes.length, 1);
    assert.strictEqual(reg.eyes[0].id, eyeId);
    assert.strictEqual(reg.eyes[0].strategy_id, 'strategy_alpha');
    assert.deepStrictEqual(reg.eyes[0].campaign_ids, ['camp_launch', 'camp_scale']);

    const dup = spawnSync(process.execPath, [
      scriptPath,
      'create',
      `--name=${eyeName}`,
      '--parser=hn_rss',
      '--directive=T1_make_jay_billionaire_v1',
      '--domains=example.com'
    ], { cwd: repoRoot, encoding: 'utf8', env });
    assert.notStrictEqual(dup.status, 0, 'duplicate id should fail');

    const badDirective = spawnSync(process.execPath, [
      scriptPath,
      'validate',
      '--directive=T1_not_active'
    ], { cwd: repoRoot, encoding: 'utf8', env });
    assert.notStrictEqual(badDirective.status, 0, 'inactive directive should fail');

    console.log('eyes_intake.test.js: OK');
  } finally {
    if (configBefore == null) {
      if (fs.existsSync(configPath)) fs.rmSync(configPath, { force: true });
    } else {
      fs.writeFileSync(configPath, configBefore, 'utf8');
    }
    if (registryBefore == null) {
      if (fs.existsSync(registryPath)) fs.rmSync(registryPath, { force: true });
    } else {
      fs.writeFileSync(registryPath, registryBefore, 'utf8');
    }
  }
}

try {
  run();
} catch (err) {
  console.error(`eyes_intake.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
