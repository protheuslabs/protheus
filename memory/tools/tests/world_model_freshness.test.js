#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(script, cwd, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function isoDaysAgo(days) {
  return new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'assimilation', 'world_model_freshness.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'world-model-freshness-'));
  const policyPath = path.join(tmp, 'config', 'world_model_freshness_policy.json');
  const profilesDir = path.join(tmp, 'state', 'assimilation', 'capability_profiles', 'profiles');

  writeJson(path.join(profilesDir, 'old_profile.json'), {
    schema_id: 'capability_profile',
    schema_version: '1.0',
    generated_at: isoDaysAgo(5),
    profile_id: 'old_profile',
    source: {
      capability_id: 'cap_old',
      source_type: 'api',
      framework: 'protheus',
      origin_ref: 'old-source'
    },
    surface: {
      auth: { mode: 'oauth2' },
      rate_limit: { hints: [] }
    },
    provenance: {
      legal: {
        tos_ok: true,
        robots_ok: true,
        data_rights_ok: true
      }
    }
  });

  writeJson(path.join(profilesDir, 'fresh_profile.json'), {
    schema_id: 'capability_profile',
    schema_version: '1.0',
    generated_at: isoDaysAgo(0.2),
    profile_id: 'fresh_profile',
    source: {
      capability_id: 'cap_fresh',
      source_type: 'api',
      framework: 'protheus',
      origin_ref: 'fresh-source'
    },
    surface: {
      auth: { mode: 'oauth2' },
      rate_limit: { hints: ['60/min'] }
    },
    provenance: {
      legal: {
        tos_ok: true,
        robots_ok: true,
        data_rights_ok: true
      }
    }
  });

  writeJson(policyPath, {
    schema_id: 'world_model_freshness_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: false,
    strict_requires_profiles: true,
    stale_after_days: 1,
    warning_after_days: 0.5,
    min_refresh_interval_hours: 0,
    freshness_slo_target: 0.4,
    max_profiles_per_run: 10,
    profile_roots: [profilesDir],
    required_surface_checks: {
      legal_ok: true,
      auth_model_present: true,
      rate_limit_hint_present: true
    },
    outputs: {
      latest_path: path.join(tmp, 'state', 'assimilation', 'world_model_freshness', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'assimilation', 'world_model_freshness', 'receipts.jsonl'),
      deltas_path: path.join(tmp, 'state', 'assimilation', 'world_model_freshness', 'deltas.jsonl'),
      compiler_queue_path: path.join(tmp, 'state', 'assimilation', 'world_model_freshness', 'compiler_queue.jsonl')
    }
  });

  const env = {
    ...process.env,
    WORLD_MODEL_REFRESH_ROOT: tmp,
    WORLD_MODEL_REFRESH_POLICY_PATH: policyPath
  };

  const runRes = run(script, repoRoot, ['run', '--apply=1', '--strict=1', `--policy=${policyPath}`], env);
  assert.strictEqual(runRes.status, 0, runRes.stderr || 'run should pass');
  assert.ok(runRes.payload && runRes.payload.ok === true, 'run payload should be ok');
  assert.strictEqual(Number(runRes.payload.profile_count || 0), 2, 'two profiles should be processed');
  assert.strictEqual(Number(runRes.payload.stale_count || 0), 1, 'one stale profile expected');
  assert.ok(Number(runRes.payload.queued_delta_count || 0) >= 1, 'compiler delta queue should have stale entry');

  const oldProfile = JSON.parse(fs.readFileSync(path.join(profilesDir, 'old_profile.json'), 'utf8'));
  assert.ok(oldProfile.freshness && oldProfile.freshness.last_refreshed_at, 'stale profile should be refreshed on apply');

  const queuePath = path.join(tmp, 'state', 'assimilation', 'world_model_freshness', 'compiler_queue.jsonl');
  const queueRows = fs.existsSync(queuePath)
    ? fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  assert.ok(queueRows.length >= 1, 'compiler queue should include at least one delta');
  assert.strictEqual(String(queueRows[0].queue_type || ''), 'world_model_freshness_delta', 'queue row type should match');

  const status = run(script, repoRoot, ['status', `--policy=${policyPath}`], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.ok(Number(status.payload.queued_delta_count_200 || 0) >= 1, 'status should include queued deltas');

  console.log('world_model_freshness.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`world_model_freshness.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
