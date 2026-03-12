#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

if (!require.extensions['.ts']) {
  require.extensions['.ts'] = function compileTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        sourceMap: false,
        declaration: false
      },
      fileName: filename,
      reportDiagnostics: false
    }).outputText;
    module._compile(output, filename);
  };
}

const mod = require(path.resolve(__dirname, '..', '..', 'client', 'runtime', 'lib', 'ops_domain_conduit_runner.ts'));

function run() {
  const parsed = mod.parseArgs(['--domain', 'legacy-retired-lane', 'build', '--lane-id=FOO-1']);
  const args = mod.buildPassArgs(parsed);
  assert.deepStrictEqual(args, ['build', '--lane-id=FOO-1']);

  const parsedPositional = mod.parseArgs(['legacy-retired-lane', 'build', '--lane-id=FOO-2']);
  const positionalArgs = mod.buildPassArgs(parsedPositional);
  assert.deepStrictEqual(positionalArgs, ['build', '--lane-id=FOO-2']);
}

run();
console.log(
  JSON.stringify({
    ok: true,
    type: 'ops_domain_conduit_runner_arg_passthrough_test'
  }),
);
