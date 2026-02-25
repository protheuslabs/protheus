'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

function readRuntimeModeFromState(repoRoot) {
  try {
    const statePath = process.env.PROTHEUS_RUNTIME_MODE_STATE_PATH
      ? path.resolve(process.env.PROTHEUS_RUNTIME_MODE_STATE_PATH)
      : path.join(repoRoot, 'state', 'ops', 'runtime_mode.json');
    if (!fs.existsSync(statePath)) return null;
    const payload = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const mode = String(payload && payload.mode || '').trim().toLowerCase();
    if (mode === 'dist' || mode === 'source') return mode;
    return null;
  } catch {
    return null;
  }
}

function resolveRuntimeMode(repoRoot) {
  const envMode = String(process.env.PROTHEUS_RUNTIME_MODE || '').trim().toLowerCase();
  if (envMode === 'dist' || envMode === 'source') return envMode;
  return readRuntimeModeFromState(repoRoot) || 'source';
}

function distJsPathFor(repoRoot, sourceJsPath) {
  const rel = path.relative(repoRoot, sourceJsPath);
  if (!rel || rel.startsWith('..')) return null;
  return path.join(repoRoot, 'dist', rel);
}

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

  const repoRoot = path.resolve(__dirname, '..');
  const runtimeMode = resolveRuntimeMode(repoRoot);
  if (runtimeMode === 'dist') {
    const distPath = distJsPathFor(repoRoot, jsPath);
    if (distPath && fs.existsSync(distPath)) {
      const distSource = fs.readFileSync(distPath, 'utf8');
      mod.filename = distPath;
      mod.paths = Module._nodeModulePaths(path.dirname(distPath));
      mod._compile(distSource, distPath);
      return;
    }
    if (String(process.env.PROTHEUS_RUNTIME_DIST_REQUIRED || '0') === '1') {
      throw new Error(`ts_bootstrap: missing_dist_runtime:${String(distPath || 'unknown')}`);
    }
  }

  const source = fs.readFileSync(tsPath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
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
