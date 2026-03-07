#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function applyQuarantine(sentinel: AnyObj = {}, verifier: AnyObj = {}, policy: AnyObj = {}, statePath: string) {
  const shadowOnly = policy && policy.shadow_only !== false;
  const tier = String(sentinel && sentinel.tier || 'clear');
  const mismatches = Array.isArray(verifier && verifier.mismatches)
    ? verifier.mismatches
    : [];
  const isolatedFiles = mismatches
    .map((row: AnyObj) => String(row && row.file || '').trim())
    .filter(Boolean)
    .slice(0, 5000);

  const prev = readJson(statePath, {});
  const next = {
    schema_id: 'helix_quarantine_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    tier,
    shadow_only: shadowOnly,
    isolated_files: isolatedFiles,
    mode: tier === 'clear'
      ? 'idle'
      : (shadowOnly ? 'shadow_quarantine' : 'active_quarantine'),
    previous_updated_at: prev && prev.updated_at ? String(prev.updated_at) : null
  };
  writeJsonAtomic(statePath, next);
  return {
    ok: true,
    type: 'helix_quarantine',
    state_path: statePath,
    state: next
  };
}

module.exports = {
  applyQuarantine
};
