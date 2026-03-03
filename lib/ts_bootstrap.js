'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
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

function runGlobalSecurityGate(jsPath, repoRoot) {
  if (String(process.env.PROTHEUS_SECURITY_GLOBAL_GATE || '1') === '0') {
    return;
  }
  if (String(process.env.PROTHEUS_SECURITY_GATE_BYPASS || '0') === '1') {
    return;
  }
  if (global.__protheus_security_global_gate_ok === true) {
    return;
  }

  const request = securityRequestFor(jsPath, repoRoot);
  const requestBase64 = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');

  const attempts = [];
  for (const candidate of securityBinaryCandidates(repoRoot)) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const out = spawnSync(candidate, ['check', `--request-base64=${requestBase64}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const payload = parseJsonPayload(out.stdout);
      if (Number(out.status) === 0 && payload && payload.ok === true && payload.decision && payload.decision.ok === true && payload.decision.fail_closed !== true) {
        global.__protheus_security_global_gate_ok = true;
        return;
      }
      attempts.push(`bin:${candidate}:${cleanText(out.stderr || out.stdout || '', 140)}`);
    } catch (err) {
      attempts.push(`bin:${candidate}:${cleanText(err && err.message, 140)}`);
    }
  }

  try {
    const out = spawnSync('cargo', [
      'run',
      '--quiet',
      '--manifest-path',
      path.join(repoRoot, 'crates', 'security', 'Cargo.toml'),
      '--bin',
      'security_core',
      '--',
      'check',
      `--request-base64=${requestBase64}`
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    const payload = parseJsonPayload(out.stdout);
    if (Number(out.status) === 0 && payload && payload.ok === true && payload.decision && payload.decision.ok === true && payload.decision.fail_closed !== true) {
      global.__protheus_security_global_gate_ok = true;
      return;
    }
    attempts.push(`cargo:${cleanText(out.stderr || out.stdout || '', 140)}`);
  } catch (err) {
    attempts.push(`cargo:${cleanText(err && err.message, 140)}`);
  }

  const reason = attempts.length ? attempts[0] : 'security_gate_execution_failed';
  throw new Error(`ts_bootstrap: security_global_gate_failed:${reason}`);
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
  runGlobalSecurityGate(jsPath, repoRoot);
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
