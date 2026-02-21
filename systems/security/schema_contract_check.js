#!/usr/bin/env node
'use strict';

/**
 * schema_contract_check.js
 *
 * Validates versioned schema contracts and checks representative runtime objects
 * against required contract paths.
 *
 * Usage:
 *   node systems/security/schema_contract_check.js run
 *   node systems/security/schema_contract_check.js --help
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeAutonomyReceiptForWrite
} = require('../../lib/autonomy_receipt_schema.js');
const { enrichOne } = require('../autonomy/proposal_enricher.js');
const { defaultCatalog } = require('../adaptive/sensory/eyes/catalog_store.js');
const { defaultFocusState } = require('../adaptive/sensory/eyes/focus_trigger_store.js');
const { defaultHabitState } = require('../adaptive/habits/habit_store.js');
const { defaultReflexState } = require('../adaptive/reflex/reflex_store.js');
const { defaultStrategyState } = require('../adaptive/strategy/strategy_store.js');
const {
  loadSystemBudgetState,
  recordSystemBudgetUsage,
  writeSystemBudgetDecision
} = require('../budget/system_budget.js');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTRACTS_DIR = path.join(ROOT, 'config', 'contracts');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/schema_contract_check.js run');
  console.log('  node systems/security/schema_contract_check.js --help');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function hasPath(obj, dottedPath) {
  const parts = String(dottedPath || '').split('.').filter(Boolean);
  if (!parts.length) return false;
  let cur = obj;
  for (const part of parts) {
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return false;
      cur = cur[idx];
      continue;
    }
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return false;
    cur = cur[part];
  }
  return true;
}

function validateContractFile(filePath) {
  const doc = readJson(filePath);
  const failures = [];
  const id = String(doc && doc.schema_id || '').trim();
  const version = String(doc && doc.schema_version || '').trim();
  if (!id) failures.push('schema_id_missing');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) failures.push('schema_version_invalid');
  return { ok: failures.length === 0, doc, failures };
}

function sampleAutonomyReceipt() {
  return normalizeAutonomyReceiptForWrite({
    type: 'autonomy_action_receipt',
    verdict: 'pass',
    intent: {
      objective_id: 'T1_make_jay_billionaire_v1',
      success_criteria_policy: { required: true, min_count: 1 }
    },
    verification: {
      checks: [{ name: 'route_execute_ok', pass: true }],
      failed: [],
      passed: true
    },
    receipt_contract: {
      attempted: true,
      verified: true
    }
  });
}

function sampleEnrichedProposal() {
  const ctx = {
    eyes: new Map([
      ['hn_frontpage', { id: 'hn_frontpage', parser_type: 'hn_rss' }]
    ]),
    thresholds: {
      min_signal_quality: 58,
      min_sensory_signal_score: 45,
      min_sensory_relevance_score: 42,
      min_directive_fit: 40,
      min_actionability_score: 45,
      min_composite_eligibility: 62
    },
    directiveProfile: {
      available: true,
      strategy_id: 'default_general',
      strategy_tokens: ['revenue', 'automation'],
      active_directive_ids: ['T1_make_jay_billionaire_v1'],
      positive_phrases: ['increase revenue'],
      negative_phrases: [],
      positive_tokens: ['revenue', 'automation'],
      negative_tokens: []
    },
    directiveObjectiveIds: ['T1_make_jay_billionaire_v1'],
    strategy: {
      id: 'default_general',
      name: 'default_general',
      status: 'active',
      admission_policy: { max_remediation_depth: 2 }
    },
    outcomePolicy: {
      proposal_filter_policy: {
        require_success_criteria: true,
        min_success_criteria_count: 1,
        success_criteria_exempt_types: []
      }
    }
  };
  const proposal = {
    id: 'P-schema-contract',
    title: 'Stabilize collector reliability with measurable success criteria',
    type: 'collector_remediation',
    risk: 'low',
    suggested_next_command: 'node systems/routing/route_execute.js --id=T1_make_jay_billionaire_v1 --task="repair collector fetch"',
    validation: ['error rate < 5% in 24h'],
    evidence: [
      { evidence_ref: 'directive_pulse/T1_make_jay_billionaire_v1' },
      { evidence_ref: 'eye:hn_frontpage' }
    ],
    meta: { source_eye: 'hn_frontpage' }
  };
  return enrichOne(proposal, ctx).proposal;
}

function validateRequiredPaths(schemaId, requiredPaths, sample) {
  const failures = [];
  for (const p of requiredPaths) {
    if (!hasPath(sample, p)) failures.push(`${schemaId}:missing_path:${p}`);
  }
  return failures;
}

function validateAutonomyReceiptContract() {
  const fp = path.join(CONTRACTS_DIR, 'autonomy_receipt.schema.json');
  const raw = validateContractFile(fp);
  if (!raw.ok) return { name: 'autonomy_receipt', ok: false, failures: raw.failures };
  const required = Array.isArray(raw.doc.required_paths) ? raw.doc.required_paths : [];
  const failures = [];
  if (!required.length) failures.push('autonomy_receipt:required_paths_missing');
  failures.push(...validateRequiredPaths('autonomy_receipt', required, sampleAutonomyReceipt()));
  return { name: 'autonomy_receipt', ok: failures.length === 0, failures };
}

function validateProposalAdmissionContract() {
  const fp = path.join(CONTRACTS_DIR, 'proposal_admission.schema.json');
  const raw = validateContractFile(fp);
  if (!raw.ok) return { name: 'proposal_admission', ok: false, failures: raw.failures };
  const required = Array.isArray(raw.doc.required_paths) ? raw.doc.required_paths : [];
  const failures = [];
  if (!required.length) failures.push('proposal_admission:required_paths_missing');
  failures.push(...validateRequiredPaths('proposal_admission', required, sampleEnrichedProposal()));
  return { name: 'proposal_admission', ok: failures.length === 0, failures };
}

function validateAdaptiveStoreContract() {
  const fp = path.join(CONTRACTS_DIR, 'adaptive_store.schema.json');
  const raw = validateContractFile(fp);
  if (!raw.ok) return { name: 'adaptive_store', ok: false, failures: raw.failures };
  const stores = raw.doc && isObject(raw.doc.stores) ? raw.doc.stores : {};
  const fixtures = {
    eyes_catalog: defaultCatalog(),
    focus_state: defaultFocusState(),
    habit_state: defaultHabitState(),
    reflex_state: defaultReflexState(),
    strategy_state: defaultStrategyState()
  };
  const failures = [];
  for (const [storeName, fixture] of Object.entries(fixtures)) {
    const storeSpec = isObject(stores[storeName]) ? stores[storeName] : null;
    if (!storeSpec) {
      failures.push(`adaptive_store:missing_store_contract:${storeName}`);
      continue;
    }
    const required = Array.isArray(storeSpec.required_paths) ? storeSpec.required_paths : [];
    if (!required.length) failures.push(`adaptive_store:required_paths_missing:${storeName}`);
    failures.push(...validateRequiredPaths(`adaptive_store:${storeName}`, required, fixture));
  }
  return { name: 'adaptive_store', ok: failures.length === 0, failures };
}

function sampleSystemBudgetArtifacts() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-budget-'));
  try {
    const stateDir = path.join(tempRoot, 'state');
    const eventsPath = path.join(tempRoot, 'events.jsonl');
    const day = '2026-02-21';
    const opts = {
      state_dir: stateDir,
      events_path: eventsPath,
      allow_strategy: false,
      daily_token_cap: 1000
    };
    loadSystemBudgetState(day, opts);
    recordSystemBudgetUsage({
      date: day,
      tokens_est: 120,
      module: 'schema_checker',
      capability: 'budget_record'
    }, opts);
    writeSystemBudgetDecision({
      date: day,
      module: 'schema_checker',
      capability: 'budget_decision',
      request_tokens_est: 250,
      decision: 'allow',
      reason: 'schema_contract_sample'
    }, opts);

    const statePath = path.join(stateDir, `${day}.json`);
    const state = readJson(statePath);
    const rows = fs.existsSync(eventsPath)
      ? fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const record = rows.find((row) => String(row.type || '') === 'system_budget_record') || {};
    const decision = rows.find((row) => String(row.type || '') === 'system_budget_decision') || {};
    return { state, record, decision };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function validateSystemBudgetContract() {
  const fp = path.join(CONTRACTS_DIR, 'system_budget.schema.json');
  const raw = validateContractFile(fp);
  if (!raw.ok) return { name: 'system_budget', ok: false, failures: raw.failures };
  const spec = raw.doc && isObject(raw.doc) ? raw.doc : {};
  const stateRequired = spec.state && Array.isArray(spec.state.required_paths) ? spec.state.required_paths : [];
  const eventSpecs = spec.events && isObject(spec.events) ? spec.events : {};
  const artifacts = sampleSystemBudgetArtifacts();
  const failures = [];
  if (!stateRequired.length) failures.push('system_budget:required_paths_missing:state');
  failures.push(...validateRequiredPaths('system_budget:state', stateRequired, artifacts.state));
  for (const [eventType, eventSpec] of Object.entries(eventSpecs)) {
    const required = eventSpec && Array.isArray(eventSpec.required_paths) ? eventSpec.required_paths : [];
    if (!required.length) {
      failures.push(`system_budget:required_paths_missing:${eventType}`);
      continue;
    }
    const sample = eventType === 'system_budget_record'
      ? artifacts.record
      : eventType === 'system_budget_decision'
        ? artifacts.decision
        : {};
    failures.push(...validateRequiredPaths(`system_budget:${eventType}`, required, sample));
  }
  return { name: 'system_budget', ok: failures.length === 0, failures };
}

function runCheck() {
  const checks = [
    validateAutonomyReceiptContract(),
    validateProposalAdmissionContract(),
    validateAdaptiveStoreContract(),
    validateSystemBudgetContract()
  ];
  const failures = checks.flatMap((c) => c.failures || []);
  return {
    ok: failures.length === 0,
    ts: new Date().toISOString(),
    contracts_dir: CONTRACTS_DIR,
    checks: checks.map((c) => ({
      name: c.name,
      ok: c.ok,
      failure_count: Array.isArray(c.failures) ? c.failures.length : 0
    })),
    failure_count: failures.length,
    failures
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '');
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }
  const out = runCheck();
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  runCheck,
  hasPath,
  sampleAutonomyReceipt,
  sampleEnrichedProposal,
  sampleSystemBudgetArtifacts
};
