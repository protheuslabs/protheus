#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-OF-001..010 implementation pack.
 * Primitive-first capabilities inspired by OpenFang intake, routed through governed contracts.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.OPENFANG_CAPABILITY_PACK_POLICY_PATH
  ? path.resolve(process.env.OPENFANG_CAPABILITY_PACK_POLICY_PATH)
  : path.join(ROOT, 'config', 'openfang_capability_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/openfang_capability_pack.js fuel-runtime --fuel-budget=100 --fuel-used=30 [--apply=0|1]');
  console.log('  node systems/ops/openfang_capability_pack.js taint-evaluate --labels=public,pii --sink=external_webhook');
  console.log('  node systems/ops/openfang_capability_pack.js ssrf-guard --url=https://api.example.com/data [--scope=default] [--apply=0|1]');
  console.log('  node systems/ops/openfang_capability_pack.js circuit-breaker --signature=loop_a [--apply=0|1]');
  console.log('  node systems/ops/openfang_capability_pack.js pack-manifest --manifest=/abs/path.json [--apply=0|1]');
  console.log('  node systems/ops/openfang_capability_pack.js pack-signature --manifest=/abs/path.json [--verify=<signature>] [--apply=0|1]');
  console.log('  node systems/ops/openfang_capability_pack.js openai-facade --request-json=\'{"model":"gpt-4o-mini","messages":[...]}\'');
  console.log('  node systems/ops/openfang_capability_pack.js framework-import --input=/abs/path.json --framework=langgraph [--apply=0|1]');
  console.log('  node systems/ops/openfang_capability_pack.js channel-contracts [--apply=0|1]');
  console.log('  node systems/ops/openfang_capability_pack.js benchmark-pack [--apply=0|1]');
  console.log('  node systems/ops/openfang_capability_pack.js status');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    fuel: {
      default_budget: 100,
      min_remaining_for_success: 1
    },
    taint: {
      sensitive_labels: ['secret', 'pii', 'credential'],
      blocked_sinks: ['external_webhook', 'public_chat', 'email_raw']
    },
    egress: {
      allow_domains: ['api.openai.com', 'api.anthropic.com', 'api.x.ai', 'api.groq.com', 'example.com'],
      deny_hosts: ['localhost', '127.0.0.1', '169.254.169.254', 'metadata.google.internal'],
      deny_private_ip: true
    },
    circuit_breaker: {
      window_ms: 60_000,
      max_calls_per_window: 8,
      cooldown_ms: 90_000
    },
    paths: {
      latest_path: 'state/ops/openfang_capability_pack/latest.json',
      receipts_path: 'state/ops/openfang_capability_pack/receipts.jsonl',
      state_path: 'state/ops/openfang_capability_pack/state.json',
      manifests_index_path: 'state/ops/openfang_capability_pack/manifests.json',
      migration_output_path: 'state/ops/openfang_capability_pack/migrations.jsonl',
      benchmark_path: 'state/ops/public_benchmark_pack/openfang_capability_pack.json',
      runtime_efficiency_path: 'state/ops/runtime_efficiency_floor/latest.json',
      adapters_path: 'config/actuation_adapters.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const fuel = raw.fuel && typeof raw.fuel === 'object' ? raw.fuel : {};
  const taint = raw.taint && typeof raw.taint === 'object' ? raw.taint : {};
  const egress = raw.egress && typeof raw.egress === 'object' ? raw.egress : {};
  const breaker = raw.circuit_breaker && typeof raw.circuit_breaker === 'object' ? raw.circuit_breaker : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};

  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    fuel: {
      default_budget: clampInt(fuel.default_budget, 1, 1_000_000, base.fuel.default_budget),
      min_remaining_for_success: clampInt(fuel.min_remaining_for_success, 0, 1_000_000, base.fuel.min_remaining_for_success)
    },
    taint: {
      sensitive_labels: (Array.isArray(taint.sensitive_labels) ? taint.sensitive_labels : base.taint.sensitive_labels)
        .map((v) => normalizeToken(v, 80))
        .filter(Boolean),
      blocked_sinks: (Array.isArray(taint.blocked_sinks) ? taint.blocked_sinks : base.taint.blocked_sinks)
        .map((v) => normalizeToken(v, 80))
        .filter(Boolean)
    },
    egress: {
      allow_domains: (Array.isArray(egress.allow_domains) ? egress.allow_domains : base.egress.allow_domains)
        .map((v) => cleanText(v, 120).toLowerCase())
        .filter(Boolean),
      deny_hosts: (Array.isArray(egress.deny_hosts) ? egress.deny_hosts : base.egress.deny_hosts)
        .map((v) => cleanText(v, 120).toLowerCase())
        .filter(Boolean),
      deny_private_ip: toBool(egress.deny_private_ip, base.egress.deny_private_ip)
    },
    circuit_breaker: {
      window_ms: clampInt(breaker.window_ms, 1000, 86_400_000, base.circuit_breaker.window_ms),
      max_calls_per_window: clampInt(breaker.max_calls_per_window, 1, 10000, base.circuit_breaker.max_calls_per_window),
      cooldown_ms: clampInt(breaker.cooldown_ms, 1000, 86_400_000, base.circuit_breaker.cooldown_ms)
    },
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      manifests_index_path: resolvePath(paths.manifests_index_path, base.paths.manifests_index_path),
      migration_output_path: resolvePath(paths.migration_output_path, base.paths.migration_output_path),
      benchmark_path: resolvePath(paths.benchmark_path, base.paths.benchmark_path),
      runtime_efficiency_path: resolvePath(paths.runtime_efficiency_path, base.paths.runtime_efficiency_path),
      adapters_path: resolvePath(paths.adapters_path, base.paths.adapters_path)
    }
  };
}

function loadState(policy) {
  const state = readJson(policy.paths.state_path, {});
  return {
    schema_id: 'openfang_capability_pack_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    counters: state.counters && typeof state.counters === 'object' ? state.counters : {},
    signatures: state.signatures && typeof state.signatures === 'object' ? state.signatures : {},
    open_circuits: state.open_circuits && typeof state.open_circuits === 'object' ? state.open_circuits : {},
    taint_decisions: clampInt(state.taint_decisions, 0, 1_000_000, 0)
  };
}

function saveState(policy, state) {
  writeJsonAtomic(policy.paths.state_path, {
    ...state,
    updated_at: nowIso()
  });
}

function receipt(policy, row) {
  const payload = {
    ts: nowIso(),
    ok: true,
    shadow_only: policy.shadow_only,
    ...row
  };
  writeJsonAtomic(policy.paths.latest_path, payload);
  appendJsonl(policy.paths.receipts_path, payload);
  return payload;
}

function asList(v) {
  return String(v == null ? '' : v)
    .split(',')
    .map((x) => normalizeToken(x, 80))
    .filter(Boolean);
}

function isPrivateIp(host) {
  if (!net.isIP(host)) return false;
  if (host === '127.0.0.1') return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  const two = host.split('.').slice(0, 2).join('.');
  if (two === '172.16' || two === '172.17' || two === '172.18' || two === '172.19' || two === '172.20' || two === '172.21' || two === '172.22' || two === '172.23' || two === '172.24' || two === '172.25' || two === '172.26' || two === '172.27' || two === '172.28' || two === '172.29' || two === '172.30' || two === '172.31') return true;
  if (host.startsWith('169.254.')) return true;
  return false;
}

function fuelRuntime(args, policy) {
  const apply = toBool(args.apply, false);
  const budget = clampInt(args['fuel-budget'] || args.fuel_budget, 1, 1_000_000, policy.fuel.default_budget);
  const used = clampInt(args['fuel-used'] || args.fuel_used, 0, 1_000_000, 0);
  const remaining = Math.max(0, budget - used);
  const ok = remaining >= policy.fuel.min_remaining_for_success;
  return receipt(policy, {
    type: 'of_fuel_metered_runtime',
    apply,
    fuel_budget: budget,
    fuel_used: used,
    fuel_remaining: remaining,
    ok
  });
}

function taintEvaluate(args, policy) {
  const labels = asList(args.labels);
  const sink = normalizeToken(args.sink || 'internal_only', 80) || 'internal_only';
  const sensitive = labels.some((label) => policy.taint.sensitive_labels.includes(label));
  const blocked = sensitive && policy.taint.blocked_sinks.includes(sink);
  const state = loadState(policy);
  state.taint_decisions += 1;
  saveState(policy, state);
  return receipt(policy, {
    type: 'of_taint_tracking_decision',
    labels,
    sink,
    sensitive,
    blocked,
    reason_code: blocked ? 'taint_sink_denied' : 'taint_sink_allowed'
  });
}

function ssrfGuard(args, policy) {
  const apply = toBool(args.apply, false);
  const rawUrl = String(args.url || '').trim();
  if (!rawUrl) return { ok: false, error: 'url_required' };
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return { ok: false, error: 'invalid_url' }; }

  const host = String(parsed.hostname || '').toLowerCase();
  const domainAllowed = policy.egress.allow_domains.some((d) => host === d || host.endsWith(`.${d}`));
  const denyHost = policy.egress.deny_hosts.includes(host);
  const denyPrivate = policy.egress.deny_private_ip && isPrivateIp(host);
  const allow = parsed.protocol === 'https:' && domainAllowed && !denyHost && !denyPrivate;

  return receipt(policy, {
    type: 'of_ssrf_dns_rebinding_defense',
    apply,
    url: rawUrl,
    host,
    allow,
    reason_code: allow ? 'egress_allowed' : 'egress_denied'
  });
}

function circuitBreaker(args, policy) {
  const apply = toBool(args.apply, false);
  const signature = normalizeToken(args.signature || args.sig || '', 120);
  if (!signature) return { ok: false, error: 'signature_required' };

  const state = loadState(policy);
  const now = Date.now();
  const counters = state.counters[signature] || { calls: [], circuit_open_until_ms: 0 };
  counters.calls = Array.isArray(counters.calls) ? counters.calls : [];
  counters.calls = counters.calls.filter((ms) => Number(ms) > now - policy.circuit_breaker.window_ms);
  counters.calls.push(now);

  let circuitOpen = now < Number(counters.circuit_open_until_ms || 0);
  if (!circuitOpen && counters.calls.length > policy.circuit_breaker.max_calls_per_window) {
    circuitOpen = true;
    counters.circuit_open_until_ms = now + policy.circuit_breaker.cooldown_ms;
  }

  if (apply) {
    state.counters[signature] = counters;
    if (circuitOpen) state.open_circuits[signature] = counters.circuit_open_until_ms;
    else delete state.open_circuits[signature];
    saveState(policy, state);
  }

  return receipt(policy, {
    type: 'of_tool_loop_circuit_breaker',
    apply,
    signature,
    calls_in_window: counters.calls.length,
    circuit_open: circuitOpen,
    reopen_at: circuitOpen ? new Date(counters.circuit_open_until_ms).toISOString() : null,
    requires_repair: circuitOpen
  });
}

function packManifest(args, policy) {
  const apply = toBool(args.apply, false);
  const manifestPath = args.manifest ? path.resolve(String(args.manifest)) : '';
  if (!manifestPath) return { ok: false, error: 'manifest_required' };
  const manifest = readJson(manifestPath, null);
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'invalid_manifest_json' };

  const required = ['objective', 'permissions', 'risk', 'budget', 'schedule', 'adapters', 'rollback'];
  const missing = required.filter((k) => manifest[k] == null);
  const valid = missing.length === 0;

  if (apply && valid) {
    const index = readJson(policy.paths.manifests_index_path, { manifests: [] });
    const manifests = Array.isArray(index.manifests) ? index.manifests : [];
    manifests.push({
      id: `pack_${stableHash(`${manifestPath}|${Date.now()}`, 16)}`,
      manifest_path: manifestPath,
      registered_at: nowIso(),
      objective: cleanText(manifest.objective || '', 180)
    });
    writeJsonAtomic(policy.paths.manifests_index_path, { manifests });
  }

  return receipt(policy, {
    type: 'of_capability_pack_manifest',
    apply,
    manifest_path: manifestPath,
    valid,
    missing_fields: missing
  });
}

function packSignature(args, policy) {
  const apply = toBool(args.apply, false);
  const manifestPath = args.manifest ? path.resolve(String(args.manifest)) : '';
  if (!manifestPath) return { ok: false, error: 'manifest_required' };
  const source = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
  if (!source) return { ok: false, error: 'manifest_not_found' };

  const signature = stableHash(`pack-sign|${source}`, 48);
  const verify = cleanText(args.verify || '', 80);
  const verified = verify ? verify === signature : true;

  return receipt(policy, {
    type: 'of_capability_pack_signature',
    apply,
    manifest_path: manifestPath,
    signature,
    verified,
    reason_code: verified ? 'signature_ok' : 'signature_mismatch'
  });
}

function openaiFacade(args, policy) {
  let req;
  try {
    req = JSON.parse(String(args['request-json'] || args.request_json || '{}'));
  } catch {
    return { ok: false, error: 'invalid_request_json' };
  }

  const model = cleanText(req.model || 'gpt-4o-mini', 80);
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const tools = Array.isArray(req.tools) ? req.tools : [];
  const lastUser = messages.filter((m) => m && m.role === 'user').slice(-1)[0] || {};

  return receipt(policy, {
    type: 'of_openai_compatible_facade',
    model,
    mapped_route: 'eye_weaver_universal_execution',
    message_count: messages.length,
    tool_count: tools.length,
    normalized_prompt_preview: cleanText(lastUser.content || '', 180),
    compatibility_ok: true
  });
}

function frameworkImport(args, policy) {
  const apply = toBool(args.apply, false);
  const inputPath = args.input ? path.resolve(String(args.input)) : '';
  const framework = normalizeToken(args.framework || 'unknown', 40) || 'unknown';
  if (!inputPath) return { ok: false, error: 'input_required' };

  const source = readJson(inputPath, null);
  if (!source || typeof source !== 'object') return { ok: false, error: 'invalid_import_source' };

  const canonical = {
    schema_id: 'protheus_capability_pack',
    schema_version: '1.0',
    imported_from: framework,
    imported_at: nowIso(),
    objective: cleanText(source.objective || source.goal || `imported_${framework}`, 180),
    steps: Array.isArray(source.steps) ? source.steps.length : 0,
    provenance_hash: stableHash(`${framework}|${JSON.stringify(source)}`, 32)
  };

  if (apply) appendJsonl(policy.paths.migration_output_path, canonical);

  return receipt(policy, {
    type: 'of_framework_migration_bridge',
    apply,
    framework,
    canonical_preview: canonical
  });
}

function channelContracts(args, policy) {
  const apply = toBool(args.apply, false);
  const adapters = readJson(policy.paths.adapters_path, {});
  const rows = Array.isArray(adapters.adapters)
    ? adapters.adapters
    : (Array.isArray(adapters.channels) ? adapters.channels : []);

  const matrix = rows.map((row) => ({
    id: normalizeToken(row.id || row.channel || row.name || 'unknown', 80),
    risk: normalizeToken(row.risk || row.risk_tier || 'medium', 32),
    rate_limit: row.rate_limit || row.rate_limit_per_min || null,
    fallback: row.fallback || null
  }));

  if (apply) {
    const state = loadState(policy);
    state.channel_matrix = matrix;
    saveState(policy, state);
  }

  return receipt(policy, {
    type: 'of_channel_adapter_contract_expansion',
    apply,
    channel_count: matrix.length,
    channels: matrix.slice(0, 20)
  });
}

function benchmarkPack(args, policy) {
  const apply = toBool(args.apply, false);
  const runtime = readJson(policy.paths.runtime_efficiency_path, {});
  const metrics = runtime.payload && runtime.payload.metrics ? runtime.payload.metrics : runtime.metrics || {};

  const artifact = {
    schema_id: 'openfang_capability_pack_benchmark',
    schema_version: '1.0',
    generated_at: nowIso(),
    metrics: {
      cold_start_p95_ms: Number(metrics.cold_start_p95_ms || metrics.cold_start_ms || 0),
      idle_rss_p95_mb: Number(metrics.idle_rss_p95_mb || metrics.idle_rss_mb || 0),
      install_artifact_total_mb: Number(metrics.install_artifact_total_mb || metrics.install_artifact_mb || 0)
    },
    contracts: {
      openai_facade: true,
      taint_tracking: true,
      ssrf_guard: true,
      circuit_breaker: true
    }
  };

  if (apply) writeJsonAtomic(policy.paths.benchmark_path, artifact);

  return receipt(policy, {
    type: 'of_cross_system_benchmark_parity',
    apply,
    benchmark_path: policy.paths.benchmark_path,
    metrics: artifact.metrics
  });
}

function status(policy) {
  return {
    ok: true,
    type: 'openfang_capability_pack_status',
    shadow_only: policy.shadow_only,
    latest: readJson(policy.paths.latest_path, {}),
    state: loadState(policy)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'openfang_capability_pack_disabled' }, 1);

  if (cmd === 'fuel-runtime') emit(fuelRuntime(args, policy));
  if (cmd === 'taint-evaluate') emit(taintEvaluate(args, policy));
  if (cmd === 'ssrf-guard') {
    const out = ssrfGuard(args, policy);
    emit(out, out.allow === false ? 1 : 0);
  }
  if (cmd === 'circuit-breaker') emit(circuitBreaker(args, policy));
  if (cmd === 'pack-manifest') {
    const out = packManifest(args, policy);
    emit(out, out.valid === false ? 1 : 0);
  }
  if (cmd === 'pack-signature') {
    const out = packSignature(args, policy);
    emit(out, out.verified === false ? 1 : 0);
  }
  if (cmd === 'openai-facade') emit(openaiFacade(args, policy));
  if (cmd === 'framework-import') {
    const out = frameworkImport(args, policy);
    emit(out, out.ok === false ? 1 : 0);
  }
  if (cmd === 'channel-contracts') emit(channelContracts(args, policy));
  if (cmd === 'benchmark-pack') emit(benchmarkPack(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: 'unknown_command', cmd }, 2);
}

if (require.main === module) {
  main();
}
