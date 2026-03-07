#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function makeProposal(admissionPreview) {
  return {
    id: 'preview-proposal',
    type: 'ops_remediation',
    meta: {
      admission_preview: admissionPreview
    }
  };
}

function run() {
  const samples = [
    {
      label: 'object preview preserved',
      proposal: makeProposal({ allow: true, reason: 'ready' })
    },
    {
      label: 'array preview dropped',
      proposal: makeProposal(['unexpected'])
    },
    {
      label: 'null preview',
      proposal: makeProposal(null)
    }
  ];

  for (const sample of samples) {
    const tsOut = loadController(false).proposalAdmissionPreview(sample.proposal);
    const rustOut = loadController(true).proposalAdmissionPreview(sample.proposal);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `proposalAdmissionPreview parity mismatch (${sample.label})`
    );
  }

  console.log('autonomy_proposal_admission_preview_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_admission_preview_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
