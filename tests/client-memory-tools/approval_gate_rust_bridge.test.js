#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-gate-'));
const queuePath = path.join(queueDir, 'approvals_queue.yaml');

process.env.APPROVAL_GATE_QUEUE_PATH = queuePath;
process.env.PROTHEUS_OPS_USE_PREBUILT = '0';

const approvalGate = require(path.join(ROOT, 'client', 'runtime', 'lib', 'approval_gate.ts'));

const emptyQueue = approvalGate.loadQueue();
assert.deepStrictEqual(emptyQueue, { pending: [], approved: [], denied: [], history: [] });

const queued = approvalGate.queueForApproval(
  {
    action_id: 'act_publish_demo',
    directive_id: 'T0_invariants',
    type: 'publish_publicly',
    summary: 'Ship public demo',
  },
  'publishing_requires_explicit_approval'
);
assert.strictEqual(queued.success, true);
assert.strictEqual(queued.action_id, 'act_publish_demo');
assert(fs.existsSync(queuePath), 'expected queue file');

let queue = approvalGate.loadQueue();
assert.strictEqual(queue.pending.length, 1);
assert.strictEqual(queue.pending[0].action_id, 'act_publish_demo');
assert.strictEqual(approvalGate.wasApproved('act_publish_demo'), false);

const approved = approvalGate.approveAction('act_publish_demo');
assert.strictEqual(approved.success, true);
assert.strictEqual(approvalGate.wasApproved('act_publish_demo'), true);

queue = approvalGate.loadQueue();
assert.strictEqual(queue.pending.length, 0);
assert.strictEqual(queue.approved.length, 1);
assert.strictEqual(queue.history.length, 1);

approvalGate.saveQueue({
  pending: [],
  approved: [],
  denied: [
    {
      action_id: 'act_deny',
      status: 'DENIED',
      summary: 'Reject destructive op',
      deny_reason: 'manual review',
    },
  ],
  history: [],
});

queue = approvalGate.loadQueue();
assert.strictEqual(queue.denied.length, 1);
assert.strictEqual(queue.denied[0].action_id, 'act_deny');

const parsedYaml = approvalGate.parseQueueYaml(`
pending:
  - action_id: act_yaml
    status: PENDING
approved: []
denied: []
history: []
`);
assert.strictEqual(parsedYaml.pending.length, 1);
assert.strictEqual(parsedYaml.pending[0].action_id, 'act_yaml');

const parsedCommand = approvalGate.parseApprovalCommand('APPROVE act_yaml');
assert(parsedCommand, 'expected parsed approval command');
assert.strictEqual(parsedCommand.action, 'approve');
assert.strictEqual(parsedCommand.action_id, 'act_yaml');

console.log('approval_gate_rust_bridge.test.js: OK');
