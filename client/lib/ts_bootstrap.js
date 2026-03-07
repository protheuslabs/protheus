'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const ts = require('typescript');

const TS_COMPILER_OPTIONS = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  sourceMap: false,
  declaration: false,
  removeComments: false
};

let TS_REQUIRE_HOOK_INSTALLED = false;

function transpileTsSource(source, tsPath) {
  return ts.transpileModule(source, {
    compilerOptions: TS_COMPILER_OPTIONS,
    fileName: tsPath,
    reportDiagnostics: false
  }).outputText;
}

function installTsRequireHook() {
  if (TS_REQUIRE_HOOK_INSTALLED) return;
  require.extensions['.ts'] = function compileTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const transpiled = transpileTsSource(source, filename);
    module._compile(transpiled, filename);
  };
  TS_REQUIRE_HOOK_INSTALLED = true;
}

function resolveRepoRoot(startDir = __dirname) {
  let dir = path.resolve(startDir);
  while (true) {
    const cargo = path.join(dir, 'Cargo.toml');
    const coreOps = path.join(dir, 'core', 'layer0', 'ops', 'Cargo.toml');
    if (fs.existsSync(cargo) && fs.existsSync(coreOps)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(__dirname, '..', '..');
    }
    dir = parent;
  }
}

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

function cleanText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseJsonPayload(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function securityBinaryCandidates(repoRoot) {
  const explicit = cleanText(process.env.PROTHEUS_SECURITY_CORE_BIN || '', 500);
  const out = [
    explicit,
    path.join(repoRoot, 'target', 'release', 'security_core'),
    path.join(repoRoot, 'target', 'debug', 'security_core'),
    path.join(repoRoot, 'core', 'layer0', 'security', 'target', 'release', 'security_core'),
    path.join(repoRoot, 'core', 'layer0', 'security', 'target', 'debug', 'security_core'),
    path.join(repoRoot, 'crates', 'security', 'target', 'release', 'security_core'),
    path.join(repoRoot, 'crates', 'security', 'target', 'debug', 'security_core')
  ].filter(Boolean);
  return Array.from(new Set(out));
}

function securityRequestFor(jsPath, repoRoot) {
  const rel = path.relative(repoRoot, jsPath).replace(/\\/g, '/');
  const subsystem = rel.split('/')[0] || 'system';
  const h = crypto.createHash('sha256').update(`${rel}|${Date.now()}`, 'utf8').digest('hex');
  return {
    operation_id: `bootstrap_${h.slice(0, 16)}`,
    subsystem,
    action: 'module_bootstrap',
    actor: rel,
    risk_class: 'normal',
    payload_digest: `sha256:${h}`,
    tags: ['global_security_gate', 'bootstrap'],
    covenant_violation: false,
    tamper_signal: false,
    key_age_hours: 1,
    operator_quorum: 2,
    audit_receipt_nonce: `nonce-${h.slice(0, 12)}`,
    zk_proof: 'zk-bootstrap',
    ciphertext_digest: `sha256:${h.slice(0, 32)}`
  };
}

function securityGateTimeoutMs() {
  const raw = Number(process.env.PROTHEUS_SECURITY_GATE_TIMEOUT_MS || 8000);
  if (!Number.isFinite(raw)) return 8000;
  return Math.max(1000, Math.min(120000, Math.floor(raw)));
}

function securitySpawnOptions(repoRoot) {
  return {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: securityGateTimeoutMs()
  };
}

function runGlobalSecurityGate(jsPath, repoRoot) {
  if (String(process.env.PROTHEUS_SECURITY_GLOBAL_GATE || '0') === '0') {
    return;
  }
  if (global.__protheus_security_global_gate_ok === true) {
    return;
  }
  const rel = String(jsPath || '').replace(/\\/g, '/');
  throw new Error(
    `ts_bootstrap: security_global_gate_direct_exec_blocked:${cleanText(rel, 200)}:` +
    'use_conduit_authoritative_security_gate'
  );
}

function bootstrap(jsPath, mod) {
  const tsPath = String(jsPath || '').replace(/\.js$/i, '.ts');
  if (!tsPath || tsPath === jsPath) {
    throw new Error(`ts_bootstrap: invalid_js_path:${String(jsPath || '')}`);
  }
  if (!mod || typeof mod._compile !== 'function') {
    throw new Error('ts_bootstrap: invalid_module');
  }

  const repoRoot = resolveRepoRoot(__dirname);
  runGlobalSecurityGate(jsPath, repoRoot);
  const runtimeMode = resolveRuntimeMode(repoRoot);
  const distPath = distJsPathFor(repoRoot, jsPath);
  const tsExists = fs.existsSync(tsPath);

  // In migrated surfaces, TS source may be intentionally absent; prefer dist fallback.
  if (runtimeMode === 'dist' || !tsExists) {
    if (distPath && fs.existsSync(distPath)) {
      const distSource = fs.readFileSync(distPath, 'utf8');
      mod.filename = distPath;
      mod.paths = Module._nodeModulePaths(path.dirname(distPath));
      mod._compile(distSource, distPath);
      return;
    }
    if (runtimeMode === 'dist' && String(process.env.PROTHEUS_RUNTIME_DIST_REQUIRED || '0') === '1') {
      throw new Error(`ts_bootstrap: missing_dist_runtime:${String(distPath || 'unknown')}`);
    }
  }

  if (!tsExists) {
    throw new Error(`ts_bootstrap: missing_ts_source:${tsPath}`);
  }

  installTsRequireHook();
  const source = fs.readFileSync(tsPath, 'utf8');
  const transpiled = transpileTsSource(source, tsPath);

  mod._compile(transpiled, jsPath);
}

module.exports = {
  bootstrap
};
