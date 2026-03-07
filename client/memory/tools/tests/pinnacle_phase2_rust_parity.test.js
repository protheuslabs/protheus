#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { mergeDelta, getSovereigntyIndex } = require(path.join(ROOT, 'systems', 'pinnacle', 'index.js'));

function fail(msg) {
  console.error(`❌ pinnacle_phase2_rust_parity.test.js: ${msg}`);
  process.exit(1);
}

function ensureReleaseBinary() {
  const out = spawnSync('cargo', ['build', '--manifest-path', 'core/layer0/pinnacle/Cargo.toml', '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    fail(`cargo build failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
}

function seeded(seed) {
  let x = (seed >>> 0) ^ 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function deterministicHashKey(key, value) {
  const hash = crypto.createHash('sha256');
  hash.update(String(key));
  hash.update(stableStringify(value.payload));
  const vc = value.vector_clock && typeof value.vector_clock === 'object' ? value.vector_clock : {};
  for (const k of Object.keys(vc).sort()) {
    hash.update(`${k}:${Number(vc[k] || 0)}`);
  }
  hash.update(String(Boolean(value.signed)));
  return hash.digest('hex');
}

function vectorClockCmp(left, right) {
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  let leftGt = false;
  let rightGt = false;
  for (const key of keys) {
    const l = Number((left && left[key]) || 0);
    const r = Number((right && right[key]) || 0);
    if (l > r) leftGt = true;
    if (r > l) rightGt = true;
  }
  if (leftGt && !rightGt) return 1;
  if (!leftGt && rightGt) return -1;
  return 0;
}

function legacyMergeDelta(left, right, profile) {
  const leftChanges = left && left.changes && typeof left.changes === 'object' ? left.changes : {};
  const rightChanges = right && right.changes && typeof right.changes === 'object' ? right.changes : {};
  const keys = Array.from(new Set([...Object.keys(leftChanges), ...Object.keys(rightChanges)])).sort();

  const merged = {};
  const conflicts = [];

  for (const key of keys) {
    const lv = leftChanges[key];
    const rv = rightChanges[key];
    if (lv && rv) {
      const cmp = vectorClockCmp(lv.vector_clock || {}, rv.vector_clock || {});
      if (cmp > 0) {
        merged[key] = lv;
      } else if (cmp < 0) {
        merged[key] = rv;
      } else {
        const lh = deterministicHashKey(key, lv);
        const rh = deterministicHashKey(key, rv);
        if (lh >= rh) {
          merged[key] = lv;
          conflicts.push({
            key,
            left_clock: lv.vector_clock || {},
            right_clock: rv.vector_clock || {},
            resolver: 'deterministic_hash_tie_break_left'
          });
        } else {
          merged[key] = rv;
          conflicts.push({
            key,
            left_clock: lv.vector_clock || {},
            right_clock: rv.vector_clock || {},
            resolver: 'deterministic_hash_tie_break_right'
          });
        }
      }
    } else if (lv) {
      merged[key] = lv;
    } else if (rv) {
      merged[key] = rv;
    }
  }

  const total = Math.max(1, Object.keys(merged).length);
  const conflictRate = conflicts.length / total;
  const unsignedCount = Object.values(merged).filter((v) => !v.signed).length;
  const unsignedRate = unsignedCount / total;

  const convergenceScore = Math.max(0, Math.min(100, 100 - (conflictRate * 100)));
  const sovereigntyIndex = Math.max(
    0,
    Math.min(
      100,
      convergenceScore
      - (conflictRate * Number(profile.conflict_penalty_pct || 0))
      - (unsignedRate * Number(profile.unsigned_penalty_pct || 0) * 10)
    )
  );

  const digestLines = [];
  for (const key of Object.keys(merged).sort()) {
    const value = merged[key];
    digestLines.push(`${key}:${stableStringify(value.payload)}:${stableStringify(value.vector_clock || {})}`);
  }
  for (const c of conflicts) {
    digestLines.push(`conflict:${c.key}:${c.resolver}`);
  }
  const digest = crypto.createHash('sha256')
    .update(digestLines.map((line, idx) => `${idx}:${line}|`).join(''))
    .digest('hex');

  return {
    merged,
    conflicts,
    convergence_score_pct: round3(convergenceScore),
    sovereignty_index_pct: round3(sovereigntyIndex),
    digest,
    profile_id: profile.profile_id
  };
}

function buildDelta(seed, sideLabel) {
  const rnd = seeded(seed);
  const changes = {};
  const keyCount = 2 + Math.floor(rnd() * 4);
  for (let i = 0; i < keyCount; i += 1) {
    const key = `key_${i}`;
    changes[key] = {
      payload: {
        score: Math.floor(rnd() * 100),
        note: `${sideLabel}_${i}_${Math.floor(rnd() * 999)}`
      },
      vector_clock: {
        [sideLabel]: 1 + Math.floor(rnd() * 5),
        peer: Math.floor(rnd() * 3)
      },
      signed: rnd() > 0.28
    };
  }
  return {
    node_id: sideLabel,
    changes
  };
}

function normalizeRustMerge(raw) {
  const conflicts = Array.isArray(raw && raw.conflicts) ? raw.conflicts.map((row) => ({
    key: String(row && row.key || ''),
    left_clock: row && row.left_clock && typeof row.left_clock === 'object' ? row.left_clock : {},
    right_clock: row && row.right_clock && typeof row.right_clock === 'object' ? row.right_clock : {},
    resolver: String(row && row.resolver || '')
  })) : [];
  return {
    merged: raw && raw.merged && typeof raw.merged === 'object' ? raw.merged : {},
    conflicts,
    convergence_score_pct: round3(raw && raw.convergence_score_pct),
    sovereignty_index_pct: round3(raw && raw.sovereignty_index_pct),
    digest: String(raw && raw.digest || ''),
    profile_id: String(raw && raw.profile_id || '')
  };
}

function main() {
  ensureReleaseBinary();

  const profilePath = path.join(ROOT, 'crates', 'pinnacle', 'src', 'blobs', 'pinnacle_merge_profile.blob');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

  for (let i = 0; i < 40; i += 1) {
    const left = buildDelta(i + 11, 'device_a');
    const right = buildDelta(i + 97, 'device_b');

    const rustOut = mergeDelta(left, right, { allow_cli_fallback: true });
    if (!rustOut || rustOut.ok !== true || !rustOut.payload || typeof rustOut.payload !== 'object') {
      fail(`rust merge failed on case ${i}: ${JSON.stringify(rustOut || {})}`);
    }

    const rustNorm = normalizeRustMerge(rustOut.payload);
    const legacy = legacyMergeDelta(left, right, profile);
    assert.deepStrictEqual(rustNorm, legacy, `parity mismatch on case ${i}`);

    const idxOut = getSovereigntyIndex(left, right, { allow_cli_fallback: true });
    if (!idxOut || idxOut.ok !== true || !idxOut.payload || typeof idxOut.payload !== 'object') {
      fail(`index failed on case ${i}: ${JSON.stringify(idxOut || {})}`);
    }
    assert.strictEqual(round3(idxOut.payload.sovereignty_index_pct), legacy.sovereignty_index_pct, `index mismatch on case ${i}`);
  }

  console.log('pinnacle_phase2_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
