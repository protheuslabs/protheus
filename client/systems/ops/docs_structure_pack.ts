#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-DOC-001..008 implementation pack.
 * Builds canonical docs taxonomy, ADR registry, service/interface registries, and governance matrices.
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
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.DOCS_STRUCTURE_PACK_POLICY_PATH
  ? path.resolve(process.env.DOCS_STRUCTURE_PACK_POLICY_PATH)
  : path.join(ROOT, 'config', 'docs_structure_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/docs_structure_pack.js run-all [--apply=0|1]');
  console.log('  node systems/ops/docs_structure_pack.js validate [--strict=0|1]');
  console.log('  node systems/ops/docs_structure_pack.js status');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeTextAtomic(filePath, text) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, String(text), 'utf8');
  fs.renameSync(tmp, filePath);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    required_sections: ['architecture', 'runtime', 'governance', 'ops', 'security', 'compliance', 'runbooks'],
    paths: {
      docs_hub_path: 'docs/README.md',
      adr_root: 'docs/adr',
      service_catalog_path: 'config/service_catalog.json',
      interface_registry_path: 'config/interface_contract_registry.json',
      control_evidence_matrix_path: 'state/ops/docs_structure/control_evidence_matrix.json',
      release_templates_root: 'docs/release/templates',
      data_governance_matrix_path: 'docs/data_governance_matrix.md',
      environment_matrix_path: 'docs/environment_matrix.md',
      latest_path: 'state/ops/docs_structure/latest.json',
      receipts_path: 'state/ops/docs_structure/receipts.jsonl',
      compliance_controls_map_path: 'config/compliance_controls_map.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    required_sections: (Array.isArray(raw.required_sections) ? raw.required_sections : base.required_sections)
      .map((v) => normalizeToken(v, 40))
      .filter(Boolean),
    paths: {
      docs_hub_path: resolvePath(paths.docs_hub_path, base.paths.docs_hub_path),
      adr_root: resolvePath(paths.adr_root, base.paths.adr_root),
      service_catalog_path: resolvePath(paths.service_catalog_path, base.paths.service_catalog_path),
      interface_registry_path: resolvePath(paths.interface_registry_path, base.paths.interface_registry_path),
      control_evidence_matrix_path: resolvePath(paths.control_evidence_matrix_path, base.paths.control_evidence_matrix_path),
      release_templates_root: resolvePath(paths.release_templates_root, base.paths.release_templates_root),
      data_governance_matrix_path: resolvePath(paths.data_governance_matrix_path, base.paths.data_governance_matrix_path),
      environment_matrix_path: resolvePath(paths.environment_matrix_path, base.paths.environment_matrix_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      compliance_controls_map_path: resolvePath(paths.compliance_controls_map_path, base.paths.compliance_controls_map_path)
    }
  };
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

function generateDocsHub(policy, apply) {
  const sections = [
    ['architecture', 'Architecture overview, organ map, dependency graph'],
    ['runtime', 'Spine lifecycle, execution lanes, scheduler and state kernel'],
    ['governance', 'Constitution, Heroic Echo, policy gates, escalation ladders'],
    ['ops', 'SLOs, deployment guides, incident and recovery playbooks'],
    ['security', 'Identity/soul-token, attestation, leases, containment controls'],
    ['compliance', 'Control matrix, evidence exports, retention and audit packs'],
    ['runbooks', 'Operator runbooks and emergency-response checklists']
  ];
  const md = [
    '# Protheus Documentation Hub',
    '',
    `Generated: ${nowIso()}`,
    '',
    '## Index',
    ...sections.map(([id, desc]) => `- **${id}**: ${desc}`),
    '',
    '## Ownership',
    '- Platform: runtime, architecture, interfaces',
    '- Security: attestation, containment, key lifecycle',
    '- Ops: SLOs, incident playbooks, release evidence',
    '- Governance: constitution, policy contracts, approvals',
    ''
  ].join('\n');
  if (apply) writeTextAtomic(policy.paths.docs_hub_path, `${md}\n`);
  return {
    section_count: sections.length,
    docs_hub_path: policy.paths.docs_hub_path
  };
}

function generateAdrRegistry(policy, apply) {
  const adrRoot = policy.paths.adr_root;
  const readmePath = path.join(adrRoot, 'README.md');
  const templatePath = path.join(adrRoot, 'TEMPLATE.md');
  const indexPath = path.join(adrRoot, 'INDEX.md');

  const readme = [
    '# ADR Registry',
    '',
    'Status lifecycle: `proposed`, `accepted`, `superseded`, `rejected`.',
    '',
    'Numbering: `NNNN-title.md` (e.g., `0001-state-kernel.md`).',
    ''
  ].join('\n');

  const template = [
    '# ADR NNNN: <title>',
    '',
    '- Status: proposed',
    '- Date: YYYY-MM-DD',
    '- Owners: <owner>',
    '- Supersedes: <optional>',
    '',
    '## Context',
    '<problem and constraints>',
    '',
    '## Decision',
    '<decision summary>',
    '',
    '## Consequences',
    '<tradeoffs, migration, rollback>',
    ''
  ].join('\n');

  const index = [
    '# ADR Index',
    '',
    '| ADR | Status | Title | Links |',
    '|---|---|---|---|',
    '| 0001 | accepted | State Kernel Control Plane | /docs/STATE_KERNEL.md |',
    ''
  ].join('\n');

  if (apply) {
    writeTextAtomic(readmePath, `${readme}\n`);
    writeTextAtomic(templatePath, `${template}\n`);
    writeTextAtomic(indexPath, `${index}\n`);
  }

  return {
    adr_root: adrRoot,
    files: [readmePath, templatePath, indexPath]
  };
}

function generateServiceCatalog(policy, apply) {
  const catalog = {
    schema_id: 'service_catalog',
    schema_version: '1.0',
    updated_at: nowIso(),
    services: [
      {
        id: 'spine',
        owner: 'platform',
        slo_class: 'critical',
        criticality_tier: 1,
        dependencies: ['state_kernel', 'policy_vm', 'workflow_executor'],
        escalation: 'ops-primary'
      },
      {
        id: 'state_kernel',
        owner: 'platform',
        slo_class: 'critical',
        criticality_tier: 1,
        dependencies: ['sqlite', 'receipt_ledger'],
        escalation: 'platform-primary'
      },
      {
        id: 'weaver',
        owner: 'autonomy',
        slo_class: 'high',
        criticality_tier: 2,
        dependencies: ['duality_seed', 'model_router', 'value_attribution'],
        escalation: 'autonomy-primary'
      }
    ]
  };
  if (apply) writeJsonAtomic(policy.paths.service_catalog_path, catalog);
  return {
    service_catalog_path: policy.paths.service_catalog_path,
    service_count: catalog.services.length
  };
}

function generateInterfaceRegistry(policy, apply) {
  const registry = {
    schema_id: 'interface_contract_registry',
    schema_version: '1.0',
    updated_at: nowIso(),
    interfaces: [
      {
        id: 'openai_facade_chat_completions',
        kind: 'api',
        version_policy: 'n-2',
        migration_owner: 'platform',
        compatibility_window_days: 180,
        source: 'systems/ops/openfang_capability_pack.ts'
      },
      {
        id: 'state_kernel_event_log',
        kind: 'event_schema',
        version_policy: 'append_only',
        migration_owner: 'data_plane',
        compatibility_window_days: 365,
        source: 'systems/ops/event_sourced_control_plane.ts'
      },
      {
        id: 'workflow_executor_cli',
        kind: 'cli',
        version_policy: 'minor_stable',
        migration_owner: 'runtime',
        compatibility_window_days: 120,
        source: 'systems/workflow/workflow_executor.ts'
      }
    ]
  };
  if (apply) writeJsonAtomic(policy.paths.interface_registry_path, registry);
  return {
    interface_registry_path: policy.paths.interface_registry_path,
    interface_count: registry.interfaces.length
  };
}

function generateControlEvidenceMatrix(policy, apply) {
  const controls = readJson(policy.paths.compliance_controls_map_path, {});
  const map = controls.controls && typeof controls.controls === 'object' ? controls.controls : controls;
  const rows = Object.entries(map || {}).map(([controlId, value]) => {
    const row = value && typeof value === 'object' ? value : {};
    return {
      control_id: controlId,
      owner: cleanText(row.owner || 'unassigned', 80),
      cadence: cleanText(row.cadence || row.frequency || 'daily', 40),
      checks: Array.isArray(row.checks) ? row.checks : [],
      evidence_paths: Array.isArray(row.evidence_paths) ? row.evidence_paths : []
    };
  });
  const matrix = {
    schema_id: 'control_evidence_matrix',
    schema_version: '1.0',
    generated_at: nowIso(),
    row_count: rows.length,
    rows
  };
  if (apply) writeJsonAtomic(policy.paths.control_evidence_matrix_path, matrix);
  return {
    control_evidence_matrix_path: policy.paths.control_evidence_matrix_path,
    row_count: rows.length
  };
}

function generateReleaseTemplates(policy, apply) {
  const root = policy.paths.release_templates_root;
  const files = {
    'release_plan.md': '# Release Plan\n\n- Scope\n- Risk\n- Rollback\n',
    'rollback_plan.md': '# Rollback Plan\n\n- Trigger conditions\n- Steps\n- Verification\n',
    'risk_assessment.md': '# Risk Assessment\n\n- Threats\n- Mitigations\n- Residual risk\n',
    'post_release_verification.md': '# Post Release Verification\n\n- SLO checks\n- Contract checks\n- Alerts\n',
    'deprecation_notice.md': '# Deprecation Notice\n\n- Surface\n- Timeline\n- Migration path\n',
    'postmortem_handoff.md': '# Postmortem Handoff\n\n- Incident summary\n- Follow-ups\n- Owners\n'
  };
  if (apply) {
    for (const [name, body] of Object.entries(files)) {
      writeTextAtomic(path.join(root, name), `${body}\n`);
    }
  }
  return {
    release_templates_root: root,
    template_count: Object.keys(files).length
  };
}

function generateDataGovernanceMatrix(policy, apply) {
  const md = [
    '# Data Governance Matrix',
    '',
    '| Class | Retention | Access Scope | Legal Hold | Deletion SLA | Owner |',
    '|---|---|---|---|---|---|',
    '| public_receipts | 365d | operators | no | 30d | ops |',
    '| sensitive_runtime | 90d | security | yes | 7d | security |',
    '| training_candidates | 180d | autonomy + legal-approved | yes | 14d | data_plane |',
    '| secrets | rotated (no long-term storage) | secret_broker_only | yes | immediate revoke | security |',
    ''
  ].join('\n');
  if (apply) writeTextAtomic(policy.paths.data_governance_matrix_path, `${md}\n`);
  return {
    data_governance_matrix_path: policy.paths.data_governance_matrix_path
  };
}

function generateEnvironmentMatrix(policy, apply) {
  const md = [
    '# Environment Matrix',
    '',
    '| Env | Owners | Allowed Mutations | Approval Requirements | Deploy Gates |',
    '|---|---|---|---|---|',
    '| dev | platform | any shadow-safe | single maintainer | contract_check + unit tests |',
    '| stage | platform + ops | bounded canary/live | dual approval for high-risk | foundation_contract_gate + reliability checks |',
    '| prod | ops + governance | policy-approved only | explicit high-risk approval + soul-token gate | all required checks + no freeze gate violations |',
    ''
  ].join('\n');
  if (apply) writeTextAtomic(policy.paths.environment_matrix_path, `${md}\n`);
  return {
    environment_matrix_path: policy.paths.environment_matrix_path
  };
}

function runAll(args, policy) {
  const apply = toBool(args.apply, false);
  const artifacts = {
    docs_hub: generateDocsHub(policy, apply),
    adr_registry: generateAdrRegistry(policy, apply),
    service_catalog: generateServiceCatalog(policy, apply),
    interface_registry: generateInterfaceRegistry(policy, apply),
    control_evidence_matrix: generateControlEvidenceMatrix(policy, apply),
    release_templates: generateReleaseTemplates(policy, apply),
    data_governance: generateDataGovernanceMatrix(policy, apply),
    environment_matrix: generateEnvironmentMatrix(policy, apply)
  };
  return receipt(policy, {
    type: 'docs_structure_run_all',
    apply,
    artifacts
  });
}

function validate(args, policy) {
  const strict = toBool(args.strict, false);
  const requiredPaths = [
    policy.paths.docs_hub_path,
    path.join(policy.paths.adr_root, 'README.md'),
    path.join(policy.paths.adr_root, 'TEMPLATE.md'),
    path.join(policy.paths.adr_root, 'INDEX.md'),
    policy.paths.service_catalog_path,
    policy.paths.interface_registry_path,
    policy.paths.control_evidence_matrix_path,
    path.join(policy.paths.release_templates_root, 'release_plan.md'),
    policy.paths.data_governance_matrix_path,
    policy.paths.environment_matrix_path
  ];
  const missing = requiredPaths.filter((p) => !fs.existsSync(p));
  const checks = {
    required_paths_present: missing.length === 0,
    required_section_count: policy.required_sections.length >= 6
  };
  const pass = checks.required_paths_present && checks.required_section_count;
  const out = receipt(policy, {
    type: 'docs_structure_validate',
    strict,
    checks,
    missing_paths: missing,
    pass
  });
  if (strict && !pass) return { ...out, exit_code: 1 };
  return { ...out, exit_code: 0 };
}

function status(policy) {
  return {
    ok: true,
    type: 'docs_structure_status',
    shadow_only: policy.shadow_only,
    latest: readJson(policy.paths.latest_path, {})
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
  if (!policy.enabled) emit({ ok: false, error: 'docs_structure_pack_disabled' }, 1);

  if (cmd === 'run-all') emit(runAll(args, policy));
  if (cmd === 'validate') {
    const out = validate(args, policy);
    emit(out, out.exit_code || 0);
  }
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: 'unknown_command', cmd }, 2);
}

if (require.main === module) {
  main();
}
