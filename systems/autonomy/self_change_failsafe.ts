#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FAILSAFE_DIR = path.join(REPO_ROOT, 'state', 'autonomy', 'failsafe');
const STATE_PATH = path.join(FAILSAFE_DIR, 'self_change_state.json');
const AUDIT_PATH = path.join(FAILSAFE_DIR, 'self_change_audit.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function appendJsonl(p, obj) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
}

function rel(p) {
  return path.relative(REPO_ROOT, p).replace(/\\/g, '/');
}

function loadState() {
  return readJson(STATE_PATH, { active: null, last_stable: null });
}

function saveState(state) {
  writeJson(STATE_PATH, state);
}

function beginChange(change) {
  const state = loadState();
  state.active = {
    id: change.id,
    ts: nowIso(),
    kind: change.kind || 'self_change',
    target_path: path.resolve(change.target_path),
    snapshot_path: path.resolve(change.snapshot_path),
    note: String(change.note || '').slice(0, 240)
  };
  saveState(state);
  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    type: 'self_change_begin',
    id: state.active.id,
    kind: state.active.kind,
    target_path: rel(state.active.target_path),
    snapshot_path: rel(state.active.snapshot_path)
  });
  return state.active;
}

function completeChange(id, meta = {}) {
  const state = loadState();
  const active = state.active;
  if (!active || active.id !== id) return false;
  state.last_stable = {
    id,
    ts: nowIso(),
    kind: active.kind,
    target_path: active.target_path,
    snapshot_path: active.snapshot_path
  };
  state.active = null;
  saveState(state);
  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    type: 'self_change_complete',
    id,
    kind: active.kind,
    target_path: rel(active.target_path),
    snapshot_path: rel(active.snapshot_path),
    meta
  });
  return true;
}

function clearActiveAsRecovered(id, reason) {
  const state = loadState();
  if (state.active && state.active.id === id) {
    state.active = null;
    saveState(state);
    appendJsonl(AUDIT_PATH, {
      ts: nowIso(),
      type: 'self_change_recovered',
      id,
      reason: String(reason || 'recovered').slice(0, 240)
    });
    return true;
  }
  return false;
}

function recoverIfInterrupted() {
  const state = loadState();
  const active = state.active;
  if (!active) return { recovered: false, reason: 'no_active_change' };

  const targetPath = path.resolve(active.target_path);
  const snapshotPath = path.resolve(active.snapshot_path);
  if (!fs.existsSync(snapshotPath)) {
    return { recovered: false, reason: 'snapshot_missing', id: active.id, target_path: targetPath };
  }

  fs.copyFileSync(snapshotPath, targetPath);
  clearActiveAsRecovered(active.id, 'auto_revert_interrupted_change');
  return {
    recovered: true,
    id: active.id,
    target_path: targetPath,
    snapshot_path: snapshotPath
  };
}

function writeAtomicJson(filePath, obj) {
  const abs = path.resolve(filePath);
  const tmp = `${abs}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  ensureDir(path.dirname(abs));
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, abs);
}

module.exports = {
  beginChange,
  completeChange,
  recoverIfInterrupted,
  writeAtomicJson
};

