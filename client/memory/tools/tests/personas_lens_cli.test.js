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
  assert.ok(out.stdout.includes('**Persona LLM:** `off`'), 'persona LLM should default to off');
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
  assert.ok(out.stdout.includes('**Emotion Lens:** `on`'), 'emotion lens should default to on');
  assert.ok(out.stdout.includes('personas/li_wei/emotion_lens.md'), 'li wei persona should include emotion lens context');
  assert.ok(out.stdout.includes('Emotion signal:'), 'li wei persona should include emotion signal reasoning');

  out = run(['lens', 'li_wei', '--emotion=off', 'How can we make the personas viral?']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('**Emotion Lens:** `off`'), 'emotion flag should disable emotion lens');
  assert.ok(!out.stdout.includes('Emotion signal:'), 'emotion-off run should not include emotion signals');
  assert.ok(!out.stdout.includes('personas/li_wei/emotion_lens.md'), 'emotion-off run should hide emotion lens context file');

  out = run(['lens', 'li_wei', '--values=off', 'How can we make the personas durable?']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('**Values Lens:** `off`'), 'values flag should disable values lens');
  assert.ok(!out.stdout.includes('Values filter:'), 'values-off run should suppress values filter reasoning');
  assert.ok(!out.stdout.includes('personas/li_wei/values_philosophy_lens.md'), 'values-off run should hide values lens context file');

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
  assert.ok(out.stdout.includes('**Context Budget Cap:** `2000` tokens'), 'all command should include context budget cap');
  assert.ok(out.stdout.includes('## Aarav Singh (`aarav_singh`)'), 'all command should include at least one persona section');

  out = run([
    'lens',
    'vikram',
    'rohan',
    'Prioritize memory or security first?',
    '--expected=Prioritize memory core determinism first.'
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('# Lens Response: Multi Persona'), 'multi-persona run should render multi heading');
  assert.ok(out.stdout.includes('## Persona Positions'), 'multi-persona run should include position section');
  assert.ok(out.stdout.includes('## Arbitration'), 'multi-persona run should include arbitration section');
  assert.ok(out.stdout.includes('Rule file:'), 'multi-persona run should reference arbitration rule file');
  assert.ok(out.stdout.includes('**Disagreement:** `yes`'), 'multi-persona run should detect disagreement when divergence exceeds threshold');
  assert.ok(out.stdout.includes('Winner: `vikram_menon`'), 'multi-persona arbitration should pick vikram by deterministic tie-break for this query');
  assert.ok(out.stdout.includes('## Surprise Check'), 'multi-persona run should include surprise check section');
  assert.ok(out.stdout.includes('Recall signals:'), 'multi-persona run should include client/memory/feed recall context');

  out = run([
    'arbitrate',
    '--between=vikram,priya',
    '--issue=sample vs full audit for migration evidence',
    '--schema=json'
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  const arbitrationPayload = JSON.parse(out.stdout);
  assert.strictEqual(arbitrationPayload.type, 'persona_arbitration', 'arbitrate command should emit persona_arbitration payload');
  assert.ok(arbitrationPayload.winner, 'arbitrate command should resolve a deterministic winner');
  assert.ok(Array.isArray(arbitrationPayload.persona_positions), 'arbitrate command should include persona positions');

  out = run(['lens', 'trigger', 'pre-sprint', 'Foundation Lock sprint planning review']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('# Trigger: pre-sprint'), 'pre-sprint trigger should render trigger heading');
  assert.ok(out.stdout.includes('# Lens Response: All Personas'), 'pre-sprint trigger should run all-persona lens response');

  out = run(['lens', 'trigger', 'drift-alert', 'Drift climbed above threshold in inversion loop.']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('# Trigger: drift-alert'), 'drift-alert trigger should render trigger heading');
  assert.ok(out.stdout.includes('# Lens Response: Vikram Menon'), 'drift-alert trigger should consult vikram by default');

  out = run(['lens', 'dashboard', '--window=5']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('# Personas Dashboard'), 'dashboard command should render markdown heading');
  assert.ok(out.stdout.includes('Trigger policy doc:'), 'dashboard should include trigger policy reference');

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

  const checkinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-lens-checkin-'));
  fs.mkdirSync(path.join(checkinRoot, 'personas'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'personas', 'jay_haslam'), path.join(checkinRoot, 'personas', 'jay_haslam'), { recursive: true });
  fs.writeFileSync(path.join(checkinRoot, 'HEARTBEAT.md'), '# HEARTBEAT\n- stabilize inversion drift below 2%\n', 'utf8');
  out = run(['lens', 'checkin', '--persona=jay_haslam', '--heartbeat=HEARTBEAT.md', '--emotion=off'], { OPENCLAW_WORKSPACE: checkinRoot });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('"type": "persona_checkin"'), 'checkin command should return persona_checkin payload');
  assert.ok(out.stdout.includes('"emotion": "off"'), 'checkin payload should include emotion mode');
  const checkinCorrespondence = fs.readFileSync(path.join(checkinRoot, 'personas', 'jay_haslam', 'correspondence.md'), 'utf8');
  assert.ok(checkinCorrespondence.includes('Re: daily checkin'), 'checkin should append daily checkin entry');
  assert.ok(checkinCorrespondence.includes('Heartbeat snapshot:'), 'checkin should persist heartbeat snapshot');
  const checkinMemory = fs.readFileSync(path.join(checkinRoot, 'personas', 'jay_haslam', 'memory.md'), 'utf8');
  assert.ok(checkinMemory.includes('title: daily checkin'), 'checkin should append persona memory node');

  out = run(['lens', 'trigger', 'weekly-checkin', '--persona=jay_haslam', '--heartbeat=HEARTBEAT.md'], { OPENCLAW_WORKSPACE: checkinRoot });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('"type": "persona_checkin"'), 'weekly-checkin trigger should return persona_checkin payload');

  const feedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-lens-feed-'));
  fs.mkdirSync(path.join(feedRoot, 'personas'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'personas', 'vikram_menon'), path.join(feedRoot, 'personas', 'vikram_menon'), { recursive: true });
  out = run(
    ['lens', 'feed', 'vikram_menon', 'Cross-signal detected elevated security drift risk.', '--source=master_llm', '--tags=drift,security'],
    { OPENCLAW_WORKSPACE: feedRoot }
  );
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('"type": "persona_feed_append"'), 'feed command should return append payload');
  assert.ok(out.stdout.includes('"system_passed_record"'), 'feed command should append system_passed payload when eligible');
  const feedBody = fs.readFileSync(path.join(feedRoot, 'personas', 'vikram_menon', 'feed.md'), 'utf8');
  assert.ok(feedBody.includes('Cross-signal detected elevated security drift risk.'), 'feed should append snippet');
  assert.ok(feedBody.includes('## System Passed'), 'feed should include system passed section');
  assert.ok(feedBody.includes('"hash"'), 'feed should include hash-verified system payload record');
  const feedMemory = fs.readFileSync(path.join(feedRoot, 'personas', 'vikram_menon', 'memory.md'), 'utf8');
  assert.ok(feedMemory.includes('title: feed update'), 'feed append should write memory node');

  out = run(
    ['lens', 'vikram_menon', '--include-feed=1', 'Should we prioritize memory or security first?'],
    { OPENCLAW_WORKSPACE: feedRoot }
  );
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('**System Passed Feed:** `on`'), 'include-feed should be reflected in markdown');
  assert.ok(out.stdout.includes('System-passed context:'), 'include-feed should inject system-passed outcome context');

  const telemetryBody = fs.readFileSync(path.join(feedRoot, 'personas', 'organization', 'telemetry.jsonl'), 'utf8');
  assert.ok(telemetryBody.includes('"metric":"passed_data_utility_rate"'), 'include-feed lens run should emit passed_data_utility_rate telemetry');

  out = run(
    ['lens', 'vikram_menon', '--schema=json', '--surprise=on', '--surprise-seed=test-seed-001', 'Should we prioritize memory or security first?'],
    { OPENCLAW_WORKSPACE: feedRoot }
  );
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  const structured = JSON.parse(out.stdout);
  assert.strictEqual(structured.schema, 'persona_lens_v1', 'schema=json should emit structured persona payload');
  assert.strictEqual(typeof structured.recommendation, 'string', 'structured payload should include recommendation');
  assert.strictEqual(typeof structured.confidence, 'number', 'structured payload should include confidence');
  assert.ok(Array.isArray(structured.blockers), 'structured payload should include blockers array');
  assert.ok(Array.isArray(structured.recent_correspondence), 'structured payload should include recent correspondence entries');
  assert.ok(structured.surprise && typeof structured.surprise.roll === 'number', 'structured payload should include surprise metadata');

  out = run(
    ['persona', 'feed', 'vikram_menon', 'Operator direct persona feed through protheusctl persona route.', '--source=operator', '--tags=ops'],
    { OPENCLAW_WORKSPACE: feedRoot }
  );
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('"type": "persona_feed_append"'), 'protheusctl persona route should support feed append');

  out = run(
    ['lens', 'feedback', '--surprising=1', '--changed-decision=1', '--useful=vikram_menon', '--note=helped catch parity risk before merge'],
    { OPENCLAW_WORKSPACE: feedRoot }
  );
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('"type": "persona_feedback_recorded"'), 'feedback command should append feedback row');

  out = run(['lens', 'feedback-summary', '--window=20', '--json=1'], { OPENCLAW_WORKSPACE: feedRoot });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  const feedbackSummary = JSON.parse(out.stdout);
  assert.strictEqual(feedbackSummary.type, 'persona_feedback_summary', 'feedback summary should return summary payload');
  assert.ok(feedbackSummary.total >= 1, 'feedback summary should include at least one row');

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
