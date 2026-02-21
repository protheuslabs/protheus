#!/usr/bin/env node
'use strict';

/**
 * eyes_intake.js
 *
 * Purpose:
 * - Make sensory-eye creation fast/safe for the dynamic layer.
 * - Enforce a simple gate: new eyes must map to an active directive.
 * - Keep new eyes probationary by default so atrophy/evolution can prune naturally.
 *
 * Usage:
 *   node systems/sensory/eyes_intake.js create --name="..." --parser=hn_rss --directive=T1_make_jay_billionaire_v1 [--domains=foo.com,bar.com]
 *   node systems/sensory/eyes_intake.js validate --directive=T1_make_jay_billionaire_v1
 *   node systems/sensory/eyes_intake.js list-directives
 *   node systems/sensory/eyes_intake.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadActiveDirectives } = require('../../lib/directive_resolver.js');
const { resolveCatalogPath, ensureCatalog, setCatalog } = require('../../lib/eyes_catalog.js');
const { randomUid } = require('../../lib/uid.js');

const WORKSPACE_DIR = path.join(__dirname, '..', '..');
const CONFIG_PATH = resolveCatalogPath(WORKSPACE_DIR);
const ADAPTIVE_COLLECTOR_DIR = process.env.ADAPTIVE_EYES_COLLECTOR_DIR
  ? path.resolve(process.env.ADAPTIVE_EYES_COLLECTOR_DIR)
  : path.join(WORKSPACE_DIR, 'adaptive', 'sensory', 'eyes', 'collectors');
const REGISTRY_PATH = process.env.EYES_INTAKE_REGISTRY_PATH
  ? path.resolve(process.env.EYES_INTAKE_REGISTRY_PATH)
  : path.join(WORKSPACE_DIR, 'state', 'sensory', 'eyes', 'registry.json');
const GUARD_PATH = path.join(WORKSPACE_DIR, 'systems', 'security', 'guard.js');
const WORKSPACE_DUMP_GUARD_PATH = path.join(WORKSPACE_DIR, 'systems', 'security', 'workspace_dump_guard.js');

const DEFAULT_DOMAINS = {
  hn_rss: ['news.ycombinator.com', 'hnrss.org'],
  moltbook_hot: ['www.moltbook.com', 'api.moltbook.com'],
  local_state_digest: ['local.workspace'],
  ollama_search: ['ollama.com', 'www.ollama.com'],
  bird_x: ['x.com', 'twitter.com'],
  stock_market: ['finance.yahoo.com', 'query1.finance.yahoo.com'],
  google_trends: ['trends.google.com'],
  github_repo: ['api.github.com', 'github.com'],
  upwork_gigs: ['www.upwork.com', 'upwork.com'],
  producthunt_launches: ['www.producthunt.com', 'api.producthunt.com'],
  stub: ['example.com']
};

function usage() {
  console.log('Usage:');
  console.log('  node systems/sensory/eyes_intake.js create --name="..." --parser=<parser_type> --directive=<directive_id> [--domains=d1,d2]');
  console.log('    Optional:');
  console.log('      --id=<eye_id> --topics=t1,t2 --notes="..." --status=probation|active --cadence=6');
  console.log('      --max-items=10 --max-seconds=15 --max-bytes=524288 --max-requests=1');
  console.log('      --parser-options=\'{"owner":"x","repo":"y"}\'');
  console.log('  node systems/sensory/eyes_intake.js validate --directive=<directive_id>');
  console.log('  node systems/sensory/eyes_intake.js list-directives');
  console.log('  node systems/sensory/eyes_intake.js --help');
}

function adaptiveCollectorPath(parserType) {
  const key = String(parserType || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (!key) return '';
  return path.join(ADAPTIVE_COLLECTOR_DIR, `${key}.js`);
}

function supportedParserTypes() {
  const out = new Set(['stub']);
  try {
    if (fs.existsSync(ADAPTIVE_COLLECTOR_DIR)) {
      for (const f of fs.readdirSync(ADAPTIVE_COLLECTOR_DIR)) {
        if (!String(f).endsWith('.js')) continue;
        out.add(String(f).replace(/\.js$/i, '').trim().toLowerCase());
      }
    }
  } catch {
    // Ignore directory read errors.
  }
  return out;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function asList(v) {
  return String(v || '')
    .split(',')
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

function asInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function normalizeId(v) {
  const s = String(v || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) return '';
  return s.slice(0, 40);
}

function directiveIdsFromEnv() {
  return asList(process.env.EYES_INTAKE_ALLOWED_DIRECTIVES || '');
}

function loadActiveDirectiveIds() {
  const fromEnv = directiveIdsFromEnv();
  if (fromEnv.length) return new Set(fromEnv);
  try {
    const dirs = loadActiveDirectives({ allowMissing: true, allowWeakTier1: true });
    return new Set((dirs || []).map((d) => String((d && d.id) || '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function checkDirectiveOrExit(directiveId) {
  const id = String(directiveId || '').trim();
  if (!id) {
    console.error('eyes_intake: missing --directive=<active_directive_id>');
    process.exit(2);
  }
  const active = loadActiveDirectiveIds();
  if (!active.has(id)) {
    console.error(`eyes_intake: directive '${id}' is not active`);
    process.exit(2);
  }
  return id;
}

function ensureGuardOrExit() {
  if (String(process.env.EYES_INTAKE_SKIP_GUARD || '') === '1') return;
  const catalogRel = path.relative(WORKSPACE_DIR, path.resolve(CONFIG_PATH)).replace(/\\/g, '/');
  const guardedFiles = ['state/sensory/eyes/registry.json'];
  if (catalogRel && !catalogRel.startsWith('../')) {
    guardedFiles.unshift(catalogRel);
  }
  const files = guardedFiles.join(',');
  const r = spawnSync(process.execPath, [GUARD_PATH, `--files=${files}`], {
    cwd: WORKSPACE_DIR,
    encoding: 'utf8',
    env: process.env
  });
  if (r.status === 0) return;
  const stderr = String(r.stderr || '').trim();
  const stdout = String(r.stdout || '').trim();
  if (stderr) process.stderr.write(`${stderr}\n`);
  if (stdout) process.stderr.write(`${stdout}\n`);
  process.exit(r.status == null ? 1 : r.status);
}

function ensureDumpHygieneOrExit() {
  if (String(process.env.EYES_INTAKE_SKIP_GUARD || '') === '1') return;
  const r = spawnSync(process.execPath, [WORKSPACE_DUMP_GUARD_PATH, 'run', '--strict'], {
    cwd: WORKSPACE_DIR,
    encoding: 'utf8',
    env: process.env
  });
  if (r.status === 0) return;
  const stderr = String(r.stderr || '').trim();
  const stdout = String(r.stdout || '').trim();
  if (stderr) process.stderr.write(`${stderr}\n`);
  if (stdout) process.stderr.write(`${stdout}\n`);
  process.exit(r.status == null ? 1 : r.status);
}

function normalizeParserOptions(raw) {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

function validateParserSpecific(parserType, parserOptions) {
  if (parserType !== 'github_repo') return;
  const owner = String(parserOptions && parserOptions.owner || '').trim();
  const repo = String(parserOptions && parserOptions.repo || '').trim();
  if (!owner || !repo) {
    console.error('eyes_intake: github_repo parser requires --parser-options with owner and repo');
    process.exit(2);
  }
}

function defaultBudgets(args) {
  return {
    max_items: Math.max(1, asInt(args['max-items'], 10)),
    max_seconds: Math.max(1, asInt(args['max-seconds'], 15)),
    max_bytes: Math.max(1024, asInt(args['max-bytes'], 524288)),
    max_requests: Math.max(0, asInt(args['max-requests'], 1))
  };
}

function createEye(args) {
  const name = String(args.name || '').trim();
  const parserType = String(args.parser || '').trim().toLowerCase();
  const directiveRef = checkDirectiveOrExit(args.directive);
  if (!name) {
    console.error('eyes_intake: missing --name');
    process.exit(2);
  }
  const supportedParsers = supportedParserTypes();
  if (!supportedParsers.has(parserType)) {
    const modulePath = adaptiveCollectorPath(parserType);
    console.error(`eyes_intake: unsupported parser '${parserType}'`);
    console.error(`eyes_intake: add adaptive collector module at ${modulePath}`);
    console.error(`eyes_intake: available parsers=${Array.from(supportedParsers).sort((a, b) => a.localeCompare(b)).join(',')}`);
    process.exit(2);
  }

  const eyeId = normalizeId(args.id || name);
  if (!eyeId) {
    console.error('eyes_intake: could not derive eye id');
    process.exit(2);
  }

  const config = ensureCatalog(CONFIG_PATH);
  if (!config || !Array.isArray(config.eyes)) {
    console.error(`eyes_intake: invalid eyes catalog ${CONFIG_PATH}`);
    process.exit(1);
  }
  if (config.eyes.some((e) => String((e && e.id) || '') === eyeId)) {
    console.error(`eyes_intake: eye id already exists: ${eyeId}`);
    process.exit(2);
  }

  const parserOptions = normalizeParserOptions(args['parser-options'] || args.parser_options);
  validateParserSpecific(parserType, parserOptions);

  const domains = asList(args.domains);
  const allowedDomains = domains.length ? domains : (DEFAULT_DOMAINS[parserType] || ['example.com']);
  const topics = asList(args.topics);
  const eye = {
    uid: randomUid({ prefix: 'e', length: 24 }),
    id: eyeId,
    name,
    status: String(args.status || 'probation'),
    cadence_hours: Math.max(1, asInt(args.cadence, 24)),
    allowed_domains: allowedDomains,
    budgets: defaultBudgets(args),
    parser_type: parserType,
    topics: topics.length ? topics : [directiveRef.toLowerCase()],
    directive_ref: directiveRef,
    last_run: null,
    last_success: null,
    error_rate: 0.0,
    score_ema: 50.0,
    notes: String(args.notes || '').trim() || `Generated via eyes_intake for ${directiveRef}`,
    created_ts: new Date().toISOString(),
    updated_ts: new Date().toISOString()
  };
  if (parserOptions && Object.keys(parserOptions).length) {
    eye.parser_options = parserOptions;
  }

  ensureGuardOrExit();
  ensureDumpHygieneOrExit();

  config.eyes.push(eye);
  setCatalog(CONFIG_PATH, config, {
    source: 'systems/sensory/eyes_intake.js',
    reason: 'create_eye',
    actor: process.env.USER || 'unknown'
  });

  const registry = readJson(REGISTRY_PATH, { version: '1.0', last_updated: new Date().toISOString(), eyes: [] });
  if (!Array.isArray(registry.eyes)) registry.eyes = [];
  if (!registry.eyes.some((e) => String((e && e.id) || '') === eyeId)) {
    registry.eyes.push({
      ...eye,
      run_count: 0,
      total_runs: 0,
      total_items: 0,
      total_errors: 0,
      consecutive_failures: 0
    });
  }
  registry.last_updated = new Date().toISOString();
  writeJson(REGISTRY_PATH, registry);

  process.stdout.write(JSON.stringify({
    ok: true,
    eye_id: eyeId,
    parser_type: parserType,
    directive_ref: directiveRef,
    status: eye.status,
    config_path: CONFIG_PATH,
    registry_path: REGISTRY_PATH
  }, null, 2) + '\n');
}

function validateDirective(args) {
  const directiveRef = checkDirectiveOrExit(args.directive);
  process.stdout.write(JSON.stringify({ ok: true, directive_ref: directiveRef }) + '\n');
}

function listDirectives() {
  const active = Array.from(loadActiveDirectiveIds()).sort((a, b) => a.localeCompare(b));
  process.stdout.write(JSON.stringify({ ok: true, active_directives: active }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'create') {
    createEye(args);
    return;
  }
  if (cmd === 'validate') {
    validateDirective(args);
    return;
  }
  if (cmd === 'list-directives') {
    listDirectives();
    return;
  }
  console.error(`eyes_intake: unknown command '${cmd}'`);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  asList,
  normalizeId,
  loadActiveDirectiveIds
};
