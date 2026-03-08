#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-MIGR-003
 * Universal importer bridge (OpenFang + generic adapters).
 */

const fs = require('fs');
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

const openfangImporter = require('./importers/openfang_importer.js');
const genericJsonImporter = require('./importers/generic_json_importer.js');
const genericYamlImporter = require('./importers/generic_yaml_importer.js');
const workflowGraphImporter = require('./importers/workflow_graph_importer.js');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.UNIVERSAL_IMPORTERS_POLICY_PATH
  ? path.resolve(process.env.UNIVERSAL_IMPORTERS_POLICY_PATH)
  : path.join(ROOT, 'config', 'universal_importers_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/migration/universal_importers.js run --from=<engine> --path=<source> [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/migration/universal_importers.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: false,
    signing: {
      key_env: 'PROTHEUS_MIGRATION_SIGNING_KEY',
      default_key: 'migration_dev_key',
      algorithm: 'sha256'
    },
    engine_aliases: {
      openfang: 'openfang',
      crewai: 'generic_json',
      autogen: 'generic_json',
      langgraph: 'workflow_graph',
      workflow_graph: 'workflow_graph',
      json: 'generic_json',
      yaml: 'generic_yaml',
      yml: 'generic_yaml',
      generic: 'generic_json',
      common_dump: 'generic_json'
    },
    paths: {
      latest_path: 'state/migration/importers/latest.json',
      receipts_path: 'state/migration/importers/receipts.jsonl',
      reports_root: 'state/migration/importers/reports',
      mapped_root: 'state/migration/importers/mapped'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const signing = raw.signing && typeof raw.signing === 'object' ? raw.signing : {};
  const aliases = raw.engine_aliases && typeof raw.engine_aliases === 'object'
    ? raw.engine_aliases
    : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    signing: {
      key_env: cleanText(signing.key_env || base.signing.key_env, 120),
      default_key: cleanText(signing.default_key || base.signing.default_key, 240),
      algorithm: cleanText(signing.algorithm || base.signing.algorithm, 40)
    },
    engine_aliases: {
      ...base.engine_aliases,
      ...Object.fromEntries(
        Object.entries(aliases).map(([k, v]) => [normalizeToken(k, 80), normalizeToken(v as string, 80)])
      )
    },
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      reports_root: resolvePath(paths.reports_root, base.paths.reports_root),
      mapped_root: resolvePath(paths.mapped_root, base.paths.mapped_root)
    },
    policy_path: path.resolve(policyPath)
  };
}

function sign(policy: AnyObj, payload: AnyObj) {
  const envName = cleanText(policy.signing.key_env || 'PROTHEUS_MIGRATION_SIGNING_KEY', 120) || 'PROTHEUS_MIGRATION_SIGNING_KEY';
  const secret = cleanText(process.env[envName] || policy.signing.default_key || 'migration_dev_key', 400) || 'migration_dev_key';
  return {
    algorithm: cleanText(policy.signing.algorithm || 'sha256', 40) || 'sha256',
    key_id: stableHash(`${envName}:${secret}`, 12),
    signature: stableHash(`${JSON.stringify(payload)}|${secret}`, 48)
  };
}

function writeReceipt(policy: AnyObj, payload: AnyObj) {
  const row = {
    ts: nowIso(),
    schema_id: 'universal_importers_receipt',
    schema_version: '1.0',
    ...payload
  };
  row.signature = sign(policy, {
    type: row.type,
    ok: row.ok === true,
    import_id: row.import_id || null,
    source_engine: row.source_engine || null
  });
  writeJsonAtomic(policy.paths.latest_path, row);
  appendJsonl(policy.paths.receipts_path, row);
  return row;
}

function resolveEngine(policy: AnyObj, fromRaw: string) {
  const normalized = normalizeToken(fromRaw || '', 80);
  if (!normalized) return null;
  const resolved = policy.engine_aliases[normalized] || normalized;
  return normalizeToken(resolved, 80) || null;
}

function importerFor(engine: string) {
  const table: AnyObj = {
    openfang: openfangImporter,
    generic_json: genericJsonImporter,
    generic_yaml: genericYamlImporter,
    workflow_graph: workflowGraphImporter
  };
  return table[engine] || null;
}

function findSourceFile(sourcePath: string, engine: string) {
  if (!fs.existsSync(sourcePath)) return null;
  const st = fs.statSync(sourcePath);
  if (st.isFile()) return sourcePath;
  if (!st.isDirectory()) return null;

  const extensions = engine === 'generic_yaml'
    ? ['.yaml', '.yml']
    : ['.json', '.yaml', '.yml'];

  const files = fs.readdirSync(sourcePath)
    .map((name) => path.join(sourcePath, name))
    .filter((abs) => {
      try { return fs.statSync(abs).isFile(); } catch { return false; }
    })
    .filter((abs) => extensions.some((ext) => abs.toLowerCase().endsWith(ext)))
    .sort((a, b) => a.localeCompare(b));

  return files[0] || null;
}

function parseSource(sourceFile: string, engine: string) {
  const raw = String(fs.readFileSync(sourceFile, 'utf8') || '');
  if (engine === 'generic_yaml') return raw;
  if (sourceFile.toLowerCase().endsWith('.yaml') || sourceFile.toLowerCase().endsWith('.yml')) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runImport(args: AnyObj, policy: AnyObj) {
  const strict = args.strict != null ? toBool(args.strict, false) : policy.strict_default;
  const apply = toBool(args.apply, false);
  const fromRaw = cleanText(args.from || args.engine || '', 120);
  const sourcePathRaw = cleanText(args.path || args.source || '', 400);

  const resolvedEngine = resolveEngine(policy, fromRaw);
  if (!resolvedEngine) {
    return writeReceipt(policy, {
      ok: false,
      type: 'universal_importers_run',
      error: 'from_required',
      strict,
      apply
    });
  }

  const importer = importerFor(resolvedEngine);
  if (!importer) {
    return writeReceipt(policy, {
      ok: false,
      type: 'universal_importers_run',
      error: 'unsupported_engine',
      source_engine: resolvedEngine,
      strict,
      apply
    });
  }

  if (!sourcePathRaw) {
    return writeReceipt(policy, {
      ok: false,
      type: 'universal_importers_run',
      error: 'path_required',
      source_engine: resolvedEngine,
      strict,
      apply
    });
  }

  const sourcePath = path.isAbsolute(sourcePathRaw) ? sourcePathRaw : path.resolve(ROOT, sourcePathRaw);
  const sourceFile = findSourceFile(sourcePath, resolvedEngine);
  if (!sourceFile) {
    return writeReceipt(policy, {
      ok: false,
      type: 'universal_importers_run',
      error: 'source_not_found',
      source_engine: resolvedEngine,
      source_path: sourcePath,
      strict,
      apply
    });
  }

  const parsed = parseSource(sourceFile, resolvedEngine);
  const imported = importer.importPayload(parsed, {
    source_path: sourceFile,
    source_engine: resolvedEngine
  }) || {};
  const entities = imported.entities && typeof imported.entities === 'object'
    ? imported.entities
    : { agents: [], tasks: [], workflows: [], tools: [], records: [] };

  const sourceItemCount = Number(imported.source_item_count || 0);
  const mappedItemCount = Number(imported.mapped_item_count || 0);
  const warnings = Array.isArray(imported.warnings) ? imported.warnings.map((v: unknown) => cleanText(v, 220)).filter(Boolean) : [];
  const lossCount = Math.max(0, sourceItemCount - mappedItemCount);
  const noLoss = lossCount === 0 && sourceItemCount === mappedItemCount;

  const importId = `imp_${Date.now()}_${stableHash(`${resolvedEngine}|${sourceFile}|${sourceItemCount}|${mappedItemCount}`, 10)}`;
  const mappedPayload = {
    schema_id: 'migration_import_bundle',
    schema_version: '1.0',
    import_id: importId,
    ts: nowIso(),
    source_engine: resolvedEngine,
    source_path: sourceFile,
    entities,
    metrics: {
      source_item_count: sourceItemCount,
      mapped_item_count: mappedItemCount,
      loss_count: lossCount,
      no_loss: noLoss,
      warning_count: warnings.length
    },
    warnings
  };

  const reportPath = path.join(policy.paths.reports_root, `${importId}.json`);
  const mappedPath = path.join(policy.paths.mapped_root, `${importId}.json`);
  ensureDir(path.dirname(reportPath));
  writeJsonAtomic(reportPath, mappedPayload);
  if (apply) {
    ensureDir(path.dirname(mappedPath));
    writeJsonAtomic(mappedPath, mappedPayload);
  }

  const out = {
    ok: strict ? noLoss : true,
    type: 'universal_importers_run',
    lane_id: 'V4-MIGR-003',
    strict,
    apply,
    import_id: importId,
    source_engine: resolvedEngine,
    source_path: sourceFile,
    report_path: rel(reportPath),
    mapped_path: apply ? rel(mappedPath) : null,
    metrics: mappedPayload.metrics,
    warnings,
    no_loss_transform: noLoss,
    entities_summary: {
      agents: Array.isArray(entities.agents) ? entities.agents.length : 0,
      tasks: Array.isArray(entities.tasks) ? entities.tasks.length : 0,
      workflows: Array.isArray(entities.workflows) ? entities.workflows.length : 0,
      tools: Array.isArray(entities.tools) ? entities.tools.length : 0,
      records: Array.isArray(entities.records) ? entities.records.length : 0
    }
  };

  return writeReceipt(policy, out);
}

function status(policy: AnyObj) {
  return {
    ok: true,
    type: 'universal_importers_status',
    lane_id: 'V4-MIGR-003',
    enabled: policy.enabled,
    latest: readJson(policy.paths.latest_path, null),
    latest_path: rel(policy.paths.latest_path),
    receipts_path: rel(policy.paths.receipts_path),
    reports_root: rel(policy.paths.reports_root),
    mapped_root: rel(policy.paths.mapped_root)
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
  if (!policy.enabled) emit({ ok: false, error: 'universal_importers_disabled' }, 1);

  if (cmd === 'run') {
    const out = runImport(args, policy);
    emit(out, out.ok ? 0 : 1);
  }
  if (cmd === 'status') emit(status(policy));

  usage();
  process.exit(1);
}

main();
