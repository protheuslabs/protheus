#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function run(args, env = {}) {
  const out = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_RUNTIME_MODE: 'source',
      PROTHEUS_CTL_SECURITY_GATE_DISABLED: '1',
      PROTHEUS_CLI_SUGGESTIONS: '0',
      PROTHEUS_UPDATE_CHECKER_DISABLED: '1',
      ...env
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || '')
  };
}

try {
  let out = run(['completion', 'bash']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('complete -F _protheus_complete protheus'), 'bash completion should include complete hook');
  assert.ok(out.stdout.includes('local commands='), 'bash completion should include command list');
  assert.ok(out.stdout.includes('global_flags='), 'bash completion should include global flags');
  assert.ok(out.stdout.includes('setup)'), 'bash completion should include setup case');

  out = run(['completion', 'zsh']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('#compdef protheus'), 'zsh completion should include compdef');
  assert.ok(out.stdout.includes('_describe'), 'zsh completion should include descriptions');
  assert.ok(out.stdout.includes('global_flags=('), 'zsh completion should include global flags');
  assert.ok(out.stdout.includes('diagram)'), 'zsh completion should include diagram case');

  out = run(['completion', 'fish']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('complete -c protheus'), 'fish completion should include completion declarations');
  assert.ok(out.stdout.includes('__fish_use_subcommand'), 'fish completion should include subcommand gating');
  assert.ok(out.stdout.includes('__fish_seen_subcommand_from setup'), 'fish completion should include setup subcommands');
  assert.ok(out.stdout.includes('__fish_seen_subcommand_from shadow'), 'fish completion should include shadow subcommands');
  assert.ok(out.stdout.includes('__fish_seen_subcommand_from shadow" -a "arise'), 'fish completion should include shadow arise subcommand');

  console.log('protheus_completion_command.test.js: OK');
} catch (err) {
  console.error(`protheus_completion_command.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
