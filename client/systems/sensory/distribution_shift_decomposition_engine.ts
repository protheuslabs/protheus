#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-099
 * Distribution shift decomposition engine.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.DISTRIBUTION_SHIFT_POLICY_PATH
  ? path.resolve(process.env.DISTRIBUTION_SHIFT_POLICY_PATH)
  : path.join(ROOT, 'config', 'distribution_shift_decomposition_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
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

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function stableHash(v: unknown, len = 18) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    components: ['source', 'topic', 'style', 'population'],
    component_thresholds: {
      source: 0.2,
      topic: 0.25,
      style: 0.2,
      population: 0.2
    },
    paths: {
      baseline_path: 'state/sensory/features/baseline.json',
      current_dir: 'state/sensory/features/current',
      output_dir: 'state/sensory/analysis/distribution_shift',
      latest_path: 'state/sensory/analysis/distribution_shift/latest.json',
      receipts_path: 'state/sensory/analysis/distribution_shift/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const thresholds = raw.component_thresholds && typeof raw.component_thresholds === 'object' ? raw.component_thresholds : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    components: Array.isArray(raw.components) ? raw.components.map((c: any) => normalizeToken(c, 60)).filter(Boolean) : base.components,
    component_thresholds: {
      source: Number.isFinite(Number(thresholds.source)) ? Number(thresholds.source) : base.component_thresholds.source,
      topic: Number.isFinite(Number(thresholds.topic)) ? Number(thresholds.topic) : base.component_thresholds.topic,
      style: Number.isFinite(Number(thresholds.style)) ? Number(thresholds.style) : base.component_thresholds.style,
      population: Number.isFinite(Number(thresholds.population)) ? Number(thresholds.population) : base.component_thresholds.population
    },
    paths: {
      baseline_path: resolvePath(paths.baseline_path, base.paths.baseline_path),
      current_dir: resolvePath(paths.current_dir, base.paths.current_dir),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadRowsFrom(pathLike: string) {
  const src = readJson(pathLike, null);
  const rows = src && Array.isArray(src.rows) ? src.rows : [];
  return rows.filter((row: any) => row && typeof row === 'object');
}

function distribution(rows: Record<string, any>[], key: string) {
  const counts = new Map();
  for (const row of rows || []) {
    const token = normalizeToken(row && row[key] || 'unknown', 120) || 'unknown';
    counts.set(token, Number(counts.get(token) || 0) + 1);
  }
  const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
  const probs = new Map();
  for (const [token, count] of counts.entries()) {
    probs.set(token, total > 0 ? count / total : 0);
  }
  return probs;
}

function totalVariation(p: Map<string, number>, q: Map<string, number>) {
  const keys = new Set([...p.keys(), ...q.keys()]);
  let sum = 0;
  for (const key of keys) {
    sum += Math.abs(Number(p.get(key) || 0) - Number(q.get(key) || 0));
  }
  return 0.5 * sum;
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const baselineRows = loadRowsFrom(policy.paths.baseline_path);
  const currentPath = path.join(policy.paths.current_dir, `${dateStr}.json`);
  const currentRows = loadRowsFrom(currentPath);

  const components = (policy.components || []).length > 0 ? policy.components : ['source', 'topic', 'style', 'population'];
  const decomposition = [];
  const remediation = [];

  for (const component of components) {
    const baseDist = distribution(baselineRows, component);
    const currentDist = distribution(currentRows, component);
    const shift = totalVariation(baseDist, currentDist);
    const threshold = Number(policy.component_thresholds && policy.component_thresholds[component] || 0.2);
    const trigger = shift >= threshold;

    decomposition.push({
      component,
      shift_score: Number(shift.toFixed(6)),
      threshold: Number(threshold.toFixed(6)),
      trigger
    });

    if (trigger) {
      remediation.push({
        remediation_id: `shift_${stableHash(`${dateStr}|${component}|${shift}`, 20)}`,
        component,
        shift_score: Number(shift.toFixed(6)),
        threshold: Number(threshold.toFixed(6)),
        action: `targeted_rebalancing_for_${component}`
      });
    }
  }

  decomposition.sort((a, b) => Number(b.shift_score || 0) - Number(a.shift_score || 0));

  const out = {
    ok: true,
    type: 'distribution_shift_decomposition_engine',
    ts: nowIso(),
    date: dateStr,
    source_paths: {
      baseline: policy.paths.baseline_path,
      current: currentPath
    },
    decomposition,
    remediation,
    triggered_components: remediation.length
  };

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'distribution_shift_decomposition_receipt',
    date: dateStr,
    triggered_components: remediation.length,
    top_component: decomposition[0] ? decomposition[0].component : null,
    top_shift_score: decomposition[0] ? decomposition[0].shift_score : 0
  });

  if (strict && remediation.length > 0) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.output_dir, `${dateStr}.json`);
  const payload = readJson(fp, {
    ok: true,
    type: 'distribution_shift_decomposition_engine_status',
    date: dateStr,
    triggered_components: 0
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/distribution_shift_decomposition_engine.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/distribution_shift_decomposition_engine.js status [YYYY-MM-DD] [--policy=<path>]');
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase() || 'status';
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(args._[1] || '')) ? String(args._[1]) : todayStr();
  const strict = toBool(args.strict, false);
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'policy_disabled' }, null, 2)}\n`);
    process.exit(2);
  }
  if (cmd === 'run') return run(dateStr, policy, strict);
  if (cmd === 'status') return status(policy, dateStr);
  return usageAndExit(2);
}

module.exports = {
  run
};

if (require.main === module) {
  main();
}
