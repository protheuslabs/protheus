'use strict';

const fs = require('fs');
const ts = require('typescript');

function bootstrap(jsPath, mod) {
  const tsPath = String(jsPath || '').replace(/\.js$/i, '.ts');
  if (!tsPath || tsPath === jsPath) {
    throw new Error(`ts_bootstrap: invalid_js_path:${String(jsPath || '')}`);
  }
  if (!fs.existsSync(tsPath)) {
    throw new Error(`ts_bootstrap: missing_ts_source:${tsPath}`);
  }
  if (!mod || typeof mod._compile !== 'function') {
    throw new Error('ts_bootstrap: invalid_module');
  }

  const source = fs.readFileSync(tsPath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      sourceMap: false,
      declaration: false,
      removeComments: false
    },
    fileName: tsPath,
    reportDiagnostics: false
  }).outputText;

  mod._compile(transpiled, jsPath);
}

module.exports = {
  bootstrap
};
