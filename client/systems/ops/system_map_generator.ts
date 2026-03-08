#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

type MapEntry = {
  id: string,
  subsystem: string,
  layer: string,
  owner: string,
  purpose: string,
  inbound: string[],
  outbound: string[],
  failure_mode: string,
  health_check: string,
  srs: string[]
};

const DEFAULT_POLICY_PATH = process.env.SYSTEM_MAP_GENERATOR_POLICY_PATH
  ? path.resolve(process.env.SYSTEM_MAP_GENERATOR_POLICY_PATH)
  : path.join(ROOT, 'client', 'config', 'system_map_generator_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node client/systems/ops/system_map_generator.js run [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node client/systems/ops/system_map_generator.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    registry_path: 'client/config/system_map_registry.json',
    outputs: {
      markdown_path: 'client/docs/architecture/SYSTEM_MAP.md',
      latest_path: 'client/local/state/ops/system_map/latest.json',
      history_path: 'client/local/state/ops/system_map/history.jsonl'
    }
  };
}

function asList(v: unknown, maxLen = 160) {
  if (Array.isArray(v)) {
    return v.map((row) => cleanText(row, maxLen)).filter(Boolean);
  }
  const txt = cleanText(v || '', 8000);
  if (!txt) return [];
  return txt.split(',').map((row) => cleanText(row, maxLen)).filter(Boolean);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 32) || '1.0',
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    registry_path: resolvePath(raw.registry_path, base.registry_path),
    outputs: {
      markdown_path: resolvePath(outputs.markdown_path, base.outputs.markdown_path),
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function normalizeEntry(raw: AnyObj): MapEntry | null {
  const id = normalizeToken(raw.id || '', 120);
  const subsystem = cleanText(raw.subsystem || '', 120);
  const layer = cleanText(raw.layer || '', 80);
  if (!id || !subsystem || !layer) return null;
  return {
    id,
    subsystem,
    layer,
    owner: cleanText(raw.owner || 'unknown', 80) || 'unknown',
    purpose: cleanText(raw.purpose || '', 260),
    inbound: asList(raw.inbound, 120),
    outbound: asList(raw.outbound, 120),
    failure_mode: normalizeToken(raw.failure_mode || '', 120) || 'unknown_failure_mode',
    health_check: cleanText(raw.health_check || '', 220),
    srs: asList(raw.srs, 80)
  };
}

function layerRank(layer: string) {
  const raw = String(layer || '').toLowerCase();
  if (raw.includes('-1')) return 1;
  if (raw.includes('layer 0')) return 2;
  if (raw.includes('layer 1')) return 3;
  if (raw.includes('layer 2')) return 4;
  if (raw.includes('layer 3')) return 5;
  if (raw.includes('cross')) return 6;
  if (raw.includes('ops')) return 7;
  return 8;
}

function renderMarkdown(entries: MapEntry[], generatedAt: string) {
  const sorted = [...entries].sort((a, b) => {
    const lr = layerRank(a.layer) - layerRank(b.layer);
    if (lr !== 0) return lr;
    return a.subsystem.localeCompare(b.subsystem);
  });
  const layerCounts: Record<string, number> = {};
  for (const entry of sorted) {
    layerCounts[entry.layer] = Number(layerCounts[entry.layer] || 0) + 1;
  }

  const lines: string[] = [];
  lines.push('# System Map');
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push('');
  lines.push('This map is generated from `client/config/system_map_registry.json` via `system_map_generator` and is the canonical quick-reference for subsystem purpose, ownership, and health checks.');
  lines.push('');
  lines.push('## Layer Coverage');
  lines.push('');
  lines.push('| Layer | Subsystems |');
  lines.push('|---|---:|');
  for (const layer of Object.keys(layerCounts).sort((a, b) => layerRank(a) - layerRank(b))) {
    lines.push(`| ${layer} | ${layerCounts[layer]} |`);
  }
  lines.push('');
  lines.push('## Subsystem Map');
  lines.push('');
  lines.push('| Subsystem | Layer | Purpose | Owner | Inputs | Outputs | Failure Mode | Health Check | SRS |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const entry of sorted) {
    const srs = entry.srs.length ? entry.srs.map((id) => `\`${id}\``).join(', ') : '';
    lines.push(
      `| ${entry.subsystem} | ${entry.layer} | ${entry.purpose} | ${entry.owner} | ${entry.inbound.join('; ')} | ${entry.outbound.join('; ')} | ${entry.failure_mode} | \`${entry.health_check}\` | ${srs} |`
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function run(policy: AnyObj, args: AnyObj) {
  const strict = toBool(args.strict, policy.strict_default);
  const apply = toBool(args.apply, true);
  const registry = readJson(policy.registry_path, null);
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.entries)) {
    return {
      ok: false,
      type: 'system_map_generator',
      action: 'run',
      ts: nowIso(),
      error: 'registry_missing_or_invalid',
      policy_path: policy.policy_path,
      registry_path: policy.registry_path,
      strict,
      apply
    };
  }
  const entries = registry.entries.map((row: AnyObj) => normalizeEntry(row)).filter(Boolean);
  if (strict && entries.length === 0) {
    return {
      ok: false,
      type: 'system_map_generator',
      action: 'run',
      ts: nowIso(),
      error: 'no_valid_entries',
      policy_path: policy.policy_path,
      registry_path: policy.registry_path,
      strict,
      apply
    };
  }
  const ts = nowIso();
  const markdown = renderMarkdown(entries as MapEntry[], ts);
  const receipt = {
    ok: true,
    type: 'system_map_generator',
    action: 'run',
    ts,
    strict,
    apply,
    entry_count: entries.length,
    policy_path: policy.policy_path,
    registry_path: policy.registry_path,
    markdown_path: policy.outputs.markdown_path,
    latest_path: policy.outputs.latest_path,
    history_path: policy.outputs.history_path,
    receipt_id: stableHash(`system_map|${ts}|${entries.length}`, 24)
  };
  if (apply) {
    writeJsonAtomic(policy.outputs.latest_path, {
      ...receipt,
      entries
    });
    appendJsonl(policy.outputs.history_path, receipt);
    const fs = require('fs');
    fs.mkdirSync(path.dirname(policy.outputs.markdown_path), { recursive: true });
    fs.writeFileSync(policy.outputs.markdown_path, markdown, 'utf8');
  }
  return receipt;
}

function status(policy: AnyObj) {
  return {
    ok: true,
    type: 'system_map_generator',
    action: 'status',
    ts: nowIso(),
    policy_path: policy.policy_path,
    latest: readJson(policy.outputs.latest_path, null)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 40) || 'status';
  if (cmd === 'help') {
    usage();
    emit({ ok: true, type: 'system_map_generator', action: 'help', ts: nowIso() }, 0);
  }
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) {
    emit({ ok: false, type: 'system_map_generator', action: cmd, ts: nowIso(), error: 'lane_disabled', policy_path: policy.policy_path }, 2);
  }

  if (cmd === 'run') {
    const out = run(policy, args);
    emit(out, out.ok ? 0 : 1);
  }
  if (cmd === 'status') {
    emit(status(policy), 0);
  }
  usage();
  emit({ ok: false, type: 'system_map_generator', action: cmd, ts: nowIso(), error: `unknown_command:${cmd}` }, 2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  run,
  status,
  renderMarkdown
};
