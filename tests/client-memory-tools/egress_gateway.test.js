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

function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-gateway-rust-'));
  const runtimeRoot = path.join(workspace, 'client', 'runtime');
  const policyPath = path.join(runtimeRoot, 'config', 'egress_gateway_policy.json');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify({
    version: '2.0',
    default_decision: 'deny',
    global_rate_caps: { per_hour: 5, per_day: 10 },
    scopes: {
      'sensory.collector.dynamic': {
        methods: ['GET'],
        domains: ['example.com'],
        require_runtime_allowlist: true,
        rate_caps: { per_hour: 2, per_day: 4 }
      }
    }
  }, null, 2));

  process.env.PROTHEUS_WORKSPACE_ROOT = workspace;
  process.env.PROTHEUS_RUNTIME_ROOT = runtimeRoot;
  process.env.EGRESS_GATEWAY_POLICY_PATH = policyPath;
  delete process.env.EGRESS_GATEWAY_STATE_PATH;
  delete process.env.EGRESS_GATEWAY_AUDIT_PATH;
  process.env.PROTHEUS_OPS_USE_PREBUILT = '0';
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = '120000';

  const mod = resetModule(path.join(ROOT, 'client', 'runtime', 'lib', 'egress_gateway.ts'));
  const policy = mod.loadPolicy();
  assert.equal(policy.version, '2.0');
  assert.equal(policy.scopes['sensory.collector.dynamic'].require_runtime_allowlist, true);

  const allowed = mod.authorizeEgress({
    scope: 'sensory.collector.market_news',
    caller: 'collector',
    runtime_allowlist: ['example.com'],
    url: 'https://example.com/data',
    method: 'GET',
    now_ms: 1000,
    apply: true
  });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.scope_resolved, 'sensory.collector.dynamic');

  const denied = mod.authorizeEgress({
    scope: 'sensory.collector.market_news',
    caller: 'collector',
    runtime_allowlist: [],
    url: 'https://example.com/data',
    method: 'GET',
    now_ms: 2000,
    apply: false
  });
  assert.equal(denied.allow, false);
  assert.equal(denied.code, 'runtime_allowlist_required');

  const state = mod.loadState();
  assert.equal(state.per_hour['sensory.collector.market_news:1970-01-01T00'], 1);

  const auditPath = path.join(runtimeRoot, 'local', 'state', 'security', 'egress_gateway', 'audit.jsonl');
  assert.equal(fs.existsSync(auditPath), true);

  console.log(JSON.stringify({ ok: true, type: 'egress_gateway_rust_bridge_test' }));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
