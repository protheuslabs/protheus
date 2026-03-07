import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = process.cwd();

const wrapperFiles = [
  'client/systems/primitives/canonical_event_log.ts',
  'client/systems/primitives/policy_vm.ts',
  'client/systems/primitives/primitive_catalog.ts',
  'client/systems/sensory/temporal_patterns.ts',
] as const;

describe('conduit primitive wrapper contract', () => {
  test.each(wrapperFiles)('wrapper contract enforced for %s', async (relativePath) => {
    const full = path.join(ROOT, relativePath);
    const source = fs.readFileSync(full, 'utf8');
    expect(source.includes('createConduitLaneModule')).toBe(true);
    expect(source.includes('direct_conduit_lane_bridge.js')).toBe(true);
    expect(source.includes('legacy_retired_lane_bridge')).toBe(false);

    const mod = await import(pathToFileURL(full).href);
    const lane = (mod && (mod.default || mod)) as any;
    expect(lane).toBeTruthy();
    expect(typeof lane.buildLaneReceipt).toBe('function');
    expect(typeof lane.verifyLaneReceipt).toBe('function');
  });

  test('install.sh exists and references hosted installer endpoint', () => {
    const source = fs.readFileSync(path.join(ROOT, 'client', 'install.sh'), 'utf8');
    expect(source.includes('api.github.com/repos')).toBe(true);
    expect(source.includes('protheus-ops')).toBe(true);
    expect(source.includes('protheusd')).toBe(true);
  });

  test('install.ps1 exists and provisions Windows wrappers', () => {
    const source = fs.readFileSync(path.join(ROOT, 'client', 'install.ps1'), 'utf8');
    expect(source.includes('protheus-ops.exe')).toBe(true);
    expect(source.includes('protheusd.cmd')).toBe(true);
    expect(source.includes('conduit_daemon')).toBe(true);
  });

  test('architecture doc includes conduit mermaid map', () => {
    const source = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    expect(source.includes('```mermaid')).toBe(true);
    expect(source.includes('Conduit')).toBe(true);
    expect(source.includes('7 Core Primitives')).toBe(true);
  });

  test('getting started doc includes curl and powershell install paths', () => {
    const source = fs.readFileSync(path.join(ROOT, 'client/docs/GETTING_STARTED.md'), 'utf8');
    expect(source.includes('curl -fsSL https://get.protheus.ai/install | sh')).toBe(true);
    expect(source.includes('install.ps1')).toBe(true);
    expect(source.includes('protheus --help')).toBe(true);
  });
});

describe('conduit client coverage paths', () => {
  test('message budget constants match expected contract count', async () => {
    const conduit = await import(pathToFileURL(path.join(ROOT, 'client/systems/conduit/conduit-client.ts')).href);
    expect(conduit.MAX_CONDUIT_MESSAGE_TYPES).toBe(10);
    expect(conduit.TS_COMMAND_TYPES.length + conduit.RUST_EVENT_TYPES.length).toBe(10);
  });

  test('overStdio sends signed envelope and parses response', async () => {
    const conduit = await import(pathToFileURL(path.join(ROOT, 'client/systems/conduit/conduit-client.ts')).href);
    const script = `
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (!buffer.includes('\\n')) return;
  const line = buffer.split('\\n')[0];
  const req = JSON.parse(line);
  const response = {
    schema_id: req.schema_id,
    schema_version: req.schema_version,
    request_id: req.request_id,
    ts_ms: req.ts_ms,
    event: {
      type: 'system_feedback',
      status: 'ok',
      detail: {
        command_type: req.command.type,
        signature_len: String(req.security.signature || '').length,
        token_len: String(req.security.capability_token.signature || '').length
      },
      violation_reason: null
    },
    validation: {
      ok: true,
      fail_closed: false,
      reason: 'validated',
      policy_receipt_hash: 'p',
      security_receipt_hash: 's',
      receipt_hash: 'v'
    },
    crossing: {
      crossing_id: req.request_id,
      direction: 'TsToRust',
      command_type: req.command.type,
      deterministic_hash: 'd',
      ts_ms: req.ts_ms
    },
    receipt_hash: 'r'
  };
  process.stdout.write(JSON.stringify(response) + '\\n');
});
`;
    const client = conduit.ConduitClient.overStdio(
      process.execPath,
      ['-e', script],
      ROOT,
      { token_ttl_ms: 60_000 },
    );

    const response = await client.send({ type: 'get_system_status' }, 'req-stdio-1');
    await client.close();

    expect(response.request_id).toBe('req-stdio-1');
    expect((response.event as any).status).toBe('ok');
    expect((response.event as any).detail.command_type).toBe('get_system_status');
    expect((response.event as any).detail.signature_len).toBeGreaterThan(16);
    expect((response.event as any).detail.token_len).toBeGreaterThan(16);
  });

  test('overStdio surfaces stderr as conduit error', async () => {
    const conduit = await import(pathToFileURL(path.join(ROOT, 'client/systems/conduit/conduit-client.ts')).href);
    const client = conduit.ConduitClient.overStdio(
      process.execPath,
      ['-e', 'process.stderr.write(\"boom\\n\"); setTimeout(() => process.exit(1), 10);'],
      ROOT,
    );

    await expect(client.send({ type: 'list_active_agents' }, 'req-stdio-err')).rejects.toThrow(
      /conduit_stdio_error|conduit_stdio_exit/,
    );
    await client.close();
  });

  test.skip('overUnixSocket path works for single roundtrip', async () => {
    if (process.platform === 'win32') return;
    const conduit = await import(pathToFileURL(path.join(ROOT, 'client/systems/conduit/conduit-client.ts')).href);
    const socketPath = path.join(os.tmpdir(), `pc-${process.pid}-${Date.now()}.sock`);
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (!buffer.includes('\\n')) return;
        const line = buffer.split('\\n')[0];
        const req = JSON.parse(line);
        const response = {
          schema_id: req.schema_id,
          schema_version: req.schema_version,
          request_id: req.request_id,
          ts_ms: req.ts_ms,
          event: {
            type: 'system_feedback',
            status: 'ok',
            detail: { command_type: req.command.type },
            violation_reason: null
          },
          validation: {
            ok: true,
            fail_closed: false,
            reason: 'validated',
            policy_receipt_hash: 'p',
            security_receipt_hash: 's',
            receipt_hash: 'v'
          },
          crossing: {
            crossing_id: req.request_id,
            direction: 'TsToRust',
            command_type: req.command.type,
            deterministic_hash: 'd',
            ts_ms: req.ts_ms
          },
          receipt_hash: 'r'
        };
        socket.write(JSON.stringify(response) + '\\n');
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(socketPath, () => resolve());
      server.once('error', reject);
    });

    const client = conduit.ConduitClient.overUnixSocket(socketPath);
    const response = await client.send({ type: 'get_system_status' }, 'req-socket-1');
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    expect(response.request_id).toBe('req-socket-1');
    expect((response.event as any).detail.command_type).toBe('get_system_status');
  }, 10_000);
});

describe('direct conduit lane bridge coverage paths', () => {
  test('findRepoRoot resolves workspace root from nested directory', async () => {
    const bridge = await import(pathToFileURL(path.join(ROOT, 'client/lib/direct_conduit_lane_bridge.js')).href);
    const found = bridge.findRepoRoot(path.join(ROOT, 'client', 'systems', 'ops'));
    expect(found).toBe(ROOT);
  });

  test('createConduitLaneModule normalizes lane id and exposes async builders', async () => {
    const bridge = await import(pathToFileURL(path.join(ROOT, 'client/lib/direct_conduit_lane_bridge.js')).href);
    const lane = bridge.createConduitLaneModule('systems-primitives-policy-vm', ROOT);
    expect(lane.LANE_ID).toBe('SYSTEMS-PRIMITIVES-POLICY-VM');
    expect(typeof lane.buildLaneReceipt).toBe('function');
    expect(typeof lane.verifyLaneReceipt).toBe('function');
  });

  test('runLaneViaConduit fails closed when daemon exits before responding', async () => {
    const previousCommand = process.env.PROTHEUS_CONDUIT_DAEMON_COMMAND;
    const previousArgs = process.env.PROTHEUS_CONDUIT_DAEMON_ARGS;
    process.env.PROTHEUS_CONDUIT_DAEMON_COMMAND = process.execPath;
    process.env.PROTHEUS_CONDUIT_DAEMON_ARGS = '-e process.exit(0)';
    const bridge = await import(pathToFileURL(path.join(ROOT, 'client/lib/direct_conduit_lane_bridge.js')).href);
    const receipt = await bridge.runLaneViaConduit('SYSTEMS-PRIMITIVES-POLICY-VM', ROOT);
    if (previousCommand == null) {
      delete process.env.PROTHEUS_CONDUIT_DAEMON_COMMAND;
    } else {
      process.env.PROTHEUS_CONDUIT_DAEMON_COMMAND = previousCommand;
    }
    if (previousArgs == null) {
      delete process.env.PROTHEUS_CONDUIT_DAEMON_ARGS;
    } else {
      process.env.PROTHEUS_CONDUIT_DAEMON_ARGS = previousArgs;
    }
    expect(receipt.ok).toBe(false);
    expect(String(receipt.error || '')).not.toHaveLength(0);
    expect(receipt.type).toBe('conduit_lane_bridge_error');
  }, 10_000);
});
