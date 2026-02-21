#!/usr/bin/env node
'use strict';

const { run } = require('./moltbook_publish_guard');

function toArgv(params, dryRun) {
  const p = params && typeof params === 'object' ? params : {};
  const argv = [];

  if (typeof p.title === 'string' && p.title.trim()) argv.push(`--title=${p.title}`);
  if (typeof p.body === 'string' && p.body.trim()) argv.push(`--body=${p.body}`);
  if (typeof p.title_file === 'string' && p.title_file.trim()) argv.push(`--title-file=${p.title_file}`);
  if (typeof p.body_file === 'string' && p.body_file.trim()) argv.push(`--body-file=${p.body_file}`);
  if (typeof p.submolt === 'string' && p.submolt.trim()) argv.push(`--submolt=${p.submolt}`);
  if (dryRun) argv.push('--dry-run');

  return argv;
}

async function execute({ params, dryRun }) {
  const argv = toArgv(params, dryRun === true);
  const result = await run(argv);
  const out = result && result.out ? result.out : {};
  return {
    ok: result && result.exitCode === 0,
    code: result && Number.isFinite(result.exitCode) ? result.exitCode : 1,
    summary: {
      decision: 'ACTUATE',
      gate_decision: 'ALLOW',
      executable: result && result.exitCode === 0,
      adapter: 'moltbook_publish',
      verified: !!(out && out.result === 'success'),
      action: 'create_post'
    },
    details: out
  };
}

module.exports = {
  id: 'moltbook_publish',
  description: 'Guarded Moltbook post publication with verification receipts.',
  execute
};

