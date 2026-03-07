#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.COMMAND_REGISTRY_POLICY_PATH
  ? path.resolve(process.env.COMMAND_REGISTRY_POLICY_PATH)
  : path.join(ROOT, 'config', 'command_registry_policy.json');

type AnyObj = Record<string, any>;

type CommandMeta = {
  owner: string;
  scope: string;
  risk_tier: number;
  source: string;
};

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function clampRiskTier(v: unknown) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 2;
  const i = Math.floor(n);
  if (i < 0) return 0;
  if (i > 4) return 4;
  return i;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/command_registry_surface_contract.js sync [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/command_registry_surface_contract.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/command_registry_surface_contract.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    paths: {
      package_json_path: 'package.json',
      registry_path: 'config/command_registry.json',
      generated_registry_path: 'state/ops/command_registry/generated_registry.json',
      docs_path: 'docs/ops/COMMAND_REGISTRY.md',
      latest_path: 'state/ops/command_registry/latest.json',
      receipts_path: 'state/ops/command_registry/receipts.jsonl'
    },
    curated_operator_surface: ['dev', 'build', 'start', 'test', 'lint', 'security:audit'],
    groups: [],
    explicit: {}
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, true),
    paths: {
      package_json_path: resolvePath(paths.package_json_path, base.paths.package_json_path),
      registry_path: resolvePath(paths.registry_path, base.paths.registry_path),
      generated_registry_path: resolvePath(paths.generated_registry_path, base.paths.generated_registry_path),
      docs_path: resolvePath(paths.docs_path, base.paths.docs_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    curated_operator_surface: Array.isArray(raw.curated_operator_surface)
      ? raw.curated_operator_surface.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
      : base.curated_operator_surface,
    groups: Array.isArray(raw.groups) ? raw.groups : base.groups,
    explicit: raw.explicit && typeof raw.explicit === 'object' ? raw.explicit : base.explicit,
    default_metadata: raw.default_metadata && typeof raw.default_metadata === 'object'
      ? raw.default_metadata
      : { owner: 'platform', scope: 'general', risk_tier: 2 }
  };
}

function normalizeMeta(raw: AnyObj, source: string): CommandMeta | null {
  const owner = cleanText(raw && raw.owner, 80);
  const scope = cleanText(raw && raw.scope, 80);
  if (!owner || !scope) return null;
  return {
    owner,
    scope,
    risk_tier: clampRiskTier(raw && raw.risk_tier),
    source
  };
}

function matchFromGroups(scriptName: string, groups: AnyObj[], source: string): CommandMeta | null {
  for (const row of groups) {
    const prefix = cleanText(row && row.prefix, 120);
    if (!prefix) continue;
    if (!scriptName.startsWith(prefix)) continue;
    const meta = normalizeMeta(row, source);
    if (meta) return meta;
  }
  return null;
}

function resolveMeta(scriptName: string, registry: AnyObj, policy: AnyObj): CommandMeta | null {
  const commandMap = registry && registry.commands && typeof registry.commands === 'object'
    ? registry.commands
    : {};
  const local = commandMap[scriptName];
  if (local) {
    const meta = normalizeMeta(local, 'registry.commands');
    if (meta) return meta;
  }

  const explicit = policy.explicit && typeof policy.explicit === 'object' ? policy.explicit[scriptName] : null;
  if (explicit) {
    const meta = normalizeMeta(explicit, 'policy.explicit');
    if (meta) return meta;
  }

  const registryGroups = Array.isArray(registry && registry.groups) ? registry.groups : [];
  const fromRegistryGroup = matchFromGroups(scriptName, registryGroups, 'registry.groups');
  if (fromRegistryGroup) return fromRegistryGroup;

  const policyGroups = Array.isArray(policy.groups) ? policy.groups : [];
  const fromPolicyGroup = matchFromGroups(scriptName, policyGroups, 'policy.groups');
  if (fromPolicyGroup) return fromPolicyGroup;

  return normalizeMeta(policy.default_metadata || {}, 'policy.default_metadata');
}

function buildDocs(generated: AnyObj, docsPath: string) {
  const lines: string[] = [];
  lines.push('# Command Registry');
  lines.push('');
  lines.push(`Generated: ${generated.generated_at}`);
  lines.push('');
  lines.push('## Curated Operator Surface');
  for (const scriptName of generated.curated_operator_surface) {
    lines.push(`- \`${scriptName}\``);
  }
  lines.push('');
  lines.push('## Registered Commands');
  lines.push('| Command | Owner | Scope | Risk Tier | Source |');
  lines.push('|---|---|---|---|---|');
  for (const row of generated.commands.slice(0, 400)) {
    lines.push(`| \`${row.name}\` | ${row.owner} | ${row.scope} | ${row.risk_tier} | ${row.source} |`);
  }
  lines.push('');
  lines.push(`Total commands: ${generated.commands.length}`);
  lines.push(`Missing metadata: ${generated.missing.length}`);
  require('fs').mkdirSync(path.dirname(docsPath), { recursive: true });
  require('fs').writeFileSync(docsPath, `${lines.join('\n')}\n`, 'utf8');
}

function runContract(policy: AnyObj, strict: boolean, mode: string) {
  const pkg = readJson(policy.paths.package_json_path, {});
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const scriptNames = Object.keys(scripts).sort();
  const registry = readJson(policy.paths.registry_path, {});

  const commands = [];
  const missing: string[] = [];
  for (const scriptName of scriptNames) {
    const meta = resolveMeta(scriptName, registry, policy);
    if (!meta) {
      missing.push(scriptName);
      continue;
    }
    commands.push({
      name: scriptName,
      command: cleanText(scripts[scriptName], 400),
      owner: meta.owner,
      scope: meta.scope,
      risk_tier: meta.risk_tier,
      source: meta.source
    });
  }

  const curated = Array.isArray(policy.curated_operator_surface) ? policy.curated_operator_surface : [];
  const curatedMissing = curated.filter((name: string) => !scripts[name]);

  const generated = {
    schema_id: 'command_registry_generated',
    schema_version: '1.0',
    generated_at: nowIso(),
    command_count: scriptNames.length,
    registered_count: commands.length,
    missing_count: missing.length,
    curated_operator_surface: curated,
    curated_missing: curatedMissing,
    commands,
    missing
  };

  writeJsonAtomic(policy.paths.generated_registry_path, generated);
  buildDocs(generated, policy.paths.docs_path);

  const checks = {
    command_registry_exists: generated.registered_count > 0,
    no_unregistered_scripts: generated.missing_count === 0,
    curated_surface_commands_exist: curatedMissing.length === 0
  };

  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blocking.length === 0;
  const ok = strict ? pass : true;

  const out = {
    ok,
    pass,
    strict,
    type: 'command_registry_surface_contract',
    mode,
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    counts: {
      scripts: scriptNames.length,
      registered: commands.length,
      missing: missing.length,
      curated_missing: curatedMissing.length
    },
    artifacts: {
      generated_registry_path: rel(policy.paths.generated_registry_path),
      docs_path: rel(policy.paths.docs_path),
      registry_path: rel(policy.paths.registry_path)
    }
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'check').toLowerCase();
  if (args.help || cmd === '--help' || cmd === 'help') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (cmd === 'status') {
    return emit(readJson(policy.paths.latest_path, {
      ok: true,
      type: 'command_registry_surface_contract',
      status: 'no_status',
      policy_path: rel(policyPath)
    }), 0);
  }

  if (cmd !== 'sync' && cmd !== 'check') {
    usage();
    return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
  }

  const strict = toBool(args.strict, policy.strict_default);
  const out = runContract(policy, strict, cmd);
  return emit(out, out.ok ? 0 : 1);
}

main();
