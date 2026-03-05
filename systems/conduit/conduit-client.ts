import net from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export const CONDUIT_SCHEMA_ID = 'protheus_conduit';
export const CONDUIT_SCHEMA_VERSION = '1.0';

export type TsCommand =
  | { type: 'start_agent'; agent_id: string }
  | { type: 'stop_agent'; agent_id: string }
  | { type: 'query_receipt_chain'; from_hash?: string | null; limit?: number | null }
  | { type: 'list_active_agents' }
  | { type: 'get_system_status' }
  | { type: 'apply_policy_update'; patch_id: string; patch: unknown }
  | {
      type: 'install_extension';
      extension_id: string;
      wasm_sha256: string;
      capabilities: string[];
    };

export type RustEvent =
  | { type: 'agent_started'; agent_id: string }
  | { type: 'agent_stopped'; agent_id: string }
  | { type: 'receipt_added'; receipt_hash: string }
  | { type: 'system_status'; status: string; detail: unknown }
  | { type: 'policy_violation'; reason: string };

export interface CommandEnvelope {
  schema_id: typeof CONDUIT_SCHEMA_ID;
  schema_version: typeof CONDUIT_SCHEMA_VERSION;
  request_id: string;
  ts_ms: number;
  command: TsCommand;
}

export interface ValidationReceipt {
  ok: boolean;
  fail_closed: boolean;
  reason: string;
  receipt_hash: string;
}

export interface CrossingReceipt {
  crossing_id: string;
  direction: 'TsToRust' | 'RustToTs';
  command_type: string;
  deterministic_hash: string;
  ts_ms: number;
}

export interface ResponseEnvelope {
  schema_id: typeof CONDUIT_SCHEMA_ID;
  schema_version: typeof CONDUIT_SCHEMA_VERSION;
  request_id: string;
  ts_ms: number;
  event: RustEvent;
  validation: ValidationReceipt;
  crossing: CrossingReceipt;
  receipt_hash: string;
}

type Transport = {
  sendLine(line: string): Promise<string>;
  close(): Promise<void>;
};

class UnixSocketTransport implements Transport {
  constructor(private readonly socketPath: string) {}

  async sendLine(line: string): Promise<string> {
    const socket = net.createConnection(this.socketPath);
    return new Promise((resolve, reject) => {
      let out = '';
      socket.setEncoding('utf8');
      socket.once('error', reject);
      socket.on('data', (chunk) => {
        out += chunk;
        if (out.includes('\n')) {
          socket.end();
          resolve(out.trim());
        }
      });
      socket.once('connect', () => {
        socket.write(line.endsWith('\n') ? line : `${line}\n`);
      });
      socket.once('end', () => {
        if (!out.trim()) {
          reject(new Error('conduit_unix_socket_empty_response'));
        }
      });
    });
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

class StdioTransport implements Transport {
  private readonly proc: ChildProcessWithoutNullStreams;

  constructor(command: string, args: string[] = [], cwd?: string) {
    this.proc = spawn(command, args, { cwd, stdio: 'pipe' });
  }

  async sendLine(line: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let out = '';
      const onData = (chunk: string | Buffer) => {
        out += chunk.toString();
        if (out.includes('\n')) {
          cleanup();
          resolve(out.trim());
        }
      };
      const onErr = (chunk: string | Buffer) => {
        cleanup();
        reject(new Error(`conduit_stdio_error:${chunk.toString().trim()}`));
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`conduit_stdio_exit:${code ?? 'unknown'}`));
      };
      const cleanup = () => {
        this.proc.stdout.off('data', onData);
        this.proc.stderr.off('data', onErr);
        this.proc.off('exit', onExit);
      };

      this.proc.stdout.on('data', onData);
      this.proc.stderr.on('data', onErr);
      this.proc.once('exit', onExit);
      this.proc.stdin.write(line.endsWith('\n') ? line : `${line}\n`);
    });
  }

  async close(): Promise<void> {
    if (!this.proc.killed) {
      this.proc.kill('SIGTERM');
    }
  }
}

export class ConduitClient {
  private constructor(private readonly transport: Transport) {}

  static overUnixSocket(path: string): ConduitClient {
    return new ConduitClient(new UnixSocketTransport(path));
  }

  static overStdio(command: string, args: string[] = [], cwd?: string): ConduitClient {
    return new ConduitClient(new StdioTransport(command, args, cwd));
  }

  async send(command: TsCommand, requestId?: string): Promise<ResponseEnvelope> {
    const envelope: CommandEnvelope = {
      schema_id: CONDUIT_SCHEMA_ID,
      schema_version: CONDUIT_SCHEMA_VERSION,
      request_id: requestId ?? `ts-${Date.now()}`,
      ts_ms: Date.now(),
      command,
    };

    const line = JSON.stringify(envelope);
    const raw = await this.transport.sendLine(line);
    return JSON.parse(raw) as ResponseEnvelope;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
