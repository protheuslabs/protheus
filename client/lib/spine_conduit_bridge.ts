'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

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
  const { ConduitClient } = loadConduitClient(root);
  const command = daemonCommand(root);
  const client = ConduitClient.overStdio(command, daemonArgs(command), root);

  try {
    const requestId = `${requestPrefix}-${Date.now()}`;
    const response = await client.send(
      { type: 'start_agent', agent_id: String(agentId) },
      requestId
    );
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
    return {
      ok: false,
      status: 1,
      payload: {
        ok: false,
        type: errorType,
        reason: error,
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
