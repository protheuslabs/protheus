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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-trigger-rust-'));
  const runtimeRoot = path.join(workspace, 'client', 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });

  process.env.PROTHEUS_WORKSPACE_ROOT = workspace;
  process.env.PROTHEUS_RUNTIME_ROOT = runtimeRoot;
  process.env.PROTHEUS_OPS_USE_PREBUILT = '0';
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = '120000';

  const store = resetModule(path.join(ROOT, 'core/layer1/memory_runtime/adaptive/focus_trigger_store.ts'));
  const state = store.ensureFocusState();
  assert.equal(Array.isArray(state.triggers), true);
  assert.equal(state.policy.max_triggers, 48);

  const mutated = store.mutateFocusState(null, (current) => {
    current.triggers.push({
      key: 'market volatility',
      pattern: 'volatility',
      source: 'manual',
      weight: 7
    });
    return current;
  });
  assert.equal(mutated.triggers.length, 1);
  assert.equal(mutated.triggers[0].key, 'market_volatility');

  const reread = store.readFocusState();
  assert.equal(reread.triggers[0].uid.length > 0, true);

  const mutationLogPath = path.join(runtimeRoot, 'local', 'state', 'security', 'adaptive_mutations.jsonl');
  const pointerPath = path.join(runtimeRoot, 'local', 'state', 'memory', 'adaptive_pointers.jsonl');
  const indexPath = path.join(runtimeRoot, 'local', 'state', 'memory', 'adaptive_pointer_index.json');
  assert.equal(fs.existsSync(mutationLogPath), true);
  assert.equal(fs.existsSync(pointerPath), true);
  assert.equal(fs.existsSync(indexPath), true);

  console.log(JSON.stringify({ ok: true, type: 'focus_trigger_store_rust_bridge_test' }));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
