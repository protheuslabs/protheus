'use strict';

export {};

const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const crypto = require('crypto') as typeof import('crypto');
const { spawnSync } = require('child_process') as typeof import('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SECRETS_DIR = process.env.SECRET_BROKER_SECRETS_DIR
  ? path.resolve(process.env.SECRET_BROKER_SECRETS_DIR)
  : path.join(os.homedir(), '.config', 'protheus', 'secrets');
const STATE_PATH = process.env.SECRET_BROKER_STATE_PATH
  ? path.resolve(process.env.SECRET_BROKER_STATE_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'secret_broker_state.json');
const AUDIT_PATH = process.env.SECRET_BROKER_AUDIT_PATH
  ? path.resolve(process.env.SECRET_BROKER_AUDIT_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'secret_broker_audit.jsonl');
const POLICY_PATH = process.env.SECRET_BROKER_POLICY_PATH
  ? path.resolve(process.env.SECRET_BROKER_POLICY_PATH)
  : path.join(REPO_ROOT, 'config', 'secret_broker_policy.json');
const LEGACY_LOCAL_KEY_PATH = path.join(REPO_ROOT, 'state', 'security', 'secret_broker_key.txt');
const LOCAL_KEY_PATH = process.env.SECRET_BROKER_LOCAL_KEY_PATH
  ? path.resolve(process.env.SECRET_BROKER_LOCAL_KEY_PATH)
  : path.join(DEFAULT_SECRETS_DIR, 'secret_broker_key.txt');

const DEFAULT_TTL_SEC = Number(process.env.SECRET_BROKER_DEFAULT_TTL_SEC || 300);
const MIN_TTL_SEC = Number(process.env.SECRET_BROKER_MIN_TTL_SEC || 30);
const MAX_TTL_SEC = Number(process.env.SECRET_BROKER_MAX_TTL_SEC || 3600);

type AnyObj = Record<string, any>;

function nowMs(input: unknown): number {
  if (Number.isFinite(Number(input))) return Number(input);
  return Date.now();
}

function nowIso(ms?: unknown): string {
  return new Date(nowMs(ms)).toISOString();
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, unknown>): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeText(v: unknown, maxLen = 240): string {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function boolFlag(v: unknown, fallback = false): boolean {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function base64urlEncode(input: string): string {
  return Buffer.from(String(input), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64urlDecode(input: string): string {
  const raw = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = raw.length % 4;
  const padded = pad === 0 ? raw : raw + '='.repeat(4 - pad);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function stableHash16(v: unknown): string {
  return crypto.createHash('sha256').update(String(v || ''), 'utf8').digest('hex').slice(0, 16);
}

function readTextSafe(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8') || '').trim();
  } catch {
    return '';
  }
}

function loadOrCreateLocalKey(): string {
  const existing = readTextSafe(LOCAL_KEY_PATH);
  if (existing) return existing;
  const legacy = readTextSafe(LEGACY_LOCAL_KEY_PATH);
  if (legacy) return legacy;
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    ensureDir(path.dirname(LOCAL_KEY_PATH));
    fs.writeFileSync(LOCAL_KEY_PATH, generated + '\n', { encoding: 'utf8', mode: 0o600 });
    return generated;
  } catch {
    return '';
  }
}

function secretBrokerKey(): string {
  const envKey = normalizeText(
    process.env.SECRET_BROKER_KEY
      || process.env.REQUEST_GATE_SECRET
      || process.env.CAPABILITY_LEASE_KEY
      || '',
    4096
  );
  if (envKey) return envKey;
  return normalizeText(loadOrCreateLocalKey(), 4096);
}

function requireSecretBrokerKey(): { ok: true; key: string } | { ok: false; error: string } {
  const key = secretBrokerKey();
  if (!key) {
    return { ok: false, error: 'secret_broker_key_missing' };
  }
  return { ok: true, key };
}

function sign(body: string, key: string): string {
  return crypto.createHmac('sha256', key).update(String(body), 'utf8').digest('hex');
}

function safeTimingEqual(a: string, b: string): boolean {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function loadState(): Record<string, any> {
  const raw = readJsonSafe(STATE_PATH, null);
  if (!raw || typeof raw !== 'object') {
    return { version: '1.1', issued: {} };
  }
  return {
    version: '1.1',
    issued: raw.issued && typeof raw.issued === 'object' ? raw.issued : {}
  };
}

function saveState(state: Record<string, any>): void {
  writeJsonAtomic(STATE_PATH, state);
}

function audit(entry: Record<string, unknown>): void {
  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    ...(entry && typeof entry === 'object' ? entry : {})
  });
}

function makeHandleId(): string {
  return `sh_${crypto.randomBytes(8).toString('hex')}`;
}

function parseHandle(handle: unknown): Record<string, any> {
  const raw = normalizeText(handle, 8192);
  const parts = raw.split('.');
  if (parts.length !== 2) return { ok: false, error: 'handle_malformed' };
  const body = String(parts[0] || '');
  const sig = String(parts[1] || '');
  let payload = null;
  try {
    payload = JSON.parse(base64urlDecode(body));
  } catch {
    return { ok: false, error: 'handle_payload_invalid' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'handle_payload_invalid' };
  return { ok: true, body, sig, payload };
}

function getByPath(obj: AnyObj, dotted: unknown): unknown {
  const p = normalizeText(dotted, 120);
  if (!p) return undefined;
  const parts = p.split('.').map((x) => x.trim()).filter(Boolean);
  let cur: any = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function parseTsMs(value: unknown): number | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const num = Number(raw);
  if (Number.isFinite(num)) {
    if (num > 100000000000) return Math.floor(num);
    if (num > 1000000000) return Math.floor(num * 1000);
  }
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  return ts;
}

function resolveTemplate(rawPath: unknown, secretId: string): string {
  let out = String(rawPath == null ? '' : rawPath).trim();
  if (!out) return '';
  out = out
    .replace(/\$\{HOME\}/g, os.homedir())
    .replace(/\$\{REPO_ROOT\}/g, REPO_ROOT)
    .replace(/\$\{DEFAULT_SECRETS_DIR\}/g, DEFAULT_SECRETS_DIR)
    .replace(/\$\{SECRET_ID\}/g, secretId);
  if (path.isAbsolute(out)) return out;
  return path.join(REPO_ROOT, out);
}

function defaultPolicy(): AnyObj {
  return {
    version: '1.0',
    audit: {
      include_backend_details: true
    },
    rotation_policy: {
      warn_after_days: 45,
      max_after_days: 90,
      require_rotated_at: false,
      enforce_on_issue: false
    },
    command_backend: {
      timeout_ms: 5000
    },
    secrets: {
      moltbook_api_key: {
        providers: [
          { type: 'env', env: 'MOLTBOOK_TOKEN', rotated_at_env: 'MOLTBOOK_TOKEN_ROTATED_AT' },
          {
            type: 'json_file',
            paths: [
              path.join(DEFAULT_SECRETS_DIR, 'moltbook.credentials.json'),
              path.join(os.homedir(), '.config', 'moltbook', 'credentials.json'),
              path.join(os.homedir(), '.openclaw', 'workspace', 'config', 'moltbook', 'credentials.json')
            ],
            field: 'api_key',
            rotated_at_field: 'rotated_at'
          }
        ]
      },
      moltstack_api_key: {
        providers: [
          { type: 'env', env: 'MOLTSTACK_TOKEN', rotated_at_env: 'MOLTSTACK_TOKEN_ROTATED_AT' },
          {
            type: 'json_file',
            paths: [
              path.join(DEFAULT_SECRETS_DIR, 'moltstack.credentials.json'),
              path.join(os.homedir(), '.config', 'moltstack', 'credentials.json')
            ],
            field: 'api_key',
            rotated_at_field: 'rotated_at'
          }
        ]
      }
    }
  };
}

function normalizeProvider(raw: AnyObj, policy: AnyObj): AnyObj {
  const type = normalizeText(raw && raw.type, 32).toLowerCase();
  if (!type) return {};
  if (type === 'env') {
    return {
      type: 'env',
      enabled: raw.enabled !== false,
      env: normalizeText(raw.env, 100),
      rotated_at_env: normalizeText(raw.rotated_at_env, 100)
    };
  }
  if (type === 'json_file') {
    const paths = Array.isArray(raw.paths)
      ? raw.paths.map((p: unknown) => String(p || '').trim()).filter(Boolean)
      : (normalizeText(raw.path || '', 400) ? [normalizeText(raw.path || '', 400)] : []);
    return {
      type: 'json_file',
      enabled: raw.enabled !== false,
      paths,
      field: normalizeText(raw.field || 'api_key', 120) || 'api_key',
      rotated_at_field: normalizeText(raw.rotated_at_field || 'rotated_at', 120) || 'rotated_at'
    };
  }
  if (type === 'command') {
    const command = Array.isArray(raw.command)
      ? raw.command.map((x: unknown) => String(x || '')).filter((x: string) => x.trim())
      : normalizeText(raw.command || '', 2000);
    return {
      type: 'command',
      enabled: raw.enabled === true,
      command,
      parse_json: raw.parse_json !== false,
      value_path: normalizeText(raw.value_path || raw.value_field || 'value', 120) || 'value',
      rotated_at_path: normalizeText(raw.rotated_at_path || raw.rotated_at_field || 'rotated_at', 120) || 'rotated_at',
      timeout_ms: clampInt(raw.timeout_ms, 500, 60000, clampInt(policy.command_backend.timeout_ms, 500, 60000, 5000)),
      env: raw.env && typeof raw.env === 'object' ? raw.env : {}
    };
  }
  return {};
}

function normalizeSecretSpec(secretId: string, raw: AnyObj, baseSpec: AnyObj, policy: AnyObj): AnyObj {
  const sourceProviders = Array.isArray(raw && raw.providers)
    ? raw.providers
    : Array.isArray(baseSpec && baseSpec.providers)
      ? baseSpec.providers
      : [];
  const providers = sourceProviders
    .map((provider: AnyObj) => normalizeProvider(provider, policy))
    .filter((provider: AnyObj) => provider && provider.type);
  const rotationRaw = {
    ...(policy.rotation_policy && typeof policy.rotation_policy === 'object' ? policy.rotation_policy : {}),
    ...(baseSpec && baseSpec.rotation && typeof baseSpec.rotation === 'object' ? baseSpec.rotation : {}),
    ...(raw && raw.rotation && typeof raw.rotation === 'object' ? raw.rotation : {})
  };
  return {
    secret_id: secretId,
    providers,
    rotation: {
      warn_after_days: clampNumber(rotationRaw.warn_after_days, 1, 3650, 45),
      max_after_days: clampNumber(rotationRaw.max_after_days, 1, 3650, 90),
      require_rotated_at: boolFlag(rotationRaw.require_rotated_at, false),
      enforce_on_issue: boolFlag(rotationRaw.enforce_on_issue, false)
    }
  };
}

function loadPolicy(policyPathRaw?: unknown): AnyObj {
  const policyPath = policyPathRaw
    ? path.resolve(String(policyPathRaw))
    : POLICY_PATH;
  const base = defaultPolicy();
  const raw: AnyObj = readJsonSafe(policyPath, {} as AnyObj);
  const merged: AnyObj = {
    version: normalizeText(raw && raw.version ? raw.version : base.version, 24) || '1.0',
    path: policyPath,
    audit: {
      include_backend_details: raw && raw.audit && raw.audit.include_backend_details === false
        ? false
        : base.audit.include_backend_details
    },
    rotation_policy: {
      warn_after_days: clampNumber(
        raw && raw.rotation_policy ? raw.rotation_policy.warn_after_days : base.rotation_policy.warn_after_days,
        1,
        3650,
        base.rotation_policy.warn_after_days
      ),
      max_after_days: clampNumber(
        raw && raw.rotation_policy ? raw.rotation_policy.max_after_days : base.rotation_policy.max_after_days,
        1,
        3650,
        base.rotation_policy.max_after_days
      ),
      require_rotated_at: boolFlag(
        raw && raw.rotation_policy ? raw.rotation_policy.require_rotated_at : base.rotation_policy.require_rotated_at,
        false
      ),
      enforce_on_issue: boolFlag(
        raw && raw.rotation_policy ? raw.rotation_policy.enforce_on_issue : base.rotation_policy.enforce_on_issue,
        false
      )
    },
    command_backend: {
      timeout_ms: clampInt(
        raw && raw.command_backend ? raw.command_backend.timeout_ms : base.command_backend.timeout_ms,
        500,
        60000,
        base.command_backend.timeout_ms
      )
    },
    secrets: {}
  };

  const sourceSecrets = raw && raw.secrets && typeof raw.secrets === 'object' ? raw.secrets : {};
  const baseSecrets = base.secrets || {};
  const secretIds = Array.from(
    new Set(
      Object.keys(baseSecrets)
        .concat(Object.keys(sourceSecrets))
        .map((id) => normalizeText(id, 120))
        .filter(Boolean)
    )
  );
  for (const secretId of secretIds) {
    const baseSpec = baseSecrets[secretId] && typeof baseSecrets[secretId] === 'object' ? baseSecrets[secretId] : {};
    const rawSpec = sourceSecrets[secretId] && typeof sourceSecrets[secretId] === 'object' ? sourceSecrets[secretId] : {};
    merged.secrets[secretId] = normalizeSecretSpec(secretId, rawSpec, baseSpec, merged);
  }
  return merged;
}

function runProviderEnv(secretId: string, provider: AnyObj): AnyObj {
  const envName = normalizeText(provider.env, 100);
  if (!envName) return { ok: false, reason: 'env_name_missing' };
  const value = normalizeText(process.env[envName], 8192);
  if (!value) return { ok: false, reason: 'env_value_missing', env: envName };
  const rotatedAt = provider.rotated_at_env
    ? normalizeText(process.env[String(provider.rotated_at_env)], 120)
    : '';
  return {
    ok: true,
    value,
    rotated_at: rotatedAt || null,
    provider_type: 'env',
    provider_ref: envName,
    external: true
  };
}

function runProviderJsonFile(secretId: string, provider: AnyObj): AnyObj {
  const candidates = Array.isArray(provider.paths) ? provider.paths : [];
  const field = normalizeText(provider.field || 'api_key', 120) || 'api_key';
  const rotatedField = normalizeText(provider.rotated_at_field || 'rotated_at', 120) || 'rotated_at';
  for (const rawPath of candidates) {
    const resolved = resolveTemplate(rawPath, secretId);
    try {
      if (!resolved || !fs.existsSync(resolved)) continue;
      const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      const candidate = getByPath(payload, field);
      const value = normalizeText(candidate, 8192);
      if (!value) continue;
      const rotatedAt = getByPath(payload, rotatedField);
      return {
        ok: true,
        value,
        rotated_at: rotatedAt == null ? null : normalizeText(rotatedAt, 120),
        provider_type: 'json_file',
        provider_ref: resolved,
        external: false
      };
    } catch {
      continue;
    }
  }
  return { ok: false, reason: 'json_file_value_missing', field };
}

function runProviderCommand(secretId: string, provider: AnyObj): AnyObj {
  const command = provider.command;
  const timeoutMs = clampInt(provider.timeout_ms, 500, 60000, 5000);
  const mergedEnv = {
    ...process.env,
    SECRET_ID: secretId,
    SECRET_BROKER_SECRET_ID: secretId
  } as AnyObj;
  if (provider.env && typeof provider.env === 'object') {
    for (const [k, v] of Object.entries(provider.env)) {
      const key = normalizeText(k, 80);
      if (!key) continue;
      mergedEnv[key] = String(v == null ? '' : v);
    }
  }

  let result: AnyObj = null;
  if (Array.isArray(command) && command.length >= 1) {
    result = spawnSync(String(command[0]), command.slice(1).map((x: unknown) => String(x)), {
      encoding: 'utf8',
      env: mergedEnv,
      timeout: timeoutMs
    });
  } else {
    const cmd = normalizeText(command, 2000);
    if (!cmd) return { ok: false, reason: 'command_missing' };
    result = spawnSync('/bin/sh', ['-lc', cmd], {
      encoding: 'utf8',
      env: mergedEnv,
      timeout: timeoutMs
    });
  }

  const code = result && Number.isFinite(Number(result.status)) ? Number(result.status) : 1;
  if (code !== 0) {
    return {
      ok: false,
      reason: 'command_exit_nonzero',
      code,
      stderr: normalizeText(result && result.stderr ? result.stderr : '', 200)
    };
  }
  const stdout = normalizeText(result && result.stdout ? result.stdout : '', 8000);
  if (!stdout) return { ok: false, reason: 'command_empty_stdout' };

  const parseJson = provider.parse_json !== false;
  if (!parseJson) {
    return {
      ok: true,
      value: stdout,
      rotated_at: null,
      provider_type: 'command',
      provider_ref: Array.isArray(command) ? String(command[0] || '') : normalizeText(command, 180),
      external: true
    };
  }

  let payload = null;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'command_json_invalid' };
  }
  const value = normalizeText(getByPath(payload, provider.value_path || 'value'), 8192);
  if (!value) return { ok: false, reason: 'command_value_missing' };
  const rotatedAt = getByPath(payload, provider.rotated_at_path || 'rotated_at');
  return {
    ok: true,
    value,
    rotated_at: rotatedAt == null ? null : normalizeText(rotatedAt, 120),
    provider_type: 'command',
    provider_ref: Array.isArray(command) ? String(command[0] || '') : normalizeText(command, 180),
    external: true
  };
}

function evaluateRotation(secretId: string, rotationCfg: AnyObj, rotatedAtRaw: unknown, now: number): AnyObj {
  const warnAfterDays = clampNumber(rotationCfg.warn_after_days, 1, 3650, 45);
  const maxAfterDays = clampNumber(rotationCfg.max_after_days, warnAfterDays, 3650, 90);
  const requireRotatedAt = rotationCfg.require_rotated_at === true;
  const enforceOnIssue = rotationCfg.enforce_on_issue === true;
  const rotatedAtMs = parseTsMs(rotatedAtRaw);
  if (!rotatedAtMs) {
    return {
      status: requireRotatedAt ? 'critical' : 'unknown',
      reason: 'rotated_at_missing',
      rotated_at: null,
      age_days: null,
      warn_after_days: warnAfterDays,
      max_after_days: maxAfterDays,
      require_rotated_at: requireRotatedAt,
      enforce_on_issue: enforceOnIssue
    };
  }
  const ageDaysRaw = Math.max(0, (now - rotatedAtMs) / (24 * 60 * 60 * 1000));
  const ageDays = Number(ageDaysRaw.toFixed(3));
  let status = 'ok';
  let reason = 'rotation_fresh';
  if (ageDays > maxAfterDays) {
    status = 'critical';
    reason = 'rotation_age_exceeded';
  } else if (ageDays > warnAfterDays) {
    status = 'warn';
    reason = 'rotation_age_warning';
  }
  return {
    status,
    reason,
    rotated_at: nowIso(rotatedAtMs),
    age_days: ageDays,
    warn_after_days: warnAfterDays,
    max_after_days: maxAfterDays,
    require_rotated_at: requireRotatedAt,
    enforce_on_issue: enforceOnIssue
  };
}

function loadSecretById(secretId: unknown, opts: AnyObj = {}): Record<string, any> {
  const now = nowMs(opts.now_ms);
  const key = normalizeText(secretId, 120);
  const policy = loadPolicy(opts.policy_path);
  const spec = policy.secrets[key];
  if (!spec || typeof spec !== 'object') {
    return { ok: false, error: 'secret_id_unsupported', secret_id: key || null };
  }
  const providerErrors: AnyObj[] = [];
  for (const provider of Array.isArray(spec.providers) ? spec.providers : []) {
    if (!provider || provider.enabled === false) continue;
    let result: AnyObj = { ok: false, reason: 'provider_unsupported' };
    if (provider.type === 'env') result = runProviderEnv(key, provider);
    else if (provider.type === 'json_file') result = runProviderJsonFile(key, provider);
    else if (provider.type === 'command') result = runProviderCommand(key, provider);
    else result = { ok: false, reason: 'provider_type_unsupported', provider_type: provider.type };

    if (result.ok) {
      const value = normalizeText(result.value, 8192);
      if (!value) {
        providerErrors.push({
          provider_type: provider.type,
          reason: 'value_empty'
        });
        continue;
      }
      const rotation = evaluateRotation(key, spec.rotation || {}, result.rotated_at, now);
      const out = {
        ok: true,
        secret_id: key,
        value,
        value_hash: stableHash16(value),
        backend: {
          provider_type: result.provider_type || provider.type,
          provider_ref: normalizeText(result.provider_ref || '', 200) || null,
          external: result.external === true
        },
        rotation
      };
      if (opts.with_audit !== false) {
        audit({
          type: 'secret_value_loaded',
          secret_id: key,
          provider_type: out.backend.provider_type,
          provider_ref: policy.audit.include_backend_details ? out.backend.provider_ref : null,
          external_backend: out.backend.external === true,
          value_hash: out.value_hash,
          rotation_status: rotation.status,
          rotation_age_days: rotation.age_days
        });
      }
      return out;
    }
    providerErrors.push({
      provider_type: provider.type,
      reason: normalizeText(result.reason || 'provider_failed', 120),
      code: Number.isFinite(Number(result.code)) ? Number(result.code) : null,
      ref: normalizeText(result.provider_ref || '', 120) || null
    });
  }

  if (opts.with_audit !== false) {
    audit({
      type: 'secret_value_load_failed',
      secret_id: key,
      reason: 'all_providers_failed',
      provider_errors: providerErrors.slice(0, 8)
    });
  }
  return {
    ok: false,
    error: 'secret_value_missing',
    secret_id: key,
    provider_errors: providerErrors.slice(0, 8)
  };
}

function evaluateSecretRotationHealth(opts: AnyObj = {}): Record<string, any> {
  const policy = loadPolicy(opts.policy_path);
  const now = nowMs(opts.now_ms);
  const secretIds = Array.isArray(opts.secret_ids)
    ? opts.secret_ids.map((x: unknown) => normalizeText(x, 120)).filter(Boolean)
    : Object.keys(policy.secrets || {});
  const checks: AnyObj[] = [];
  const counters = {
    ok: 0,
    warn: 0,
    critical: 0,
    unknown: 0,
    unavailable: 0
  };

  for (const secretId of secretIds) {
    const loaded = loadSecretById(secretId, { now_ms: now, with_audit: false, policy_path: policy.path });
    if (!loaded.ok) {
      counters.unavailable += 1;
      checks.push({
        secret_id: secretId,
        status: 'critical',
        reason: loaded.error || 'secret_unavailable',
        available: false,
        provider_errors: loaded.provider_errors || []
      });
      continue;
    }
    const rotation = loaded.rotation && typeof loaded.rotation === 'object'
      ? loaded.rotation
      : { status: 'unknown', reason: 'rotation_missing' };
    const status = normalizeText(rotation.status || 'unknown', 24) || 'unknown';
    if (status === 'ok') counters.ok += 1;
    else if (status === 'warn') counters.warn += 1;
    else if (status === 'critical') counters.critical += 1;
    else counters.unknown += 1;

    checks.push({
      secret_id: secretId,
      status,
      reason: normalizeText(rotation.reason || '', 120) || null,
      available: true,
      provider_type: loaded.backend ? loaded.backend.provider_type || null : null,
      provider_ref: policy.audit.include_backend_details && loaded.backend
        ? loaded.backend.provider_ref || null
        : null,
      external_backend: loaded.backend ? loaded.backend.external === true : null,
      rotated_at: rotation.rotated_at || null,
      age_days: rotation.age_days == null ? null : Number(rotation.age_days),
      warn_after_days: rotation.warn_after_days == null ? null : Number(rotation.warn_after_days),
      max_after_days: rotation.max_after_days == null ? null : Number(rotation.max_after_days),
      enforce_on_issue: rotation.enforce_on_issue === true
    });
  }

  const total = checks.length;
  const level = counters.critical > 0 || counters.unavailable > 0
    ? 'critical'
    : (counters.warn > 0 ? 'warn' : 'ok');
  const out = {
    ok: level !== 'critical',
    type: 'secret_rotation_health',
    ts: nowIso(now),
    policy_path: policy.path,
    policy_version: policy.version,
    total,
    level,
    counts: counters,
    checks
  };
  if (opts.with_audit !== false) {
    audit({
      type: 'secret_rotation_check',
      level,
      total,
      counts: counters
    });
  }
  return out;
}

function secretBrokerStatus(opts: AnyObj = {}): Record<string, any> {
  const policy = loadPolicy(opts.policy_path);
  const state = loadState();
  const issuedRows = Object.values(state.issued || {}) as AnyObj[];
  const activeHandles = issuedRows.filter((row) => {
    const expires = parseTsMs(row && row.expires_at ? row.expires_at : null);
    return Number.isFinite(expires) && Number(expires) > Date.now();
  }).length;
  const rotation = evaluateSecretRotationHealth({ policy_path: policy.path, with_audit: false });

  return {
    ok: true,
    type: 'secret_broker_status',
    ts: nowIso(),
    policy_path: policy.path,
    policy_version: policy.version,
    state_path: STATE_PATH,
    audit_path: AUDIT_PATH,
    supported_secret_ids: Object.keys(policy.secrets || {}),
    issued_total: issuedRows.length,
    issued_active: activeHandles,
    rotation
  };
}

function issueSecretHandle(opts: Record<string, any> = {}): Record<string, any> {
  const keyRes = requireSecretBrokerKey();
  if (!keyRes.ok) return keyRes;

  const secretId = normalizeText(opts.secret_id || opts.secretId || '', 120);
  const scope = normalizeText(opts.scope || '', 180);
  const caller = normalizeText(opts.caller || 'unknown', 180);
  const reason = normalizeText(opts.reason || '', 240) || null;

  if (!secretId) return { ok: false, error: 'secret_id_required' };
  if (!scope) return { ok: false, error: 'scope_required' };

  const secret = loadSecretById(secretId, { now_ms: opts.now_ms, policy_path: opts.policy_path });
  if (!secret.ok) {
    audit({
      type: 'secret_handle_issue_denied',
      secret_id: secretId,
      scope,
      caller,
      reason: secret.error || 'secret_missing'
    });
    return secret;
  }

  const rotation = secret.rotation && typeof secret.rotation === 'object' ? secret.rotation : {};
  if (rotation.enforce_on_issue === true && String(rotation.status || '').toLowerCase() === 'critical') {
    audit({
      type: 'secret_handle_issue_denied',
      secret_id: secretId,
      scope,
      caller,
      reason: 'rotation_policy_enforced',
      rotation_status: rotation.status || 'critical'
    });
    return {
      ok: false,
      error: 'rotation_policy_enforced',
      secret_id: secretId,
      rotation
    };
  }

  const ttlSec = clampInt(opts.ttl_sec, MIN_TTL_SEC, MAX_TTL_SEC, DEFAULT_TTL_SEC);
  const issuedMs = nowMs(opts.now_ms);
  const expiresMs = issuedMs + (ttlSec * 1000);
  const payload = {
    v: '1.1',
    handle_id: makeHandleId(),
    secret_id: secret.secret_id,
    scope,
    caller,
    reason,
    issued_at_ms: issuedMs,
    issued_at: nowIso(issuedMs),
    expires_at_ms: expiresMs,
    expires_at: nowIso(expiresMs),
    nonce: crypto.randomBytes(8).toString('hex')
  };

  const body = base64urlEncode(JSON.stringify(payload));
  const sig = sign(body, keyRes.key);
  const handle = `${body}.${sig}`;

  const state = loadState();
  state.issued[payload.handle_id] = {
    handle_id: payload.handle_id,
    secret_id: payload.secret_id,
    scope: payload.scope,
    caller: payload.caller,
    reason: payload.reason,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    value_hash: secret.value_hash,
    backend_provider_type: secret.backend ? secret.backend.provider_type || null : null,
    backend_provider_ref: secret.backend ? secret.backend.provider_ref || null : null,
    rotation_status: secret.rotation ? secret.rotation.status || null : null,
    resolve_count: 0,
    last_resolved_at: null
  };
  saveState(state);

  audit({
    type: 'secret_handle_issued',
    handle_id: payload.handle_id,
    secret_id: payload.secret_id,
    scope: payload.scope,
    caller: payload.caller,
    ttl_sec: ttlSec,
    reason: payload.reason,
    backend_provider_type: secret.backend ? secret.backend.provider_type || null : null,
    backend_provider_ref: secret.backend ? secret.backend.provider_ref || null : null,
    rotation_status: secret.rotation ? secret.rotation.status || null : null,
    rotation_age_days: secret.rotation ? secret.rotation.age_days || null : null
  });

  return {
    ok: true,
    handle,
    handle_id: payload.handle_id,
    secret_id: payload.secret_id,
    scope: payload.scope,
    caller: payload.caller,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    ttl_sec: ttlSec,
    backend: secret.backend || null,
    rotation: secret.rotation || null
  };
}

function resolveSecretHandle(handle: unknown, opts: Record<string, any> = {}): Record<string, any> {
  const keyRes = requireSecretBrokerKey();
  if (!keyRes.ok) return keyRes;

  const parsed = parseHandle(handle);
  if (!parsed.ok) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: parsed.error || 'handle_invalid',
      scope: normalizeText(opts.scope || '', 180) || null,
      caller: normalizeText(opts.caller || '', 180) || null
    });
    return parsed;
  }

  const expectedSig = sign(parsed.body, keyRes.key);
  if (!safeTimingEqual(parsed.sig, expectedSig)) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: 'handle_signature_invalid',
      handle_id: parsed.payload && parsed.payload.handle_id ? parsed.payload.handle_id : null
    });
    return { ok: false, error: 'handle_signature_invalid' };
  }

  const payload = parsed.payload;
  const handleId = normalizeText(payload.handle_id || '', 120);
  const secretId = normalizeText(payload.secret_id || '', 120);
  const scope = normalizeText(payload.scope || '', 180);
  const caller = normalizeText(payload.caller || '', 180);
  const expMs = Number(payload.expires_at_ms || 0);
  const now = nowMs(opts.now_ms);

  if (!handleId || !secretId || !scope || !caller) {
    return { ok: false, error: 'handle_payload_missing_fields' };
  }
  if (!Number.isFinite(expMs) || expMs <= now) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: 'handle_expired',
      handle_id: handleId,
      secret_id: secretId
    });
    return { ok: false, error: 'handle_expired', handle_id: handleId, secret_id: secretId };
  }

  const requiredScope = normalizeText(opts.scope || '', 180);
  if (requiredScope && requiredScope !== scope) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: 'scope_mismatch',
      handle_id: handleId,
      secret_id: secretId,
      required_scope: requiredScope,
      handle_scope: scope
    });
    return {
      ok: false,
      error: 'scope_mismatch',
      handle_id: handleId,
      secret_id: secretId,
      required_scope: requiredScope,
      handle_scope: scope
    };
  }

  const requiredCaller = normalizeText(opts.caller || '', 180);
  if (requiredCaller && requiredCaller !== caller) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: 'caller_mismatch',
      handle_id: handleId,
      secret_id: secretId,
      required_caller: requiredCaller,
      handle_caller: caller
    });
    return {
      ok: false,
      error: 'caller_mismatch',
      handle_id: handleId,
      secret_id: secretId,
      required_caller: requiredCaller,
      handle_caller: caller
    };
  }

  const state = loadState();
  if (!state.issued[handleId]) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: 'handle_unknown',
      handle_id: handleId,
      secret_id: secretId
    });
    return { ok: false, error: 'handle_unknown', handle_id: handleId, secret_id: secretId };
  }

  const secret = loadSecretById(secretId, { now_ms: now, policy_path: opts.policy_path });
  if (!secret.ok) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: secret.error || 'secret_value_missing',
      handle_id: handleId,
      secret_id: secretId
    });
    return secret;
  }

  state.issued[handleId].resolve_count = Number(state.issued[handleId].resolve_count || 0) + 1;
  state.issued[handleId].last_resolved_at = nowIso(now);
  state.issued[handleId].last_backend_provider_type = secret.backend ? secret.backend.provider_type || null : null;
  state.issued[handleId].last_rotation_status = secret.rotation ? secret.rotation.status || null : null;
  saveState(state);

  audit({
    type: 'secret_handle_resolved',
    handle_id: handleId,
    secret_id: secretId,
    scope,
    caller,
    resolve_count: state.issued[handleId].resolve_count,
    backend_provider_type: secret.backend ? secret.backend.provider_type || null : null,
    backend_provider_ref: secret.backend ? secret.backend.provider_ref || null : null,
    rotation_status: secret.rotation ? secret.rotation.status || null : null,
    rotation_age_days: secret.rotation ? secret.rotation.age_days || null : null
  });

  return {
    ok: true,
    handle_id: handleId,
    secret_id: secretId,
    scope,
    caller,
    expires_at: payload.expires_at || null,
    value: secret.value,
    value_hash: secret.value_hash,
    backend: secret.backend || null,
    rotation: secret.rotation || null
  };
}

module.exports = {
  issueSecretHandle,
  resolveSecretHandle,
  loadSecretById,
  evaluateSecretRotationHealth,
  secretBrokerStatus,
  loadPolicy,
  POLICY_PATH,
  STATE_PATH,
  AUDIT_PATH
};
