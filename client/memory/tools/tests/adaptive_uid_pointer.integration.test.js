#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function restore(filePath, snapshot) {
  if (snapshot == null) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, snapshot, 'utf8');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const intakePath = path.join(repoRoot, 'systems', 'sensory', 'eyes_intake.js');
  const catalogPath = path.join(repoRoot, 'adaptive', 'sensory', 'eyes', 'catalog.json');
  const registryPath = path.join(repoRoot, 'state', 'sensory', 'eyes', 'registry.json');
  const pointersPath = path.join(repoRoot, 'client', 'local', 'state', 'memory', 'adaptive_pointers.jsonl');
  const pointerIndexPath = path.join(repoRoot, 'client', 'local', 'state', 'memory', 'adaptive_pointer_index.json');

  const beforeCatalog = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf8') : null;
  const beforeRegistry = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, 'utf8') : null;
  const beforePointers = fs.existsSync(pointersPath) ? fs.readFileSync(pointersPath, 'utf8') : null;
  const beforePointerIndex = fs.existsSync(pointerIndexPath) ? fs.readFileSync(pointerIndexPath, 'utf8') : null;

  const stamp = Date.now();
  const eyeName = `UID Pointer Eye ${stamp}`;
  const eyeId = `uid_pointer_eye_${stamp}`;

  try {
    writeJson(catalogPath, {
      version: '1.0',
      eyes: [],
      global_limits: { max_concurrent_runs: 3, global_max_requests_per_day: 50, global_max_bytes_per_day: 5242880 },
      scoring: { ema_alpha: 0.3, score_threshold_high: 70, score_threshold_low: 30, score_threshold_dormant: 20, cadence_min_hours: 1, cadence_max_hours: 168 }
    });
    writeJson(registryPath, { version: '1.0', last_updated: new Date().toISOString(), eyes: [] });
    if (fs.existsSync(pointersPath)) fs.rmSync(pointersPath, { force: true });
    if (fs.existsSync(pointerIndexPath)) fs.rmSync(pointerIndexPath, { force: true });

    const env = {
      ...process.env,
      EYES_INTAKE_SKIP_GUARD: '1',
      EYES_INTAKE_ALLOWED_DIRECTIVES: 'T1_make_jay_billionaire_v1'
    };

    const create = spawnSync(process.execPath, [
      intakePath,
      'create',
      `--id=${eyeId}`,
      `--name=${eyeName}`,
      '--parser=hn_rss',
      '--directive=T1_make_jay_billionaire_v1',
      '--domains=example.com'
    ], { cwd: repoRoot, encoding: 'utf8', env });
    assert.strictEqual(create.status, 0, create.stderr || 'eye create failed');

    const catalog = readJson(catalogPath, {});
    const eye = Array.isArray(catalog.eyes) ? catalog.eyes.find((e) => String(e && e.id) === eyeId) : null;
    assert.ok(eye, 'eye should be present in adaptive catalog');
    assert.ok(/^[A-Za-z0-9]+$/.test(String(eye.uid || '')), 'eye uid should be alphanumeric');

    const pointers = readJsonl(pointersPath);
    const pointer = pointers.find((p) => String(p && p.entity_id) === eyeId);
    assert.ok(pointer, 'adaptive pointer should be emitted');
    assert.strictEqual(String(pointer.kind), 'adaptive_eye');
    assert.strictEqual(String(pointer.uid), String(eye.uid));

    console.log('adaptive_uid_pointer.integration.test.js: OK');
  } finally {
    restore(catalogPath, beforeCatalog);
    restore(registryPath, beforeRegistry);
    restore(pointersPath, beforePointers);
    restore(pointerIndexPath, beforePointerIndex);
  }
}

try {
  run();
} catch (err) {
  console.error(`adaptive_uid_pointer.integration.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
