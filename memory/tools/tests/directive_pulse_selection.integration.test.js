#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { loadActiveDirectives } = require('../../../lib/directive_resolver.js');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function writeJsonl(filePath, rows) {
  mkDir(path.dirname(filePath));
  const body = (rows || []).map(r => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, `${body}${body ? '\n' : ''}`, 'utf8');
}

function parseLastJson(stdout) {
  const lines = String(stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'autonomy', 'autonomy_controller.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_directive_pulse_selection');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const testDate = '2099-12-30';
  const proposalsPath = path.join(repoRoot, 'state', 'sensory', 'proposals', `${testDate}.json`);
  const backupExists = fs.existsSync(proposalsPath);
  const backupBody = backupExists ? fs.readFileSync(proposalsPath, 'utf8') : null;

  try {
    const directiveRows = (() => {
      try {
        const directives = loadActiveDirectives({ allowMissing: true });
        return directives
          .map((d) => {
            const data = d && d.data && typeof d.data === 'object' ? d.data : {};
            const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
            const id = String(meta.id || d.id || '').trim();
            const tier = Number.isFinite(Number(d && d.tier))
              ? Number(d.tier)
              : Number(meta.tier);
            if (!id || /^T0(?:_|$)/i.test(id)) return null;
            if (!Number.isFinite(tier)) return null;
            return { id, tier };
          })
          .filter(Boolean)
          .sort((a, b) => a.tier - b.tier || String(a.id).localeCompare(String(b.id)));
      } catch {
        return [];
      }
    })();
    const primaryObjective = directiveRows.find((r) => r.tier <= 1) || directiveRows[0] || { id: 'T1_make_jay_billionaire_v1', tier: 1 };
    const secondaryObjective = directiveRows.find((r) => r.tier >= 2) || primaryObjective;

    writeJson(proposalsPath, [
      {
        id: 'PULSE-SEL-T1',
        type: 'external_intel',
        title: 'Build scalable automated systems for wealth growth',
        summary: 'Prioritize one bounded implementation that increases compounding revenue.',
        expected_impact: 'medium',
        risk: 'low',
        validation: [
          'Define one measurable output metric with 24h target',
          'Run dry-run route and capture receipt'
        ],
        suggested_next_command: 'node systems/routing/route_execute.js --task="Implement one bounded compounding automation step" --tokens_est=700 --dry-run',
        action_spec: {
          version: 1,
          objective_id: primaryObjective.id,
          target: 'signal:pulse-sel-t1',
          next_command: 'node systems/routing/route_execute.js --task="Implement one bounded compounding automation step" --tokens_est=700 --dry-run',
          verify: [
            'Define one measurable output metric with 24h target',
            'Run dry-run route and capture receipt'
          ],
          success_criteria: [
            {
              metric: 'artifact_count',
              target: '>=1 artifact produced',
              horizon: '24h'
            }
          ],
          rollback: 'Revert bounded automation change'
        },
        evidence: [
          { evidence_ref: 'eye:local_state_fallback', evidence_url: 'https://local.workspace/signal/pulse-sel-t1' }
        ],
        meta: {
          source_eye: 'local_state_fallback',
          directive_objective_id: primaryObjective.id,
          relevance_score: 75,
          relevance_tier: 'high',
          signal_quality_score: 80,
          signal_quality_tier: 'high'
        }
      },
      {
        id: 'PULSE-SEL-ALT',
        type: 'external_intel',
        title: 'Improve reliability observability process',
        summary: 'General infra optimization task.',
        expected_impact: 'low',
        risk: 'low',
        validation: [
          'Define measurable reliability metric and 48h threshold',
          'Route dry-run'
        ],
        suggested_next_command: 'node systems/routing/route_execute.js --task="Improve reliability logging" --tokens_est=500 --dry-run',
        action_spec: {
          version: 1,
          objective_id: secondaryObjective.id,
          target: 'signal:pulse-sel-alt',
          next_command: 'node systems/routing/route_execute.js --task="Improve reliability logging" --tokens_est=500 --dry-run',
          verify: [
            'Define measurable reliability metric and 48h threshold',
            'Route dry-run'
          ],
          success_criteria: [
            {
              metric: 'error_rate',
              target: 'error rate reduced versus baseline',
              horizon: '48h'
            }
          ],
          rollback: 'Revert logging changes'
        },
        evidence: [
          { evidence_ref: 'eye:local_state_fallback', evidence_url: 'https://local.workspace/signal/pulse-sel-alt' }
        ],
        meta: {
          source_eye: 'local_state_fallback',
          directive_objective_id: secondaryObjective.id,
          relevance_score: 70,
          relevance_tier: 'medium',
          signal_quality_score: 72,
          signal_quality_tier: 'medium'
        }
      }
    ]);

    const autonomyDir = path.join(tmpRoot, 'autonomy');
    const runsDir = path.join(autonomyDir, 'runs');
    writeJsonl(path.join(runsDir, `${testDate}.jsonl`), [
      {
        ts: new Date().toISOString(),
        type: 'autonomy_run',
        result: 'executed',
        outcome: 'no_change',
        directive_pulse: {
          objective_id: 'seed_tier2',
          tier: 2
        }
      }
    ]);

    const env = {
      ...process.env,
      AUTONOMY_STATE_DIR: autonomyDir,
      AUTONOMY_DIRECTIVE_PULSE_ENABLED: '1',
      AUTONOMY_DIRECTIVE_PULSE_T1_MIN_SHARE: '0.5',
      AUTONOMY_DIRECTIVE_PULSE_T2_MIN_SHARE: '0.25'
    };

    const r = runScript(repoRoot, ['evidence', testDate], env);
    assert.strictEqual(r.status, 0, `evidence run should pass: ${r.stderr}`);
    const out = parseLastJson(r.stdout);
    assert.ok(out && typeof out === 'object', 'expected JSON output');
    assert.strictEqual(out.result, 'score_only_evidence');
    assert.strictEqual(out.selection_mode, 'directive_reservation');
    assert.ok(out.directive_pulse && out.directive_pulse.objective_id, 'expected directive pulse objective');
    assert.strictEqual(String(out.directive_pulse.objective_id), String(primaryObjective.id), 'expected objective-bound reservation candidate');
    assert.strictEqual(Number(out.directive_pulse.tier), Number(primaryObjective.tier), 'expected reserved objective tier');

    console.log('directive_pulse_selection.integration.test.js: OK');
  } finally {
    if (backupExists) fs.writeFileSync(proposalsPath, backupBody, 'utf8');
    else if (fs.existsSync(proposalsPath)) fs.rmSync(proposalsPath, { force: true });
  }
}

try {
  run();
} catch (err) {
  console.error(`directive_pulse_selection.integration.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
