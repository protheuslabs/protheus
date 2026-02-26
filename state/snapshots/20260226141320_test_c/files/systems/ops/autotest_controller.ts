#!/usr/bin/env node
'use strict';

/**
 * systems/ops/autotest_controller.js
 *
 * Change-aware background testing controller:
 * - Maintains module->test registry with seeded module fields.
 * - Invalidates checked state when module fingerprint changes.
 * - Emits alerts for untested modules.
 * - Runs scoped tests (critical|changed|all) and writes user-friendly reports.
 * - Supports sleep-window pulse/daemon execution.
 *
 * Usage:
 *   node systems/ops/autotest_controller.js sync [--policy=path] [--strict=1|0]
 *   node systems/ops/autotest_controller.js run [--policy=path] [--scope=critical|changed|all] [--max-tests=N] [--strict=1|0] [--sleep-only=1|0] [--force=1|0] [--run-timeout-ms=N]
 *   node systems/ops/autotest_controller.js report [YYYY-MM-DD|latest] [--policy=path] [--write=1|0]
 *   node systems/ops/autotest_controller.js status [--policy=path]
 *   node systems/ops/autotest_controller.js pulse [--policy=path] [--scope=changed|critical|all] [--max-tests=N] [--strict=1|0] [--force=1|0] [--run-timeout-ms=N]
 *   node systems/ops/autotest_controller.js daemon [--policy=path] [--interval-sec=N] [--max-cycles=N] [--scope=changed|critical|all] [--max-tests=N] [--strict=1|0] [--run-timeout-ms=N]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
let emitPainSignal = null;
try {
  ({ emitPainSignal } = require('../autonomy/pain_signal.js'));
} catch {
  emitPainSignal = null;
}

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'autotest_policy.json');

function runtimePaths() {
  const stateDir = process.env.AUTOTEST_STATE_DIR
    ? path.resolve(process.env.AUTOTEST_STATE_DIR)
    : path.join(ROOT, 'state', 'ops', 'autotest');
  return {
    policy_path: process.env.AUTOTEST_POLICY_PATH
      ? path.resolve(process.env.AUTOTEST_POLICY_PATH)
      : DEFAULT_POLICY_PATH,
    state_dir: stateDir,
    registry_path: path.join(stateDir, 'registry.json'),
    status_path: path.join(stateDir, 'status.json'),
    events_path: path.join(stateDir, 'events.jsonl'),
    latest_path: path.join(stateDir, 'latest.json'),
    reports_dir: path.join(stateDir, 'reports'),
    runs_dir: path.join(stateDir, 'runs'),
    module_root: process.env.AUTOTEST_MODULE_ROOT
      ? path.resolve(process.env.AUTOTEST_MODULE_ROOT)
      : path.join(ROOT, 'systems'),
    test_root: process.env.AUTOTEST_TEST_ROOT
      ? path.resolve(process.env.AUTOTEST_TEST_ROOT)
      : path.join(ROOT, 'memory', 'tools', 'tests'),
    spine_runs_dir: process.env.AUTOTEST_SPINE_RUNS_DIR
      ? path.resolve(process.env.AUTOTEST_SPINE_RUNS_DIR)
      : path.join(ROOT, 'state', 'spine', 'runs')
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/autotest_controller.js sync [--policy=path] [--strict=1|0]');
  console.log('  node systems/ops/autotest_controller.js run [--policy=path] [--scope=critical|changed|all] [--max-tests=N] [--strict=1|0] [--sleep-only=1|0] [--force=1|0] [--run-timeout-ms=N]');
  console.log('  node systems/ops/autotest_controller.js report [YYYY-MM-DD|latest] [--policy=path] [--write=1|0]');
  console.log('  node systems/ops/autotest_controller.js status [--policy=path]');
  console.log('  node systems/ops/autotest_controller.js pulse [--policy=path] [--scope=changed|critical|all] [--max-tests=N] [--strict=1|0] [--force=1|0] [--run-timeout-ms=N]');
  console.log('  node systems/ops/autotest_controller.js daemon [--policy=path] [--interval-sec=N] [--max-cycles=N] [--scope=changed|critical|all] [--max-tests=N] [--strict=1|0] [--run-timeout-ms=N]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeToken(v, maxLen = 120) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function writeTextAtomic(filePath, text) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, text, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function relPath(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    module_discovery: {
      root: 'systems',
      include_ext: ['.ts'],
      ignore_prefixes: [
        'systems/ops/visualizer/'
      ]
    },
    test_discovery: {
      root: 'memory/tools/tests',
      include_suffix: '.test.js',
      ignore_prefixes: []
    },
    heuristics: {
      min_match_score: 4,
      min_token_len: 4,
      shared_token_score: 2,
      basename_contains_score: 4,
      layer_hint_score: 2
    },
    explicit_maps: {
      by_prefix: {
        'systems/security/': [
          'memory/tools/tests/security_integrity.test.js',
          'memory/tools/tests/guard_remote_gate.test.js',
          'memory/tools/tests/directive_gate.test.js'
        ],
        'systems/spine/': [
          'memory/tools/tests/spine_evidence_run_plan.test.js'
        ]
      }
    },
    critical_commands: [
      'node systems/ops/typecheck_systems.js',
      'node systems/ops/ts_clone_drift_guard.js --baseline=config/ts_clone_drift_baseline.json',
      'node systems/spine/contract_check.js'
    ],
    alerts: {
      emit_untested: true,
      emit_changed_without_tests: true,
      max_untested_in_report: 120,
      max_failed_in_report: 120
    },
    execution: {
      default_scope: 'changed',
      max_tests_per_run: 24,
      strict: false,
      timeout_ms_per_test: 180000,
      run_timeout_ms: 120000
    },
    sleep_window_local: {
      enabled: true,
      start_hour: 0,
      end_hour: 7
    },
    runtime_guard: {
      max_load_per_cpu: 0.75,
      max_rss_mb: 1600,
      spine_hot_window_sec: 75
    },
    daemon: {
      interval_sec: 900,
      max_cycles: 0,
      jitter_sec: 20
    }
  };
}

function loadPolicy(policyPathRaw) {
  const paths = runtimePaths();
  const policyPath = path.resolve(String(policyPathRaw || paths.policy_path || DEFAULT_POLICY_PATH));
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();

  const moduleDiscovery = raw.module_discovery && typeof raw.module_discovery === 'object'
    ? raw.module_discovery
    : {};
  const testDiscovery = raw.test_discovery && typeof raw.test_discovery === 'object'
    ? raw.test_discovery
    : {};
  const heuristics = raw.heuristics && typeof raw.heuristics === 'object'
    ? raw.heuristics
    : {};
  const explicitMaps = raw.explicit_maps && typeof raw.explicit_maps === 'object'
    ? raw.explicit_maps
    : {};
  const alerts = raw.alerts && typeof raw.alerts === 'object'
    ? raw.alerts
    : {};
  const execution = raw.execution && typeof raw.execution === 'object'
    ? raw.execution
    : {};
  const sleepWindow = raw.sleep_window_local && typeof raw.sleep_window_local === 'object'
    ? raw.sleep_window_local
    : {};
  const runtimeGuard = raw.runtime_guard && typeof raw.runtime_guard === 'object'
    ? raw.runtime_guard
    : {};
  const daemon = raw.daemon && typeof raw.daemon === 'object'
    ? raw.daemon
    : {};

  const normalizeList = (arr, fallback = []) => {
    const rows = Array.isArray(arr) ? arr : fallback;
    return rows
      .map((v) => normalizeToken(v, 260))
      .filter(Boolean);
  };

  const byPrefixRaw = explicitMaps.by_prefix && typeof explicitMaps.by_prefix === 'object'
    ? explicitMaps.by_prefix
    : {};
  const byPrefix = {};
  for (const [prefix, tests] of Object.entries(byPrefixRaw)) {
    const p = normalizeToken(prefix, 260);
    if (!p) continue;
    byPrefix[p] = normalizeList(tests, []);
  }

  const criticalCommandsRaw = Array.isArray(raw.critical_commands)
    ? raw.critical_commands
    : base.critical_commands;
  const criticalCommands = criticalCommandsRaw
    .map((cmd) => String(cmd == null ? '' : cmd).trim())
    .filter(Boolean)
    .slice(0, 200);

  return {
    path: policyPath,
    version: String(raw.version || base.version),
    enabled: raw.enabled !== false,
    module_discovery: {
      root: normalizeToken(moduleDiscovery.root || base.module_discovery.root, 260) || 'systems',
      include_ext: normalizeList(moduleDiscovery.include_ext, base.module_discovery.include_ext),
      ignore_prefixes: normalizeList(moduleDiscovery.ignore_prefixes, base.module_discovery.ignore_prefixes)
    },
    test_discovery: {
      root: normalizeToken(testDiscovery.root || base.test_discovery.root, 260) || 'memory/tools/tests',
      include_suffix: String(testDiscovery.include_suffix || base.test_discovery.include_suffix || '.test.js').trim() || '.test.js',
      ignore_prefixes: normalizeList(testDiscovery.ignore_prefixes, base.test_discovery.ignore_prefixes)
    },
    heuristics: {
      min_match_score: clampInt(heuristics.min_match_score, 1, 100, base.heuristics.min_match_score),
      min_token_len: clampInt(heuristics.min_token_len, 2, 20, base.heuristics.min_token_len),
      shared_token_score: clampInt(heuristics.shared_token_score, 0, 50, base.heuristics.shared_token_score),
      basename_contains_score: clampInt(heuristics.basename_contains_score, 0, 50, base.heuristics.basename_contains_score),
      layer_hint_score: clampInt(heuristics.layer_hint_score, 0, 50, base.heuristics.layer_hint_score)
    },
    explicit_maps: {
      by_prefix: byPrefix
    },
    critical_commands: criticalCommands,
    alerts: {
      emit_untested: alerts.emit_untested !== false,
      emit_changed_without_tests: alerts.emit_changed_without_tests !== false,
      max_untested_in_report: clampInt(alerts.max_untested_in_report, 1, 5000, base.alerts.max_untested_in_report),
      max_failed_in_report: clampInt(alerts.max_failed_in_report, 1, 5000, base.alerts.max_failed_in_report)
    },
    execution: {
      default_scope: ['critical', 'changed', 'all'].includes(String(execution.default_scope || ''))
        ? String(execution.default_scope)
        : base.execution.default_scope,
      max_tests_per_run: clampInt(execution.max_tests_per_run, 1, 500, base.execution.max_tests_per_run),
      strict: toBool(execution.strict, base.execution.strict),
      timeout_ms_per_test: clampInt(execution.timeout_ms_per_test, 1000, 30 * 60 * 1000, base.execution.timeout_ms_per_test),
      run_timeout_ms: clampInt(execution.run_timeout_ms, 1000, 2 * 60 * 60 * 1000, base.execution.run_timeout_ms)
    },
    sleep_window_local: {
      enabled: toBool(sleepWindow.enabled, base.sleep_window_local.enabled),
      start_hour: clampInt(sleepWindow.start_hour, 0, 23, base.sleep_window_local.start_hour),
      end_hour: clampInt(sleepWindow.end_hour, 0, 23, base.sleep_window_local.end_hour)
    },
    runtime_guard: {
      max_load_per_cpu: clampNumber(runtimeGuard.max_load_per_cpu, 0.05, 8, base.runtime_guard.max_load_per_cpu),
      max_rss_mb: clampInt(runtimeGuard.max_rss_mb, 128, 128000, base.runtime_guard.max_rss_mb),
      spine_hot_window_sec: clampInt(runtimeGuard.spine_hot_window_sec, 5, 3600, base.runtime_guard.spine_hot_window_sec)
    },
    daemon: {
      interval_sec: clampInt(daemon.interval_sec, 20, 24 * 60 * 60, base.daemon.interval_sec),
      max_cycles: clampInt(daemon.max_cycles, 0, 1000000, base.daemon.max_cycles),
      jitter_sec: clampInt(daemon.jitter_sec, 0, 600, base.daemon.jitter_sec)
    }
  };
}

function listFilesRecursively(rootDir, out = []) {
  if (!fs.existsSync(rootDir)) return out;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e) continue;
    const fp = path.join(rootDir, e.name);
    if (e.isDirectory()) {
      listFilesRecursively(fp, out);
      continue;
    }
    if (e.isFile()) out.push(fp);
  }
  return out;
}

function shouldIgnoreRel(rel, ignorePrefixes) {
  const normalized = normalizeToken(rel, 400);
  return (Array.isArray(ignorePrefixes) ? ignorePrefixes : [])
    .some((prefix) => normalized.startsWith(normalizeToken(prefix, 400)));
}

function moduleCandidates(paths, policy) {
  const root = process.env.AUTOTEST_MODULE_ROOT
    ? path.resolve(process.env.AUTOTEST_MODULE_ROOT)
    : path.join(ROOT, policy.module_discovery.root || 'systems');
  const includeExt = Array.isArray(policy.module_discovery.include_ext)
    ? policy.module_discovery.include_ext
    : ['.ts'];
  const rows = [];
  const files = listFilesRecursively(root, []);
  for (const abs of files) {
    const rel = relPath(abs);
    if (shouldIgnoreRel(rel, policy.module_discovery.ignore_prefixes)) continue;
    if (!includeExt.some((ext) => rel.endsWith(String(ext)))) continue;
    rows.push({
      id: stableId(`module|${rel}`, 'mod'),
      path: rel,
      abs_path: abs,
      ext: path.extname(rel),
      basename: path.basename(rel, path.extname(rel))
    });
  }
  return rows.sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

function testCandidates(paths, policy) {
  const root = process.env.AUTOTEST_TEST_ROOT
    ? path.resolve(process.env.AUTOTEST_TEST_ROOT)
    : path.join(ROOT, policy.test_discovery.root || 'memory/tools/tests');
  const suffix = String(policy.test_discovery.include_suffix || '.test.js');
  const rows = [];
  const files = listFilesRecursively(root, []);
  for (const abs of files) {
    const rel = relPath(abs);
    if (shouldIgnoreRel(rel, policy.test_discovery.ignore_prefixes)) continue;
    if (!rel.endsWith(suffix)) continue;
    const stem = path.basename(rel).slice(0, -suffix.length);
    rows.push({
      id: stableId(`test|${rel}`, 'tst'),
      kind: 'node_script',
      path: rel,
      abs_path: abs,
      stem,
      command: `node ${rel}`
    });
  }
  return rows.sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

function tokenizeName(v, minLen) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((tok) => tok && tok.length >= minLen);
}

function layerHint(rel) {
  const parts = String(rel || '').split('/');
  if (parts.length < 2) return null;
  if (parts[0] === 'systems') return parts[1] || null;
  return parts[0] || null;
}

function scoreModuleTestPair(mod, test, policy) {
  const h = policy.heuristics;
  const moduleBase = normalizeToken(mod.basename, 120);
  const testStem = normalizeToken(test.stem, 180);
  let score = 0;

  if (testStem.includes(moduleBase) || moduleBase.includes(testStem)) {
    score += h.basename_contains_score;
  }

  const modTokens = tokenizeName(moduleBase, h.min_token_len);
  const testTokens = new Set(tokenizeName(testStem, h.min_token_len));
  for (const tok of modTokens) {
    if (testTokens.has(tok)) score += h.shared_token_score;
  }

  const modLayer = layerHint(mod.path);
  if (modLayer && testStem.includes(normalizeToken(modLayer, 64))) {
    score += h.layer_hint_score;
  }

  return score;
}

function mapModuleTests(modules, tests, policy) {
  const explicit = policy.explicit_maps && policy.explicit_maps.by_prefix && typeof policy.explicit_maps.by_prefix === 'object'
    ? policy.explicit_maps.by_prefix
    : {};
  const byPath = new Map(tests.map((t) => [String(t.path), t]));

  const mapping = {};
  for (const mod of modules) {
    const testIds = new Set();

    for (const [prefix, testPaths] of Object.entries(explicit)) {
      if (!String(mod.path).startsWith(String(prefix))) continue;
      for (const p of Array.isArray(testPaths) ? testPaths : []) {
        const row = byPath.get(String(p));
        if (row) testIds.add(String(row.id));
      }
    }

    for (const test of tests) {
      const score = scoreModuleTestPair(mod, test, policy);
      if (score >= policy.heuristics.min_match_score) testIds.add(String(test.id));
    }

    mapping[mod.path] = Array.from(testIds).sort();
  }
  return mapping;
}

function stableId(seed, prefix = 'id') {
  const digest = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 14);
  return `${prefix}_${digest}`;
}

function loadStatus(paths) {
  const fallback = {
    version: '1.0',
    updated_at: null,
    modules: {},
    tests: {},
    alerts: {
      emitted_signatures: {},
      latest: []
    },
    last_sync: null,
    last_run: null,
    last_report: null
  };
  const row = readJson(paths.status_path, fallback);
  if (!row || typeof row !== 'object') return fallback;
  if (!row.modules || typeof row.modules !== 'object') row.modules = {};
  if (!row.tests || typeof row.tests !== 'object') row.tests = {};
  if (!row.alerts || typeof row.alerts !== 'object') row.alerts = { emitted_signatures: {}, latest: [] };
  if (!row.alerts.emitted_signatures || typeof row.alerts.emitted_signatures !== 'object') row.alerts.emitted_signatures = {};
  if (!Array.isArray(row.alerts.latest)) row.alerts.latest = [];
  return row;
}

function shortText(v, max = 240) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

function parseJsonFromOutput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

function emitAlerts(paths, status, alerts) {
  const emitted = status.alerts && status.alerts.emitted_signatures && typeof status.alerts.emitted_signatures === 'object'
    ? status.alerts.emitted_signatures
    : {};
  const out = [];
  for (const alert of alerts) {
    const signature = String(alert.signature || '');
    if (!signature) continue;
    const prev = String(emitted[signature] || '').trim();
    if (prev) continue;
    emitted[signature] = alert.ts;
    out.push(alert);
    appendJsonl(paths.events_path, alert);
  }
  status.alerts.emitted_signatures = emitted;
  status.alerts.latest = out.slice(0, 200);
  return out;
}

function syncState(paths, policy) {
  const prev = loadStatus(paths);
  const modules = moduleCandidates(paths, policy);
  const tests = testCandidates(paths, policy);
  const mapping = mapModuleTests(modules, tests, policy);
  const now = nowIso();

  const nextModules = {};
  const alerts = [];
  let changedCount = 0;
  let newCount = 0;
  let untestedCount = 0;

  for (const mod of modules) {
    const fp = sha256File(mod.abs_path);
    const prevRow = prev.modules && prev.modules[mod.path] && typeof prev.modules[mod.path] === 'object'
      ? prev.modules[mod.path]
      : null;

    const mappedTests = Array.isArray(mapping[mod.path]) ? mapping[mod.path] : [];
    const hasTests = mappedTests.length > 0;
    const isNew = !prevRow;
    const changed = !prevRow || String(prevRow.fingerprint || '') !== fp;

    if (isNew) newCount += 1;
    if (changed) changedCount += 1;
    if (!hasTests) untestedCount += 1;

    const checked = changed
      ? false
      : (prevRow && prevRow.checked === true && prevRow.mapped_test_count === mappedTests.length);

    const row = {
      id: String((prevRow && prevRow.id) || mod.id),
      path: mod.path,
      fingerprint: fp,
      checked,
      changed,
      is_new: isNew,
      untested: !hasTests,
      mapped_test_ids: mappedTests,
      mapped_test_count: mappedTests.length,
      last_change_ts: changed ? now : (prevRow && prevRow.last_change_ts ? String(prevRow.last_change_ts) : null),
      last_test_ts: prevRow && prevRow.last_test_ts ? String(prevRow.last_test_ts) : null,
      last_pass_ts: prevRow && prevRow.last_pass_ts ? String(prevRow.last_pass_ts) : null,
      last_fail_ts: prevRow && prevRow.last_fail_ts ? String(prevRow.last_fail_ts) : null,
      seed_fields: {
        owner: prevRow && prevRow.seed_fields && prevRow.seed_fields.owner ? String(prevRow.seed_fields.owner) : null,
        priority: prevRow && prevRow.seed_fields && prevRow.seed_fields.priority ? String(prevRow.seed_fields.priority) : 'normal',
        notes: prevRow && prevRow.seed_fields && prevRow.seed_fields.notes ? String(prevRow.seed_fields.notes) : null
      }
    };

    nextModules[mod.path] = row;

    if (policy.alerts.emit_untested && !hasTests) {
      const shouldEmit = isNew || (policy.alerts.emit_changed_without_tests && changed) || (prevRow && prevRow.untested !== true);
      if (shouldEmit) {
        alerts.push({
          ts: now,
          type: 'autotest_alert',
          severity: 'warn',
          alert_kind: 'untested_module',
          module_path: mod.path,
          reason: changed ? 'changed_module_without_tests' : 'module_without_tests',
          signature: stableId(`untested|${mod.path}|${fp}`, 'alert')
        });
      }
    }
  }

  const nextTests = {};
  for (const test of tests) {
    const prevRow = prev.tests && prev.tests[test.id] && typeof prev.tests[test.id] === 'object'
      ? prev.tests[test.id]
      : null;
    nextTests[test.id] = {
      id: test.id,
      kind: test.kind,
      path: test.path,
      command: test.command,
      critical: false,
      last_status: prevRow && prevRow.last_status ? String(prevRow.last_status) : 'untested',
      last_exit_code: prevRow && Number.isFinite(Number(prevRow.last_exit_code)) ? Number(prevRow.last_exit_code) : null,
      last_run_ts: prevRow && prevRow.last_run_ts ? String(prevRow.last_run_ts) : null,
      last_duration_ms: prevRow && Number.isFinite(Number(prevRow.last_duration_ms)) ? Number(prevRow.last_duration_ms) : null,
      last_stdout_excerpt: prevRow && prevRow.last_stdout_excerpt ? String(prevRow.last_stdout_excerpt) : null,
      last_stderr_excerpt: prevRow && prevRow.last_stderr_excerpt ? String(prevRow.last_stderr_excerpt) : null
    };
  }

  for (let i = 0; i < policy.critical_commands.length; i += 1) {
    const command = String(policy.critical_commands[i]);
    const id = stableId(`critical|${command}`, 'tst');
    const prevRow = prev.tests && prev.tests[id] && typeof prev.tests[id] === 'object'
      ? prev.tests[id]
      : null;
    nextTests[id] = {
      id,
      kind: 'shell_command',
      path: null,
      command,
      critical: true,
      last_status: prevRow && prevRow.last_status ? String(prevRow.last_status) : 'untested',
      last_exit_code: prevRow && Number.isFinite(Number(prevRow.last_exit_code)) ? Number(prevRow.last_exit_code) : null,
      last_run_ts: prevRow && prevRow.last_run_ts ? String(prevRow.last_run_ts) : null,
      last_duration_ms: prevRow && Number.isFinite(Number(prevRow.last_duration_ms)) ? Number(prevRow.last_duration_ms) : null,
      last_stdout_excerpt: prevRow && prevRow.last_stdout_excerpt ? String(prevRow.last_stdout_excerpt) : null,
      last_stderr_excerpt: prevRow && prevRow.last_stderr_excerpt ? String(prevRow.last_stderr_excerpt) : null
    };
  }

  const registry = {
    ok: true,
    type: 'autotest_registry',
    ts: now,
    policy_version: policy.version,
    module_root: relPath(paths.module_root),
    test_root: relPath(paths.test_root),
    modules: modules.map((m) => ({
      id: m.id,
      path: m.path,
      mapped_test_ids: mapping[m.path] || []
    })),
    tests: Object.values(nextTests).map((t) => ({
      id: t.id,
      kind: t.kind,
      path: t.path,
      command: t.command,
      critical: t.critical === true
    }))
  };

  const nextStatus = {
    ...prev,
    version: '1.0',
    updated_at: now,
    modules: nextModules,
    tests: nextTests,
    last_sync: now
  };

  const emittedAlerts = emitAlerts(paths, nextStatus, alerts);

  writeJsonAtomic(paths.registry_path, registry);
  writeJsonAtomic(paths.status_path, nextStatus);
  writeJsonAtomic(paths.latest_path, {
    ok: true,
    type: 'autotest_sync',
    ts: now,
    changed_modules: changedCount,
    new_modules: newCount,
    untested_modules: untestedCount,
    emitted_alerts: emittedAlerts.length,
    registry_path: relPath(paths.registry_path),
    status_path: relPath(paths.status_path)
  });

  appendJsonl(path.join(paths.runs_dir, `${dateArgOrToday()}.jsonl`), {
    ts: now,
    type: 'autotest_sync',
    changed_modules: changedCount,
    new_modules: newCount,
    untested_modules: untestedCount,
    emitted_alerts: emittedAlerts.length
  });

  return {
    ok: true,
    type: 'autotest_sync',
    ts: now,
    changed_modules: changedCount,
    new_modules: newCount,
    untested_modules: untestedCount,
    tests_discovered: Object.keys(nextTests).length,
    emitted_alerts: emittedAlerts.length,
    registry_path: relPath(paths.registry_path),
    status_path: relPath(paths.status_path)
  };
}

function isSpineHot(paths, windowSec) {
  const windowMs = Math.max(1, Number(windowSec || 60)) * 1000;
  const nowMs = Date.now();
  const dateA = nowIso().slice(0, 10);
  const d = new Date(`${dateA}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const dateB = d.toISOString().slice(0, 10);
  const files = [
    path.join(paths.spine_runs_dir, `${dateA}.jsonl`),
    path.join(paths.spine_runs_dir, `${dateB}.jsonl`)
  ];
  let latestTsMs = 0;
  for (const fp of files) {
    for (const row of readJsonl(fp)) {
      const tsMs = Date.parse(String(row && row.ts || ''));
      if (!Number.isFinite(tsMs)) continue;
      if (tsMs > latestTsMs) latestTsMs = tsMs;
    }
  }
  return {
    hot: latestTsMs > 0 && (nowMs - latestTsMs) <= windowMs,
    last_spine_ts: latestTsMs > 0 ? new Date(latestTsMs).toISOString() : null
  };
}

function inSleepWindow(policy) {
  const cfg = policy.sleep_window_local || {};
  if (cfg.enabled !== true) return true;
  const start = clampInt(cfg.start_hour, 0, 23, 0);
  const end = clampInt(cfg.end_hour, 0, 23, 7);
  const hour = new Date().getHours();
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function runtimeResourceWithin(policy) {
  const cpus = Math.max(1, (os.cpus() || []).length || 1);
  const load = os.loadavg()[0] || 0;
  const rssMb = process.memoryUsage().rss / (1024 * 1024);
  const loadPerCpu = load / cpus;
  const guard = policy.runtime_guard || {};
  const maxLoadPerCpu = Number(guard.max_load_per_cpu || 0.75);
  const maxRssMb = Number(guard.max_rss_mb || 1600);
  return {
    ok: loadPerCpu <= maxLoadPerCpu && rssMb <= maxRssMb,
    load_per_cpu: Number(loadPerCpu.toFixed(4)),
    rss_mb: Number(rssMb.toFixed(2)),
    max_load_per_cpu: maxLoadPerCpu,
    max_rss_mb: maxRssMb
  };
}

function runCommand(command, timeoutMs) {
  const started = Date.now();
  const proc = spawnSync(command, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    timeout: Math.max(1000, Number(timeoutMs || 180000))
  });
  return {
    ok: proc.status === 0,
    exit_code: proc.status == null ? 1 : proc.status,
    signal: proc.signal || null,
    timed_out: proc.error && String(proc.error.message || '').includes('ETIMEDOUT'),
    duration_ms: Date.now() - started,
    stdout_excerpt: shortText(proc.stdout || '', 800),
    stderr_excerpt: shortText(proc.stderr || '', 800)
  };
}

function cleanCmdToken(tok) {
  return String(tok == null ? '' : tok).trim().replace(/^['"]|['"]$/g, '');
}

function commandPathHints(command) {
  const tokens = String(command == null ? '' : command)
    .split(/\s+/g)
    .map((tok) => cleanCmdToken(tok))
    .filter(Boolean);
  const out = [];
  for (const tok of tokens) {
    if (!/[./]/.test(tok)) continue;
    if (tok === '.' || tok === '..') continue;
    if (tok.startsWith('-')) continue;
    const abs = path.resolve(ROOT, tok);
    if (!abs.startsWith(ROOT)) continue;
    if (!fs.existsSync(abs)) continue;
    out.push(relPath(abs));
  }
  return out;
}

function reverseModuleMapping(status) {
  const map = new Map();
  const modules = status && status.modules && typeof status.modules === 'object' ? status.modules : {};
  for (const [modulePath, mod] of Object.entries(modules)) {
    if (!mod || typeof mod !== 'object') continue;
    const testIds = Array.isArray(mod.mapped_test_ids) ? mod.mapped_test_ids : [];
    for (const id of testIds) {
      const key = String(id || '').trim();
      if (!key) continue;
      const bucket = map.get(key) || new Set();
      bucket.add(String(modulePath));
      map.set(key, bucket);
    }
  }
  return map;
}

function normalizeGuardFileList(files) {
  const seen = new Set();
  const out = [];
  for (const file of Array.isArray(files) ? files : []) {
    const raw = String(file || '').trim();
    if (!raw) continue;
    const abs = path.resolve(ROOT, raw);
    if (!abs.startsWith(ROOT)) continue;
    if (!fs.existsSync(abs)) continue;
    const rel = relPath(abs);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out.slice(0, 80);
}

function runGuardForFiles(files) {
  const normalized = normalizeGuardFileList(files);
  if (!normalized.length) {
    return {
      ok: true,
      skipped: true,
      reason: 'no_guard_targets',
      files: []
    };
  }
  const guardArg = `--files=${normalized.join(',')}`;
  const env = {
    ...process.env,
    REQUEST_SOURCE: process.env.REQUEST_SOURCE || 'local',
    REQUEST_ACTION: process.env.REQUEST_ACTION || 'audit'
  };
  if (!env.CLEARANCE) env.CLEARANCE = '3';
  const started = Date.now();
  const proc = spawnSync('node', ['systems/security/guard.js', guardArg], {
    cwd: ROOT,
    encoding: 'utf8',
    env
  });
  const payload = parseJsonFromOutput(proc.stdout || '');
  const ok = proc.status === 0 && !!(payload && payload.ok === true);
  return {
    ok,
    skipped: false,
    reason: ok
      ? null
      : shortText(
          (payload && payload.reason)
            ? String(payload.reason)
            : (proc.stderr || proc.stdout || 'guard_blocked'),
          220
        ),
    files: normalized,
    duration_ms: Date.now() - started,
    payload: payload && typeof payload === 'object' ? payload : null,
    stderr_excerpt: shortText(proc.stderr || '', 400),
    stdout_excerpt: shortText(proc.stdout || '', 400)
  };
}

function testSetForScope(status, scope) {
  const modules = status.modules && typeof status.modules === 'object' ? status.modules : {};
  const tests = status.tests && typeof status.tests === 'object' ? status.tests : {};

  const selected = new Set();
  if (scope === 'critical') {
    for (const row of Object.values(tests)) {
      if (row && row.critical === true) selected.add(String(row.id));
    }
    return selected;
  }

  if (scope === 'all') {
    for (const row of Object.values(tests)) {
      if (!row || !row.id) continue;
      selected.add(String(row.id));
    }
    return selected;
  }

  for (const mod of Object.values(modules)) {
    if (!mod || typeof mod !== 'object') continue;
    if (mod.checked === true && mod.changed !== true) continue;
    const ids = Array.isArray(mod.mapped_test_ids) ? mod.mapped_test_ids : [];
    for (const id of ids) selected.add(String(id));
  }
  return selected;
}

function updateModuleCheckStates(status) {
  const modules = status.modules && typeof status.modules === 'object' ? status.modules : {};
  const tests = status.tests && typeof status.tests === 'object' ? status.tests : {};
  for (const [modulePath, mod] of Object.entries(modules)) {
    if (!mod || typeof mod !== 'object') continue;
    const ids = Array.isArray(mod.mapped_test_ids) ? mod.mapped_test_ids : [];
    const allPass = ids.length > 0 && ids.every((id) => {
      const t = tests[id];
      return !!t && String(t.last_status || '') === 'pass';
    });
    const checked = allPass && mod.changed !== true;
    mod.checked = checked;
    mod.untested = ids.length === 0;
    if (checked && !mod.last_pass_ts) mod.last_pass_ts = nowIso();
    modules[modulePath] = mod;
  }
  status.modules = modules;
}

function cmdRun(args, policy, paths) {
  const runStartMs = Date.now();
  const strict = toBool(args.strict, policy.execution.strict);
  const sleepOnly = toBool(args['sleep-only'], false);
  const force = toBool(args.force, false);
  const scope = ['critical', 'changed', 'all'].includes(String(args.scope || '').trim())
    ? String(args.scope).trim()
    : String(policy.execution.default_scope || 'changed');
  const maxTests = clampInt(args['max-tests'], 1, 500, policy.execution.max_tests_per_run);
  const runTimeoutMs = clampInt(
    args['run-timeout-ms'],
    policy.execution.run_timeout_ms,
    1000,
    2 * 60 * 60 * 1000
  );
  const runDeadlineMs = runStartMs + runTimeoutMs;
  const phaseMs = {
    sync_ms: 0,
    select_ms: 0,
    execute_ms: 0,
    total_ms: 0
  };

  function budgetExceeded() {
    return Date.now() > runDeadlineMs;
  }

  function remainingBudgetMs() {
    return Math.max(1000, runDeadlineMs - Date.now());
  }

  const syncStarted = Date.now();
  const syncOut = syncState(paths, policy);
  phaseMs.sync_ms = Date.now() - syncStarted;
  const status = loadStatus(paths);

  const sleepGate = inSleepWindow(policy);
  const resources = runtimeResourceWithin(policy);
  const spineHot = isSpineHot(paths, policy.runtime_guard.spine_hot_window_sec);
  const skipReasons = [];
  if (sleepOnly && !sleepGate) skipReasons.push('outside_sleep_window');
  if (resources.ok !== true) skipReasons.push('resource_guard');
  if (spineHot.hot === true) skipReasons.push('spine_hot');
  if (skipReasons.length > 0 && !force) {
    const out = {
      ok: true,
      type: 'autotest_run',
      ts: nowIso(),
      scope,
      strict,
      skipped: true,
      skip_reasons: skipReasons,
      synced: syncOut,
      sleep_window_ok: sleepGate,
      resource_guard: resources,
      spine_hot: spineHot,
      run_timeout_ms: runTimeoutMs,
      phase_ms: {
        ...phaseMs,
        total_ms: Date.now() - runStartMs
      }
    };
    writeJsonAtomic(paths.latest_path, out);
    appendJsonl(path.join(paths.runs_dir, `${dateArgOrToday()}.jsonl`), out);
    return out;
  }

  function timeoutOut(reason, extras = {}) {
    const out = {
      ok: false,
      type: 'autotest_run',
      ts: nowIso(),
      scope,
      strict,
      timeout: true,
      timeout_reason: reason,
      run_timeout_ms: runTimeoutMs,
      synced: syncOut,
      sleep_window_ok: sleepGate,
      resource_guard: resources,
      spine_hot: spineHot,
      phase_ms: {
        ...phaseMs,
        total_ms: Date.now() - runStartMs
      },
      ...extras
    };
    writeJsonAtomic(paths.latest_path, out);
    appendJsonl(path.join(paths.runs_dir, `${dateArgOrToday()}.jsonl`), out);
    return out;
  }

  if (budgetExceeded()) {
    return timeoutOut('sync_budget_exhausted');
  }

  const selectStarted = Date.now();
  const testIds = Array.from(testSetForScope(status, scope));
  const selected = testIds
    .map((id) => status.tests && status.tests[id])
    .filter(Boolean)
    .slice(0, maxTests);
  const testToModules = reverseModuleMapping(status);
  phaseMs.select_ms = Date.now() - selectStarted;

  const results = [];
  let guardBlocked = 0;
  const executeStarted = Date.now();
  for (const test of selected) {
    if (budgetExceeded()) {
      phaseMs.execute_ms = Date.now() - executeStarted;
      return timeoutOut('execution_budget_exhausted', {
        selected_tests: results.length,
        passed: results.filter((r) => r.ok === true).length,
        failed: results.filter((r) => r.ok !== true).length,
        partial_results: results.slice(0, 120)
      });
    }
    const guardFiles = [];
    if (test.path) guardFiles.push(String(test.path));
    const mapped = testToModules.get(String(test.id || ''));
    if (mapped && typeof mapped.forEach === 'function') {
      mapped.forEach((modulePath) => guardFiles.push(String(modulePath)));
    }
    const commandHints = commandPathHints(test.command);
    for (const hint of commandHints) guardFiles.push(hint);

    const guard = runGuardForFiles(guardFiles);
    const perTestTimeoutMs = Math.max(
      1000,
      Math.min(policy.execution.timeout_ms_per_test, remainingBudgetMs())
    );
    const res = guard.ok
      ? runCommand(test.command, perTestTimeoutMs)
      : {
          ok: false,
          exit_code: 1,
          signal: null,
          timed_out: false,
          duration_ms: Number(guard.duration_ms || 0),
          stdout_excerpt: shortText(`guard_blocked:${guard.reason || 'blocked'}`, 800),
          stderr_excerpt: shortText(
            [guard.stderr_excerpt || '', guard.stdout_excerpt || ''].filter(Boolean).join(' '),
            800
          )
        };
    if (guard.ok !== true) guardBlocked += 1;

    const row = status.tests[test.id] || {};
    row.last_status = res.ok ? 'pass' : 'fail';
    row.last_exit_code = res.exit_code;
    row.last_run_ts = nowIso();
    row.last_duration_ms = res.duration_ms;
    row.last_stdout_excerpt = res.stdout_excerpt;
    row.last_stderr_excerpt = res.stderr_excerpt;
    row.last_guard = {
      ok: guard.ok === true,
      reason: guard.reason || null,
      files: Array.isArray(guard.files) ? guard.files.slice(0, 24) : []
    };
    if (res.ok) row.last_pass_ts = row.last_run_ts;
    else row.last_fail_ts = row.last_run_ts;
    status.tests[test.id] = row;

    results.push({
      id: test.id,
      command: test.command,
      critical: test.critical === true,
      guard_ok: guard.ok === true,
      guard_reason: guard.reason || null,
      guard_files: Array.isArray(guard.files) ? guard.files : [],
      ok: res.ok,
      exit_code: res.exit_code,
      duration_ms: res.duration_ms,
      stdout_excerpt: res.stdout_excerpt,
      stderr_excerpt: res.stderr_excerpt
    });
  }
  phaseMs.execute_ms = Date.now() - executeStarted;

  for (const mod of Object.values(status.modules)) {
    if (!mod || typeof mod !== 'object') continue;
    if (mod.changed === true) mod.last_test_ts = nowIso();
    const ids = Array.isArray(mod.mapped_test_ids) ? mod.mapped_test_ids : [];
    if (!ids.length) continue;
    const fail = ids.some((id) => String(status.tests[id] && status.tests[id].last_status || '') === 'fail');
    const pass = ids.every((id) => String(status.tests[id] && status.tests[id].last_status || '') === 'pass');
    if (fail) mod.last_fail_ts = nowIso();
    if (pass) {
      mod.last_pass_ts = nowIso();
      if (mod.changed === true) mod.changed = false;
    }
  }

  updateModuleCheckStates(status);
  status.updated_at = nowIso();
  status.last_run = nowIso();
  writeJsonAtomic(paths.status_path, status);

  const passed = results.filter((r) => r.ok === true).length;
  const failed = results.length - passed;
  const untested = Object.values(status.modules).filter((m) => m && m.untested === true).length;

  let painSignal = null;
  if ((failed > 0 || guardBlocked > 0) && typeof emitPainSignal === 'function') {
    try {
      const sample = results
        .filter((row) => row && row.ok !== true)
        .slice(0, 6)
        .map((row) => ({
          id: row.id,
          guard_ok: row.guard_ok === true,
          command: shortText(row.command || '', 180),
          stderr: shortText(row.stderr_excerpt || '', 220)
        }));
      painSignal = emitPainSignal({
        source: 'autotest_controller',
        subsystem: 'ops.autotest',
        code: guardBlocked > 0 ? 'guard_blocked' : 'test_failures',
        summary: `Autotest run failures (${failed}/${results.length}) scope=${scope}`,
        details: JSON.stringify({
          scope,
          strict,
          selected_tests: results.length,
          failed,
          guard_blocked: guardBlocked,
          sample
        }).slice(0, 1200),
        severity: guardBlocked > 0 ? 'high' : 'medium',
        risk: guardBlocked > 0 ? 'high' : 'medium',
        create_proposal: true
      });
    } catch (err) {
      painSignal = {
        ok: false,
        error: shortText(err && err.message ? err.message : err || 'pain_signal_failed', 220)
      };
    }
  }

  const out = {
    ok: strict ? failed === 0 && untested === 0 : failed === 0,
    type: 'autotest_run',
    ts: nowIso(),
    scope,
    strict,
    synced: syncOut,
    selected_tests: results.length,
    passed,
    failed,
    guard_blocked: guardBlocked,
    untested_modules: untested,
    sleep_window_ok: sleepGate,
    resource_guard: resources,
    spine_hot: spineHot,
    run_timeout_ms: runTimeoutMs,
    phase_ms: {
      ...phaseMs,
      total_ms: Date.now() - runStartMs
    },
    results: results.slice(0, 300),
    pain_signal: painSignal
  };

  writeJsonAtomic(paths.latest_path, out);
  appendJsonl(path.join(paths.runs_dir, `${dateArgOrToday()}.jsonl`), out);

  if (failed > 0 || untested > 0 || guardBlocked > 0) {
    appendJsonl(paths.events_path, {
      ts: nowIso(),
      type: 'autotest_alert',
      severity: (failed > 0 || guardBlocked > 0) ? 'error' : 'warn',
      alert_kind: guardBlocked > 0
        ? 'guard_blocked'
        : (failed > 0 ? 'test_failures' : 'untested_modules'),
      failed,
      guard_blocked: guardBlocked,
      untested_modules: untested,
      scope
    });
  }

  return out;
}

function cmdReport(args, policy, paths) {
  const token = String(args._[1] || 'latest').trim().toLowerCase();
  const write = toBool(args.write, true);
  const status = loadStatus(paths);

  const latestRun = readJson(paths.latest_path, null);
  const ts = nowIso();
  const date = token === 'latest' ? ts.slice(0, 10) : dateArgOrToday(token);

  const modules = Object.values(status.modules || {});
  const tests = Object.values(status.tests || {});

  const untested = modules
    .filter((m) => m && m.untested === true)
    .sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')))
    .slice(0, policy.alerts.max_untested_in_report);

  const failedTests = tests
    .filter((t) => t && String(t.last_status || '') === 'fail')
    .sort((a, b) => String(a.path || a.command || '').localeCompare(String(b.path || b.command || '')))
    .slice(0, policy.alerts.max_failed_in_report);

  const checkedModules = modules.filter((m) => m && m.checked === true).length;
  const changedModules = modules.filter((m) => m && m.changed === true).length;
  const totalModules = modules.length;

  const lines = [];
  lines.push('# Autotest Report');
  lines.push('');
  lines.push(`- Generated: ${ts}`);
  lines.push(`- Date: ${date}`);
  lines.push(`- Modules: ${totalModules}`);
  lines.push(`- Checked: ${checkedModules}`);
  lines.push(`- Changed/Pending: ${changedModules}`);
  lines.push(`- Untested Modules: ${untested.length}`);
  lines.push(`- Failed Tests: ${failedTests.length}`);
  if (latestRun && typeof latestRun === 'object') {
    lines.push(`- Last Run Scope: ${String(latestRun.scope || 'n/a')}`);
    lines.push(`- Last Run Passed/Failed: ${Number(latestRun.passed || 0)}/${Number(latestRun.failed || 0)}`);
  }

  lines.push('');
  lines.push('## Failed Tests');
  if (!failedTests.length) {
    lines.push('- None');
  } else {
    for (const t of failedTests) {
      const label = t.path ? String(t.path) : String(t.command || 'unknown_test');
      lines.push(`- ${label}`);
      if (t.last_stderr_excerpt) lines.push(`  - stderr: ${String(t.last_stderr_excerpt)}`);
    }
  }

  lines.push('');
  lines.push('## Untested Modules');
  if (!untested.length) {
    lines.push('- None');
  } else {
    for (const m of untested) {
      lines.push(`- ${String(m.path || 'unknown_module')}`);
      if (m.changed === true) lines.push('  - reason: changed module with no mapped tests');
      else if (m.is_new === true) lines.push('  - reason: new module with no mapped tests');
      else lines.push('  - reason: no mapped tests');
    }
  }

  const markdown = `${lines.join('\n')}\n`;
  const outPath = path.join(paths.reports_dir, `${date}.md`);
  if (write) writeTextAtomic(outPath, markdown);

  const out = {
    ok: true,
    type: 'autotest_report',
    ts,
    date,
    modules_total: totalModules,
    modules_checked: checkedModules,
    modules_changed: changedModules,
    untested_modules: untested.length,
    failed_tests: failedTests.length,
    output_path: write ? relPath(outPath) : null,
    write
  };

  status.last_report = ts;
  writeJsonAtomic(paths.status_path, status);
  writeJsonAtomic(paths.latest_path, out);
  appendJsonl(path.join(paths.runs_dir, `${dateArgOrToday()}.jsonl`), out);
  return out;
}

function cmdStatus(policy, paths) {
  const status = loadStatus(paths);
  const modules = Object.values(status.modules || {});
  const tests = Object.values(status.tests || {});
  const out = {
    ok: true,
    type: 'autotest_status',
    ts: nowIso(),
    policy_version: policy.version,
    modules_total: modules.length,
    modules_checked: modules.filter((m) => m && m.checked === true).length,
    modules_changed: modules.filter((m) => m && m.changed === true).length,
    untested_modules: modules.filter((m) => m && m.untested === true).length,
    tests_total: tests.length,
    tests_failed: tests.filter((t) => t && String(t.last_status || '') === 'fail').length,
    tests_passed: tests.filter((t) => t && String(t.last_status || '') === 'pass').length,
    tests_untested: tests.filter((t) => t && String(t.last_status || '') === 'untested').length,
    last_sync: status.last_sync || null,
    last_run: status.last_run || null,
    last_report: status.last_report || null,
    status_path: relPath(paths.status_path),
    registry_path: relPath(paths.registry_path)
  };
  return out;
}

async function cmdDaemon(args, policy, paths) {
  const intervalSec = clampInt(args['interval-sec'], 20, 24 * 60 * 60, policy.daemon.interval_sec);
  const maxCycles = clampInt(args['max-cycles'], 0, 1000000, policy.daemon.max_cycles);
  const jitterSec = clampInt(args['jitter-sec'], 0, 600, policy.daemon.jitter_sec);
  const scope = ['critical', 'changed', 'all'].includes(String(args.scope || '').trim())
    ? String(args.scope).trim()
    : String(policy.execution.default_scope || 'changed');
  const strict = toBool(args.strict, policy.execution.strict);
  const maxTests = clampInt(args['max-tests'], 1, 500, policy.execution.max_tests_per_run);

  let cycles = 0;
  let lastOut = null;
  while (true) {
    cycles += 1;
    const runOut = cmdRun({
      scope,
      strict,
      'max-tests': maxTests,
      'sleep-only': true,
      'run-timeout-ms': args['run-timeout-ms']
    }, policy, paths);
    const reportOut = cmdReport({ _: ['report', 'latest'], write: true }, policy, paths);
    lastOut = {
      run: runOut,
      report: reportOut
    };

    const stop = maxCycles > 0 && cycles >= maxCycles;
    if (stop) break;

    const jitter = jitterSec > 0 ? Math.floor(Math.random() * (jitterSec + 1)) : 0;
    await sleepMs((intervalSec + jitter) * 1000);
  }

  return {
    ok: true,
    type: 'autotest_daemon',
    ts: nowIso(),
    cycles,
    interval_sec: intervalSec,
    jitter_sec: jitterSec,
    scope,
    strict,
    max_tests: maxTests,
    last: lastOut
  };
}

function ensureStateDirs(paths) {
  ensureDir(paths.state_dir);
  ensureDir(paths.reports_dir);
  ensureDir(paths.runs_dir);
  ensureDir(path.dirname(paths.events_path));
  ensureDir(path.dirname(paths.latest_path));
  ensureDir(path.dirname(paths.registry_path));
  ensureDir(path.dirname(paths.status_path));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const paths = runtimePaths();
  const policy = loadPolicy(args.policy || paths.policy_path);
  ensureStateDirs(paths);

  if (policy.enabled !== true && !['status'].includes(cmd)) {
    const outDisabled = {
      ok: true,
      type: 'autotest',
      ts: nowIso(),
      disabled: true,
      reason: 'policy_disabled'
    };
    process.stdout.write(`${JSON.stringify(outDisabled)}\n`);
    return;
  }

  let out;
  if (cmd === 'sync') {
    out = syncState(paths, policy);
  } else if (cmd === 'run') {
    out = cmdRun(args, policy, paths);
  } else if (cmd === 'report') {
    out = cmdReport(args, policy, paths);
  } else if (cmd === 'status') {
    out = cmdStatus(policy, paths);
  } else if (cmd === 'pulse') {
    const runOut = cmdRun({ ...args, 'sleep-only': true }, policy, paths);
    const reportOut = cmdReport({ _: ['report', 'latest'], write: true }, policy, paths);
    out = {
      ok: (runOut && runOut.ok !== false) && (reportOut && reportOut.ok !== false),
      type: 'autotest_pulse',
      ts: nowIso(),
      run: runOut,
      report: reportOut
    };
  } else if (cmd === 'daemon') {
    out = await cmdDaemon(args, policy, paths);
  } else {
    usage();
    process.exitCode = 2;
    return;
  }

  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (!out || out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: String(err && err.message ? err.message : err || 'autotest_controller_failed')
    })}\n`);
    process.exit(1);
  });
}

module.exports = {
  syncState,
  testSetForScope,
  inSleepWindow,
  runtimeResourceWithin
};
