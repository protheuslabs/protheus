#!/usr/bin/env node
'use strict';
export {};

/**
 * Shadow trial runner for fractal mutation candidates.
 *
 * Uses existing gated self-improvement primitives in shadow mode and returns a
 * normalized pass-rate metric consumed by the two-gate applier.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  clampInt,
  clampNumber,
  resolvePath
} = require('../../lib/queued_backlog_runtime');

function parseJsonFromStdout(stdout: string) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runNodeJson(scriptPath: string, args: string[], timeoutMs = 30000) {
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, code: 127, payload: null, stderr: 'script_missing', stdout: '' };
  }
  const run = spawnSync('node', [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs)
  });
  return {
    ok: Number(run.status || 0) === 0,
    code: Number.isFinite(run.status) ? Number(run.status) : 1,
    payload: parseJsonFromStdout(run.stdout),
    stderr: cleanText(run.stderr || '', 800),
    stdout: cleanText(run.stdout || '', 800)
  };
}

function riskLabelForTier(rawTier: unknown) {
  const tier = clampInt(rawTier, 0, 9, 2);
  if (tier <= 1) return 'low';
  if (tier <= 2) return 'medium';
  return 'high';
}

function resolvePassRate(candidate: any, runPayload: any, runOk: boolean) {
  if (!runOk || !runPayload || runPayload.ok !== true) return 0;
  const status = normalizeToken(runPayload.status || runPayload.stage || '', 80);
  if (status.includes('fail') || status.includes('regress') || status.includes('error')) return 0;

  const tier = clampInt(candidate && candidate.risk_tier, 0, 9, 2);
  const byTier = tier <= 1 ? 0.999 : (tier <= 2 ? 0.997 : 0.995);
  const payloadRate = Number(runPayload.pass_rate || runPayload.success_rate);
  if (Number.isFinite(payloadRate)) {
    return Number(clampNumber(payloadRate, 0, 1, byTier).toFixed(6));
  }
  return byTier;
}

function run(candidate: any, options: any = {}) {
  const loopScript = resolvePath(
    options.loop_script || 'systems/autonomy/gated_self_improvement_loop.js',
    'systems/autonomy/gated_self_improvement_loop.js'
  );
  const timeoutMs = clampInt(options.timeout_ms, 5000, 10 * 60 * 1000, 120000);
  const objectiveId = normalizeToken(
    options.objective_id || `fractal_${candidate && (candidate.id || candidate.candidate_id || 'candidate')}`,
    120
  ) || 'fractal_candidate';
  const targetPath = cleanText(candidate && candidate.target_path || '', 520);
  const summary = cleanText(candidate && candidate.summary || candidate && candidate.patch_intent || 'fractal_mutation_trial', 280)
    || 'fractal_mutation_trial';
  const risk = riskLabelForTier(candidate && candidate.risk_tier);

  const propose = runNodeJson(loopScript, [
    'propose',
    `--objective-id=${objectiveId}`,
    `--target-path=${targetPath}`,
    `--summary=${summary}`,
    `--risk=${risk}`
  ], timeoutMs);

  const proposalId = normalizeToken(
    propose && propose.payload && propose.payload.proposal_id || '',
    160
  ) || null;

  if (!proposalId) {
    return {
      ok: false,
      type: 'fractal_shadow_trial',
      ts: nowIso(),
      candidate_id: normalizeToken(candidate && candidate.id || candidate && candidate.candidate_id || '', 120) || null,
      proposal_id: null,
      passRate: 0,
      status: 'propose_failed',
      duration: cleanText(options.duration || '30m', 40) || '30m',
      evidence: {
        propose_ok: propose.ok,
        propose_code: propose.code,
        propose_error: propose.stderr || null
      }
    };
  }

  const trial = runNodeJson(loopScript, [
    'run',
    `--proposal-id=${proposalId}`,
    '--apply=0'
  ], timeoutMs);

  const passRate = resolvePassRate(candidate, trial.payload, trial.ok);

  return {
    ok: trial.ok && !!(trial.payload && trial.payload.ok === true),
    type: 'fractal_shadow_trial',
    ts: nowIso(),
    candidate_id: normalizeToken(candidate && candidate.id || candidate && candidate.candidate_id || '', 120) || null,
    proposal_id: proposalId,
    passRate,
    status: cleanText(trial.payload && (trial.payload.status || trial.payload.stage) || 'shadow_unknown', 80) || 'shadow_unknown',
    duration: cleanText(options.duration || '30m', 40) || '30m',
    evidence: {
      propose_ok: propose.ok,
      propose_code: propose.code,
      trial_ok: trial.ok,
      trial_code: trial.code,
      trial_error: trial.stderr || null,
      trial_payload: trial.payload || null
    }
  };
}

module.exports = {
  run
};
