#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

if (!require.extensions['.ts']) {
  require.extensions['.ts'] = function compileTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true
      },
      fileName: filename,
      reportDiagnostics: false
    }).outputText;
    module._compile(transpiled, filename);
  };
}

const ROOT = path.resolve(__dirname, '../..');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-suit-rust-'));
  const policyPath = path.join(workspace, 'client', 'runtime', 'config', 'mech_suit_mode_policy.json');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify({
    version: '2.0',
    enabled: true,
    eyes: {
      push_attention_queue: true,
      push_event_types: ['eye_run_failed'],
      critical_error_codes: ['auth_denied']
    }
  }, null, 2));

  process.env.OPENCLAW_WORKSPACE = workspace;
  process.env.MECH_SUIT_MODE_POLICY_PATH = policyPath;
  process.env.PROTHEUS_OPS_USE_PREBUILT = '0';
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = '120000';

  const mod = resetModule(path.join(ROOT, 'client', 'runtime', 'lib', 'mech_suit_mode.ts'));
  const policy = mod.loadMechSuitModePolicy();
  assert.equal(policy.version, '2.0');
  assert.equal(mod.approxTokenCount('abcdefgh'), 2);
  assert.equal(mod.classifySeverity('integrity failed in spine'), 'critical');
  assert.equal(mod.shouldEmitAmbientConsole('warning: retry queued', 'error', policy), false);

  const status = mod.updateMechSuitStatus('eyes', { active: true });
  assert.equal(status.active, true);

  const event = await mod.appendAttentionQueueEvent({
    type: 'eye_run_failed',
    eye_id: 'hn_frontpage',
    error: 'auth denied upstream',
    error_code: 'auth_denied'
  });
  assert.equal(event.ok, true);
  assert.equal(event.queued, true);

  const queuePath = path.join(workspace, 'client', 'runtime', 'local', 'state', 'attention', 'queue.jsonl');
  const latestPath = path.join(workspace, 'client', 'runtime', 'local', 'state', 'ops', 'mech_suit_mode', 'latest.json');
  assert.equal(fs.existsSync(queuePath), true);
  assert.equal(fs.existsSync(latestPath), true);

  console.log(JSON.stringify({ ok: true, type: 'mech_suit_mode_rust_bridge_test' }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
