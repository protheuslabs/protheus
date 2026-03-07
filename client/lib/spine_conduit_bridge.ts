'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const DEFAULT_CONDUIT_GATE_BASE_MS = 30 * 60 * 1000;
const DEFAULT_CONDUIT_GATE_MAX_MS = 6 * 60 * 60 * 1000;

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
    parsePositiveInt(process.env.PROTHEUS_CONDUIT_RUNTIME_GATE_THRESHOLD, 1)
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
  if (!Number.isFinite(blockedUntilMs) || blockedUntilMs <= Date.now()) return null;
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
  if (!existing || !existing.consecutive_failures) return;
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
  const previousFailures = Number(existing.consecutive_failures || 0);
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

async function runConduitAgent(agentId, requestPrefix, receiptKey, errorType, opts = {}) {
  const root = findRepoRoot(opts.cwdHint || process.cwd());
  const gateState = buildGateActiveError(root);
  if (gateState) {
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
  const { ConduitClient } = loadConduitClient(root);
  const command = daemonCommand(root);
  const client = ConduitClient.overStdio(command, daemonArgs(command), root);
  const defaultStdioTimeoutMs = Math.max(
    1000,
    Number(process.env.PROTHEUS_CONDUIT_STDIO_TIMEOUT_MS || process.env.PROTHEUS_CONDUIT_TIMEOUT_MS || 120000) || 120000
  );
  const defaultBridgeTimeoutMs = Math.max(defaultStdioTimeoutMs + 1000, 125000);
  const requestedTimeoutMs = Number(opts.timeoutMs || process.env.PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS || defaultBridgeTimeoutMs);
  const timeoutMs = Math.max(
    defaultStdioTimeoutMs + 1000,
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
    if (status === 0) {
      clearRuntimeGateIfSet(root);
    } else if (timeoutLikeError(detailReason)) {
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
    recordRuntimeGateFailure(root, error);
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
