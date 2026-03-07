#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const autonomyPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadAutonomy(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[autonomyPath];
  delete require.cache[bridgePath];
  return require(autonomyPath);
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const typeSamples = [
    { type: 'directive_clarification' },
    { type: 'directive_decomposition' },
    { type: 'other' },
    {}
  ];
  for (const sample of typeSamples) {
    assert.strictEqual(
      rust.isDirectiveClarificationProposal(sample),
      ts.isDirectiveClarificationProposal(sample),
      `isDirectiveClarificationProposal mismatch for ${JSON.stringify(sample)}`
    );
    assert.strictEqual(
      rust.isDirectiveDecompositionProposal(sample),
      ts.isDirectiveDecompositionProposal(sample),
      `isDirectiveDecompositionProposal mismatch for ${JSON.stringify(sample)}`
    );
  }

  const objectiveSamples = ['T1_ALPHA', 'T9_X1', 't1_alpha', 'bad-id', '', null];
  for (const sample of objectiveSamples) {
    assert.strictEqual(
      rust.sanitizeDirectiveObjectiveId(sample),
      ts.sanitizeDirectiveObjectiveId(sample),
      `sanitizeDirectiveObjectiveId mismatch for ${String(sample)}`
    );
  }

  const fileCmdSamples = [
    'node tool --file=client/config/directives/T1_ALPHA.yaml',
    "node tool --file='client/config/directives/T2_BETA.yml'",
    'node tool --file=../../etc/passwd',
    ''
  ];
  for (const sample of fileCmdSamples) {
    assert.strictEqual(
      rust.parseDirectiveFileArgFromCommand(sample),
      ts.parseDirectiveFileArgFromCommand(sample),
      `parseDirectiveFileArgFromCommand mismatch for ${String(sample)}`
    );
  }

  const objectiveCmdSamples = [
    'run --id=T1_ALPHA',
    "run --id='T3_GAMMA'",
    'run --id=bad',
    ''
  ];
  for (const sample of objectiveCmdSamples) {
    assert.strictEqual(
      rust.parseDirectiveObjectiveArgFromCommand(sample),
      ts.parseDirectiveObjectiveArgFromCommand(sample),
      `parseDirectiveObjectiveArgFromCommand mismatch for ${String(sample)}`
    );
  }

  const objectiveSet = new Set(['T1_ALPHA', 'T2_BETA', 'T3_GAMMA']);
  const evidenceProposal = {
    evidence: [
      { evidence_ref: 'note directive_pulse/T2_BETA context' },
      { evidence_ref: 'directive:T1_ALPHA' }
    ]
  };
  assert.deepStrictEqual(
    rust.parseObjectiveIdFromEvidenceRefs(evidenceProposal, objectiveSet),
    ts.parseObjectiveIdFromEvidenceRefs(evidenceProposal, objectiveSet),
    'parseObjectiveIdFromEvidenceRefs mismatch'
  );

  const commandProposal = {
    suggested_next_command: 'node client/systems/directive --id=T3_GAMMA'
  };
  assert.deepStrictEqual(
    rust.parseObjectiveIdFromCommand(commandProposal, objectiveSet),
    ts.parseObjectiveIdFromCommand(commandProposal, objectiveSet),
    'parseObjectiveIdFromCommand mismatch'
  );

  const objectiveForExec = rust.objectiveIdForExecution(
    { meta: { objective_id: '' }, action_spec: { objective_id: 'T2_BETA' } },
    { objective_id: '' },
    { objective_id: '' },
    { objective_id: 'T1_ALPHA' }
  );
  const objectiveForExecTs = ts.objectiveIdForExecution(
    { meta: { objective_id: '' }, action_spec: { objective_id: 'T2_BETA' } },
    { objective_id: '' },
    { objective_id: '' },
    { objective_id: 'T1_ALPHA' }
  );
  assert.strictEqual(objectiveForExec, objectiveForExecTs, 'objectiveIdForExecution mismatch');

  const shortTextSamples = [
    ['abcdef', 3],
    ['tiny', 10],
    ['', 4]
  ];
  for (const sample of shortTextSamples) {
    assert.strictEqual(
      rust.shortText(sample[0], sample[1]),
      ts.shortText(sample[0], sample[1]),
      `shortText mismatch for ${JSON.stringify(sample)}`
    );
  }

  const statusSamples = [
    ['pass', 'unknown'],
    ['warn', 'unknown'],
    ['FAIL', 'unknown'],
    ['noise', 'fallback']
  ];
  for (const sample of statusSamples) {
    assert.strictEqual(
      rust.normalizedSignalStatus(sample[0], sample[1]),
      ts.normalizedSignalStatus(sample[0], sample[1]),
      `normalizedSignalStatus mismatch for ${JSON.stringify(sample)}`
    );
  }

  console.log('autonomy_directive_parser_helpers_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_directive_parser_helpers_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

