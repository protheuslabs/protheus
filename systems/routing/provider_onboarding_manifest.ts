#!/usr/bin/env node
'use strict';
export {};

/**
 * provider_onboarding_manifest.js
 *
 * Config-only provider onboarding for RM-121.
 * Auto-wires:
 * - config/agent_routing_rules.json (model profile + allowlist + provider budget/guard)
 * - config/model_adapters.json (provider profile metadata)
 * - config/secret_broker_policy.json (provider api key secret spec)
 * - config/trainability_matrix_policy.json (provider rules)
 * - state/routing/provider_onboarding_receipts.jsonl (receipt trail)
 *
 * Usage:
 *   node systems/routing/provider_onboarding_manifest.js list [--manifest=...]
 *   node systems/routing/provider_onboarding_manifest.js run --provider=<id> [--apply=1] [--strict=1]
 *   node systems/routing/provider_onboarding_manifest.js status --provider=<id>
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MANIFEST_PATH = process.env.PROVIDER_ONBOARDING_MANIFEST_PATH
  ? path.resolve(String(process.env.PROVIDER_ONBOARDING_MANIFEST_PATH))
  : path.join(ROOT, 'config', 'provider_onboarding_manifest.json');
const DEFAULT_ROUTING_CONFIG_PATH = process.env.PROVIDER_ONBOARDING_ROUTING_CONFIG_PATH
  ? path.resolve(String(process.env.PROVIDER_ONBOARDING_ROUTING_CONFIG_PATH))
  : path.join(ROOT, 'config', 'agent_routing_rules.json');
const DEFAULT_MODE_ADAPTERS_PATH = process.env.PROVIDER_ONBOARDING_MODE_ADAPTERS_PATH
  ? path.resolve(String(process.env.PROVIDER_ONBOARDING_MODE_ADAPTERS_PATH))
  : path.join(ROOT, 'config', 'model_adapters.json');
const DEFAULT_SECRET_POLICY_PATH = process.env.PROVIDER_ONBOARDING_SECRET_POLICY_PATH
  ? path.resolve(String(process.env.PROVIDER_ONBOARDING_SECRET_POLICY_PATH))
  : path.join(ROOT, 'config', 'secret_broker_policy.json');
const DEFAULT_TRAINABILITY_POLICY_PATH = process.env.PROVIDER_ONBOARDING_TRAINABILITY_POLICY_PATH
  ? path.resolve(String(process.env.PROVIDER_ONBOARDING_TRAINABILITY_POLICY_PATH))
  : path.join(ROOT, 'config', 'trainability_matrix_policy.json');
const DEFAULT_RECEIPTS_PATH = process.env.PROVIDER_ONBOARDING_RECEIPTS_PATH
  ? path.resolve(String(process.env.PROVIDER_ONBOARDING_RECEIPTS_PATH))
  : path.join(ROOT, 'state', 'routing', 'provider_onboarding_receipts.jsonl');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function token(v: unknown, maxLen = 120) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    if (!String(arg).startsWith('--')) {
      out._.push(String(arg));
      continue;
    }
    const idx = String(arg).indexOf('=');
    if (idx === -1) out[String(arg).slice(2)] = true;
    else out[String(arg).slice(2, idx)] = String(arg).slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function defaultManifest() {
  return {
    version: '1.0',
    providers: {
      openai_gpt5_cloud: {
        enabled: false,
        model_id: 'openai/gpt-5.2',
        provider_key: 'openai',
        tiers: [2, 3],
        roles: ['planning', 'logic', 'coding', 'general'],
        class: 'cloud_specialist',
        spawn_allowed: true,
        budget: {
          daily_token_cap: 24000,
          request_token_cap: 3200
        },
        guard: {
          max_risk: 'high',
          require_second_opinion_for_high_risk: true
        },
        secret: {
          secret_id: 'openai_api_key',
          env_var: 'OPENAI_API_KEY'
        },
        trainability: {
          allow: false,
          note: 'Third-party terms review required.'
        }
      }
    }
  };
}

function loadManifest(manifestPath: string) {
  const raw = readJson(manifestPath, {});
  const base = defaultManifest();
  const srcProviders = raw && raw.providers && typeof raw.providers === 'object'
    ? raw.providers
    : base.providers;
  const providers: AnyObj = {};
  for (const [idRaw, rowRaw] of Object.entries(srcProviders || {})) {
    const id = token(idRaw, 120);
    if (!id) continue;
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw as AnyObj : {};
    const modelId = clean(row.model_id || '', 180);
    if (!modelId) continue;
    const providerKey = token(row.provider_key || id.split('_')[0] || id, 120) || id;
    const tiersRaw = Array.isArray(row.tiers) ? row.tiers : [2];
    const tiers = tiersRaw
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n))
      .map((n) => Math.max(1, Math.min(3, Math.floor(n))));
    const rolesRaw = Array.isArray(row.roles) ? row.roles : ['general'];
    const roles = rolesRaw.map((v) => token(v, 60)).filter(Boolean);
    const secret = row.secret && typeof row.secret === 'object' ? row.secret : {};
    const budget = row.budget && typeof row.budget === 'object' ? row.budget : {};
    const guard = row.guard && typeof row.guard === 'object' ? row.guard : {};
    const trainability = row.trainability && typeof row.trainability === 'object' ? row.trainability : {};
    providers[id] = {
      id,
      enabled: row.enabled !== false,
      model_id: modelId,
      provider_key: providerKey,
      tiers: Array.from(new Set(tiers.length ? tiers : [2])),
      roles: Array.from(new Set(roles.length ? roles : ['general'])),
      class: token(row.class || 'cloud_specialist', 80) || 'cloud_specialist',
      spawn_allowed: row.spawn_allowed !== false,
      budget: {
        daily_token_cap: Math.max(500, Number(budget.daily_token_cap || 12000) || 12000),
        request_token_cap: Math.max(200, Number(budget.request_token_cap || 1800) || 1800)
      },
      guard: {
        max_risk: token(guard.max_risk || 'medium', 20) || 'medium',
        require_second_opinion_for_high_risk: guard.require_second_opinion_for_high_risk === true
      },
      secret: {
        secret_id: token(secret.secret_id || `${providerKey}_api_key`, 120) || `${providerKey}_api_key`,
        env_var: clean(secret.env_var || `${providerKey.toUpperCase()}_API_KEY`, 80) || `${providerKey.toUpperCase()}_API_KEY`
      },
      trainability: {
        allow: trainability.allow === true,
        note: clean(trainability.note || 'Provider-specific terms review required.', 200)
      }
    };
  }
  return {
    version: clean(raw && raw.version || base.version, 24) || '1.0',
    providers
  };
}

function resolvePaths(args: AnyObj) {
  return {
    manifest_path: args.manifest ? path.resolve(String(args.manifest)) : DEFAULT_MANIFEST_PATH,
    routing_config_path: args['routing-config'] ? path.resolve(String(args['routing-config'])) : DEFAULT_ROUTING_CONFIG_PATH,
    mode_adapters_path: args['mode-adapters'] ? path.resolve(String(args['mode-adapters'])) : DEFAULT_MODE_ADAPTERS_PATH,
    secret_policy_path: args['secret-policy'] ? path.resolve(String(args['secret-policy'])) : DEFAULT_SECRET_POLICY_PATH,
    trainability_policy_path: args['trainability-policy'] ? path.resolve(String(args['trainability-policy'])) : DEFAULT_TRAINABILITY_POLICY_PATH,
    receipts_path: args['receipts-path'] ? path.resolve(String(args['receipts-path'])) : DEFAULT_RECEIPTS_PATH
  };
}

function applyRoutingConfig(input: AnyObj, provider: AnyObj) {
  const next = deepClone(input && typeof input === 'object' ? input : { version: 1, routing: {} });
  if (!next.routing || typeof next.routing !== 'object') next.routing = {};
  if (!Array.isArray(next.routing.spawn_model_allowlist)) next.routing.spawn_model_allowlist = [];
  if (!next.routing.model_profiles || typeof next.routing.model_profiles !== 'object') next.routing.model_profiles = {};
  if (!next.routing.provider_budgets || typeof next.routing.provider_budgets !== 'object') next.routing.provider_budgets = {};
  if (!next.routing.provider_guardrails || typeof next.routing.provider_guardrails !== 'object') next.routing.provider_guardrails = {};

  next.routing.model_profiles[provider.model_id] = {
    tiers: provider.tiers,
    roles: provider.roles,
    class: provider.class
  };
  if (provider.spawn_allowed === true) {
    const allow = new Set((next.routing.spawn_model_allowlist || []).map((v: unknown) => clean(v, 180)).filter(Boolean));
    allow.add(provider.model_id);
    next.routing.spawn_model_allowlist = Array.from(allow);
  }
  next.routing.provider_budgets[provider.id] = {
    daily_token_cap: provider.budget.daily_token_cap,
    request_token_cap: provider.budget.request_token_cap,
    model_id: provider.model_id
  };
  next.routing.provider_guardrails[provider.id] = {
    provider_key: provider.provider_key,
    model_id: provider.model_id,
    max_risk: provider.guard.max_risk,
    require_second_opinion_for_high_risk: provider.guard.require_second_opinion_for_high_risk === true
  };
  return next;
}

function applyModeAdapters(input: AnyObj, provider: AnyObj) {
  const next = deepClone(input && typeof input === 'object' ? input : { schema_version: 1, mode_routing: {} });
  if (!next.provider_profiles || typeof next.provider_profiles !== 'object') next.provider_profiles = {};
  next.provider_profiles[provider.id] = {
    provider_key: provider.provider_key,
    model_id: provider.model_id,
    tiers: provider.tiers,
    roles: provider.roles,
    class: provider.class,
    enabled: true,
    onboarding_version: '1.0'
  };
  return next;
}

function applySecretPolicy(input: AnyObj, provider: AnyObj) {
  const next = deepClone(input && typeof input === 'object' ? input : { version: '1.0', secrets: {} });
  if (!next.secrets || typeof next.secrets !== 'object') next.secrets = {};
  if (!next.secrets[provider.secret.secret_id]) {
    next.secrets[provider.secret.secret_id] = {
      providers: [
        {
          type: 'env',
          env: provider.secret.env_var,
          rotated_at_env: `${provider.secret.env_var}_ROTATED_AT`
        },
        {
          type: 'json_file',
          paths: [
            '${DEFAULT_SECRETS_DIR}/provider.credentials.json',
            `${'${HOME}'}/.config/providers/${provider.id}.credentials.json`
          ],
          field: 'api_key',
          rotated_at_field: 'rotated_at'
        }
      ],
      rotation: {
        warn_after_days: 45,
        max_after_days: 90,
        require_rotated_at: false,
        enforce_on_issue: false
      }
    };
  }
  return next;
}

function applyTrainabilityPolicy(input: AnyObj, provider: AnyObj) {
  const next = deepClone(input && typeof input === 'object' ? input : { version: '1.0', default_allow: false, provider_rules: {} });
  if (!next.provider_rules || typeof next.provider_rules !== 'object') next.provider_rules = {};
  next.provider_rules[provider.provider_key] = {
    allow: provider.trainability.allow === true,
    allowed_license_ids: provider.trainability.allow === true ? ['explicit_operator_approved'] : [],
    allowed_consent_modes: provider.trainability.allow === true ? ['explicit_opt_in'] : [],
    note: provider.trainability.note
  };
  return next;
}

function validateWires(routingCfg: AnyObj, adaptersCfg: AnyObj, secretCfg: AnyObj, trainabilityCfg: AnyObj, provider: AnyObj) {
  const checks = {
    routing_model_profile: !!(
      routingCfg
      && routingCfg.routing
      && routingCfg.routing.model_profiles
      && routingCfg.routing.model_profiles[provider.model_id]
    ),
    routing_budget_guard: !!(
      routingCfg
      && routingCfg.routing
      && routingCfg.routing.provider_budgets
      && routingCfg.routing.provider_budgets[provider.id]
      && routingCfg.routing.provider_guardrails
      && routingCfg.routing.provider_guardrails[provider.id]
    ),
    model_adapters_provider_profile: !!(
      adaptersCfg
      && adaptersCfg.provider_profiles
      && adaptersCfg.provider_profiles[provider.id]
    ),
    secret_policy_wired: !!(
      secretCfg
      && secretCfg.secrets
      && secretCfg.secrets[provider.secret.secret_id]
    ),
    trainability_policy_wired: !!(
      trainabilityCfg
      && trainabilityCfg.provider_rules
      && trainabilityCfg.provider_rules[provider.provider_key]
    )
  };
  const pass = Object.values(checks).every((v) => v === true);
  return { pass, checks };
}

function runOnboarding(args: AnyObj) {
  const started = Date.now();
  const paths = resolvePaths(args);
  const manifest = loadManifest(paths.manifest_path);
  const providerId = token(args.provider || '', 120);
  if (!providerId) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'provider_required' })}\n`);
    process.exit(2);
  }
  const provider = manifest.providers[providerId];
  if (!provider) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'provider_not_found', provider: providerId })}\n`);
    process.exit(2);
  }
  if (provider.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'provider_disabled', provider: providerId })}\n`);
    process.exit(2);
  }

  const apply = toBool(args.apply, false);
  const strict = toBool(args.strict, false);

  const routingCurrent = readJson(paths.routing_config_path, {});
  const modeAdaptersCurrent = readJson(paths.mode_adapters_path, {});
  const secretCurrent = readJson(paths.secret_policy_path, {});
  const trainabilityCurrent = readJson(paths.trainability_policy_path, {});

  const routingNext = applyRoutingConfig(routingCurrent, provider);
  const modeAdaptersNext = applyModeAdapters(modeAdaptersCurrent, provider);
  const secretNext = applySecretPolicy(secretCurrent, provider);
  const trainabilityNext = applyTrainabilityPolicy(trainabilityCurrent, provider);

  const validation = validateWires(routingNext, modeAdaptersNext, secretNext, trainabilityNext, provider);
  const changedFiles = [
    relPath(paths.routing_config_path),
    relPath(paths.mode_adapters_path),
    relPath(paths.secret_policy_path),
    relPath(paths.trainability_policy_path)
  ];

  if (apply) {
    writeJsonAtomic(paths.routing_config_path, routingNext);
    writeJsonAtomic(paths.mode_adapters_path, modeAdaptersNext);
    writeJsonAtomic(paths.secret_policy_path, secretNext);
    writeJsonAtomic(paths.trainability_policy_path, trainabilityNext);
    appendJsonl(paths.receipts_path, {
      ts: nowIso(),
      type: 'provider_onboarding',
      provider_id: provider.id,
      model_id: provider.model_id,
      provider_key: provider.provider_key,
      changed_files: changedFiles,
      checks: validation.checks,
      pass: validation.pass
    });
  }

  const payload = {
    ok: true,
    type: 'provider_onboarding_manifest',
    ts: nowIso(),
    mode: apply ? 'apply' : 'plan',
    manifest_path: relPath(paths.manifest_path),
    provider: {
      id: provider.id,
      model_id: provider.model_id,
      provider_key: provider.provider_key,
      tiers: provider.tiers,
      roles: provider.roles,
      class: provider.class,
      spawn_allowed: provider.spawn_allowed === true,
      secret_id: provider.secret.secret_id
    },
    changed_files: changedFiles,
    checks: validation.checks,
    pass: validation.pass,
    elapsed_ms: Date.now() - started,
    receipts_path: relPath(paths.receipts_path)
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && !validation.pass) process.exit(1);
}

function listProviders(args: AnyObj) {
  const paths = resolvePaths(args);
  const manifest = loadManifest(paths.manifest_path);
  const providers = Object.values(manifest.providers)
    .map((p: AnyObj) => ({
      id: p.id,
      enabled: p.enabled === true,
      provider_key: p.provider_key,
      model_id: p.model_id,
      tiers: p.tiers,
      roles: p.roles
    }))
    .sort((a: AnyObj, b: AnyObj) => String(a.id).localeCompare(String(b.id)));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'provider_onboarding_manifest_list',
    ts: nowIso(),
    manifest_path: relPath(paths.manifest_path),
    provider_count: providers.length,
    providers
  }, null, 2)}\n`);
}

function statusProvider(args: AnyObj) {
  const paths = resolvePaths(args);
  const manifest = loadManifest(paths.manifest_path);
  const providerId = token(args.provider || '', 120);
  if (!providerId) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'provider_required' })}\n`);
    process.exit(2);
  }
  const provider = manifest.providers[providerId];
  if (!provider) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'provider_not_found', provider: providerId })}\n`);
    process.exit(2);
  }
  const routingCfg = readJson(paths.routing_config_path, {});
  const modeAdaptersCfg = readJson(paths.mode_adapters_path, {});
  const secretCfg = readJson(paths.secret_policy_path, {});
  const trainabilityCfg = readJson(paths.trainability_policy_path, {});
  const validation = validateWires(routingCfg, modeAdaptersCfg, secretCfg, trainabilityCfg, provider);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'provider_onboarding_manifest_status',
    ts: nowIso(),
    provider_id: provider.id,
    model_id: provider.model_id,
    checks: validation.checks,
    pass: validation.pass
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/routing/provider_onboarding_manifest.js list [--manifest=path]');
  console.log('  node systems/routing/provider_onboarding_manifest.js run --provider=<id> [--apply=1] [--strict=1]');
  console.log('  node systems/routing/provider_onboarding_manifest.js status --provider=<id>');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = token(args._[0] || 'list', 40);
  if (cmd === 'list') return listProviders(args);
  if (cmd === 'run' || cmd === 'apply') return runOnboarding(args);
  if (cmd === 'status') return statusProvider(args);
  usage();
  process.exit(1);
}

main();

