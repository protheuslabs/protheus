'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

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

function loadConduitClient(root) {
  const candidates = [
    path.join(root, 'client', 'runtime', 'systems', 'conduit', 'conduit-client.js'),
    path.join(root, 'client', 'runtime', 'systems', 'conduit', 'conduit-client.ts'),
    path.join(root, 'systems', 'conduit', 'conduit-client.js'),
    path.join(root, 'systems', 'conduit', 'conduit-client.ts')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      if (candidate.endsWith('.ts')) {
        return loadTsModule(candidate);
      }
      return require(candidate);
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
    return String(raw)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }
  return command === 'cargo'
    ? ['run', '--quiet', '-p', 'conduit', '--bin', 'conduit_daemon']
    : [];
}

async function runLaneViaConduit(laneId, cwdHint) {
  const normalized = String(laneId || '').trim().toUpperCase();
  const root = findRepoRoot(cwdHint || process.cwd());
  const { ConduitClient } = loadConduitClient(root);
  const command = daemonCommand(root);
  const client = ConduitClient.overStdio(command, daemonArgs(command), root);

  try {
    const requestId = `lane-${normalized}-${Date.now()}`;
    const response = await client.send(
      { type: 'start_agent', agent_id: `lane:${normalized}` },
      requestId,
    );
    const laneReceipt =
      response &&
      response.event &&
      response.event.type === 'system_feedback' &&
      response.event.detail &&
      typeof response.event.detail === 'object'
        ? response.event.detail.lane_receipt
        : null;

    if (laneReceipt && typeof laneReceipt === 'object') {
      return laneReceipt;
    }

    return {
      ok: false,
      type: 'conduit_lane_bridge_error',
      lane_id: normalized,
      error: 'lane_receipt_missing',
      conduit_response: response,
    };
  } catch (err) {
    return {
      ok: false,
      type: 'conduit_lane_bridge_error',
      lane_id: normalized,
      error: String(err && err.message ? err.message : err),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function createConduitLaneModule(laneId, cwdHint) {
  const normalized = String(laneId || '').trim().toUpperCase();
  async function buildLaneReceipt() {
    return runLaneViaConduit(normalized, cwdHint);
  }
  async function verifyLaneReceipt() {
    const row = await buildLaneReceipt();
    return row && row.ok === true && String(row.lane_id || '') === normalized;
  }
  return {
    LANE_ID: normalized,
    buildLaneReceipt,
    verifyLaneReceipt,
  };
}

module.exports = {
  createConduitLaneModule,
  findRepoRoot,
  runLaneViaConduit,
};
