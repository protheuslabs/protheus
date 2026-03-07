#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function runJson(scriptPath, args, cwd, opts = {}) {
  const proc = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env }
  });
  if (opts.allowFailure !== true) {
    assert.strictEqual(proc.status, 0, `expected success: ${proc.stderr || proc.stdout}`);
  } else {
    assert.ok(proc.status === 0 || proc.status === 1, `unexpected exit code: ${proc.status}`);
  }
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected stdout');
  return JSON.parse(raw);
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const bridgeScript = path.join(repoRoot, 'systems', 'obsidian', 'obsidian_bridge.js');
  const watcherScript = path.join(repoRoot, 'systems', 'obsidian', 'vault_watcher.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-bridge-'));
  const memoryRoot = path.join(tmpRoot, 'memory');
  const notesRoot = path.join(tmpRoot, 'notes');
  const stateRoot = path.join(tmpRoot, 'state', 'obsidian');
  const projectionRoot = path.join(stateRoot, 'projections');
  const policyPath = path.join(tmpRoot, 'config', 'obsidian_bridge_policy.json');
  const notePath = path.join(memoryRoot, 'bridge-note.md');
  const deletedPath = path.join(memoryRoot, 'deleted-note.md');
  const userPath = path.join(memoryRoot, 'user-authored.md');

  writeText(notePath, '# Note\nhello\n');
  writeText(deletedPath, '# Delete me\n');
  writeText(userPath, '# User note\n');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    vault_roots: [memoryRoot, notesRoot],
    allowed_extensions: ['.md', '.canvas'],
    clearance: {
      ingest_min: 1,
      project_min: 2,
      project_elevated_min: 3
    },
    ingest: {
      dedupe_enabled: true,
      loop_suppression: true,
      ignore_projection_marker: true
    },
    projection: {
      projection_roots: [projectionRoot],
      deny_user_authored_paths: true,
      allow_elevated_override: true
    },
    outputs: {
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      ingest_path: path.join(stateRoot, 'ingest_events.jsonl'),
      latest_path: path.join(stateRoot, 'latest.json'),
      ingest_index_path: path.join(stateRoot, 'ingest_index.json')
    }
  });

  const status = runJson(bridgeScript, ['status', `--policy=${policyPath}`], repoRoot);
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.policy.shadow_only, true);

  const ingestOne = runJson(bridgeScript, [
    'ingest',
    `--policy=${policyPath}`,
    `--file=${notePath}`,
    '--action=edit',
    '--clearance=1'
  ], repoRoot);
  assert.strictEqual(ingestOne.ok, true);
  assert.ok(ingestOne.event_id);

  const ingestDup = runJson(bridgeScript, [
    'ingest',
    `--policy=${policyPath}`,
    `--file=${notePath}`,
    '--action=edit',
    '--clearance=1'
  ], repoRoot);
  assert.strictEqual(ingestDup.ok, true);
  assert.strictEqual(ingestDup.skipped, true);
  assert.strictEqual(ingestDup.reason, 'duplicate_event_id');

  fs.unlinkSync(deletedPath);
  const ingestDelete = runJson(bridgeScript, [
    'ingest',
    `--policy=${policyPath}`,
    `--file=${deletedPath}`,
    '--action=delete',
    '--clearance=1'
  ], repoRoot);
  assert.strictEqual(ingestDelete.ok, true);
  assert.ok(ingestDelete.event_id, 'delete action should still emit event id');

  const projected = runJson(bridgeScript, [
    'project',
    `--policy=${policyPath}`,
    '--title=Weekly Summary',
    '--kind=summary',
    '--content=Hello from bridge',
    '--target=summary.md',
    '--clearance=2'
  ], repoRoot);
  assert.strictEqual(projected.ok, true);
  assert.strictEqual(projected.elevated_used, false);
  const projectedFile = path.join(projectionRoot, 'summary.md');
  assert.ok(fs.existsSync(projectedFile), 'projection file should be created');
  const projectedText = fs.readFileSync(projectedFile, 'utf8');
  assert.ok(/protheus:projection/.test(projectedText), 'projection marker expected');

  const denied = runJson(bridgeScript, [
    'project',
    `--policy=${policyPath}`,
    '--title=Denied',
    '--content=Nope',
    `--target=${userPath}`,
    '--clearance=2'
  ], repoRoot, { allowFailure: true });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.reason, 'projection_target_denied');

  const elevated = runJson(bridgeScript, [
    'project',
    `--policy=${policyPath}`,
    '--title=Elevated',
    '--content=Allowed with elevated override',
    `--target=${userPath}`,
    '--elevated=1',
    '--clearance=3'
  ], repoRoot);
  assert.strictEqual(elevated.ok, true);
  assert.strictEqual(elevated.elevated_used, true);
  assert.ok(fs.existsSync(userPath), 'elevated projection should write target');

  const watcherOnce = runJson(watcherScript, [
    'run',
    `--policy=${policyPath}`,
    '--once=1',
    '--interval-ms=200'
  ], repoRoot);
  assert.strictEqual(watcherOnce.ok, true);
  assert.strictEqual(watcherOnce.mode, 'once');

  console.log('obsidian_bridge tests passed');
}

main();
