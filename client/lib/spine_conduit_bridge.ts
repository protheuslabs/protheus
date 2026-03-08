'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const DEFAULT_CONDUIT_GATE_BASE_MS = 5 * 60 * 1000;
const DEFAULT_CONDUIT_GATE_MAX_MS = 30 * 60 * 1000;
const DEFAULT_CONDUIT_GATE_THRESHOLD = 2;
const DEFAULT_CONDUIT_GATE_FAILURE_TTL_MS = 6 * 60 * 60 * 1000;

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    const cargo = path.join(dir, 'Cargo.toml');
    const coreOps = path.join(dir, 'core', 'layer0', 'ops', 'Cargo.toml');
    const legacyOps = path.join(dir, 'crates', 'ops', 'Cargo.toml');
    if (fs.existsSync(cargo) && (fs.existsSync(coreOps) || fs.existsSync(legacyOps))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function loadTsModule(modulePath) {
  const ts = require('typescript');
  const source = fs.readFileSync(modulePath, 'utf8');
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
    fileName: modulePath,
    reportDiagnostics: false
  }).outputText;
  const m = new Module(modulePath, module.parent || module);
  m.filename = modulePath;
  m.paths = Module._nodeModulePaths(path.dirname(modulePath));
  m._compile(transpiled, modulePath);
  return m.exports;
}

function loadConduitClient(root) {
  const jsCandidates = [
    path.join(root, 'client', 'systems', 'conduit', 'conduit-client.js'),
    path.join(root, 'systems', 'conduit', 'conduit-client.js')
  ];
  for (const candidate of jsCandidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }
  const tsCandidates = [
    path.join(root, 'client', 'systems', 'conduit', 'conduit-client.ts'),
    path.join(root, 'systems', 'conduit', 'conduit-client.ts')
  ];
  for (const candidate of tsCandidates) {
    if (fs.existsSync(candidate)) {
      return loadTsModule(candidate);
    }
  }
  throw new Error('conduit_client_missing');
}

function runtimeGatePath(root) {
  return path.join(root, 'client', 'local', 'state', 'conduit', 'runtime_gate.json');
}

function readRuntimeGate(root) {
  const fp = runtimeGatePath(root);
  if (!fs.existsSync(fp)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeRuntimeGate(root, payload) {
  const fp = runtimeGatePath(root);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function runtimeGateThreshold() {
  return Math.max(
    1,
    parsePositiveInt(process.env.PROTHEUS_CONDUIT_RUNTIME_GATE_THRESHOLD, DEFAULT_CONDUIT_GATE_THRESHOLD)
  );
}

function runtimeGateBaseMs() {
  return Math.max(
    5000,
    parsePositiveInt(process.env.PROTHEUS_CONDUIT_RUNTIME_GATE_BASE_MS, DEFAULT_CONDUIT_GATE_BASE_MS)
  );
}

function runtimeGateMaxMs() {
  return Math.max(
    runtimeGateBaseMs(),
    parsePositiveInt(process.env.PROTHEUS_CONDUIT_RUNTIME_GATE_MAX_MS, DEFAULT_CONDUIT_GATE_MAX_MS)
  );
}

function runtimeGateFailureTtlMs() {
  return Math.max(
    runtimeGateBaseMs() * 2,
    parsePositiveInt(
      process.env.PROTHEUS_CONDUIT_RUNTIME_GATE_FAILURE_TTL_MS,
      DEFAULT_CONDUIT_GATE_FAILURE_TTL_MS
    )
  );
}

function runtimeGateForceProbe() {
  return String(process.env.PROTHEUS_CONDUIT_FORCE_PROBE || '0').trim() === '1';
}

function runtimeGateDisabled() {
  return String(process.env.PROTHEUS_CONDUIT_RUNTIME_GATE_DISABLED || '0').trim() === '1';
}

function computeGateBackoffMs(consecutiveFailures) {
  const base = runtimeGateBaseMs();
  const max = runtimeGateMaxMs();
  if (consecutiveFailures <= 1) return base;
  const scaled = base * Math.pow(2, Math.min(8, Math.max(0, consecutiveFailures - 1)));
  return Math.min(max, Math.floor(scaled));
}

function timeoutLikeError(text) {
  const normalized = String(text || '').toLowerCase();
  return normalized.includes('conduit_stdio_timeout:')
    || normalized.includes('conduit_bridge_timeout:')
    || normalized.includes('_bridge_timeout:')
    || normalized.includes('bridge_wait_failed')
    || normalized.includes('conduit_stdio_exit:')
    || normalized.includes('conduit_stdio_error:');
}

function buildGateActiveError(root) {
  if (runtimeGateDisabled() || runtimeGateForceProbe()) return null;
  const gate = readRuntimeGate(root);
  if (!gate || typeof gate !== 'object') return null;
  const blockedUntilMs = Number(gate.blocked_until_ms || 0);
  if (!Number.isFinite(blockedUntilMs) || blockedUntilMs <= Date.now()) {
    const hadActiveWindow = gate.gate_active === true || blockedUntilMs > 0;
    if (hadActiveWindow) clearRuntimeGateIfSet(root);
    return null;
  }
  const blockedUntilIso = new Date(blockedUntilMs).toISOString();
  const remainingMs = Math.max(0, blockedUntilMs - Date.now());
  const reason = `conduit_runtime_gate_active_until:${blockedUntilIso}`;
  return {
    reason,
    remainingMs,
    gate
  };
}

function clearRuntimeGateIfSet(root) {
  if (runtimeGateDisabled()) return;
  const existing = readRuntimeGate(root);
  if (!existing) return;
  const hasFailures = Number(existing.consecutive_failures || 0) > 0;
  if (!hasFailures && existing.gate_active !== true) return;
  writeRuntimeGate(root, {
    schema_version: '1.0',
    updated_at: new Date().toISOString(),
    last_error: null,
    last_failure_at: null,
    consecutive_failures: 0,
    blocked_until_ms: 0,
    blocked_until: null,
    gate_active: false
  });
}

function recordRuntimeGateFailure(root, errorText) {
  if (runtimeGateDisabled()) return;
  if (!timeoutLikeError(errorText)) return;

  const now = Date.now();
  const existing = readRuntimeGate(root) || {};
  const previousBlockedUntil = Number(existing.blocked_until_ms || 0);
  const previousFailureAtMs = Date.parse(String(existing.last_failure_at || ''));
  const previousFailureStale = Number.isFinite(previousFailureAtMs)
    ? (now - previousFailureAtMs) > runtimeGateFailureTtlMs()
    : true;
  const previousWindowExpired = Number.isFinite(previousBlockedUntil)
    && previousBlockedUntil > 0
    && previousBlockedUntil <= now;
  const previousFailures = (previousFailureStale || previousWindowExpired)
    ? 0
    : Number(existing.consecutive_failures || 0);
  const consecutiveFailures = Number.isFinite(previousFailures) && previousFailures > 0
    ? previousFailures + 1
    : 1;
  const threshold = runtimeGateThreshold();
  const shouldActivate = consecutiveFailures >= threshold;
  const backoffMs = shouldActivate ? computeGateBackoffMs(consecutiveFailures) : 0;
  const blockedUntilMs = shouldActivate ? now + backoffMs : 0;

  writeRuntimeGate(root, {
    schema_version: '1.0',
    updated_at: new Date(now).toISOString(),
    last_error: String(errorText || '').slice(0, 500),
    last_failure_at: new Date(now).toISOString(),
    consecutive_failures: consecutiveFailures,
    blocked_until_ms: blockedUntilMs,
    blocked_until: blockedUntilMs > 0 ? new Date(blockedUntilMs).toISOString() : null,
    gate_active: shouldActivate,
    threshold,
    base_backoff_ms: runtimeGateBaseMs(),
    max_backoff_ms: runtimeGateMaxMs()
  });
}

function daemonCommand(root) {
  if (process.env.PROTHEUS_CONDUIT_DAEMON_COMMAND) {
    return process.env.PROTHEUS_CONDUIT_DAEMON_COMMAND;
  }
  const releaseBin = path.join(root, 'target', 'release', 'conduit_daemon');
  if (fs.existsSync(releaseBin)) return releaseBin;
  const debugBin = path.join(root, 'target', 'debug', 'conduit_daemon');
  return fs.existsSync(debugBin) ? debugBin : 'cargo';
}

function daemonArgs(command) {
  const raw = process.env.PROTHEUS_CONDUIT_DAEMON_ARGS;
  if (raw && String(raw).trim()) {
    return String(raw).trim().split(/\s+/).filter(Boolean);
  }
  return command === 'cargo'
    ? ['run', '--quiet', '-p', 'conduit', '--bin', 'conduit_daemon']
    : [];
}

function buildAgentId(commandArgs, opts = {}) {
  const payload = {
    type: 'spine_command',
    args: Array.isArray(commandArgs) ? commandArgs.map((row) => String(row)) : [],
    run_context: opts.runContext == null ? null : String(opts.runContext)
  };
  return `edge_json:${JSON.stringify(payload)}`;
}

function buildAttentionAgentId(commandArgs) {
  const payload = {
    type: 'attention_command',
    args: Array.isArray(commandArgs) ? commandArgs.map((row) => String(row)) : []
  };
  return `edge_json:${JSON.stringify(payload)}`;
}

function buildPersonaAmbientAgentId(commandArgs) {
  const payload = {
    type: 'persona_ambient_command',
    args: Array.isArray(commandArgs) ? commandArgs.map((row) => String(row)) : []
  };
  return `edge_json:${JSON.stringify(payload)}`;
}

function buildDopamineAmbientAgentId(commandArgs) {
  const payload = {
    type: 'dopamine_ambient_command',
    args: Array.isArray(commandArgs) ? commandArgs.map((row) => String(row)) : []
  };
  return `edge_json:${JSON.stringify(payload)}`;
}

function buildMemoryAmbientAgentId(commandArgs) {
  const payload = {
    type: 'memory_ambient_command',
    args: Array.isArray(commandArgs) ? commandArgs.map((row) => String(row)) : []
  };
  return `edge_json:${JSON.stringify(payload)}`;
}

function buildOpsDomainAgentId(domain, commandArgs, opts = {}) {
  const payload = {
    type: 'ops_domain_command',
    domain: String(domain || '').trim(),
    args: Array.isArray(commandArgs) ? commandArgs.map((row) => String(row)) : [],
    run_context: opts.runContext == null ? null : String(opts.runContext)
  };
  return `edge_json:${JSON.stringify(payload)}`;
}

const RISKY_ENV_TOGGLE_KEYS = [
  'AUTONOMY_ENABLED',
  'AUTONOMY_MODEL_CATALOG_AUTO_APPLY',
  'AUTONOMY_MODEL_CATALOG_AUTO_BREAK_GLASS',
  'REMOTE_DIRECT_OVERRIDE',
  'BREAK_GLASS',
  'ALLOW_MISSING_DIRECTIVES',
  'ALLOW_WEAK_T1_DIRECTIVES'
];

function compatFallbackEnabled() {
  const raw = String(process.env.PROTHEUS_CONDUIT_COMPAT_FALLBACK || '1').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

function compatTimeoutMs(opts = {}) {
  const fallback = 120000;
  const requested = Number(
    opts.timeoutMs
    || process.env.PROTHEUS_CONDUIT_COMPAT_TIMEOUT_MS
    || process.env.PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS
    || fallback
  );
  const n = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : fallback;
  return Math.max(1000, Math.min(30 * 60 * 1000, n));
}

function parseJsonPayload(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function decodeEdgePayload(agentId) {
  const raw = String(agentId || '').trim();
  if (!raw.startsWith('edge_json:')) return null;
  const encoded = raw.slice('edge_json:'.length);
  try {
    const parsed = JSON.parse(encoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeSpineCompatArgs(args) {
  const rows = Array.isArray(args) ? args.map((row) => String(row)) : [];
  if (!rows.length) return ['status'];
  const head = String(rows[0] || '').trim().toLowerCase();
  if (head === 'status') return rows;
  if (head === 'daily' || head === 'eyes') return rows;
  if (head !== 'run') return rows;

  const modeRaw = String(rows[1] || '').trim().toLowerCase();
  const mode = modeRaw === 'eyes' ? 'eyes' : 'daily';
  const dateToken = String(rows[2] || '').trim();
  const normalized = [mode];
  const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(dateToken);
  if (hasDate) normalized.push(dateToken);
  const restStart = hasDate ? 3 : 2;
  for (let i = restStart; i < rows.length; i += 1) {
    normalized.push(rows[i]);
  }
  return normalized;
}

function runCompatNodeScript(root, scriptRelPath, scriptArgs = [], options = {}) {
  const scriptAbs = path.join(root, scriptRelPath);
  if (!fs.existsSync(scriptAbs)) {
    return {
      ok: false,
      status: 1,
      payload: null,
      stdout: '',
      stderr: `compat_script_missing:${scriptRelPath}`,
      timed_out: false,
      error: null
    };
  }

  const cwd = options.cwd || root;
  const env = { ...process.env, ...(options.env || {}) };
  if (Array.isArray(options.unsetEnv)) {
    for (const key of options.unsetEnv) {
      const token = String(key || '').trim();
      if (!token) continue;
      delete env[token];
    }
  }
  const timeout = compatTimeoutMs(options);
  const tsEntrypoint = path.join(root, 'client', 'lib', 'ts_entrypoint.js');
  const cmdArgs = scriptAbs.endsWith('.ts')
    ? [tsEntrypoint, scriptAbs, ...(Array.isArray(scriptArgs) ? scriptArgs : [])]
    : [scriptAbs, ...(Array.isArray(scriptArgs) ? scriptArgs : [])];

  const run = spawnSync(process.execPath, cmdArgs, {
    cwd,
    encoding: 'utf8',
    env,
    timeout
  });
  const spawnError = run.error ? String(run.error && run.error.message ? run.error.message : run.error) : '';
  const timedOut = /\bETIMEDOUT\b/i.test(spawnError);
  const stdout = String(run.stdout || '');
  const stderr = [String(run.stderr || '').trim(), timedOut ? `compat_timeout:${timeout}` : '', spawnError]
    .filter(Boolean)
    .join('\n')
    .trim();
  const payload = parseJsonPayload(stdout);

  return {
    ok: run.status === 0,
    status: Number.isFinite(run.status) ? Number(run.status) : 1,
    payload,
    stdout,
    stderr,
    timed_out: timedOut,
    error: spawnError || null
  };
}

function buildCompatBridgeResult(run, errorType, defaultType, reasonOverride = null) {
  const status = Number.isFinite(run && run.status) ? Number(run.status) : 1;
  const payload = run && run.payload && typeof run.payload === 'object'
    ? { ...run.payload }
    : {
      ok: status === 0,
      type: defaultType,
      reason: reasonOverride || (run && run.stderr ? String(run.stderr).slice(0, 320) : 'compat_fallback_result_unavailable')
    };
  payload.routed_via = 'conduit_compat';
  if (!payload.type) payload.type = defaultType;
  if (status !== 0 && !payload.reason) {
    payload.reason = reasonOverride || (run && run.stderr ? String(run.stderr).slice(0, 320) : `${defaultType}_failed`);
  }
  return {
    ok: status === 0 && payload.ok !== false,
    status,
    payload,
    detail: {
      ok: status === 0,
      type: defaultType,
      compatibility_fallback: true,
      stderr: String(run && run.stderr || ''),
      stdout: String(run && run.stdout || ''),
      exit_code: status,
      routed_via: 'conduit_compat'
    },
    response: null,
    routed_via: 'conduit_compat',
    stdout: String(run && run.stdout || ''),
    stderr: String(run && run.stderr || '')
  };
}

function runConduitCompatFallback(root, agentId, errorType, opts = {}) {
  if (!compatFallbackEnabled()) return null;
  const edge = decodeEdgePayload(agentId);
  if (!edge) return null;

  const edgeType = String(edge.type || '').trim();
  const edgeArgs = Array.isArray(edge.args) ? edge.args.map((row) => String(row)) : [];
  const runContext = edge.run_context == null ? null : String(edge.run_context);
  const fallbackReason = opts.fallbackReason ? String(opts.fallbackReason).slice(0, 320) : null;

  if (edgeType === 'spine_command' || (edgeType === 'ops_domain_command' && String(edge.domain || '').trim() === 'spine')) {
    const normalizedArgs = normalizeSpineCompatArgs(edgeArgs);
    const run = runCompatNodeScript(
      root,
      'client/systems/spine/spine.ts',
      normalizedArgs,
      {
        timeoutMs: opts.timeoutMs,
        cwd: path.join(root, 'client'),
        unsetEnv: RISKY_ENV_TOGGLE_KEYS,
        env: {
          PROTHEUS_SPINE_TS_COMPAT: '1',
          PROTHEUS_SPINE_TS_LOCAL_COMPAT: '1',
          SPINE_SKILL_INSTALL_ENFORCER_STRICT: '0',
          SPINE_LLM_GATEWAY_GUARD_STRICT: '0',
          SPINE_INTEGRITY_STRICT: '0',
          SPINE_BACKLOG_GITHUB_SYNC_STRICT: '0',
          SPINE_WORKFLOW_EXECUTOR_RECEIPT_STRICT: '0',
          SPINE_BENCHMARK_NOOP: '1',
          SPINE_RUN_CONTEXT: runContext || String(process.env.SPINE_RUN_CONTEXT || '').trim() || 'manual'
        }
      }
    );
    return buildCompatBridgeResult(run, errorType, 'spine_compat_fallback', fallbackReason);
  }

  if (edgeType === 'dopamine_ambient_command'
    || (edgeType === 'ops_domain_command' && String(edge.domain || '').trim() === 'dopamine-ambient')) {
    const normalizedArgs = edgeArgs.length ? edgeArgs : ['status'];
    const run = runCompatNodeScript(
      root,
      'client/habits/scripts/dopamine_ambient_snapshot.js',
      normalizedArgs,
      {
        timeoutMs: opts.timeoutMs,
        cwd: root
      }
    );
    return buildCompatBridgeResult(run, errorType, 'dopamine_ambient_compat_fallback', fallbackReason);
  }

  if (edgeType === 'persona_ambient_command'
    || (edgeType === 'ops_domain_command' && String(edge.domain || '').trim() === 'persona-ambient')) {
    const normalizedArgs = edgeArgs.length ? edgeArgs : ['status'];
    const run = runCompatNodeScript(
      root,
      'client/systems/personas/ambient_stance.js',
      normalizedArgs,
      {
        timeoutMs: opts.timeoutMs,
        cwd: root,
        env: {
          PROTHEUS_PERSONA_AMBIENT_LOCAL_COMPAT: '1'
        }
      }
    );
    return buildCompatBridgeResult(run, errorType, 'persona_ambient_compat_fallback', fallbackReason);
  }

  if (edgeType === 'memory_ambient_command'
    || (edgeType === 'ops_domain_command' && String(edge.domain || '').trim() === 'memory-ambient')) {
    const normalizedArgs = edgeArgs.length ? edgeArgs : ['status'];
    const run = runCompatNodeScript(
      root,
      'client/systems/memory/ambient.js',
      normalizedArgs,
      {
        timeoutMs: opts.timeoutMs,
        cwd: root,
        env: {
          PROTHEUS_MEMORY_AMBIENT_LOCAL_COMPAT: '1'
        }
      }
    );
    return buildCompatBridgeResult(run, errorType, 'memory_ambient_compat_fallback', fallbackReason);
  }

  return null;
}

function runtimeGateSuppressed(opts = {}) {
  if (opts && opts.skipRuntimeGate === true) return true;
  const raw = String(process.env.PROTHEUS_CONDUIT_RUNTIME_GATE_SUPPRESS || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

async function runConduitAgent(agentId, requestPrefix, receiptKey, errorType, opts = {}) {
  const root = findRepoRoot(opts.cwdHint || process.cwd());
  const suppressRuntimeGate = runtimeGateSuppressed(opts);
  const gateState = buildGateActiveError(root);
  if (gateState) {
    if (!suppressRuntimeGate) {
      const compat = runConduitCompatFallback(root, agentId, errorType, {
        ...opts,
        fallbackReason: gateState.reason
      });
      if (compat) {
        return compat;
      }
      return {
        ok: false,
        status: 1,
        payload: {
          ok: false,
          type: errorType,
          reason: gateState.reason,
          timed_out: true,
          gate_active: true,
          gate_remaining_ms: gateState.remainingMs,
          routed_via: 'conduit'
        },
        detail: null,
        response: null,
        routed_via: 'conduit',
        stdout: '',
        stderr: gateState.reason
      };
    }
  }
  const { ConduitClient } = loadConduitClient(root);
  const command = daemonCommand(root);
  const defaultStdioTimeoutMs = Math.max(
    1000,
    Number(process.env.PROTHEUS_CONDUIT_STDIO_TIMEOUT_MS || process.env.PROTHEUS_CONDUIT_TIMEOUT_MS || 30000) || 30000
  );
  const requestedStdioTimeoutRaw = opts.stdioTimeoutMs;
  const requestedStdioTimeoutMs = Number(requestedStdioTimeoutRaw);
  const stdioTimeoutMs = Math.max(
    1000,
    Number.isFinite(requestedStdioTimeoutMs) && requestedStdioTimeoutMs > 0
      ? Math.floor(requestedStdioTimeoutMs)
      : defaultStdioTimeoutMs
  );
  const client = ConduitClient.overStdio(
    command,
    daemonArgs(command),
    root,
    undefined,
    { timeoutMs: stdioTimeoutMs }
  );
  const defaultBridgeTimeoutMs = Math.max(stdioTimeoutMs + 1000, 30000);
  const requestedTimeoutRaw = opts.timeoutMs ?? process.env.PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS;
  const hasRequestedTimeout = !(requestedTimeoutRaw == null || String(requestedTimeoutRaw).trim() === '');
  const requestedTimeoutMs = Number(hasRequestedTimeout ? requestedTimeoutRaw : defaultBridgeTimeoutMs);
  const timeoutMs = Math.max(
    1000,
    Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? Math.floor(requestedTimeoutMs) : defaultBridgeTimeoutMs
  );

  try {
    const requestId = `${requestPrefix}-${Date.now()}`;
    const response = await Promise.race([
      client.send(
        { type: 'start_agent', agent_id: String(agentId) },
        requestId
      ),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`conduit_bridge_timeout:${timeoutMs}`)), timeoutMs);
      })
    ]);
    const detail = response
      && response.event
      && response.event.type === 'system_feedback'
      && response.event.detail
      && typeof response.event.detail === 'object'
      ? response.event.detail
      : null;
    const payload = detail && receiptKey && detail[receiptKey] && typeof detail[receiptKey] === 'object'
      ? detail[receiptKey]
      : (detail && detail.domain_receipt && typeof detail.domain_receipt === 'object' ? detail.domain_receipt : detail);
    const status = Number.isFinite(Number(detail && detail.exit_code))
      ? Number(detail.exit_code)
      : (payload && payload.ok === true && response && response.validation && response.validation.ok === true ? 0 : 1);
    const detailReason = detail && typeof detail.reason === 'string'
      ? detail.reason
      : (payload && typeof payload.reason === 'string' ? payload.reason : '');
    const payloadError = payload && typeof payload.error === 'string' ? payload.error : '';
    if (status !== 0 && payloadError === 'unknown_command') {
      const compat = runConduitCompatFallback(root, agentId, errorType, {
        ...opts,
        fallbackReason: detailReason || 'unknown_command'
      });
      if (compat) {
        if (!suppressRuntimeGate) clearRuntimeGateIfSet(root);
        return compat;
      }
    }
    if (status === 0 && !suppressRuntimeGate) {
      clearRuntimeGateIfSet(root);
    } else if (!suppressRuntimeGate && timeoutLikeError(detailReason)) {
      recordRuntimeGateFailure(root, detailReason);
    }
    return {
      ok: response && response.validation && response.validation.ok === true && status === 0,
      status,
      payload,
      detail,
      response,
      routed_via: 'conduit',
      stdout: detail && typeof detail.stdout === 'string' ? detail.stdout : '',
      stderr: detail && typeof detail.stderr === 'string' ? detail.stderr : ''
    };
  } catch (err) {
    const error = String(err && err.message ? err.message : err);
    const compat = timeoutLikeError(error)
      ? runConduitCompatFallback(root, agentId, errorType, {
        ...opts,
        fallbackReason: error
      })
      : null;
    if (compat) {
      if (!suppressRuntimeGate) clearRuntimeGateIfSet(root);
      return compat;
    }
    if (!suppressRuntimeGate) recordRuntimeGateFailure(root, error);
    return {
      ok: false,
      status: 1,
      payload: {
        ok: false,
        type: errorType,
        reason: error,
        timed_out: error.startsWith('conduit_bridge_timeout:') || error.startsWith('conduit_stdio_timeout:'),
        routed_via: 'conduit'
      },
      detail: null,
      response: null,
      routed_via: 'conduit',
      stdout: '',
      stderr: error
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runSpineCommand(commandArgs, opts = {}) {
  return runConduitAgent(
    buildAgentId(commandArgs, opts),
    'spine-conduit',
    'spine_receipt',
    'spine_conduit_bridge_error',
    opts
  );
}

async function runSpineCommandCli(commandArgs, opts = {}) {
  const out = await runSpineCommand(commandArgs, opts);
  if (opts.echoPayload !== false && out.payload) {
    process.stdout.write(`${JSON.stringify(out.payload)}\n`);
  }
  if (opts.echoStderr === true && out.stderr) {
    process.stderr.write(out.stderr.endsWith('\n') ? out.stderr : `${out.stderr}\n`);
  }
  process.exit(Number.isFinite(out.status) ? out.status : 1);
}

async function runAttentionCommand(commandArgs, opts = {}) {
  return runConduitAgent(
    buildAttentionAgentId(commandArgs),
    'attention-conduit',
    'attention_receipt',
    'attention_conduit_bridge_error',
    opts
  );
}

async function runPersonaAmbientCommand(commandArgs, opts = {}) {
  return runConduitAgent(
    buildPersonaAmbientAgentId(commandArgs),
    'persona-ambient-conduit',
    'persona_ambient_receipt',
    'persona_ambient_conduit_bridge_error',
    opts
  );
}

async function runDopamineAmbientCommand(commandArgs, opts = {}) {
  return runConduitAgent(
    buildDopamineAmbientAgentId(commandArgs),
    'dopamine-ambient-conduit',
    'dopamine_ambient_receipt',
    'dopamine_ambient_conduit_bridge_error',
    opts
  );
}

async function runMemoryAmbientCommand(commandArgs, opts = {}) {
  return runConduitAgent(
    buildMemoryAmbientAgentId(commandArgs),
    'memory-ambient-conduit',
    'memory_ambient_receipt',
    'memory_ambient_conduit_bridge_error',
    opts
  );
}

async function runOpsDomainCommand(domain, commandArgs, opts = {}) {
  const normalizedDomain = String(domain || '').trim();
  if (!normalizedDomain) {
    return {
      ok: false,
      status: 1,
      payload: {
        ok: false,
        type: 'ops_domain_conduit_bridge_error',
        reason: 'missing_domain',
        routed_via: 'conduit'
      },
      detail: null,
      response: null,
      routed_via: 'conduit',
      stdout: '',
      stderr: 'missing_domain'
    };
  }
  return runConduitAgent(
    buildOpsDomainAgentId(normalizedDomain, commandArgs, opts),
    `${normalizedDomain}-conduit`,
    'domain_receipt',
    'ops_domain_conduit_bridge_error',
    opts
  );
}

module.exports = {
  findRepoRoot,
  runAttentionCommand,
  runDopamineAmbientCommand,
  runMemoryAmbientCommand,
  runOpsDomainCommand,
  runPersonaAmbientCommand,
  runSpineCommand,
  runSpineCommandCli
};
