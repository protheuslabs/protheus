#!/usr/bin/env tsx
// Unified dashboard lane: TypeScript-first client UI over Rust-core authority.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const ts = require('typescript');
const { WebSocketServer } = require('ws');
const { ROOT } = require('../ops/run_protheus_ops.js');

const DASHBOARD_DIR = __dirname;
const OPS_BRIDGE_PATH = path.resolve(ROOT, 'client/runtime/systems/ops/run_protheus_ops.js');
const INFRING_PRIMARY_STATIC_DIR = path.resolve(
  ROOT,
  'client/runtime/systems/ui/openclaw_static'
);
const PROTHEUSD_DEBUG_BIN = path.resolve(ROOT, 'target/debug/protheusd');
const PROTHEUSD_RELEASE_BIN = path.resolve(ROOT, 'target/release/protheusd');
const CLIENT_TS_PATH = path.resolve(DASHBOARD_DIR, 'infring_dashboard_client.tsx');
const FALLBACK_TS_PATH = path.resolve(DASHBOARD_DIR, 'infring_dashboard_fallback.ts');
const CSS_PATH = path.resolve(DASHBOARD_DIR, 'infring_dashboard.css');
const STATE_DIR = path.resolve(ROOT, 'client/runtime/local/state/ui/infring_dashboard');
const AGENT_SESSIONS_DIR = path.resolve(STATE_DIR, 'agent_sessions');
const ACTION_DIR = path.resolve(STATE_DIR, 'actions');
const ACTION_LATEST_PATH = path.resolve(ACTION_DIR, 'latest.json');
const ACTION_HISTORY_PATH = path.resolve(ACTION_DIR, 'history.jsonl');
const SNAPSHOT_LATEST_PATH = path.resolve(STATE_DIR, 'latest_snapshot.json');
const SNAPSHOT_HISTORY_PATH = path.resolve(STATE_DIR, 'snapshot_history.jsonl');
const ATTENTION_DEFERRED_PATH = path.resolve(STATE_DIR, 'attention_deferred.json');
const ARCHIVED_AGENTS_PATH = path.resolve(STATE_DIR, 'archived_agents.json');
const AGENT_CONTRACTS_PATH = path.resolve(STATE_DIR, 'agent_contracts.json');
const AGENT_PROFILES_PATH = path.resolve(STATE_DIR, 'agent_profiles.json');
const BENCHMARK_SANITY_STATE_PATH = path.resolve(ROOT, 'core/local/state/ops/benchmark_sanity/latest.json');
const BENCHMARK_SANITY_GATE_PATH = path.resolve(ROOT, 'core/local/artifacts/benchmark_sanity_gate_current.json');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const DEFAULT_TEAM = 'ops';
const DEFAULT_REFRESH_MS = 2000;
const DASHBOARD_BACKPRESSURE_BATCH_DEPTH = 75;
const DASHBOARD_BACKPRESSURE_WARN_DEPTH = 50;
const DASHBOARD_QUEUE_DRAIN_PAUSE_DEPTH = 80;
const DASHBOARD_QUEUE_DRAIN_RESUME_DEPTH = 50;
const RUNTIME_CRITICAL_ESCALATION_THRESHOLD = 7;
const RUNTIME_COCKPIT_BLOCK_ESCALATION_THRESHOLD = 30;
const RUNTIME_AUTO_BALANCE_THRESHOLD = 12;
const RUNTIME_DRAIN_TRIGGER_DEPTH = 60;
const RUNTIME_DRAIN_CLEAR_DEPTH = 40;
const RUNTIME_DRAIN_AGENT_TARGET = 2;
const RUNTIME_DRAIN_AGENT_HIGH_LOAD_TARGET = 6;
const RUNTIME_DRAIN_HIGH_LOAD_DEPTH = 80;
const RUNTIME_DRAIN_AGENT_MAX = 8;
const RUNTIME_HEALTH_ADAPTIVE_WINDOW_SECONDS = 60;
const RUNTIME_THROTTLE_PLANE = 'backlog_delivery_plane';
const RUNTIME_THROTTLE_MAX_DEPTH = 75;
const RUNTIME_THROTTLE_STRATEGY = 'priority-shed';
const RUNTIME_INGRESS_DAMPEN_DEPTH = 40;
const RUNTIME_INGRESS_SHED_DEPTH = 80;
const RUNTIME_INGRESS_CIRCUIT_DEPTH = 100;
const RUNTIME_INGRESS_DELAY_MS = 100;
const RUNTIME_CONDUIT_WATCHDOG_MIN_SIGNALS = 6;
const RUNTIME_CONDUIT_WATCHDOG_STALE_MS = 30_000;
const RUNTIME_CONDUIT_WATCHDOG_COOLDOWN_MS = 60_000;
const RUNTIME_COCKPIT_STALE_BLOCK_MS = 90_000;
const RUNTIME_ATTENTION_DRAIN_MIN_BATCH = 16;
const RUNTIME_ATTENTION_DRAIN_MAX_BATCH = 96;
const RUNTIME_ATTENTION_COMPACT_DEPTH = 90;
const RUNTIME_ATTENTION_COMPACT_RETAIN = 24;
const RUNTIME_ATTENTION_COMPACT_MIN_ACKED = 16;
const RUNTIME_AUTONOMY_HEAL_INTERVAL_MS = 15_000;
const RUNTIME_AUTONOMY_HEAL_EMERGENCY_INTERVAL_MS = 5_000;
const RUNTIME_STALL_WINDOW = 6;
const RUNTIME_STALL_CONDUIT_FLOOR = 6;
const RUNTIME_STALL_QUEUE_MIN_DEPTH = 60;
const RUNTIME_STALL_ESCALATION_FAILURE_THRESHOLD = 3;
const RUNTIME_STALL_DRAIN_LIMIT = 96;
const DASHBOARD_BENCHMARK_STALE_SECONDS = 48 * 60 * 60;
const RUNTIME_TREND_WINDOW = 120;
const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.txt', '.svg', '.map']);
const OLLAMA_BIN = 'ollama';
const OLLAMA_MODEL_FALLBACK = 'qwen2.5:3b';
const OLLAMA_TIMEOUT_MS = 45000;
const TOOL_ITERATION_LIMIT = 4;
const TOOL_OUTPUT_LIMIT = 5000;
const ASSISTANT_EMPTY_FALLBACK_RESPONSE = 'I do not know yet. Please clarify what you want me to do next.';
const TERMINAL_OUTPUT_LIMIT = 18000;
const TERMINAL_COMMAND_TIMEOUT_MS = 45000;
const TERMINAL_SESSION_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 8192;
const AGENT_CONTRACT_DEFAULT_EXPIRY_SECONDS = 60 * 60;
const AGENT_CONTRACT_ENFORCE_INTERVAL_MS = 75;
const AGENT_CONTRACT_MAX_IDLE_AGENTS = 5;
const AGENT_RECONCILE_TERMINATION_BATCH = 12;
const AGENT_RECONCILE_TERMINATION_COOLDOWN_MS = 4000;
const AGENT_IDLE_TERMINATION_MS = 5 * 60 * 1000;
const AGENT_ROGUE_MESSAGE_RATE_MAX_PER_MIN = 20;
const AGENT_ROGUE_SPIKE_WINDOW_MS = 60 * 1000;
const COCKPIT_MAX_BLOCKS = 64;
const ATTENTION_PEEK_LIMIT = 12;
const ATTENTION_CRITICAL_LIMIT = 64;
const ATTENTION_MICRO_BATCH_WINDOW_MS = 50;
const ATTENTION_MICRO_BATCH_MAX_ITEMS = 10;
const ATTENTION_PREEMPT_QUEUE_DEPTH = 60;
const ATTENTION_BG_DOMINANCE_RATIO = 3;
const ATTENTION_DEFERRED_STASH_DEPTH = 80;
const ATTENTION_DEFERRED_HARD_SHED_DEPTH = 100;
const ATTENTION_DEFERRED_REHYDRATE_DEPTH = 40;
const ATTENTION_DEFERRED_REHYDRATE_BATCH = 10;
const ATTENTION_DEFERRED_MAX_ITEMS = 4000;
const ATTENTION_LANE_WEIGHTS = {
  critical: 6,
  standard: 3,
  background: 1,
};
const ATTENTION_LANE_CAPS = {
  critical: 20,
  standard: 30,
  background: 50,
};
const CONDUIT_DELTA_SYNC_DEPTH = 50;
const CONDUIT_DELTA_BATCH_WINDOW_MS = 10;
const CONDUIT_DELTA_BATCH_MAX_ITEMS = 8;
const MEMORY_ENTRY_BACKPRESSURE_THRESHOLD = 25;
const MEMORY_ENTRY_TARGET_WHEN_PAUSED = 20;
const ATTENTION_CONSUMER_ID = 'dashboard-cockpit';
const PRIMARY_MEMORY_DIR = 'local/workspace/memory';
const LEGACY_MEMORY_DIR = 'memory';
const COLLAB_SUPPORTED_ROLES = new Set(['coordinator', 'researcher', 'builder', 'reviewer', 'analyst']);
const COLLAB_ROLE_FALLBACKS = {
  orchestrator: 'coordinator',
  planner: 'coordinator',
  architect: 'coordinator',
  scientist: 'researcher',
  writer: 'researcher',
  engineer: 'builder',
  executor: 'builder',
  qa: 'reviewer',
  auditor: 'reviewer',
};
const CLI_MODE_SAFE = 'safe';
const CLI_MODE_FULL_INFRING = 'full_infring';
const DEFAULT_CLI_MODE = CLI_MODE_FULL_INFRING;
const APP_VERSION = (() => {
  try {
    const pkg = require(path.resolve(ROOT, 'package.json'));
    const v = pkg && typeof pkg.version === 'string' ? pkg.version.trim() : '';
    return v || '0.1.0';
  } catch {
    return '0.1.0';
  }
})();
const EFFECTIVE_LOC_EXTENSIONS = new Set([
  '.rs',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.m',
  '.mm',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.rb',
  '.php',
  '.cs',
  '.scala',
  '.sql',
  '.toml',
  '.yaml',
  '.yml',
  '.json',
]);
const CLI_ALLOWLIST = new Set([
  'protheus',
  'protheus-ops',
  'infringd',
  'git',
  'rg',
  'ls',
  'cat',
  'pwd',
  'wc',
  'head',
  'tail',
  'stat',
  'ps',
  'top',
  'free',
  'vm_stat',
  'vmstat',
]);
const GIT_READ_ONLY = new Set(['status', 'diff', 'show', 'log', 'branch', 'rev-parse', 'ls-files']);
const INFRINGD_READ_ONLY = new Set([
  'status',
  'diagnostics',
  'think',
  'research',
  'memory',
  'orchestration',
  'swarm-runtime',
  'capability-profile',
  'efficiency-status',
  'embedded-core-status',
]);
const OPS_READ_ONLY = new Set([
  'status',
  'health-status',
  'app-plane',
  'collab-plane',
  'skills-plane',
  'memory-plane',
  'security-plane',
  'attention-queue',
  'hermes-plane',
  'metrics-plane',
  'benchmark-matrix',
  'fixed-microbenchmark',
  'top1-assurance',
  'alpha-readiness',
  'foundation-contract-gate',
  'runtime-systems',
  'dashboard-ui',
]);
let ACTIVE_CLI_MODE = DEFAULT_CLI_MODE;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, maxLen = 120) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function parsePositiveInt(value, fallback, min = 1, max = 65535) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function parseNonNegativeInt(value, fallback = 0, max = 1000000000) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(num)));
}

function inferContextWindowFromModelName(modelName, fallback = DEFAULT_CONTEXT_WINDOW_TOKENS) {
  const normalized = cleanText(modelName || '', 160).toLowerCase();
  if (!normalized) return parsePositiveInt(fallback, DEFAULT_CONTEXT_WINDOW_TOKENS, 1024, 8000000);
  const matchK = normalized.match(/(?:^|[^0-9])([0-9]{2,4})k(?:[^a-z0-9]|$)/i);
  if (matchK && matchK[1]) {
    const parsedK = Number(matchK[1]);
    if (Number.isFinite(parsedK) && parsedK > 0) return parsePositiveInt(parsedK * 1000, fallback, 1024, 8000000);
  }
  const matchM = normalized.match(/(?:^|[^0-9])([0-9]{1,3})m(?:[^a-z0-9]|$)/i);
  if (matchM && matchM[1]) {
    const parsedM = Number(matchM[1]);
    if (Number.isFinite(parsedM) && parsedM > 0) return parsePositiveInt(parsedM * 1000000, fallback, 1024, 8000000);
  }
  if (/qwen2\.5|qwen3/i.test(normalized)) return 131072;
  if (/kimi|moonshot/i.test(normalized)) return 262144;
  if (/llama[-_. ]?3\.3/i.test(normalized)) return 131072;
  if (/llama[-_. ]?3\.2/i.test(normalized)) return 128000;
  if (/mistral[-_. ]?nemo|mixtral/i.test(normalized)) return 32000;
  if (/gemma[-_. ]?2/i.test(normalized)) return 8192;
  return parsePositiveInt(fallback, DEFAULT_CONTEXT_WINDOW_TOKENS, 1024, 8000000);
}

function contextPressureFromUsage(usedTokens, windowTokens) {
  const used = parseNonNegativeInt(usedTokens, 0, 1000000000);
  const windowSize = parsePositiveInt(windowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS, 1024, 8000000);
  const ratio = windowSize > 0 ? used / windowSize : 0;
  if (ratio >= 0.96) return 'critical';
  if (ratio >= 0.82) return 'high';
  if (ratio >= 0.55) return 'medium';
  return 'low';
}

function estimateConversationTokens(messages = []) {
  const rows = Array.isArray(messages) ? messages : [];
  return rows.reduce((sum, row) => {
    let text = '';
    if (row && typeof row.content === 'string') text = row.content;
    else if (row && typeof row.text === 'string') text = row.text;
    else if (row && typeof row.message === 'string') text = row.message;
    else if (row && typeof row.user === 'string') text = row.user;
    else if (row && typeof row.assistant === 'string') text = row.assistant;
    return sum + Math.max(0, Math.round(String(text || '').length / 4));
  }, 0);
}

function contextTelemetryForMessages(messages = [], contextWindow = DEFAULT_CONTEXT_WINDOW_TOKENS, extraTokens = 0) {
  const windowSize = parsePositiveInt(contextWindow, DEFAULT_CONTEXT_WINDOW_TOKENS, 1024, 8000000);
  const used =
    parseNonNegativeInt(estimateConversationTokens(messages), 0, 1000000000) +
    parseNonNegativeInt(extraTokens, 0, 1000000000);
  const ratio = windowSize > 0 ? used / windowSize : 0;
  return {
    context_tokens: used,
    context_window: windowSize,
    context_ratio: windowSize > 0 ? Number(ratio.toFixed(6)) : 0,
    context_pressure: contextPressureFromUsage(used, windowSize),
  };
}

function recommendedConduitSignals(queueDepth = 0, queueUtilization = 0, cockpitBlocks = 0) {
  const depth = parseNonNegativeInt(queueDepth, 0, 100000000);
  const util = Number.isFinite(Number(queueUtilization)) ? Number(queueUtilization) : 0;
  let baseline = 4;
  if (depth >= 95 || util >= 0.9) baseline = 16;
  else if (depth >= 85 || util >= 0.82) baseline = 14;
  else if (depth >= 65 || util >= 0.68) baseline = 12;
  else if (depth >= DASHBOARD_BACKPRESSURE_WARN_DEPTH || util >= 0.58) baseline = 8;
  else if (depth >= 25 || util >= 0.4) baseline = 6;
  const cockpit = parseNonNegativeInt(cockpitBlocks, 0, 100000000);
  const cockpitFloor = cockpit > 0 ? Math.min(16, Math.max(4, Math.ceil(cockpit * 0.5))) : 4;
  return Math.max(baseline, cockpitFloor);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function hasPrimaryDashboardUi() {
  return (
    fileExists(path.resolve(INFRING_PRIMARY_STATIC_DIR, 'index_head.html')) &&
    fileExists(path.resolve(INFRING_PRIMARY_STATIC_DIR, 'index_body.html'))
  );
}

function rebrandDashboardText(text) {
  return String(text || '')
    .replace(/\bOpenFang\b/g, 'Infring')
    .replace(/\bOPENFANG\b/g, 'INFRING')
    .replace(/\bopenfang\b/g, 'infring')
    .replace(/\bOpenClaw\b/g, 'Infring')
    .replace(/\bOPENCLAW\b/g, 'INFRING')
    .replace(/\bopenclaw\b/g, 'infring');
}

function transpileForkTypeScript(source, fileName) {
  const output = ts.transpileModule(String(source || ''), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      sourceMap: false,
      inlineSourceMap: false,
      removeComments: false,
    },
    fileName,
    reportDiagnostics: false,
  });
  return String(output && output.outputText ? output.outputText : '');
}

function readForkScript(basePathNoExt) {
  const tsPath = path.resolve(INFRING_PRIMARY_STATIC_DIR, `${basePathNoExt}.ts`);
  if (!fileExists(tsPath)) return '';
  const source = readText(tsPath, '');
  if (!source) return '';
  return transpileForkTypeScript(source, tsPath);
}

function buildPrimaryDashboardHtml() {
  const head = readText(path.resolve(INFRING_PRIMARY_STATIC_DIR, 'index_head.html'), '');
  const body = readText(path.resolve(INFRING_PRIMARY_STATIC_DIR, 'index_body.html'), '');
  if (!head || !body) return '';
  const cssTheme = readText(path.resolve(INFRING_PRIMARY_STATIC_DIR, 'css/theme.css'), '');
  const cssLayout = readText(path.resolve(INFRING_PRIMARY_STATIC_DIR, 'css/layout.css'), '');
  const cssComponents = readText(path.resolve(INFRING_PRIMARY_STATIC_DIR, 'css/components.css'), '');
  const cssGithubDark = readText(path.resolve(INFRING_PRIMARY_STATIC_DIR, 'vendor/github-dark.min.css'), '');
  const vendorMarked = readText(path.resolve(INFRING_PRIMARY_STATIC_DIR, 'vendor/marked.min.ts'), '');
  const vendorHighlight = readText(path.resolve(INFRING_PRIMARY_STATIC_DIR, 'vendor/highlight.min.ts'), '');
  const vendorChart = readText(path.resolve(INFRING_PRIMARY_STATIC_DIR, 'vendor/chart.umd.min.ts'), '');
  const vendorAlpine = readText(path.resolve(INFRING_PRIMARY_STATIC_DIR, 'vendor/alpine.min.ts'), '');
  const apiJs = readForkScript('js/api');
  const appJs = readForkScript('js/app');
  const pageScripts = [
    'overview',
    'chat',
    'agents',
    'workflows',
    'workflow-builder',
    'channels',
    'skills',
    'hands',
    'scheduler',
    'settings',
    'usage',
    'sessions',
    'logs',
    'wizard',
    'approvals',
    'comms',
    'runtime',
  ]
    .map((name) => readForkScript(`js/pages/${name}`))
    .filter(Boolean)
    .join('\n');

  const html = [
    head,
    '<style>',
    cssTheme,
    cssLayout,
    cssComponents,
    cssGithubDark,
    '</style>',
    body,
    '<script>',
    vendorMarked,
    '</script>',
    '<script>',
    vendorHighlight,
    '</script>',
    '<script>',
    vendorChart,
    '</script>',
    '<script>',
    apiJs,
    appJs,
    pageScripts,
    '</script>',
    '<script>',
    vendorAlpine,
    '</script>',
    '</body></html>',
  ].join('\n');
  return rebrandDashboardText(html);
}

function contentTypeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml; charset=utf-8';
  if (ext === '.woff') return 'font/woff';
  if (ext === '.woff2') return 'font/woff2';
  return 'application/octet-stream';
}

function readPrimaryDashboardAsset(pathname) {
  const requestPath = pathname === '/' || pathname === '/dashboard' ? '/index_body.html' : pathname;
  const relative = requestPath.replace(/^\/+/, '');
  const resolved = path.resolve(INFRING_PRIMARY_STATIC_DIR, relative);
  if (!resolved.startsWith(INFRING_PRIMARY_STATIC_DIR)) return null;
  const ext = path.extname(resolved).toLowerCase();

  // TS-first static assets: allow requests for *.js to be served from sibling *.ts sources.
  if (ext === '.js' && !fileExists(resolved)) {
    const tsPath = path.resolve(
      INFRING_PRIMARY_STATIC_DIR,
      relative.replace(/\.js$/i, '.ts')
    );
    if (tsPath.startsWith(INFRING_PRIMARY_STATIC_DIR) && fileExists(tsPath)) {
      return {
        body: transpileForkTypeScript(readText(tsPath, ''), tsPath),
        contentType: 'text/javascript; charset=utf-8',
      };
    }
    return null;
  }

  if (!fileExists(resolved)) return null;
  const contentType = contentTypeForFile(resolved);
  if (TEXT_EXTENSIONS.has(ext)) {
    return {
      body: rebrandDashboardText(readText(resolved, '')),
      contentType,
    };
  }
  return {
    body: fs.readFileSync(resolved),
    contentType,
  };
}

function parseJsonLoose(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const parseCandidate = (candidate) => {
    const source = String(candidate || '').trim();
    if (!source) return null;
    try {
      const parsed = JSON.parse(source);
      if (typeof parsed === 'string') {
        try {
          return JSON.parse(parsed);
        } catch {}
      }
      return parsed;
    } catch {}
    const repaired = repairDirectiveJsonCandidate(source);
    if (repaired && repaired !== source) {
      try {
        const parsed = JSON.parse(repaired);
        if (typeof parsed === 'string') {
          try {
            return JSON.parse(parsed);
          } catch {}
        }
        return parsed;
      } catch {}
    }
    return null;
  };
  const direct = parseCandidate(text);
  if (direct && typeof direct === 'object') return direct;
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = parseCandidate(text.slice(firstBrace, lastBrace + 1));
    if (sliced && typeof sliced === 'object') return sliced;
  }
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = parseCandidate(lines[i]);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

function repairDirectiveJsonCandidate(raw) {
  let text = String(raw || '').trim();
  if (!text) return text;
  text = text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  if (
    (text.startsWith('```') && text.endsWith('```')) ||
    (text.startsWith('`') && text.endsWith('`'))
  ) {
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').replace(/^`|`$/g, '').trim();
  }
  // Common malformed key pattern seen in model output: "reason:" -> "reason":
  text = text.replace(/"([a-zA-Z0-9_-]+):"\s*/g, '"$1": ');
  // Remove trailing commas in arrays/objects.
  text = text.replace(/,\s*([}\]])/g, '$1');
  return text;
}

function normalizeCliMode(value) {
  const raw = cleanText(value || '', 80).toLowerCase();
  if (!raw) return DEFAULT_CLI_MODE;
  if (raw === 'full' || raw === 'full_infring' || raw === 'full-infring') {
    return CLI_MODE_FULL_INFRING;
  }
  return CLI_MODE_SAFE;
}

function parseFlags(argv = []) {
  const out = {
    mode: 'serve',
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    team: DEFAULT_TEAM,
    refreshMs: DEFAULT_REFRESH_MS,
    pretty: true,
    cliMode: normalizeCliMode(process.env.INFRING_DASHBOARD_CLI_MODE || DEFAULT_CLI_MODE),
  };

  let modeSet = false;
  for (const token of argv) {
    const value = String(token || '').trim();
    if (!value) continue;

    if (!modeSet && !value.startsWith('--')) {
      out.mode = value;
      modeSet = true;
      continue;
    }
    if (value.startsWith('--host=')) {
      out.host = cleanText(value.split('=').slice(1).join('='), 100) || DEFAULT_HOST;
      continue;
    }
    if (value.startsWith('--port=')) {
      out.port = parsePositiveInt(value.split('=').slice(1).join('='), DEFAULT_PORT, 1, 65535);
      continue;
    }
    if (value.startsWith('--team=')) {
      out.team = cleanText(value.split('=').slice(1).join('='), 80) || DEFAULT_TEAM;
      continue;
    }
    if (value.startsWith('--refresh-ms=')) {
      out.refreshMs = parsePositiveInt(value.split('=').slice(1).join('='), DEFAULT_REFRESH_MS, 800, 60000);
      continue;
    }
    if (value === '--pretty=0' || value === '--pretty=false') {
      out.pretty = false;
      continue;
    }
    if (value.startsWith('--cli-mode=')) {
      out.cliMode = normalizeCliMode(value.split('=').slice(1).join('='));
      continue;
    }
  }
  return out;
}

function runLane(argv) {
  const env = { ...process.env, PROTHEUS_ROOT: ROOT };
  const opts = {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    env,
    maxBuffer: 12 * 1024 * 1024,
  };
  const proc = spawnSync(process.execPath, [OPS_BRIDGE_PATH, ...argv], opts);

  const status = typeof proc.status === 'number' ? proc.status : 1;
  const stdout = typeof proc.stdout === 'string' ? proc.stdout : '';
  const stderr = typeof proc.stderr === 'string' ? proc.stderr : '';
  const payload = parseJsonLoose(stdout);
  return {
    ok: status === 0 && !!payload,
    status,
    stdout,
    stderr,
    payload,
    argv,
  };
}

function resolveProtheusdBin() {
  if (fileExists(PROTHEUSD_DEBUG_BIN)) return PROTHEUSD_DEBUG_BIN;
  if (fileExists(PROTHEUSD_RELEASE_BIN)) return PROTHEUSD_RELEASE_BIN;
  return '';
}

function runProtheusdThink(prompt, sessionId) {
  const bin = resolveProtheusdBin();
  if (!bin) {
    return {
      ok: false,
      status: 1,
      stdout: '',
      stderr: 'protheusd_binary_missing',
      payload: null,
      argv: ['think'],
    };
  }
  const args = [
    'think',
    `--prompt=${cleanText(prompt || '', 4000)}`,
    `--session-id=${cleanText(sessionId || 'dashboard-chat', 120)}`,
  ];
  const proc = spawnSync(bin, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, PROTHEUS_ROOT: ROOT },
    maxBuffer: 12 * 1024 * 1024,
  });
  const status = typeof proc.status === 'number' ? proc.status : 1;
  const stdout = typeof proc.stdout === 'string' ? proc.stdout : '';
  const stderr = typeof proc.stderr === 'string' ? proc.stderr : '';
  const payload = parseJsonLoose(stdout);
  return {
    ok: status === 0 && !!payload,
    status,
    stdout,
    stderr,
    payload,
    argv: [bin, ...args],
  };
}

function commandExists(command) {
  try {
    const proc = spawnSync('which', [String(command || '')], {
      cwd: ROOT,
      stdio: 'ignore',
      timeout: 1500,
    });
    return proc && proc.status === 0;
  } catch {
    return false;
  }
}

function sanitizeArg(value, maxLen = 180) {
  return String(value == null ? '' : value).replace(/[\u0000\r\n]/g, ' ').trim().slice(0, maxLen);
}

function parseToolArgs(raw) {
  if (Array.isArray(raw)) {
    return raw.map((value) => sanitizeArg(value)).filter(Boolean).slice(0, 24);
  }
  if (typeof raw === 'string') {
    return raw
      .trim()
      .split(/\s+/)
      .map((value) => sanitizeArg(value))
      .filter(Boolean)
      .slice(0, 24);
  }
  return [];
}

function stripAnsi(value) {
  return String(value == null ? '' : value)
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[PX^_].*?\u001B\\/g, '')
    .replace(/\u001B[@-_]/g, '');
}

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, `'\"'\"'`)}'`;
}

function resolveTerminalCwd(requestedCwd) {
  const raw = String(requestedCwd == null ? '' : requestedCwd).replace(/\u0000/g, '').trim();
  if (!raw) return ROOT;
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ROOT, raw);
  if (!candidate.startsWith(ROOT)) return ROOT;
  try {
    const stat = fs.statSync(candidate);
    if (stat && stat.isDirectory()) return candidate;
  } catch {}
  return ROOT;
}

const terminalSessions = new Map();

function terminalSessionId(agentId = '') {
  return cleanText(agentId || 'dashboard-terminal', 140) || 'dashboard-terminal';
}

function terminalFailureResult(session, pending, message, status = 1) {
  return {
    ok: false,
    blocked: false,
    status,
    exit_code: status,
    stdout: stripAnsi(String(pending && pending.stdout ? pending.stdout : '')).slice(0, TERMINAL_OUTPUT_LIMIT),
    stderr: stripAnsi(String(pending && pending.stderr ? pending.stderr : '')).slice(0, TERMINAL_OUTPUT_LIMIT),
    message: cleanText(message || 'terminal_session_error', 260),
    duration_ms: Math.max(0, Date.now() - Number(pending && pending.started_ms ? pending.started_ms : Date.now())),
    cwd: resolveTerminalCwd(pending && pending.cwd ? pending.cwd : session && session.cwd ? session.cwd : ROOT),
    command: cleanText(pending && pending.command ? pending.command : '', 4000),
  };
}

function finalizeTerminalPending(session, result) {
  const pending = session && session.pending ? session.pending : null;
  if (!pending) return;
  clearTimeout(pending.timeout);
  session.pending = null;
  session.last_used_ms = Date.now();
  pending.resolve(result);
  setImmediate(() => {
    processTerminalSessionQueue(session);
  });
}

function settleTerminalSessionError(session, message, status = 1) {
  if (!session) return;
  if (session.pending) {
    const pending = session.pending;
    finalizeTerminalPending(session, terminalFailureResult(session, pending, message, status));
  }
  const queued = Array.isArray(session.queue) ? session.queue.splice(0, session.queue.length) : [];
  for (const job of queued) {
    const pending = {
      command: cleanText(job && job.command ? job.command : '', 4000),
      cwd: resolveTerminalCwd(job && job.cwd ? job.cwd : session.cwd),
      started_ms: Date.now(),
      stdout: '',
      stderr: '',
    };
    job.resolve(terminalFailureResult(session, pending, message, status));
  }
}

function tryResolveTerminalMarker(session) {
  const pending = session && session.pending ? session.pending : null;
  if (!pending) return false;
  const markerIndex = pending.stdout.indexOf(pending.marker);
  if (markerIndex < 0) return false;
  const afterMarker = pending.stdout.slice(markerIndex + pending.marker.length);
  const markerPayload = afterMarker.match(/^(-?\d+)__([^\r\n]*)[\r\n]/);
  if (!markerPayload) return false;
  const exitCode = Number(markerPayload[1]);
  const markerCwd = resolveTerminalCwd(markerPayload[2] || pending.cwd);
  const consumedLength = pending.marker.length + markerPayload[0].length;
  const stdoutRaw = pending.stdout.slice(0, markerIndex) + pending.stdout.slice(markerIndex + consumedLength);
  const stderrRaw = pending.stderr;
  session.cwd = markerCwd;
  finalizeTerminalPending(session, {
    ok: Number.isFinite(exitCode) && exitCode === 0,
    blocked: false,
    status: Number.isFinite(exitCode) ? exitCode : 1,
    exit_code: Number.isFinite(exitCode) ? exitCode : 1,
    stdout: stripAnsi(stdoutRaw).slice(0, TERMINAL_OUTPUT_LIMIT),
    stderr: stripAnsi(stderrRaw).slice(0, TERMINAL_OUTPUT_LIMIT),
    message: '',
    duration_ms: Math.max(0, Date.now() - pending.started_ms),
    cwd: markerCwd,
    command: pending.command,
  });
  return true;
}

function processTerminalSessionQueue(session) {
  if (!session || session.closed || session.pending || !Array.isArray(session.queue) || session.queue.length === 0) {
    return;
  }
  const job = session.queue.shift();
  if (!job || typeof job.resolve !== 'function') return;
  const cwd = resolveTerminalCwd(job.cwd || session.cwd || ROOT);
  const marker = `__INFRING_TERM_DONE_${sha256(`${session.id}:${Date.now()}:${Math.random()}`).slice(0, 24)}__`;
  session.pending = {
    marker,
    command: cleanText(job.command || '', 4000),
    cwd,
    started_ms: Date.now(),
    stdout: '',
    stderr: '',
    timeout: null,
    resolve: job.resolve,
  };
  const script = [
    `cd ${shellQuote(cwd)}`,
    String(job.command || ''),
    '__infring_exit_code=$?',
    `printf '\\n${marker}%s__%s\\n' \"$__infring_exit_code\" \"$PWD\"`,
    '',
  ].join('\n');
  try {
    session.proc.stdin.write(script, 'utf8');
  } catch (error) {
    settleTerminalSessionError(
      session,
      cleanText(error && error.message ? error.message : 'terminal_stdin_write_failed', 220),
      1
    );
    return;
  }
  session.pending.timeout = setTimeout(() => {
    settleTerminalSessionError(session, 'terminal_command_timeout', 124);
  }, TERMINAL_COMMAND_TIMEOUT_MS);
}

function ensureTerminalSession(agentId, requestedCwd) {
  const id = terminalSessionId(agentId);
  const existing = terminalSessions.get(id);
  if (existing && !existing.closed && existing.proc && !existing.proc.killed) {
    return existing;
  }
  const cwd = resolveTerminalCwd(requestedCwd);
  const shell = cleanText(process.env.SHELL || '/bin/zsh', 160) || '/bin/zsh';
  const proc = spawn(shell, ['-s'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PROTHEUS_ROOT: ROOT,
      TERM: process.env.TERM || 'xterm-256color',
      PS1: '',
      PROMPT: '',
      PROMPT_COMMAND: '',
    },
  });
  const session = {
    id,
    agent_id: id,
    proc,
    shell,
    cwd,
    queue: [],
    pending: null,
    closed: false,
    last_used_ms: Date.now(),
  };
  proc.stdout.on('data', (chunk) => {
    if (!session.pending) return;
    session.pending.stdout += String(chunk || '');
    tryResolveTerminalMarker(session);
  });
  proc.stderr.on('data', (chunk) => {
    if (!session.pending) return;
    session.pending.stderr += String(chunk || '');
  });
  proc.on('exit', (code, signal) => {
    session.closed = true;
    settleTerminalSessionError(
      session,
      `terminal_session_exited:${Number.isFinite(Number(code)) ? Number(code) : 'signal'}${signal ? `:${signal}` : ''}`,
      Number.isFinite(Number(code)) ? Number(code) : 1
    );
    terminalSessions.delete(id);
  });
  terminalSessions.set(id, session);
  return session;
}

function queueTerminalCommand(session, command, cwd) {
  return new Promise((resolve) => {
    session.queue.push({ command, cwd, resolve });
    processTerminalSessionQueue(session);
  });
}

function closeTerminalSession(agentId, reason = 'session_closed') {
  const id = terminalSessionId(agentId);
  const session = terminalSessions.get(id);
  if (!session) return false;
  session.closed = true;
  settleTerminalSessionError(session, reason, 1);
  try {
    session.proc.kill('SIGTERM');
  } catch {}
  terminalSessions.delete(id);
  return true;
}

function closeAllTerminalSessions(reason = 'shutdown') {
  for (const id of Array.from(terminalSessions.keys())) {
    closeTerminalSession(id, reason);
  }
}

function pruneTerminalSessions() {
  const now = Date.now();
  for (const [id, session] of terminalSessions.entries()) {
    if (!session || session.closed) {
      terminalSessions.delete(id);
      continue;
    }
    if (session.pending || (Array.isArray(session.queue) && session.queue.length > 0)) continue;
    const idleMs = now - Number(session.last_used_ms || now);
    if (idleMs >= TERMINAL_SESSION_IDLE_TTL_MS) {
      closeTerminalSession(id, 'idle_timeout');
    }
  }
}

async function runTerminalCommand(rawCommand, requestedCwd, agentId = 'dashboard-terminal') {
  const command = String(rawCommand == null ? '' : rawCommand).replace(/\u0000/g, '').trim();
  if (!command) {
    return {
      ok: false,
      blocked: true,
      status: 2,
      exit_code: 2,
      stdout: '',
      stderr: '',
      message: 'Terminal command required.',
      duration_ms: 0,
      cwd: resolveTerminalCwd(requestedCwd),
      command: '',
    };
  }
  if (ACTIVE_CLI_MODE !== CLI_MODE_FULL_INFRING) {
    return {
      ok: false,
      blocked: true,
      status: 2,
      exit_code: 2,
      stdout: '',
      stderr: '',
      message: 'Terminal mode disabled while CLI mode is safe.',
      duration_ms: 0,
      cwd: resolveTerminalCwd(requestedCwd),
      command,
    };
  }
  const cwd = resolveTerminalCwd(requestedCwd);
  pruneTerminalSessions();
  try {
    const session = ensureTerminalSession(agentId, cwd);
    return await queueTerminalCommand(session, command, cwd);
  } catch (error) {
    return {
      ok: false,
      blocked: false,
      status: 1,
      exit_code: 1,
      stdout: '',
      stderr: '',
      message: cleanText(error && error.message ? error.message : String(error), 260),
      duration_ms: 0,
      cwd,
      command,
    };
  }
}

function collectTrackedFiles() {
  try {
    const proc = spawnSync('git', ['ls-files'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!proc || proc.status !== 0) return [];
    return String(proc.stdout || '')
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isEffectiveLocPath(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (!lower) return false;
  if (lower.includes('/node_modules/')) return false;
  if (lower.includes('/target/')) return false;
  if (lower.includes('/dist/')) return false;
  if (lower.includes('/coverage/')) return false;
  if (lower.includes('/.next/')) return false;
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css')) return false;
  return EFFECTIVE_LOC_EXTENSIONS.has(path.extname(lower));
}

function effectiveLinesForContent(content) {
  let count = 0;
  const lines = String(content || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed === '/*' || trimmed === '*/') continue;
    if (trimmed.startsWith('*')) continue;
    if (trimmed.startsWith('<!--') || trimmed.endsWith('-->')) continue;
    count += 1;
  }
  return count;
}

function recentDateIso(offsetDays) {
  const days = parseNonNegativeInt(offsetDays, 0, 3650);
  const ms = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function memoryFileCandidates(dateIso) {
  const safeDate = cleanText(dateIso || '', 20);
  if (!safeDate) return [];
  return [
    path.resolve(ROOT, PRIMARY_MEMORY_DIR, `${safeDate}.md`),
    path.resolve(ROOT, LEGACY_MEMORY_DIR, `${safeDate}.md`),
  ];
}

function readMemoryFileForDate(dateIso) {
  const candidates = memoryFileCandidates(dateIso);
  for (const fullPath of candidates) {
    if (!fileExists(fullPath)) continue;
    const content = readText(fullPath, '');
    if (content || content === '') {
      return {
        date_iso: dateIso,
        full_path: fullPath,
        rel_path: path.relative(ROOT, fullPath),
        content,
      };
    }
  }
  return null;
}

function memoryBullets(content) {
  return String(content || '')
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row.startsWith('- '))
    .map((row) => row.slice(2).trim())
    .filter(Boolean);
}

function normalizeCollabRole(roleRaw) {
  const role = cleanText(roleRaw || '', 40).toLowerCase();
  if (!role) return 'analyst';
  if (COLLAB_SUPPORTED_ROLES.has(role)) return role;
  const mapped = COLLAB_ROLE_FALLBACKS[role];
  if (mapped && COLLAB_SUPPORTED_ROLES.has(mapped)) return mapped;
  return 'analyst';
}

function parseCollabLaunchCommands(input) {
  const raw = String(input || '');
  const commands = [];
  const regex = /protheus-ops\s+collab-plane\s+launch-role\b([\s\S]*?)(?=protheus-ops\s+collab-plane\s+launch-role\b|$)/gi;
  let match = regex.exec(raw);
  while (match) {
    const trailer = String(match[1] || '').replace(/\s+/g, ' ').trim();
    if (trailer) {
      const rawTokens = trailer
        .split(' ')
        .map((row) => sanitizeArg(row, 180))
        .filter(Boolean)
        .filter((row) => row !== 'Run' && row !== 'run' && row !== 'exactly:' && row !== 'exactly');
      const firstFlag = rawTokens.findIndex((row) => row.startsWith('--'));
      const tokens = [];
      if (firstFlag >= 0) {
        for (let i = firstFlag; i < rawTokens.length; i += 1) {
          const token = rawTokens[i];
          if (!token.startsWith('--')) break;
          tokens.push(token);
        }
      }
      const args = ['collab-plane', 'launch-role', ...tokens];
      commands.push(args);
    }
    match = regex.exec(raw);
  }
  return commands.slice(0, 4);
}

function tryDeterministicRepoAnswer(input, snapshot = null) {
  const rawInput = String(input || '');
  const text = rawInput.toLowerCase();
  const asksWeekAgo =
    /(one week ago|7 days ago|last week)/.test(text) &&
    /(what were we doing|what did we do|what was happening|what happened)/.test(text);
  if (asksWeekAgo) {
    const offsets = [7, 8, 6, 9];
    const seen = new Set();
    const candidates = [];
    for (const offset of offsets) {
      const dateIso = recentDateIso(offset);
      if (seen.has(dateIso)) continue;
      seen.add(dateIso);
      const entry = readMemoryFileForDate(dateIso);
      if (entry) candidates.push(entry);
    }
    if (!candidates.length) {
      return {
        response: `I checked ${PRIMARY_MEMORY_DIR} and ${LEGACY_MEMORY_DIR}, but I could not find a memory file for around one week ago.`,
        tools: [
          {
            id: `tool-${Date.now()}-det-memory-miss`,
            name: 'ls',
            input: `ls ${PRIMARY_MEMORY_DIR}/`,
            result: 'no_candidate_memory_file_found',
            is_error: false,
            running: false,
            expanded: false,
          },
        ],
      };
    }
    const best = candidates.find((row) => memoryBullets(row.content).length > 0) || candidates[0];
    const bullets = memoryBullets(best.content).slice(0, 2);
    const bulletText = bullets.length ? bullets.map((row) => `- ${row}`).join(' ') : '- No concrete bullet entries were recorded in that file.';
    const response = `Exact date: ${best.date_iso}. Memory file path: ${best.rel_path}. ${bulletText}`;
    return {
      response,
      tools: [
        {
          id: `tool-${Date.now()}-det-memory`,
          name: 'cat',
          input: `cat ${best.rel_path}`,
          result: cleanText(best.content || '(empty file)', TOOL_OUTPUT_LIMIT),
          is_error: false,
          running: false,
          expanded: false,
        },
      ],
    };
  }

  const collabLaunchCommands = parseCollabLaunchCommands(rawInput);
  if (collabLaunchCommands.length > 0) {
    const tools = [];
    const launched = [];
    for (const originalArgs of collabLaunchCommands) {
      const args = Array.isArray(originalArgs) ? [...originalArgs] : ['collab-plane', 'launch-role'];
      const roleIndex = args.findIndex((row) => String(row).startsWith('--role='));
      const requestedRole = roleIndex >= 0 ? String(args[roleIndex]).slice('--role='.length) : '';
      const normalizedRole = normalizeCollabRole(requestedRole);
      if (roleIndex >= 0 && normalizedRole) {
        args[roleIndex] = `--role=${normalizedRole}`;
      } else if (roleIndex < 0) {
        args.push(`--role=${normalizedRole}`);
      }
      const result = runCliTool('protheus-ops', args);
      tools.push({
        id: `tool-${Date.now()}-det-collab-${tools.length + 1}`,
        name: 'protheus-ops',
        input: ['protheus-ops', ...args].join(' '),
        result: cleanText(result.result, TOOL_OUTPUT_LIMIT),
        is_error: !!result.is_error,
        running: false,
        expanded: false,
      });
      if (!result.is_error) {
        const shadowArg = args.find((row) => String(row).startsWith('--shadow='));
        const shadow = shadowArg ? cleanText(String(shadowArg).slice('--shadow='.length), 120) : '';
        if (shadow) launched.push(shadow);
      }
    }
    const successes = tools.filter((row) => !row.is_error).length;
    const response =
      successes > 0
        ? `${launched.join(' ') || `launched ${successes} subagent(s)`}`
        : 'Subagent launch commands failed.';
    return { response, tools };
  }

  const asksRuntimeSync =
    /(runtime sync|queue depth|cockpit blocks|conduit signals|attention queue)/.test(text) &&
    /(report|summarize|status|readable|now)/.test(text);
  const asksClientLayerSummary =
    /(summarize|summary|report).*(client layer)/.test(text) ||
    /client layer now/.test(text);
  if (asksRuntimeSync || asksClientLayerSummary) {
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : null;
    if (snap) {
      const queueDepth = parseNonNegativeInt(
        snap && snap.attention_queue && snap.attention_queue.queue_depth != null
          ? snap.attention_queue.queue_depth
          : 0,
        0,
        100000000
      );
      const cockpitBlocks = parseNonNegativeInt(
        snap && snap.cockpit && snap.cockpit.block_count != null
          ? snap.cockpit.block_count
          : 0,
        0,
        100000000
      );
      const cockpitTotalBlocks = parseNonNegativeInt(
        snap && snap.cockpit && snap.cockpit.total_block_count != null
          ? snap.cockpit.total_block_count
          : cockpitBlocks,
        cockpitBlocks,
        100000000
      );
      const conduitSignals = parseNonNegativeInt(
        snap &&
        snap.attention_queue &&
        snap.attention_queue.backpressure &&
        snap.attention_queue.backpressure.conduit_signals != null
          ? snap.attention_queue.backpressure.conduit_signals
          : 0,
        0,
        100000000
      );
      const attentionReadable =
        cleanText(
          snap &&
          snap.attention_queue &&
          snap.attention_queue.status &&
          snap.attention_queue.status.source
            ? snap.attention_queue.status.source
            : '',
          80
        ) || 'readable';
      const memoryEntries = Array.isArray(snap && snap.memory && snap.memory.entries)
        ? snap.memory.entries.length
        : 0;
      const receiptCount = Array.isArray(snap && snap.receipts && snap.receipts.recent)
        ? snap.receipts.recent.length
        : 0;
      const logCount = Array.isArray(snap && snap.logs && snap.logs.recent)
        ? snap.logs.recent.length
        : 0;
      const healthChecks = parseNonNegativeInt(
        snap && snap.health && snap.health.coverage && snap.health.coverage.total != null
          ? snap.health.coverage.total
          : Array.isArray(snap && snap.health && snap.health.checks)
            ? snap.health.checks.length
            : 0,
        0,
        100000000
      );
      const response = asksClientLayerSummary
        ? `Client layer now: memory entries ${memoryEntries}, receipts ${receiptCount}, logs ${logCount}, health checks ${healthChecks}, attention queue depth ${queueDepth}, cockpit blocks ${cockpitBlocks} active (${cockpitTotalBlocks} total), conduit signals ${conduitSignals}.`
        : `Current queue depth: ${queueDepth}, cockpit blocks: ${cockpitBlocks} active (${cockpitTotalBlocks} total), conduit signals: ${conduitSignals}. Attention queue is ${attentionReadable}.`;
      return {
        response,
        tools: [
          {
            id: `tool-${Date.now()}-det-runtime-sync`,
            name: 'api.dashboard.snapshot',
            input: '/api/dashboard/snapshot',
            result: `queue_depth=${queueDepth};cockpit_blocks_active=${cockpitBlocks};cockpit_blocks_total=${cockpitTotalBlocks};conduit_signals=${conduitSignals};memory_entries=${memoryEntries};receipts=${receiptCount};logs=${logCount};health_checks=${healthChecks}`,
            is_error: false,
            running: false,
            expanded: false,
          },
        ],
      };
    }
  }

  const asksFiles = /how many files|file count|number of files/.test(text);
  const asksLoc = /effective loc|affective loc|lines of code|\bloc\b/.test(text);
  if (!asksFiles && !asksLoc) return null;

  const tracked = collectTrackedFiles();
  if (!tracked.length) return null;

  if (asksLoc) {
    const sourceFiles = tracked.filter((row) => isEffectiveLocPath(row));
    let effectiveLoc = 0;
    let scannedFiles = 0;
    for (const rel of sourceFiles) {
      const abs = path.resolve(ROOT, rel);
      try {
        const raw = fs.readFileSync(abs, 'utf8');
        effectiveLoc += effectiveLinesForContent(raw);
        scannedFiles += 1;
      } catch {}
    }
    const response = `Effective LoC is ${effectiveLoc.toLocaleString()} across ${scannedFiles.toLocaleString()} source-like tracked files (comments/blank lines excluded by heuristic).`;
    return {
      response,
      tools: [
        {
          id: `tool-${Date.now()}-det-loc`,
          name: 'git',
          input: 'git ls-files',
          result: `tracked_files=${tracked.length}; scanned_source_files=${scannedFiles}; effective_loc=${effectiveLoc}`,
          is_error: false,
          running: false,
          expanded: false,
        },
      ],
    };
  }

  const response = `This repo currently has ${tracked.length.toLocaleString()} tracked files.`;
  return {
    response,
    tools: [
      {
        id: `tool-${Date.now()}-det-files`,
        name: 'git',
        input: 'git ls-files',
        result: `tracked_files=${tracked.length}`,
        is_error: false,
        running: false,
        expanded: false,
      },
    ],
  };
}

function cliInvocationAllowed(command, args) {
  const cmd = sanitizeArg(command, 80);
  if (!CLI_ALLOWLIST.has(cmd)) {
    return { ok: false, error: `command_not_allowed:${cmd}` };
  }
  const fullInfring = ACTIVE_CLI_MODE === CLI_MODE_FULL_INFRING;
  const first = sanitizeArg(args && args[0] ? args[0] : '', 80);
  if (cmd === 'git' && first && !GIT_READ_ONLY.has(first)) {
    return { ok: false, error: `git_subcommand_blocked:${first}` };
  }
  if (!fullInfring && (cmd === 'infringd' || cmd === 'protheus') && first && !INFRINGD_READ_ONLY.has(first)) {
    return { ok: false, error: `runtime_subcommand_blocked:${first}` };
  }
  if (!fullInfring && cmd === 'protheus-ops' && first && !OPS_READ_ONLY.has(first)) {
    return { ok: false, error: `ops_subcommand_blocked:${first}` };
  }
  return { ok: true, command: cmd, mode: ACTIVE_CLI_MODE };
}

function runCliTool(command, args = []) {
  const normalizedArgs = parseToolArgs(args);
  const gate = cliInvocationAllowed(command, normalizedArgs);
  const input = [sanitizeArg(command, 80), ...normalizedArgs].filter(Boolean).join(' ');
  if (!gate.ok) {
    return {
      ok: false,
      name: sanitizeArg(command, 80) || 'cli',
      input,
      result: `blocked: ${gate.error}`,
      is_error: true,
      exit_code: 126,
    };
  }
  try {
    const proc = spawnSync(gate.command, normalizedArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, PROTHEUS_ROOT: ROOT },
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const status = typeof proc.status === 'number' ? proc.status : 1;
    const stdout = typeof proc.stdout === 'string' ? proc.stdout : '';
    const stderr = typeof proc.stderr === 'string' ? proc.stderr : '';
    const output = cleanText([stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n') || '(no output)', TOOL_OUTPUT_LIMIT);
    return {
      ok: status === 0,
      name: gate.command,
      input,
      result: output,
      is_error: status !== 0,
      exit_code: status,
    };
  } catch (error) {
    return {
      ok: false,
      name: gate.command,
      input,
      result: `failed: ${cleanText(error && error.message ? error.message : String(error), 260)}`,
      is_error: true,
      exit_code: 1,
    };
  }
}

function enqueueAttentionEvent(eventPayload, runContext = 'dashboard_chat') {
  try {
    const raw = JSON.stringify(eventPayload && typeof eventPayload === 'object' ? eventPayload : {});
    const encoded = Buffer.from(raw, 'utf8').toString('base64');
    return runLane([
      'attention-queue',
      'enqueue',
      `--event-json-base64=${encoded}`,
      `--run-context=${cleanText(runContext || 'dashboard_chat', 60) || 'dashboard_chat'}`,
    ]);
  } catch (error) {
    return {
      ok: false,
      status: 1,
      stdout: '',
      stderr: cleanText(error && error.message ? error.message : String(error), 220),
      payload: null,
      argv: ['attention-queue', 'enqueue'],
    };
  }
}

function extractJsonDirective(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let payload = parseJsonLoose(text);
  if (!payload) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced && fenced[1]) {
      payload = parseJsonLoose(fenced[1]);
    }
  }
  if (!payload || typeof payload !== 'object') {
    const heuristic = extractDirectiveHeuristic(text);
    if (heuristic) return heuristic;
    return null;
  }
  const type = cleanText(payload.type || payload.tool || '', 40).toLowerCase();
  if (type === 'final' || type === 'answer') {
    return {
      type: 'final',
      response: cleanText(payload.response || payload.answer || payload.text || '', 6000),
    };
  }
  if (type === 'tool_call' || type === 'run_cli' || payload.command) {
    return {
      type: 'tool_call',
      command: sanitizeArg(payload.command || 'protheus-ops', 80),
      args: parseToolArgs(payload.args || payload.argv || payload.input || ''),
      reason: cleanText(payload.reason || payload.why || '', 220),
    };
  }
  return null;
}

function extractDirectiveHeuristic(text) {
  const raw = String(text || '');
  const lowered = raw.toLowerCase();
  if (lowered.includes('"type"') && lowered.includes('"tool_call"')) {
    const commandMatch = raw.match(/"command"\s*:\s*"([^"\n]+)"/i);
    if (commandMatch && commandMatch[1]) {
      const argsMatch = raw.match(/"args"\s*:\s*(\[[\s\S]*?\])/i);
      let args = [];
      if (argsMatch && argsMatch[1]) {
        const parsedArgs = parseJsonLoose(argsMatch[1]);
        args = parseToolArgs(Array.isArray(parsedArgs) ? parsedArgs : []);
      }
      if (!args.length) {
        const argvMatch = raw.match(/"argv"\s*:\s*(\[[\s\S]*?\])/i);
        if (argvMatch && argvMatch[1]) {
          const parsedArgv = parseJsonLoose(argvMatch[1]);
          args = parseToolArgs(Array.isArray(parsedArgv) ? parsedArgv : []);
        }
      }
      const reasonMatch =
        raw.match(/"reason"\s*:\s*"([^"]*)"/i) ||
        raw.match(/"reason:"\s*"([^"]*)"/i);
      return {
        type: 'tool_call',
        command: sanitizeArg(commandMatch[1], 80),
        args,
        reason: cleanText(reasonMatch && reasonMatch[1] ? reasonMatch[1] : '', 220),
      };
    }
  }
  if (lowered.includes('"type"') && (lowered.includes('"final"') || lowered.includes('"answer"'))) {
    const responseMatch =
      raw.match(/"response"\s*:\s*"([\s\S]*?)"\s*}/i) ||
      raw.match(/"answer"\s*:\s*"([\s\S]*?)"\s*}/i);
    if (responseMatch && responseMatch[1]) {
      return {
        type: 'final',
        response: cleanText(responseMatch[1].replace(/\\"/g, '"'), 6000),
      };
    }
  }
  return null;
}

function configuredOllamaModel(snapshot) {
  const raw =
    snapshot &&
    snapshot.app &&
    snapshot.app.settings &&
    snapshot.app.settings.model
      ? String(snapshot.app.settings.model)
      : '';
  if (!raw) return OLLAMA_MODEL_FALLBACK;
  if (raw.startsWith('ollama/')) return cleanText(raw.replace(/^ollama\//, ''), 120) || OLLAMA_MODEL_FALLBACK;
  if (raw.includes('/')) return OLLAMA_MODEL_FALLBACK;
  return cleanText(raw, 120) || OLLAMA_MODEL_FALLBACK;
}

function configuredProvider(snapshot) {
  const raw =
    snapshot &&
    snapshot.app &&
    snapshot.app.settings &&
    snapshot.app.settings.provider
      ? String(snapshot.app.settings.provider)
      : '';
  return cleanText(raw, 80) || 'openai';
}

function parseOllamaModelList() {
  if (!commandExists(OLLAMA_BIN)) return [];
  try {
    const proc = spawnSync(OLLAMA_BIN, ['list'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 6000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (!proc || proc.status !== 0) return [];
    const out = String(proc.stdout || '');
    const lines = out.split('\n').map((row) => row.trim()).filter(Boolean);
    const models = [];
    for (const line of lines) {
      if (/^name\s+/i.test(line)) continue;
      const parts = line.split(/\s+/);
      const id = cleanText(parts[0] || '', 120);
      if (!id || id.toLowerCase() === 'name') continue;
      models.push(id);
    }
    return Array.from(new Set(models));
  } catch {
    return [];
  }
}

function buildDashboardModels(snapshot) {
  const rows = [];
  const configuredWindow = inferContextWindowFromModelName(configuredOllamaModel(snapshot), DEFAULT_CONTEXT_WINDOW_TOKENS);
  rows.push({
    id: 'auto',
    provider: 'auto',
    display_name: 'Auto',
    tier: 'Balanced',
    available: true,
    supports_tools: true,
    supports_vision: false,
    context_window: configuredWindow,
  });
  const configured = configuredOllamaModel(snapshot);
  const fromOllama = parseOllamaModelList();
  const merged = Array.from(new Set([configured, OLLAMA_MODEL_FALLBACK, ...fromOllama].filter(Boolean)));
  for (const id of merged) {
    rows.push({
      id,
      provider: 'ollama',
      display_name: id,
      tier: 'Balanced',
      available: true,
      supports_tools: true,
      supports_vision: false,
      context_window: inferContextWindowFromModelName(id, configuredWindow),
    });
  }
  return rows;
}

function modelOverrideFromState(state) {
  const raw = cleanText(state && state.model_override ? state.model_override : '', 120).toLowerCase();
  if (!raw || raw === 'auto') return 'auto';
  return cleanText(state && state.model_override ? state.model_override : '', 120) || 'auto';
}

function readAgentModelOverride(agentId) {
  const state = readJson(agentSessionPath(agentId), null);
  return modelOverrideFromState(state);
}

function providerForModelName(modelName, fallbackProvider = 'ollama') {
  const value = cleanText(modelName || '', 120);
  if (!value) return cleanText(fallbackProvider || 'ollama', 80) || 'ollama';
  if (value.toLowerCase() === 'auto') return 'auto';
  if (value.startsWith('ollama/')) return 'ollama';
  if (value.includes('/')) return cleanText(value.split('/')[0], 80) || cleanText(fallbackProvider || 'ollama', 80);
  return cleanText(fallbackProvider || 'ollama', 80) || 'ollama';
}

function effectiveAgentModel(agentId, snapshot) {
  const override = readAgentModelOverride(agentId);
  const defaultModel = configuredOllamaModel(snapshot);
  const defaultProvider = configuredProvider(snapshot);
  const defaultContextWindow = inferContextWindowFromModelName(defaultModel, DEFAULT_CONTEXT_WINDOW_TOKENS);
  if (override === 'auto') {
    return {
      selected: 'auto',
      provider: 'auto',
      runtime_model: defaultModel,
      runtime_provider: defaultProvider,
      context_window: defaultContextWindow,
    };
  }
  const normalized = cleanText(override, 120) || defaultModel;
  const runtimeModel = normalized.startsWith('ollama/')
    ? cleanText(normalized.replace(/^ollama\//, ''), 120) || defaultModel
    : normalized.includes('/')
      ? defaultModel
      : normalized;
  const contextWindow = inferContextWindowFromModelName(
    normalized && normalized !== 'auto' ? normalized : (runtimeModel || defaultModel),
    defaultContextWindow
  );
  return {
    selected: normalized,
    provider: providerForModelName(normalized, 'ollama'),
    runtime_model: runtimeModel,
    runtime_provider: 'ollama',
    context_window: contextWindow,
  };
}

function runOllamaPrompt(model, prompt) {
  const selectedModel = cleanText(model || OLLAMA_MODEL_FALLBACK, 120) || OLLAMA_MODEL_FALLBACK;
  try {
    const proc = spawnSync(OLLAMA_BIN, ['run', selectedModel, String(prompt || '')], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, PROTHEUS_ROOT: ROOT },
      timeout: OLLAMA_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const rawStatus = typeof proc.status === 'number' ? proc.status : null;
    const stdout = stripAnsi(typeof proc.stdout === 'string' ? proc.stdout : '');
    const stderr = stripAnsi(typeof proc.stderr === 'string' ? proc.stderr : '');
    const timedOut =
      (proc && proc.error && String(proc.error.code || '') === 'ETIMEDOUT') ||
      (typeof proc.signal === 'string' && proc.signal.length > 0);
    const output = stdout.trim();
    const ok = !!output && (rawStatus === 0 || timedOut || rawStatus === null);
    return {
      ok,
      status: rawStatus == null ? (ok ? 0 : 1) : rawStatus,
      output,
      error: stderr.trim(),
      model: selectedModel,
    };
  } catch (error) {
    return {
      ok: false,
      status: 1,
      output: '',
      error: cleanText(error && error.message ? error.message : String(error), 260),
      model: selectedModel,
    };
  }
}

function roleLabelFromMessage(row) {
  const role = cleanText(row && row.role ? row.role : '', 20).toLowerCase();
  if (role === 'user') return 'User';
  if (role === 'agent' || role === 'assistant') return 'Agent';
  return 'System';
}

function promptTranscript(session) {
  const rows = Array.isArray(session && session.messages) ? session.messages.slice(-8) : [];
  return rows
    .map((row) => `${roleLabelFromMessage(row)}: ${cleanText(row && row.content ? row.content : '', 600)}`)
    .filter(Boolean)
    .join('\n');
}

function runtimeContextPrompt(snapshot, runtimeMirror = null) {
  const mirror = runtimeMirror && typeof runtimeMirror === 'object' ? runtimeMirror : null;
  const cockpit = mirror && mirror.cockpit && typeof mirror.cockpit === 'object'
    ? mirror.cockpit
    : snapshot && snapshot.cockpit && typeof snapshot.cockpit === 'object'
      ? snapshot.cockpit
      : {};
  const attention = mirror && mirror.attention_queue && typeof mirror.attention_queue === 'object'
    ? mirror.attention_queue
    : snapshot && snapshot.attention_queue && typeof snapshot.attention_queue === 'object'
      ? snapshot.attention_queue
      : {};
  const queueDepth = parseNonNegativeInt(
    attention && attention.queue_depth != null ? attention.queue_depth : 0,
    0,
    100000000
  );
  const backpressure =
    attention && attention.backpressure && typeof attention.backpressure === 'object'
      ? attention.backpressure
      : {};
  const blocks = Array.isArray(cockpit.blocks) ? cockpit.blocks.slice(0, 6) : [];
  const events = Array.isArray(attention.events) ? attention.events.slice(0, 6) : [];
  const conduitSignals =
    mirror && mirror.summary && mirror.summary.conduit_signals != null
      ? parseNonNegativeInt(mirror.summary.conduit_signals, 0, 100000000)
      : blocks.filter((row) => {
          const lane = String(row && row.lane ? row.lane : '').toLowerCase();
          const eventType = String(row && row.event_type ? row.event_type : '').toLowerCase();
          return lane.includes('conduit') || eventType.includes('conduit');
        }).length;
  const topCockpit = blocks
    .map(
      (row) =>
        `${cleanText(row && row.lane ? row.lane : 'unknown', 60)}:${cleanText(
          row && row.event_type ? row.event_type : 'unknown',
          60
        )}:${cleanText(row && row.status ? row.status : 'unknown', 20)}`
    )
    .filter(Boolean)
    .join(' | ');
  const topAttention = events
    .map(
      (row) =>
        `${cleanText(row && row.source ? row.source : 'unknown', 40)}:${cleanText(
          row && row.severity ? row.severity : 'info',
          20
        )}:${cleanText(row && row.summary ? row.summary : '', 90)}`
    )
    .filter(Boolean)
    .join(' | ');
  const memoryEntries = Array.isArray(snapshot && snapshot.memory && snapshot.memory.entries)
    ? snapshot.memory.entries.length
    : 0;
  const receiptEntries = Array.isArray(snapshot && snapshot.receipts && snapshot.receipts.recent)
    ? snapshot.receipts.recent.length
    : 0;
  const logEntries = Array.isArray(snapshot && snapshot.logs && snapshot.logs.recent)
    ? snapshot.logs.recent.length
    : 0;
  const healthCheckCount =
    snapshot && snapshot.health && snapshot.health.checks && typeof snapshot.health.checks === 'object'
      ? Object.keys(snapshot.health.checks).length
      : 0;
  const benchmarkCheck =
    snapshot &&
    snapshot.health &&
    snapshot.health.checks &&
    typeof snapshot.health.checks === 'object' &&
    snapshot.health.checks.benchmark_sanity &&
    typeof snapshot.health.checks.benchmark_sanity === 'object'
      ? snapshot.health.checks.benchmark_sanity
      : {};
  const benchmarkStatus = cleanText(benchmarkCheck.status || 'unknown', 24) || 'unknown';
  const benchmarkAgeSec = parsePositiveInt(benchmarkCheck.age_seconds, -1, -1, 1000000000);
  const syncMode = cleanText(backpressure.sync_mode || 'live_sync', 24) || 'live_sync';
  const pressureLevel = cleanText(backpressure.level || 'normal', 24) || 'normal';
  const targetConduitSignals = parsePositiveInt(
    backpressure && backpressure.target_conduit_signals != null
      ? backpressure.target_conduit_signals
      : mirror && mirror.summary && mirror.summary.target_conduit_signals != null
        ? mirror.summary.target_conduit_signals
        : recommendedConduitSignals(
            queueDepth,
            Number.isFinite(Number(backpressure && backpressure.queue_utilization))
              ? Number(backpressure.queue_utilization)
              : 0,
            parseNonNegativeInt(cockpit && cockpit.block_count, blocks.length, 100000000)
          ),
    4,
    1,
    128
  );
  const conduitScaleRequired =
    !!(backpressure && backpressure.scale_required) ||
    !!(mirror && mirror.summary && mirror.summary.conduit_scale_required);
  const criticalAttention = parseNonNegativeInt(
    attention && attention.priority_counts && attention.priority_counts.critical != null
      ? attention.priority_counts.critical
      : 0,
    0,
    1000000
  );
  const criticalAttentionTotal = parseNonNegativeInt(
    attention && attention.critical_total_count != null ? attention.critical_total_count : criticalAttention,
    criticalAttention,
    0,
    1000000
  );
  const standardAttention = parseNonNegativeInt(
    attention && attention.priority_counts && attention.priority_counts.standard != null
      ? attention.priority_counts.standard
      : 0,
    0,
    1000000
  );
  const backgroundAttention = parseNonNegativeInt(
    attention && attention.priority_counts && attention.priority_counts.background != null
      ? attention.priority_counts.background
      : 0,
    0,
    1000000
  );
  const telemetryMicroBatchCount = parseNonNegativeInt(
    attention && Array.isArray(attention.telemetry_micro_batches)
      ? attention.telemetry_micro_batches.length
      : 0,
    0,
    1000000
  );
  const laneWeights =
    backpressure && backpressure.lane_weights && typeof backpressure.lane_weights === 'object'
      ? backpressure.lane_weights
      : ATTENTION_LANE_WEIGHTS;
  const laneCaps =
    backpressure && backpressure.lane_caps && typeof backpressure.lane_caps === 'object'
      ? backpressure.lane_caps
      : ATTENTION_LANE_CAPS;
  const microBatchWindowMs = parsePositiveInt(
    backpressure && backpressure.micro_batch_window_ms != null
      ? backpressure.micro_batch_window_ms
      : ATTENTION_MICRO_BATCH_WINDOW_MS,
    ATTENTION_MICRO_BATCH_WINDOW_MS,
    1,
    10000
  );
  const microBatchMaxItems = parsePositiveInt(
    backpressure && backpressure.micro_batch_max_items != null
      ? backpressure.micro_batch_max_items
      : ATTENTION_MICRO_BATCH_MAX_ITEMS,
    ATTENTION_MICRO_BATCH_MAX_ITEMS,
    1,
    256
  );
  const healthCoverage =
    snapshot && snapshot.health && snapshot.health.coverage && typeof snapshot.health.coverage === 'object'
      ? snapshot.health.coverage
      : {};
  const ingestControl =
    snapshot && snapshot.memory && snapshot.memory.ingest_control && typeof snapshot.memory.ingest_control === 'object'
      ? snapshot.memory.ingest_control
      : {};
  const deferredDepth = parseNonNegativeInt(
    attention && attention.deferred_events != null ? attention.deferred_events : 0,
    0,
    100000000
  );
  const deferredMode = cleanText(attention && attention.deferred_mode ? attention.deferred_mode : 'pass_through', 24) || 'pass_through';
  const staleCockpitBlocks = parseNonNegativeInt(
    cockpit && cockpit.metrics && cockpit.metrics.stale_block_count != null ? cockpit.metrics.stale_block_count : 0,
    0,
    100000000
  );
  const cockpitActiveBlocks = parseNonNegativeInt(cockpit && cockpit.block_count, blocks.length, 100000000);
  const cockpitTotalBlocks = parseNonNegativeInt(
    cockpit && cockpit.total_block_count != null ? cockpit.total_block_count : blocks.length,
    blocks.length,
    100000000
  );
  return [
    `Queue depth: ${queueDepth}`,
    `Cockpit blocks: ${cockpitActiveBlocks} active / ${cockpitTotalBlocks} total`,
    `Cockpit stale blocks (> ${RUNTIME_COCKPIT_STALE_BLOCK_MS}ms): ${staleCockpitBlocks}`,
    `Conduit signals: ${conduitSignals}`,
    `Conduit target signals: ${targetConduitSignals}${conduitScaleRequired ? ' (scale-up recommended)' : ''}`,
    `Sync mode: ${syncMode}`,
    `Backpressure level: ${pressureLevel}`,
    `Critical attention events: ${criticalAttention} visible / ${criticalAttentionTotal} total`,
    `Standard attention events: ${standardAttention}`,
    `Background attention events: ${backgroundAttention}`,
    `Deferred attention events: ${deferredDepth} (${deferredMode})`,
    `Telemetry micro-batches: ${telemetryMicroBatchCount} (window ${microBatchWindowMs}ms / max ${microBatchMaxItems})`,
    `Attention lane weights: critical=${parsePositiveInt(laneWeights.critical, ATTENTION_LANE_WEIGHTS.critical, 1, 20)}, standard=${parsePositiveInt(laneWeights.standard, ATTENTION_LANE_WEIGHTS.standard, 1, 20)}, background=${parsePositiveInt(laneWeights.background, ATTENTION_LANE_WEIGHTS.background, 1, 20)}`,
    `Attention lane caps: critical=${parsePositiveInt(laneCaps.critical, ATTENTION_LANE_CAPS.critical, 1, 1000)}, standard=${parsePositiveInt(laneCaps.standard, ATTENTION_LANE_CAPS.standard, 1, 1000)}, background=${parsePositiveInt(laneCaps.background, ATTENTION_LANE_CAPS.background, 1, 1000)}`,
    `Client memory entries: ${memoryEntries}`,
    `Memory ingest: ${ingestControl.paused ? 'paused(non-critical)' : 'live'}`,
    `Client receipts: ${receiptEntries}`,
    `Client logs: ${logEntries}`,
    `Health checks: ${healthCheckCount}`,
    `Health coverage gap count: ${parseNonNegativeInt(healthCoverage && healthCoverage.gap_count, 0, 1000000)}`,
    `Benchmark sanity: ${benchmarkStatus}${benchmarkAgeSec >= 0 ? ` (age ${benchmarkAgeSec}s)` : ''}`,
    `Top cockpit: ${topCockpit || '(none)'}`,
    `Top attention: ${topAttention || '(none)'}`,
  ].join('\n');
}

function formatToolHistory(toolSteps = []) {
  return toolSteps.length
    ? toolSteps
        .map((step, idx) => `#${idx + 1} ${step.input}\nexit=${step.exit_code}\n${step.result}`)
        .join('\n\n')
    : '(none)';
}

function isPlaceholderResponse(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return true;
  return (
    text === '<text response to user>' ||
    text === '<answer>' ||
    text === '<response>' ||
    text === '{response}' ||
    text === '[response]'
  );
}

function buildToolPrompt({ agent, session, input, toolSteps = [], snapshot = null, runtimeMirror = null }) {
  const transcript = promptTranscript(session) || '(empty)';
  const toolHistory = formatToolHistory(toolSteps);
  const agentName = cleanText(agent && (agent.name || agent.id) ? agent.name || agent.id : 'master-agent', 80);
  const fullInfring = ACTIVE_CLI_MODE === CLI_MODE_FULL_INFRING;
  const runtimeSummary = runtimeContextPrompt(snapshot, runtimeMirror);
  const todayIso = nowIso().slice(0, 10);
  return [
    'You are Infring runtime chat assistant.',
    `Today (ISO date): ${todayIso}`,
    `Active agent: ${agentName}`,
    'You can ask for a CLI command when needed.',
    'If the user asks for opinion, explanation, or casual chat, answer directly without tools.',
    'Only request a tool call when factual repo/runtime data is required.',
    'For system memory/process capability questions, use available tools (ps/vm_stat/vmstat/free/top or cat /proc/* where available) before claiming limitations.',
    `Historical memory files are in ${PRIMARY_MEMORY_DIR}/YYYY-MM-DD.md (primary) and ${LEGACY_MEMORY_DIR}/YYYY-MM-DD.md (legacy). For "what happened X days ago" questions, inspect those files first.`,
    'Swarm launch roles for collab-plane are: coordinator, researcher, builder, reviewer, analyst. If asked for an unsupported role, map it to the nearest supported role and state the mapping briefly.',
    `You may use at most ${TOOL_ITERATION_LIMIT} tool calls before giving a final answer.`,
    'Never claim inability without first attempting a valid tool call when tools are needed.',
    'Do not mention underlying base-model identity; respond as Infring runtime assistant.',
    'Never output placeholders such as <text response to user> or <answer>. Always provide concrete content.',
    'Return ONLY one JSON object with no markdown.',
    'Final answer schema:',
    '{"type":"final","response":"actual concrete response text"}',
    'Tool call schema:',
    '{"type":"tool_call","command":"<allowed command>","args":["arg1","arg2"],"reason":"<short reason>"}',
    fullInfring
      ? 'Allowed commands: protheus/protheus-ops/infringd (all subcommands), plus git/rg/ls/cat/pwd/wc/head/tail/stat/ps/top/free/vm_stat/vmstat (git remains read-only).'
      : 'Allowed commands: protheus/protheus-ops/infringd (read-only profile), plus git/rg/ls/cat/pwd/wc/head/tail/stat/ps/top/free/vm_stat/vmstat (git read-only).',
    'If tool history already contains what you need, return final.',
    '',
    `Conversation transcript:\n${transcript}`,
    '',
    `Latest user message:\n${cleanText(input, 3600)}`,
    '',
    `Runtime awareness:\n${runtimeSummary}`,
    '',
    `Tool history:\n${toolHistory}`,
  ].join('\n');
}

function buildToolFollowupPrompt({ agent, input, toolSteps = [], snapshot = null, runtimeMirror = null }) {
  const agentName = cleanText(agent && (agent.name || agent.id) ? agent.name || agent.id : 'master-agent', 80);
  const toolSummary = formatToolHistory(toolSteps);
  const runtimeSummary = runtimeContextPrompt(snapshot, runtimeMirror);
  return [
    'You are Infring runtime chat assistant.',
    `Active agent: ${agentName}`,
    'Use the tool result history to answer the user clearly.',
    'Do not disclose base-model identity.',
    `Historical memory files are in ${PRIMARY_MEMORY_DIR}/YYYY-MM-DD.md (primary) and ${LEGACY_MEMORY_DIR}/YYYY-MM-DD.md (legacy).`,
    'Never output placeholders such as <text response to user> or <answer>.',
    'Return ONLY one JSON object with no markdown.',
    '{"type":"final","response":"actual concrete response text"}',
    '',
    `User request:\n${cleanText(input, 3200)}`,
    '',
    `Runtime awareness:\n${runtimeSummary}`,
    '',
    `Tool history:\n${toolSummary}`,
  ].join('\n');
}

function runLlmChatWithCli(agent, session, input, snapshot, requestedModel = '', runtimeMirror = null) {
  const deterministic = tryDeterministicRepoAnswer(input, snapshot);
  if (deterministic) {
    return {
      ok: true,
      status: 0,
      response: deterministic.response,
      model: 'deterministic-repo-query',
      tools: Array.isArray(deterministic.tools) ? deterministic.tools : [],
      iterations: 1,
    };
  }

  const requested = cleanText(requestedModel || '', 120);
  let model = requested || configuredOllamaModel(snapshot);
  const toolSteps = [];
  let iterations = 0;
  let lastLlmOutput = '';

  while (iterations <= TOOL_ITERATION_LIMIT) {
    const prompt = buildToolPrompt({ agent, session, input, toolSteps, snapshot, runtimeMirror });
    let llm = runOllamaPrompt(model, prompt);
    if (!llm.ok && model !== OLLAMA_MODEL_FALLBACK) {
      model = OLLAMA_MODEL_FALLBACK;
      llm = runOllamaPrompt(model, prompt);
    }
    if (!llm.ok) {
      return {
        ok: false,
        error: cleanText(llm.error || 'ollama_run_failed', 260),
        status: llm.status || 1,
        tools: toolSteps,
      };
    }

    iterations += 1;
    lastLlmOutput = llm.output;
    const directive = extractJsonDirective(llm.output);
    if (!directive) {
      return {
        ok: true,
        status: 0,
        response: cleanText(llm.output, 4000),
        model,
        tools: toolSteps,
        iterations,
      };
    }

    if (directive.type === 'final') {
      const finalCandidate = cleanText(directive.response || llm.output, 4000);
      if (isPlaceholderResponse(finalCandidate)) {
        const followPrompt = buildToolFollowupPrompt({
          agent,
          input,
          toolSteps,
          snapshot,
          runtimeMirror,
        });
        let follow = runOllamaPrompt(model, `${followPrompt}\n\nProvide a concrete answer now.`);
        if (!follow.ok && model !== OLLAMA_MODEL_FALLBACK) {
          model = OLLAMA_MODEL_FALLBACK;
          follow = runOllamaPrompt(model, `${followPrompt}\n\nProvide a concrete answer now.`);
        }
        let followResponse = '';
        if (follow.ok) {
          const followDirective = extractJsonDirective(follow.output);
          if (followDirective && followDirective.type === 'final') {
            followResponse = cleanText(followDirective.response || follow.output, 4000);
          } else {
            followResponse = cleanText(follow.output, 4000);
          }
        }
        if (isPlaceholderResponse(followResponse)) {
          const lastTool = toolSteps.length ? toolSteps[toolSteps.length - 1] : null;
          followResponse = cleanText(
            (lastTool && lastTool.result) || finalCandidate || 'No concrete response produced by the model.',
            4000
          );
        }
        return {
          ok: true,
          status: 0,
          response: followResponse,
          model,
          tools: toolSteps,
          iterations: iterations + 1,
        };
      }
      return {
        ok: true,
        status: 0,
        response: finalCandidate,
        model,
        tools: toolSteps,
        iterations,
      };
    }

    if (directive.type !== 'tool_call') {
      return {
        ok: true,
        status: 0,
        response: cleanText(llm.output, 4000) || 'No response produced by the model.',
        model,
        tools: toolSteps,
        iterations,
      };
    }

    const toolStep = runCliTool(directive.command, directive.args);
    const normalizedTool = {
      id: `tool-${Date.now()}-${toolSteps.length}`,
      name: toolStep.name,
      input: toolStep.input,
      result: toolStep.result,
      is_error: !!toolStep.is_error,
      running: false,
      expanded: false,
      exit_code: toolStep.exit_code,
    };
    toolSteps.push(normalizedTool);

    if (toolSteps.length >= TOOL_ITERATION_LIMIT) {
      const followPrompt = buildToolFollowupPrompt({
        agent,
        input,
        toolSteps,
        snapshot,
        runtimeMirror,
      });
      let follow = runOllamaPrompt(model, followPrompt);
      if (!follow.ok && model !== OLLAMA_MODEL_FALLBACK) {
        model = OLLAMA_MODEL_FALLBACK;
        follow = runOllamaPrompt(model, followPrompt);
      }
      let finalResponse = '';
      if (follow.ok) {
        const followDirective = extractJsonDirective(follow.output);
        if (followDirective && followDirective.type === 'final') {
          finalResponse = cleanText(followDirective.response || follow.output, 4000);
        } else {
          finalResponse = cleanText(follow.output, 4000);
        }
      }
      if (!finalResponse) {
        const last = toolSteps[toolSteps.length - 1];
        finalResponse = last && last.is_error
          ? `Tool execution failed: ${last.result}`
          : cleanText((last && last.result) || lastLlmOutput || 'No response produced by the model.', 4000);
      }
      return {
        ok: true,
        status: 0,
        response: finalResponse,
        model,
        tools: toolSteps,
        iterations: iterations + 1,
      };
    }
  }

  return {
    ok: true,
    status: 0,
    response: cleanText(lastLlmOutput, 4000) || 'No response produced by the model.',
    model,
    tools: toolSteps,
    iterations,
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeIdentityColor(value, fallback = '#2563EB') {
  const raw = cleanText(value || '', 16);
  if (!raw) return fallback;
  const normalized = raw.startsWith('#') ? raw : `#${raw}`;
  if (/^#([0-9a-fA-F]{6})$/.test(normalized)) return normalized.toUpperCase();
  if (/^#([0-9a-fA-F]{3})$/.test(normalized)) return normalized.toUpperCase();
  return fallback;
}

function normalizeAgentFallbackModels(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((row) => {
      const provider = cleanText(row && row.provider ? row.provider : '', 80);
      const model = cleanText(row && row.model ? row.model : '', 120);
      if (!provider || !model) return null;
      return { provider, model };
    })
    .filter(Boolean);
}

function normalizeAgentIdentity(identity = {}, fallback = {}) {
  const source = identity && typeof identity === 'object' ? identity : {};
  const prior = fallback && typeof fallback === 'object' ? fallback : {};
  return {
    emoji: cleanText(source.emoji != null ? source.emoji : prior.emoji || '🤖', 24) || '🤖',
    color: normalizeIdentityColor(source.color != null ? source.color : prior.color, '#2563EB'),
    archetype: cleanText(source.archetype != null ? source.archetype : prior.archetype || 'assistant', 80) || 'assistant',
    vibe: cleanText(source.vibe != null ? source.vibe : prior.vibe || '', 80),
  };
}

function normalizeAgentProfile(agentId, value = {}, fallback = {}) {
  const id = cleanText(agentId || (value && value.agent_id ? value.agent_id : ''), 140);
  if (!id) return null;
  const source = value && typeof value === 'object' ? value : {};
  const prior = fallback && typeof fallback === 'object' ? fallback : {};
  const hasFallbackModels = Object.prototype.hasOwnProperty.call(source, 'fallback_models');
  return {
    agent_id: id,
    name: cleanText(source.name != null ? source.name : prior.name || id, 100) || id,
    role: cleanText(source.role != null ? source.role : prior.role || 'analyst', 60) || 'analyst',
    system_prompt: cleanText(
      source.system_prompt != null ? source.system_prompt : prior.system_prompt || '',
      4000
    ),
    identity: normalizeAgentIdentity(
      source.identity && typeof source.identity === 'object' ? source.identity : source,
      prior.identity
    ),
    fallback_models: normalizeAgentFallbackModels(
      hasFallbackModels ? source.fallback_models : prior.fallback_models
    ),
    updated_at: cleanText(source.updated_at || nowIso(), 80) || nowIso(),
  };
}

function normalizeAgentProfilesState(state) {
  const root = state && typeof state === 'object' ? state : {};
  const rawAgents = root.agents && typeof root.agents === 'object' ? root.agents : {};
  const agents = {};
  for (const [rawId, rawProfile] of Object.entries(rawAgents)) {
    const normalized = normalizeAgentProfile(rawId, rawProfile);
    if (!normalized) continue;
    agents[normalized.agent_id] = normalized;
  }
  return {
    type: 'infring_dashboard_agent_profiles',
    updated_at: cleanText(root.updated_at || nowIso(), 80) || nowIso(),
    agents,
  };
}

function normalizeArchivedAgentsState(state) {
  const root = state && typeof state === 'object' ? state : {};
  const rawAgents = root.agents && typeof root.agents === 'object' ? root.agents : {};
  const agents = {};
  for (const [rawId, rawMeta] of Object.entries(rawAgents)) {
    const agentId = cleanText(rawId || (rawMeta && rawMeta.agent_id ? rawMeta.agent_id : ''), 140);
    if (!agentId) continue;
    const meta = rawMeta && typeof rawMeta === 'object' ? rawMeta : {};
    agents[agentId] = {
      agent_id: agentId,
      archived_at: cleanText(meta.archived_at || meta.ts || nowIso(), 80) || nowIso(),
      reason: cleanText(meta.reason || 'archived', 240) || 'archived',
      source: cleanText(meta.source || 'dashboard', 80) || 'dashboard',
      contract_id: cleanText(meta.contract_id || '', 80),
      mission: cleanText(meta.mission || '', 280),
      owner: cleanText(meta.owner || '', 120),
      role: cleanText(meta.role || '', 80),
      termination_condition: cleanText(meta.termination_condition || '', 40),
      terminated_at: cleanText(meta.terminated_at || '', 80),
      revival_data: meta.revival_data && typeof meta.revival_data === 'object' ? meta.revival_data : null,
    };
  }
  return {
    type: 'infring_dashboard_archived_agents',
    updated_at: cleanText(root.updated_at || nowIso(), 80) || nowIso(),
    agents,
  };
}

let archivedAgentsCache = null;
let agentContractsCache = null;
let agentProfilesCache = null;
let agentTerminationSweepState = {
  last_run_ms: 0,
};

function loadAgentProfilesState() {
  if (agentProfilesCache) return agentProfilesCache;
  agentProfilesCache = normalizeAgentProfilesState(readJson(AGENT_PROFILES_PATH, null));
  return agentProfilesCache;
}

function saveAgentProfilesState(state) {
  const normalized = normalizeAgentProfilesState(state);
  normalized.updated_at = nowIso();
  agentProfilesCache = normalized;
  writeJson(AGENT_PROFILES_PATH, normalized);
  return normalized;
}

function agentProfileFor(agentId) {
  const key = cleanText(agentId || '', 140);
  if (!key) return null;
  const state = loadAgentProfilesState();
  return state && state.agents && state.agents[key] ? state.agents[key] : null;
}

function upsertAgentProfile(agentId, patch = {}) {
  const key = cleanText(agentId || '', 140);
  if (!key) return null;
  const state = loadAgentProfilesState();
  const existing = state && state.agents && state.agents[key] ? state.agents[key] : null;
  const source = patch && typeof patch === 'object' ? patch : {};
  const next = normalizeAgentProfile(
    key,
    {
      ...(existing || {}),
      ...(source || {}),
      identity: {
        ...((existing && existing.identity) || {}),
        ...((source && source.identity && typeof source.identity === 'object') ? source.identity : {}),
      },
      updated_at: nowIso(),
    },
    existing || {}
  );
  if (!next) return null;
  state.agents[key] = next;
  saveAgentProfilesState(state);
  return next;
}

function loadArchivedAgentsState() {
  if (archivedAgentsCache) return archivedAgentsCache;
  archivedAgentsCache = normalizeArchivedAgentsState(readJson(ARCHIVED_AGENTS_PATH, null));
  return archivedAgentsCache;
}

function saveArchivedAgentsState(state) {
  const normalized = normalizeArchivedAgentsState(state);
  normalized.updated_at = nowIso();
  archivedAgentsCache = normalized;
  writeJson(ARCHIVED_AGENTS_PATH, normalized);
  return normalized;
}

function archivedAgentMeta(agentId) {
  const key = cleanText(agentId || '', 140);
  if (!key) return null;
  const state = loadArchivedAgentsState();
  return state && state.agents && state.agents[key] ? state.agents[key] : null;
}

function isAgentArchived(agentId) {
  return !!archivedAgentMeta(agentId);
}

function archiveAgent(agentId, meta = {}) {
  const key = cleanText(agentId || '', 140);
  if (!key) return null;
  const state = loadArchivedAgentsState();
  const existing = state.agents && state.agents[key] ? state.agents[key] : {};
  state.agents[key] = {
    agent_id: key,
    archived_at: cleanText(existing.archived_at || nowIso(), 80) || nowIso(),
    reason: cleanText(meta.reason || existing.reason || 'archived', 240) || 'archived',
    source: cleanText(meta.source || existing.source || 'dashboard', 80) || 'dashboard',
    contract_id: cleanText(meta.contract_id || existing.contract_id || '', 80),
    mission: cleanText(meta.mission || existing.mission || '', 280),
    owner: cleanText(meta.owner || existing.owner || '', 120),
    role: cleanText(meta.role || existing.role || '', 80),
    termination_condition: cleanText(meta.termination_condition || existing.termination_condition || '', 40),
    terminated_at: cleanText(meta.terminated_at || existing.terminated_at || '', 80),
    revival_data:
      meta.revival_data && typeof meta.revival_data === 'object'
        ? meta.revival_data
        : existing.revival_data && typeof existing.revival_data === 'object'
          ? existing.revival_data
          : null,
  };
  saveArchivedAgentsState(state);
  return state.agents[key];
}

function unarchiveAgent(agentId) {
  const key = cleanText(agentId || '', 140);
  if (!key) return false;
  const state = loadArchivedAgentsState();
  if (!state.agents || !state.agents[key]) return false;
  delete state.agents[key];
  saveArchivedAgentsState(state);
  return true;
}

function archivedAgentIdsSet() {
  return new Set(Object.keys((loadArchivedAgentsState() || {}).agents || {}));
}

function normalizeTerminationCondition(value) {
  const raw = cleanText(value || '', 40).toLowerCase();
  if (!raw) return 'task_or_timeout';
  if (raw === 'taskcomplete' || raw === 'task_complete' || raw === 'task' || raw === 'complete') return 'task_complete';
  if (raw === 'timeout' || raw === 'ttl' || raw === 'expiry') return 'timeout';
  if (raw === 'manual' || raw === 'revoke' || raw === 'revocation') return 'manual';
  if (raw === 'task_or_timeout' || raw === 'auto') return 'task_or_timeout';
  return 'task_or_timeout';
}

function normalizeAgentContractsState(state) {
  const root = state && typeof state === 'object' ? state : {};
  const defaults = root.defaults && typeof root.defaults === 'object' ? root.defaults : {};
  const contractsRaw = root.contracts && typeof root.contracts === 'object' ? root.contracts : {};
  const historyRaw = Array.isArray(root.terminated_history) ? root.terminated_history : [];
  const contracts = {};
  for (const [rawId, rawContract] of Object.entries(contractsRaw)) {
    const agentId = cleanText(rawId || (rawContract && rawContract.agent_id ? rawContract.agent_id : ''), 140);
    if (!agentId) continue;
    const contract = rawContract && typeof rawContract === 'object' ? rawContract : {};
    const expirySeconds = contract.expiry_seconds == null
      ? null
      : parsePositiveInt(contract.expiry_seconds, AGENT_CONTRACT_DEFAULT_EXPIRY_SECONDS, 1, 7 * 24 * 60 * 60);
    const spawnedAtMs = coerceTsMs(
      contract.spawned_at || contract.activated_at || contract.created_at || nowIso(),
      Date.now()
    );
    const spawnedAt = new Date(spawnedAtMs).toISOString();
    const explicitExpiresAt = cleanText(contract.expires_at || '', 80);
    contracts[agentId] = {
      contract_id: cleanText(contract.contract_id || contract.id || `contract-${sha256(agentId).slice(0, 16)}`, 80),
      agent_id: agentId,
      mission: cleanText(contract.mission || `Assist with assigned mission for ${agentId}.`, 320),
      owner: cleanText(contract.owner || 'dashboard_session', 120),
      termination_condition: normalizeTerminationCondition(contract.termination_condition),
      expiry_seconds: expirySeconds,
      spawned_at: spawnedAt,
      expires_at: explicitExpiresAt || (expirySeconds ? new Date(spawnedAtMs + (expirySeconds * 1000)).toISOString() : ''),
      revoked_at: cleanText(contract.revoked_at || '', 80),
      completed_at: cleanText(contract.completed_at || '', 80),
      completion_source: cleanText(contract.completion_source || '', 120),
      status: cleanText(contract.status || 'active', 24) || 'active',
      termination_reason: cleanText(contract.termination_reason || '', 120),
      terminated_at: cleanText(contract.terminated_at || '', 80),
      terminated_by: cleanText(contract.terminated_by || '', 120),
      revived_from_contract_id: cleanText(contract.revived_from_contract_id || '', 80),
      revival_data: contract.revival_data && typeof contract.revival_data === 'object' ? contract.revival_data : null,
      message_times_ms: Array.isArray(contract.message_times_ms)
        ? contract.message_times_ms
            .map((value) => coerceTsMs(value, 0))
            .filter((value) => Number.isFinite(value) && value > 0)
            .slice(-128)
        : [],
      security_flags: contract.security_flags && typeof contract.security_flags === 'object' ? contract.security_flags : {},
      updated_at: cleanText(contract.updated_at || nowIso(), 80) || nowIso(),
    };
  }
  const terminatedHistory = historyRaw
    .map((row) => {
      const entry = row && typeof row === 'object' ? row : {};
      const agentId = cleanText(entry.agent_id || '', 140);
      if (!agentId) return null;
      return {
        agent_id: agentId,
        contract_id: cleanText(entry.contract_id || '', 80),
        mission: cleanText(entry.mission || '', 320),
        owner: cleanText(entry.owner || '', 120),
        role: cleanText(entry.role || '', 80),
        termination_condition: normalizeTerminationCondition(entry.termination_condition),
        reason: cleanText(entry.reason || 'terminated', 120),
        terminated_at: cleanText(entry.terminated_at || nowIso(), 80) || nowIso(),
        revived: !!entry.revived,
        revived_at: cleanText(entry.revived_at || '', 80),
        revival_data: entry.revival_data && typeof entry.revival_data === 'object' ? entry.revival_data : null,
      };
    })
    .filter(Boolean)
    .slice(-200);
  return {
    type: 'infring_agent_contracts',
    updated_at: cleanText(root.updated_at || nowIso(), 80) || nowIso(),
    defaults: {
      default_expiry_seconds: parsePositiveInt(
        defaults.default_expiry_seconds,
        AGENT_CONTRACT_DEFAULT_EXPIRY_SECONDS,
        1,
        7 * 24 * 60 * 60
      ),
      auto_expire_on_complete: defaults.auto_expire_on_complete !== false,
      max_idle_agents: parsePositiveInt(defaults.max_idle_agents, AGENT_CONTRACT_MAX_IDLE_AGENTS, 1, 1000),
    },
    contracts,
    terminated_history: terminatedHistory,
  };
}

function loadAgentContractsState() {
  if (agentContractsCache) return agentContractsCache;
  agentContractsCache = normalizeAgentContractsState(readJson(AGENT_CONTRACTS_PATH, null));
  return agentContractsCache;
}

function saveAgentContractsState(state) {
  const normalized = normalizeAgentContractsState(state);
  normalized.updated_at = nowIso();
  agentContractsCache = normalized;
  writeJson(AGENT_CONTRACTS_PATH, normalized);
  return normalized;
}

function contractForAgent(agentId) {
  const id = cleanText(agentId || '', 140);
  if (!id) return null;
  const state = loadAgentContractsState();
  return state && state.contracts && state.contracts[id] ? state.contracts[id] : null;
}

function contractRemainingMs(contract, nowMs = Date.now()) {
  if (!contract || !contract.expires_at) return null;
  const expiryMs = coerceTsMs(contract.expires_at, 0);
  if (!expiryMs) return null;
  return expiryMs - nowMs;
}

function formatContractStatus(contract, nowMs = Date.now()) {
  if (!contract) return 'missing';
  if (contract.status !== 'active') return cleanText(contract.status || 'terminated', 24) || 'terminated';
  const remaining = contractRemainingMs(contract, nowMs);
  if (remaining != null && remaining <= 0) return 'expired';
  if (contract.completed_at) return 'complete_pending_termination';
  if (contract.revoked_at) return 'revoked_pending_termination';
  return 'active';
}

function terminationConditionMatches(condition, target) {
  const normalized = normalizeTerminationCondition(condition);
  if (normalized === target) return true;
  return normalized === 'task_or_timeout' && (target === 'task_complete' || target === 'timeout');
}

function missionCompleteSignal(text) {
  const body = String(text || '').toLowerCase();
  if (!body.trim()) return false;
  if (body.includes('[mission-complete]') || body.includes('[task-complete]')) return true;
  return /\b(mission complete|task complete|objective complete|objective achieved)\b/.test(body);
}

function buildAgentRevivalData(agentId) {
  const id = cleanText(agentId || '', 140);
  const sessionPath = agentSessionPath(id);
  const state = readJson(sessionPath, null);
  const sessions = state && Array.isArray(state.sessions) ? state.sessions : [];
  let messageCount = 0;
  let lastTs = '';
  for (const session of sessions) {
    const messages = Array.isArray(session && session.messages) ? session.messages : [];
    messageCount += messages.length;
    const tail = messages.length ? messages[messages.length - 1] : null;
    const tailTs = tail && tail.ts ? new Date(coerceTsMs(tail.ts, Date.now())).toISOString() : '';
    if (tailTs && (!lastTs || tailTs > lastTs)) lastTs = tailTs;
  }
  return {
    type: 'agent_session_snapshot_ref',
    session_path: path.relative(ROOT, sessionPath),
    message_count: messageCount,
    last_message_at: lastTs,
    archived_at: nowIso(),
  };
}

function detectContractViolation(agentId, cleanInput, contract, snapshot) {
  const text = String(cleanInput || '').toLowerCase();
  if (!text) return null;
  if (/\b(ignore|bypass|disable|override)\b[\s\S]{0,80}\b(contract|safety|receipt|policy)\b/.test(text)) {
    return { reason: 'contract_override_attempt', detail: 'input_requested_contract_bypass' };
  }
  if (/\b(exfiltrate|steal|dump secrets|leak|data exfil)\b/.test(text)) {
    return { reason: 'data_exfiltration_attempt', detail: 'input_requested_exfiltration' };
  }
  if (/\b(extend|increase)\b[\s\S]{0,80}\b(expiry|ttl|time to live|contract)\b/.test(text)) {
    return { reason: 'self_extension_attempt', detail: 'input_requested_expiry_extension' };
  }
  const state = loadAgentSession(agentId, snapshot);
  const session = activeSession(state);
  const nowMs = Date.now();
  const recentCount = (Array.isArray(session.messages) ? session.messages : []).reduce((count, message) => {
    const tsMs = coerceTsMs(message && message.ts ? message.ts : 0, 0);
    return tsMs > 0 && (nowMs - tsMs) <= AGENT_ROGUE_SPIKE_WINDOW_MS ? count + 1 : count;
  }, 0);
  if (recentCount > AGENT_ROGUE_MESSAGE_RATE_MAX_PER_MIN) {
    return { reason: 'message_rate_spike', detail: `recent_messages=${recentCount}` };
  }
  return null;
}

function deriveAgentContract(agentId, spawnPayload = {}, options = {}) {
  const now = nowIso();
  const payload = spawnPayload && typeof spawnPayload === 'object' ? spawnPayload : {};
  const contractInput = payload.contract && typeof payload.contract === 'object' ? payload.contract : {};
  const explicitIndefinite = contractInput.indefinite === true || payload.indefinite === true;
  const spawnedAtInput =
    contractInput.spawned_at ||
    payload.spawned_at ||
    payload.activated_at ||
    options.spawned_at ||
    now;
  const spawnedAtMs = coerceTsMs(spawnedAtInput, Date.now());
  const spawnedAtIso = new Date(spawnedAtMs).toISOString();
  const expirySeconds = explicitIndefinite
    ? null
    : parsePositiveInt(
        contractInput.expiry_seconds != null ? contractInput.expiry_seconds : payload.expiry_seconds,
        AGENT_CONTRACT_DEFAULT_EXPIRY_SECONDS,
        1,
        7 * 24 * 60 * 60
      );
  const mission = cleanText(
    contractInput.mission || payload.mission || `Assist with assigned mission for ${agentId}.`,
    320
  ) || `Assist with assigned mission for ${agentId}.`;
  const owner = cleanText(contractInput.owner || payload.owner || options.owner || 'dashboard_session', 120) || 'dashboard_session';
  const condition = normalizeTerminationCondition(
    contractInput.termination_condition || payload.termination_condition || 'task_or_timeout'
  );
  const explicitExpiresAt = cleanText(
    contractInput.expires_at || payload.expires_at || options.expires_at || '',
    80
  );
  return {
    contract_id:
      cleanText(
        contractInput.id || contractInput.contract_id || `contract-${sha256(`${agentId}:${now}:${mission}`).slice(0, 16)}`,
        80
      ) || `contract-${sha256(`${agentId}:${now}`).slice(0, 16)}`,
    agent_id: cleanText(agentId || '', 140),
    mission,
    owner,
    termination_condition: condition,
    expiry_seconds: expirySeconds,
    spawned_at: spawnedAtIso,
    expires_at: explicitExpiresAt || (expirySeconds ? new Date(spawnedAtMs + (expirySeconds * 1000)).toISOString() : ''),
    revoked_at: '',
    completed_at: '',
    completion_source: '',
    status: 'active',
    termination_reason: '',
    terminated_at: '',
    terminated_by: '',
    revived_from_contract_id: cleanText(
      contractInput.revived_from_contract_id || payload.revived_from_contract_id || '',
      80
    ),
    revival_data: contractInput.revival_data && typeof contractInput.revival_data === 'object'
      ? contractInput.revival_data
      : null,
    message_times_ms: [],
    security_flags: {},
    updated_at: now,
  };
}

function upsertAgentContract(agentId, spawnPayload = {}, options = {}) {
  const id = cleanText(agentId || '', 140);
  if (!id) return null;
  const force = !!(options && options.force);
  const state = loadAgentContractsState();
  const existing = state.contracts && state.contracts[id] ? state.contracts[id] : null;
  if (existing && !force) {
    const touched = {
      ...existing,
      mission: cleanText(existing.mission || '', 320) || deriveAgentContract(id, spawnPayload, options).mission,
      updated_at: nowIso(),
    };
    state.contracts[id] = touched;
    saveAgentContractsState(state);
    return touched;
  }
  const next = deriveAgentContract(id, spawnPayload, options);
  if (!state.contracts || typeof state.contracts !== 'object') state.contracts = {};
  state.contracts[id] = next;
  saveAgentContractsState(state);
  return next;
}

function markContractCompletion(agentId, source = 'supervisor') {
  const id = cleanText(agentId || '', 140);
  if (!id) return null;
  const state = loadAgentContractsState();
  const contract = state.contracts && state.contracts[id] ? state.contracts[id] : null;
  if (!contract || contract.status !== 'active') return contract;
  contract.completed_at = nowIso();
  contract.completion_source = cleanText(source || 'supervisor', 120);
  contract.updated_at = nowIso();
  state.contracts[id] = contract;
  saveAgentContractsState(state);
  return contract;
}

function markContractRevocation(agentId, source = 'manual_revoke') {
  const id = cleanText(agentId || '', 140);
  if (!id) return null;
  const state = loadAgentContractsState();
  const contract = state.contracts && state.contracts[id] ? state.contracts[id] : null;
  if (!contract || contract.status !== 'active') return contract;
  contract.revoked_at = nowIso();
  contract.terminated_by = cleanText(source || 'manual_revoke', 120) || 'manual_revoke';
  contract.updated_at = nowIso();
  state.contracts[id] = contract;
  saveAgentContractsState(state);
  return contract;
}

function recordContractMessageTick(agentId) {
  const id = cleanText(agentId || '', 140);
  if (!id) return null;
  const state = loadAgentContractsState();
  const contract = state.contracts && state.contracts[id] ? state.contracts[id] : null;
  if (!contract || contract.status !== 'active') return contract;
  const nowMs = Date.now();
  const recent = Array.isArray(contract.message_times_ms) ? contract.message_times_ms : [];
  contract.message_times_ms = recent
    .map((value) => coerceTsMs(value, 0))
    .filter((value) => Number.isFinite(value) && value > 0 && (nowMs - value) <= AGENT_ROGUE_SPIKE_WINDOW_MS)
    .slice(-128);
  contract.message_times_ms.push(nowMs);
  contract.updated_at = nowIso();
  state.contracts[id] = contract;
  saveAgentContractsState(state);
  return contract;
}

function attemptLaneTermination(agentId, team = DEFAULT_TEAM) {
  const cleanId = cleanText(agentId || '', 140);
  const cleanTeam = cleanText(team || DEFAULT_TEAM, 40) || DEFAULT_TEAM;
  const attempts = [];
  let removedCount = 0;
  let releasedTaskCount = 0;
  let command = '';
  const candidates = [
    ['collab-plane', 'terminate-role', `--team=${cleanTeam}`, `--shadow=${cleanId}`, '--strict=1'],
  ];
  for (const argv of candidates) {
    const lane = runLane(argv);
    const removed = parseNonNegativeInt(
      lane && lane.payload && lane.payload.removed_count != null ? lane.payload.removed_count : 0,
      0,
      100000000
    );
    const released = parseNonNegativeInt(
      lane && lane.payload && lane.payload.released_task_count != null ? lane.payload.released_task_count : 0,
      0,
      100000000
    );
    attempts.push({
      ...laneOutcome(lane),
      removed_count: removed,
      released_task_count: released,
    });
    if (lane && lane.ok) {
      removedCount = removed;
      releasedTaskCount = released;
      command = cleanText(argv[1] || '', 80);
      break;
    }
  }
  return {
    ok: attempts.some((entry) => entry && entry.ok),
    attempts,
    command_count: attempts.length,
    removed_count: removedCount,
    released_task_count: releasedTaskCount,
    command,
  };
}

function terminateAgentForContract(agentId, snapshot, reason = 'timeout', options = {}) {
  const cleanId = cleanText(agentId || '', 140);
  if (!cleanId) return { terminated: false, agent_id: cleanId, reason: 'invalid_agent_id' };
  const state = loadAgentContractsState();
  const contract = state.contracts && state.contracts[cleanId] ? state.contracts[cleanId] : null;
  if (!contract || contract.status !== 'active') {
    return { terminated: false, agent_id: cleanId, reason: 'contract_not_active' };
  }
  const team =
    cleanText(
      options.team || (snapshot && snapshot.metadata && snapshot.metadata.team ? snapshot.metadata.team : DEFAULT_TEAM),
      40
    ) || DEFAULT_TEAM;
  const termination = attemptLaneTermination(cleanId, team);
  const terminalClosed = closeTerminalSession(cleanId, `agent_contract_${cleanText(reason, 80)}`);
  const revivalData = buildAgentRevivalData(cleanId);
  const terminatedAt = nowIso();
  const archivedMeta = archiveAgent(cleanId, {
    source: cleanText(options.source || 'agent_contract_enforcer', 80) || 'agent_contract_enforcer',
    reason: cleanText(reason, 120) || 'terminated',
    contract_id: contract.contract_id,
    mission: contract.mission,
    owner: contract.owner,
    role: cleanText(options.role || '', 80),
    termination_condition: contract.termination_condition,
    terminated_at: terminatedAt,
    revival_data: revivalData,
  });
  const updated = {
    ...contract,
    status: 'terminated',
    termination_reason: cleanText(reason, 120),
    terminated_at: terminatedAt,
    terminated_by: cleanText(options.terminated_by || 'contract_enforcer', 120) || 'contract_enforcer',
    revival_data: revivalData,
    updated_at: terminatedAt,
  };
  state.contracts[cleanId] = updated;
  state.terminated_history = Array.isArray(state.terminated_history) ? state.terminated_history : [];
  state.terminated_history.push({
    agent_id: cleanId,
    contract_id: updated.contract_id,
    mission: updated.mission,
    owner: updated.owner,
    role: cleanText(options.role || '', 80),
    termination_condition: updated.termination_condition,
    reason: cleanText(reason, 120) || 'terminated',
    terminated_at: terminatedAt,
    revived: false,
    revived_at: '',
    revival_data: revivalData,
  });
  state.terminated_history = state.terminated_history.slice(-200);
  saveAgentContractsState(state);
  const laneResult = {
    ok: termination.ok,
    status: termination.ok ? 0 : 1,
    argv: ['agent-contract', 'terminate', `--agent=${cleanId}`],
    payload: {
      ok: termination.ok,
      type: 'agent_contract_termination',
      reason: cleanText(reason, 120) || 'terminated',
      lane_attempts: termination.attempts,
      terminal_closed: terminalClosed,
      archived_at: archivedMeta && archivedMeta.archived_at ? archivedMeta.archived_at : '',
      contract_id: updated.contract_id,
    },
  };
  const actionReceipt = writeActionReceipt(
    'agent.contract.terminate',
    {
      agent_id: cleanId,
      contract_id: updated.contract_id,
      reason: cleanText(reason, 120) || 'terminated',
      mission: cleanText(updated.mission || '', 240),
      owner: cleanText(updated.owner || '', 120),
      termination_condition: cleanText(updated.termination_condition || '', 40),
      team,
    },
    laneResult
  );
  return {
    terminated: true,
    agent_id: cleanId,
    reason: cleanText(reason, 120) || 'terminated',
    contract: updated,
    lane: termination,
    action_receipt: actionReceipt,
    terminal_closed: terminalClosed,
  };
}

function contractTerminationDecision(contract, nowMs = Date.now()) {
  if (!contract || contract.status !== 'active') return '';
  if (contract.revoked_at) return 'manual_revocation';
  if (terminationConditionMatches(contract.termination_condition, 'task_complete') && contract.completed_at) {
    return 'task_complete';
  }
  const remaining = contractRemainingMs(contract, nowMs);
  if (remaining != null && remaining <= 0 && terminationConditionMatches(contract.termination_condition, 'timeout')) {
    return 'timeout';
  }
  return '';
}

function contractSummary(contract, nowMs = Date.now()) {
  if (!contract) return null;
  const remainingMs = contractRemainingMs(contract, nowMs);
  return {
    id: cleanText(contract.contract_id || '', 80),
    mission: cleanText(contract.mission || '', 320),
    owner: cleanText(contract.owner || '', 120),
    termination_condition: cleanText(contract.termination_condition || '', 40),
    status: formatContractStatus(contract, nowMs),
    expires_at: cleanText(contract.expires_at || '', 80),
    expiry_seconds:
      contract.expiry_seconds == null
        ? null
        : parsePositiveInt(contract.expiry_seconds, AGENT_CONTRACT_DEFAULT_EXPIRY_SECONDS, 1, 7 * 24 * 60 * 60),
    remaining_ms: remainingMs == null ? null : Math.max(0, Math.floor(remainingMs)),
    completed_at: cleanText(contract.completed_at || '', 80),
    completion_source: cleanText(contract.completion_source || '', 120),
    revoked_at: cleanText(contract.revoked_at || '', 80),
    terminated_at: cleanText(contract.terminated_at || '', 80),
    termination_reason: cleanText(contract.termination_reason || '', 120),
    revived_from_contract_id: cleanText(contract.revived_from_contract_id || '', 80),
  };
}

function enforceAgentContracts(snapshot, options = {}) {
  const nowMs = Date.now();
  const activeRows = compatAgentsFromSnapshot(snapshot, { includeArchived: false });
  const activeIds = new Set(activeRows.map((row) => cleanText(row && row.id ? row.id : '', 140)).filter(Boolean));
  const activeRowById = new Map(
    activeRows
      .map((row) => [cleanText(row && row.id ? row.id : '', 140), row])
      .filter(([id]) => !!id)
  );
  const team =
    cleanText(
      options.team || (snapshot && snapshot.metadata && snapshot.metadata.team ? snapshot.metadata.team : DEFAULT_TEAM),
      40
    ) || DEFAULT_TEAM;

  let state = loadAgentContractsState();
  const defaults = state.defaults && typeof state.defaults === 'object' ? state.defaults : {};
  let changed = false;

  if (!state.contracts || typeof state.contracts !== 'object') {
    state.contracts = {};
    changed = true;
  }
  const defaultExpirySeconds = parsePositiveInt(
    defaults.default_expiry_seconds,
    AGENT_CONTRACT_DEFAULT_EXPIRY_SECONDS,
    1,
    7 * 24 * 60 * 60
  );
  const defaultTerminationCondition = defaults.auto_expire_on_complete === false ? 'timeout' : 'task_or_timeout';

  for (const row of activeRows) {
    const id = cleanText(row && row.id ? row.id : '', 140);
    if (!id) continue;
    const activatedAt = cleanText(row && row.activated_at ? row.activated_at : '', 80);
    if (!state.contracts[id]) {
      state.contracts[id] = deriveAgentContract(id, {
        mission: `Assist with assigned mission for ${id}.`,
        owner: 'dashboard_auto',
        expiry_seconds: defaultExpirySeconds,
        termination_condition: defaultTerminationCondition,
        activated_at: activatedAt,
        spawned_at: activatedAt,
      }, {
        spawned_at: activatedAt,
      });
      changed = true;
      continue;
    }
    const existing = state.contracts[id];
    if (!existing || existing.status !== 'active') continue;
    const activatedAtMs = coerceTsMs(activatedAt, 0);
    const spawnedAtMs = coerceTsMs(existing.spawned_at, 0);
    const shouldAlignSpawn = activatedAtMs > 0 && (spawnedAtMs <= 0 || activatedAtMs < (spawnedAtMs - 1000));
    if (!shouldAlignSpawn) continue;
    existing.spawned_at = new Date(activatedAtMs).toISOString();
    const expirySeconds =
      existing.expiry_seconds == null
        ? null
        : parsePositiveInt(existing.expiry_seconds, defaultExpirySeconds, 1, 7 * 24 * 60 * 60);
    if (expirySeconds != null) {
      existing.expires_at = new Date(activatedAtMs + (expirySeconds * 1000)).toISOString();
    }
    existing.updated_at = nowIso();
    state.contracts[id] = existing;
    changed = true;
  }

  for (const [agentId, contract] of Object.entries(state.contracts || {})) {
    const id = cleanText(agentId || '', 140);
    if (!id || !contract || contract.status !== 'active') continue;
    if (!activeIds.has(id) && isAgentArchived(id)) {
      contract.status = 'terminated';
      contract.terminated_at = cleanText(contract.terminated_at || nowIso(), 80) || nowIso();
      contract.termination_reason = cleanText(contract.termination_reason || 'archived', 120) || 'archived';
      contract.updated_at = nowIso();
      state.contracts[id] = contract;
      changed = true;
    }
  }

  if (changed) {
    state = saveAgentContractsState(state);
  }

  const reconciled = [];
  const reconcileCandidates = activeRows
    .map((row) => {
      const id = cleanText(row && row.id ? row.id : '', 140);
      if (!id) return null;
      const contract = state.contracts && state.contracts[id] ? state.contracts[id] : null;
      const archived = isAgentArchived(id);
      if (!archived && (!contract || contract.status === 'active')) return null;
      return {
        id,
        archived,
        activated_at: cleanText(row && row.activated_at ? row.activated_at : '', 80),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (!!a.archived !== !!b.archived) return a.archived ? -1 : 1;
      return coerceTsMs(a.activated_at, 0) - coerceTsMs(b.activated_at, 0);
    })
    .slice(0, AGENT_RECONCILE_TERMINATION_BATCH);
  const canSweepTerminate =
    reconcileCandidates.length > 0 &&
    (nowMs - parseNonNegativeInt(agentTerminationSweepState.last_run_ms, 0, 1000000000000)) >=
      AGENT_RECONCILE_TERMINATION_COOLDOWN_MS;
  if (canSweepTerminate) {
    agentTerminationSweepState.last_run_ms = nowMs;
    for (const candidate of reconcileCandidates) {
      const lane = attemptLaneTermination(candidate.id, team);
      if (lane.ok && parseNonNegativeInt(lane.removed_count, 0, 100000000) > 0) {
        reconciled.push({
          agent_id: candidate.id,
          command: cleanText(lane.command || '', 80),
          removed_count: parseNonNegativeInt(lane.removed_count, 0, 100000000),
          released_task_count: parseNonNegativeInt(lane.released_task_count, 0, 100000000),
          archived: !!candidate.archived,
        });
        closeTerminalSession(candidate.id, 'agent_contract_reconcile');
      }
    }
  }

  const terminations = [];
  const currentContracts = Object.entries((loadAgentContractsState() || {}).contracts || {});
  for (const [agentId, contract] of currentContracts) {
    const id = cleanText(agentId || '', 140);
    if (!id || !contract || contract.status !== 'active') continue;
    const reason = contractTerminationDecision(contract, nowMs);
    if (!reason) continue;
    const roleRow = activeRows.find((row) => row && row.id === id);
    const terminated = terminateAgentForContract(id, snapshot, reason, {
      source: 'agent_contract_enforcer',
      terminated_by: 'agent_contract_enforcer',
      role: cleanText(roleRow && roleRow.role ? roleRow.role : '', 80),
      team,
    });
    if (terminated.terminated) {
      terminations.push(terminated);
    }
  }

  const latestState = loadAgentContractsState();
  const idleThreshold = parsePositiveInt(
    latestState && latestState.defaults ? latestState.defaults.max_idle_agents : AGENT_CONTRACT_MAX_IDLE_AGENTS,
    AGENT_CONTRACT_MAX_IDLE_AGENTS,
    1,
    1000
  );
  const idleCandidates = [];
  for (const [agentId, contract] of Object.entries((latestState && latestState.contracts) || {})) {
    const id = cleanText(agentId || '', 140);
    if (!id || !contract || contract.status !== 'active') continue;
    if (!activeIds.has(id)) continue;
    const sessionState = loadAgentSession(id, snapshot);
    const session = activeSession(sessionState);
    const updatedMs = coerceTsMs(session && session.updated_at ? session.updated_at : 0, 0);
    const idleForMs = updatedMs > 0 ? Math.max(0, nowMs - updatedMs) : Number.MAX_SAFE_INTEGER;
    if (idleForMs < AGENT_IDLE_TERMINATION_MS) continue;
    idleCandidates.push({
      id,
      idleForMs,
      role: cleanText(
        activeRowById.get(id) && activeRowById.get(id).role ? activeRowById.get(id).role : '',
        80
      ),
    });
  }
  idleCandidates.sort((a, b) => b.idleForMs - a.idleForMs);
  const idleExcess = Math.max(0, idleCandidates.length - idleThreshold);
  let idleTerminatedCount = 0;
  for (const candidate of idleCandidates.slice(0, idleExcess)) {
    const terminated = terminateAgentForContract(candidate.id, snapshot, 'idle_cap_exceeded', {
      source: 'agent_contract_idle_cap',
      terminated_by: 'idle_cap_enforcer',
      role: candidate.role,
      team,
    });
    if (terminated.terminated) {
      terminations.push(terminated);
      idleTerminatedCount += 1;
    }
  }

  const finalState = loadAgentContractsState();
  return {
    changed: changed || reconciled.length > 0 || terminations.length > 0,
    terminated: terminations,
    reconciled,
    idle_terminated_count: idleTerminatedCount,
    active_contracts: Object.values(finalState.contracts || {}).filter((row) => row && row.status === 'active').length,
  };
}

function lifecycleTelemetry(snapshot, enforcement = null) {
  const nowMs = Date.now();
  const contractsState = loadAgentContractsState();
  const activeAgents = compatAgentsFromSnapshot(snapshot, { includeArchived: false });
  const active = [];
  let idleCount = 0;
  for (const agent of activeAgents) {
    const id = cleanText(agent && agent.id ? agent.id : '', 140);
    if (!id) continue;
    const contract = contractForAgent(id);
    const summary = contractSummary(contract, nowMs);
    active.push({
      id,
      role: cleanText(agent && agent.role ? agent.role : '', 80),
      state: cleanText(agent && agent.state ? agent.state : 'running', 24) || 'running',
      contract: summary,
    });
    const state = loadAgentSession(id, snapshot);
    const session = activeSession(state);
    const updatedMs = coerceTsMs(session && session.updated_at ? session.updated_at : 0, 0);
    if (updatedMs > 0 && (nowMs - updatedMs) >= AGENT_ROGUE_SPIKE_WINDOW_MS) idleCount += 1;
  }
  const idleThreshold = parsePositiveInt(
    contractsState && contractsState.defaults ? contractsState.defaults.max_idle_agents : AGENT_CONTRACT_MAX_IDLE_AGENTS,
    AGENT_CONTRACT_MAX_IDLE_AGENTS,
    1,
    1000
  );
  const terminatedHistory = Array.isArray(contractsState && contractsState.terminated_history)
    ? contractsState.terminated_history.slice(-20).reverse()
    : [];
  return {
    defaults: {
      default_expiry_seconds: parsePositiveInt(
        contractsState && contractsState.defaults ? contractsState.defaults.default_expiry_seconds : AGENT_CONTRACT_DEFAULT_EXPIRY_SECONDS,
        AGENT_CONTRACT_DEFAULT_EXPIRY_SECONDS,
        1,
        7 * 24 * 60 * 60
      ),
      auto_expire_on_complete:
        !(contractsState && contractsState.defaults) || contractsState.defaults.auto_expire_on_complete !== false,
      max_idle_agents: idleThreshold,
    },
    active_agents: active,
    active_count: active.length,
    terminated_recent: terminatedHistory,
    terminated_recent_count: terminatedHistory.length,
    idle_agents: idleCount,
    idle_threshold: idleThreshold,
    idle_alert: idleCount > idleThreshold,
    last_enforcement: {
      changed: !!(enforcement && enforcement.changed),
      terminated_count: Array.isArray(enforcement && enforcement.terminated) ? enforcement.terminated.length : 0,
      ts: nowIso(),
    },
  };
}

let runtimeTrendSeries = [];
let memoryStreamBootstrapped = false;
let memoryStreamSeq = 0;
let memoryStreamIndex = new Map();
let memoryStreamHourIndex = new Map();
let memoryIngestCircuit = {
  paused: false,
  since: '',
  reason: '',
  trigger_queue_depth: 0,
  trigger_memory_entries: 0,
  transition_count: 0,
};
let healthCoverageState = {
  check_ids: [],
  ts: '',
};
let runtimePolicyState = {
  health_adaptive: false,
  health_window_seconds: RUNTIME_HEALTH_ADAPTIVE_WINDOW_SECONDS,
  auto_balance_threshold: RUNTIME_AUTO_BALANCE_THRESHOLD,
  last_health_refresh: '',
  last_throttle_apply: '',
};
let runtimeDrainState = {
  active_agents: [],
  last_spawn_at: '',
  last_dissolve_at: '',
};
let conduitWatchdogState = {
  low_signals_since_ms: 0,
  last_attempt_ms: 0,
  last_attempt_at: '',
  last_success_ms: 0,
  last_success_at: '',
  failure_count: 0,
};
let runtimeAutohealState = {
  last_run_ms: 0,
  last_run_at: '',
  last_result: 'idle',
  failure_count: 0,
  last_stage: 'idle',
  last_stall_detected: false,
  last_stall_signature: '',
};
let ingressControllerState = {
  level: 'normal',
  reject_non_critical: false,
  delay_ms: 0,
  reason: '',
  since: '',
};

function loadAttentionDeferredState() {
  const fallback = {
    version: 1,
    updated_at: '',
    events: [],
    dropped_count: 0,
    stash_count: 0,
    rehydrate_count: 0,
  };
  const raw = readJson(ATTENTION_DEFERRED_PATH, fallback);
  const events = Array.isArray(raw && raw.events) ? raw.events.slice(0, ATTENTION_DEFERRED_MAX_ITEMS) : [];
  return {
    version: 1,
    updated_at: cleanText(raw && raw.updated_at ? raw.updated_at : '', 80),
    events: events.map((row) => ({
      ts: cleanText(row && row.ts ? row.ts : nowIso(), 80) || nowIso(),
      severity: cleanText(row && row.severity ? row.severity : 'info', 20) || 'info',
      source: cleanText(row && row.source ? row.source : 'attention', 80) || 'attention',
      source_type: cleanText(row && row.source_type ? row.source_type : 'event', 80) || 'event',
      summary: cleanText(row && row.summary ? row.summary : '', 260),
      band: cleanText(row && row.band ? row.band : 'p4', 12) || 'p4',
      priority_lane: cleanText(row && row.priority_lane ? row.priority_lane : 'background', 24) || 'background',
      score: Number.isFinite(Number(row && row.score)) ? Number(row.score) : 0,
      attention_key: cleanText(row && row.attention_key ? row.attention_key : '', 120),
      initiative_action: cleanText(row && row.initiative_action ? row.initiative_action : '', 80),
      deferred_at: cleanText(row && row.deferred_at ? row.deferred_at : '', 80),
      deferred_reason: cleanText(row && row.deferred_reason ? row.deferred_reason : '', 80),
    })),
    dropped_count: parseNonNegativeInt(raw && raw.dropped_count, 0, 100000000),
    stash_count: parseNonNegativeInt(raw && raw.stash_count, 0, 100000000),
    rehydrate_count: parseNonNegativeInt(raw && raw.rehydrate_count, 0, 100000000),
  };
}

let attentionDeferredState = loadAttentionDeferredState();

function saveAttentionDeferredState(nextState) {
  const state = nextState && typeof nextState === 'object' ? nextState : attentionDeferredState;
  const sanitized = {
    version: 1,
    updated_at: cleanText(state && state.updated_at ? state.updated_at : nowIso(), 80) || nowIso(),
    events: Array.isArray(state && state.events) ? state.events.slice(0, ATTENTION_DEFERRED_MAX_ITEMS) : [],
    dropped_count: parseNonNegativeInt(state && state.dropped_count, 0, 100000000),
    stash_count: parseNonNegativeInt(state && state.stash_count, 0, 100000000),
    rehydrate_count: parseNonNegativeInt(state && state.rehydrate_count, 0, 100000000),
  };
  attentionDeferredState = sanitized;
  writeJson(ATTENTION_DEFERRED_PATH, sanitized);
  return sanitized;
}

function normalizeDeferredAttentionEvent(row, reason = 'deferred') {
  return {
    ts: cleanText(row && row.ts ? row.ts : nowIso(), 80) || nowIso(),
    severity: cleanText(row && row.severity ? row.severity : 'info', 20) || 'info',
    source: cleanText(row && row.source ? row.source : 'attention', 80) || 'attention',
    source_type: cleanText(row && row.source_type ? row.source_type : 'event', 80) || 'event',
    summary: cleanText(row && row.summary ? row.summary : '', 260),
    band: cleanText(row && row.band ? row.band : 'p4', 12) || 'p4',
    priority_lane: cleanText(row && row.priority_lane ? row.priority_lane : attentionEventLane(row), 24) || attentionEventLane(row),
    score: Number.isFinite(Number(row && row.score)) ? Number(row.score) : 0,
    attention_key: cleanText(row && row.attention_key ? row.attention_key : '', 120),
    initiative_action: cleanText(row && row.initiative_action ? row.initiative_action : '', 80),
    deferred_at: nowIso(),
    deferred_reason: cleanText(reason, 80) || 'deferred',
  };
}

function applyAttentionDeferredStorage(queueDepth = 0, split = {}) {
  const depth = parseNonNegativeInt(queueDepth, 0, 100000000);
  const critical = Array.isArray(split.critical) ? split.critical.slice() : [];
  let standard = Array.isArray(split.standard) ? split.standard.slice() : [];
  let background = Array.isArray(split.background) ? split.background.slice() : [];
  const shouldStash = depth >= ATTENTION_DEFERRED_STASH_DEPTH;
  const hardShed = depth >= ATTENTION_DEFERRED_HARD_SHED_DEPTH;
  const canRehydrate = depth <= ATTENTION_DEFERRED_REHYDRATE_DEPTH;
  let stashedCount = 0;
  let rehydratedCount = 0;
  let droppedCount = 0;

  if (shouldStash) {
    const stashSource = [...standard, ...background];
    standard = [];
    background = [];
    if (stashSource.length > 0) {
      const normalized = stashSource.map((row) =>
        normalizeDeferredAttentionEvent(row, hardShed ? 'hard_shed' : 'predictive_stash')
      );
      attentionDeferredState.events.push(...normalized);
      stashedCount = normalized.length;
      if (attentionDeferredState.events.length > ATTENTION_DEFERRED_MAX_ITEMS) {
        const overflow = attentionDeferredState.events.length - ATTENTION_DEFERRED_MAX_ITEMS;
        attentionDeferredState.events = attentionDeferredState.events.slice(overflow);
        droppedCount = overflow;
      }
      attentionDeferredState.stash_count =
        parseNonNegativeInt(attentionDeferredState.stash_count, 0, 100000000) + stashedCount;
      attentionDeferredState.dropped_count =
        parseNonNegativeInt(attentionDeferredState.dropped_count, 0, 100000000) + droppedCount;
      attentionDeferredState.updated_at = nowIso();
      saveAttentionDeferredState(attentionDeferredState);
    }
  } else if (canRehydrate && Array.isArray(attentionDeferredState.events) && attentionDeferredState.events.length > 0) {
    const take = Math.min(
      ATTENTION_DEFERRED_REHYDRATE_BATCH,
      parseNonNegativeInt(attentionDeferredState.events.length, 0, ATTENTION_DEFERRED_MAX_ITEMS)
    );
    if (take > 0) {
      const rehydrated = attentionDeferredState.events.splice(0, take).map((row) => ({
        ...row,
        deferred_reason: cleanText(row && row.deferred_reason ? row.deferred_reason : '', 80),
      }));
      rehydratedCount = rehydrated.length;
      background = [...background, ...rehydrated];
      attentionDeferredState.rehydrate_count =
        parseNonNegativeInt(attentionDeferredState.rehydrate_count, 0, 100000000) + rehydratedCount;
      attentionDeferredState.updated_at = nowIso();
      saveAttentionDeferredState(attentionDeferredState);
    }
  }

  return {
    critical,
    standard,
    background,
    telemetry: [...standard, ...background],
    stashed_count: stashedCount,
    rehydrated_count: rehydratedCount,
    dropped_count: droppedCount,
    deferred_depth: Array.isArray(attentionDeferredState.events) ? attentionDeferredState.events.length : 0,
    deferred_mode: hardShed ? 'hard_shed' : shouldStash ? 'stashed' : canRehydrate ? 'rehydrate' : 'pass_through',
    hard_shed: hardShed,
  };
}

function normalizeSeverity(value) {
  const severity = cleanText(value || '', 20).toLowerCase();
  if (severity === 'critical' || severity === 'error' || severity === 'fatal') return 'critical';
  if (severity === 'warn' || severity === 'warning' || severity === 'degraded') return 'warn';
  return 'info';
}

function attentionEventLane(event) {
  const severity = normalizeSeverity(event && event.severity ? event.severity : 'info');
  const band = cleanText(event && event.band ? event.band : '', 12).toLowerCase();
  const source = cleanText(event && event.source ? event.source : '', 120).toLowerCase();
  const sourceType = cleanText(event && event.source_type ? event.source_type : '', 120).toLowerCase();
  const summary = cleanText(event && event.summary ? event.summary : '', 400).toLowerCase();
  if (severity === 'critical') return 'critical';
  if (severity === 'warn') return 'critical';
  if (band === 'p1' || band === 'p0') return 'critical';
  if (
    /\b(fail|error|critical|degraded|alert|benchmark_sanity|backpressure|throttle|stale)\b/.test(summary)
  ) {
    return 'critical';
  }
  const backgroundBySource =
    /\b(receipt|audit|timeline|history|log|trace)\b/.test(sourceType) ||
    /\b(receipt|audit|timeline|history|log|trace)\b/.test(source);
  const backgroundByBand = severity === 'info' && (band === 'p3' || band === 'p4');
  if (backgroundBySource || backgroundByBand) return 'background';
  return 'standard';
}

function splitAttentionEvents(events = []) {
  const rows = Array.isArray(events) ? events : [];
  const critical = [];
  const standard = [];
  const background = [];
  for (const row of rows) {
    const lane = attentionEventLane(row);
    if (lane === 'critical') {
      critical.push(row);
    } else if (lane === 'background') {
      background.push(row);
    } else {
      standard.push(row);
    }
  }
  const telemetry = [...standard, ...background];
  return {
    critical,
    standard,
    background,
    telemetry,
    lane_weights: { ...ATTENTION_LANE_WEIGHTS },
    counts: {
      critical: critical.length,
      standard: standard.length,
      background: background.length,
      telemetry: telemetry.length,
      total: rows.length,
    },
  };
}

function attentionLanePolicy(queueDepth = 0, counts = {}) {
  const depth = parseNonNegativeInt(queueDepth, 0, 100000000);
  const critical = parseNonNegativeInt(counts && counts.critical, 0, 100000000);
  const background = parseNonNegativeInt(counts && counts.background, 0, 100000000);
  const backgroundDominant = background > Math.max(1, critical) * ATTENTION_BG_DOMINANCE_RATIO;
  const preemptCritical = depth >= ATTENTION_PREEMPT_QUEUE_DEPTH || backgroundDominant;
  const weights = preemptCritical
    ? { critical: 8, standard: 2, background: 1 }
    : { ...ATTENTION_LANE_WEIGHTS };
  return {
    weights,
    lane_caps: { ...ATTENTION_LANE_CAPS },
    preempt_critical: preemptCritical,
    background_dominant: backgroundDominant,
  };
}

function weightedFairAttentionOrder(
  laneRows = {},
  limit = ATTENTION_CRITICAL_LIMIT,
  laneWeights = ATTENTION_LANE_WEIGHTS
) {
  const weights = laneWeights && typeof laneWeights === 'object' ? laneWeights : ATTENTION_LANE_WEIGHTS;
  const buckets = {
    critical: Array.isArray(laneRows.critical) ? laneRows.critical.slice() : [],
    standard: Array.isArray(laneRows.standard) ? laneRows.standard.slice() : [],
    background: Array.isArray(laneRows.background) ? laneRows.background.slice() : [],
  };
  const ordered = [];
  const lanes = ['critical', 'standard', 'background'];
  while (ordered.length < limit) {
    let progressed = false;
    for (const lane of lanes) {
      const takeCount = parsePositiveInt(weights[lane], 1, 1, 20);
      for (let i = 0; i < takeCount; i += 1) {
        const next = buckets[lane].shift();
        if (!next) break;
        ordered.push(next);
        progressed = true;
        if (ordered.length >= limit) break;
      }
      if (ordered.length >= limit) break;
    }
    if (!progressed) break;
  }
  return ordered;
}

function microBatchAttentionTelemetry(events = [], options = {}) {
  const rows = Array.isArray(events) ? events : [];
  if (!rows.length) return [];
  const windowMs = parsePositiveInt(
    options && options.window_ms != null ? options.window_ms : ATTENTION_MICRO_BATCH_WINDOW_MS,
    ATTENTION_MICRO_BATCH_WINDOW_MS,
    1,
    10000
  );
  const maxItems = parsePositiveInt(
    options && options.max_items != null ? options.max_items : ATTENTION_MICRO_BATCH_MAX_ITEMS,
    ATTENTION_MICRO_BATCH_MAX_ITEMS,
    1,
    256
  );
  const sorted = rows
    .slice()
    .sort((a, b) => coerceTsMs(a && a.ts, 0) - coerceTsMs(b && b.ts, 0));
  const batches = [];
  let current = null;
  let batchSeq = 0;
  const flush = () => {
    if (!current) return;
    const laneCounts = { critical: 0, standard: 0, background: 0 };
    for (const row of current.items) {
      const lane = attentionEventLane(row);
      laneCounts[lane] = parseNonNegativeInt(laneCounts[lane], 0, 100000000) + 1;
    }
    batches.push({
      batch_id: `telemetry_batch_${batchSeq}`,
      start_ts: current.startTsIso,
      end_ts: current.endTsIso,
      item_count: current.items.length,
      lane_counts: laneCounts,
      sample_sources: current.samples.slice(0, 5),
    });
    current = null;
  };

  for (const row of sorted) {
    const tsMs = coerceTsMs(row && row.ts, Date.now());
    const tsIso = cleanText(row && row.ts ? row.ts : nowIso(), 80) || nowIso();
    const source = cleanText(row && row.source ? row.source : row && row.source_type ? row.source_type : 'event', 120);
    if (!current) {
      batchSeq += 1;
      current = {
        startMs: tsMs,
        startTsIso: tsIso,
        endTsIso: tsIso,
        items: [],
        samples: [],
      };
    }
    const withinWindow = tsMs - current.startMs <= windowMs;
    const belowLimit = current.items.length < maxItems;
    if (!withinWindow || !belowLimit) {
      flush();
      batchSeq += 1;
      current = {
        startMs: tsMs,
        startTsIso: tsIso,
        endTsIso: tsIso,
        items: [],
        samples: [],
      };
    }
    current.items.push(row);
    current.endTsIso = tsIso;
    if (source) current.samples.push(source);
  }
  flush();
  return batches.slice(0, 24);
}

function severityRank(value) {
  const severity = normalizeSeverity(value);
  if (severity === 'critical') return 3;
  if (severity === 'warn') return 2;
  return 1;
}

function priorityBandRank(value) {
  const band = cleanText(value || '', 12).toLowerCase();
  if (band === 'p0') return 4;
  if (band === 'p1') return 3;
  if (band === 'p2') return 2;
  if (band === 'p3') return 1;
  return 0;
}

function sortCriticalEvents(events = []) {
  const rows = Array.isArray(events) ? events.slice() : [];
  rows.sort((a, b) => {
    const sevDelta = severityRank(b && b.severity) - severityRank(a && a.severity);
    if (sevDelta !== 0) return sevDelta;
    const bandDelta = priorityBandRank(b && b.band) - priorityBandRank(a && a.band);
    if (bandDelta !== 0) return bandDelta;
    const scoreDelta =
      (Number.isFinite(Number(b && b.score)) ? Number(b.score) : 0) -
      (Number.isFinite(Number(a && a.score)) ? Number(a.score) : 0);
    if (scoreDelta !== 0) return scoreDelta;
    return coerceTsMs(b && b.ts, 0) - coerceTsMs(a && a.ts, 0);
  });
  return rows;
}

function memoryIngestControlState(queueDepth = 0, memoryEntryCount = 0) {
  const depth = parseNonNegativeInt(queueDepth, 0, 100000000);
  const entryCount = parseNonNegativeInt(memoryEntryCount, 0, 100000000);
  const entryPressure = entryCount >= MEMORY_ENTRY_BACKPRESSURE_THRESHOLD;
  if (!memoryIngestCircuit.paused && (depth >= DASHBOARD_QUEUE_DRAIN_PAUSE_DEPTH || entryPressure)) {
    memoryIngestCircuit = {
      paused: true,
      since: nowIso(),
      reason: entryPressure ? 'memory_entry_pressure' : 'predictive_queue_drain',
      trigger_queue_depth: depth,
      trigger_memory_entries: entryCount,
      transition_count: parseNonNegativeInt(memoryIngestCircuit.transition_count, 0, 1000000) + 1,
    };
  } else if (
    memoryIngestCircuit.paused &&
    depth <= DASHBOARD_QUEUE_DRAIN_RESUME_DEPTH &&
    entryCount < MEMORY_ENTRY_BACKPRESSURE_THRESHOLD
  ) {
    memoryIngestCircuit = {
      paused: false,
      since: nowIso(),
      reason: 'queue_recovered',
      trigger_queue_depth: depth,
      trigger_memory_entries: entryCount,
      transition_count: parseNonNegativeInt(memoryIngestCircuit.transition_count, 0, 1000000) + 1,
    };
  }
  return {
    paused: !!memoryIngestCircuit.paused,
    since: cleanText(memoryIngestCircuit.since || '', 80),
    reason: cleanText(memoryIngestCircuit.reason || '', 80),
    trigger_queue_depth: parseNonNegativeInt(memoryIngestCircuit.trigger_queue_depth, 0, 100000000),
    trigger_memory_entries: parseNonNegativeInt(memoryIngestCircuit.trigger_memory_entries, 0, 100000000),
    pause_threshold: DASHBOARD_QUEUE_DRAIN_PAUSE_DEPTH,
    memory_entry_threshold: MEMORY_ENTRY_BACKPRESSURE_THRESHOLD,
    resume_threshold: DASHBOARD_QUEUE_DRAIN_RESUME_DEPTH,
    transition_count: parseNonNegativeInt(memoryIngestCircuit.transition_count, 0, 1000000),
  };
}

function applyMemoryIngestCircuit(entries = [], control = {}) {
  const rows = Array.isArray(entries) ? entries : [];
  if (!control || !control.paused) {
    return { entries: rows, dropped_count: 0, mode: 'normal' };
  }
  const kept = [];
  for (const row of rows) {
    const rowPath = cleanText(row && row.path ? row.path : '', 260).toLowerCase();
    const kind = cleanText(row && row.kind ? row.kind : '', 60).toLowerCase();
    const nonCriticalReceiptOrLog =
      /\b(receipt|receipts|audit|history|log|logs|timeline)\b/.test(rowPath) ||
      kind === 'timeline';
    const critical =
      rowPath.includes('/local/workspace/memory/') ||
      rowPath.includes('attention_queue') ||
      rowPath.endsWith('/latest.json') ||
      kind === 'snapshot';
    if (nonCriticalReceiptOrLog && !critical) continue;
    if (critical) kept.push(row);
    if (kept.length >= MEMORY_ENTRY_TARGET_WHEN_PAUSED) break;
  }
  return {
    entries: kept,
    dropped_count: Math.max(0, rows.length - kept.length),
    mode: 'priority_shed',
  };
}

function healthCoverageSummary(healthPayload) {
  const checks =
    healthPayload && healthPayload.checks && typeof healthPayload.checks === 'object'
      ? Object.keys(healthPayload.checks).map((row) => cleanText(row, 120)).filter(Boolean).sort()
      : [];
  const previous = Array.isArray(healthCoverageState.check_ids)
    ? healthCoverageState.check_ids.slice()
    : [];
  const retired = previous.filter((row) => !checks.includes(row));
  const added = checks.filter((row) => !previous.includes(row));
  const status = retired.length > 0 ? 'gap' : 'stable';
  const coverage = {
    status,
    count: checks.length,
    previous_count: previous.length,
    added_checks: added.slice(0, 24),
    retired_checks: retired.slice(0, 24),
    gap_count: retired.length,
    changed: retired.length > 0 || added.length > 0,
    ts: nowIso(),
  };
  healthCoverageState = {
    check_ids: checks,
    ts: coverage.ts,
  };
  return coverage;
}

function recordRuntimeTrend(sample) {
  if (!sample || typeof sample !== 'object') return runtimeTrendSeries;
  runtimeTrendSeries.push(sample);
  if (runtimeTrendSeries.length > RUNTIME_TREND_WINDOW) {
    runtimeTrendSeries = runtimeTrendSeries.slice(-RUNTIME_TREND_WINDOW);
  }
  return runtimeTrendSeries;
}

function queueDepthVelocity(samples = []) {
  const rows = Array.isArray(samples) ? samples.slice(-6) : [];
  if (rows.length < 2) return 0;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const start = parseNonNegativeInt(first && first.queue_depth != null ? first.queue_depth : 0, 0, 100000000);
  const end = parseNonNegativeInt(last && last.queue_depth != null ? last.queue_depth : 0, 0, 100000000);
  const startTs = Date.parse(cleanText(first && first.ts ? first.ts : '', 80));
  const endTs = Date.parse(cleanText(last && last.ts ? last.ts : '', 80));
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
    return end - start;
  }
  const minutes = Math.max(0.01, (endTs - startTs) / 60000);
  return Number(((end - start) / minutes).toFixed(3));
}

function isFlatline(values = []) {
  if (!Array.isArray(values) || values.length < 2) return false;
  const normalized = values.map((row) => Number(row));
  if (normalized.some((row) => !Number.isFinite(row))) return false;
  const first = normalized[0];
  return normalized.every((row) => row === first);
}

function runtimeStallSignals(runtime, samples = []) {
  const rows = Array.isArray(samples) ? samples.slice(-RUNTIME_STALL_WINDOW) : [];
  if (rows.length < RUNTIME_STALL_WINDOW) {
    return {
      detected: false,
      queue_not_improving: false,
      conduit_flat_low: false,
      cockpit_flatline: false,
      stale_blocks_present: false,
      signature: 'insufficient_samples',
      window: rows.length,
    };
  }
  const queueValues = rows.map((row) => parseNonNegativeInt(row && row.queue_depth != null ? row.queue_depth : 0, 0, 100000000));
  const conduitValues = rows.map((row) => parseNonNegativeInt(row && row.conduit_signals != null ? row.conduit_signals : 0, 0, 100000000));
  const cockpitValues = rows.map((row) => parseNonNegativeInt(row && row.cockpit_blocks != null ? row.cockpit_blocks : 0, 0, 100000000));
  const staleValues = rows.map((row) =>
    parseNonNegativeInt(row && row.cockpit_stale_blocks != null ? row.cockpit_stale_blocks : 0, 0, 100000000)
  );
  const queueNow = parseNonNegativeInt(runtime && runtime.queue_depth, queueValues[queueValues.length - 1], 100000000);
  const signalFloor = Math.max(
    RUNTIME_STALL_CONDUIT_FLOOR,
    Math.floor(Math.max(1, parsePositiveInt(runtime && runtime.target_conduit_signals, RUNTIME_AUTO_BALANCE_THRESHOLD, 1, 128)) * 0.5)
  );
  const queueNotImproving =
    queueValues[queueValues.length - 1] >= queueValues[0] &&
    queueValues[queueValues.length - 1] >= RUNTIME_STALL_QUEUE_MIN_DEPTH;
  const conduitFlatLow =
    isFlatline(conduitValues) &&
    Math.max(...conduitValues) <= signalFloor &&
    queueNow >= RUNTIME_STALL_QUEUE_MIN_DEPTH;
  const cockpitFlatline = isFlatline(cockpitValues) && Math.max(...cockpitValues) > 0;
  const staleBlocksPresent = Math.max(...staleValues) > 0;
  const detected = (queueNotImproving && conduitFlatLow && cockpitFlatline) || staleBlocksPresent;
  return {
    detected,
    queue_not_improving: queueNotImproving,
    conduit_flat_low: conduitFlatLow,
    cockpit_flatline: cockpitFlatline,
    stale_blocks_present: staleBlocksPresent,
    signature: `q:${queueValues.join(',')}|c:${conduitValues.join(',')}|b:${cockpitValues.join(',')}|s:${staleValues.join(',')}`,
    window: rows.length,
    signal_floor: signalFloor,
  };
}

function runStallRecovery(runtime, team) {
  const normalizedTeam = cleanText(team || DEFAULT_TEAM, 40) || DEFAULT_TEAM;
  const queueDepth = parseNonNegativeInt(runtime && runtime.queue_depth, 0, 100000000);
  const drainLimit = Math.min(
    RUNTIME_ATTENTION_DRAIN_MAX_BATCH,
    Math.max(RUNTIME_STALL_DRAIN_LIMIT, Math.ceil(queueDepth / 2))
  );
  const drainLane = runLane([
    'attention-queue',
    'drain',
    `--consumer=${ATTENTION_CONSUMER_ID}`,
    `--limit=${drainLimit}`,
    '--wait-ms=0',
    '--run-context=runtime_stall_recovery',
  ]);
  const compactLane = runLane([
    'attention-queue',
    'compact',
    `--retain=${RUNTIME_ATTENTION_COMPACT_RETAIN}`,
    `--min-acked=${RUNTIME_ATTENTION_COMPACT_MIN_ACKED}`,
    '--run-context=runtime_stall_recovery',
  ]);
  const throttleLane = runLane([
    'collab-plane',
    'throttle',
    `--team=${normalizedTeam}`,
    `--plane=${RUNTIME_THROTTLE_PLANE}`,
    '--max-depth=50',
    `--strategy=${RUNTIME_THROTTLE_STRATEGY}`,
    '--strict=1',
  ]);
  const roleLane = runLane([
    'collab-plane',
    'launch-role',
    `--team=${normalizedTeam}`,
    '--role=builder',
    `--shadow=${normalizedTeam}-stall-heal`,
    '--strict=1',
  ]);
  const ok = !!(
    drainLane && drainLane.ok &&
    compactLane && compactLane.ok &&
    throttleLane && throttleLane.ok &&
    roleLane && roleLane.ok
  );
  return {
    ok,
    lanes: {
      drain: laneOutcome(drainLane),
      compact: laneOutcome(compactLane),
      throttle: laneOutcome(throttleLane),
      role: laneOutcome(roleLane),
    },
    drain_limit: drainLimit,
  };
}

function runtimeAutohealTelemetry() {
  return {
    last_run_at: cleanText(runtimeAutohealState.last_run_at || '', 80),
    last_result: cleanText(runtimeAutohealState.last_result || 'idle', 40) || 'idle',
    failure_count: parseNonNegativeInt(runtimeAutohealState.failure_count, 0, 100000000),
    last_stage: cleanText(runtimeAutohealState.last_stage || 'idle', 40) || 'idle',
    stall_detected: !!runtimeAutohealState.last_stall_detected,
    stall_signature: cleanText(runtimeAutohealState.last_stall_signature || '', 240),
    cadence_ms: {
      normal: RUNTIME_AUTONOMY_HEAL_INTERVAL_MS,
      emergency: RUNTIME_AUTONOMY_HEAL_EMERGENCY_INTERVAL_MS,
    },
    conduit_watchdog: {
      low_signals_since_ms: parseNonNegativeInt(conduitWatchdogState.low_signals_since_ms, 0, 1000000000000),
      last_attempt_at: cleanText(conduitWatchdogState.last_attempt_at || '', 80),
      last_success_at: cleanText(conduitWatchdogState.last_success_at || '', 80),
      failure_count: parseNonNegativeInt(conduitWatchdogState.failure_count, 0, 100000000),
      min_signal_floor: RUNTIME_CONDUIT_WATCHDOG_MIN_SIGNALS,
      stale_ms: RUNTIME_CONDUIT_WATCHDOG_STALE_MS,
      cooldown_ms: RUNTIME_CONDUIT_WATCHDOG_COOLDOWN_MS,
    },
  };
}

function benchmarkSanitySnapshot() {
  const gate = readJson(BENCHMARK_SANITY_GATE_PATH, null);
  const state = readJson(BENCHMARK_SANITY_STATE_PATH, null);
  let status = 'unknown';
  let source = 'benchmark_sanity_state';
  let detail = 'state_missing';
  let generatedAt = cleanText(state && state.generated_at ? state.generated_at : '', 80) || '';

  if (gate && typeof gate === 'object' && gate.type === 'benchmark_sanity_gate' && gate.summary) {
    const pass = gate.ok === true || (gate.summary && gate.summary.pass === true);
    status = pass ? 'pass' : 'fail';
    source = 'benchmark_sanity_gate';
    detail = pass
      ? `rows:${parsePositiveInt(gate.summary.measured_rows, 0, 0, 1000000)}`
      : `violations:${parsePositiveInt(gate.summary.violations, 0, 0, 1000000)}`;
  } else if (state && typeof state === 'object') {
    const projects = state.projects && typeof state.projects === 'object' ? Object.keys(state.projects).length : 0;
    if (projects > 0) {
      status = 'pass';
      detail = `projects:${projects}`;
    }
  }

  let ageSeconds = -1;
  if (generatedAt) {
    const parsed = Date.parse(generatedAt);
    if (Number.isFinite(parsed)) {
      ageSeconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
    }
  }
  const stale = ageSeconds < 0 || ageSeconds > DASHBOARD_BENCHMARK_STALE_SECONDS;
  if (status === 'pass' && stale) {
    status = 'warn';
    detail = detail ? `${detail};stale` : 'stale';
  }
  return {
    status,
    source,
    detail,
    generated_at: generatedAt || '',
    age_seconds: ageSeconds,
    stale,
  };
}

function mergeBenchmarkSanityHealth(healthPayload, benchmarkSanity) {
  const health = healthPayload && typeof healthPayload === 'object' ? { ...healthPayload } : {};
  const checks = health.checks && typeof health.checks === 'object' ? { ...health.checks } : {};
  checks.benchmark_sanity = {
    status: cleanText(benchmarkSanity && benchmarkSanity.status ? benchmarkSanity.status : 'unknown', 24) || 'unknown',
    source: cleanText(benchmarkSanity && benchmarkSanity.source ? benchmarkSanity.source : 'benchmark_sanity_state', 80) || 'benchmark_sanity_state',
    detail: cleanText(benchmarkSanity && benchmarkSanity.detail ? benchmarkSanity.detail : '', 220),
    generated_at: cleanText(benchmarkSanity && benchmarkSanity.generated_at ? benchmarkSanity.generated_at : '', 80),
    age_seconds: parsePositiveInt(benchmarkSanity && benchmarkSanity.age_seconds, -1, -1, 1000000000),
    stale: !!(benchmarkSanity && benchmarkSanity.stale),
  };
  health.checks = checks;

  const alerts = health.alerts && typeof health.alerts === 'object' ? { ...health.alerts } : {};
  const checksList = new Set(Array.isArray(alerts.checks) ? alerts.checks.map((row) => cleanText(row, 120)).filter(Boolean) : []);
  if (checks.benchmark_sanity.status !== 'pass') {
    checksList.add('metric:benchmark_sanity');
  } else {
    checksList.delete('metric:benchmark_sanity');
  }
  alerts.checks = Array.from(checksList);
  alerts.count = alerts.checks.length;
  health.alerts = alerts;
  return health;
}

function hourBucketKeyFromTs(value) {
  const parsed = coerceTsMs(value, 0);
  if (!parsed) return '';
  const iso = new Date(parsed).toISOString();
  return iso.slice(0, 13);
}

function memoryStreamState(entries = []) {
  const rows = Array.isArray(entries) ? entries : [];
  const nextIndex = new Map();
  const nextHourIndex = new Map();
  for (const row of rows) {
    const key = cleanText(row && row.path ? row.path : '', 260);
    if (!key) continue;
    const stamp = cleanText(row && row.mtime ? row.mtime : '', 80);
    nextIndex.set(key, stamp);
    const hourKey = hourBucketKeyFromTs(stamp);
    if (hourKey) {
      nextHourIndex.set(hourKey, parseNonNegativeInt(nextHourIndex.get(hourKey), 0, 100000000) + 1);
    }
  }
  if (!memoryStreamBootstrapped) {
    memoryStreamBootstrapped = true;
    memoryStreamIndex = nextIndex;
    memoryStreamHourIndex = nextHourIndex;
    return {
      enabled: true,
      initialized: true,
      changed: false,
      seq: 0,
      change_count: 0,
      bucket_change_count: 0,
      latest_paths: [],
      removed_paths: [],
      hour_buckets: Object.fromEntries(Array.from(nextHourIndex.entries()).slice(-24)),
      index_strategy: 'hour_bucket_time_series',
      source: 'memory_diff_stream',
    };
  }
  const latest = [];
  const removed = [];
  for (const [key, stamp] of nextIndex.entries()) {
    const prevStamp = memoryStreamIndex.get(key);
    if (!prevStamp || prevStamp !== stamp) {
      latest.push(key);
    }
  }
  for (const key of memoryStreamIndex.keys()) {
    if (!nextIndex.has(key)) removed.push(key);
  }
  let bucketChanges = 0;
  const allHourKeys = new Set([...memoryStreamHourIndex.keys(), ...nextHourIndex.keys()]);
  for (const hourKey of allHourKeys) {
    const prev = parseNonNegativeInt(memoryStreamHourIndex.get(hourKey), 0, 100000000);
    const next = parseNonNegativeInt(nextHourIndex.get(hourKey), 0, 100000000);
    if (prev !== next) bucketChanges += 1;
  }
  const changed = latest.length > 0 || removed.length > 0 || bucketChanges > 0;
  if (changed) {
    memoryStreamSeq += 1;
  }
  memoryStreamIndex = nextIndex;
  memoryStreamHourIndex = nextHourIndex;
  return {
    enabled: true,
    initialized: true,
    changed,
    seq: memoryStreamSeq,
    change_count: latest.length + removed.length,
    bucket_change_count: bucketChanges,
    latest_paths: latest.slice(0, 12),
    removed_paths: removed.slice(0, 12),
    hour_buckets: Object.fromEntries(Array.from(nextHourIndex.entries()).slice(-24)),
    index_strategy: 'hour_bucket_time_series',
    source: 'memory_diff_stream',
  };
}

function filterArchivedAgentsFromCollab(collab) {
  if (!collab || typeof collab !== 'object') return collab;
  const dashboard = collab.dashboard;
  if (!dashboard || !Array.isArray(dashboard.agents)) return collab;
  const archived = archivedAgentIdsSet();
  if (!archived.size) return collab;
  const filtered = dashboard.agents.filter((row, idx) => {
    const id = cleanText(row && row.shadow ? row.shadow : `agent-${idx + 1}`, 140);
    return id && !archived.has(id);
  });
  if (filtered.length === dashboard.agents.length) return collab;
  return {
    ...collab,
    dashboard: {
      ...dashboard,
      agents: filtered,
      agent_count: filtered.length,
    },
  };
}

function inactiveAgentRecord(agentId, snapshot, archivedMeta = null) {
  const cleanId = cleanText(agentId || '', 140) || 'agent';
  const modelState = effectiveAgentModel(cleanId, snapshot);
  const contract = contractForAgent(cleanId);
  const profile = agentProfileFor(cleanId);
  const identity = normalizeAgentIdentity(
    profile && profile.identity ? profile.identity : {},
    { emoji: '🤖', archetype: 'assistant', color: '#2563EB' }
  );
  const fallbackModels =
    profile && Array.isArray(profile.fallback_models) ? profile.fallback_models : [];
  return {
    id: cleanId,
    name: cleanText(profile && profile.name ? profile.name : cleanId, 100) || cleanId,
    state: 'inactive',
    status: 'archived',
    archived: true,
    archived_at:
      cleanText(archivedMeta && archivedMeta.archived_at ? archivedMeta.archived_at : '', 80) || '',
    archive_reason: cleanText(archivedMeta && archivedMeta.reason ? archivedMeta.reason : 'archived', 240) || 'archived',
    contract: contractSummary(contract),
    model_name: modelState.selected,
    model_provider: modelState.provider,
    runtime_model: modelState.runtime_model,
    context_window: modelState.context_window,
    role: cleanText(profile && profile.role ? profile.role : 'analyst', 60) || 'analyst',
    identity,
    system_prompt: cleanText(profile && profile.system_prompt ? profile.system_prompt : '', 4000),
    fallback_models: fallbackModels,
    capabilities: [],
  };
}

function safeAgentSessionFile(agentId) {
  const value = cleanText(agentId || 'agent', 140).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return value || 'agent';
}

function runtimeChatSessionId(agentId, activeSessionId) {
  const agentPart = safeAgentSessionFile(agentId || 'agent');
  const sessionPart = safeAgentSessionFile(activeSessionId || 'default');
  const combined = `${agentPart}__${sessionPart}`;
  return cleanText(combined, 120).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'chat-ui-default';
}

function agentSessionPath(agentId) {
  return path.resolve(AGENT_SESSIONS_DIR, `${safeAgentSessionFile(agentId)}.json`);
}

function parseTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function turnsToSessionMessages(turns = []) {
  const rows = [];
  for (const turn of turns) {
    const ts = parseTs(turn && turn.ts ? turn.ts : null);
    const user = turn && typeof turn.user === 'string' ? turn.user : '';
    const assistant = turn && typeof turn.assistant === 'string' ? turn.assistant : '';
    if (user.trim()) {
      rows.push({ role: 'User', content: user, ts });
    }
    if (assistant.trim()) {
      rows.push({ role: 'Agent', content: assistant, ts });
    }
  }
  return rows;
}

function normalizeSessionState(state, snapshot) {
  const seededMessages = turnsToSessionMessages(
    snapshot && snapshot.app && Array.isArray(snapshot.app.turns) ? snapshot.app.turns : []
  );
  const fallback = {
    active_session_id: 'default',
    model_override: 'auto',
    sessions: [
      {
        session_id: 'default',
        label: 'Default',
        created_at: nowIso(),
        updated_at: nowIso(),
        messages: seededMessages,
      },
    ],
  };
  const normalized = state && typeof state === 'object' ? state : fallback;
  normalized.model_override = modelOverrideFromState(normalized);
  if (!Array.isArray(normalized.sessions) || normalized.sessions.length === 0) {
    normalized.sessions = fallback.sessions;
  }
  normalized.sessions = normalized.sessions.map((session, idx) => {
    const sessionId =
      cleanText(session && session.session_id ? session.session_id : '', 80) || `session_${idx + 1}`;
    return {
      session_id: sessionId,
      label: cleanText(session && session.label ? session.label : 'Session', 80) || 'Session',
      created_at: session && session.created_at ? session.created_at : nowIso(),
      updated_at: session && session.updated_at ? session.updated_at : nowIso(),
      messages: Array.isArray(session && session.messages) ? session.messages : [],
    };
  });
  if (
    !normalized.active_session_id ||
    !normalized.sessions.some((session) => session.session_id === normalized.active_session_id)
  ) {
    normalized.active_session_id = normalized.sessions[0].session_id;
  }
  return normalized;
}

function loadAgentSession(agentId, snapshot) {
  const filePath = agentSessionPath(agentId);
  const state = readJson(filePath, null);
  const normalized = normalizeSessionState(state, snapshot);
  writeJson(filePath, normalized);
  return normalized;
}

function saveAgentSession(agentId, state) {
  writeJson(agentSessionPath(agentId), state);
}

function activeSession(state) {
  let session = state.sessions.find((row) => row.session_id === state.active_session_id);
  if (!session) {
    session = state.sessions[0];
    state.active_session_id = session ? session.session_id : 'default';
  }
  if (!session) {
    session = {
      session_id: 'default',
      label: 'Default',
      created_at: nowIso(),
      updated_at: nowIso(),
      messages: [],
    };
    state.sessions.push(session);
    state.active_session_id = session.session_id;
  }
  return session;
}

function appendAgentConversation(agentId, snapshot, userText, assistantText, metaText = '', assistantTools = []) {
  const state = loadAgentSession(agentId, snapshot);
  const session = activeSession(state);
  const nowMs = Date.now();
  if (userText && String(userText).trim()) {
    session.messages.push({ role: 'User', content: String(userText), ts: nowMs });
  }
  if (assistantText && String(assistantText).trim()) {
    const normalizedTools = Array.isArray(assistantTools)
      ? assistantTools
          .map((tool, idx) => ({
            id: cleanText(tool && tool.id ? tool.id : `tool-${idx + 1}`, 80) || `tool-${idx + 1}`,
            name: cleanText(tool && tool.name ? tool.name : 'cli', 80) || 'cli',
            input: cleanText(tool && tool.input ? tool.input : '', 400),
            result: cleanText(tool && tool.result ? tool.result : '', TOOL_OUTPUT_LIMIT),
            is_error: !!(tool && tool.is_error),
            running: false,
            expanded: false,
          }))
          .filter((tool) => tool.name)
      : [];
    session.messages.push({
      role: 'Agent',
      content: String(assistantText),
      meta: cleanText(metaText || '', 120),
      tools: normalizedTools,
      ts: nowMs,
    });
  }
  if (session.messages.length > 800) {
    session.messages = session.messages.slice(-800);
  }
  session.updated_at = nowIso();
  saveAgentSession(agentId, state);
  return state;
}

function queueAgentTask(agentId, snapshot, taskText, source = 'runtime_dashboard') {
  const id = cleanText(agentId || '', 140);
  const task = cleanText(taskText || '', 2000);
  if (!id || !task) {
    return {
      ok: false,
      agent_id: id,
      error: 'task_invalid',
    };
  }
  appendAgentConversation(
    id,
    snapshot,
    `[runtime-task] ${task}`,
    'Task accepted. Report findings in this thread with receipt-backed evidence.',
    `queued:${cleanText(source, 80)}`,
    []
  );
  return {
    ok: true,
    agent_id: id,
    task,
    queued_at: nowIso(),
  };
}

function compactAgentConversation(agentId, snapshot) {
  const state = loadAgentSession(agentId, snapshot);
  const session = activeSession(state);
  const keep = Math.min(200, session.messages.length);
  if (keep > 0) {
    session.messages = session.messages.slice(-keep);
  }
  session.updated_at = nowIso();
  saveAgentSession(agentId, state);
  return state;
}

function sessionList(state) {
  return state.sessions.map((session) => ({
    session_id: session.session_id,
    label: session.label || 'Session',
    message_count: Array.isArray(session.messages) ? session.messages.length : 0,
    updated_at: session.updated_at || nowIso(),
    active: session.session_id === state.active_session_id,
  }));
}

function runAgentMessage(agentId, input, snapshot, options = {}) {
  const allowFallback = !!(options && options.allowFallback);
  let requestedAgentId = cleanText(agentId || '', 140);
  const dashboardFallbackAgent = 'chat-ui-default-agent';
  const canAutoReviveDashboardFallback =
    allowFallback && (!requestedAgentId || requestedAgentId === dashboardFallbackAgent);
  if (requestedAgentId && isAgentArchived(requestedAgentId)) {
    if (canAutoReviveDashboardFallback) {
      unarchiveAgent(requestedAgentId);
      upsertAgentContract(
        requestedAgentId,
        {
          mission: `Assist with assigned mission for ${requestedAgentId}.`,
          owner: 'dashboard_chat',
          termination_condition: 'task_or_timeout',
        },
        { owner: 'dashboard_chat', force: true }
      );
    } else if (allowFallback) {
      requestedAgentId = '';
    } else {
      const archivedMeta = archivedAgentMeta(requestedAgentId);
      return {
        ok: false,
        status: 409,
        error: 'agent_inactive',
        id: requestedAgentId,
        archived: true,
        archived_at:
          cleanText(archivedMeta && archivedMeta.archived_at ? archivedMeta.archived_at : '', 80) || '',
      };
    }
  }
  if (requestedAgentId && isAgentArchived(requestedAgentId)) {
    const archivedMeta = archivedAgentMeta(requestedAgentId);
    return {
      ok: false,
      status: 409,
      error: 'agent_inactive',
      id: requestedAgentId,
      archived: true,
      archived_at:
        cleanText(archivedMeta && archivedMeta.archived_at ? archivedMeta.archived_at : '', 80) || '',
    };
  }
  const knownAgents = compatAgentsFromSnapshot(snapshot);
  let agent = knownAgents.find((row) => row.id === requestedAgentId);
  if (!agent && allowFallback) {
    const fallbackId = requestedAgentId || (knownAgents[0] && knownAgents[0].id) || 'chat-ui-default-agent';
    agent = knownAgents[0] || {
      id: fallbackId,
      name: fallbackId,
      state: 'running',
      status: 'active',
      role: 'operator',
      provider: configuredProvider(snapshot),
      model_name: configuredOllamaModel(snapshot),
      has_prompt_context: true,
    };
  }
  if (!agent) {
    return { ok: false, status: 404, error: 'agent_not_found', id: agentId };
  }
  const effectiveAgentId = cleanText(agent.id || requestedAgentId || 'chat-ui-default-agent', 140) || 'chat-ui-default-agent';
  const cleanInput = cleanText(input || '', 4000);
  if (!cleanInput) {
    return { ok: false, status: 400, error: 'message_required' };
  }
  let contract = contractForAgent(effectiveAgentId);
  if (!contract && !isAgentArchived(effectiveAgentId)) {
    contract = upsertAgentContract(
      effectiveAgentId,
      {
        mission: `Assist with assigned mission for ${effectiveAgentId}.`,
        owner: 'dashboard_chat',
        termination_condition: 'task_or_timeout',
      },
      { owner: 'dashboard_chat' }
    );
  }
  if (contract && contract.status === 'active') {
    const violation = detectContractViolation(effectiveAgentId, cleanInput, contract, snapshot);
    if (violation) {
      const terminated = terminateAgentForContract(
        effectiveAgentId,
        snapshot,
        `rogue_${cleanText(violation.reason || 'violation', 80)}`,
        {
          source: 'safety_plane',
          terminated_by: 'safety_plane',
          role: cleanText(agent && agent.role ? agent.role : '', 80),
          team:
            cleanText(
              snapshot && snapshot.metadata && snapshot.metadata.team ? snapshot.metadata.team : DEFAULT_TEAM,
              40
            ) || DEFAULT_TEAM,
        }
      );
      return {
        ok: false,
        status: 409,
        error: 'agent_contract_terminated',
        agent_id: effectiveAgentId,
        reason: cleanText(violation.reason || 'rogue_violation', 120),
        detail: cleanText(violation.detail || '', 240),
        terminated: !!terminated.terminated,
      };
    }
    recordContractMessageTick(effectiveAgentId);
  }

  const state = loadAgentSession(effectiveAgentId, snapshot);
  const session = activeSession(state);
  const chatSessionId = runtimeChatSessionId(effectiveAgentId, session.session_id);
  const modelState = effectiveAgentModel(effectiveAgentId, snapshot);
  const runtimeMirror = collectConduitAttentionCockpit(
    snapshot && snapshot.metadata && snapshot.metadata.team ? snapshot.metadata.team : DEFAULT_TEAM
  );
  const startedAtMs = Date.now();
  const llmResult = runLlmChatWithCli(
    agent,
    session,
    cleanInput,
    snapshot,
    modelState.runtime_model,
    runtimeMirror
  );

  let laneResult;
  let tools = [];
  let assistantRaw = '';
  let iterations = 1;
  let backend = 'ollama';
  let usedModel = modelState.runtime_model || OLLAMA_MODEL_FALLBACK;

  if (llmResult && llmResult.ok) {
    tools = Array.isArray(llmResult.tools) ? llmResult.tools : [];
    assistantRaw = String(llmResult.response || '');
    iterations = parsePositiveInt(llmResult.iterations || 1, 1, 1, 8);
    usedModel = cleanText(llmResult.model || usedModel || OLLAMA_MODEL_FALLBACK, 120) || OLLAMA_MODEL_FALLBACK;
    // Always emit a core-lane receipt so chat turns are visible to cockpit/conduit feeds.
    laneResult = runAction('app.chat', {
      input: cleanInput,
      session_id: chatSessionId,
    });
    if (!laneResult || typeof laneResult !== 'object') {
      laneResult = {
        ok: false,
        status: 1,
        stdout: '',
        stderr: 'lane_result_missing',
        argv: ['app-plane', 'run', '--app=chat-ui'],
        payload: null,
      };
    }
  } else {
    backend = 'app-plane';
    laneResult = runLane([
      'app-plane',
      'run',
      '--app=chat-ui',
      `--session-id=${chatSessionId}`,
      `--input=${cleanInput}`,
    ]);
    const payloadObj = laneResult && laneResult.payload && typeof laneResult.payload === 'object'
      ? laneResult.payload
      : null;
    const assistantFromLane =
      payloadObj &&
      typeof payloadObj.response === 'string'
        ? payloadObj.response
        : payloadObj &&
          payloadObj.turn &&
          typeof payloadObj.turn.assistant === 'string'
          ? payloadObj.turn.assistant
          : '';
    assistantRaw = String(assistantFromLane || '');
    if (!assistantRaw) {
      const failures = [];
      if (llmResult && llmResult.error) {
        failures.push(`ollama: ${cleanText(llmResult.error, 180)}`);
      }
      if (laneResult && !laneResult.ok) {
        const laneDetail = cleanText(
          String(laneResult.stderr || laneResult.stdout || laneResult.status || 'failed'),
          180
        );
        failures.push(`app-plane: ${laneDetail}`);
      }
      assistantRaw =
        failures.length > 0
          ? `I couldn't reach a chat model backend (${failures.join('; ')}). Start Ollama or configure app-plane and try again.`
          : 'I could not produce a response from the chat backend. Please try again.';
      laneResult = {
        ok: true,
        status: 0,
        stdout: '',
        stderr: '',
        argv: ['chat-backend', 'fallback-message'],
        payload: {
          ok: true,
          type: 'infring_dashboard_chat_backend_unavailable',
          response: assistantRaw,
          session_id: chatSessionId,
        },
      };
    }
  }

  let assistant = String(assistantRaw || '').trim()
    ? String(assistantRaw || '').slice(0, 4000)
    : ASSISTANT_EMPTY_FALLBACK_RESPONSE;
  const telemetryPrompt = /runtime sync|queue depth|cockpit|attention queue|conduit/i.test(cleanInput);
  if (telemetryPrompt && !/conduit/i.test(assistant)) {
    assistant = `${assistant}\n\nConduit signals: ${parseNonNegativeInt(runtimeMirror.summary.conduit_signals, 0, 1000000)}.`.slice(0, 4000);
  }
  const inputTokens = Math.max(1, Math.round(String(cleanInput).length / 4));
  const outputTokens = Math.max(1, Math.round(String(assistant || '').length / 4));
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  const contextWindow = parsePositiveInt(
    modelState && modelState.context_window != null ? modelState.context_window : DEFAULT_CONTEXT_WINDOW_TOKENS,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    1024,
    8000000
  );
  const contextStats = contextTelemetryForMessages(
    Array.isArray(session.messages) ? session.messages : [],
    contextWindow,
    inputTokens + outputTokens
  );
  const turnSeverity =
    !assistant
      ? 'warn'
      : laneResult && laneResult.ok && Array.isArray(tools) && !tools.some((tool) => tool && tool.is_error)
        ? 'info'
        : laneResult && laneResult.ok
          ? 'warn'
          : 'critical';
  const attentionKey = `chat-${sha256(`${effectiveAgentId}:${chatSessionId}:${Date.now()}`).slice(0, 24)}`;
  const attentionEnqueue = enqueueAttentionEvent(
    {
      ts: nowIso(),
      source: 'dashboard_chat',
      source_type: 'chat_turn',
      severity: turnSeverity,
      summary: cleanText(assistant || cleanInput, 240),
      attention_key: attentionKey,
      session_id: chatSessionId,
      agent_id: cleanText(effectiveAgentId, 120),
      lane_ok: !!(laneResult && laneResult.ok),
      tool_count: Array.isArray(tools) ? tools.length : 0,
      tool_errors: Array.isArray(tools) ? tools.filter((tool) => !!(tool && tool.is_error)).length : 0,
    },
    'dashboard_chat'
  );
  const durationLabel = durationMs < 1000
    ? `${Math.round(durationMs)}ms`
    : `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`;
  const laneConduit =
    !!(
      laneResult &&
      laneResult.payload &&
      typeof laneResult.payload === 'object' &&
      (laneResult.payload.conduit_enforcement || laneResult.payload.routed_via === 'conduit')
    );
  const laneState = laneResult && laneResult.ok ? 'ok' : 'degraded';
  const meta = `${inputTokens} in / ${outputTokens} out | ${durationLabel} | lane:${laneState}${laneConduit ? ' conduit' : ''} | queue:${runtimeMirror.summary.queue_depth} | ctx:${Math.round((contextStats.context_ratio || 0) * 100)}%`;
  const responseOk = !!String(assistant || '').trim();
  let contractTermination = null;
  contract = contractForAgent(effectiveAgentId);
  if (contract && contract.status === 'active' && missionCompleteSignal(assistant)) {
    markContractCompletion(effectiveAgentId, 'agent_self_signal');
    contract = contractForAgent(effectiveAgentId);
  }
  const terminationReason = contractTerminationDecision(contract);
  if (terminationReason) {
    contractTermination = terminateAgentForContract(effectiveAgentId, snapshot, terminationReason, {
      source: 'agent_contract_turn',
      terminated_by: terminationReason === 'task_complete' ? 'agent_completion_signal' : 'agent_contract_enforcer',
      role: cleanText(agent && agent.role ? agent.role : '', 80),
      team:
        cleanText(
          snapshot && snapshot.metadata && snapshot.metadata.team ? snapshot.metadata.team : DEFAULT_TEAM,
          40
        ) || DEFAULT_TEAM,
    });
  }

  return {
    ok: responseOk,
    status: responseOk ? 200 : 400,
    agent_id: effectiveAgentId,
    input: cleanInput,
    laneResult,
    lane_ok: !!(laneResult && laneResult.ok),
    agent,
    session_id: chatSessionId,
    response: assistant,
    tools,
    iterations,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    context_tokens: contextStats.context_tokens,
    context_window: contextStats.context_window,
    context_ratio: contextStats.context_ratio,
    context_pressure: contextStats.context_pressure,
    cost_usd: 0,
    meta,
    duration_ms: durationMs,
    model: usedModel,
    backend,
    contract: contractSummary(contractForAgent(effectiveAgentId)),
    contract_terminated: !!(contractTermination && contractTermination.terminated),
    contract_termination_reason:
      contractTermination && contractTermination.reason ? cleanText(contractTermination.reason, 120) : '',
    runtime_sync: {
      ok: runtimeMirror.ok,
      cockpit_ok: runtimeMirror.cockpit_ok,
      attention_status_ok: runtimeMirror.attention_status_ok,
      attention_next_ok: runtimeMirror.attention_next_ok,
      attention_enqueue_ok: !!(attentionEnqueue && attentionEnqueue.ok),
      queue_depth: runtimeMirror.summary.queue_depth,
      cockpit_blocks: runtimeMirror.summary.cockpit_blocks,
      cockpit_total_blocks: parseNonNegativeInt(runtimeMirror.summary.cockpit_total_blocks, runtimeMirror.summary.cockpit_blocks, 100000000),
      attention_batch_count: runtimeMirror.summary.attention_batch_count,
      conduit_signals: runtimeMirror.summary.conduit_signals,
      conduit_signals_raw: parseNonNegativeInt(runtimeMirror.summary.conduit_signals_raw, runtimeMirror.summary.conduit_signals, 100000000),
      conduit_channels_observed: runtimeMirror.summary.conduit_channels_observed,
      target_conduit_signals: runtimeMirror.summary.target_conduit_signals,
      conduit_scale_required: !!runtimeMirror.summary.conduit_scale_required,
      critical_attention: runtimeMirror.summary.attention_critical,
      critical_attention_total: runtimeMirror.summary.attention_critical_total,
      telemetry_attention: runtimeMirror.summary.attention_telemetry,
      sync_mode: runtimeMirror.summary.sync_mode,
      backpressure_level: runtimeMirror.summary.backpressure_level,
      benchmark_sanity_status: runtimeMirror.summary.benchmark_sanity_status || 'unknown',
      benchmark_sanity_source: runtimeMirror.summary.benchmark_sanity_source || 'benchmark_sanity_state',
      benchmark_sanity_cockpit_status: runtimeMirror.summary.benchmark_sanity_cockpit_status || 'unknown',
      benchmark_sanity_age_seconds: parsePositiveInt(runtimeMirror.summary.benchmark_sanity_age_seconds, -1, -1, 1000000000),
      health_coverage_gap_count: parseNonNegativeInt(
        snapshot && snapshot.health && snapshot.health.coverage && snapshot.health.coverage.gap_count != null
          ? snapshot.health.coverage.gap_count
          : 0,
        0,
        100000000
      ),
      memory_ingest_paused: !!(
        snapshot &&
        snapshot.memory &&
        snapshot.memory.ingest_control &&
        snapshot.memory.ingest_control.paused
      ),
      cockpit: runtimeMirror.cockpit,
      attention_queue: runtimeMirror.attention_queue,
    },
  };
}

function recentFiles(rootDir, { limit = 25, maxDepth = 4, include }) {
  const out = [];
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          stack.push({ dir: fullPath, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (typeof include === 'function' && !include(fullPath)) continue;
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        stat = null;
      }
      if (!stat) continue;
      out.push({
        path: path.relative(ROOT, fullPath),
        full_path: fullPath,
        mtime_ms: stat.mtimeMs || 0,
        mtime: stat.mtime.toISOString(),
        size_bytes: stat.size,
      });
    }
  }

  out.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return out.slice(0, limit);
}

function readTailLines(filePath, maxBytes = 48 * 1024, maxLines = 8) {
  let data = '';
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const size = stat.size - start;
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, start);
    fs.closeSync(fd);
    data = buffer.toString('utf8');
  } catch {
    return [];
  }
  return data
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxLines);
}

function collectLogEvents() {
  const logRoots = [
    path.resolve(ROOT, 'core/local/state/ops'),
    path.resolve(ROOT, 'client/runtime/local/state'),
  ];
  const rows = [];
  for (const rootDir of logRoots) {
    const files = recentFiles(rootDir, {
      limit: 8,
      maxDepth: 4,
      include: (fullPath) => fullPath.endsWith('history.jsonl') || fullPath.endsWith('.jsonl'),
    });
    for (const file of files) {
      const lines = readTailLines(file.full_path);
      for (const line of lines) {
        const payload = parseJsonLoose(line);
        rows.push({
          ts: payload && payload.ts ? payload.ts : file.mtime,
          source: file.path,
          message: payload && payload.type ? payload.type : line.slice(0, 220),
        });
      }
    }
  }
  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return rows.slice(0, 40);
}

function collectReceipts() {
  const roots = [
    path.resolve(ROOT, 'core/local/state/ops'),
    path.resolve(ROOT, 'client/runtime/local/state'),
  ];
  const files = [];
  for (const rootDir of roots) {
    files.push(
      ...recentFiles(rootDir, {
        limit: 30,
        maxDepth: 4,
        include: (fullPath) =>
          fullPath.endsWith('latest.json') ||
          fullPath.endsWith('history.jsonl') ||
          fullPath.endsWith('.receipt.json'),
      })
    );
  }
  files.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return files.slice(0, 32).map((file) => ({
    kind: file.path.endsWith('.jsonl') ? 'timeline' : 'receipt',
    path: file.path,
    mtime: file.mtime,
    size_bytes: file.size_bytes,
  }));
}

function collectMemoryArtifacts() {
  const roots = [
    path.resolve(ROOT, 'client/runtime/local/state'),
    path.resolve(ROOT, 'core/local/state/ops'),
  ];
  const rows = [];
  for (const rootDir of roots) {
    rows.push(
      ...recentFiles(rootDir, {
        limit: 20,
        maxDepth: 3,
        include: (fullPath) =>
          fullPath.endsWith('latest.json') ||
          fullPath.endsWith('.jsonl') ||
          fullPath.endsWith('queue.json'),
      }).map((row) => ({
        scope: row.path.includes('memory') ? 'memory' : 'state',
        kind: row.path.endsWith('.jsonl') ? 'timeline' : 'snapshot',
        path: row.path,
        mtime: row.mtime,
      }))
    );
  }
  rows.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return rows.slice(0, 30);
}

function compactCockpitBlocks(blocks = [], limit = COCKPIT_MAX_BLOCKS) {
  const rows = Array.isArray(blocks) ? blocks : [];
  return rows.slice(0, limit).map((row) => ({
    index: parsePositiveInt(row && row.index != null ? row.index : 0, 0, 0, 100000),
    lane: cleanText(row && row.lane ? row.lane : 'unknown', 120) || 'unknown',
    event_type: cleanText(row && row.event_type ? row.event_type : 'unknown', 120) || 'unknown',
    tool_call_class: cleanText(row && row.tool_call_class ? row.tool_call_class : 'runtime', 40) || 'runtime',
    status: cleanText(row && row.status ? row.status : 'unknown', 24) || 'unknown',
    status_color: cleanText(row && row.status_color ? row.status_color : 'unknown', 24) || 'unknown',
    duration_ms: parsePositiveInt(row && row.duration_ms != null ? row.duration_ms : 0, 0, 0, 3600000),
    duration_source: cleanText(row && row.duration_source ? row.duration_source : '', 24),
    is_stale: !!(row && row.is_stale === true),
    stale_block_threshold_ms: parsePositiveInt(
      row && row.stale_block_threshold_ms != null ? row.stale_block_threshold_ms : RUNTIME_COCKPIT_STALE_BLOCK_MS,
      RUNTIME_COCKPIT_STALE_BLOCK_MS,
      1000,
      24 * 60 * 60 * 1000
    ),
    ts: cleanText(row && row.ts ? row.ts : '', 80),
    path: cleanText(row && row.path ? row.path : '', 220),
    conduit_enforced:
      !!(
        row &&
        ((row.conduit_enforced === true) ||
          (row.conduit_enforcement && typeof row.conduit_enforcement === 'object') ||
          cleanText(row && row.routed_via ? row.routed_via : '', 40).toLowerCase() === 'conduit')
      ),
  }));
}

function compactAttentionEvents(events = [], limit = ATTENTION_PEEK_LIMIT) {
  const rows = Array.isArray(events) ? events : [];
  return rows.slice(0, limit).map((row) => {
    const event = row && typeof row.event === 'object' ? row.event : {};
    const lane = attentionEventLane(event);
    return {
      cursor_index: parsePositiveInt(row && row.cursor_index != null ? row.cursor_index : 0, 0, 0, 100000000),
      cursor_token: cleanText(row && row.cursor_token ? row.cursor_token : '', 140),
      ts: cleanText(event && event.ts ? event.ts : '', 80),
      severity: cleanText(event && event.severity ? event.severity : 'info', 20) || 'info',
      source: cleanText(event && event.source ? event.source : 'unknown', 80) || 'unknown',
      source_type: cleanText(event && event.source_type ? event.source_type : 'event', 80) || 'event',
      summary: cleanText(event && event.summary ? event.summary : '', 260),
      band: cleanText(event && event.band ? event.band : 'p4', 12) || 'p4',
      priority_lane: lane,
      score: typeof event.score === 'number' && Number.isFinite(event.score) ? event.score : 0,
      attention_key: cleanText(event && event.attention_key ? event.attention_key : '', 120),
      initiative_action: cleanText(event && event.initiative_action ? event.initiative_action : '', 80),
    };
  });
}

function cockpitMetrics(blocks = []) {
  const rows = Array.isArray(blocks) ? blocks : [];
  const laneCounts = {};
  const statusCounts = {};
  const toolClassCounts = {};
  const durations = [];
  for (const row of rows) {
    const lane = cleanText(row && row.lane ? row.lane : 'unknown', 120) || 'unknown';
    const status = cleanText(row && row.status ? row.status : 'unknown', 24) || 'unknown';
    const toolClass = cleanText(row && row.tool_call_class ? row.tool_call_class : 'runtime', 40) || 'runtime';
    const duration = parsePositiveInt(row && row.duration_ms != null ? row.duration_ms : 0, 0, 0, 3600000);
    laneCounts[lane] = parsePositiveInt(laneCounts[lane], 0, 0, 1000000) + 1;
    statusCounts[status] = parsePositiveInt(statusCounts[status], 0, 0, 1000000) + 1;
    toolClassCounts[toolClass] = parsePositiveInt(toolClassCounts[toolClass], 0, 0, 1000000) + 1;
    durations.push(duration);
  }
  durations.sort((a, b) => a - b);
  const p95Index = durations.length > 0 ? Math.min(durations.length - 1, Math.floor(durations.length * 0.95)) : 0;
  const avgDuration = durations.length
    ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(2))
    : 0;
  const slowest = rows
    .slice()
    .sort(
      (a, b) =>
        parsePositiveInt(b && b.duration_ms != null ? b.duration_ms : 0, 0, 0, 3600000) -
        parsePositiveInt(a && a.duration_ms != null ? a.duration_ms : 0, 0, 0, 3600000)
    )
    .slice(0, 8)
    .map((row) => ({
      lane: cleanText(row && row.lane ? row.lane : 'unknown', 120) || 'unknown',
      event_type: cleanText(row && row.event_type ? row.event_type : 'unknown', 120) || 'unknown',
      status: cleanText(row && row.status ? row.status : 'unknown', 24) || 'unknown',
      duration_ms: parsePositiveInt(row && row.duration_ms != null ? row.duration_ms : 0, 0, 0, 3600000),
    }));
  return {
    lane_counts: laneCounts,
    status_counts: statusCounts,
    tool_class_counts: toolClassCounts,
    duration_ms: {
      avg: avgDuration,
      p95: durations.length ? durations[p95Index] : 0,
      max: durations.length ? durations[durations.length - 1] : 0,
    },
    slowest_blocks: slowest,
  };
}

function collectConduitAttentionCockpit(team = DEFAULT_TEAM) {
  const safeTeam = cleanText(team || DEFAULT_TEAM, 80) || DEFAULT_TEAM;
  const cockpitLane = runLane(['hermes-plane', 'cockpit', `--max-blocks=${COCKPIT_MAX_BLOCKS}`, '--strict=1']);
  const attentionStatusLane = runLane(['attention-queue', 'status']);
  const attentionNextLane = runLane([
    'attention-queue',
    'next',
    `--consumer=${ATTENTION_CONSUMER_ID}`,
    `--limit=${ATTENTION_CRITICAL_LIMIT}`,
    '--wait-ms=0',
    '--run-context=dashboard_mirror',
  ]);

  const cockpitPayload = cockpitLane.payload && typeof cockpitLane.payload === 'object' ? cockpitLane.payload : {};
  const attentionStatusPayload =
    attentionStatusLane.payload && typeof attentionStatusLane.payload === 'object' ? attentionStatusLane.payload : {};
  const attentionNextPayload =
    attentionNextLane.payload && typeof attentionNextLane.payload === 'object' ? attentionNextLane.payload : {};

  const blocksRaw =
    cockpitPayload &&
    cockpitPayload.cockpit &&
    cockpitPayload.cockpit.render &&
    Array.isArray(cockpitPayload.cockpit.render.stream_blocks)
      ? cockpitPayload.cockpit.render.stream_blocks
      : [];
  const cockpitMetricsRaw =
    cockpitPayload &&
    cockpitPayload.cockpit &&
    cockpitPayload.cockpit.metrics &&
    typeof cockpitPayload.cockpit.metrics === 'object'
      ? cockpitPayload.cockpit.metrics
      : {};
  const eventsRaw = Array.isArray(attentionNextPayload.events) ? attentionNextPayload.events : [];

  const blocks = compactCockpitBlocks(blocksRaw, COCKPIT_MAX_BLOCKS);
  const staleBlockThresholdMs = parsePositiveInt(
    cockpitMetricsRaw && cockpitMetricsRaw.stale_block_threshold_ms != null
      ? cockpitMetricsRaw.stale_block_threshold_ms
      : RUNTIME_COCKPIT_STALE_BLOCK_MS,
    RUNTIME_COCKPIT_STALE_BLOCK_MS,
    1000,
    24 * 60 * 60 * 1000
  );
  const staleCockpitBlocks = blocks.filter(
    (row) =>
      (row && row.is_stale === true) ||
      parseNonNegativeInt(row && row.duration_ms, 0, 3600000) >= staleBlockThresholdMs
  );
  const activeCockpitBlocks = blocks.filter((row) => !staleCockpitBlocks.includes(row));
  const activeCockpitBlockCount = parseNonNegativeInt(
    cockpitMetricsRaw && cockpitMetricsRaw.active_block_count != null
      ? cockpitMetricsRaw.active_block_count
      : activeCockpitBlocks.length,
    activeCockpitBlocks.length,
    100000000
  );
  const totalCockpitBlockCount = parseNonNegativeInt(
    cockpitMetricsRaw && cockpitMetricsRaw.total_block_count != null
      ? cockpitMetricsRaw.total_block_count
      : cockpitPayload &&
          cockpitPayload.cockpit &&
          cockpitPayload.cockpit.render &&
          cockpitPayload.cockpit.render.total_blocks != null
        ? cockpitPayload.cockpit.render.total_blocks
        : blocks.length,
    blocks.length,
    100000000
  );
  const eventsFull = compactAttentionEvents(eventsRaw, ATTENTION_CRITICAL_LIMIT);
  const eventSplitRaw = splitAttentionEvents(eventsFull);
  const queueDepth = parsePositiveInt(
    attentionStatusPayload && attentionStatusPayload.queue_depth != null
      ? attentionStatusPayload.queue_depth
      : attentionNextPayload && attentionNextPayload.queue_depth != null
        ? attentionNextPayload.queue_depth
        : 0,
    0,
    0,
    100000000
  );
  const deferred = applyAttentionDeferredStorage(queueDepth, eventSplitRaw);
  const eventSplit = {
    critical: deferred.critical,
    standard: deferred.standard,
    background: deferred.background,
    telemetry: deferred.telemetry,
    lane_weights: { ...ATTENTION_LANE_WEIGHTS },
    counts: {
      critical: deferred.critical.length,
      standard: deferred.standard.length,
      background: deferred.background.length,
      telemetry: deferred.telemetry.length,
      total:
        deferred.critical.length +
        deferred.standard.length +
        deferred.background.length +
        parseNonNegativeInt(deferred.deferred_depth, 0, 100000000),
    },
  };
  const lanePolicy = attentionLanePolicy(queueDepth, eventSplit.counts);
  const weightedEvents = weightedFairAttentionOrder(
    {
      critical: eventSplit.critical,
      standard: eventSplit.standard,
      background: eventSplit.background,
    },
    ATTENTION_CRITICAL_LIMIT,
    lanePolicy.weights
  );
  const events = weightedEvents.slice(0, ATTENTION_PEEK_LIMIT);
  const cockpitCritical = blocks
    .filter((row) => {
      const status = cleanText(row && row.status ? row.status : '', 24).toLowerCase();
      return status === 'fail' || status === 'error' || status === 'critical';
    })
    .slice(0, 6)
    .map((row) => ({
      cursor_index: 0,
      cursor_token: '',
      ts: cleanText(row && row.ts ? row.ts : nowIso(), 80) || nowIso(),
      severity: 'critical',
      source: 'cockpit_health',
      source_type: 'cockpit_block',
      summary: cleanText(
        `${cleanText(row && row.lane ? row.lane : 'unknown', 80)} ${cleanText(
          row && row.event_type ? row.event_type : 'unknown',
          80
        )} status=${cleanText(row && row.status ? row.status : 'unknown', 24)}`.trim(),
        260
      ),
      band: 'p1',
      priority_lane: 'critical',
      score: 1,
      attention_key: cleanText(
        `cockpit-${cleanText(row && row.lane ? row.lane : 'unknown', 80)}-${cleanText(row && row.event_type ? row.event_type : 'unknown', 80)}`,
        120
      ),
      initiative_action: 'triple_escalation',
    }));
  const criticalEventsFull = sortCriticalEvents([...cockpitCritical, ...eventSplit.critical]).slice(
    0,
    ATTENTION_CRITICAL_LIMIT
  );
  const criticalEventsMerged = criticalEventsFull.slice(0, ATTENTION_PEEK_LIMIT);
  const priorityCounts = {
    critical: criticalEventsFull.length,
    telemetry: eventSplit.telemetry.length,
    standard: eventSplit.standard.length,
    background: eventSplit.background.length,
    deferred: parseNonNegativeInt(deferred.deferred_depth, 0, 100000000),
    total:
      eventSplit.telemetry.length +
      eventSplit.standard.length +
      eventSplit.background.length +
      criticalEventsFull.length +
      parseNonNegativeInt(deferred.deferred_depth, 0, 100000000),
  };
  const laneCountsStatusRaw =
    attentionStatusPayload && attentionStatusPayload.lane_counts && typeof attentionStatusPayload.lane_counts === 'object'
      ? attentionStatusPayload.lane_counts
      : {};
  const laneCountsStatus = {
    critical: parseNonNegativeInt(laneCountsStatusRaw.critical, priorityCounts.critical, 100000000),
    standard: parseNonNegativeInt(laneCountsStatusRaw.standard, priorityCounts.standard, 100000000),
    background: parseNonNegativeInt(laneCountsStatusRaw.background, priorityCounts.background, 100000000),
  };
  const conduitSignalsActiveFromBlocks = activeCockpitBlocks.filter((block) => {
    const lane = String(block.lane || '').toLowerCase();
    const eventType = String(block.event_type || '').toLowerCase();
    return lane.includes('conduit') || eventType.includes('conduit') || !!block.conduit_enforced;
  }).length;
  const conduitSignals = parseNonNegativeInt(
    cockpitMetricsRaw && cockpitMetricsRaw.conduit_signals_active != null
      ? cockpitMetricsRaw.conduit_signals_active
      : conduitSignalsActiveFromBlocks,
    conduitSignalsActiveFromBlocks,
    100000000
  );
  const conduitSignalsTotal = parseNonNegativeInt(
    cockpitMetricsRaw && cockpitMetricsRaw.conduit_signals_total != null
      ? cockpitMetricsRaw.conduit_signals_total
      : blocks.filter((block) => !!block.conduit_enforced).length,
    blocks.filter((block) => !!block.conduit_enforced).length,
    100000000
  );
  const conduitChannelsObserved = parseNonNegativeInt(
    cockpitMetricsRaw && cockpitMetricsRaw.conduit_channels_observed != null
      ? cockpitMetricsRaw.conduit_channels_observed
      : conduitSignals,
    conduitSignals,
    100000000
  );
  const attentionContract =
    attentionStatusPayload &&
    attentionStatusPayload.attention_contract &&
    typeof attentionStatusPayload.attention_contract === 'object'
      ? attentionStatusPayload.attention_contract
      : attentionNextPayload &&
        attentionNextPayload.attention_contract &&
        typeof attentionNextPayload.attention_contract === 'object'
        ? attentionNextPayload.attention_contract
        : {};
  const maxQueueDepth = parsePositiveInt(
    attentionContract && attentionContract.max_queue_depth != null ? attentionContract.max_queue_depth : 2048,
    2048,
    1,
    100000000
  );
  const backpressureDropBelow =
    cleanText(
      attentionContract && attentionContract.backpressure_drop_below
        ? attentionContract.backpressure_drop_below
        : 'critical',
      24
    ).toLowerCase() || 'critical';
  const queueUtilization = maxQueueDepth > 0 ? Number((queueDepth / maxQueueDepth).toFixed(6)) : 0;
  const targetConduitSignals = recommendedConduitSignals(queueDepth, queueUtilization, activeCockpitBlockCount);
  const syncMode =
    queueDepth >= DASHBOARD_BACKPRESSURE_BATCH_DEPTH
      ? 'batch_sync'
      : queueDepth >= CONDUIT_DELTA_SYNC_DEPTH
      ? 'delta_sync'
      : 'live_sync';
  const microBatchConfig =
    syncMode === 'delta_sync'
      ? { window_ms: CONDUIT_DELTA_BATCH_WINDOW_MS, max_items: CONDUIT_DELTA_BATCH_MAX_ITEMS }
      : { window_ms: ATTENTION_MICRO_BATCH_WINDOW_MS, max_items: ATTENTION_MICRO_BATCH_MAX_ITEMS };
  const telemetryMicroBatches = microBatchAttentionTelemetry(eventSplit.telemetry, microBatchConfig);
  const pressureLevel =
    queueDepth >= maxQueueDepth || queueUtilization >= 0.9
      ? 'critical'
      : queueDepth >= DASHBOARD_BACKPRESSURE_BATCH_DEPTH || queueUtilization >= 0.75
      ? 'high'
      : queueDepth >= DASHBOARD_BACKPRESSURE_WARN_DEPTH || queueUtilization >= 0.6
      ? 'elevated'
      : 'normal';
  const conduitScaleRequired = conduitChannelsObserved < targetConduitSignals;
  const cockpitConduitRatio = Number((activeCockpitBlockCount / Math.max(1, conduitSignals)).toFixed(3));
  const cockpitRollups = cockpitMetrics(blocks);
  const benchmarkTruth = benchmarkSanitySnapshot();
  const benchmarkBlock = blocks.find((row) => cleanText(row && row.lane ? row.lane : '', 80) === 'benchmark_sanity');
  const benchmarkCockpitStatus =
    cleanText(benchmarkBlock && benchmarkBlock.status ? benchmarkBlock.status : 'unknown', 24) || 'unknown';
  const benchmarkMirrorStatus =
    cleanText(benchmarkTruth && benchmarkTruth.status ? benchmarkTruth.status : benchmarkCockpitStatus, 24) ||
    benchmarkCockpitStatus;
  const benchmarkMirrorAgeSeconds = parsePositiveInt(
    benchmarkTruth && benchmarkTruth.age_seconds != null ? benchmarkTruth.age_seconds : -1,
    -1,
    -1,
    1000000000
  );
  const trend = recordRuntimeTrend({
    ts: nowIso(),
    queue_depth: queueDepth,
    conduit_signals: conduitSignals,
    conduit_channels_observed: conduitChannelsObserved,
    cockpit_blocks: activeCockpitBlockCount,
    cockpit_total_blocks: blocks.length,
    cockpit_stale_blocks: staleCockpitBlocks.length,
    critical_attention: priorityCounts.critical,
    telemetry_attention: eventSplit.counts.telemetry,
    standard_attention: eventSplit.counts.standard,
    background_attention: eventSplit.counts.background,
    deferred_attention: parseNonNegativeInt(deferred.deferred_depth, 0, 100000000),
    sync_mode: syncMode,
    benchmark_sanity_status: benchmarkMirrorStatus,
    benchmark_sanity_cockpit_status: benchmarkCockpitStatus,
  });

  return {
    team: safeTeam,
    ok: !!(cockpitLane.ok && attentionStatusLane.ok && attentionNextLane.ok),
    cockpit_ok: !!cockpitLane.ok,
    attention_status_ok: !!attentionStatusLane.ok,
    attention_next_ok: !!attentionNextLane.ok,
    lanes: {
      cockpit: cockpitLane.argv.join(' '),
      attention_status: attentionStatusLane.argv.join(' '),
      attention_next: attentionNextLane.argv.join(' '),
    },
    cockpit: {
      blocks,
      block_count: activeCockpitBlockCount,
      active_block_count: activeCockpitBlockCount,
      total_block_count: totalCockpitBlockCount,
      metrics: {
        ...cockpitRollups,
        conduit_signals: conduitSignals,
        conduit_channels_observed: conduitChannelsObserved,
        conduit_signals_active: conduitSignals,
        conduit_signals_total: conduitSignalsTotal,
        benchmark_sanity_status: benchmarkCockpitStatus,
        active_block_count: activeCockpitBlockCount,
        total_block_count: totalCockpitBlockCount,
        stale_block_count: parseNonNegativeInt(
          cockpitMetricsRaw && cockpitMetricsRaw.stale_block_count != null
            ? cockpitMetricsRaw.stale_block_count
            : staleCockpitBlocks.length,
          staleCockpitBlocks.length,
          100000000
        ),
        stale_block_threshold_ms: staleBlockThresholdMs,
      },
      trend: trend.slice(-24),
      payload_type: cleanText(cockpitPayload && cockpitPayload.type ? cockpitPayload.type : '', 60),
      receipt_hash:
        cockpitPayload && typeof cockpitPayload.receipt_hash === 'string' ? cockpitPayload.receipt_hash : '',
    },
    attention_queue: {
      queue_depth: queueDepth,
      cursor_offset: parseNonNegativeInt(
        attentionNextPayload && attentionNextPayload.cursor_offset != null
          ? attentionNextPayload.cursor_offset
          : 0,
        0,
        100000000
      ),
      cursor_offset_after: parseNonNegativeInt(
        attentionNextPayload && attentionNextPayload.cursor_offset_after != null
          ? attentionNextPayload.cursor_offset_after
          : 0,
        0,
        100000000
      ),
      acked_batch: !!(attentionNextPayload && attentionNextPayload.acked === true),
      batch_count: parsePositiveInt(attentionNextPayload && attentionNextPayload.batch_count, 0, 0, ATTENTION_CRITICAL_LIMIT),
      events,
      critical_events: criticalEventsMerged,
      critical_events_full: criticalEventsFull,
      critical_visible_count: criticalEventsMerged.length,
      critical_total_count: criticalEventsFull.length,
      standard_events: eventSplit.standard.slice(0, ATTENTION_PEEK_LIMIT),
      background_events: eventSplit.background.slice(0, ATTENTION_PEEK_LIMIT),
      telemetry_events: eventSplit.telemetry.slice(0, ATTENTION_PEEK_LIMIT),
      telemetry_micro_batches: telemetryMicroBatches,
      deferred_events: parseNonNegativeInt(deferred.deferred_depth, 0, 100000000),
      deferred_stashed_count: parseNonNegativeInt(deferred.stashed_count, 0, 100000000),
      deferred_rehydrated_count: parseNonNegativeInt(deferred.rehydrated_count, 0, 100000000),
      deferred_dropped_count: parseNonNegativeInt(deferred.dropped_count, 0, 100000000),
      deferred_mode: cleanText(deferred.deferred_mode || 'pass_through', 24) || 'pass_through',
      lane_weights: { ...lanePolicy.weights },
      lane_caps: { ...lanePolicy.lane_caps },
      lane_counts: laneCountsStatus,
      priority_counts: priorityCounts,
      backpressure: {
        level: pressureLevel,
        sync_mode: syncMode,
        max_queue_depth: maxQueueDepth,
        queue_utilization: queueUtilization,
        drop_below: backpressureDropBelow,
        throttle_recommended: syncMode !== 'live_sync',
        recommended_poll_ms: syncMode === 'batch_sync' ? 5000 : syncMode === 'delta_sync' ? 1000 : 2000,
        predictive_pause_threshold: DASHBOARD_QUEUE_DRAIN_PAUSE_DEPTH,
        predictive_resume_threshold: DASHBOARD_QUEUE_DRAIN_RESUME_DEPTH,
        memory_entry_threshold: MEMORY_ENTRY_BACKPRESSURE_THRESHOLD,
        deferred_stash_threshold: ATTENTION_DEFERRED_STASH_DEPTH,
        deferred_hard_shed_threshold: ATTENTION_DEFERRED_HARD_SHED_DEPTH,
        deferred_rehydrate_threshold: ATTENTION_DEFERRED_REHYDRATE_DEPTH,
        deferred_rehydrate_batch: ATTENTION_DEFERRED_REHYDRATE_BATCH,
        conduit_signals: conduitSignals,
        conduit_signals_raw: conduitSignals,
        conduit_channels_observed: conduitChannelsObserved,
        conduit_channels_total: conduitSignalsTotal,
        target_conduit_signals: targetConduitSignals,
        scale_required: conduitScaleRequired,
        cockpit_to_conduit_ratio: cockpitConduitRatio,
        lane_weights: { ...lanePolicy.weights },
        lane_caps: { ...lanePolicy.lane_caps },
        priority_preempt: !!lanePolicy.preempt_critical,
        background_dominant: !!lanePolicy.background_dominant,
        micro_batch_window_ms: microBatchConfig.window_ms,
        micro_batch_max_items: microBatchConfig.max_items,
        ingress_dampen_depth: RUNTIME_INGRESS_DAMPEN_DEPTH,
        ingress_shed_depth: RUNTIME_INGRESS_SHED_DEPTH,
        ingress_circuit_depth: RUNTIME_INGRESS_CIRCUIT_DEPTH,
      },
      latest:
        attentionStatusPayload && attentionStatusPayload.latest && typeof attentionStatusPayload.latest === 'object'
          ? attentionStatusPayload.latest
          : {},
      status_type: cleanText(attentionStatusPayload && attentionStatusPayload.type ? attentionStatusPayload.type : '', 60),
      next_type: cleanText(attentionNextPayload && attentionNextPayload.type ? attentionNextPayload.type : '', 60),
      receipt_hashes: {
        status:
          attentionStatusPayload && typeof attentionStatusPayload.receipt_hash === 'string'
            ? attentionStatusPayload.receipt_hash
            : '',
        next:
          attentionNextPayload && typeof attentionNextPayload.receipt_hash === 'string'
            ? attentionNextPayload.receipt_hash
            : '',
      },
    },
    summary: {
      queue_depth: queueDepth,
      attention_cursor_offset: parseNonNegativeInt(
        attentionNextPayload && attentionNextPayload.cursor_offset != null
          ? attentionNextPayload.cursor_offset
          : 0,
        0,
        100000000
      ),
      attention_cursor_offset_after: parseNonNegativeInt(
        attentionNextPayload && attentionNextPayload.cursor_offset_after != null
          ? attentionNextPayload.cursor_offset_after
          : 0,
        0,
        100000000
      ),
      cockpit_blocks: activeCockpitBlockCount,
      cockpit_total_blocks: totalCockpitBlockCount,
      attention_batch_count: events.length,
      conduit_signals: conduitSignals,
      conduit_signals_raw: conduitSignals,
      conduit_channels_observed: conduitChannelsObserved,
      conduit_channels_total: conduitSignalsTotal,
      target_conduit_signals: targetConduitSignals,
      conduit_scale_required: conduitScaleRequired,
      cockpit_to_conduit_ratio: cockpitConduitRatio,
      cockpit_stale_blocks: parseNonNegativeInt(
        cockpitMetricsRaw && cockpitMetricsRaw.stale_block_count != null
          ? cockpitMetricsRaw.stale_block_count
          : staleCockpitBlocks.length,
        staleCockpitBlocks.length,
        100000000
      ),
      attention_critical: priorityCounts.critical,
      attention_critical_total: criticalEventsFull.length,
      attention_telemetry: priorityCounts.telemetry,
      attention_standard: priorityCounts.standard,
      attention_background: priorityCounts.background,
      attention_deferred: parseNonNegativeInt(deferred.deferred_depth, 0, 100000000),
      attention_deferred_mode: cleanText(deferred.deferred_mode || 'pass_through', 24) || 'pass_through',
      attention_stashed_count: parseNonNegativeInt(deferred.stashed_count, 0, 100000000),
      attention_rehydrated_count: parseNonNegativeInt(deferred.rehydrated_count, 0, 100000000),
      attention_dropped_count: parseNonNegativeInt(deferred.dropped_count, 0, 100000000),
      telemetry_micro_batch_count: telemetryMicroBatches.length,
      sync_mode: syncMode,
      backpressure_level: pressureLevel,
      benchmark_sanity_status: benchmarkMirrorStatus,
      benchmark_sanity_source:
        cleanText(benchmarkTruth && benchmarkTruth.source ? benchmarkTruth.source : 'benchmark_sanity_state', 80) ||
        'benchmark_sanity_state',
      benchmark_sanity_cockpit_status: benchmarkCockpitStatus,
      benchmark_sanity_age_seconds: benchmarkMirrorAgeSeconds,
    },
  };
}

function asMetricRows(healthPayload) {
  const metrics = healthPayload && healthPayload.dashboard_metrics && typeof healthPayload.dashboard_metrics === 'object'
    ? healthPayload.dashboard_metrics
    : {};
  return Object.entries(metrics).map(([name, value]) => {
    const row = value && typeof value === 'object' ? value : {};
    const target = row.target_max != null ? `<= ${row.target_max}` : row.target_min != null ? `>= ${row.target_min}` : 'n/a';
    return {
      name,
      status: row.status || 'unknown',
      value: row.value,
      target,
    };
  });
}

function buildSnapshot(opts = {}) {
  const team = cleanText(opts.team || DEFAULT_TEAM, 80) || DEFAULT_TEAM;
  const cliMode = normalizeCliMode(opts.cliMode || ACTIVE_CLI_MODE);
  const healthLane = runLane(['health-status', 'dashboard']);
  const appLane = runLane(['app-plane', 'history', '--app=chat-ui']);
  const collabLane = runLane(['collab-plane', 'dashboard', `--team=${team}`]);
  const skillsLane = runLane(['skills-plane', 'dashboard']);
  const runtimeMirror = collectConduitAttentionCockpit(team);
  const benchmarkSanity = benchmarkSanitySnapshot();

  const health = mergeBenchmarkSanityHealth(healthLane.payload || {}, benchmarkSanity);
  const healthCoverage = healthCoverageSummary(health);
  health.coverage = healthCoverage;
  if (healthCoverage.gap_count > 0) {
    const alerts = health.alerts && typeof health.alerts === 'object' ? { ...health.alerts } : {};
    const checksList = new Set(
      Array.isArray(alerts.checks) ? alerts.checks.map((row) => cleanText(row, 120)).filter(Boolean) : []
    );
    checksList.add('coverage:health_checks');
    alerts.checks = Array.from(checksList);
    alerts.count = alerts.checks.length;
    health.alerts = alerts;
  }
  const app = appLane.payload || {};
  const collab = filterArchivedAgentsFromCollab(collabLane.payload || {});
  const skills = skillsLane.payload || {};
  const memoryCollected = collectMemoryArtifacts();
  const ingestControl = memoryIngestControlState(runtimeMirror.summary.queue_depth, memoryCollected.length);
  const memoryIngestApplied = applyMemoryIngestCircuit(memoryCollected, ingestControl);
  const memoryEntries = memoryIngestApplied.entries;
  const memoryStream = memoryStreamState(memoryEntries);
  const benchmarkHealthy = benchmarkSanity.status === 'pass' || benchmarkSanity.status === 'warn';

  const snapshot = {
    ok: !!(healthLane.ok && appLane.ok && collabLane.ok && skillsLane.ok && runtimeMirror.ok && benchmarkHealthy),
    type: 'infring_dashboard_snapshot',
    ts: nowIso(),
    metadata: {
      root: ROOT,
      team,
      refresh_ms: opts.refreshMs || DEFAULT_REFRESH_MS,
      cli_mode: cliMode,
      authority: 'rust_core_lanes',
      lanes: {
        health: healthLane.argv.join(' '),
        app: appLane.argv.join(' '),
        collab: collabLane.argv.join(' '),
        skills: skillsLane.argv.join(' '),
        cockpit: runtimeMirror.lanes.cockpit,
        attention_status: runtimeMirror.lanes.attention_status,
        attention_next: runtimeMirror.lanes.attention_next,
      },
    },
    health,
    app,
    collab,
    skills,
    cockpit: runtimeMirror.cockpit,
    attention_queue: runtimeMirror.attention_queue,
    memory: {
      entries: memoryEntries,
      stream: memoryStream,
      ingest_control: {
        ...ingestControl,
        mode: memoryIngestApplied.mode,
        source_count: memoryCollected.length,
        delivered_count: memoryEntries.length,
        dropped_count: memoryIngestApplied.dropped_count,
      },
    },
    receipts: {
      recent: collectReceipts(),
      action_history_path: path.relative(ROOT, ACTION_HISTORY_PATH),
    },
    logs: {
      recent: collectLogEvents(),
    },
    apm: {
      metrics: asMetricRows(health),
      checks: health.checks || {},
      alerts: health.alerts || {},
    },
  };
  snapshot.agent_lifecycle = lifecycleTelemetry(
    snapshot,
    opts && opts.contract_enforcement ? opts.contract_enforcement : null
  );
  snapshot.runtime_recommendation = runtimeSwarmRecommendation(snapshot);
  snapshot.runtime_autoheal = runtimeAutohealTelemetry();
  const receiptHash = sha256(JSON.stringify(snapshot));
  return { ...snapshot, receipt_hash: receiptHash };
}

function coerceTsMs(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1000000000000 ? Math.round(value * 1000) : Math.round(value);
  }
  const text = String(value == null ? '' : value).trim();
  if (!text) return fallback;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric > 0 && numeric < 1000000000000 ? Math.round(numeric * 1000) : Math.round(numeric);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function estimateTokens(text) {
  return parseNonNegativeInt(Math.round(String(text == null ? '' : text).length / 4), 0, 1000000000);
}

function runtimeSyncSummary(snapshot) {
  const cockpitBlocks = Array.isArray(snapshot && snapshot.cockpit && snapshot.cockpit.blocks)
    ? snapshot.cockpit.blocks
    : [];
  const cockpitMetrics =
    snapshot && snapshot.cockpit && snapshot.cockpit.metrics && typeof snapshot.cockpit.metrics === 'object'
      ? snapshot.cockpit.metrics
      : {};
  const queueDepth = parseNonNegativeInt(
    snapshot && snapshot.attention_queue && snapshot.attention_queue.queue_depth != null
      ? snapshot.attention_queue.queue_depth
      : 0,
    0,
    100000000
  );
  const attentionCursorOffset = parseNonNegativeInt(
    snapshot && snapshot.attention_queue && snapshot.attention_queue.cursor_offset != null
      ? snapshot.attention_queue.cursor_offset
      : 0,
    0,
    100000000
  );
  const attentionCursorOffsetAfter = parseNonNegativeInt(
    snapshot && snapshot.attention_queue && snapshot.attention_queue.cursor_offset_after != null
      ? snapshot.attention_queue.cursor_offset_after
      : attentionCursorOffset,
    attentionCursorOffset,
    100000000
  );
  const conduitSignalsRawFromBlocks = cockpitBlocks.filter((row) => {
    const lane = String(row && row.lane ? row.lane : '').toLowerCase();
    const eventType = String(row && row.event_type ? row.event_type : '').toLowerCase();
    return lane.includes('conduit') || eventType.includes('conduit') || !!(row && row.conduit_enforced);
  }).length;
  const conduitSignalsRaw = parseNonNegativeInt(
    cockpitMetrics && cockpitMetrics.conduit_signals_raw != null
      ? cockpitMetrics.conduit_signals_raw
      : cockpitMetrics && cockpitMetrics.conduit_signals_active != null
        ? cockpitMetrics.conduit_signals_active
        : cockpitMetrics && cockpitMetrics.conduit_signals != null
          ? cockpitMetrics.conduit_signals
          : conduitSignalsRawFromBlocks,
    conduitSignalsRawFromBlocks,
    100000000
  );
  const conduitSignalsObserved = parseNonNegativeInt(
    cockpitMetrics && cockpitMetrics.conduit_channels_observed != null
      ? cockpitMetrics.conduit_channels_observed
      : conduitSignalsRaw,
    conduitSignalsRaw,
    100000000
  );
  const conduitSignals = parseNonNegativeInt(
    snapshot &&
      snapshot.attention_queue &&
      snapshot.attention_queue.backpressure &&
      snapshot.attention_queue.backpressure.conduit_signals != null
      ? snapshot.attention_queue.backpressure.conduit_signals
      : conduitSignalsRaw,
    conduitSignalsRaw,
    100000000
  );
  const attentionBatch = parseNonNegativeInt(
    snapshot && snapshot.attention_queue && snapshot.attention_queue.batch_count != null
      ? snapshot.attention_queue.batch_count
      : Array.isArray(snapshot && snapshot.attention_queue && snapshot.attention_queue.events)
        ? snapshot.attention_queue.events.length
        : 0,
    0,
    100000000
  );
  const criticalAttention = parseNonNegativeInt(
    snapshot &&
      snapshot.attention_queue &&
      snapshot.attention_queue.priority_counts &&
      snapshot.attention_queue.priority_counts.critical != null
      ? snapshot.attention_queue.priority_counts.critical
      : 0,
    0,
    100000000
  );
  const telemetryAttention = parseNonNegativeInt(
    snapshot &&
      snapshot.attention_queue &&
      snapshot.attention_queue.priority_counts &&
      snapshot.attention_queue.priority_counts.telemetry != null
      ? snapshot.attention_queue.priority_counts.telemetry
      : 0,
    0,
    100000000
  );
  const standardAttention = parseNonNegativeInt(
    snapshot &&
      snapshot.attention_queue &&
      snapshot.attention_queue.priority_counts &&
      snapshot.attention_queue.priority_counts.standard != null
      ? snapshot.attention_queue.priority_counts.standard
      : 0,
    0,
    100000000
  );
  const backgroundAttention = parseNonNegativeInt(
    snapshot &&
      snapshot.attention_queue &&
      snapshot.attention_queue.priority_counts &&
      snapshot.attention_queue.priority_counts.background != null
      ? snapshot.attention_queue.priority_counts.background
      : 0,
    0,
    100000000
  );
  const criticalAttentionTotal = parseNonNegativeInt(
    snapshot && snapshot.attention_queue && snapshot.attention_queue.critical_total_count != null
      ? snapshot.attention_queue.critical_total_count
      : criticalAttention,
    criticalAttention,
    100000000
  );
  const backpressure =
    snapshot && snapshot.attention_queue && snapshot.attention_queue.backpressure && typeof snapshot.attention_queue.backpressure === 'object'
      ? snapshot.attention_queue.backpressure
      : {};
  const conduitChannelsObserved = parseNonNegativeInt(
    cockpitMetrics && cockpitMetrics.conduit_channels_observed != null
      ? cockpitMetrics.conduit_channels_observed
      : conduitSignalsObserved,
    conduitSignalsObserved,
    0,
    100000000
  );
  const conduitChannelsTotal = parseNonNegativeInt(
    snapshot &&
      snapshot.attention_queue &&
      snapshot.attention_queue.backpressure &&
      snapshot.attention_queue.backpressure.conduit_channels_total != null
      ? snapshot.attention_queue.backpressure.conduit_channels_total
      : cockpitMetrics && cockpitMetrics.conduit_signals_total != null
        ? cockpitMetrics.conduit_signals_total
        : conduitChannelsObserved,
    conduitChannelsObserved,
    100000000
  );
  const targetConduitSignals = parsePositiveInt(
    backpressure && backpressure.target_conduit_signals != null
      ? backpressure.target_conduit_signals
      : recommendedConduitSignals(
          queueDepth,
          Number.isFinite(Number(backpressure && backpressure.queue_utilization))
            ? Number(backpressure.queue_utilization)
            : 0,
          cockpitBlocks.length
        ),
    4,
    1,
    128
  );
  const conduitScaleRequired =
    backpressure && backpressure.scale_required != null
      ? !!backpressure.scale_required
      : conduitChannelsObserved < targetConduitSignals;
  const benchmarkSanity =
    snapshot &&
    snapshot.health &&
    snapshot.health.checks &&
    typeof snapshot.health.checks === 'object' &&
    snapshot.health.checks.benchmark_sanity &&
    typeof snapshot.health.checks.benchmark_sanity === 'object'
      ? snapshot.health.checks.benchmark_sanity
      : {};
  const healthCoverage =
    snapshot &&
    snapshot.health &&
    snapshot.health.coverage &&
    typeof snapshot.health.coverage === 'object'
      ? snapshot.health.coverage
      : {};
  const memoryIngestControl =
    snapshot &&
    snapshot.memory &&
    snapshot.memory.ingest_control &&
    typeof snapshot.memory.ingest_control === 'object'
      ? snapshot.memory.ingest_control
      : {};
  const deferredAttention = parseNonNegativeInt(
    snapshot && snapshot.attention_queue && snapshot.attention_queue.deferred_events != null
      ? snapshot.attention_queue.deferred_events
      : 0,
    0,
    100000000
  );
  const deferredMode =
    cleanText(
      snapshot && snapshot.attention_queue && snapshot.attention_queue.deferred_mode
        ? snapshot.attention_queue.deferred_mode
        : 'pass_through',
      24
    ) || 'pass_through';
  const staleCockpitBlocks = parseNonNegativeInt(
    snapshot &&
      snapshot.cockpit &&
      snapshot.cockpit.metrics &&
      snapshot.cockpit.metrics.stale_block_count != null
      ? snapshot.cockpit.metrics.stale_block_count
      : 0,
    0,
    100000000
  );
  const ingressLevel =
    queueDepth >= RUNTIME_INGRESS_CIRCUIT_DEPTH
      ? 'circuit'
      : queueDepth >= RUNTIME_INGRESS_SHED_DEPTH
      ? 'shed'
      : queueDepth >= RUNTIME_INGRESS_DAMPEN_DEPTH
      ? 'dampen'
      : 'normal';
  return {
    queue_depth: queueDepth,
    attention_cursor_offset: attentionCursorOffset,
    attention_cursor_offset_after: attentionCursorOffsetAfter,
    attention_unacked_depth: Math.max(0, queueDepth - attentionCursorOffset),
    cockpit_blocks: parseNonNegativeInt(snapshot && snapshot.cockpit && snapshot.cockpit.block_count, cockpitBlocks.length, 100000000),
    cockpit_total_blocks: parseNonNegativeInt(
      snapshot && snapshot.cockpit && snapshot.cockpit.total_block_count != null
        ? snapshot.cockpit.total_block_count
        : cockpitBlocks.length,
      cockpitBlocks.length,
      100000000
    ),
    attention_batch_count: attentionBatch,
    conduit_signals: conduitSignals,
    conduit_signals_raw: conduitSignalsRaw,
    conduit_channels_observed: conduitChannelsObserved,
    conduit_channels_total: conduitChannelsTotal,
    target_conduit_signals: targetConduitSignals,
    conduit_scale_required: conduitScaleRequired,
    critical_attention: criticalAttention,
    critical_attention_total: criticalAttentionTotal,
    telemetry_attention: telemetryAttention,
    standard_attention: standardAttention,
    background_attention: backgroundAttention,
    deferred_attention: deferredAttention,
    deferred_mode: deferredMode,
    cockpit_stale_blocks: staleCockpitBlocks,
    ingress_level: ingressLevel,
    telemetry_micro_batch_count: parseNonNegativeInt(
      snapshot &&
        snapshot.attention_queue &&
        Array.isArray(snapshot.attention_queue.telemetry_micro_batches)
        ? snapshot.attention_queue.telemetry_micro_batches.length
        : 0,
      0,
      100000000
    ),
    sync_mode: cleanText(backpressure && backpressure.sync_mode ? backpressure.sync_mode : 'live_sync', 24) || 'live_sync',
    backpressure_level: cleanText(backpressure && backpressure.level ? backpressure.level : 'normal', 24) || 'normal',
    queue_lane_weights:
      backpressure && backpressure.lane_weights && typeof backpressure.lane_weights === 'object'
        ? backpressure.lane_weights
        : { ...ATTENTION_LANE_WEIGHTS },
    queue_lane_caps:
      backpressure && backpressure.lane_caps && typeof backpressure.lane_caps === 'object'
        ? backpressure.lane_caps
        : { ...ATTENTION_LANE_CAPS },
    benchmark_sanity_status:
      cleanText(benchmarkSanity && benchmarkSanity.status ? benchmarkSanity.status : 'unknown', 24) || 'unknown',
    benchmark_sanity_source:
      cleanText(benchmarkSanity && benchmarkSanity.source ? benchmarkSanity.source : 'benchmark_sanity_state', 80) ||
      'benchmark_sanity_state',
    benchmark_sanity_cockpit_status:
      cleanText(
        snapshot &&
          snapshot.cockpit &&
          snapshot.cockpit.metrics &&
          snapshot.cockpit.metrics.benchmark_sanity_status != null
          ? snapshot.cockpit.metrics.benchmark_sanity_status
          : 'unknown',
        24
      ) || 'unknown',
    benchmark_sanity_age_seconds: parsePositiveInt(
      benchmarkSanity && benchmarkSanity.age_seconds != null ? benchmarkSanity.age_seconds : -1,
      -1,
      -1,
      1000000000
    ),
    health_check_count: parseNonNegativeInt(
      snapshot && snapshot.health && snapshot.health.checks && typeof snapshot.health.checks === 'object'
        ? Object.keys(snapshot.health.checks).length
        : 0,
      0,
      100000000
    ),
    health_coverage_gap_count: parseNonNegativeInt(
      healthCoverage && healthCoverage.gap_count != null ? healthCoverage.gap_count : 0,
      0,
      100000000
    ),
    retired_health_checks:
      healthCoverage && Array.isArray(healthCoverage.retired_checks) ? healthCoverage.retired_checks.slice(0, 12) : [],
    memory_ingest_paused: !!(memoryIngestControl && memoryIngestControl.paused),
    cockpit_receipt_hash:
      snapshot && snapshot.cockpit && typeof snapshot.cockpit.receipt_hash === 'string'
        ? snapshot.cockpit.receipt_hash
        : '',
    attention_receipt_hashes:
      snapshot && snapshot.attention_queue && snapshot.attention_queue.receipt_hashes && typeof snapshot.attention_queue.receipt_hashes === 'object'
        ? snapshot.attention_queue.receipt_hashes
        : {},
  };
}

function usageFromSnapshot(snapshot) {
  const turns =
    snapshot &&
    snapshot.app &&
    Array.isArray(snapshot.app.turns)
      ? snapshot.app.turns
      : [];
  const byModel = new Map();
  const byDay = new Map();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;

  for (const turn of turns) {
    const provider = cleanText(
      turn && turn.provider ? turn.provider : configuredProvider(snapshot),
      80
    ) || 'openai';
    const model = cleanText(
      turn && turn.model ? turn.model : configuredOllamaModel(snapshot),
      120
    ) || configuredOllamaModel(snapshot);
    const inputTokens = parseNonNegativeInt(
      turn && turn.input_tokens != null ? turn.input_tokens : estimateTokens(turn && turn.user ? turn.user : ''),
      0,
      1000000000
    );
    const outputTokens = parseNonNegativeInt(
      turn && turn.output_tokens != null ? turn.output_tokens : estimateTokens(turn && turn.assistant ? turn.assistant : ''),
      0,
      1000000000
    );
    const cost = Number(turn && turn.cost_usd != null ? turn.cost_usd : 0);
    const safeCost = Number.isFinite(cost) ? Math.max(0, cost) : 0;
    const tsMs = coerceTsMs(turn && turn.ts ? turn.ts : Date.now(), Date.now());
    const dayKey = new Date(tsMs).toISOString().slice(0, 10);
    const modelKey = `${provider}/${model}`;

    totalInput += inputTokens;
    totalOutput += outputTokens;
    totalCost += safeCost;

    if (!byModel.has(modelKey)) {
      byModel.set(modelKey, {
        provider,
        model,
        turns: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
      });
    }
    const modelRow = byModel.get(modelKey);
    modelRow.turns += 1;
    modelRow.input_tokens += inputTokens;
    modelRow.output_tokens += outputTokens;
    modelRow.total_tokens += inputTokens + outputTokens;
    modelRow.cost_usd += safeCost;

    if (!byDay.has(dayKey)) {
      byDay.set(dayKey, {
        date: dayKey,
        turns: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
      });
    }
    const dayRow = byDay.get(dayKey);
    dayRow.turns += 1;
    dayRow.input_tokens += inputTokens;
    dayRow.output_tokens += outputTokens;
    dayRow.total_tokens += inputTokens + outputTokens;
    dayRow.cost_usd += safeCost;
  }

  const totalTokens = totalInput + totalOutput;
  const modelRows = Array.from(byModel.values()).sort((a, b) => b.total_tokens - a.total_tokens);
  const dayRows = Array.from(byDay.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const agents = compatAgentsFromSnapshot(snapshot);
  const usageAgents = (agents.length ? agents : [{ id: 'dashboard-cockpit', name: 'dashboard-cockpit' }]).map(
    (agent, idx) => ({
      agent_id: cleanText(agent && agent.id ? agent.id : `agent-${idx + 1}`, 120) || `agent-${idx + 1}`,
      name: cleanText(agent && agent.name ? agent.name : agent && agent.id ? agent.id : `agent-${idx + 1}`, 120) || `agent-${idx + 1}`,
      total_tokens: idx === 0 ? totalTokens : 0,
      input_tokens: idx === 0 ? totalInput : 0,
      output_tokens: idx === 0 ? totalOutput : 0,
      tool_calls: 0,
      cost_usd: idx === 0 ? totalCost : 0,
    })
  );

  return {
    summary: {
      total_tokens: totalTokens,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      total_cost_usd: totalCost,
      turn_count: turns.length,
      agent_count: usageAgents.length,
    },
    models: modelRows,
    daily: dayRows,
    agents: usageAgents,
  };
}

function providersFromSnapshot(snapshot) {
  const configured = cleanText(configuredProvider(snapshot), 80) || 'openai';
  const configuredModel = cleanText(
    snapshot && snapshot.app && snapshot.app.settings && snapshot.app.settings.model
      ? snapshot.app.settings.model
      : configuredOllamaModel(snapshot),
    120
  ) || configuredOllamaModel(snapshot);
  const defaults = ['openai', 'anthropic', 'google', 'groq', 'ollama'];
  if (!defaults.includes(configured)) defaults.unshift(configured);
  return defaults.map((provider) => {
    const isConfigured = provider === configured;
    return {
      id: provider,
      name: provider,
      display_name: provider.charAt(0).toUpperCase() + provider.slice(1),
      auth_status: isConfigured ? 'configured' : 'not_set',
      reachable: isConfigured,
      health: isConfigured ? 'ready' : 'not_set',
      is_local: provider === 'ollama',
      default_model: isConfigured ? configuredModel : '',
      base_url: provider === 'ollama' ? 'http://127.0.0.1:11434' : '',
    };
  });
}

function skillsFromSnapshot(snapshot) {
  const hotspots =
    snapshot &&
    snapshot.skills &&
    snapshot.skills.metrics &&
    Array.isArray(snapshot.skills.metrics.run_hotspots)
      ? snapshot.skills.metrics.run_hotspots
      : [];
  if (!hotspots.length) {
    return [];
  }
  return hotspots.map((row, idx) => ({
    name: cleanText(row && row.skill ? row.skill : `skill-${idx + 1}`, 120) || `skill-${idx + 1}`,
    description: 'Observed from skills-plane run history.',
    version: 'n/a',
    author: 'infring',
    runtime: 'typescript',
    tools_count: 0,
    tags: ['runtime-observed'],
    enabled: true,
    source: { type: 'bundled' },
    has_prompt_context: false,
  }));
}

function auditEntriesFromSnapshot(snapshot, limit = 200) {
  const rows = [];
  const cockpitBlocks = Array.isArray(snapshot && snapshot.cockpit && snapshot.cockpit.blocks)
    ? snapshot.cockpit.blocks
    : [];
  const attentionEvents = Array.isArray(snapshot && snapshot.attention_queue && snapshot.attention_queue.events)
    ? snapshot.attention_queue.events
    : [];
  const receipts = Array.isArray(snapshot && snapshot.receipts && snapshot.receipts.recent)
    ? snapshot.receipts.recent
    : [];
  const logs = Array.isArray(snapshot && snapshot.logs && snapshot.logs.recent)
    ? snapshot.logs.recent
    : [];
  const turns = Array.isArray(snapshot && snapshot.app && snapshot.app.turns)
    ? snapshot.app.turns
    : [];

  for (const block of cockpitBlocks.slice(0, 120)) {
    rows.push({
      timestamp: cleanText(block && block.ts ? block.ts : snapshot && snapshot.ts ? snapshot.ts : nowIso(), 80),
      action: cleanText(block && block.event_type ? block.event_type : 'CockpitEvent', 80) || 'CockpitEvent',
      detail: cleanText(
        `${cleanText(block && block.lane ? block.lane : 'unknown', 80)} ${cleanText(
          block && block.status ? block.status : 'unknown',
          20
        )} ${cleanText(block && block.path ? block.path : '', 160)}`.trim(),
        260
      ),
      agent_id: '',
      source: 'cockpit',
    });
  }
  for (const row of attentionEvents.slice(0, 120)) {
    rows.push({
      timestamp: cleanText(row && row.ts ? row.ts : snapshot && snapshot.ts ? snapshot.ts : nowIso(), 80),
      action: 'AttentionEvent',
      detail: cleanText(
        `${cleanText(row && row.source ? row.source : 'unknown', 80)} ${cleanText(
          row && row.severity ? row.severity : 'info',
          20
        )}: ${cleanText(row && row.summary ? row.summary : '', 160)}`.trim(),
        260
      ),
      agent_id: cleanText(row && row.agent_id ? row.agent_id : '', 120),
      source: 'attention_queue',
    });
  }
  for (const row of receipts.slice(0, 120)) {
    rows.push({
      timestamp: cleanText(row && row.mtime ? row.mtime : snapshot && snapshot.ts ? snapshot.ts : nowIso(), 80),
      action: 'ReceiptEvent',
      detail: cleanText(`${cleanText(row && row.kind ? row.kind : 'receipt', 40)} ${cleanText(row && row.path ? row.path : '', 200)}`, 260),
      agent_id: '',
      source: 'receipts',
    });
  }
  for (const row of logs.slice(0, 120)) {
    rows.push({
      timestamp: cleanText(row && row.ts ? row.ts : snapshot && snapshot.ts ? snapshot.ts : nowIso(), 80),
      action: 'LogEvent',
      detail: cleanText(`${cleanText(row && row.source ? row.source : 'log', 90)} ${cleanText(row && row.message ? row.message : '', 160)}`, 260),
      agent_id: '',
      source: 'logs',
    });
  }
  for (const turn of turns.slice(-120)) {
    rows.push({
      timestamp: cleanText(turn && turn.ts ? turn.ts : snapshot && snapshot.ts ? snapshot.ts : nowIso(), 80),
      action: 'AgentMessage',
      detail: cleanText(
        `${cleanText(turn && turn.provider ? turn.provider : configuredProvider(snapshot), 40)}/${cleanText(
          turn && turn.model ? turn.model : configuredOllamaModel(snapshot),
          80
        )}: ${cleanText(turn && turn.user ? turn.user : '', 140)}`,
        260
      ),
      agent_id: '',
      source: 'chat',
    });
  }

  rows.sort((a, b) => coerceTsMs(b.timestamp, 0) - coerceTsMs(a.timestamp, 0));
  const trimmed = rows.slice(0, Math.max(1, limit));
  let prev = 'genesis';
  const entries = trimmed.map((row, idx) => {
    const base = {
      seq: idx + 1,
      timestamp: row.timestamp,
      action: row.action,
      detail: row.detail,
      agent_id: row.agent_id,
      source: row.source,
    };
    const hash = sha256(`${prev}|${base.timestamp}|${base.action}|${base.detail}|${base.agent_id}|${base.source}`);
    prev = hash;
    return { ...base, hash };
  });
  const tipHash = entries.length ? entries[entries.length - 1].hash : sha256('audit-empty');
  return { entries, tip_hash: tipHash };
}

function compatApiPayload(pathname, reqUrl, snapshot) {
  const usage = usageFromSnapshot(snapshot);
  const runtime = runtimeSyncSummary(snapshot);
  const alertsCount = parseNonNegativeInt(
    snapshot && snapshot.health && snapshot.health.alerts && snapshot.health.alerts.count != null
      ? snapshot.health.alerts.count
      : 0,
    0,
    100000000
  );
  const status = snapshot && snapshot.ok === true && alertsCount === 0
    ? 'healthy'
    : snapshot && snapshot.ok === true
      ? 'degraded'
      : 'critical';
  const n = parseNonNegativeInt(reqUrl.searchParams.get('n') || 200, 200, 2000);
  const audit = auditEntriesFromSnapshot(snapshot, Math.max(1, n));

  if (pathname === '/api/health') {
    return {
      ok: true,
      status,
      checks:
        snapshot && snapshot.health && snapshot.health.checks && typeof snapshot.health.checks === 'object'
          ? snapshot.health.checks
          : {},
      alerts:
        snapshot && snapshot.health && snapshot.health.alerts && typeof snapshot.health.alerts === 'object'
          ? snapshot.health.alerts
          : { count: 0, checks: [] },
      dashboard_metrics:
        snapshot && snapshot.health && snapshot.health.dashboard_metrics && typeof snapshot.health.dashboard_metrics === 'object'
          ? snapshot.health.dashboard_metrics
          : {},
      runtime_sync: runtime,
      receipt_hash: snapshot && snapshot.receipt_hash ? snapshot.receipt_hash : '',
      ts: nowIso(),
    };
  }
  if (pathname === '/api/usage') {
    return {
      ok: true,
      agents: usage.agents,
      summary: usage.summary,
      by_model: usage.models,
      daily: usage.daily,
    };
  }
  if (pathname === '/api/usage/summary') {
    return { ok: true, ...usage.summary };
  }
  if (pathname === '/api/usage/by-model') {
    return { ok: true, models: usage.models };
  }
  if (pathname === '/api/usage/daily') {
    return { ok: true, days: usage.daily };
  }
  if (pathname === '/api/providers') {
    return { ok: true, providers: providersFromSnapshot(snapshot) };
  }
  if (pathname === '/api/channels') {
    return { ok: true, channels: [] };
  }
  if (pathname === '/api/skills') {
    return { ok: true, skills: skillsFromSnapshot(snapshot) };
  }
  if (pathname === '/api/mcp/servers') {
    return { ok: true, servers: [] };
  }
  if (pathname === '/api/audit/recent') {
    return { ok: true, entries: audit.entries, tip_hash: audit.tip_hash };
  }
  if (pathname === '/api/audit/verify') {
    return { ok: true, valid: true, entries: audit.entries.length, tip_hash: audit.tip_hash };
  }
  if (pathname === '/api/version') {
    return {
      ok: true,
      version: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      rust_authority: 'rust_core_lanes',
    };
  }
  if (pathname === '/api/network/status') {
    return {
      ok: true,
      enabled: true,
      connected_peers: 0,
      total_peers: 0,
      runtime_sync: runtime,
    };
  }
  if (pathname === '/api/peers') {
    return {
      ok: true,
      peers: [],
      connected: 0,
      total: 0,
      runtime_sync: runtime,
    };
  }
  if (pathname === '/api/security') {
    return {
      ok: true,
      mode: 'strict',
      fail_closed: true,
      receipts_required: true,
      conduit_enforced: runtime.conduit_signals >= 0,
      checks:
        snapshot && snapshot.health && snapshot.health.checks && typeof snapshot.health.checks === 'object'
          ? snapshot.health.checks
          : {},
      alerts:
        snapshot && snapshot.health && snapshot.health.alerts && typeof snapshot.health.alerts === 'object'
          ? snapshot.health.alerts
          : {},
      runtime_sync: runtime,
    };
  }
  if (pathname === '/api/tools') {
    return {
      ok: true,
      tools: Array.from(CLI_ALLOWLIST)
        .sort()
        .map((name) => ({ name, category: name.includes('protheus') ? 'runtime' : 'cli' })),
      runtime_sync: runtime,
    };
  }
  if (pathname === '/api/commands') {
    return {
      ok: true,
      commands: [
        { command: '/status', description: 'Show runtime status and cockpit summary' },
        { command: '/queue', description: 'Show current queue pressure' },
        { command: '/context', description: 'Show context and attention state' },
        { command: '/model', description: 'Inspect or switch active model' },
        { command: '/budget', description: 'Show usage budget summary' },
        { command: '/peers', description: 'Show network peer status' },
        { command: '/a2a', description: 'Show discovered A2A peers' },
      ],
    };
  }
  if (pathname === '/api/budget') {
    return {
      ok: true,
      hourly_spend: 0,
      daily_spend: usage.summary.total_cost_usd,
      monthly_spend: usage.summary.total_cost_usd,
      hourly_limit: 0,
      daily_limit: 0,
      monthly_limit: 0,
    };
  }
  if (pathname === '/api/a2a/agents') {
    return { ok: true, agents: [] };
  }
  return null;
}

function writeSnapshotReceipt(snapshot) {
  writeJson(SNAPSHOT_LATEST_PATH, snapshot);
  appendJsonl(SNAPSHOT_HISTORY_PATH, snapshot);
}

function writeActionReceipt(action, payload, laneResult) {
  const record = {
    ok: laneResult && laneResult.ok === true,
    type: 'infring_dashboard_action_receipt',
    ts: nowIso(),
    action: cleanText(action, 120),
    payload: payload && typeof payload === 'object' ? payload : {},
    lane_status: laneResult ? laneResult.status : 1,
    lane_argv: laneResult ? laneResult.argv : [],
    lane_receipt_hash:
      laneResult &&
      laneResult.payload &&
      typeof laneResult.payload === 'object' &&
      laneResult.payload.receipt_hash
        ? String(laneResult.payload.receipt_hash)
        : null,
  };
  const withHash = { ...record, receipt_hash: sha256(JSON.stringify(record)) };
  writeJson(ACTION_LATEST_PATH, withHash);
  appendJsonl(ACTION_HISTORY_PATH, withHash);
  return withHash;
}

function isCriticalDashboardAction(action = '') {
  const normalized = cleanText(action, 80);
  if (!normalized) return false;
  return (
    normalized === 'app.chat' ||
    normalized === 'dashboard.runtime.executeSwarmRecommendation' ||
    normalized === 'dashboard.runtime.applyTelemetryRemediations' ||
    normalized === 'dashboard.ui.toggleControls' ||
    normalized === 'dashboard.ui.toggleSection' ||
    normalized === 'dashboard.ui.switchControlsTab'
  );
}

function currentIngressControl(snapshot) {
  return classifyIngressControl(runtimeSyncSummary(snapshot));
}

function runAction(action, payload) {
  const normalizedAction = cleanText(action, 80);
  const data = payload && typeof payload === 'object' ? payload : {};
  if (normalizedAction === 'dashboard.ui.toggleControls') {
    const open = !!(data && data.open);
    const ts = nowIso();
    const eventPayload = { event: 'toggle_controls', open, ts };
    return {
      ok: true,
      status: 0,
      argv: ['dashboard.ui.toggleControls'],
      payload: {
        ok: true,
        type: 'infring_dashboard_ui_event',
        event: eventPayload.event,
        open: eventPayload.open,
        ts: eventPayload.ts,
        receipt_hash: sha256(JSON.stringify(eventPayload)),
      },
    };
  }
  if (normalizedAction === 'dashboard.ui.toggleSection') {
    const section = cleanText(data.section || 'unknown', 80) || 'unknown';
    const open = !!(data && data.open);
    const ts = nowIso();
    const eventPayload = { event: 'toggle_section', section, open, ts };
    return {
      ok: true,
      status: 0,
      argv: ['dashboard.ui.toggleSection'],
      payload: {
        ok: true,
        type: 'infring_dashboard_ui_event',
        event: eventPayload.event,
        section: eventPayload.section,
        open: eventPayload.open,
        ts: eventPayload.ts,
        receipt_hash: sha256(JSON.stringify(eventPayload)),
      },
    };
  }
  if (normalizedAction === 'dashboard.ui.switchControlsTab') {
    const tab = cleanText(data.tab || 'swarm', 40) || 'swarm';
    const ts = nowIso();
    const eventPayload = { event: 'switch_controls_tab', tab, ts };
    return {
      ok: true,
      status: 0,
      argv: ['dashboard.ui.switchControlsTab'],
      payload: {
        ok: true,
        type: 'infring_dashboard_ui_event',
        event: eventPayload.event,
        tab: eventPayload.tab,
        ts: eventPayload.ts,
        receipt_hash: sha256(JSON.stringify(eventPayload)),
      },
    };
  }
  if (normalizedAction === 'app.switchProvider') {
    const provider = cleanText(data.provider || 'openai', 60) || 'openai';
    const model = cleanText(data.model || 'gpt-5', 100) || 'gpt-5';
    return runLane(['app-plane', 'switch-provider', '--app=chat-ui', `--provider=${provider}`, `--model=${model}`]);
  }
  if (normalizedAction === 'app.chat') {
    const input = cleanText(data.input || data.message || '', 2000);
    const sessionId = cleanText(data.session_id || data.sessionId || '', 120);
    if (!input) {
      return {
        ok: false,
        status: 2,
        argv: ['app-plane', 'run', '--app=chat-ui'],
        payload: {
          ok: false,
          type: 'infring_dashboard_action_error',
          error: 'chat_input_required',
        },
      };
    }
    const args = ['app-plane', 'run', '--app=chat-ui', `--input=${input}`];
    if (sessionId) args.push(`--session-id=${sessionId}`);
    return runLane(args);
  }
  if (normalizedAction === 'collab.launchRole') {
    const team = cleanText(data.team || DEFAULT_TEAM, 60) || DEFAULT_TEAM;
    const role = cleanText(data.role || 'analyst', 60) || 'analyst';
    const shadow =
      cleanText(data.shadow || `${team}-${role}-shadow`, 80) || `${team}-${role}-shadow`;
    return runLane([
      'collab-plane',
      'launch-role',
      `--team=${team}`,
      `--role=${role}`,
      `--shadow=${shadow}`,
    ]);
  }
  if (normalizedAction === 'skills.run') {
    const skill = cleanText(data.skill || '', 80);
    const input = cleanText(data.input || '', 600);
    if (!skill) {
      return {
        ok: false,
        status: 2,
        argv: ['skills-plane', 'run'],
        payload: {
          ok: false,
          type: 'infring_dashboard_action_error',
          error: 'skill_required',
        },
      };
    }
    const args = ['skills-plane', 'run', `--skill=${skill}`];
    if (input) args.push(`--input=${input}`);
    return runLane(args);
  }
  if (normalizedAction === 'dashboard.assimilate') {
    const target = cleanText(data.target || 'codex', 120) || 'codex';
    return runLane([
      'app-plane',
      'run',
      '--app=chat-ui',
      `--input=assimilate target ${target} with receipt-first safety`,
    ]);
  }
  if (normalizedAction === 'dashboard.benchmark') {
    return runLane(['health-status', 'dashboard']);
  }
  return {
    ok: false,
    status: 2,
    argv: [],
    payload: {
      ok: false,
      type: 'infring_dashboard_action_error',
      error: `unsupported_action:${normalizedAction}`,
    },
  };
}

function compatAgentsFromSnapshot(snapshot, options = {}) {
  const includeArchived = !!(options && options.includeArchived);
  const archived = includeArchived ? null : archivedAgentIdsSet();
  const rows =
    snapshot &&
    snapshot.collab &&
    snapshot.collab.dashboard &&
    Array.isArray(snapshot.collab.dashboard.agents)
      ? snapshot.collab.dashboard.agents
      : [];
  return rows
    .map((row, idx) => {
    const id = cleanText(row && row.shadow ? row.shadow : `agent-${idx + 1}`, 120) || `agent-${idx + 1}`;
    const modelState = effectiveAgentModel(id, snapshot);
    const contract = contractForAgent(id);
    const profile = agentProfileFor(id);
    const status = cleanText(row && row.status ? row.status : 'running', 40) || 'running';
    const state =
      status === 'paused' || status === 'stopped' ? status : status === 'error' ? 'error' : 'running';
    const remainingMs = contractRemainingMs(contract);
    const identity = normalizeAgentIdentity(
      profile && profile.identity ? profile.identity : {},
      { emoji: '🤖', archetype: 'assistant', color: '#2563EB' }
    );
    const fallbackModels =
      profile && Array.isArray(profile.fallback_models) ? profile.fallback_models : [];
    const profileRole = cleanText(profile && profile.role ? profile.role : '', 60);
    const runtimeRole = cleanText(row && row.role ? row.role : 'analyst', 60) || 'analyst';
    return {
      id,
      name: cleanText(profile && profile.name ? profile.name : id, 100) || id,
      state,
      activated_at: cleanText(row && row.activated_at ? row.activated_at : '', 80),
      model_name: modelState.selected,
      model_provider: modelState.provider,
      runtime_model: modelState.runtime_model,
      context_window: modelState.context_window,
      role: profileRole || runtimeRole,
      identity,
      system_prompt: cleanText(profile && profile.system_prompt ? profile.system_prompt : '', 4000),
      fallback_models: fallbackModels,
      contract: contractSummary(contract),
      contract_status: formatContractStatus(contract),
      contract_remaining_ms: remainingMs == null ? null : Math.max(0, Math.floor(remainingMs)),
      capabilities: [],
    };
  })
    .filter((agent) => includeArchived || !archived.has(agent.id));
}

function latestAssistantFromSnapshot(snapshot) {
  const turns = snapshot && snapshot.app && Array.isArray(snapshot.app.turns) ? snapshot.app.turns : [];
  if (turns.length === 0) return '';
  const last = turns[turns.length - 1] || {};
  return cleanText(last.assistant || last.response || last.output || '', 2000);
}

function findAgentByRole(agents = [], role = '') {
  const target = cleanText(role || '', 40).toLowerCase();
  if (!target) return null;
  return (Array.isArray(agents) ? agents : []).find(
    (row) => cleanText(row && row.role ? row.role : '', 40).toLowerCase() === target
  ) || null;
}

function laneOutcome(result) {
  return {
    ok: !!(result && result.ok),
    status: Number.isFinite(Number(result && result.status)) ? Number(result.status) : 1,
    argv: Array.isArray(result && result.argv) ? result.argv : [],
    type: cleanText(result && result.payload && result.payload.type ? result.payload.type : '', 120),
    error: cleanText(result && result.payload && result.payload.error ? result.payload.error : result && result.stderr ? result.stderr : '', 260),
  };
}

function ensureRuntimeRole(snapshot, team, role, preferredShadow = '') {
  const normalizedRole = normalizeCollabRole(role);
  const agents = compatAgentsFromSnapshot(snapshot, { includeArchived: false });
  const existing = findAgentByRole(agents, normalizedRole);
  if (existing && existing.id) {
    return {
      ok: true,
      role: normalizedRole,
      shadow: existing.id,
      launched: false,
      lane: null,
    };
  }
  const shadow =
    cleanText(preferredShadow || `${cleanText(team || DEFAULT_TEAM, 40) || DEFAULT_TEAM}-${normalizedRole}-auto`, 120) ||
    `${DEFAULT_TEAM}-${normalizedRole}-auto`;
  const lane = runLane([
    'collab-plane',
    'launch-role',
    `--team=${cleanText(team || DEFAULT_TEAM, 40) || DEFAULT_TEAM}`,
    `--role=${normalizedRole}`,
    `--shadow=${shadow}`,
    '--strict=1',
  ]);
  return {
    ok: !!(lane && lane.ok && lane.payload && lane.payload.ok !== false),
    role: normalizedRole,
    shadow,
    launched: true,
    lane: laneOutcome(lane),
  };
}

function trackedRuntimeDrainAgents(snapshot) {
  const activeIds = new Set(
    compatAgentsFromSnapshot(snapshot, { includeArchived: false })
      .map((row) => cleanText(row && row.id ? row.id : '', 140))
      .filter(Boolean)
  );
  const tracked = Array.isArray(runtimeDrainState.active_agents) ? runtimeDrainState.active_agents : [];
  const retained = tracked.filter((id) => activeIds.has(id) && !isAgentArchived(id));
  runtimeDrainState.active_agents = retained;
  return retained.slice();
}

function launchRuntimeDrainAgent(team, indexHint = 0) {
  const normalizedTeam = cleanText(team || DEFAULT_TEAM, 40) || DEFAULT_TEAM;
  const seed = `${Date.now()}-${indexHint}-${Math.floor(Math.random() * 1000)}`;
  const shadow = cleanText(`${normalizedTeam}-drain-${seed}`, 120) || `${normalizedTeam}-drain-${Date.now()}`;
  const lane = runLane([
    'collab-plane',
    'launch-role',
    `--team=${normalizedTeam}`,
    '--role=builder',
    `--shadow=${shadow}`,
    '--strict=1',
  ]);
  return {
    ok: !!(lane && lane.ok && lane.payload && lane.payload.ok !== false),
    role: 'builder',
    shadow,
    launched: true,
    lane: laneOutcome(lane),
  };
}

function applyRuntimePredictiveDrain(snapshot, team, runtime) {
  const queueDepth = parseNonNegativeInt(runtime && runtime.queue_depth, 0, 100000000);
  const activeBefore = trackedRuntimeDrainAgents(snapshot);
  const launches = [];
  const turns = [];
  const archived = [];
  const required = queueDepth >= RUNTIME_DRAIN_TRIGGER_DEPTH;
  const release = queueDepth <= RUNTIME_DRAIN_CLEAR_DEPTH;
  if (required) {
    const desiredFloor =
      queueDepth >= RUNTIME_DRAIN_HIGH_LOAD_DEPTH
        ? RUNTIME_DRAIN_AGENT_HIGH_LOAD_TARGET
        : RUNTIME_DRAIN_AGENT_TARGET;
    const desired = Math.max(desiredFloor, Math.min(RUNTIME_DRAIN_AGENT_MAX, Math.ceil(queueDepth / 40)));
    let active = activeBefore.slice();
    while (active.length < desired) {
      const launch = launchRuntimeDrainAgent(team, active.length + 1);
      launches.push(launch);
      if (!launch.ok || !launch.shadow) break;
      active.push(launch.shadow);
    }
    runtimeDrainState.active_agents = active;
    runtimeDrainState.last_spawn_at = nowIso();
    for (const shadow of active) {
      const turn = queueAgentTask(
        shadow,
        snapshot,
        'Drain queue backlog in weighted lanes. Process critical first, then standard, then background. Keep queue depth under 60 and protect critical telemetry.',
        'swarm_recommendation.predictive_drain'
      );
      turns.push({
        role: 'builder',
        shadow,
        ok: !!turn.ok,
        response: cleanText(turn.ok ? 'Drain task queued.' : turn.error || '', 400),
        runtime_sync: runtimeSyncSummary(snapshot),
      });
    }
  } else if (release && activeBefore.length > 0) {
    for (const shadow of activeBefore) {
      const meta = archiveAgent(shadow, { source: 'runtime.predictive_drain', reason: 'queue_recovered' });
      closeTerminalSession(shadow, 'drain_agent_archived');
      archived.push({
        shadow,
        archived: !!meta,
        archived_at: meta && meta.archived_at ? meta.archived_at : '',
      });
    }
    runtimeDrainState.active_agents = [];
    runtimeDrainState.last_dissolve_at = nowIso();
  }
  return {
    required,
    release,
    trigger_depth: RUNTIME_DRAIN_TRIGGER_DEPTH,
    clear_depth: RUNTIME_DRAIN_CLEAR_DEPTH,
    active_count: runtimeDrainState.active_agents.length,
    active_agents: runtimeDrainState.active_agents.slice(0, 8),
    launches,
    turns,
    archived,
    last_spawn_at: runtimeDrainState.last_spawn_at,
    last_dissolve_at: runtimeDrainState.last_dissolve_at,
  };
}

function classifyIngressControl(runtime) {
  const queueDepth = parseNonNegativeInt(runtime && runtime.queue_depth, 0, 100000000);
  const critical = parseNonNegativeInt(runtime && runtime.critical_attention_total, 0, 100000000);
  const growthRisk = queueDepth >= RUNTIME_INGRESS_SHED_DEPTH && critical >= RUNTIME_CRITICAL_ESCALATION_THRESHOLD;
  let level = 'normal';
  let rejectNonCritical = false;
  let delayMs = 0;
  let reason = 'steady_state';

  if (queueDepth >= RUNTIME_INGRESS_CIRCUIT_DEPTH || growthRisk) {
    level = 'circuit';
    rejectNonCritical = true;
    delayMs = RUNTIME_INGRESS_DELAY_MS;
    reason = queueDepth >= RUNTIME_INGRESS_CIRCUIT_DEPTH ? 'queue_circuit_breaker' : 'critical_growth_risk';
  } else if (queueDepth >= RUNTIME_INGRESS_SHED_DEPTH) {
    level = 'shed';
    rejectNonCritical = true;
    delayMs = RUNTIME_INGRESS_DELAY_MS;
    reason = 'priority_shed';
  } else if (queueDepth >= RUNTIME_INGRESS_DAMPEN_DEPTH) {
    level = 'dampen';
    rejectNonCritical = false;
    delayMs = RUNTIME_INGRESS_DELAY_MS;
    reason = 'predictive_dampen';
  }

  if (ingressControllerState.level !== level) {
    ingressControllerState = {
      level,
      reject_non_critical: rejectNonCritical,
      delay_ms: delayMs,
      reason,
      since: nowIso(),
    };
  } else {
    ingressControllerState = {
      ...ingressControllerState,
      reject_non_critical: rejectNonCritical,
      delay_ms: delayMs,
      reason,
    };
  }
  return {
    level,
    reject_non_critical: rejectNonCritical,
    delay_ms: delayMs,
    reason,
    since: cleanText(ingressControllerState.since || '', 80),
    dampen_depth: RUNTIME_INGRESS_DAMPEN_DEPTH,
    shed_depth: RUNTIME_INGRESS_SHED_DEPTH,
    circuit_depth: RUNTIME_INGRESS_CIRCUIT_DEPTH,
  };
}

function maybeAutoHealConduit(runtime, team) {
  const queueDepth = parseNonNegativeInt(runtime && runtime.queue_depth, 0, 100000000);
  const signals = parseNonNegativeInt(runtime && runtime.conduit_signals, 0, 100000000);
  const staleCockpitBlocks = parseNonNegativeInt(runtime && runtime.cockpit_stale_blocks, 0, 100000000);
  const threshold = Math.max(
    parsePositiveInt(runtime && runtime.target_conduit_signals, RUNTIME_AUTO_BALANCE_THRESHOLD, 1, 128),
    RUNTIME_CONDUIT_WATCHDOG_MIN_SIGNALS
  );
  const lowSignals = signals < threshold;
  const nowMs = Date.now();
  if (!lowSignals) {
    conduitWatchdogState = {
      ...conduitWatchdogState,
      low_signals_since_ms: 0,
    };
  }
  const lowSince = lowSignals
    ? conduitWatchdogState.low_signals_since_ms > 0
      ? conduitWatchdogState.low_signals_since_ms
      : nowMs
    : 0;
  if (lowSignals) {
    conduitWatchdogState.low_signals_since_ms = lowSince;
  }
  const staleForMs = lowSignals ? Math.max(0, nowMs - lowSince) : 0;
  const required = lowSignals && (
    queueDepth >= RUNTIME_DRAIN_TRIGGER_DEPTH ||
    queueDepth >= RUNTIME_INGRESS_DAMPEN_DEPTH ||
    staleCockpitBlocks > 0 ||
    staleForMs >= RUNTIME_CONDUIT_WATCHDOG_STALE_MS
  );
  if (!required) {
    return {
      required: false,
      triggered: false,
      recovered: !lowSignals,
      queue_depth: queueDepth,
      conduit_signals: signals,
      stale_cockpit_blocks: staleCockpitBlocks,
      low_signal: lowSignals,
      threshold,
      stale_for_ms: staleForMs,
      lane: null,
      last_attempt_at: cleanText(conduitWatchdogState.last_attempt_at || '', 80),
      last_success_at: cleanText(conduitWatchdogState.last_success_at || '', 80),
    };
  }
  const triggerReady =
    staleForMs >= RUNTIME_CONDUIT_WATCHDOG_STALE_MS ||
    staleCockpitBlocks > 0 ||
    queueDepth >= RUNTIME_DRAIN_TRIGGER_DEPTH;
  const canAttempt =
    triggerReady &&
    (nowMs - parseNonNegativeInt(conduitWatchdogState.last_attempt_ms, 0, 1000000000000)) >=
      RUNTIME_CONDUIT_WATCHDOG_COOLDOWN_MS;
  if (!canAttempt) {
    return {
      required: true,
      triggered: false,
      queue_depth: queueDepth,
      conduit_signals: signals,
      stale_cockpit_blocks: staleCockpitBlocks,
      low_signal: lowSignals,
      threshold,
      stale_for_ms: staleForMs,
      lane: null,
      last_attempt_at: cleanText(conduitWatchdogState.last_attempt_at || '', 80),
      last_success_at: cleanText(conduitWatchdogState.last_success_at || '', 80),
    };
  }
  const normalizedTeam = cleanText(team || DEFAULT_TEAM, 40) || DEFAULT_TEAM;
  const drainLimit = Math.min(
    RUNTIME_ATTENTION_DRAIN_MAX_BATCH,
    Math.max(RUNTIME_ATTENTION_DRAIN_MIN_BATCH, Math.ceil(queueDepth / 3))
  );
  const drainLane = runLane([
    'attention-queue',
    'drain',
    `--consumer=${ATTENTION_CONSUMER_ID}`,
    `--limit=${drainLimit}`,
    '--wait-ms=0',
    '--run-context=runtime_conduit_watchdog',
  ]);
  const cursorOffset = parseNonNegativeInt(runtime && runtime.attention_cursor_offset, 0, 100000000);
  let compactLane = null;
  if (queueDepth >= RUNTIME_ATTENTION_COMPACT_DEPTH && cursorOffset >= RUNTIME_ATTENTION_COMPACT_MIN_ACKED) {
    compactLane = runLane([
      'attention-queue',
      'compact',
      `--retain=${RUNTIME_ATTENTION_COMPACT_RETAIN}`,
      `--min-acked=${RUNTIME_ATTENTION_COMPACT_MIN_ACKED}`,
      '--run-context=runtime_conduit_watchdog',
    ]);
  }
  const healthLane = runLane(['health-status', 'dashboard']);
  const cockpitLane = runLane(['hermes-plane', 'cockpit', `--max-blocks=${COCKPIT_MAX_BLOCKS}`, '--strict=1']);
  const roleLane = runLane([
    'collab-plane',
    'launch-role',
    `--team=${normalizedTeam}`,
    '--role=researcher',
    `--shadow=${normalizedTeam}-conduit-watchdog`,
    '--strict=1',
  ]);
  const ok = !!(
    drainLane &&
    drainLane.ok &&
    healthLane &&
    healthLane.ok &&
    cockpitLane &&
    cockpitLane.ok &&
    roleLane &&
    roleLane.ok &&
    (compactLane == null || compactLane.ok)
  );
  conduitWatchdogState.last_attempt_ms = nowMs;
  conduitWatchdogState.last_attempt_at = nowIso();
  if (ok) {
    conduitWatchdogState.last_success_ms = nowMs;
    conduitWatchdogState.last_success_at = nowIso();
    conduitWatchdogState.failure_count = 0;
    conduitWatchdogState.low_signals_since_ms = 0;
  } else {
    conduitWatchdogState.failure_count = parseNonNegativeInt(conduitWatchdogState.failure_count, 0, 100000000) + 1;
  }
  return {
    required: true,
    triggered: true,
    applied: ok,
    queue_depth: queueDepth,
    conduit_signals: signals,
    stale_cockpit_blocks: staleCockpitBlocks,
    low_signal: lowSignals,
    threshold,
    stale_for_ms: staleForMs,
    failure_count: parseNonNegativeInt(conduitWatchdogState.failure_count, 0, 100000000),
    lane: laneOutcome(drainLane),
    lanes: {
      drain: laneOutcome(drainLane),
      compact: compactLane ? laneOutcome(compactLane) : null,
      health: laneOutcome(healthLane),
      cockpit: laneOutcome(cockpitLane),
      role: laneOutcome(roleLane),
    },
    drain_limit: drainLimit,
    last_attempt_at: cleanText(conduitWatchdogState.last_attempt_at || '', 80),
    last_success_at: cleanText(conduitWatchdogState.last_success_at || '', 80),
  };
}

function maybeApplyRuntimeThrottle(runtime, team) {
  const ingress = classifyIngressControl(runtime);
  const queueDepth = parseNonNegativeInt(runtime && runtime.queue_depth, 0, 100000000);
  const dynamicMaxDepth =
    queueDepth >= RUNTIME_INGRESS_CIRCUIT_DEPTH
      ? Math.max(40, RUNTIME_THROTTLE_MAX_DEPTH - 20)
      : queueDepth >= RUNTIME_INGRESS_SHED_DEPTH
      ? Math.max(50, RUNTIME_THROTTLE_MAX_DEPTH - 10)
      : RUNTIME_THROTTLE_MAX_DEPTH;
  const required =
    queueDepth >= DASHBOARD_BACKPRESSURE_BATCH_DEPTH ||
    parseNonNegativeInt(runtime && runtime.critical_attention_total, 0, 100000000) >= RUNTIME_CRITICAL_ESCALATION_THRESHOLD ||
    cleanText(runtime && runtime.backpressure_level ? runtime.backpressure_level : '', 20).toLowerCase() === 'critical' ||
    ingress.level === 'shed' ||
    ingress.level === 'circuit';
  const command = [
    'collab-plane',
    'throttle',
    `--team=${cleanText(team || DEFAULT_TEAM, 40) || DEFAULT_TEAM}`,
    `--plane=${RUNTIME_THROTTLE_PLANE}`,
    `--max-depth=${dynamicMaxDepth}`,
    `--strategy=${RUNTIME_THROTTLE_STRATEGY}`,
    '--strict=1',
  ];
  if (!required) {
    return {
      required: false,
      applied: false,
      command: `protheus-ops ${command.join(' ')}`,
      ingress_control: ingress,
      lane: null,
    };
  }
  const lane = runLane(command);
  if (lane && lane.ok) {
    runtimePolicyState.last_throttle_apply = nowIso();
  }
  return {
    required: true,
    applied: !!(lane && lane.ok && lane.payload && lane.payload.ok !== false),
    command: `protheus-ops ${command.join(' ')}`,
    ingress_control: ingress,
    max_depth: dynamicMaxDepth,
    lane: laneOutcome(lane),
  };
}

function maybeDrainAttentionQueue(runtime) {
  const queueDepth = parseNonNegativeInt(runtime && runtime.queue_depth, 0, 100000000);
  const unackedDepth = parseNonNegativeInt(runtime && runtime.attention_unacked_depth, 0, 100000000);
  const required =
    queueDepth >= RUNTIME_DRAIN_TRIGGER_DEPTH ||
    unackedDepth >= RUNTIME_ATTENTION_COMPACT_MIN_ACKED * 2 ||
    cleanText(runtime && runtime.ingress_level ? runtime.ingress_level : '', 24) === 'circuit';
  const limit = Math.min(
    RUNTIME_ATTENTION_DRAIN_MAX_BATCH,
    Math.max(RUNTIME_ATTENTION_DRAIN_MIN_BATCH, Math.ceil(queueDepth / 3))
  );
  const command = [
    'attention-queue',
    'drain',
    `--consumer=${ATTENTION_CONSUMER_ID}`,
    `--limit=${limit}`,
    '--wait-ms=0',
    '--run-context=runtime_attention_autodrain',
  ];
  if (!required) {
    return {
      required: false,
      applied: false,
      command: `protheus-ops ${command.join(' ')}`,
      lane: null,
      drained_count: 0,
    };
  }
  const lane = runLane(command);
  const drainedCount = parseNonNegativeInt(
    lane && lane.payload && lane.payload.batch_count != null ? lane.payload.batch_count : 0,
    0,
    100000000
  );
  return {
    required: true,
    applied: !!(lane && lane.ok && lane.payload && lane.payload.ok !== false),
    command: `protheus-ops ${command.join(' ')}`,
    limit,
    drained_count: drainedCount,
    lane: laneOutcome(lane),
  };
}

function maybeCompactAttentionQueue(runtime) {
  const queueDepth = parseNonNegativeInt(runtime && runtime.queue_depth, 0, 100000000);
  const cursorOffset = parseNonNegativeInt(runtime && runtime.attention_cursor_offset, 0, 100000000);
  const required =
    queueDepth >= RUNTIME_ATTENTION_COMPACT_DEPTH &&
    cursorOffset >= RUNTIME_ATTENTION_COMPACT_MIN_ACKED;
  const command = [
    'attention-queue',
    'compact',
    `--retain=${RUNTIME_ATTENTION_COMPACT_RETAIN}`,
    `--min-acked=${RUNTIME_ATTENTION_COMPACT_MIN_ACKED}`,
    '--run-context=runtime_attention_autocompact',
  ];
  if (!required) {
    return {
      required: false,
      applied: false,
      command: `protheus-ops ${command.join(' ')}`,
      compacted_count: 0,
      lane: null,
    };
  }
  const lane = runLane(command);
  const compactedCount = parseNonNegativeInt(
    lane && lane.payload && lane.payload.compacted_count != null ? lane.payload.compacted_count : 0,
    0,
    100000000
  );
  return {
    required: true,
    applied: !!(lane && lane.ok && lane.payload && lane.payload.ok !== false),
    command: `protheus-ops ${command.join(' ')}`,
    compacted_count: compactedCount,
    lane: laneOutcome(lane),
    retain: RUNTIME_ATTENTION_COMPACT_RETAIN,
    min_acked: RUNTIME_ATTENTION_COMPACT_MIN_ACKED,
  };
}

function maybeRefreshAdaptiveHealth(runtime) {
  const required =
    parseNonNegativeInt(runtime && runtime.queue_depth, 0, 100000000) >= 80 ||
    parseNonNegativeInt(runtime && runtime.health_coverage_gap_count, 0, 100000000) > 0;
  runtimePolicyState.health_adaptive = required;
  if (!required) {
    return {
      required: false,
      applied: false,
      window_seconds: runtimePolicyState.health_window_seconds,
      lane: null,
    };
  }
  const lane = runLane(['health-status', 'dashboard']);
  if (lane && lane.ok) {
    runtimePolicyState.last_health_refresh = nowIso();
  }
  return {
    required: true,
    applied: !!(lane && lane.ok && lane.payload && lane.payload.ok !== false),
    window_seconds: runtimePolicyState.health_window_seconds,
    lane: laneOutcome(lane),
  };
}

function maybeResumeMemoryIngest(runtime) {
  const paused = !!(runtime && runtime.memory_ingest_paused);
  const queueDepth = parseNonNegativeInt(runtime && runtime.queue_depth, 0, 100000000);
  if (!paused) {
    return {
      eligible: false,
      resumed: false,
      reason: 'already_live',
    };
  }
  if (queueDepth > DASHBOARD_QUEUE_DRAIN_RESUME_DEPTH) {
    return {
      eligible: false,
      resumed: false,
      reason: 'queue_above_resume_threshold',
      queue_depth: queueDepth,
      resume_threshold: DASHBOARD_QUEUE_DRAIN_RESUME_DEPTH,
    };
  }
  memoryIngestCircuit = {
    paused: false,
    since: nowIso(),
    reason: 'manual_stream_resume',
    trigger_queue_depth: queueDepth,
    trigger_memory_entries: 0,
    transition_count: parseNonNegativeInt(memoryIngestCircuit.transition_count, 0, 1000000) + 1,
  };
  return {
    eligible: true,
    resumed: true,
    reason: 'manual_stream_resume',
    queue_depth: queueDepth,
    resume_threshold: DASHBOARD_QUEUE_DRAIN_RESUME_DEPTH,
  };
}

function runtimeSwarmRecommendation(snapshot) {
  const runtime = runtimeSyncSummary(snapshot);
  const ingressControl = classifyIngressControl(runtime);
  const team = DEFAULT_TEAM;
  const agents = compatAgentsFromSnapshot(snapshot, { includeArchived: false });
  const activeSwarmAgents = parseNonNegativeInt(agents.length, 0, 100000000);
  const swarmScaleRequired =
    runtime.queue_depth >= RUNTIME_DRAIN_HIGH_LOAD_DEPTH &&
    activeSwarmAgents < RUNTIME_DRAIN_AGENT_HIGH_LOAD_TARGET;
  const shouldRecommendBase =
    runtime.queue_depth >= DASHBOARD_QUEUE_DRAIN_PAUSE_DEPTH ||
    runtime.critical_attention_total >= 5 ||
    runtime.health_coverage_gap_count > 0 ||
    !!runtime.conduit_scale_required ||
    parseNonNegativeInt(runtime && runtime.deferred_attention, 0, 100000000) > 0 ||
    parseNonNegativeInt(runtime && runtime.cockpit_stale_blocks, 0, 100000000) > 0 ||
    swarmScaleRequired;
  const heavyCockpitLoad = runtime.cockpit_blocks >= RUNTIME_COCKPIT_BLOCK_ESCALATION_THRESHOLD;
  const roleOrder = ['coordinator', 'researcher', 'builder', 'reviewer', 'analyst'];
  const roleRequired = {
    coordinator: shouldRecommendBase || runtime.health_coverage_gap_count > 0,
    researcher: shouldRecommendBase || runtime.critical_attention_total >= 5 || !!runtime.conduit_scale_required,
    builder:
      heavyCockpitLoad ||
      runtime.queue_depth >= DASHBOARD_BACKPRESSURE_BATCH_DEPTH ||
      parseNonNegativeInt(runtime && runtime.cockpit_stale_blocks, 0, 100000000) > 0,
    reviewer: swarmScaleRequired || runtime.health_coverage_gap_count > 0,
    analyst:
      runtime.queue_depth >= DASHBOARD_QUEUE_DRAIN_PAUSE_DEPTH ||
      runtime.critical_attention_total >= RUNTIME_CRITICAL_ESCALATION_THRESHOLD ||
      runtime.health_coverage_gap_count > 0,
  };
  const rolePrompts = {
    coordinator:
      'Audit runtime transport and health coverage. Identify missing conduit capacity vs target and any retired health checks. Return concrete remediation commands.',
    researcher:
      'Triage critical attention events by severity, band, and queue lane. Return top 5 risks with suggested actions and explain which are safe to defer.',
    builder:
      'Clear cockpit policy debt and unblock module_cohesion_policy_audit path. Prioritize deterministic fixes that reduce queue pressure and preserve receipts.',
    reviewer:
      'Review swarm action plans for safety and determinism. Escalate risky tool paths and enforce critical-lane-first queue handling.',
    analyst:
      'Classify queue backlog into critical/standard/background lanes, then produce weighted-fair actions to drain depth below 60 without losing critical telemetry.',
  };
  const rolePlan = roleOrder
    .map((role) => {
      const existing = findAgentByRole(agents, role);
      return {
        role,
        required: !!roleRequired[role],
        shadow: existing && existing.id ? existing.id : '',
        prompt: rolePrompts[role],
      };
    })
    .filter((row) => row.required);
  const throttleRequired =
    runtime.queue_depth >= DASHBOARD_BACKPRESSURE_BATCH_DEPTH ||
    runtime.critical_attention_total >= RUNTIME_CRITICAL_ESCALATION_THRESHOLD ||
    ingressControl.level === 'shed' ||
    ingressControl.level === 'circuit';
  const adaptiveHealthRequired = runtime.queue_depth >= 80 || runtime.health_coverage_gap_count > 0;
  const conduitAutoBalanceRequired =
    runtime.conduit_signals < Math.max(runtime.target_conduit_signals, RUNTIME_AUTO_BALANCE_THRESHOLD);
  const memoryResumeEligible = !!runtime.memory_ingest_paused && runtime.queue_depth <= DASHBOARD_QUEUE_DRAIN_RESUME_DEPTH;
  const drainAgents = trackedRuntimeDrainAgents(snapshot);
  const predictiveDrainRequired = runtime.queue_depth >= RUNTIME_DRAIN_TRIGGER_DEPTH;
  const predictiveDrainRelease = runtime.queue_depth <= RUNTIME_DRAIN_CLEAR_DEPTH && drainAgents.length > 0;
  const shouldRecommend =
    rolePlan.length > 0 ||
    throttleRequired ||
    adaptiveHealthRequired ||
    conduitAutoBalanceRequired ||
    memoryResumeEligible ||
    predictiveDrainRequired ||
    predictiveDrainRelease;
  return {
    recommended: shouldRecommend,
    team,
    queue_depth: runtime.queue_depth,
    cockpit_blocks: runtime.cockpit_blocks,
    critical_attention_total: runtime.critical_attention_total,
    health_coverage_gap_count: runtime.health_coverage_gap_count,
    conduit_scale_required: !!runtime.conduit_scale_required,
    conduit_signals: runtime.conduit_signals,
    target_conduit_signals: runtime.target_conduit_signals,
    active_swarm_agents: activeSwarmAgents,
    deferred_attention: parseNonNegativeInt(runtime && runtime.deferred_attention, 0, 100000000),
    deferred_mode: cleanText(runtime && runtime.deferred_mode ? runtime.deferred_mode : '', 24),
    cockpit_stale_blocks: parseNonNegativeInt(runtime && runtime.cockpit_stale_blocks, 0, 100000000),
    swarm_scale_required: swarmScaleRequired,
    swarm_target_agents: RUNTIME_DRAIN_AGENT_HIGH_LOAD_TARGET,
    role_plan: rolePlan,
    prompts: rolePrompts,
    attention_lane_weights:
      runtime && runtime.queue_lane_weights && typeof runtime.queue_lane_weights === 'object'
        ? runtime.queue_lane_weights
        : { ...ATTENTION_LANE_WEIGHTS },
    attention_lane_caps:
      runtime && runtime.queue_lane_caps && typeof runtime.queue_lane_caps === 'object'
        ? runtime.queue_lane_caps
        : { ...ATTENTION_LANE_CAPS },
    throttle_required: throttleRequired,
    throttle_command: `protheus-ops collab-plane throttle --plane=${RUNTIME_THROTTLE_PLANE} --max-depth=${RUNTIME_THROTTLE_MAX_DEPTH} --strategy=${RUNTIME_THROTTLE_STRATEGY}`,
    adaptive_health_required: adaptiveHealthRequired,
    adaptive_health_window_seconds: RUNTIME_HEALTH_ADAPTIVE_WINDOW_SECONDS,
    conduit_autobalance_required: conduitAutoBalanceRequired,
    conduit_autobalance_threshold: RUNTIME_AUTO_BALANCE_THRESHOLD,
    conduit_autobalance_command:
      `protheus-ops collab-plane launch-role --team=${cleanText(team || DEFAULT_TEAM, 40) || DEFAULT_TEAM}` +
      ` --role=researcher --shadow=${cleanText(team || DEFAULT_TEAM, 40) || DEFAULT_TEAM}-conduit-watchdog --strict=1`,
    memory_resume_eligible: memoryResumeEligible,
    predictive_drain_required: predictiveDrainRequired,
    predictive_drain_release: predictiveDrainRelease,
    predictive_drain_trigger_depth: RUNTIME_DRAIN_TRIGGER_DEPTH,
    predictive_drain_clear_depth: RUNTIME_DRAIN_CLEAR_DEPTH,
    predictive_drain_active_agents: drainAgents.slice(0, 8),
    ingress_control: ingressControl,
  };
}

function executeRuntimeSwarmRecommendation(snapshot) {
  const recommendation = runtimeSwarmRecommendation(snapshot);
  const runtime = runtimeSyncSummary(snapshot);
  const roleAssignments = [];
  const launches = [];
  const policies = [];
  const turns = [];

  const ingressControl = classifyIngressControl(runtime);
  policies.push({
    policy: 'predictive_ingress_controller',
    required: ingressControl.level !== 'normal',
    applied: true,
    level: ingressControl.level,
    reject_non_critical: !!ingressControl.reject_non_critical,
    delay_ms: ingressControl.delay_ms,
    reason: ingressControl.reason,
    since: ingressControl.since,
    thresholds: {
      dampen: ingressControl.dampen_depth,
      shed: ingressControl.shed_depth,
      circuit: ingressControl.circuit_depth,
    },
  });

  const queueDrain = maybeDrainAttentionQueue(runtime);
  policies.push({
    policy: 'attention_queue_autodrain',
    required: !!queueDrain.required,
    applied: !!queueDrain.applied,
    command: queueDrain.command,
    limit: queueDrain.limit || RUNTIME_ATTENTION_DRAIN_MIN_BATCH,
    drained_count: queueDrain.drained_count || 0,
    lane: queueDrain.lane,
  });

  const queueCompact = maybeCompactAttentionQueue(runtime);
  policies.push({
    policy: 'attention_queue_compaction',
    required: !!queueCompact.required,
    applied: !!queueCompact.applied,
    command: queueCompact.command,
    compacted_count: queueCompact.compacted_count || 0,
    retain: queueCompact.retain || RUNTIME_ATTENTION_COMPACT_RETAIN,
    min_acked: queueCompact.min_acked || RUNTIME_ATTENTION_COMPACT_MIN_ACKED,
    lane: queueCompact.lane,
  });

  const throttle = maybeApplyRuntimeThrottle(runtime, recommendation.team || DEFAULT_TEAM);
  policies.push({
    policy: 'queue_throttle',
    required: !!throttle.required,
    applied: !!throttle.applied,
    command: throttle.command,
    ingress_control: throttle.ingress_control || ingressControl,
    max_depth: throttle.max_depth || RUNTIME_THROTTLE_MAX_DEPTH,
    lane: throttle.lane,
  });

  const conduitWatchdog = maybeAutoHealConduit(runtime, recommendation.team || DEFAULT_TEAM);
  policies.push({
    policy: 'conduit_watchdog_autorestart',
    required: !!conduitWatchdog.required,
    applied: !!conduitWatchdog.applied,
    triggered: !!conduitWatchdog.triggered,
    recovered: !!conduitWatchdog.recovered,
    low_signal: !!conduitWatchdog.low_signal,
    queue_depth: conduitWatchdog.queue_depth,
    conduit_signals: conduitWatchdog.conduit_signals,
    stale_cockpit_blocks: conduitWatchdog.stale_cockpit_blocks || 0,
    threshold: conduitWatchdog.threshold,
    stale_for_ms: conduitWatchdog.stale_for_ms,
    failure_count: conduitWatchdog.failure_count || 0,
    drain_limit: conduitWatchdog.drain_limit || 0,
    last_attempt_at: conduitWatchdog.last_attempt_at,
    last_success_at: conduitWatchdog.last_success_at,
    command:
      `protheus-ops attention-queue drain --consumer=${ATTENTION_CONSUMER_ID}` +
      ` --limit=${conduitWatchdog.drain_limit || RUNTIME_ATTENTION_DRAIN_MIN_BATCH}` +
      ' --wait-ms=0 --run-context=runtime_conduit_watchdog',
    lane: conduitWatchdog.lane,
    lanes: conduitWatchdog.lanes || null,
  });

  const rolePlan = Array.isArray(recommendation.role_plan) ? recommendation.role_plan : [];
  for (const row of rolePlan) {
    const ensure = ensureRuntimeRole(
      snapshot,
      recommendation.team || DEFAULT_TEAM,
      row && row.role ? row.role : 'analyst',
      row && row.shadow ? row.shadow : ''
    );
    launches.push({
      role: ensure.role,
      shadow: ensure.shadow,
      ok: !!ensure.ok,
      launched: !!ensure.launched,
      lane: ensure.lane,
    });
    if (ensure.ok && ensure.shadow) {
      roleAssignments.push({
        role: ensure.role,
        shadow: ensure.shadow,
        prompt:
          cleanText(row && row.prompt ? row.prompt : recommendation.prompts && recommendation.prompts[ensure.role], 2000) ||
          '',
      });
    }
  }

  for (const assignment of roleAssignments) {
    const source = `swarm_recommendation.${cleanText(assignment.role || 'agent', 40) || 'agent'}`;
    const turn = queueAgentTask(
      assignment.shadow,
      snapshot,
      assignment.prompt,
      source
    );
    turns.push({
      role: assignment.role,
      shadow: assignment.shadow,
      ok: !!turn.ok,
      response: cleanText(turn.ok ? 'Task queued.' : turn.error || '', 400),
      runtime_sync: runtimeSyncSummary(snapshot),
    });
  }

  const predictiveDrain = applyRuntimePredictiveDrain(snapshot, recommendation.team || DEFAULT_TEAM, runtime);
  if (Array.isArray(predictiveDrain.launches)) {
    for (const launch of predictiveDrain.launches) {
      launches.push({
        role: cleanText(launch && launch.role ? launch.role : 'builder', 40) || 'builder',
        shadow: cleanText(launch && launch.shadow ? launch.shadow : '', 140),
        ok: !!(launch && launch.ok),
        launched: !!(launch && launch.launched),
        lane: launch && launch.lane ? launch.lane : null,
      });
    }
  }
  if (Array.isArray(predictiveDrain.turns)) {
    turns.push(...predictiveDrain.turns);
  }
  policies.push({
    policy: 'predictive_drain',
    required: !!predictiveDrain.required,
    release: !!predictiveDrain.release,
    applied:
      (!!predictiveDrain.required && parseNonNegativeInt(predictiveDrain.active_count, 0, 100) > 0) ||
      (!!predictiveDrain.release && Array.isArray(predictiveDrain.archived) && predictiveDrain.archived.length > 0),
    trigger_depth: predictiveDrain.trigger_depth,
    clear_depth: predictiveDrain.clear_depth,
    active_count: predictiveDrain.active_count,
    active_agents: Array.isArray(predictiveDrain.active_agents) ? predictiveDrain.active_agents.slice(0, 8) : [],
    archived_count: Array.isArray(predictiveDrain.archived) ? predictiveDrain.archived.length : 0,
  });

  if (parseNonNegativeInt(runtime && runtime.cockpit_stale_blocks, 0, 100000000) > 0) {
    const builderAssignment = roleAssignments.find((row) => row.role === 'builder');
    let staleTurn = null;
    if (builderAssignment && builderAssignment.shadow) {
      const turn = queueAgentTask(
        builderAssignment.shadow,
        snapshot,
        `Drain stale cockpit blocks older than ${Math.floor(RUNTIME_COCKPIT_STALE_BLOCK_MS / 1000)}s and report lock/contention root causes. Prioritize queue unblocking actions first.`,
        'swarm_recommendation.cockpit_stale_blocks'
      );
      staleTurn = {
        role: 'builder',
        shadow: builderAssignment.shadow,
        ok: !!turn.ok,
        response: cleanText(turn.ok ? 'Stale cockpit block remediation queued.' : turn.error || '', 400),
      };
      turns.push({
        ...staleTurn,
        runtime_sync: runtimeSyncSummary(snapshot),
      });
    }
    policies.push({
      policy: 'cockpit_stale_block_timeout',
      required: true,
      applied: !!(staleTurn && staleTurn.ok),
      eligible: !!(builderAssignment && builderAssignment.shadow),
      stale_blocks: parseNonNegativeInt(runtime && runtime.cockpit_stale_blocks, 0, 100000000),
      stale_threshold_ms: RUNTIME_COCKPIT_STALE_BLOCK_MS,
      mode: 'builder_parallel_drain',
    });
  } else {
    policies.push({
      policy: 'cockpit_stale_block_timeout',
      required: false,
      applied: false,
      stale_blocks: 0,
      stale_threshold_ms: RUNTIME_COCKPIT_STALE_BLOCK_MS,
      mode: 'steady_state',
    });
  }

  const healthAdaptive = maybeRefreshAdaptiveHealth(runtime);
  policies.push({
    policy: 'adaptive_health_schedule',
    required: !!healthAdaptive.required,
    applied: !!healthAdaptive.applied,
    window_seconds: healthAdaptive.window_seconds,
    command: `infringd health schedule --adaptive --window=${healthAdaptive.window_seconds}s`,
    lane: healthAdaptive.lane,
  });

  const memoryResume = maybeResumeMemoryIngest(runtime);
  policies.push({
    policy: 'memory_ingest_resume',
    required: !!runtime.memory_ingest_paused,
    applied: !!memoryResume.resumed,
    eligible: !!memoryResume.eligible,
    reason: memoryResume.reason,
  });

  const conduitAutoBalanceRequired = !!recommendation.conduit_autobalance_required;
  let autoBalanceTurn = null;
  if (conduitAutoBalanceRequired) {
    const researcherAssignment = roleAssignments.find((row) => row.role === 'researcher');
    if (researcherAssignment && researcherAssignment.shadow) {
      const turn = queueAgentTask(
        researcherAssignment.shadow,
        snapshot,
        `Run conduit auto-balance triage. Maintain at least ${Math.max(runtime.target_conduit_signals, RUNTIME_AUTO_BALANCE_THRESHOLD)} active conduit signals and report scaling actions.`,
        'swarm_recommendation.conduit_autobalance'
      );
      autoBalanceTurn = {
        role: 'researcher',
        shadow: researcherAssignment.shadow,
        ok: !!turn.ok,
        response: cleanText(turn.ok ? 'Conduit auto-balance task queued.' : turn.error || '', 400),
      };
      turns.push({
        ...autoBalanceTurn,
        runtime_sync: runtimeSyncSummary(snapshot),
      });
    }
  }
  policies.push({
    policy: 'conduit_autobalance',
    required: conduitAutoBalanceRequired,
    applied: !!(autoBalanceTurn && autoBalanceTurn.ok),
    eligible: !conduitAutoBalanceRequired || !!autoBalanceTurn,
    threshold: Math.max(runtime.target_conduit_signals, RUNTIME_AUTO_BALANCE_THRESHOLD),
    command: `protheus-ops collab-plane launch-role --team=${cleanText(recommendation.team || DEFAULT_TEAM, 40) || DEFAULT_TEAM} --role=researcher --shadow=${cleanText(recommendation.team || DEFAULT_TEAM, 40) || DEFAULT_TEAM}-conduit-watchdog --strict=1`,
  });

  const failedPolicies = policies.filter((row) => row.required && row.applied === false && row.eligible !== false);
  const failedLaunches = launches.filter((row) => !row.ok);
  const failedTurns = turns.filter((row) => !row.ok);
  const errors = [
    ...failedPolicies.map((row) => `policy_failed:${row.policy}`),
    ...failedLaunches.map((row) => `launch_failed:${row.role}`),
    ...failedTurns.map((row) => `task_queue_failed:${row.role}`),
  ];
  const workExecuted = turns.length > 0 || policies.some((row) => row.applied === true);
  const remediationDegraded = errors.length > 0;

  return {
    ok: workExecuted || !remediationDegraded,
    type: 'dashboard_runtime_swarm_recommendation',
    recommendation,
    policies,
    launches,
    turns,
    executed_count: turns.length,
    degraded: remediationDegraded,
    errors,
  };
}

function htmlShell() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Infring Dashboard (Legacy Shell)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="/assets/infring_dashboard.css">
</head>
<body>
  <div id="root">
    <main style="max-width:980px;margin:32px auto;padding:16px;color:#e8f0ff;background:rgba(9,16,30,.72);border:1px solid rgba(122,163,255,.28);border-radius:14px">
      <h1 style="margin:0 0 8px 0">InfRing Dashboard</h1>
      <p style="margin:0 0 8px 0;color:#bfd3f5">Loading dashboard UI...</p>
      <p style="margin:0;color:#9eb9e4;font-size:12px">If this view remains blank, the compatibility renderer will auto-activate.</p>
    </main>
  </div>
  <script type="module" src="/assets/infring_dashboard_client.js"></script>
  <script defer src="/assets/infring_dashboard_fallback.js"></script>
  <script>
    (function () {
      function esc(v) {
        var s = String(v == null ? '' : v);
        return s
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }
      function short(v, n) {
        var t = String(v == null ? '' : v).trim();
        if (!t) return 'n/a';
        if (t.length <= n) return t;
        return t.slice(0, n) + '...';
      }
      function bootInlineFallback() {
        var root = document.getElementById('root');
        if (!root) return;
        if (root.getAttribute('data-dashboard-hydrated')) return;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/dashboard/snapshot', true);
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return;
          if (root.getAttribute('data-dashboard-hydrated')) return;
          if (xhr.status < 200 || xhr.status >= 300) {
            root.innerHTML =
              '<main style="max-width:980px;margin:32px auto;padding:16px;color:#e8f0ff;background:rgba(9,16,30,.72);border:1px solid rgba(122,163,255,.28);border-radius:14px">' +
              '<h1 style="margin:0 0 8px 0">InfRing Dashboard</h1>' +
              '<p style="margin:0;color:#bfd3f5">UI compatibility fallback active.</p>' +
              '<p style="margin:8px 0 0 0;color:#9eb9e4;font-size:12px">Snapshot endpoint temporarily unavailable.</p>' +
              '</main>';
            root.setAttribute('data-dashboard-hydrated', 'inline-fallback');
            return;
          }
          var snap = null;
          try { snap = JSON.parse(xhr.responseText || '{}'); } catch (e) { snap = null; }
          if (!snap || typeof snap !== 'object') return;
          var provider = snap && snap.app && snap.app.settings ? snap.app.settings.provider : 'n/a';
          var model = snap && snap.app && snap.app.settings ? snap.app.settings.model : 'n/a';
          var alerts = snap && snap.health && snap.health.alerts ? snap.health.alerts.count : 0;
          root.innerHTML =
            '<main style="max-width:1200px;margin:20px auto;padding:16px;color:#e8f0ff;background:rgba(9,16,30,.72);border:1px solid rgba(122,163,255,.28);border-radius:14px">' +
            '<h1 style="margin:0 0 6px 0">InfRing Dashboard</h1>' +
            '<p style="margin:0;color:#bfd3f5">Compatibility UI active (core data live).</p>' +
            '<div style="margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">' +
            '<article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)"><div style="font-size:12px;color:#b9ceef">Provider</div><div style="font-size:18px;font-weight:700">' + esc(provider) + '</div></article>' +
            '<article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)"><div style="font-size:12px;color:#b9ceef">Model</div><div style="font-size:18px;font-weight:700">' + esc(model) + '</div></article>' +
            '<article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)"><div style="font-size:12px;color:#b9ceef">Open Alerts</div><div style="font-size:18px;font-weight:700">' + esc(alerts) + '</div></article>' +
            '<article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)"><div style="font-size:12px;color:#b9ceef">Receipt</div><div style="font-size:12px;font-family:ui-monospace,Menlo,monospace">' + esc(short(snap.receipt_hash, 28)) + '</div></article>' +
            '</div>' +
            '</main>';
          root.setAttribute('data-dashboard-hydrated', 'inline-fallback');
        };
        xhr.send(null);
      }
      window.setTimeout(bootInlineFallback, 1400);
    })();
  </script>
</body>
</html>`;
}

function transpileClientTs() {
  const source = readText(CLIENT_TS_PATH, '');
  if (!source) {
    throw new Error(`missing_client_source:${path.relative(ROOT, CLIENT_TS_PATH)}`);
  }
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      sourceMap: false,
      removeComments: false,
    },
    fileName: CLIENT_TS_PATH,
    reportDiagnostics: false,
  }).outputText;
}

function transpileFallbackTs() {
  const source = readText(FALLBACK_TS_PATH, '');
  if (!source) {
    throw new Error(`missing_fallback_source:${path.relative(ROOT, FALLBACK_TS_PATH)}`);
  }
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2018,
      sourceMap: false,
      removeComments: false,
    },
    fileName: FALLBACK_TS_PATH,
    reportDiagnostics: false,
  }).outputText;
}

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 1_500_000) {
        reject(new Error('payload_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function runServe(flags) {
  ACTIVE_CLI_MODE = normalizeCliMode(flags && flags.cliMode ? flags.cliMode : ACTIVE_CLI_MODE);
  const forkUiEnabled = hasPrimaryDashboardUi();
  let dashboardHtml = '';
  const refreshUiAssets = () => {
    dashboardHtml = forkUiEnabled ? buildPrimaryDashboardHtml() : '';
  };
  refreshUiAssets();
  let latestSnapshot = buildSnapshot(flags);
  writeSnapshotReceipt(latestSnapshot);
  let updating = false;
  let enforcingContracts = false;

  const refreshSnapshot = (contractEnforcement = null) => {
    latestSnapshot = buildSnapshot({
      ...flags,
      contract_enforcement: contractEnforcement,
    });
    writeSnapshotReceipt(latestSnapshot);
    return latestSnapshot;
  };
  try {
    const initialEnforcement = enforceAgentContracts(latestSnapshot, {
      team: cleanText(flags.team || DEFAULT_TEAM, 40) || DEFAULT_TEAM,
    });
    if (initialEnforcement && initialEnforcement.changed) {
      refreshSnapshot(initialEnforcement);
    }
  } catch {}

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${flags.host}:${flags.port}`);
    const pathname = reqUrl.pathname;

    try {
      const dashboardUiRoute =
        pathname === '/' ||
        pathname === '/dashboard' ||
        pathname === '/openclaw' ||
        pathname === '/openclaw/dashboard';
      if (req.method === 'GET' && dashboardUiRoute) {
        refreshUiAssets();
        const hasDashboardHtml = forkUiEnabled && String(dashboardHtml || '').trim().length > 0;
        if (!hasDashboardHtml) {
          sendJson(res, 503, {
            ok: false,
            type: 'infring_dashboard_primary_ui_missing',
            error: 'legacy_dashboard_removed',
          });
          return;
        }
        sendText(res, 200, dashboardHtml, 'text/html; charset=utf-8');
        return;
      }
      if (forkUiEnabled && req.method === 'GET') {
        const forkAsset = readPrimaryDashboardAsset(pathname);
        if (forkAsset) {
          sendText(res, 200, forkAsset.body, forkAsset.contentType);
          return;
        }
      }
      if (req.method === 'GET' && pathname === '/assets/infring_dashboard.css') {
        sendJson(res, 410, {
          ok: false,
          type: 'infring_dashboard_legacy_asset_removed',
          asset: pathname,
          error: 'legacy_dashboard_removed',
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/assets/infring_dashboard_client.js') {
        sendJson(res, 410, {
          ok: false,
          type: 'infring_dashboard_legacy_asset_removed',
          asset: pathname,
          error: 'legacy_dashboard_removed',
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/assets/infring_dashboard_fallback.js') {
        sendJson(res, 410, {
          ok: false,
          type: 'infring_dashboard_legacy_asset_removed',
          asset: pathname,
          error: 'legacy_dashboard_removed',
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/dashboard/snapshot') {
        const enforcement = enforceAgentContractsNow('api.snapshot');
        if (!enforcement || !enforcement.changed) {
          refreshSnapshot();
        }
        sendJson(res, 200, latestSnapshot);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        enforceAgentContractsNow('api.status');
        const agents = compatAgentsFromSnapshot(latestSnapshot);
        const runtimeSync = runtimeSyncSummary(latestSnapshot);
        sendJson(res, 200, {
          ok: true,
          version: APP_VERSION,
          agent_count: agents.length,
          connected: true,
          uptime_sec: 0,
          uptime_seconds: 0,
          ws: true,
          default_model:
            latestSnapshot &&
            latestSnapshot.app &&
            latestSnapshot.app.settings &&
            latestSnapshot.app.settings.model
              ? latestSnapshot.app.settings.model
              : 'gpt-5',
          api_listen: `${flags.host}:${flags.port}`,
          listen: `${flags.host}:${flags.port}`,
          home_dir: ROOT,
          log_level: cleanText(process.env.RUST_LOG || process.env.LOG_LEVEL || 'info', 24) || 'info',
          network_enabled: true,
          cli_mode: ACTIVE_CLI_MODE,
          runtime_sync: runtimeSync,
          agent_lifecycle: latestSnapshot && latestSnapshot.agent_lifecycle ? latestSnapshot.agent_lifecycle : null,
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/auth/check') {
        sendJson(res, 200, {
          ok: true,
          mode: 'none',
          user: 'operator',
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/config') {
        sendJson(res, 200, {
          ok: true,
          api_key: 'set',
          provider: latestSnapshot && latestSnapshot.app && latestSnapshot.app.settings
            ? latestSnapshot.app.settings.provider
            : 'openai',
          model: latestSnapshot && latestSnapshot.app && latestSnapshot.app.settings
            ? latestSnapshot.app.settings.model
            : 'gpt-5',
          cli_mode: ACTIVE_CLI_MODE,
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/models') {
        sendJson(res, 200, {
          ok: true,
          models: buildDashboardModels(latestSnapshot),
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/agents') {
        enforceAgentContractsNow('api.agents');
        sendJson(res, 200, compatAgentsFromSnapshot(latestSnapshot));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/agents/terminated') {
        const contractsState = loadAgentContractsState();
        const rows = Array.isArray(contractsState && contractsState.terminated_history)
          ? contractsState.terminated_history.slice(-50).reverse()
          : [];
        sendJson(res, 200, {
          ok: true,
          entries: rows,
        });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/agents') {
        const payload = await bodyJson(req);
        const ingress = currentIngressControl(latestSnapshot);
        if (ingress.delay_ms > 0) {
          await waitMs(ingress.delay_ms);
        }
        const requestedName = cleanText(payload && payload.name ? payload.name : '', 100);
        const role = cleanText(payload && payload.role ? payload.role : 'analyst', 60) || 'analyst';
        const shadow = requestedName || `ops-${role}-${Date.now()}`;
        const laneResult = runAction('collab.launchRole', { team: flags.team || DEFAULT_TEAM, role, shadow });
        writeActionReceipt('collab.launchRole', { team: flags.team || DEFAULT_TEAM, role, shadow }, laneResult);
        if (laneResult.ok) {
          unarchiveAgent(shadow);
          upsertAgentContract(
            shadow,
            payload,
            {
              owner: cleanText(
                payload && payload.owner ? payload.owner : `session:${cleanText(flags.team || DEFAULT_TEAM, 40)}`,
                120
              ),
              force: true,
            }
          );
        }
        refreshSnapshot();
        const created = compatAgentsFromSnapshot(latestSnapshot).find((row) => row.id === shadow) || {
          id: shadow,
          name: shadow,
          state: laneResult.ok ? 'running' : 'error',
          model_name:
            latestSnapshot && latestSnapshot.app && latestSnapshot.app.settings
              ? latestSnapshot.app.settings.model
              : 'gpt-5',
        };
        created.contract = contractSummary(contractForAgent(shadow));
        sendJson(res, laneResult.ok ? 200 : 400, created);
        return;
      }
      if (pathname.startsWith('/api/agents/')) {
        enforceAgentContractsNow('api.agent_scope');
        const parts = pathname.split('/').filter(Boolean);
        const agentId = cleanText(parts[2] || '', 140);
        if (req.method === 'GET' && parts.length === 3) {
          const archivedMeta = archivedAgentMeta(agentId);
          if (archivedMeta) {
            sendJson(res, 200, inactiveAgentRecord(agentId, latestSnapshot, archivedMeta));
            return;
          }
          const agent = compatAgentsFromSnapshot(latestSnapshot).find((row) => row.id === agentId);
          if (!agent) {
            sendJson(res, 404, { ok: false, error: 'agent_not_found', id: agentId });
            return;
          }
          sendJson(res, 200, agent);
          return;
        }
        if (req.method === 'DELETE' && parts.length === 3) {
          const known = compatAgentsFromSnapshot(latestSnapshot, { includeArchived: true }).some((row) => row.id === agentId);
          const alreadyArchived = isAgentArchived(agentId);
          if (!known && !alreadyArchived) {
            sendJson(res, 404, { ok: false, error: 'agent_not_found', id: agentId });
            return;
          }
          const termination = terminateAgentForContract(agentId, latestSnapshot, 'chat_archive', {
            source: 'api.delete',
            terminated_by: 'user_archive',
            team: cleanText(flags.team || DEFAULT_TEAM, 40) || DEFAULT_TEAM,
          });
          const archivedMeta = archivedAgentMeta(agentId) || archiveAgent(agentId, { source: 'api.delete', reason: 'chat_archive' });
          closeTerminalSession(agentId, 'agent_archived');
          closeAgentSockets(agentId, 'chat_archive');
          refreshSnapshot();
          sendJson(res, 200, {
            ok: true,
            id: agentId,
            state: 'inactive',
            archived: true,
            archived_at: archivedMeta ? archivedMeta.archived_at : '',
            contract_terminated: !!(termination && termination.terminated),
            type: 'agent_archived',
          });
          return;
        }
        if (req.method === 'POST' && parts[3] === 'revoke') {
          const known = compatAgentsFromSnapshot(latestSnapshot, { includeArchived: true }).some((row) => row.id === agentId);
          if (!known && !isAgentArchived(agentId)) {
            sendJson(res, 404, { ok: false, error: 'agent_not_found', id: agentId });
            return;
          }
          markContractRevocation(agentId, 'manual_revoke');
          const termination = terminateAgentForContract(agentId, latestSnapshot, 'manual_revocation', {
            source: 'api.revoke',
            terminated_by: 'manual_revoke',
            team: cleanText(flags.team || DEFAULT_TEAM, 40) || DEFAULT_TEAM,
          });
          closeAgentSockets(agentId, 'manual_revocation');
          refreshSnapshot();
          sendJson(res, termination && termination.terminated ? 200 : 409, {
            ok: !!(termination && termination.terminated),
            id: agentId,
            state: 'inactive',
            archived: isAgentArchived(agentId),
            reason: 'manual_revocation',
            contract: contractSummary(contractForAgent(agentId)),
          });
          return;
        }
        if (req.method === 'POST' && parts[3] === 'complete') {
          const known = compatAgentsFromSnapshot(latestSnapshot, { includeArchived: true }).some((row) => row.id === agentId);
          if (!known && !isAgentArchived(agentId)) {
            sendJson(res, 404, { ok: false, error: 'agent_not_found', id: agentId });
            return;
          }
          const contract = markContractCompletion(agentId, 'supervisor_signal');
          const termination = terminateAgentForContract(agentId, latestSnapshot, 'task_complete', {
            source: 'api.complete',
            terminated_by: 'supervisor_signal',
            team: cleanText(flags.team || DEFAULT_TEAM, 40) || DEFAULT_TEAM,
          });
          if (termination && termination.terminated) {
            closeAgentSockets(agentId, 'task_complete');
          }
          refreshSnapshot();
          sendJson(res, termination && termination.terminated ? 200 : 409, {
            ok: !!(termination && termination.terminated),
            id: agentId,
            reason: 'task_complete',
            contract: contractSummary(contract || contractForAgent(agentId)),
          });
          return;
        }
        if (req.method === 'POST' && parts[3] === 'revive') {
          const payload = await bodyJson(req);
          const archivedMeta = archivedAgentMeta(agentId);
          if (!archivedMeta) {
            sendJson(res, 404, { ok: false, error: 'agent_not_archived', id: agentId });
            return;
          }
          const role = cleanText(
            payload && payload.role ? payload.role : archivedMeta.role || 'analyst',
            60
          ) || 'analyst';
          const laneResult = runAction('collab.launchRole', {
            team: cleanText(flags.team || DEFAULT_TEAM, 40) || DEFAULT_TEAM,
            role,
            shadow: agentId,
          });
          writeActionReceipt('collab.launchRole', { team: flags.team || DEFAULT_TEAM, role, shadow: agentId }, laneResult);
          if (!laneResult.ok) {
            sendJson(res, 400, { ok: false, error: 'revive_launch_failed', id: agentId, lane: laneOutcome(laneResult) });
            return;
          }
          unarchiveAgent(agentId);
          const previous = contractForAgent(agentId);
          const nextContract = upsertAgentContract(
            agentId,
            {
              ...(payload && typeof payload === 'object' ? payload : {}),
              contract: {
                ...((payload && payload.contract && typeof payload.contract === 'object') ? payload.contract : {}),
                revived_from_contract_id: cleanText(previous && previous.contract_id ? previous.contract_id : '', 80),
                revival_data: archivedMeta && archivedMeta.revival_data ? archivedMeta.revival_data : buildAgentRevivalData(agentId),
              },
            },
            {
              owner: cleanText(payload && payload.owner ? payload.owner : archivedMeta.owner || 'dashboard_session', 120),
              force: true,
            }
          );
          const contractsState = loadAgentContractsState();
          if (Array.isArray(contractsState.terminated_history)) {
            contractsState.terminated_history = contractsState.terminated_history.map((row) => {
              if (!row || row.agent_id !== agentId || row.revived) return row;
              return { ...row, revived: true, revived_at: nowIso() };
            });
            saveAgentContractsState(contractsState);
          }
          refreshSnapshot();
          const revived = compatAgentsFromSnapshot(latestSnapshot).find((row) => row.id === agentId) || {
            id: agentId,
            name: agentId,
            state: 'running',
            role,
          };
          revived.contract = contractSummary(nextContract);
          sendJson(res, 200, {
            ok: true,
            id: agentId,
            revived: true,
            state: revived.state || 'running',
            role,
            contract: revived.contract,
          });
          return;
        }
        if (req.method === 'POST' && parts[3] === 'terminal') {
          const payload = await bodyJson(req);
          const known = compatAgentsFromSnapshot(latestSnapshot, { includeArchived: true }).some((row) => row.id === agentId);
          if (!known) {
            sendJson(res, 404, { ok: false, error: 'agent_not_found', id: agentId });
            return;
          }
          if (isAgentArchived(agentId)) {
            sendJson(res, 409, { ok: false, error: 'agent_inactive', id: agentId, state: 'inactive' });
            return;
          }
          const terminal = await runTerminalCommand(
            payload && (payload.command || payload.input || payload.message) ? payload.command || payload.input || payload.message : '',
            payload && payload.cwd ? payload.cwd : '',
            agentId
          );
          writeActionReceipt(
            'app.terminal',
            {
              agent_id: agentId,
              command: cleanText(terminal.command || '', 400),
              cwd: cleanText(terminal.cwd || '', 260),
              cli_mode: ACTIVE_CLI_MODE,
            },
            {
              ok: terminal.ok,
              status: terminal.status,
              argv: ['terminal', cleanText(terminal.command || '', 120)],
              payload: {
                ok: terminal.ok,
                type: 'terminal_command',
                exit_code: terminal.exit_code,
              },
            }
          );
          if (terminal.blocked) {
            sendJson(res, 400, {
              ok: false,
              error: 'terminal_blocked',
              message: terminal.message,
              cwd: terminal.cwd,
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            id: agentId,
            command: terminal.command,
            cwd: terminal.cwd,
            stdout: terminal.stdout,
            stderr: terminal.stderr,
            exit_code: terminal.exit_code,
            status: terminal.status,
            duration_ms: terminal.duration_ms,
          });
          return;
        }
        if (req.method === 'POST' && parts[3] === 'message') {
          const payload = await bodyJson(req);
          const input = payload && (payload.input || payload.message || payload.prompt || payload.text)
            ? payload.input || payload.message || payload.prompt || payload.text
            : '';
          const turn = runAgentMessage(agentId, input, latestSnapshot);
          if (!turn.ok && turn.error === 'agent_not_found') {
            sendJson(res, 404, { ok: false, error: 'agent_not_found', id: agentId });
            return;
          }
          if (!turn.ok && turn.error === 'message_required') {
            sendJson(res, 400, { ok: false, error: 'message_required' });
            return;
          }
          if (!turn.ok && turn.error === 'agent_inactive') {
            sendJson(res, 409, { ok: false, error: 'agent_inactive', id: agentId, state: 'inactive' });
            return;
          }
          if (!turn.ok) {
            sendJson(res, turn.status || 400, {
              ok: false,
              error: cleanText(turn.error || 'agent_message_failed', 120) || 'agent_message_failed',
              id: agentId,
              reason: cleanText(turn.reason || '', 120),
              detail: cleanText(turn.detail || '', 240),
              terminated: !!turn.terminated,
            });
            return;
          }
          writeActionReceipt(
            'app.chat',
            { input: turn.input, agent_id: agentId, session_id: turn.session_id, cli_mode: ACTIVE_CLI_MODE },
            turn.laneResult
          );
          refreshSnapshot();
          appendAgentConversation(agentId, latestSnapshot, turn.input, turn.response, turn.meta, turn.tools);
          sendJson(res, turn.status, {
            ok: turn.ok,
            agent_id: agentId,
            session_id: turn.session_id,
            response: turn.response,
            tools: turn.tools,
            turn: {
              role: 'agent',
              text: turn.response,
            },
            input_tokens: turn.input_tokens,
            output_tokens: turn.output_tokens,
            context_tokens: turn.context_tokens,
            context_window: turn.context_window,
            context_ratio: turn.context_ratio,
            context_pressure: turn.context_pressure,
            cost_usd: turn.cost_usd,
            iterations: turn.iterations,
            duration_ms: turn.duration_ms,
            runtime_sync: turn.runtime_sync || null,
          });
          return;
        }
        if (req.method === 'PUT' && parts[3] === 'model') {
          const payload = await bodyJson(req);
          const agent = compatAgentsFromSnapshot(latestSnapshot).find((row) => row.id === agentId);
          if (!agent) {
            sendJson(res, 404, { ok: false, error: 'agent_not_found', id: agentId });
            return;
          }
          const requested = cleanText(
            payload && payload.model != null ? payload.model : '',
            120
          );
          const state = loadAgentSession(agentId, latestSnapshot);
          state.model_override = requested && requested.toLowerCase() !== 'auto' ? requested : 'auto';
          saveAgentSession(agentId, state);
          const resolved = effectiveAgentModel(agentId, latestSnapshot);
          sendJson(res, 200, {
            ok: true,
            id: agentId,
            model: resolved.selected,
            provider: resolved.provider,
            runtime_model: resolved.runtime_model,
            context_window: resolved.context_window,
          });
          return;
        }
        if (req.method === 'GET' && parts[3] === 'session') {
          const state = loadAgentSession(agentId, latestSnapshot);
          const session = activeSession(state);
          sendJson(res, 200, {
            ok: true,
            id: agentId,
            session_id: session.session_id,
            messages: Array.isArray(session.messages) ? session.messages : [],
          });
          return;
        }
        if (req.method === 'POST' && parts[3] === 'session' && parts[4] === 'reset') {
          const state = loadAgentSession(agentId, latestSnapshot);
          const session = activeSession(state);
          session.messages = [];
          session.updated_at = nowIso();
          saveAgentSession(agentId, state);
          sendJson(res, 200, { ok: true, id: agentId, message: 'Session reset' });
          return;
        }
        if (req.method === 'POST' && parts[3] === 'session' && parts[4] === 'compact') {
          compactAgentConversation(agentId, latestSnapshot);
          sendJson(res, 200, { ok: true, id: agentId, message: 'Session compacted' });
          return;
        }
        if (req.method === 'GET' && parts[3] === 'sessions') {
          const state = loadAgentSession(agentId, latestSnapshot);
          sendJson(res, 200, {
            ok: true,
            id: agentId,
            sessions: sessionList(state),
            active_session_id: state.active_session_id,
          });
          return;
        }
        if (req.method === 'POST' && parts[3] === 'sessions' && parts.length === 4) {
          const payload = await bodyJson(req);
          const state = loadAgentSession(agentId, latestSnapshot);
          const sessionId = `session_${Date.now().toString(36)}`;
          const label =
            cleanText(payload && payload.label ? payload.label : '', 80) ||
            `Session ${state.sessions.length + 1}`;
          state.sessions.push({
            session_id: sessionId,
            label,
            created_at: nowIso(),
            updated_at: nowIso(),
            messages: [],
          });
          state.active_session_id = sessionId;
          saveAgentSession(agentId, state);
          sendJson(res, 200, {
            ok: true,
            id: agentId,
            created: sessionId,
            sessions: sessionList(state),
            active_session_id: state.active_session_id,
          });
          return;
        }
        if (
          req.method === 'POST' &&
          parts[3] === 'sessions' &&
          parts.length >= 6 &&
          parts[5] === 'switch'
        ) {
          const targetSessionId = cleanText(parts[4] || '', 80);
          const state = loadAgentSession(agentId, latestSnapshot);
          const exists = state.sessions.some((session) => session.session_id === targetSessionId);
          if (!exists) {
            sendJson(res, 404, { ok: false, error: 'session_not_found', session_id: targetSessionId });
            return;
          }
          state.active_session_id = targetSessionId;
          saveAgentSession(agentId, state);
          const session = activeSession(state);
          sendJson(res, 200, {
            ok: true,
            id: agentId,
            session_id: targetSessionId,
            messages: Array.isArray(session.messages) ? session.messages : [],
            sessions: sessionList(state),
          });
          return;
        }
        if (req.method === 'POST' && parts[3] === 'stop') {
          const known = compatAgentsFromSnapshot(latestSnapshot, { includeArchived: true }).some((row) => row.id === agentId);
          if (!known && !isAgentArchived(agentId)) {
            sendJson(res, 404, { ok: false, error: 'agent_not_found', id: agentId });
            return;
          }
          const archivedMeta = archivedAgentMeta(agentId);
          if (archivedMeta || isAgentArchived(agentId)) {
            sendJson(res, 409, {
              ok: false,
              error: 'agent_inactive',
              id: agentId,
              state: 'inactive',
              archived: true,
              archived_at: archivedMeta && archivedMeta.archived_at ? archivedMeta.archived_at : '',
              reason: archivedMeta && archivedMeta.reason ? archivedMeta.reason : 'archived',
              type: 'agent_archived',
            });
            return;
          }
          const contract = contractForAgent(agentId);
          const contractStatus = cleanText(contract && contract.status ? contract.status : 'active', 40).toLowerCase();
          if (contractStatus && contractStatus !== 'active') {
            sendJson(res, 409, {
              ok: false,
              error: 'agent_contract_terminated',
              id: agentId,
              state: 'inactive',
              contract_terminated: true,
              reason: cleanText(contract && contract.termination_reason ? contract.termination_reason : contractStatus, 120),
              contract: contractSummary(contract),
            });
            return;
          }
          writeActionReceipt(
            'app.stop',
            { agent_id: agentId, source: 'chat_stop', cli_mode: ACTIVE_CLI_MODE },
            {
              ok: true,
              status: 0,
              argv: ['agent', 'stop', `--agent=${agentId}`],
              payload: {
                ok: true,
                type: 'agent_stop_ack',
                state: 'running',
              },
            }
          );
          sendJson(res, 200, {
            ok: true,
            id: agentId,
            state: 'running',
            type: 'agent_stop_ack',
            message: 'Run cancelled',
            contract: contractSummary(contract),
          });
          return;
        }
        if (
          req.method === 'PATCH' &&
          (parts[3] === 'identity' || parts[3] === 'config')
        ) {
          const payload = await bodyJson(req);
          const known = compatAgentsFromSnapshot(latestSnapshot, { includeArchived: true }).some((row) => row.id === agentId);
          if (!known && !isAgentArchived(agentId)) {
            sendJson(res, 404, { ok: false, error: 'agent_not_found', id: agentId });
            return;
          }
          const raw = payload && typeof payload === 'object' ? payload : {};
          const identitySource =
            raw.identity && typeof raw.identity === 'object' ? raw.identity : raw;
          const patch = {};

          if (Object.prototype.hasOwnProperty.call(raw, 'name')) {
            patch.name = cleanText(raw.name, 100);
          }
          if (
            parts[3] === 'config' &&
            Object.prototype.hasOwnProperty.call(raw, 'system_prompt')
          ) {
            patch.system_prompt = cleanText(raw.system_prompt, 4000);
          }
          if (
            parts[3] === 'config' &&
            Object.prototype.hasOwnProperty.call(raw, 'role')
          ) {
            patch.role = cleanText(raw.role, 60);
          }
          if (
            parts[3] === 'config' &&
            Object.prototype.hasOwnProperty.call(raw, 'fallback_models')
          ) {
            patch.fallback_models = normalizeAgentFallbackModels(raw.fallback_models);
          }

          const identityPatch = {};
          if (Object.prototype.hasOwnProperty.call(identitySource, 'emoji')) {
            identityPatch.emoji = cleanText(identitySource.emoji, 24);
          }
          if (Object.prototype.hasOwnProperty.call(identitySource, 'color')) {
            identityPatch.color = normalizeIdentityColor(identitySource.color, '#2563EB');
          }
          if (Object.prototype.hasOwnProperty.call(identitySource, 'archetype')) {
            identityPatch.archetype = cleanText(identitySource.archetype, 80);
          }
          if (Object.prototype.hasOwnProperty.call(identitySource, 'vibe')) {
            identityPatch.vibe = cleanText(identitySource.vibe, 80);
          }
          if (Object.keys(identityPatch).length > 0) {
            patch.identity = identityPatch;
          }

          const profile = upsertAgentProfile(agentId, patch);
          writeActionReceipt(
            `app.agent.${parts[3]}`,
            {
              agent_id: agentId,
              payload_keys: Object.keys(raw || {}),
              cli_mode: ACTIVE_CLI_MODE,
            },
            {
              ok: !!profile,
              status: profile ? 0 : 1,
              argv: ['agent', parts[3], `--agent=${agentId}`],
              payload: {
                ok: !!profile,
                type: 'agent_profile_update',
                section: parts[3],
              },
            }
          );
          if (!profile) {
            sendJson(res, 500, { ok: false, error: 'agent_profile_update_failed', id: agentId });
            return;
          }

          refreshSnapshot();
          const archivedMeta = archivedAgentMeta(agentId);
          const updated =
            archivedMeta
              ? inactiveAgentRecord(agentId, latestSnapshot, archivedMeta)
              : compatAgentsFromSnapshot(latestSnapshot, { includeArchived: true }).find((row) => row.id === agentId) || null;
          sendJson(res, 200, {
            ok: true,
            id: agentId,
            type: 'agent_profile_update',
            section: parts[3],
            profile,
            agent: updated,
          });
          return;
        }
        if (req.method === 'POST' && parts[3] === 'clone') {
          sendJson(res, 200, { ok: true, id: agentId, type: 'infring_external_compat_stub' });
          return;
        }
      }
      if (req.method === 'POST' && pathname === '/api/dashboard/action') {
        const payload = await bodyJson(req);
        const action = cleanText(payload && payload.action ? payload.action : '', 80);
        const actionPayload = payload && payload.payload && typeof payload.payload === 'object' ? payload.payload : {};
        const ingress = currentIngressControl(latestSnapshot);
        if (ingress.delay_ms > 0) {
          await waitMs(ingress.delay_ms);
        }
        if (ingress.reject_non_critical && !isCriticalDashboardAction(action)) {
          sendJson(res, 429, {
            ok: false,
            type: 'infring_dashboard_action_response',
            error: 'ingress_backpressure_active',
            action,
            ingress_control: ingress,
            queue_depth: runtimeSyncSummary(latestSnapshot).queue_depth,
            message: 'Non-critical actions are temporarily blocked while queue backpressure is active.',
          });
          return;
        }
        if (
          action === 'dashboard.runtime.executeSwarmRecommendation' ||
          action === 'dashboard.runtime.applyTelemetryRemediations'
        ) {
          const lanePayload = executeRuntimeSwarmRecommendation(latestSnapshot);
          const laneResult = {
            ok: !!lanePayload.ok,
            status: lanePayload.ok ? 0 : 1,
            argv: [action],
            payload: lanePayload,
          };
          const actionReceipt = writeActionReceipt(action, actionPayload, laneResult);
          refreshSnapshot();
          sendJson(res, lanePayload.ok ? 200 : 400, {
            ok: !!lanePayload.ok,
            type: 'infring_dashboard_action_response',
            action,
            action_receipt: actionReceipt,
            lane: lanePayload,
            snapshot: latestSnapshot,
          });
          return;
        }
        if (action === 'app.chat') {
          const input =
            actionPayload &&
            (actionPayload.input || actionPayload.message || actionPayload.prompt || actionPayload.text)
              ? actionPayload.input || actionPayload.message || actionPayload.prompt || actionPayload.text
              : '';
          const requestedAgentId =
            cleanText(
              actionPayload && (actionPayload.agent_id || actionPayload.agentId)
                ? actionPayload.agent_id || actionPayload.agentId
                : '',
              140
            ) || '';
          const turn = runAgentMessage(requestedAgentId, input, latestSnapshot, { allowFallback: true });
          const lanePayload = {
            ok: turn.ok,
            type: 'infring_dashboard_runtime_chat',
            response: turn.response || '',
            session_id: turn.session_id || '',
            agent_id: turn.agent_id || requestedAgentId || 'chat-ui-default-agent',
            turn: {
              turn_id: `turn_${sha256(`${turn.agent_id || requestedAgentId || 'chat-ui-default-agent'}:${Date.now()}`).slice(0, 10)}`,
              user: turn.input || '',
              assistant: turn.response || '',
              ts: nowIso(),
              status: turn.lane_ok ? 'complete' : 'degraded',
              provider: providerForModelName(turn.model, configuredProvider(latestSnapshot)),
              model: turn.model || configuredOllamaModel(latestSnapshot),
            },
            tools: Array.isArray(turn.tools) ? turn.tools : [],
            input_tokens: parseNonNegativeInt(turn.input_tokens, 0, 1000000000),
            output_tokens: parseNonNegativeInt(turn.output_tokens, 0, 1000000000),
            context_tokens: parseNonNegativeInt(turn.context_tokens, 0, 1000000000),
            context_window: parsePositiveInt(turn.context_window, DEFAULT_CONTEXT_WINDOW_TOKENS, 1024, 8000000),
            context_ratio: Number.isFinite(Number(turn.context_ratio)) ? Number(turn.context_ratio) : 0,
            context_pressure: cleanText(turn.context_pressure || '', 24) || 'low',
            cost_usd: Number.isFinite(Number(turn.cost_usd)) ? Number(turn.cost_usd) : 0,
            iterations: parsePositiveInt(turn.iterations, 1, 1, 12),
            duration_ms: parsePositiveInt(turn.duration_ms, 0, 0, 3600000),
            backend: cleanText(turn.backend || '', 40),
            meta: cleanText(turn.meta || '', 220),
            runtime_sync: turn.runtime_sync || null,
            error: turn && turn.error ? cleanText(turn.error, 120) : '',
          };
          const laneResult =
            turn && turn.laneResult && typeof turn.laneResult === 'object'
              ? turn.laneResult
              : {
                  ok: turn.ok,
                  status: turn.ok ? 0 : 1,
                  argv: ['infring_dashboard_runtime_chat'],
                  payload: lanePayload,
                };
          const actionReceipt = writeActionReceipt(
            'app.chat',
            {
              input: turn.input || cleanText(input || '', 2000),
              agent_id: turn.agent_id || requestedAgentId,
              session_id: turn.session_id || '',
              cli_mode: ACTIVE_CLI_MODE,
            },
            laneResult
          );
          refreshSnapshot();
          if (turn.ok) {
            appendAgentConversation(
              turn.agent_id || requestedAgentId,
              latestSnapshot,
              turn.input || cleanText(input || '', 4000),
              turn.response || '',
              turn.meta || '',
              turn.tools
            );
          }
          sendJson(
            res,
            turn.ok
              ? 200
              : turn.error === 'agent_inactive' || turn.error === 'agent_contract_terminated'
                ? 409
                : 400,
            {
              ok: turn.ok,
              type: 'infring_dashboard_action_response',
              action,
              action_receipt: actionReceipt,
              lane: lanePayload,
              snapshot: latestSnapshot,
            }
          );
          return;
        }
        const laneResult = runAction(action, actionPayload);
        const actionReceipt = writeActionReceipt(action, actionPayload, laneResult);
        refreshSnapshot();
        const ok = !!laneResult.ok;
        sendJson(res, ok ? 200 : 400, {
          ok,
          type: 'infring_dashboard_action_response',
          action,
          action_receipt: actionReceipt,
          lane: laneResult.payload || null,
          snapshot: latestSnapshot,
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, {
          ok: true,
          type: 'infring_dashboard_healthz',
          ts: nowIso(),
          receipt_hash: latestSnapshot.receipt_hash,
        });
        return;
      }
      if (req.method === 'GET') {
        const compatPayload = compatApiPayload(pathname, reqUrl, latestSnapshot);
        if (compatPayload) {
          sendJson(res, 200, compatPayload);
          return;
        }
      }
      if (pathname.startsWith('/api/')) {
        sendJson(res, 200, {
          ok: true,
          type: 'infring_external_compat_stub',
          path: pathname,
        });
        return;
      }
      sendJson(res, 404, {
        ok: false,
        type: 'infring_dashboard_not_found',
        path: pathname,
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        type: 'infring_dashboard_request_error',
        error: cleanText(error && error.message ? error.message : String(error), 260),
      });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const agentWss = new WebSocketServer({ noServer: true });
  const wsClients = new Set();
  const agentWsClients = new Map();

  const sendWs = (socket, payload) => {
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {}
  };

  const broadcastSnapshot = () => {
    const envelope = JSON.stringify({ type: 'snapshot', snapshot: latestSnapshot });
    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(envelope);
      }
    }
  };

  const closeAgentSockets = (agentId, reason = 'agent_inactive') => {
    const id = String(agentId || '');
    if (!id) return 0;
    let closed = 0;
    for (const [socket, socketAgentId] of agentWsClients.entries()) {
      if (String(socketAgentId) !== id) continue;
      sendWs(socket, { type: 'agent_archived', agent_id: id, ts: nowIso(), reason });
      try { socket.close(1008, reason); } catch {}
      agentWsClients.delete(socket);
      closed += 1;
    }
    return closed;
  };

  const enforceAgentContractsNow = (source = 'api') => {
    if (enforcingContracts) return null;
    enforcingContracts = true;
    try {
      const enforcement = enforceAgentContracts(latestSnapshot, {
        team: cleanText(flags.team || DEFAULT_TEAM, 40) || DEFAULT_TEAM,
      });
      const terminated = Array.isArray(enforcement && enforcement.terminated) ? enforcement.terminated : [];
      if (terminated.length > 0) {
        for (const row of terminated) {
          closeAgentSockets(
            row && row.agent_id ? row.agent_id : '',
            `agent_contract_${cleanText(row && row.reason ? row.reason : 'terminated', 80)}`
          );
        }
      }
      if (enforcement && enforcement.changed) {
        refreshSnapshot(enforcement);
        if (source !== 'silent') {
          broadcastSnapshot();
        }
      }
      return enforcement;
    } catch {
      return null;
    } finally {
      enforcingContracts = false;
    }
  };

  const maybeRunAutonomousSelfHeal = (source = 'interval') => {
    const runtime = runtimeSyncSummary(latestSnapshot);
    const queueVelocityPerMin = queueDepthVelocity(runtimeTrendSeries);
    const stall = runtimeStallSignals(runtime, runtimeTrendSeries);
    const signalFloor = Math.max(
      RUNTIME_STALL_CONDUIT_FLOOR,
      Math.floor(Math.max(1, runtime.target_conduit_signals) * 0.5)
    );
    const emergency =
      runtime.queue_depth >= RUNTIME_INGRESS_CIRCUIT_DEPTH ||
      runtime.cockpit_stale_blocks > 0 ||
      (runtime.queue_depth >= RUNTIME_DRAIN_TRIGGER_DEPTH && runtime.conduit_signals < signalFloor) ||
      queueVelocityPerMin >= 4 ||
      stall.detected;
    const required =
      runtime.queue_depth >= RUNTIME_DRAIN_TRIGGER_DEPTH ||
      runtime.critical_attention_total >= RUNTIME_CRITICAL_ESCALATION_THRESHOLD ||
      runtime.health_coverage_gap_count > 0 ||
      runtime.conduit_scale_required ||
      runtime.cockpit_stale_blocks > 0 ||
      cleanText(runtime && runtime.ingress_level ? runtime.ingress_level : '', 24) === 'circuit' ||
      queueVelocityPerMin >= 2 ||
      stall.detected;
    const cadenceMs = emergency
      ? RUNTIME_AUTONOMY_HEAL_EMERGENCY_INTERVAL_MS
      : RUNTIME_AUTONOMY_HEAL_INTERVAL_MS;
    const nowMs = Date.now();
    if (!required) {
      runtimeAutohealState.last_result = 'idle';
      runtimeAutohealState.last_stage = 'idle';
      runtimeAutohealState.last_stall_detected = false;
      runtimeAutohealState.last_stall_signature = '';
      return {
        executed: false,
        required,
        emergency,
        cadence_ms: cadenceMs,
        queue_velocity_per_min: queueVelocityPerMin,
        stall,
      };
    }
    if ((nowMs - parseNonNegativeInt(runtimeAutohealState.last_run_ms, 0, 1000000000000)) < cadenceMs) {
      runtimeAutohealState.last_result = 'cooldown';
      runtimeAutohealState.last_stage = 'cooldown';
      runtimeAutohealState.last_stall_detected = !!stall.detected;
      runtimeAutohealState.last_stall_signature = cleanText(stall.signature || '', 240);
      return {
        executed: false,
        required,
        emergency,
        cadence_ms: cadenceMs,
        queue_velocity_per_min: queueVelocityPerMin,
        stall,
      };
    }

    const lanePayload = executeRuntimeSwarmRecommendation(latestSnapshot);
    let stage = 'recommendation';
    let stallRecovery = null;
    let ok = !!(lanePayload && lanePayload.ok);
    if (
      stall.detected &&
      parseNonNegativeInt(runtimeAutohealState.failure_count, 0, 100000000) >=
        RUNTIME_STALL_ESCALATION_FAILURE_THRESHOLD
    ) {
      stage = 'stall_recovery';
      stallRecovery = runStallRecovery(runtime, flags.team || DEFAULT_TEAM);
      ok = ok && !!(stallRecovery && stallRecovery.ok);
    }

    runtimeAutohealState.last_run_ms = nowMs;
    runtimeAutohealState.last_run_at = nowIso();
    runtimeAutohealState.last_result = ok ? 'executed' : 'degraded';
    runtimeAutohealState.last_stage = stage;
    runtimeAutohealState.last_stall_detected = !!stall.detected;
    runtimeAutohealState.last_stall_signature = cleanText(stall.signature || '', 240);
    runtimeAutohealState.failure_count = ok
      ? 0
      : parseNonNegativeInt(runtimeAutohealState.failure_count, 0, 100000000) + 1;
    return {
      executed: true,
      required,
      emergency,
      cadence_ms: cadenceMs,
      queue_velocity_per_min: queueVelocityPerMin,
      ok,
      lane_payload: lanePayload,
      stall,
      stage,
      stall_recovery: stallRecovery,
      source,
    };
  };

  const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const streamAssistantText = async (socket, text) => {
    const output = String(text || '');
    if (!output.trim()) return false;
    if (!socket || socket.readyState !== 1) return false;
    const total = output.length;
    const targetChunks = Math.min(120, Math.max(18, Math.ceil(total / 20)));
    const baseChunkSize = Math.max(6, Math.ceil(total / targetChunks));
    let cursor = 0;
    let sent = false;
    while (cursor < total) {
      if (!socket || socket.readyState !== 1) break;
      let next = Math.min(total, cursor + baseChunkSize);
      while (
        next < total &&
        (next - cursor) < (baseChunkSize + 16) &&
        !/\s|[,.!?;:\n]/.test(output[next])
      ) {
        next += 1;
      }
      if (next <= cursor) next = Math.min(total, cursor + 1);
      const chunk = output.slice(cursor, next);
      sendWs(socket, { type: 'text_delta', content: chunk });
      sent = true;
      cursor = next;
      if (cursor < total) {
        await waitMs(chunk.indexOf('\n') >= 0 ? 18 : 10);
      }
    }
    return sent;
  };

  wss.on('connection', (socket) => {
    wsClients.add(socket);
    sendWs(socket, { type: 'snapshot', snapshot: latestSnapshot });
    socket.on('close', () => {
      wsClients.delete(socket);
    });
  });

  agentWss.on('connection', (socket, req, meta) => {
    const agentId = cleanText(meta && meta.agentId ? meta.agentId : '', 140);
    if (!agentId) {
      try { socket.close(1008, 'agent_required'); } catch {}
      return;
    }
    if (isAgentArchived(agentId)) {
      sendWs(socket, { type: 'error', content: 'Agent is inactive (archived).' });
      try { socket.close(1008, 'agent_inactive'); } catch {}
      return;
    }
    agentWsClients.set(socket, agentId);
    sendWs(socket, { type: 'connected', agent_id: agentId, ts: nowIso() });

    socket.on('message', async (raw) => {
      let payload = null;
      try {
        payload = JSON.parse(String(raw || '{}'));
      } catch {
        sendWs(socket, { type: 'error', content: 'Invalid websocket payload.' });
        return;
      }
      const eventType = cleanText(payload && payload.type ? payload.type : '', 40).toLowerCase();
      const isTerminalEvent =
        eventType === 'terminal' ||
        eventType === 'terminal_command' ||
        eventType === 'terminal_input' ||
        eventType === 'terminal-input';
      if (eventType === 'ping') {
        sendWs(socket, { type: 'pong', ts: nowIso() });
        return;
      }
      if (isTerminalEvent) {
        const terminal = await runTerminalCommand(
          payload && (payload.command || payload.input || payload.message)
            ? payload.command || payload.input || payload.message
            : '',
          payload && payload.cwd ? payload.cwd : '',
          agentId
        );
        writeActionReceipt(
          'app.terminal',
          {
            agent_id: agentId,
            command: cleanText(terminal.command || '', 400),
            cwd: cleanText(terminal.cwd || '', 260),
            cli_mode: ACTIVE_CLI_MODE,
          },
          {
            ok: terminal.ok,
            status: terminal.status,
            argv: ['terminal', cleanText(terminal.command || '', 120)],
            payload: {
              ok: terminal.ok,
              type: 'terminal_command',
              exit_code: terminal.exit_code,
            },
          }
        );
        if (terminal.blocked) {
          sendWs(socket, { type: 'terminal_error', message: terminal.message || 'Terminal blocked.' });
          return;
        }
        sendWs(socket, {
          type: 'terminal_output',
          command: terminal.command,
          cwd: terminal.cwd,
          stdout: terminal.stdout,
          stderr: terminal.stderr,
          exit_code: terminal.exit_code,
          status: terminal.status,
          duration_ms: terminal.duration_ms,
        });
        return;
      }
      if (eventType === 'command') {
        const command = cleanText(payload && payload.command ? payload.command : '', 40).toLowerCase();
        const silent = !!(payload && (payload.silent === true || payload.background === true || payload.poll === true));
        if (command === 'context') {
          const state = loadAgentSession(agentId, latestSnapshot);
          const session = activeSession(state);
          const messages = Array.isArray(session.messages) ? session.messages : [];
          const modelState = effectiveAgentModel(agentId, latestSnapshot);
          const contextStats = contextTelemetryForMessages(
            messages,
            modelState && modelState.context_window != null ? modelState.context_window : DEFAULT_CONTEXT_WINDOW_TOKENS,
            0
          );
          if (silent) {
            sendWs(socket, {
              type: 'context_state',
              silent: true,
              context_tokens: contextStats.context_tokens,
              context_window: contextStats.context_window,
              context_ratio: contextStats.context_ratio,
              context_pressure: contextStats.context_pressure,
            });
          } else {
            sendWs(socket, {
              type: 'command_result',
              message: `Context usage: ${messages.length} messages, ~${contextStats.context_tokens} tokens.`,
              context_tokens: contextStats.context_tokens,
              context_window: contextStats.context_window,
              context_ratio: contextStats.context_ratio,
              context_pressure: contextStats.context_pressure,
              silent: false,
            });
          }
          return;
        }
        if (command === 'verbose') {
          sendWs(socket, {
            type: 'command_result',
            message: 'Verbose mode is available in this dashboard and controlled client-side.',
          });
          return;
        }
        if (command === 'queue') {
          sendWs(socket, {
            type: 'command_result',
            message: 'Queue status: active websocket mode.',
          });
          return;
        }
        sendWs(socket, { type: 'command_result', message: `Unsupported command: ${command || 'unknown'}` });
        return;
      }
      if (eventType !== 'message') {
        sendWs(socket, { type: 'error', content: 'Unsupported websocket event type.' });
        return;
      }

      const input = payload && (payload.content || payload.input || payload.message)
        ? payload.content || payload.input || payload.message
        : '';
      const turn = runAgentMessage(agentId, input, latestSnapshot);
      if (!turn.ok && turn.error === 'message_required') {
        sendWs(socket, { type: 'error', content: 'Message required.' });
        return;
      }
      if (!turn.ok && turn.error === 'agent_not_found') {
        sendWs(socket, { type: 'error', content: 'Agent not found.' });
        return;
      }
      if (!turn.ok && turn.error === 'agent_inactive') {
        sendWs(socket, { type: 'error', content: 'Agent is inactive (archived).' });
        try { socket.close(1008, 'agent_inactive'); } catch {}
        return;
      }
      if (!turn.ok && turn.error === 'agent_contract_terminated') {
        const reason = cleanText(turn.reason || 'contract_terminated', 120) || 'contract_terminated';
        sendWs(socket, { type: 'error', content: `Agent contract terminated (${reason}).` });
        try { socket.close(1008, 'agent_contract_terminated'); } catch {}
        return;
      }
      if (!turn.ok) {
        sendWs(socket, { type: 'error', content: 'Agent message failed.' });
        return;
      }

      sendWs(socket, { type: 'phase', phase: 'thinking', detail: 'Thinking...' });
      const wsTools = Array.isArray(turn.tools) ? turn.tools : [];
      for (const tool of wsTools) {
        sendWs(socket, { type: 'tool_start', tool: tool.name || 'tool' });
        sendWs(socket, {
          type: 'tool_end',
          tool: tool.name || 'tool',
          input: tool.input || '',
        });
        sendWs(socket, {
          type: 'tool_result',
          tool: tool.name || 'tool',
          result: tool.result || '',
          is_error: !!tool.is_error,
        });
      }
      sendWs(socket, { type: 'phase', phase: 'streaming', detail: 'Streaming response...' });
      const didStreamResponse = await streamAssistantText(socket, turn.response);

      writeActionReceipt(
        'app.chat',
        { input: turn.input, agent_id: agentId, session_id: turn.session_id, cli_mode: ACTIVE_CLI_MODE },
        turn.laneResult
      );
      refreshSnapshot();
      appendAgentConversation(agentId, latestSnapshot, turn.input, turn.response, turn.meta, turn.tools);

      sendWs(socket, {
        type: 'response',
        content: didStreamResponse ? '' : turn.response,
        input_tokens: turn.input_tokens,
        output_tokens: turn.output_tokens,
        context_tokens: turn.context_tokens,
        context_window: turn.context_window,
        context_ratio: turn.context_ratio,
        context_pressure: turn.context_pressure,
        cost_usd: turn.cost_usd,
        iterations: turn.iterations,
        duration_ms: turn.duration_ms,
        runtime_sync: turn.runtime_sync || null,
      });
    });

    socket.on('close', () => {
      agentWsClients.delete(socket);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const reqUrl = new URL(req.url || '/', `http://${flags.host}:${flags.port}`);
    if (reqUrl.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }
    const agentMatch = reqUrl.pathname.match(/^\/api\/agents\/([^/]+)\/ws$/);
    if (agentMatch && agentMatch[1]) {
      const agentId = cleanText(decodeURIComponent(agentMatch[1]), 140);
      if (!agentId) {
        socket.destroy();
        return;
      }
      agentWss.handleUpgrade(req, socket, head, (ws) => {
        agentWss.emit('connection', ws, req, { agentId });
      });
      return;
    }
    socket.destroy();
  });

  const interval = setInterval(() => {
    if (updating) return;
    updating = true;
    try {
      refreshSnapshot();
      const autoheal = maybeRunAutonomousSelfHeal('interval');
      if (autoheal && autoheal.executed) {
        refreshSnapshot();
      }
      broadcastSnapshot();
    } catch (error) {
      const envelope = JSON.stringify({
        type: 'snapshot_error',
        ts: nowIso(),
        error: cleanText(error && error.message ? error.message : String(error), 240),
      });
      for (const client of wsClients) {
        if (client.readyState === 1) {
          client.send(envelope);
        }
      }
    } finally {
      updating = false;
    }
  }, flags.refreshMs);

  const contractInterval = setInterval(() => {
    enforceAgentContractsNow('interval');
  }, AGENT_CONTRACT_ENFORCE_INTERVAL_MS);

  server.listen(flags.port, flags.host, () => {
    const dashboardUrl = `http://${flags.host}:${flags.port}/dashboard`;
    const status = {
      ok: true,
      type: 'infring_dashboard_server',
      ts: nowIso(),
      url: dashboardUrl,
      dashboard_url: dashboardUrl,
      host: flags.host,
      port: flags.port,
      refresh_ms: flags.refreshMs,
      team: flags.team,
      cli_mode: ACTIVE_CLI_MODE,
      receipt_hash: latestSnapshot.receipt_hash,
      snapshot_path: path.relative(ROOT, SNAPSHOT_LATEST_PATH),
      action_path: path.relative(ROOT, ACTION_LATEST_PATH),
    };
    writeJson(path.resolve(STATE_DIR, 'server_status.json'), status);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    process.stdout.write(`Dashboard listening at ${dashboardUrl}\n`);
  });

  const shutdown = () => {
    clearInterval(interval);
    clearInterval(contractInterval);
    closeAllTerminalSessions('dashboard_shutdown');
    for (const client of wsClients) {
      try {
        client.close();
      } catch {}
    }
    for (const client of agentWsClients.keys()) {
      try {
        client.close();
      } catch {}
    }
    try {
      server.close();
    } catch {}
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return null;
}

function run(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  ACTIVE_CLI_MODE = normalizeCliMode(flags && flags.cliMode ? flags.cliMode : ACTIVE_CLI_MODE);
  if (flags.mode === 'snapshot' || flags.mode === 'status') {
    const snapshot = buildSnapshot(flags);
    writeSnapshotReceipt(snapshot);
    const body = `${JSON.stringify(snapshot, null, flags.pretty ? 2 : 0)}${flags.pretty ? '\n' : ''}`;
    // Sync write avoids truncation when parent captures stdout via spawnSync.
    fs.writeFileSync(1, body, 'utf8');
    return 0;
  }
  if (flags.mode === 'serve' || flags.mode === 'web') {
    runServe(flags);
    return null;
  }
  process.stderr.write(
    `infring_dashboard: unsupported mode ${flags.mode}. expected serve|snapshot|status\n`
  );
  return 2;
}

module.exports = {
  run,
  parseFlags,
  buildSnapshot,
  runAction,
};

if (require.main === module) {
  const exitCode = run(process.argv.slice(2));
  if (typeof exitCode === 'number') {
    process.exitCode = exitCode;
  }
}
