#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function run(args, extraEnv = null, stdinInput = '') {
  const env = Object.assign({}, process.env, extraEnv || {});
  const proc = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    input: String(stdinInput || '')
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
  assert.ok(out.stdout.includes('**Alignment Indicator:** [Yellow] auto'), 'default mode should show yellow auto indicator');
  assert.ok(out.stdout.includes('personas/vikram_menon/decision_lens.md'), 'should include decision lens context file');
  assert.ok(out.stdout.includes('personas/vikram_menon/data_streams.md'), 'should include data stream context file');
  assert.ok(out.stdout.includes('personas/vikram_menon/soul_token.md'), 'should include soul token context file');
  assert.ok(out.stdout.includes('Prioritize memory core determinism first'), 'should include expected guidance');

  out = run(['lens', 'jay_haslam', 'How can we reduce drift in the loops?']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('# Lens Response: Jay Haslam'), 'jay persona should render markdown title');
  assert.ok(out.stdout.includes('personas/jay_haslam/profile.md'), 'jay persona should include context files');

  out = run(['lens', 'vikram', 'strategic', 'How does this sprint support the singularity seed?']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('**Lens Mode:** `strategic`'), 'strategic mode should be reflected');
  assert.ok(out.stdout.includes('personas/vikram_menon/strategic_lens.md'), 'strategic mode should include strategic lens context');

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
  assert.ok(out.stdout.includes('**Lens Mode:** `decision`'), 'all command should include lens mode');
  assert.ok(out.stdout.includes('## Vikram Menon (`vikram_menon`)'), 'all command should include vikram section');
  assert.ok(out.stdout.includes('## Priya Venkatesh (`priya_venkatesh`)'), 'all command should include priya section');
  assert.ok(out.stdout.includes('## Rohan Kapoor (`rohan_kapoor`)'), 'all command should include rohan section');
  assert.ok(out.stdout.includes('## Jay Haslam (`jay_haslam`)'), 'all command should include jay section');
  assert.ok(out.stdout.includes('## Li Wei (`li_wei`)'), 'all command should include li wei section');
  assert.ok(out.stdout.includes('## Aarav Singh (`aarav_singh`)'), 'all command should include aarav section');

  out = run(['lens', 'update-stream', 'vikram_menon', '--dry-run=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('"type": "persona_stream_update"'), 'update-stream should return stream update payload');
  assert.ok(out.stdout.includes('"dry_run": true'), 'update-stream dry-run should be true');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-lens-'));
  const srcPersona = path.join(ROOT, 'personas', 'vikram_menon');
  const dstPersona = path.join(tmp, 'personas', 'vikram_menon');
  fs.mkdirSync(path.join(tmp, 'personas'), { recursive: true });
  fs.cpSync(srcPersona, dstPersona, { recursive: true });
  out = run(
    ['lens', 'vikram_menon', '--gap=1', '--active=1', 'Prioritize memory or security first?'],
    { OPENCLAW_WORKSPACE: tmp },
    'e\nSecurity first, but keep memory parity checks strict.\n'
  );
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('Starting cognizance-gap (1s)'), 'should emit live cognizance-gap start');
  assert.ok(out.stdout.includes('Stream step'), 'should emit stream steps');
  assert.ok(out.stdout.includes('**Alignment Indicator:** [Green] active'), 'active mode should show green indicator');
  assert.ok(out.stdout.includes('**Intercept:** applied'), 'intercept should be applied');
  const updatedCorrespondence = fs.readFileSync(path.join(dstPersona, 'correspondence.md'), 'utf8');
  assert.ok(updatedCorrespondence.includes('Re: persona intercept'), 'intercept should append correspondence entry');
  assert.ok(updatedCorrespondence.includes('Security first, but keep memory parity checks strict.'), 'intercept text should persist in correspondence');

  out = run(['lens', 'vikram_menon', '--gap=4', 'Prioritize memory or security first?'], null, 'a\n');
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('approved early by operator'), 'approve early signal should skip remaining gap');

  out = run(['lens', 'vikram_menon', 'How can we monetize this persona for ads?']);
  assert.notStrictEqual(out.status, 0, 'non-commercial soul-token query should fail');
  assert.ok(out.stderr.includes('soul_token_policy_blocked:non_commercial_use_only'), 'soul token non-commercial rule should block query');

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
