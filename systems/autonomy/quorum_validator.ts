#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * quorum_validator.js
 *
 * Deterministic second-pass validator for high-tier self-modification proposals.
 *
 * Usage:
 *   node systems/autonomy/quorum_validator.js check --proposal-file=/abs/path.json [--id=<proposal_id>]
 *   node systems/autonomy/quorum_validator.js --help
 */

const fs = require('fs');
const path = require('path');
const { evaluateProposalQuorum } = require('../../lib/quorum_validator.js');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/quorum_validator.js check --proposal-file=/abs/path.json [--id=<proposal_id>]');
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

function loadProposal(filePath, id) {
  const abs = path.resolve(String(filePath || '').trim());
  if (!abs || !fs.existsSync(abs)) throw new Error(`proposal file not found: ${abs}`);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (Array.isArray(raw)) {
    if (!id) return raw[0] || null;
    return raw.find((p) => String(p && p.id || '') === String(id)) || null;
  }
  if (raw && Array.isArray(raw.proposals)) {
    if (!id) return raw.proposals[0] || null;
    return raw.proposals.find((p) => String(p && p.id || '') === String(id)) || null;
  }
  return raw;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }
  if (cmd !== 'check') {
    usage();
    process.exitCode = 2;
    return;
  }

  const proposalFile = String(args['proposal-file'] || args.proposal_file || '').trim();
  const id = String(args.id || '').trim();
  if (!proposalFile) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing_proposal_file' }) + '\n');
    process.exit(2);
    return;
  }

  const proposal = loadProposal(proposalFile, id);
  if (!proposal || typeof proposal !== 'object') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'proposal_not_found' }) + '\n');
    process.exit(1);
    return;
  }

  const verdict = evaluateProposalQuorum(proposal);
  process.stdout.write(JSON.stringify({
    ok: verdict.ok === true,
    type: 'quorum_validator',
    proposal_id: proposal.id || null,
    quorum: verdict
  }) + '\n');
  if (verdict.ok !== true) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'quorum_validator_failed') }) + '\n');
    process.exit(1);
  }
}
