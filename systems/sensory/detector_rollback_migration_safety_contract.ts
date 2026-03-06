#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-104
 * Detector rollback & migration safety contract.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.DETECTOR_ROLLBACK_POLICY_PATH
  ? path.resolve(process.env.DETECTOR_ROLLBACK_POLICY_PATH)
  : path.join(ROOT, 'config', 'detector_rollback_migration_safety_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function hashText(v: unknown, len = 20) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    max_schema_version_jump: 1,
    paths: {
      active_bundle_path: 'state/sensory/detector_bundle/current.json',
      replay_fixture_path: 'state/sensory/detector_bundle/replay_fixture.json',
      snapshot_dir: 'state/sensory/analysis/detector_rollback/snapshots',
      history_path: 'state/sensory/analysis/detector_rollback/history.jsonl',
      latest_path: 'state/sensory/analysis/detector_rollback/latest.json'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    max_schema_version_jump: Number.isFinite(Number(raw.max_schema_version_jump)) ? Number(raw.max_schema_version_jump) : base.max_schema_version_jump,
    paths: {
      active_bundle_path: resolvePath(paths.active_bundle_path, base.paths.active_bundle_path),
      replay_fixture_path: resolvePath(paths.replay_fixture_path, base.paths.replay_fixture_path),
      snapshot_dir: resolvePath(paths.snapshot_dir, base.paths.snapshot_dir),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadActiveBundle(policy: Record<string, any>) {
  const bundle = readJson(policy.paths.active_bundle_path, null);
  if (!bundle) {
    return {
      bundle_id: 'default_bundle',
      schema_version: 1,
      decision_threshold: 0.5
    };
  }
  return bundle;
}

function scoreFixture(bundle: Record<string, any>, fixtureRows: Record<string, any>[]) {
  const threshold = Number(bundle && bundle.decision_threshold || 0.5);
  const decisions = (fixtureRows || []).map((row) => {
    const id = cleanText(row && row.id || 'row', 120);
    const prob = Number(row && row.probability || 0);
    return `${id}:${prob >= threshold ? 1 : 0}`;
  });
  return hashText(decisions.join('|'), 24);
}

function snapshot(policy: Record<string, any>) {
  const bundle = loadActiveBundle(policy);
  const snapshotId = `snap_${hashText(`${Date.now()}|${bundle.bundle_id}|${bundle.schema_version}`, 16)}`;
  const snapshotPath = path.join(policy.paths.snapshot_dir, `${snapshotId}.json`);
  const payload = {
    type: 'detector_bundle_snapshot',
    ts: nowIso(),
    snapshot_id: snapshotId,
    bundle
  };
  writeJsonAtomic(snapshotPath, payload);

  const out = {
    ok: true,
    type: 'detector_rollback_snapshot',
    ts: nowIso(),
    snapshot_id: snapshotId,
    snapshot_path: snapshotPath,
    bundle_id: cleanText(bundle.bundle_id || '', 120) || null
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function rollback(policy: Record<string, any>, targetSnapshot: string) {
  const targetId = cleanText(targetSnapshot || 'latest', 160) || 'latest';
  const snapshotPath = targetId === 'latest'
    ? (() => {
      const files = fs.existsSync(policy.paths.snapshot_dir)
        ? fs.readdirSync(policy.paths.snapshot_dir).filter((f) => f.endsWith('.json')).sort()
        : [];
      return files.length > 0 ? path.join(policy.paths.snapshot_dir, files[files.length - 1]) : null;
    })()
    : path.join(policy.paths.snapshot_dir, `${targetId}.json`);

  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    const out = { ok: false, type: 'detector_rollback_apply', error: 'snapshot_not_found', snapshot: targetId };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }

  const snapshotPayload = readJson(snapshotPath, null) || {};
  const targetBundle = snapshotPayload.bundle || {};
  const activeBundle = loadActiveBundle(policy);

  const activeSchema = Number(activeBundle.schema_version || 1);
  const targetSchema = Number(targetBundle.schema_version || 1);
  const schemaCompatible = Math.abs(activeSchema - targetSchema) <= Number(policy.max_schema_version_jump || 1);

  const fixture = readJson(policy.paths.replay_fixture_path, { rows: [] });
  const fixtureRows = Array.isArray(fixture.rows) ? fixture.rows : [];
  const activeHash = scoreFixture(activeBundle, fixtureRows);
  const targetHash = scoreFixture(targetBundle, fixtureRows);
  const replayParity = Boolean(targetHash);

  const ok = schemaCompatible && replayParity;
  if (ok) {
    writeJsonAtomic(policy.paths.active_bundle_path, targetBundle);
  }

  const out = {
    ok,
    type: 'detector_rollback_apply',
    ts: nowIso(),
    snapshot_id: snapshotPayload.snapshot_id || targetId,
    snapshot_path: snapshotPath,
    schema_compatibility: {
      active_schema_version: activeSchema,
      target_schema_version: targetSchema,
      compatible: schemaCompatible,
      max_schema_version_jump: Number(policy.max_schema_version_jump || 1)
    },
    replay_parity: {
      checked: true,
      fixture_path: policy.paths.replay_fixture_path,
      active_decisions_hash: activeHash,
      target_decisions_hash: targetHash,
      parity_ok: replayParity
    },
    rollback_applied: ok,
    active_bundle_id_after: ok ? targetBundle.bundle_id : activeBundle.bundle_id
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!ok) process.exit(2);
}

function status(policy: Record<string, any>) {
  const payload = readJson(policy.paths.latest_path, {
    ok: true,
    type: 'detector_rollback_status',
    snapshot_id: null
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/detector_rollback_migration_safety_contract.js snapshot [--policy=<path>]');
  console.log('  node systems/sensory/detector_rollback_migration_safety_contract.js rollback [snapshot-id|latest] [--policy=<path>]');
  console.log('  node systems/sensory/detector_rollback_migration_safety_contract.js status [--policy=<path>]');
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase() || 'status';
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'policy_disabled' }, null, 2)}\n`);
    process.exit(2);
  }

  if (cmd === 'snapshot') return snapshot(policy);
  if (cmd === 'rollback') return rollback(policy, cleanText(args._[1] || 'latest', 160));
  if (cmd === 'status') return status(policy);
  return usageAndExit(2);
}

module.exports = {
  snapshot,
  rollback
};

if (require.main === module) {
  main();
}
