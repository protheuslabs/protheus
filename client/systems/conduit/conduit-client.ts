import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export const CONDUIT_SCHEMA_ID = 'protheus_conduit';
export const CONDUIT_SCHEMA_VERSION = '1.0';
export const MAX_CONDUIT_MESSAGE_TYPES = 10;

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

export const TS_COMMAND_TYPES = [
  'start_agent',
  'stop_agent',
  'query_receipt_chain',
  'list_active_agents',
  'get_system_status',
  'apply_policy_update',
  'install_extension',
] as const;

export type AgentLifecycleState = 'started' | 'stopped';

export type RustEvent =
  | { type: 'agent_lifecycle'; state: AgentLifecycleState; agent_id: string }
  | { type: 'receipt_added'; receipt_hash: string }
  | { type: 'system_feedback'; status: string; detail: unknown; violation_reason?: string | null };

export const RUST_EVENT_TYPES = [
  'agent_lifecycle',
  'receipt_added',
  'system_feedback',
] as const;

const BRIDGE_MESSAGE_TYPE_COUNT = TS_COMMAND_TYPES.length + RUST_EVENT_TYPES.length;
if (BRIDGE_MESSAGE_TYPE_COUNT > MAX_CONDUIT_MESSAGE_TYPES) {
  throw new Error(
    `conduit_message_budget_exceeded:${BRIDGE_MESSAGE_TYPE_COUNT}>${MAX_CONDUIT_MESSAGE_TYPES}`,
  );
}

export interface CapabilityToken {
  token_id: string;
  subject: string;
  capabilities: string[];
  issued_at_ms: number;
  expires_at_ms: number;
  signature: string;
}

export interface CommandSecurityMetadata {
  client_id: string;
  key_id: string;
  nonce: string;
  signature: string;
  capability_token: CapabilityToken;
}

export interface CommandEnvelope {
  schema_id: typeof CONDUIT_SCHEMA_ID;
  schema_version: typeof CONDUIT_SCHEMA_VERSION;
  request_id: string;
  ts_ms: number;
  command: TsCommand;
  security: CommandSecurityMetadata;
}

export interface ValidationReceipt {
  ok: boolean;
  fail_closed: boolean;
  reason: string;
  policy_receipt_hash: string;
  security_receipt_hash: string;
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

export interface ConduitClientSecurityConfig {
  client_id: string;
  signing_key_id: string;
  signing_secret: string;
  token_key_id: string;
  token_secret: string;
  token_ttl_ms: number;
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
  private readonly timeoutMs: number;

  constructor(command: string, args: string[] = [], cwd?: string) {
    this.proc = spawn(command, args, { cwd, stdio: 'pipe' });
    const configured = Number(process.env.PROTHEUS_CONDUIT_STDIO_TIMEOUT_MS || 120000);
    this.timeoutMs = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 120000;
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
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`conduit_stdio_timeout:${this.timeoutMs}`));
      }, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
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
  private constructor(
    private readonly transport: Transport,
    private readonly security: ConduitClientSecurityConfig,
  ) {}

  static overUnixSocket(path: string, security?: Partial<ConduitClientSecurityConfig>): ConduitClient {
    return new ConduitClient(new UnixSocketTransport(path), resolveSecurityConfig(security));
  }

  static overStdio(
    command: string,
    args: string[] = [],
    cwd?: string,
    security?: Partial<ConduitClientSecurityConfig>,
  ): ConduitClient {
    return new ConduitClient(new StdioTransport(command, args, cwd), resolveSecurityConfig(security));
  }

  async send(command: TsCommand, requestId?: string): Promise<ResponseEnvelope> {
    const ts_ms = Date.now();
    const request_id = requestId ?? `ts-${ts_ms}`;
    const security = this.buildSecurity(request_id, ts_ms, command);

    const envelope: CommandEnvelope = {
      schema_id: CONDUIT_SCHEMA_ID,
      schema_version: CONDUIT_SCHEMA_VERSION,
      request_id,
      ts_ms,
      command,
      security,
    };

    const line = JSON.stringify(envelope);
    const raw = await this.transport.sendLine(line);
    return JSON.parse(raw) as ResponseEnvelope;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private buildSecurity(request_id: string, ts_ms: number, command: TsCommand): CommandSecurityMetadata {
    const issued_at_ms = Date.now();
    const capability = REQUIRED_SCOPES[command.type] ?? 'system.read';
    const tokenPayload = {
      token_id: `tok-${request_id}-${issued_at_ms}`,
      subject: this.security.client_id,
      capabilities: [capability],
      issued_at_ms,
      expires_at_ms: issued_at_ms + this.security.token_ttl_ms,
    };

    const tokenSignature = signValue(this.security.token_key_id, this.security.token_secret, tokenPayload);
    const capability_token: CapabilityToken = {
      ...tokenPayload,
      signature: tokenSignature,
    };

    const nonce = `nonce-${request_id}-${issued_at_ms}`;
    const signingPayload = {
      schema_id: CONDUIT_SCHEMA_ID,
      schema_version: CONDUIT_SCHEMA_VERSION,
      request_id,
      ts_ms,
      command,
      security: {
        client_id: this.security.client_id,
        key_id: this.security.signing_key_id,
        nonce,
        capability_token,
      },
    };

    const signature = signValue(this.security.signing_key_id, this.security.signing_secret, signingPayload);

    return {
      client_id: this.security.client_id,
      key_id: this.security.signing_key_id,
      nonce,
      signature,
      capability_token,
    };
  }
}

const REQUIRED_SCOPES: Record<TsCommand['type'], string> = {
  start_agent: 'agent.lifecycle',
  stop_agent: 'agent.lifecycle',
  query_receipt_chain: 'receipt.read',
  list_active_agents: 'system.read',
  get_system_status: 'system.read',
  apply_policy_update: 'policy.update',
  install_extension: 'extension.install',
};

function resolveSecurityConfig(
  override?: Partial<ConduitClientSecurityConfig>,
): ConduitClientSecurityConfig {
  return {
    client_id: override?.client_id ?? process.env.CONDUIT_CLIENT_ID ?? 'ts-surface',
    signing_key_id:
      override?.signing_key_id ?? process.env.CONDUIT_SIGNING_KEY_ID ?? 'conduit-msg-k1',
    signing_secret:
      override?.signing_secret ?? process.env.CONDUIT_SIGNING_SECRET ?? 'conduit-dev-signing-secret',
    token_key_id: override?.token_key_id ?? process.env.CONDUIT_TOKEN_KEY_ID ?? 'conduit-token-k1',
    token_secret: override?.token_secret ?? process.env.CONDUIT_TOKEN_SECRET ?? 'conduit-dev-token-secret',
    token_ttl_ms: override?.token_ttl_ms ?? Number(process.env.CONDUIT_TOKEN_TTL_MS ?? 300000),
  };
}

function signValue(keyId: string, secret: string, value: unknown): string {
  const canonical = canonicalJson(value);
  return crypto.createHash('sha256').update(`${keyId}:${secret}:${canonical}`).digest('hex');
}

function canonicalJson(value: unknown): string {
  const normalized = normalizeValue(value);
  return JSON.stringify(normalized);
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((row) => normalizeValue(row));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const out: Record<string, unknown> = {};
    for (const [key, row] of entries) {
      out[key] = normalizeValue(row);
    }
    return out;
  }
  return value;
}
