#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');
const LIST_CLI = path.join(ROOT, 'systems', 'ops', 'protheus_command_list.js');

function run(script, args, env = {}) {
  const out = spawnSync(process.execPath, [script, ...args], {
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
  let out = run(PROTHEUSCTL, ['list']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('Protheus CLI Tools'), 'list output should include title');
  assert.ok(out.stdout.includes('Core Commands:'), 'list output should include categories');
  assert.ok(out.stdout.includes('protheus lens <persona> "<query>"'), 'list output should include lens command');
  assert.ok(out.stdout.includes('protheus research "<query>"'), 'list output should include research command');
  assert.ok(out.stdout.includes('protheus setup'), 'list output should include setup command');
  assert.ok(out.stdout.includes('protheus version'), 'list output should include version command');
  assert.ok(out.stdout.includes('protheus demo'), 'list output should include demo command');
  assert.ok(out.stdout.includes('protheus debug [--deep=1]'), 'list output should include debug command');
  assert.ok(out.stdout.includes('protheus shadow <list|arise|pause|review|status>'), 'list output should include shadow operator command');

  out = run(PROTHEUSCTL, ['--help']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('Protheus CLI Help'), '--help output should include help title');
  assert.ok(out.stdout.includes('Type `protheus <command> --help` for command-specific details.'), 'help output should include guidance');

  out = run(LIST_CLI, ['--mode=list', '--json=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  const payload = JSON.parse(out.stdout);
  assert.strictEqual(payload.ok, true, 'json mode should return ok=true');
  const commands = payload.categories.flatMap((row) => row.commands.map((cmd) => cmd.command));
  assert.ok(commands.includes('list'), 'manifest should include list');
  assert.ok(commands.includes('assimilate'), 'manifest should include assimilate');
  assert.ok(commands.includes('research'), 'manifest should include research');
  assert.ok(commands.includes('setup'), 'manifest should include setup');
  assert.ok(commands.includes('version'), 'manifest should include version');
  assert.ok(commands.includes('demo'), 'manifest should include demo');
  assert.ok(commands.includes('debug'), 'manifest should include debug');
  assert.ok(commands.includes('shadow'), 'manifest should include shadow');

  console.log('protheus_list_command.test.js: OK');
} catch (err) {
  console.error(`protheus_list_command.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
