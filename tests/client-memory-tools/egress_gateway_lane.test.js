#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-fetch-rust-'));
  const runtimeRoot = path.join(workspace, 'client', 'runtime');
  const policyPath = path.join(runtimeRoot, 'config', 'egress_gateway_policy.json');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify({
    version: '1.0',
    default_decision: 'deny',
    global_rate_caps: { per_hour: 10, per_day: 20 },
    scopes: {
      test_scope: {
        methods: ['GET'],
        domains: ['127.0.0.1'],
        require_runtime_allowlist: false,
        rate_caps: { per_hour: 2, per_day: 5 }
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
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/hello`;

  try {
    const textRes = await mod.egressFetchText(url, { method: 'GET' }, {
      scope: 'test_scope',
      caller: 'egress-test'
    });
    assert.equal(textRes.status, 200);
    assert.equal(JSON.parse(textRes.text).path, '/hello');

    await assert.rejects(
      () => mod.egressFetchText('https://denied.example.com/', { method: 'GET' }, {
        scope: 'test_scope',
        caller: 'egress-test'
      }),
      (error) => {
        assert.equal(error instanceof mod.EgressGatewayError, true);
        assert.equal(error.details.code, 'domain_not_allowlisted');
        return true;
      }
    );
  } finally {
    server.close();
  }

  console.log(JSON.stringify({ ok: true, type: 'egress_gateway_fetch_rust_bridge_test' }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
