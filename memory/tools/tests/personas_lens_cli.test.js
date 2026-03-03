#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function run(args) {
  const proc = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

try {
  let out = run(['lens', 'vikram', 'Should we prioritize memory or security first?']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('# Lens Response: Vikram Menon'), 'should render markdown title');
  assert.ok(out.stdout.includes('personas/vikram_menon/profile.md'), 'should include context files');
  assert.ok(out.stdout.includes('Prioritize memory core determinism first'), 'should include expected guidance');

  out = run(['lens', 'jay_haslam', 'How can we reduce drift in the loops?']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('# Lens Response: Jay Haslam'), 'jay persona should render markdown title');
  assert.ok(out.stdout.includes('personas/jay_haslam/profile.md'), 'jay persona should include context files');

  out = run(['lens', 'li_wei', 'How can we make the personas viral?']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('# Lens Response: Li Wei'), 'li wei persona should render markdown title');
  assert.ok(out.stdout.includes('personas/li_wei/profile.md'), 'li wei persona should include context files');
  assert.ok(out.stdout.includes('personas/li_wei/emotion_lens.md'), 'li wei persona should include emotion lens context');
  assert.ok(out.stdout.includes('Emotion signal:'), 'li wei persona should include emotion signal reasoning');

  out = run(['lens', 'aarav_singh', 'How should we harden security gates?']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('# Lens Response: Aarav Singh'), 'aarav persona should render markdown title');
  assert.ok(out.stdout.includes('personas/aarav_singh/profile.md'), 'aarav persona should include context files');
  assert.ok(out.stdout.includes('personas/aarav_singh/emotion_lens.md'), 'aarav persona should include emotion lens context');
  assert.ok(out.stdout.includes('Emotion signal:'), 'aarav persona should include emotion signal reasoning');

  out = run(['lens', 'all', 'Should we prioritize memory or security first?']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('# Lens Response: All Personas'), 'all command should render top-level heading');
  assert.ok(out.stdout.includes('## Vikram Menon (`vikram_menon`)'), 'all command should include vikram section');
  assert.ok(out.stdout.includes('## Priya Venkatesh (`priya_venkatesh`)'), 'all command should include priya section');
  assert.ok(out.stdout.includes('## Rohan Kapoor (`rohan_kapoor`)'), 'all command should include rohan section');
  assert.ok(out.stdout.includes('## Jay Haslam (`jay_haslam`)'), 'all command should include jay section');
  assert.ok(out.stdout.includes('## Li Wei (`li_wei`)'), 'all command should include li wei section');
  assert.ok(out.stdout.includes('## Aarav Singh (`aarav_singh`)'), 'all command should include aarav section');

  out = run(['lens', '--list']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('vikram_menon'), 'list should include vikram persona');

  out = run(['lens', 'not_a_real_persona', 'hello']);
  assert.notStrictEqual(out.status, 0, 'unknown persona should fail');
  assert.ok(out.stderr.includes('unknown_persona'), 'unknown persona should print error');

  console.log('personas_lens_cli.test.js: OK');
} catch (err) {
  console.error(`personas_lens_cli.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
