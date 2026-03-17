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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-chain-rust-'));
  const runtimeRoot = path.join(workspace, 'client', 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });

  process.env.PROTHEUS_WORKSPACE_ROOT = workspace;
  process.env.PROTHEUS_RUNTIME_ROOT = runtimeRoot;
  process.env.PROTHEUS_OPS_USE_PREBUILT = '0';
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = '120000';
  delete process.env.PASSPORT_ITERATION_CHAIN_PATH;
  delete process.env.PASSPORT_ITERATION_CHAIN_LATEST_PATH;

  const mod = resetModule(path.join(ROOT, 'client', 'runtime', 'lib', 'passport_iteration_chain.ts'));
  const first = mod.recordIterationStep({
    lane: 'iterative_repair',
    step: 'triage',
    iteration: 1,
    objective_id: 'OBJ-1',
    target_path: 'adaptive/sensory/eyes/catalog.json',
    metadata: { status: 'ok', verified: true }
  });
  const second = mod.recordIterationStep({
    lane: 'iterative_repair',
    step: 'patch',
    iteration: 2,
    objective_id: 'OBJ-1',
    target_path: 'adaptive/sensory/eyes/catalog.json',
    metadata: { status: 'ok' }
  });
  const status = mod.status();

  assert.equal(first.ok, true);
  assert.equal(first.seq, 1);
  assert.equal(first.passport.skipped, true);
  assert.equal(second.seq, 2);
  assert.equal(typeof second.hash, 'string');
  assert.equal(status.total_events, 2);
  assert.equal(status.latest.step, 'patch');

  const chainPath = path.join(runtimeRoot, 'local', 'state', 'security', 'passport_iteration_chain.jsonl');
  const latestPath = path.join(runtimeRoot, 'local', 'state', 'security', 'passport_iteration_chain.latest.json');
  assert.equal(fs.existsSync(chainPath), true);
  assert.equal(fs.existsSync(latestPath), true);
  assert.equal(fs.readFileSync(chainPath, 'utf8').trim().split('\n').length, 2);

  console.log(JSON.stringify({ ok: true, type: 'passport_iteration_chain_rust_bridge_test' }));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
