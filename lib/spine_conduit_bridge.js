'use strict';

const fs = require('fs');
const path = require('path');

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    const cargo = path.join(dir, 'Cargo.toml');
    const cratesOps = path.join(dir, 'crates', 'ops', 'Cargo.toml');
    if (fs.existsSync(cargo) && fs.existsSync(cratesOps)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function loadConduitClient(root) {
  try {
    return require(path.join(root, 'systems', 'conduit', 'conduit-client.js'));
  } catch {
    return require(path.join(root, 'systems', 'conduit', 'conduit-client.ts'));
  }
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

async function runSpineCommand(commandArgs, opts = {}) {
  const root = findRepoRoot(opts.cwdHint || process.cwd());
  const { ConduitClient } = loadConduitClient(root);
  const command = daemonCommand(root);
  const client = ConduitClient.overStdio(command, daemonArgs(command), root);

  try {
    const requestId = `spine-conduit-${Date.now()}`;
    const response = await client.send(
      { type: 'start_agent', agent_id: buildAgentId(commandArgs, opts) },
      requestId
    );
    const detail = response
      && response.event
      && response.event.type === 'system_feedback'
      && response.event.detail
      && typeof response.event.detail === 'object'
      ? response.event.detail
      : null;
    const payload = detail && detail.spine_receipt && typeof detail.spine_receipt === 'object'
      ? detail.spine_receipt
      : detail;
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
        type: 'spine_conduit_bridge_error',
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
  const root = findRepoRoot(opts.cwdHint || process.cwd());
  const { ConduitClient } = loadConduitClient(root);
  const command = daemonCommand(root);
  const client = ConduitClient.overStdio(command, daemonArgs(command), root);

  try {
    const requestId = `attention-conduit-${Date.now()}`;
    const response = await client.send(
      { type: 'start_agent', agent_id: buildAttentionAgentId(commandArgs) },
      requestId
    );
    const detail = response
      && response.event
      && response.event.type === 'system_feedback'
      && response.event.detail
      && typeof response.event.detail === 'object'
      ? response.event.detail
      : null;
    const payload = detail && detail.attention_receipt && typeof detail.attention_receipt === 'object'
      ? detail.attention_receipt
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
        type: 'attention_conduit_bridge_error',
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

async function runPersonaAmbientCommand(commandArgs, opts = {}) {
  const root = findRepoRoot(opts.cwdHint || process.cwd());
  const { ConduitClient } = loadConduitClient(root);
  const command = daemonCommand(root);
  const client = ConduitClient.overStdio(command, daemonArgs(command), root);

  try {
    const requestId = `persona-ambient-conduit-${Date.now()}`;
    const response = await client.send(
      { type: 'start_agent', agent_id: buildPersonaAmbientAgentId(commandArgs) },
      requestId
    );
    const detail = response
      && response.event
      && response.event.type === 'system_feedback'
      && response.event.detail
      && typeof response.event.detail === 'object'
      ? response.event.detail
      : null;
    const payload = detail && detail.persona_ambient_receipt && typeof detail.persona_ambient_receipt === 'object'
      ? detail.persona_ambient_receipt
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
        type: 'persona_ambient_conduit_bridge_error',
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

async function runDopamineAmbientCommand(commandArgs, opts = {}) {
  const root = findRepoRoot(opts.cwdHint || process.cwd());
  const { ConduitClient } = loadConduitClient(root);
  const command = daemonCommand(root);
  const client = ConduitClient.overStdio(command, daemonArgs(command), root);

  try {
    const requestId = `dopamine-ambient-conduit-${Date.now()}`;
    const response = await client.send(
      { type: 'start_agent', agent_id: buildDopamineAmbientAgentId(commandArgs) },
      requestId
    );
    const detail = response
      && response.event
      && response.event.type === 'system_feedback'
      && response.event.detail
      && typeof response.event.detail === 'object'
      ? response.event.detail
      : null;
    const payload = detail && detail.dopamine_ambient_receipt && typeof detail.dopamine_ambient_receipt === 'object'
      ? detail.dopamine_ambient_receipt
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
        type: 'dopamine_ambient_conduit_bridge_error',
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

async function runMemoryAmbientCommand(commandArgs, opts = {}) {
  const root = findRepoRoot(opts.cwdHint || process.cwd());
  const { ConduitClient } = loadConduitClient(root);
  const command = daemonCommand(root);
  const client = ConduitClient.overStdio(command, daemonArgs(command), root);

  try {
    const requestId = `memory-ambient-conduit-${Date.now()}`;
    const response = await client.send(
      { type: 'start_agent', agent_id: buildMemoryAmbientAgentId(commandArgs) },
      requestId
    );
    const detail = response
      && response.event
      && response.event.type === 'system_feedback'
      && response.event.detail
      && typeof response.event.detail === 'object'
      ? response.event.detail
      : null;
    const payload = detail && detail.memory_ambient_receipt && typeof detail.memory_ambient_receipt === 'object'
      ? detail.memory_ambient_receipt
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
        type: 'memory_ambient_conduit_bridge_error',
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

module.exports = {
  findRepoRoot,
  runAttentionCommand,
  runDopamineAmbientCommand,
  runMemoryAmbientCommand,
  runPersonaAmbientCommand,
  runSpineCommand,
  runSpineCommandCli
};
