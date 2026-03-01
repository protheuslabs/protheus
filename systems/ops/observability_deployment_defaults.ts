#!/usr/bin/env node
'use strict';
export {};

/** V3-RACE-012 */
const path = require('path');
const {
  ROOT, nowIso, parseArgs, normalizeToken, toBool,
  readJson, writeJsonAtomic, appendJsonl, resolvePath, emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.OBS_DEPLOY_DEFAULTS_POLICY_PATH
  ? path.resolve(process.env.OBS_DEPLOY_DEFAULTS_POLICY_PATH)
  : path.join(ROOT, 'config', 'observability_deployment_defaults_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/observability_deployment_defaults.js generate');
  console.log('  node systems/ops/observability_deployment_defaults.js status');
}

function policy() {
  const base = {
    enabled: true,
    shadow_only: true,
    paths: {
      latest_path: 'state/ops/observability_deployment_defaults/latest.json',
      receipts_path: 'state/ops/observability_deployment_defaults/receipts.jsonl',
      manifest_path: 'deploy/observability/defaults.json'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      manifest_path: resolvePath(paths.manifest_path, base.paths.manifest_path)
    }
  };
}

function generateManifest(p: any) {
  const manifest = {
    schema_version: '1.0',
    generated_at: nowIso(),
    stack: {
      metrics: 'prometheus',
      logs: 'loki',
      traces: 'otel_collector',
      dashboards: 'grafana'
    },
    one_command_bringup: 'docker compose -f deploy/observability/docker-compose.yml up -d',
    contract_tests: ['trace_contract', 'metrics_exporter', 'log_ingest']
  };
  writeJsonAtomic(p.paths.manifest_path, manifest);
  const out = { ts: nowIso(), type: 'observability_deployment_defaults_generate', ok: true, shadow_only: p.shadow_only, manifest_path: 'deploy/observability/defaults.json' };
  writeJsonAtomic(p.paths.latest_path, out);
  appendJsonl(p.paths.receipts_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    return;
  }
  const p = policy();
  if (!p.enabled) emit({ ok: false, error: 'observability_deployment_defaults_disabled' }, 1);
  if (cmd === 'generate') emit(generateManifest(p));
  if (cmd === 'status') emit({ ok: true, type: 'observability_deployment_defaults_status', latest: readJson(p.paths.latest_path, {}) });
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
