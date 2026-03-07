#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function sanitizeDirectiveObjectiveId(raw) {
  const v = String(raw || '').trim();
  if (!/^T[0-9]+_[A-Za-z0-9_]+$/.test(v)) return '';
  return v;
}

function parseDirectiveFileArgFromCommand(cmd) {
  const text = String(cmd || '').trim();
  if (!text) return '';
  const m = text.match(/(?:^|\s)--file=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const raw = String((m && (m[1] || m[2] || m[3])) || '').trim();
  if (!raw) return '';
  if (!/^config\/directives\/[A-Za-z0-9_]+\.ya?ml$/i.test(raw)) return '';
  return raw.replace(/\\/g, '/');
}

function parseDirectiveObjectiveArgFromCommand(cmd) {
  const text = String(cmd || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const m = text.match(/(?:^|\s)--id=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const raw = String((m && (m[1] || m[2] || m[3])) || '').trim();
  return sanitizeDirectiveObjectiveId(raw);
}

function jsDirectiveClarificationExecSpec(input) {
  const proposalType = String(input.proposal_type || '').trim().toLowerCase();
  if (proposalType !== 'directive_clarification') {
    return {
      applicable: false,
      ok: false,
      reason: null,
      decision: null,
      objective_id: null,
      file: null,
      source: null,
      args: []
    };
  }
  const objectiveId = sanitizeDirectiveObjectiveId(input.meta_directive_objective_id || '');
  let relFile = objectiveId ? `client/config/directives/${objectiveId}.yaml` : '';
  let source = objectiveId ? 'meta.directive_objective_id' : '';
  if (!relFile) {
    relFile = parseDirectiveFileArgFromCommand(input.suggested_next_command);
    if (relFile) source = 'suggested_next_command';
  }
  if (!relFile) {
    return {
      applicable: true,
      ok: false,
      reason: 'directive_clarification_missing_file',
      decision: null,
      objective_id: null,
      file: null,
      source: null,
      args: []
    };
  }
  const fileObjectiveId = path.basename(relFile).replace(/\.ya?ml$/i, '');
  return {
    applicable: true,
    ok: true,
    reason: null,
    decision: 'DIRECTIVE_VALIDATE',
    objective_id: objectiveId || fileObjectiveId,
    file: relFile,
    source: source || null,
    args: ['validate', `--file=${relFile}`]
  };
}

function jsDirectiveDecompositionExecSpec(input) {
  const proposalType = String(input.proposal_type || '').trim().toLowerCase();
  if (proposalType !== 'directive_decomposition') {
    return {
      applicable: false,
      ok: false,
      reason: null,
      decision: null,
      objective_id: null,
      source: null,
      args: []
    };
  }
  const objectiveId = sanitizeDirectiveObjectiveId(input.meta_directive_objective_id || '');
  const commandId = parseDirectiveObjectiveArgFromCommand(input.suggested_next_command);
  const chosenId = objectiveId || commandId;
  const source = objectiveId ? 'meta.directive_objective_id' : (commandId ? 'suggested_next_command' : '');
  if (!chosenId) {
    return {
      applicable: true,
      ok: false,
      reason: 'directive_decomposition_missing_objective_id',
      decision: null,
      objective_id: null,
      source: null,
      args: []
    };
  }
  return {
    applicable: true,
    ok: true,
    reason: null,
    decision: 'DIRECTIVE_DECOMPOSE',
    objective_id: chosenId,
    source: source || null,
    args: ['decompose', `--id=${chosenId}`]
  };
}

function jsParseActuationSpec(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const actuation = meta.actuation && typeof meta.actuation === 'object' ? meta.actuation : null;
  if (!actuation) return { has_spec: false, kind: null, params: null, context: null };
  const kind = String(actuation.kind || '').trim();
  if (!kind) return { has_spec: false, kind: null, params: null, context: null };
  const params = actuation.params && typeof actuation.params === 'object' ? actuation.params : {};
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  const guardControls = meta.adaptive_mutation_guard_controls && typeof meta.adaptive_mutation_guard_controls === 'object'
    ? { ...meta.adaptive_mutation_guard_controls }
    : {};
  const context = {
    proposal_id: String(p.id || '').trim() || null,
    objective_id: sanitizeDirectiveObjectiveId(
      meta.objective_id || meta.directive_objective_id || actionSpec.objective_id
    ) || null,
    safety_attestation_id: String(
      guardControls.safety_attestation || meta.safety_attestation_id || meta.safety_attestation || meta.attestation_id || ''
    ).trim() || null,
    rollback_receipt_id: String(
      guardControls.rollback_receipt || meta.rollback_receipt_id || meta.rollback_receipt || actionSpec.rollback_receipt_id || ''
    ).trim() || null,
    adaptive_mutation_guard_receipt_id: String(
      guardControls.guard_receipt_id || meta.adaptive_mutation_guard_receipt_id || meta.mutation_guard_receipt_id || ''
    ).trim() || null,
    mutation_guard: {
      applies: meta.adaptive_mutation_guard_applies === true,
      pass: meta.adaptive_mutation_guard_pass !== false,
      reason: String(meta.adaptive_mutation_guard_reason || '').trim() || null,
      reasons: Array.isArray(meta.adaptive_mutation_guard_reasons) ? meta.adaptive_mutation_guard_reasons.slice(0, 8) : [],
      controls: guardControls
    }
  };
  return {
    has_spec: true,
    kind,
    params,
    context
  };
}

function jsTaskFromProposal(input) {
  const proposalId = String(input.proposal_id || 'unknown');
  const proposalType = String(input.proposal_type || 'task').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
  const title = String(input.title || '').replace(/\[Eyes:[^\]]+\]\s*/g, '').slice(0, 140);
  return { task: `Execute bounded proposal ${proposalId} (${proposalType}): ${title}` };
}

function runRust(mode, input) {
  const rust = runBacklogAutoscalePrimitive(mode, input, { allow_cli_fallback: true });
  assert(rust && rust.ok === true, `${mode}: rust bridge invocation failed`);
  assert(rust.payload && rust.payload.ok === true, `${mode}: rust payload failed`);
  return rust.payload.payload;
}

function run() {
  const clarificationSamples = [
    {
      proposal_type: 'directive_clarification',
      meta_directive_objective_id: 'T1_REPAIR',
      suggested_next_command: ''
    },
    {
      proposal_type: 'directive_clarification',
      meta_directive_objective_id: '',
      suggested_next_command: "node client/systems/security/directive_intake.js validate --file=client/config/directives/quant_intel_acquisition.yaml"
    },
    {
      proposal_type: 'route_execute',
      meta_directive_objective_id: '',
      suggested_next_command: ''
    },
    {
      proposal_type: 'directive_clarification',
      meta_directive_objective_id: '',
      suggested_next_command: ''
    }
  ];
  for (const sample of clarificationSamples) {
    assert.deepStrictEqual(
      runRust('directive_clarification_exec_spec', sample),
      jsDirectiveClarificationExecSpec(sample),
      `directive_clarification_exec_spec mismatch for sample=${JSON.stringify(sample)}`
    );
  }

  const decompositionSamples = [
    {
      proposal_type: 'directive_decomposition',
      meta_directive_objective_id: 'T2_PLAN',
      suggested_next_command: ''
    },
    {
      proposal_type: 'directive_decomposition',
      meta_directive_objective_id: '',
      suggested_next_command: "node client/systems/security/directive_intake.js decompose --id=T3_ALPHA"
    },
    {
      proposal_type: 'route_execute',
      meta_directive_objective_id: '',
      suggested_next_command: ''
    },
    {
      proposal_type: 'directive_decomposition',
      meta_directive_objective_id: '',
      suggested_next_command: ''
    }
  ];
  for (const sample of decompositionSamples) {
    assert.deepStrictEqual(
      runRust('directive_decomposition_exec_spec', sample),
      jsDirectiveDecompositionExecSpec(sample),
      `directive_decomposition_exec_spec mismatch for sample=${JSON.stringify(sample)}`
    );
  }

  const actuationProposal = {
    id: 'prop_123',
    meta: {
      objective_id: 'T4_GUARD',
      actuation: {
        kind: 'route_execute',
        params: { target: 'health', retries: 2 }
      },
      adaptive_mutation_guard_controls: {
        safety_attestation: 'att-01',
        rollback_receipt: 'rb-02',
        guard_receipt_id: 'gr-03'
      },
      adaptive_mutation_guard_applies: true,
      adaptive_mutation_guard_pass: true,
      adaptive_mutation_guard_reason: 'all checks passed',
      adaptive_mutation_guard_reasons: ['guard_ok', 'tier1_ok']
    },
    action_spec: {
      objective_id: 'T4_GUARD'
    }
  };
  assert.deepStrictEqual(
    runRust('parse_actuation_spec', { proposal: actuationProposal }),
    jsParseActuationSpec(actuationProposal),
    'parse_actuation_spec mismatch on populated proposal'
  );
  assert.deepStrictEqual(
    runRust('parse_actuation_spec', { proposal: { id: 'p2', meta: {} } }),
    jsParseActuationSpec({ id: 'p2', meta: {} }),
    'parse_actuation_spec mismatch on missing actuation'
  );

  const taskSamples = [
    { proposal_id: 'abc', proposal_type: 'Route_Execute', title: '[Eyes:foo] Tighten gate and run.' },
    { proposal_id: null, proposal_type: null, title: null }
  ];
  for (const sample of taskSamples) {
    assert.deepStrictEqual(
      runRust('task_from_proposal', sample),
      jsTaskFromProposal(sample),
      `task_from_proposal mismatch for sample=${JSON.stringify(sample)}`
    );
  }

  console.log('autonomy_directive_actuation_task_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_directive_actuation_task_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
