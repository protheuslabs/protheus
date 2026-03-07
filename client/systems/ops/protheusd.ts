#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { runSpineCommand } = require('../../lib/spine_conduit_bridge');

const ROOT = path.resolve(__dirname, '..', '..');
const INTERNAL_AMBIENT_LOOP = '__ambient-loop';

function usage() {
  console.log('Usage: protheusd start|stop|restart|status|tick [--policy=<path>] [--conduit] [--allow-legacy-fallback] [--autostart] [--no-autostart] [--no-cockpit]');
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseJson(text: unknown) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, payload: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath: string, payload: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function deterministicHash(payload: any) {
  const canonical = JSON.stringify(payload, Object.keys(payload || {}).sort());
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function withReceipt(payload: any) {
  const out = payload && typeof payload === 'object' ? payload : {};
  out.receipt_hash = deterministicHash(out);
  return out;
}

function toBool(v: unknown, fallback = false) {
  const raw = String(v == null ? '' : v).trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function toInt(v: unknown, fallback: number, lo: number, hi: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function parseFlag(argv: string[], key: string) {
  const pref = `--${key}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (token.startsWith(pref)) return token.slice(pref.length);
    if (token === `--${key}`) {
      const next = String(argv[i + 1] || '');
      if (next && !next.startsWith('--')) return next;
      return '1';
    }
  }
  return null;
}

function resolvePath(root: string, maybePath: unknown, fallbackRel: string) {
  const raw = cleanText(maybePath, 500);
  const base = raw || fallbackRel;
  return path.isAbsolute(base) ? base : path.join(root, base);
}

function isPidAlive(pid: unknown) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultControlPlanePaths(root: string) {
  const stateRoot = path.join(root, 'local', 'state', 'ops', 'protheus_control_plane');
  return {
    stateRoot,
    daemonPath: path.join(stateRoot, 'daemon.json'),
    commandsPath: path.join(stateRoot, 'commands.jsonl'),
    latestPath: path.join(stateRoot, 'latest.json'),
    receiptsPath: path.join(stateRoot, 'receipts.jsonl')
  };
}

function readConduitRuntimeGate(root: string) {
  const gatePath = path.join(root, 'local', 'state', 'conduit', 'runtime_gate.json');
  const payload = readJson(gatePath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      available: false,
      path: gatePath,
      gate_active: false
    };
  }
  return {
    available: true,
    path: gatePath,
    gate_active: payload.gate_active === true,
    blocked_until: cleanText(payload.blocked_until || '', 64) || null,
    blocked_until_ms: Number.isFinite(Number(payload.blocked_until_ms))
      ? Number(payload.blocked_until_ms)
      : null,
    remaining_ms: Number.isFinite(Number(payload.blocked_until_ms))
      ? Math.max(0, Number(payload.blocked_until_ms) - Date.now())
      : 0,
    consecutive_failures: Number.isFinite(Number(payload.consecutive_failures))
      ? Number(payload.consecutive_failures)
      : 0,
    threshold: Number.isFinite(Number(payload.threshold))
      ? Number(payload.threshold)
      : null,
    last_error: cleanText(payload.last_error || '', 260) || null,
    last_failure_at: cleanText(payload.last_failure_at || '', 64) || null,
    updated_at: cleanText(payload.updated_at || '', 64) || null
  };
}

function loadMechPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const spine = raw && raw.spine && typeof raw.spine === 'object' ? raw.spine : {};
  const state = raw && raw.state && typeof raw.state === 'object' ? raw.state : {};
  const eyes = raw && raw.eyes && typeof raw.eyes === 'object' ? raw.eyes : {};
  const personas = raw && raw.personas && typeof raw.personas === 'object' ? raw.personas : {};
  const dopamine = raw && raw.dopamine && typeof raw.dopamine === 'object' ? raw.dopamine : {};
  return {
    enabled: raw && raw.enabled !== false,
    heartbeatHours: toInt(spine.heartbeat_hours, 4, 1, 168),
    manualTriggersAllowed: spine.manual_triggers_allowed === true,
    statusPath: resolvePath(ROOT, state.status_path, 'local/state/ops/mech_suit_mode/latest.json'),
    attentionLatestPath: resolvePath(ROOT, eyes.latest_path, 'local/state/attention/latest.json'),
    personaLatestPath: resolvePath(ROOT, personas.latest_path, 'local/state/personas/ambient_stance/latest.json'),
    dopamineLatestPath: resolvePath(ROOT, dopamine.latest_path, 'local/state/dopamine/ambient/latest.json')
  };
}

function resolveRuntime(argv: string[]) {
  const policyArg = cleanText(parseFlag(argv, 'policy') || process.env.PROTHEUS_CONTROL_PLANE_POLICY_PATH, 500);
  const policyPath = policyArg
    ? (path.isAbsolute(policyArg) ? policyArg : path.join(ROOT, policyArg))
    : path.join(ROOT, 'config', 'protheus_control_plane_policy.json');
  const policy = readJson(policyPath, {});
  const defaults = defaultControlPlanePaths(ROOT);
  const paths = policy && policy.paths && typeof policy.paths === 'object' ? policy.paths : {};
  const stateRoot = resolvePath(ROOT, paths.state_root, path.relative(ROOT, defaults.stateRoot));
  const daemonPath = resolvePath(ROOT, paths.daemon_path, path.relative(ROOT, defaults.daemonPath));
  const commandsPath = resolvePath(ROOT, paths.commands_path, path.relative(ROOT, defaults.commandsPath));
  const latestPath = resolvePath(ROOT, paths.latest_path, path.relative(ROOT, defaults.latestPath));
  const receiptsPath = resolvePath(ROOT, paths.receipts_path, path.relative(ROOT, defaults.receiptsPath));

  const mechPolicyPathRaw = cleanText(process.env.MECH_SUIT_MODE_POLICY_PATH || '', 500);
  const mechPolicyPath = mechPolicyPathRaw
    ? (path.isAbsolute(mechPolicyPathRaw) ? mechPolicyPathRaw : path.join(ROOT, mechPolicyPathRaw))
    : path.join(ROOT, 'config', 'mech_suit_mode_policy.json');
  const mechPolicy = loadMechPolicy(mechPolicyPath);

  const heartbeatOverrideSec = toInt(process.env.PROTHEUS_AMBIENT_HEARTBEAT_SECONDS, 0, 0, 365 * 24 * 3600);
  const heartbeatMs = heartbeatOverrideSec > 0
    ? heartbeatOverrideSec * 1000
    : mechPolicy.heartbeatHours * 60 * 60 * 1000;
  const pollMs = toInt(process.env.PROTHEUS_AMBIENT_LOOP_POLL_MS, 15000, 1000, 300000);
  const spineRunTimeoutMs = toInt(
    process.env.PROTHEUSD_SPINE_RUN_TIMEOUT_MS || process.env.PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS,
    300000,
    1000,
    15 * 60 * 1000
  );
  const spineStatusTimeoutMs = toInt(
    process.env.PROTHEUSD_SPINE_STATUS_TIMEOUT_MS || process.env.PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS,
    120000,
    1000,
    15 * 60 * 1000
  );

  const cockpitInboxDirRaw = cleanText(parseFlag(argv, 'inbox-dir') || process.env.COCKPIT_INBOX_DIR, 500);
  const cockpitInboxDir = cockpitInboxDirRaw
    ? (path.isAbsolute(cockpitInboxDirRaw) ? cockpitInboxDirRaw : path.join(ROOT, cockpitInboxDirRaw))
    : path.join(ROOT, 'local', 'state', 'cockpit', 'inbox');
  const consumerId = cleanText(parseFlag(argv, 'consumer') || process.env.COCKPIT_CONSUMER_ID || 'cockpit_llm', 80)
    .toLowerCase()
    .replace(/[^a-z0-9._:@-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'cockpit_llm';
  const batchLimit = toInt(parseFlag(argv, 'limit') || process.env.COCKPIT_BATCH_LIMIT, 24, 1, 512);

  return {
    root: ROOT,
    policyPath,
    policy,
    stateRoot,
    daemonPath,
    commandsPath,
    latestPath,
    receiptsPath,
    mechPolicyPath,
    mechPolicy,
    heartbeatMs,
    spineRunTimeoutMs,
    spineStatusTimeoutMs,
    pollMs,
    cockpitInboxDir,
    cockpitLatestPath: path.join(cockpitInboxDir, 'latest.json'),
    cockpitStatePath: path.join(cockpitInboxDir, 'state.json'),
    consumerId,
    batchLimit
  };
}

function loadDaemonState(runtime: any) {
  const existing = readJson(runtime.daemonPath, {});
  return {
    schema_version: '1.0',
    running: existing && existing.running === true,
    mode: cleanText(existing && existing.mode || 'ambient', 40) || 'ambient',
    pid: Number.isFinite(Number(existing && existing.pid)) ? Number(existing.pid) : null,
    started_at: cleanText(existing && existing.started_at || '', 64) || null,
    updated_at: cleanText(existing && existing.updated_at || '', 64) || null,
    request_seq: Number.isFinite(Number(existing && existing.request_seq)) ? Number(existing.request_seq) : 0,
    run_seq: Number.isFinite(Number(existing && existing.run_seq)) ? Number(existing.run_seq) : 0,
    heartbeat_hours: runtime.mechPolicy.heartbeatHours,
    last_heartbeat_at: cleanText(existing && existing.last_heartbeat_at || '', 64) || null,
    next_heartbeat_at: cleanText(existing && existing.next_heartbeat_at || '', 64) || null,
    last_heartbeat_code: Number.isFinite(Number(existing && existing.last_heartbeat_code))
      ? Number(existing.last_heartbeat_code)
      : null,
    cockpit_watch: existing && existing.cockpit_watch && typeof existing.cockpit_watch === 'object'
      ? existing.cockpit_watch
      : {
          pid: null,
          restarts: 0,
          started_at: null,
          last_exit_at: null,
          last_exit_code: null
        },
    last_error: cleanText(existing && existing.last_error || '', 260) || null
  };
}

function persistDaemonState(runtime: any, state: any) {
  const normalized = {
    ...state,
    updated_at: nowIso()
  };
  writeJson(runtime.daemonPath, normalized);
  return normalized;
}

function emitLatest(runtime: any, payload: any) {
  writeJson(runtime.latestPath, payload);
  appendJsonl(runtime.receiptsPath, payload);
}

function recordCommand(runtime: any, command: string, args: string[], requestId: string) {
  appendJsonl(runtime.commandsPath, {
    ts: nowIso(),
    request_id: requestId,
    command,
    args: {
      _: args
    },
    status: 'queued'
  });
}

function runNode(script: string, args: string[], opts: any = {}) {
  const out = spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(opts.env || {})
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || ''),
    payload: parseJson(out.stdout)
  };
}

async function runHeartbeat(runtime: any, trigger: string) {
  const date = nowIso().slice(0, 10);
  const args = ['run', 'daily', date];
  const maxEyes = toInt(process.env.PROTHEUS_AMBIENT_MAX_EYES, 0, 0, 500);
  if (maxEyes > 0) args.push(`--max-eyes=${maxEyes}`);
  const primarySpine = await runSpineCommand(args, {
    cwdHint: runtime.root,
    runContext: 'heartbeat',
    timeoutMs: runtime.spineRunTimeoutMs
  });
  let spine = primarySpine;
  let spineFallbackApplied = false;
  if (!spine || spine.ok !== true) {
    const fallback = await runSpineCommand(
      ['status', '--mode=daily', `--date=${date}`],
      {
        cwdHint: runtime.root,
        runContext: 'heartbeat',
        timeoutMs: runtime.spineStatusTimeoutMs
      }
    );
    if (fallback && fallback.ok === true) {
      spineFallbackApplied = true;
      spine = {
        ...fallback,
        payload: {
          ...(fallback.payload && typeof fallback.payload === 'object' ? fallback.payload : {}),
          type: 'spine_status_heartbeat_fallback',
          heartbeat_fallback: true,
          primary_failure_reason: cleanText(
            primarySpine && primarySpine.payload && primarySpine.payload.reason
              ? primarySpine.payload.reason
              : primarySpine && primarySpine.stderr
                ? primarySpine.stderr
                : 'spine_run_daily_failed',
            240
          )
        }
      };
    }
  }

  const cockpit = runNode(
    path.join(runtime.root, 'systems', 'ops', 'cockpit_harness.js'),
    [
      'once',
      `--consumer=${runtime.consumerId}`,
      `--limit=${runtime.batchLimit}`,
      `--inbox-dir=${runtime.cockpitInboxDir}`
    ],
    { cwd: runtime.root }
  );

  const state = loadDaemonState(runtime);
  state.run_seq = Number(state.run_seq || 0) + 1;
  state.last_heartbeat_at = nowIso();
  state.next_heartbeat_at = new Date(Date.now() + runtime.heartbeatMs).toISOString();
  state.last_heartbeat_code = spine && spine.ok && cockpit.status === 0 ? 0 : 1;
  if (!spine || spine.ok !== true) {
    state.last_error = cleanText(
      spine && spine.payload && spine.payload.reason
        ? spine.payload.reason
        : spine && spine.stderr
          ? spine.stderr
          : 'spine_heartbeat_failed',
      260
    );
  } else if (cockpit.status !== 0) {
    state.last_error = cleanText(cockpit.stderr || 'cockpit_ingest_failed', 260);
  } else {
    state.last_error = null;
  }
  persistDaemonState(runtime, state);

  const receipt = withReceipt({
    ok: state.last_heartbeat_code === 0,
    shadow_only: false,
    type: 'protheus_job_runner_tick',
    ts: nowIso(),
    trigger: cleanText(trigger, 80) || 'heartbeat',
    processed: 1,
    spine: {
      ok: spine && spine.ok === true,
      status: Number.isFinite(Number(spine && spine.status)) ? Number(spine.status) : 1,
      type: spine && spine.payload && spine.payload.type ? spine.payload.type : 'spine_run',
      heartbeat_fallback: spineFallbackApplied,
      primary_status: Number.isFinite(Number(primarySpine && primarySpine.status))
        ? Number(primarySpine.status)
        : null
    },
    cockpit: {
      ok: cockpit.status === 0,
      status: cockpit.status,
      type: cockpit.payload && cockpit.payload.type ? cockpit.payload.type : 'cockpit_context_envelope'
    },
    run_seq: state.run_seq,
    next_heartbeat_at: state.next_heartbeat_at
  });
  emitLatest(runtime, receipt);
  return receipt;
}

async function runAmbientLoop(argv: string[]) {
  const runtime = resolveRuntime(argv);
  let state = loadDaemonState(runtime);
  const pid = process.pid;

  state.running = true;
  state.mode = 'ambient';
  state.pid = pid;
  if (!state.started_at) state.started_at = nowIso();
  state.updated_at = nowIso();
  state.heartbeat_hours = runtime.mechPolicy.heartbeatHours;
  state.next_heartbeat_at = nowIso();
  persistDaemonState(runtime, state);

  let shuttingDown = false;
  let heartbeatInFlight = false;
  let watchProc: any = null;

  const watcherRestartDelayMs = (restarts: number) => {
    const gate = readConduitRuntimeGate(runtime.root);
    if (gate && gate.gate_active === true) {
      const remaining = Number(gate.remaining_ms || 0);
      return Math.max(5000, Math.min(5 * 60 * 1000, Number.isFinite(remaining) ? remaining : 60000));
    }
    const safeRestarts = Math.max(0, Number(restarts || 0));
    return Math.min(5 * 60 * 1000, Math.max(1000, 1000 * Math.pow(2, Math.min(8, safeRestarts))));
  };

  const launchWatcher = () => {
    const script = path.join(runtime.root, 'systems', 'ops', 'cockpit_harness.js');
    const args = [
      script,
      'watch',
      `--consumer=${runtime.consumerId}`,
      `--limit=${runtime.batchLimit}`,
      '--once=1',
      `--inbox-dir=${runtime.cockpitInboxDir}`
    ];
    const child = spawn(process.execPath, args, {
      cwd: runtime.root,
      detached: false,
      stdio: 'ignore',
      env: {
        ...process.env,
        COCKPIT_CONSUMER_ID: runtime.consumerId,
        COCKPIT_INBOX_DIR: runtime.cockpitInboxDir
      }
    });
    const next = loadDaemonState(runtime);
    next.cockpit_watch = {
      ...(next.cockpit_watch || {}),
      pid: Number.isFinite(Number(child.pid)) ? Number(child.pid) : null,
      started_at: nowIso(),
      restarts: Number(next.cockpit_watch && next.cockpit_watch.restarts || 0)
    };
    persistDaemonState(runtime, next);
    child.on('exit', (code: number) => {
      const row = loadDaemonState(runtime);
      row.cockpit_watch = {
        ...(row.cockpit_watch || {}),
        pid: null,
        last_exit_at: nowIso(),
        last_exit_code: Number.isFinite(Number(code)) ? Number(code) : null,
        restarts: Number(row.cockpit_watch && row.cockpit_watch.restarts || 0) + (shuttingDown ? 0 : 1)
      };
      persistDaemonState(runtime, row);
      if (!shuttingDown) {
        const restarts = Number(row.cockpit_watch && row.cockpit_watch.restarts || 0);
        const delayMs = watcherRestartDelayMs(restarts);
        setTimeout(() => {
          if (!shuttingDown) {
            watchProc = launchWatcher();
          }
        }, delayMs);
      }
    });
    return child;
  };

  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (watchProc && Number.isFinite(Number(watchProc.pid))) {
      try { process.kill(Number(watchProc.pid), 'SIGTERM'); } catch {}
    }
    const row = loadDaemonState(runtime);
    row.running = false;
    row.mode = 'stopped';
    row.last_error = reason ? cleanText(reason, 200) : row.last_error;
    persistDaemonState(runtime, row);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('signal_sigterm'));
  process.on('SIGINT', () => shutdown('signal_sigint'));

  watchProc = launchWatcher();

  const maybeHeartbeat = async (trigger: string) => {
    if (heartbeatInFlight || shuttingDown) return;
    const row = loadDaemonState(runtime);
    const nextDueMs = row.next_heartbeat_at ? Date.parse(String(row.next_heartbeat_at)) : Date.now();
    if (Number.isFinite(nextDueMs) && Date.now() < nextDueMs) return;
    heartbeatInFlight = true;
    try {
      await runHeartbeat(runtime, trigger);
    } finally {
      heartbeatInFlight = false;
    }
  };

  await maybeHeartbeat('startup');
  setInterval(() => {
    if (shuttingDown) return;
    const row = loadDaemonState(runtime);
    row.running = true;
    row.mode = 'ambient';
    row.pid = pid;
    persistDaemonState(runtime, row);
    maybeHeartbeat('interval').catch(() => {});
  }, runtime.pollMs);
}

function runLegacy(command: string, extraArgs: string[], opts: { exitOnFinish?: boolean } = {}) {
  const script = path.join(__dirname, 'protheus_control_plane.js');
  const args = [script, command, ...extraArgs];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const status = Number.isFinite(r.status) ? Number(r.status) : 1;
  if (opts.exitOnFinish !== false) process.exit(status);
  return { ok: status === 0, status };
}

function runConduitEnabled(argv: string[]) {
  if (argv.includes('--no-conduit')) return false;
  if (argv.includes('--conduit')) return true;
  return process.env.PROTHEUS_CONDUIT_ENABLED === '1';
}

function allowLegacyFallback(argv: string[]) {
  if (argv.includes('--allow-legacy-fallback')) return true;
  return process.env.PROTHEUS_ALLOW_LEGACY_FALLBACK === '1';
}

function conduitStrict(argv: string[], command: string) {
  if (!['start', 'stop', 'status'].includes(command)) return false;
  if (allowLegacyFallback(argv)) return false;
  return String(process.env.PROTHEUS_CONDUIT_STRICT || '0').trim() === '1';
}

function stripControlFlags(argv: string[]) {
  return argv.filter((arg) => (
    arg !== '--conduit'
    && arg !== '--no-conduit'
    && arg !== '--allow-legacy-fallback'
    && arg !== '--autostart'
    && arg !== '--no-autostart'
    && arg !== '--cockpit'
    && arg !== '--no-cockpit'
  ));
}

function ambientAutostartEnabled(argv: string[]) {
  if (argv.includes('--no-autostart')) return false;
  if (argv.includes('--autostart')) return true;
  return String(process.env.PROTHEUS_AMBIENT_AUTOSTART || '1').trim() !== '0';
}

function parseAgentId(args: string[]) {
  const explicit = args.find((arg) => arg.startsWith('--agent='));
  if (explicit) return String(explicit.slice('--agent='.length) || '').trim() || 'protheus-default';
  return 'protheus-default';
}

type ConduitRouteResult = {
  routed: boolean;
  ok: boolean;
  error?: string;
};

async function runConduit(command: string, extraArgs: string[]): Promise<ConduitRouteResult> {
  if (!['start', 'stop', 'status'].includes(command)) {
    return { routed: false, ok: false, error: 'unsupported_command' };
  }

  let ConduitClient: any;
  try {
    ({ ConduitClient } = require('../conduit/conduit-client'));
  } catch {
    ({ ConduitClient } = require('../conduit/conduit-client.ts'));
  }
  const daemonCommand = process.env.CONDUIT_DAEMON_CMD || 'cargo';
  const daemonArgs = process.env.CONDUIT_DAEMON_ARGS
    ? process.env.CONDUIT_DAEMON_ARGS.split(' ').filter(Boolean)
    : ['run', '--quiet', '-p', 'conduit', '--bin', 'conduit_daemon'];

  const client = ConduitClient.overStdio(daemonCommand, daemonArgs, process.cwd());
  try {
    const requestId = `protheusd-${Date.now()}`;
    const message =
      command === 'start'
        ? { type: 'start_agent', agent_id: parseAgentId(extraArgs) }
        : command === 'stop'
          ? { type: 'stop_agent', agent_id: parseAgentId(extraArgs) }
          : { type: 'get_system_status' };

    const response = await client.send(message as any, requestId);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return { routed: true, ok: response.validation.ok };
  } catch (error: any) {
    return {
      routed: false,
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  } finally {
    await client.close();
  }
}

function statusReceipt(runtime: any, state: any) {
  const running = isPidAlive(state.pid);
  const daemon = {
    running,
    mode: running ? 'ambient' : 'stopped',
    pid: running ? state.pid : null,
    started_at: state.started_at || null,
    updated_at: state.updated_at || null,
    run_seq: Number(state.run_seq || 0),
    heartbeat_hours: runtime.mechPolicy.heartbeatHours,
    last_heartbeat_at: state.last_heartbeat_at || null,
    next_heartbeat_at: state.next_heartbeat_at || null,
    last_heartbeat_code: Number.isFinite(Number(state.last_heartbeat_code))
      ? Number(state.last_heartbeat_code)
      : null,
    last_error: cleanText(state.last_error || '', 260) || null,
    cockpit_watch: state.cockpit_watch || null
  };
  const mechLatest = readJson(runtime.mechPolicy.statusPath, null);
  const attentionLatest = readJson(runtime.mechPolicy.attentionLatestPath, null);
  const personaLatest = readJson(runtime.mechPolicy.personaLatestPath, null);
  const dopamineLatest = readJson(runtime.mechPolicy.dopamineLatestPath, null);
  const cockpitLatest = readJson(runtime.cockpitLatestPath, null);
  const cockpitState = readJson(runtime.cockpitStatePath, null);
  const conduitRuntimeGate = readConduitRuntimeGate(runtime.root);
  const heartbeatHealthy = daemon.last_heartbeat_code === 0;
  const ambientConfigured = !!(mechLatest && mechLatest.active === true);
  const ambientHealthy = ambientConfigured && running && heartbeatHealthy;
  const degradedReason = conduitRuntimeGate.gate_active === true
    ? 'conduit_runtime_gate_active'
    : !ambientConfigured
    ? 'ambient_policy_inactive'
    : !running
      ? 'daemon_stopped'
      : !heartbeatHealthy
        ? (daemon.last_error ? 'heartbeat_failed' : 'heartbeat_missing')
        : null;

  return withReceipt({
    ok: true,
    shadow_only: false,
    type: 'protheus_control_plane_status',
    ts: nowIso(),
    updated: state.updated_at || nowIso(),
    daemon,
    ambient_mode: {
      active: ambientHealthy,
      configured: ambientConfigured,
      healthy: ambientHealthy,
      degraded_reason: degradedReason,
      manual_triggers_allowed: runtime.mechPolicy.manualTriggersAllowed,
      heartbeat_hours: runtime.mechPolicy.heartbeatHours
    },
    conduit_runtime_gate: conduitRuntimeGate,
    cockpit: {
      available: !!cockpitLatest,
      path: runtime.cockpitLatestPath,
      sequence: cockpitLatest && Number(cockpitLatest.sequence || 0),
      consumer_id: cockpitLatest && cockpitLatest.consumer_id || (cockpitState && cockpitState.consumer_id) || null,
      last_ingest_ts: cockpitLatest && cockpitLatest.ts || (cockpitState && cockpitState.last_ingest_ts) || null,
      batch_count: cockpitLatest && cockpitLatest.attention ? Number(cockpitLatest.attention.batch_count || 0) : 0
    },
    attention: attentionLatest && typeof attentionLatest === 'object'
      ? {
          queue_depth: Number(attentionLatest.queue_depth || 0),
          last_action: cleanText(attentionLatest.last_action || '', 80) || null,
          ts: cleanText(attentionLatest.ts || '', 64) || null
        }
      : null,
    persona: personaLatest && typeof personaLatest === 'object'
      ? {
          ts: cleanText(personaLatest.ts || '', 64) || null,
          type: cleanText(personaLatest.type || '', 80) || null
        }
      : null,
    dopamine: dopamineLatest && typeof dopamineLatest === 'object'
      ? {
          ts: cleanText(dopamineLatest.ts || '', 64) || null,
          type: cleanText(dopamineLatest.type || '', 80) || null
        }
      : null
  });
}

function startDaemon(runtime: any, argv: string[], opts: { exitOnFinish?: boolean } = {}) {
  const exitOnFinish = opts.exitOnFinish !== false;
  const state = loadDaemonState(runtime);
  const requestId = `req_${String(Number(state.request_seq || 0) + 1).padStart(6, '0')}`;
  recordCommand(runtime, 'start', argv, requestId);

  if (isPidAlive(state.pid)) {
    const out = withReceipt({
      ok: true,
      shadow_only: false,
      type: 'protheus_daemon_control',
      ts: nowIso(),
      command: 'start',
      request_id: requestId,
      running: true,
      mode: 'ambient',
      already_running: true,
      pid: state.pid
    });
    emitLatest(runtime, out);
    if (exitOnFinish) {
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exit(0);
    }
    return out;
  }

  const script = path.join(__dirname, 'protheusd.js');
  const childArgs = [script, INTERNAL_AMBIENT_LOOP, `--policy=${runtime.policyPath}`, `--inbox-dir=${runtime.cockpitInboxDir}`, `--consumer=${runtime.consumerId}`, `--limit=${runtime.batchLimit}`];
  const child = spawn(process.execPath, childArgs, {
    cwd: runtime.root,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      MECH_SUIT_MODE_POLICY_PATH: runtime.mechPolicyPath
    }
  });
  child.unref();

  const next = loadDaemonState(runtime);
  next.running = true;
  next.mode = 'ambient';
  next.pid = Number.isFinite(Number(child.pid)) ? Number(child.pid) : null;
  next.started_at = nowIso();
  next.request_seq = Number(next.request_seq || 0) + 1;
  next.heartbeat_hours = runtime.mechPolicy.heartbeatHours;
  next.next_heartbeat_at = nowIso();
  persistDaemonState(runtime, next);

  const out = withReceipt({
    ok: true,
    shadow_only: false,
    type: 'protheus_daemon_control',
    ts: nowIso(),
    command: 'start',
    request_id: requestId,
    running: true,
    mode: 'ambient',
    pid: next.pid
  });
  emitLatest(runtime, out);
  if (exitOnFinish) {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  return out;
}

function stopDaemon(runtime: any, argv: string[], opts: { exitOnFinish?: boolean } = {}) {
  const exitOnFinish = opts.exitOnFinish !== false;
  const state = loadDaemonState(runtime);
  const requestId = `req_${String(Number(state.request_seq || 0) + 1).padStart(6, '0')}`;
  recordCommand(runtime, 'stop', argv, requestId);

  let stoppedPid = null;
  if (isPidAlive(state.pid)) {
    stoppedPid = Number(state.pid);
    try { process.kill(stoppedPid, 'SIGTERM'); } catch {}
  }

  const next = loadDaemonState(runtime);
  next.running = false;
  next.mode = 'stopped';
  next.pid = null;
  next.request_seq = Number(next.request_seq || 0) + 1;
  next.updated_at = nowIso();
  next.next_heartbeat_at = null;
  persistDaemonState(runtime, next);

  const out = withReceipt({
    ok: true,
    shadow_only: false,
    type: 'protheus_daemon_control',
    ts: nowIso(),
    command: 'stop',
    request_id: requestId,
    running: false,
    mode: 'stopped',
    stopped_pid: stoppedPid
  });
  emitLatest(runtime, out);
  if (exitOnFinish) {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  return out;
}

async function runTick(runtime: any, argv: string[]) {
  const state = loadDaemonState(runtime);
  const requestId = `req_${String(Number(state.request_seq || 0) + 1).padStart(6, '0')}`;
  recordCommand(runtime, 'tick', argv, requestId);
  const out = await runHeartbeat(runtime, 'manual_tick');
  const enriched = withReceipt({
    ...out,
    request_id: requestId
  });
  emitLatest(runtime, enriched);
  process.stdout.write(`${JSON.stringify(enriched)}\n`);
  process.exit(enriched.ok ? 0 : 1);
}

function runStatus(runtime: any, argv: string[]) {
  let state = loadDaemonState(runtime);
  if (!isPidAlive(state.pid) && runtime.mechPolicy.enabled === true && ambientAutostartEnabled(argv)) {
    startDaemon(runtime, argv, { exitOnFinish: false });
    state = loadDaemonState(runtime);
  }
  const requestId = `req_${String(Number(state.request_seq || 0) + 1).padStart(6, '0')}`;
  recordCommand(runtime, 'status', argv, requestId);
  const out = statusReceipt(runtime, state);
  emitLatest(runtime, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = String(argv[0] || 'status').trim();
  const rest = stripControlFlags(argv.slice(1));
  const strictConduit = conduitStrict(argv, cmd);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  if (cmd === INTERNAL_AMBIENT_LOOP) {
    await runAmbientLoop(rest);
    return;
  }

  if ((runConduitEnabled(argv) || strictConduit) && ['start', 'stop', 'status'].includes(cmd)) {
    const routed = await runConduit(cmd, rest);
    if (routed.routed) {
      process.exit(routed.ok ? 0 : 1);
      return;
    }
    if (strictConduit) {
      process.stderr.write(`conduit_required_strict:${routed.error || 'route_failed'}\n`);
      process.exit(1);
      return;
    }
    if (!allowLegacyFallback(argv)) {
      process.stderr.write(`conduit_required:${routed.error || 'route_failed'}\n`);
      process.exit(1);
      return;
    }
    process.stderr.write(`conduit_fallback_to_local:${routed.error || 'route_failed'}\n`);
  }

  const runtime = resolveRuntime(rest);

  if (cmd === 'start') {
    startDaemon(runtime, argv);
    return;
  }
  if (cmd === 'stop') {
    stopDaemon(runtime, argv);
    return;
  }
  if (cmd === 'restart') {
    stopDaemon(runtime, argv, { exitOnFinish: false });
    const out = startDaemon(runtime, argv, { exitOnFinish: false });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(out && out.ok === true ? 0 : 1);
    return;
  }
  if (cmd === 'status') {
    runStatus(runtime, argv);
    return;
  }
  if (cmd === 'tick') {
    await runTick(runtime, argv);
    return;
  }

  runLegacy(cmd, rest);
}

main().catch((error) => {
  process.stderr.write(`protheusd_error:${error && error.message ? error.message : String(error)}\n`);
  process.exit(1);
});
