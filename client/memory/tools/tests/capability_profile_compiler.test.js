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

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJson(proc, label) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label}: expected stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function assertOk(proc, label) {
  assert.strictEqual(proc.status, 0, `${label} failed: ${proc.stderr || proc.stdout}`);
  const out = parseJson(proc, label);
  assert.strictEqual(out.ok, true, `${label} expected ok=true`);
  return out;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'assimilation', 'capability_profile_compiler.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-profile-'));
  const policyPath = path.join(tmp, 'config', 'capability_profile_policy.json');
  const schemaPath = path.join(tmp, 'config', 'capability_profile_schema.json');
  const stateRoot = path.join(tmp, 'state', 'assimilation', 'capability_profiles');
  const profileInputPath = path.join(tmp, 'profile_input.json');

  writeJson(schemaPath, {
    schema_id: 'capability_profile',
    schema_version: '1.0',
    required_top_level: ['profile_id', 'schema_version', 'generated_at', 'source', 'surface', 'provenance'],
    required_source_fields: ['capability_id', 'source_type'],
    surface_contract: {
      required_sections: ['api', 'auth', 'rate_limit', 'error'],
      at_least_one_activity_field: ['api.endpoints', 'ui.flows']
    },
    provenance_required_fields: ['origin', 'legal', 'confidence'],
    allowed_source_types: ['local_skill', 'external_adapter', 'external_tool']
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_validation: true,
    schema_path: schemaPath,
    state: {
      root: stateRoot,
      profiles_dir: path.join(stateRoot, 'profiles'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      latest_path: path.join(stateRoot, 'latest.json')
    },
    onboarding: {
      profile_only_path_enabled: true,
      require_provenance: true,
      max_profile_aliases: 16
    }
  });

  writeJson(profileInputPath, {
    profile_id: 'tool.alpha',
    schema_version: '1.0',
    generated_at: '2026-02-27T00:00:00.000Z',
    source: {
      capability_id: 'tool.alpha',
      source_type: 'external_tool',
      framework: 'protheus'
    },
    aliases: ['alpha', 'tool_alpha'],
    surface: {
      api: {
        endpoints: [{ method: 'POST', path: '/v1/send' }],
        docs_urls: ['https://example.com/docs'],
        auth_model: 'oauth2'
      },
      ui: {
        flows: []
      },
      auth: {
        mode: 'oauth2',
        scopes: ['send:write']
      },
      rate_limit: {
        hints: ['60 req/min'],
        retry_after_supported: true
      },
      error: {
        classes: ['429', '500'],
        retryable: ['429']
      }
    },
    provenance: {
      origin: 'unit_test',
      confidence: 0.91,
      legal: {
        license: 'mit',
        tos_ok: true,
        robots_ok: true,
        data_rights_ok: true
      }
    }
  });

  const env = {
    ...process.env,
    CAPABILITY_PROFILE_POLICY_PATH: policyPath
  };

  const compiled = assertOk(runNode(script, [
    'compile',
    `--in=${profileInputPath}`,
    '--strict=1'
  ], env, root), 'compile');
  assert.strictEqual(compiled.profile_id, 'tool.alpha');
  assert.ok(compiled.profile_path, 'compile should emit profile_path');
  assert.ok(fs.existsSync(path.join(root, compiled.profile_path)), 'compiled profile should exist');

  const fromResearch = assertOk(runNode(script, [
    'from-research',
    '--capability-id=tool.beta',
    '--source-type=external_adapter',
    '--research-json={"confidence":0.8,"fit":"sufficient","properties":{"auth_model":"api_key"},"artifacts":{"sample_api_endpoints":["/v1/run"],"docs_urls":["https://example.com/api"],"rate_limits":["120/min"]},"legal_surface":{"license":"mit","tos_ok":true,"robots_ok":true,"data_rights_ok":true}}',
    '--strict=1'
  ], env, root), 'from-research');
  assert.strictEqual(fromResearch.ok, true);
  assert.strictEqual(fromResearch.profile_id, 'tool.beta');

  const status = assertOk(runNode(script, ['status'], env, root), 'status');
  assert.ok(Number(status.profiles_total || 0) >= 2, 'status should include compiled profile count');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('capability_profile_compiler.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`capability_profile_compiler.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
