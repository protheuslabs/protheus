#!/usr/bin/env tsx
// Unified dashboard lane: TypeScript-first client UI over Rust-core authority.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { WebSocketServer } = require('ws');
const { ROOT } = require('../ops/run_protheus_ops.js');

const DASHBOARD_DIR = __dirname;
const OPS_BRIDGE_PATH = path.resolve(ROOT, 'client/runtime/systems/ops/run_protheus_ops.js');
const OPENCLAW_FORK_STATIC_DIR = path.resolve(
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
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const DEFAULT_TEAM = 'ops';
const DEFAULT_REFRESH_MS = 2000;
const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.txt', '.svg', '.map']);
const OLLAMA_BIN = 'ollama';
const OLLAMA_MODEL_FALLBACK = 'qwen2.5:3b';
const OLLAMA_TIMEOUT_MS = 45000;
const TOOL_ITERATION_LIMIT = 1;
const TOOL_OUTPUT_LIMIT = 5000;
const CLI_MODE_SAFE = 'safe';
const CLI_MODE_FULL_INFRING = 'full_infring';
const DEFAULT_CLI_MODE = CLI_MODE_FULL_INFRING;
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

function hasOpenclawForkUi() {
  return (
    fileExists(path.resolve(OPENCLAW_FORK_STATIC_DIR, 'index_head.html')) &&
    fileExists(path.resolve(OPENCLAW_FORK_STATIC_DIR, 'index_body.html'))
  );
}

function rebrandOpenclawText(text) {
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
  const tsPath = path.resolve(OPENCLAW_FORK_STATIC_DIR, `${basePathNoExt}.ts`);
  if (fileExists(tsPath)) {
    const source = readText(tsPath, '');
    if (source) return transpileForkTypeScript(source, tsPath);
  }

  const jsPath = path.resolve(OPENCLAW_FORK_STATIC_DIR, `${basePathNoExt}.js`);
  return readText(jsPath, '');
}

function buildOpenclawForkHtml() {
  const head = readText(path.resolve(OPENCLAW_FORK_STATIC_DIR, 'index_head.html'), '');
  const body = readText(path.resolve(OPENCLAW_FORK_STATIC_DIR, 'index_body.html'), '');
  if (!head || !body) return '';
  const cssTheme = readText(path.resolve(OPENCLAW_FORK_STATIC_DIR, 'css/theme.css'), '');
  const cssLayout = readText(path.resolve(OPENCLAW_FORK_STATIC_DIR, 'css/layout.css'), '');
  const cssComponents = readText(path.resolve(OPENCLAW_FORK_STATIC_DIR, 'css/components.css'), '');
  const cssGithubDark = readText(path.resolve(OPENCLAW_FORK_STATIC_DIR, 'vendor/github-dark.min.css'), '');
  const vendorMarked = readText(path.resolve(OPENCLAW_FORK_STATIC_DIR, 'vendor/marked.min.js'), '');
  const vendorHighlight = readText(path.resolve(OPENCLAW_FORK_STATIC_DIR, 'vendor/highlight.min.js'), '');
  const vendorChart = readText(path.resolve(OPENCLAW_FORK_STATIC_DIR, 'vendor/chart.umd.min.js'), '');
  const vendorAlpine = readText(path.resolve(OPENCLAW_FORK_STATIC_DIR, 'vendor/alpine.min.js'), '');
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
  return rebrandOpenclawText(html);
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

function readOpenclawForkAsset(pathname) {
  const requestPath = pathname === '/' || pathname === '/dashboard' ? '/index_body.html' : pathname;
  const relative = requestPath.replace(/^\/+/, '');
  const resolved = path.resolve(OPENCLAW_FORK_STATIC_DIR, relative);
  if (!resolved.startsWith(OPENCLAW_FORK_STATIC_DIR)) return null;
  if (!fileExists(resolved)) return null;
  const ext = path.extname(resolved).toLowerCase();
  const contentType = contentTypeForFile(resolved);
  if (TEXT_EXTENSIONS.has(ext)) {
    return {
      body: rebrandOpenclawText(readText(resolved, '')),
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
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
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

function tryDeterministicRepoAnswer(input) {
  const text = String(input || '').toLowerCase();
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
  if (!payload || typeof payload !== 'object') return null;
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
      reason: cleanText(payload.reason || '', 220),
    };
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
  rows.push({
    id: 'auto',
    provider: 'auto',
    display_name: 'Auto',
    tier: 'Balanced',
    available: true,
    supports_tools: true,
    supports_vision: false,
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
  if (override === 'auto') {
    return { selected: 'auto', provider: 'auto', runtime_model: defaultModel, runtime_provider: defaultProvider };
  }
  const normalized = cleanText(override, 120) || defaultModel;
  const runtimeModel = normalized.startsWith('ollama/')
    ? cleanText(normalized.replace(/^ollama\//, ''), 120) || defaultModel
    : normalized.includes('/')
      ? defaultModel
      : normalized;
  return {
    selected: normalized,
    provider: providerForModelName(normalized, 'ollama'),
    runtime_model: runtimeModel,
    runtime_provider: 'ollama',
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

function buildToolPrompt({ agent, session, input, toolSteps = [] }) {
  const transcript = promptTranscript(session) || '(empty)';
  const toolHistory = toolSteps.length
    ? toolSteps
        .map((step, idx) => `#${idx + 1} ${step.input}\nexit=${step.exit_code}\n${step.result}`)
        .join('\n\n')
    : '(none)';
  const agentName = cleanText(agent && (agent.name || agent.id) ? agent.name || agent.id : 'master-agent', 80);
  const fullInfring = ACTIVE_CLI_MODE === CLI_MODE_FULL_INFRING;
  return [
    'You are Infring runtime chat assistant.',
    `Active agent: ${agentName}`,
    'You can ask for a CLI command when needed.',
    'If the user asks for opinion, explanation, or casual chat, answer directly without tools.',
    'Only request a tool call when factual repo/runtime data is required.',
    'Return ONLY one JSON object with no markdown.',
    'Final answer schema:',
    '{"type":"final","response":"<text response to user>"}',
    'Tool call schema:',
    '{"type":"tool_call","command":"<allowed command>","args":["arg1","arg2"],"reason":"<short reason>"}',
    fullInfring
      ? 'Allowed commands: protheus/protheus-ops/infringd (all subcommands), plus git/rg/ls/cat/pwd/wc/head/tail/stat (git remains read-only).'
      : 'Allowed commands: protheus/protheus-ops/infringd (read-only profile), plus git/rg/ls/cat/pwd/wc/head/tail/stat (git read-only).',
    'If tool history already contains what you need, return final.',
    '',
    `Conversation transcript:\n${transcript}`,
    '',
    `Latest user message:\n${cleanText(input, 3600)}`,
    '',
    `Tool history:\n${toolHistory}`,
  ].join('\n');
}

function buildToolFollowupPrompt({ agent, input, toolStep }) {
  const agentName = cleanText(agent && (agent.name || agent.id) ? agent.name || agent.id : 'master-agent', 80);
  const toolSummary = toolStep
    ? `Tool: ${toolStep.input}\nExit: ${toolStep.exit_code}\nOutput:\n${cleanText(toolStep.result || '', 3600)}`
    : 'Tool: (none)';
  return [
    'You are Infring runtime chat assistant.',
    `Active agent: ${agentName}`,
    'Use the tool result to answer the user clearly.',
    'Return ONLY one JSON object with no markdown.',
    '{"type":"final","response":"<answer>"}',
    '',
    `User request:\n${cleanText(input, 3200)}`,
    '',
    toolSummary,
  ].join('\n');
}

function runLlmChatWithCli(agent, session, input, snapshot, requestedModel = '') {
  const deterministic = tryDeterministicRepoAnswer(input);
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
  const prompt = buildToolPrompt({ agent, session, input, toolSteps });
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

  const directive = extractJsonDirective(llm.output);
  if (!directive) {
    return {
      ok: true,
      status: 0,
      response: cleanText(llm.output, 4000),
      model,
      tools: [],
      iterations: 1,
    };
  }

  if (directive.type === 'final') {
    return {
      ok: true,
      status: 0,
      response: cleanText(directive.response || llm.output, 4000),
      model,
      tools: [],
      iterations: 1,
    };
  }

  if (directive.type === 'tool_call') {
    const toolStep = runCliTool(directive.command, directive.args);
    const normalizedTool = {
      id: `tool-${Date.now()}-0`,
      name: toolStep.name,
      input: toolStep.input,
      result: toolStep.result,
      is_error: !!toolStep.is_error,
      running: false,
      expanded: false,
      exit_code: toolStep.exit_code,
    };
    toolSteps.push(normalizedTool);

    const followPrompt = buildToolFollowupPrompt({ agent, input, toolStep: normalizedTool });
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
      finalResponse = toolStep.is_error
        ? `Tool execution failed: ${toolStep.result}`
        : cleanText(toolStep.result, 4000);
    }
    return {
      ok: true,
      status: 0,
      response: finalResponse,
      model,
      tools: toolSteps.map((row) => ({
        id: row.id,
        name: row.name,
        input: row.input,
        result: row.result,
        is_error: row.is_error,
        running: false,
        expanded: false,
      })),
      iterations: 2,
    };
  }

  return {
    ok: true,
    status: 0,
    response: cleanText(llm.output, 4000) || 'No response produced by the model.',
    model,
    tools: [],
    iterations: 1,
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

  const health = healthLane.payload || {};
  const app = appLane.payload || {};
  const collab = collabLane.payload || {};
  const skills = skillsLane.payload || {};

  const snapshot = {
    ok: !!(healthLane.ok && appLane.ok && collabLane.ok && skillsLane.ok),
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
      },
    },
    health,
    app,
    collab,
    skills,
    memory: {
      entries: collectMemoryArtifacts(),
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
  const receiptHash = sha256(JSON.stringify(snapshot));
  return { ...snapshot, receipt_hash: receiptHash };
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
    return runLane(['app-plane', 'run', '--app=chat-ui', `--input=${input}`]);
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

function compatAgentsFromSnapshot(snapshot) {
  const rows =
    snapshot &&
    snapshot.collab &&
    snapshot.collab.dashboard &&
    Array.isArray(snapshot.collab.dashboard.agents)
      ? snapshot.collab.dashboard.agents
      : [];
  return rows.map((row, idx) => {
    const id = cleanText(row && row.shadow ? row.shadow : `agent-${idx + 1}`, 120) || `agent-${idx + 1}`;
    const modelState = effectiveAgentModel(id, snapshot);
    const status = cleanText(row && row.status ? row.status : 'running', 40) || 'running';
    const state =
      status === 'paused' || status === 'stopped' ? status : status === 'error' ? 'error' : 'running';
    return {
      id,
      name: id,
      state,
      model_name: modelState.selected,
      model_provider: modelState.provider,
      runtime_model: modelState.runtime_model,
      role: cleanText(row && row.role ? row.role : 'analyst', 60) || 'analyst',
      identity: { emoji: '🤖', archetype: 'assistant' },
      capabilities: [],
    };
  });
}

function latestAssistantFromSnapshot(snapshot) {
  const turns = snapshot && snapshot.app && Array.isArray(snapshot.app.turns) ? snapshot.app.turns : [];
  if (turns.length === 0) return '';
  const last = turns[turns.length - 1] || {};
  return cleanText(last.assistant || last.response || last.output || '', 2000);
}

function htmlShell() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>InfRing Unified Dashboard</title>
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
  const forkUiEnabled = hasOpenclawForkUi();
  const html = forkUiEnabled ? buildOpenclawForkHtml() : htmlShell();
  const css = readText(CSS_PATH, '');
  const clientJs = transpileClientTs();
  const fallbackJs = transpileFallbackTs();
  let latestSnapshot = buildSnapshot(flags);
  writeSnapshotReceipt(latestSnapshot);
  let updating = false;

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${flags.host}:${flags.port}`);
    const pathname = reqUrl.pathname;

    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
        sendText(res, 200, html, 'text/html; charset=utf-8');
        return;
      }
      if (forkUiEnabled && req.method === 'GET') {
        const forkAsset = readOpenclawForkAsset(pathname);
        if (forkAsset) {
          sendText(res, 200, forkAsset.body, forkAsset.contentType);
          return;
        }
      }
      if (req.method === 'GET' && pathname === '/assets/infring_dashboard.css') {
        sendText(res, 200, css, 'text/css; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && pathname === '/assets/infring_dashboard_client.js') {
        sendText(res, 200, clientJs, 'text/javascript; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && pathname === '/assets/infring_dashboard_fallback.js') {
        sendText(res, 200, fallbackJs, 'text/javascript; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && pathname === '/api/dashboard/snapshot') {
        latestSnapshot = buildSnapshot(flags);
        writeSnapshotReceipt(latestSnapshot);
        sendJson(res, 200, latestSnapshot);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        const agents = compatAgentsFromSnapshot(latestSnapshot);
        sendJson(res, 200, {
          ok: true,
          version: 'infring-fork-ui',
          agent_count: agents.length,
          connected: true,
          uptime_sec: 0,
          ws: true,
          cli_mode: ACTIVE_CLI_MODE,
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
        sendJson(res, 200, compatAgentsFromSnapshot(latestSnapshot));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/agents') {
        const payload = await bodyJson(req);
        const requestedName = cleanText(payload && payload.name ? payload.name : '', 100);
        const role = cleanText(payload && payload.role ? payload.role : 'analyst', 60) || 'analyst';
        const shadow = requestedName || `ops-${role}-${Date.now()}`;
        const laneResult = runAction('collab.launchRole', { team: flags.team || DEFAULT_TEAM, role, shadow });
        writeActionReceipt('collab.launchRole', { team: flags.team || DEFAULT_TEAM, role, shadow }, laneResult);
        latestSnapshot = buildSnapshot(flags);
        writeSnapshotReceipt(latestSnapshot);
        const created = compatAgentsFromSnapshot(latestSnapshot).find((row) => row.id === shadow) || {
          id: shadow,
          name: shadow,
          state: laneResult.ok ? 'running' : 'error',
          model_name:
            latestSnapshot && latestSnapshot.app && latestSnapshot.app.settings
              ? latestSnapshot.app.settings.model
              : 'gpt-5',
        };
        sendJson(res, laneResult.ok ? 200 : 400, created);
        return;
      }
      if (pathname.startsWith('/api/agents/')) {
        const parts = pathname.split('/').filter(Boolean);
        const agentId = cleanText(parts[2] || '', 140);
        if (req.method === 'GET' && parts.length === 3) {
          const agent = compatAgentsFromSnapshot(latestSnapshot).find((row) => row.id === agentId);
          if (!agent) {
            sendJson(res, 404, { ok: false, error: 'agent_not_found', id: agentId });
            return;
          }
          sendJson(res, 200, agent);
          return;
        }
        if (req.method === 'DELETE' && parts.length === 3) {
          sendJson(res, 200, { ok: true, id: agentId, type: 'agent_delete_stub' });
          return;
        }
        if (req.method === 'POST' && parts[3] === 'message') {
          const payload = await bodyJson(req);
          const agent = compatAgentsFromSnapshot(latestSnapshot).find((row) => row.id === agentId);
          if (!agent) {
            sendJson(res, 404, { ok: false, error: 'agent_not_found', id: agentId });
            return;
          }
          const input = cleanText(
            payload && (payload.input || payload.message || payload.prompt || payload.text)
              ? payload.input || payload.message || payload.prompt || payload.text
              : '',
            4000
          );
          if (!input) {
            sendJson(res, 400, { ok: false, error: 'message_required' });
            return;
          }
          const state = loadAgentSession(agentId, latestSnapshot);
          const session = activeSession(state);
          const chatSessionId = runtimeChatSessionId(agentId, session.session_id);
          const modelState = effectiveAgentModel(agentId, latestSnapshot);
          const llmResult = runLlmChatWithCli(
            agent,
            session,
            input,
            latestSnapshot,
            modelState.runtime_model
          );
          let laneResult;
          let tools = [];
          let assistantRaw = '';
          let iterations = 1;
          if (llmResult && llmResult.ok) {
            tools = Array.isArray(llmResult.tools) ? llmResult.tools : [];
            assistantRaw = String(llmResult.response || '');
            iterations = parsePositiveInt(llmResult.iterations || 1, 1, 1, 8);
            laneResult = {
              ok: true,
              status: 0,
              stdout: '',
              stderr: '',
              argv: ['ollama', 'run', llmResult.model || OLLAMA_MODEL_FALLBACK],
              payload: {
                ok: true,
                type: 'infring_dashboard_ollama_chat',
                model: llmResult.model || OLLAMA_MODEL_FALLBACK,
                selected_model: modelState.selected,
                provider: modelState.provider,
                response: assistantRaw,
                tools,
                iterations,
                session_id: chatSessionId,
              },
            };
          } else {
            laneResult = runLane([
              'app-plane',
              'run',
              '--app=chat-ui',
              `--session-id=${chatSessionId}`,
              `--input=${input}`,
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
          writeActionReceipt(
            'app.chat',
            { input, agent_id: agentId, session_id: chatSessionId, cli_mode: ACTIVE_CLI_MODE },
            laneResult
          );
          latestSnapshot = buildSnapshot(flags);
          writeSnapshotReceipt(latestSnapshot);
          const assistant = assistantRaw.slice(0, 4000);
          const inputTokens = Math.max(1, Math.round(String(input).length / 4));
          const outputTokens = Math.max(1, Math.round(String(assistant || '').length / 4));
          const meta = `${inputTokens} in / ${outputTokens} out`;
          appendAgentConversation(agentId, latestSnapshot, input, assistant, meta, tools);
          sendJson(res, laneResult.ok ? 200 : 400, {
            ok: !!laneResult.ok,
            agent_id: agentId,
            session_id: chatSessionId,
            response: assistant,
            tools,
            turn: {
              role: 'agent',
              text: assistant,
            },
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cost_usd: 0,
            iterations,
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
        if (
          (req.method === 'POST' && parts[3] === 'stop') ||
          (req.method === 'POST' && parts[3] === 'clone') ||
          (req.method === 'PATCH' && parts[3] === 'identity') ||
          (req.method === 'PATCH' && parts[3] === 'config')
        ) {
          sendJson(res, 200, { ok: true, id: agentId, type: 'infring_openclaw_compat_stub' });
          return;
        }
      }
      if (req.method === 'POST' && pathname === '/api/dashboard/action') {
        const payload = await bodyJson(req);
        const action = cleanText(payload && payload.action ? payload.action : '', 80);
        const actionPayload = payload && payload.payload && typeof payload.payload === 'object' ? payload.payload : {};
        const laneResult = runAction(action, actionPayload);
        const actionReceipt = writeActionReceipt(action, actionPayload, laneResult);
        latestSnapshot = buildSnapshot(flags);
        writeSnapshotReceipt(latestSnapshot);
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
      if (pathname.startsWith('/api/')) {
        sendJson(res, 200, {
          ok: true,
          type: 'infring_openclaw_compat_stub',
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
  const wsClients = new Set();
  wss.on('connection', (socket) => {
    wsClients.add(socket);
    socket.send(JSON.stringify({ type: 'snapshot', snapshot: latestSnapshot }));
    socket.on('close', () => {
      wsClients.delete(socket);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const reqUrl = new URL(req.url || '/', `http://${flags.host}:${flags.port}`);
    if (reqUrl.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  const interval = setInterval(() => {
    if (updating) return;
    updating = true;
    try {
      latestSnapshot = buildSnapshot(flags);
      writeSnapshotReceipt(latestSnapshot);
      const envelope = JSON.stringify({ type: 'snapshot', snapshot: latestSnapshot });
      for (const client of wsClients) {
        if (client.readyState === 1) {
          client.send(envelope);
        }
      }
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

  server.listen(flags.port, flags.host, () => {
    const url = `http://${flags.host}:${flags.port}/dashboard`;
    const status = {
      ok: true,
      type: 'infring_dashboard_server',
      ts: nowIso(),
      url,
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
    process.stdout.write(`Dashboard listening at ${url}\n`);
  });

  const shutdown = () => {
    clearInterval(interval);
    for (const client of wsClients) {
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
