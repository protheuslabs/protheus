#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/fractal/organism_cycle.js
 *
 * Bounded organism cycle implementing:
 * 1) dream consolidation
 * 2) symbiotic mutualism planning
 * 3) predator-prey pressure modeling
 * 4) epigenetic regulation tags
 * 5) signed pheromone packets
 * 6) resonance/harmony scoring
 * 7) collective archetype pool updates
 *
 * All outputs are proposal-only; no direct self-mutation.
 *
 * Usage:
 *   node systems/fractal/organism_cycle.js run [YYYY-MM-DD]
 *   node systems/fractal/organism_cycle.js status [YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const FRACTAL_DIR = process.env.FRACTAL_ORGANISM_DIR
  ? path.resolve(process.env.FRACTAL_ORGANISM_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'fractal');
const OUTPUT_DIR = path.join(FRACTAL_DIR, 'organism_cycle');
const EPIGENETIC_PATH = path.join(FRACTAL_DIR, 'epigenetic_tags.json');
const ARCHETYPE_POOL_PATH = path.join(FRACTAL_DIR, 'archetype_pool.json');
const ALERTS_DIR = path.join(FRACTAL_DIR, 'alerts');
const PHEROMONE_DIR = path.join(FRACTAL_DIR, 'pheromones');
const RUNS_DIR = process.env.FRACTAL_ORGANISM_RUNS_DIR
  ? path.resolve(process.env.FRACTAL_ORGANISM_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const INTROSPECTION_DIR = process.env.FRACTAL_INTROSPECTION_DIR
  ? path.resolve(process.env.FRACTAL_INTROSPECTION_DIR)
  : path.join(FRACTAL_DIR, 'introspection');
const SIM_DIR = process.env.FRACTAL_ORGANISM_SIM_DIR
  ? path.resolve(process.env.FRACTAL_ORGANISM_SIM_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'simulations');
const SALT = String(process.env.FRACTAL_PHEROMONE_SIGNING_SALT || 'local_fractal_pheromone_salt_v1');
const ARCHETYPE_NOVELTY_CONFIDENCE_DELTA_MIN = Math.max(
  0.01,
  Math.min(0.5, Number(process.env.FRACTAL_ARCHETYPE_NOVELTY_CONFIDENCE_DELTA_MIN || 0.08))
);

function usage() {
  console.log('Usage:');
  console.log('  node systems/fractal/organism_cycle.js run [YYYY-MM-DD]');
  console.log('  node systems/fractal/organism_cycle.js status [YYYY-MM-DD]');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const tok of argv) out._.push(String(tok || ''));
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const out = [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') out.push(row);
      } catch {
        // ignore malformed
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function stableId(seed, prefix = 'id') {
  const digest = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 14);
  return `${prefix}_${digest}`;
}

function compact(text, max = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

function runSignals(dateStr) {
  const runs = readJsonl(path.join(RUNS_DIR, `${dateStr}.jsonl`));
  const counts = {
    executed: 0,
    shipped: 0,
    no_change: 0,
    policy_holds: 0
  };
  const failureReasons = {};
  const successTypes = {};
  for (const row of runs) {
    if (String(row && row.type || '') !== 'autonomy_run') continue;
    const result = String(row && row.result || '').trim().toLowerCase();
    const outcome = String(row && row.outcome || '').trim().toLowerCase();
    const pType = String(row && row.proposal_type || '').trim().toLowerCase() || 'unknown';
    if (result === 'executed') counts.executed += 1;
    if (outcome === 'shipped') {
      counts.shipped += 1;
      successTypes[pType] = Number(successTypes[pType] || 0) + 1;
    } else if (outcome === 'no_change') {
      counts.no_change += 1;
    }
    if (result === 'policy_hold' || result.startsWith('no_candidates_policy_')) {
      counts.policy_holds += 1;
      failureReasons[result] = Number(failureReasons[result] || 0) + 1;
    }
  }
  return { counts, failureReasons, successTypes };
}

function simulationSignals(dateStr) {
  const payload = readJson(path.join(SIM_DIR, `${dateStr}.json`), {});
  const checks = payload && payload.checks_effective && typeof payload.checks_effective === 'object'
    ? payload.checks_effective
    : (payload && payload.checks && typeof payload.checks === 'object' ? payload.checks : {});
  return {
    drift: safeNumber(checks && checks.drift_rate && checks.drift_rate.value, NaN),
    yieldRate: safeNumber(checks && checks.yield_rate && checks.yield_rate.value, NaN)
  };
}

function introspectionSignals(dateStr) {
  const payload = readJson(path.join(INTROSPECTION_DIR, `${dateStr}.json`), {});
  const snap = payload && payload.snapshot && typeof payload.snapshot === 'object'
    ? payload.snapshot
    : {};
  return {
    queue_pressure: String(snap && snap.queue && snap.queue.pressure || 'normal'),
    autopause_active: snap && snap.autopause ? snap.autopause.active === true : false,
    restructure_candidates: Array.isArray(payload && payload.restructure_candidates)
      ? payload.restructure_candidates
      : []
  };
}

function dreamConsolidation(dateStr, runSig) {
  const topFailures = Object.entries(runSig.failureReasons || {})
    .sort((a: any, b: any) => Number(b[1]) - Number(a[1]))
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count: Number(count || 0) }));
  const topSuccess = Object.entries(runSig.successTypes || {})
    .sort((a: any, b: any) => Number(b[1]) - Number(a[1]))
    .slice(0, 5)
    .map(([proposal_type, count]) => ({ proposal_type, count: Number(count || 0) }));
  return {
    mode: 'bounded_sleep_cycle',
    date: dateStr,
    compressed_patterns: {
      failures: topFailures,
      successes: topSuccess
    },
    proposal_only: true,
    note: 'Dream pass consolidates patterns without direct actuation.'
  };
}

function symbiosisPlan(introSig, runSig) {
  const plans = [];
  if (String(introSig.queue_pressure || '') === 'critical' || String(introSig.queue_pressure || '') === 'high') {
    plans.push({
      id: stableId(`symbiosis|queue|${introSig.queue_pressure}`, 'sym'),
      members: ['sensory', 'strategy', 'autonomy'],
      objective: 'queue_pressure_relief',
      ttl_hours: 24,
      dissolve_if: 'queue_pressure_below_elevated_2h'
    });
  }
  if (safeNumber(runSig.counts.no_change, 0) >= 10) {
    plans.push({
      id: stableId('symbiosis|no_change|memory', 'sym'),
      members: ['memory', 'strategy', 'autonomy'],
      objective: 'no_change_pattern_reduction',
      ttl_hours: 48,
      dissolve_if: 'no_change_rate_reduced'
    });
  }
  return plans.slice(0, 4);
}

function predatorPreyModel(runSig, introSig) {
  const prey = [];
  if (safeNumber(runSig.counts.no_change, 0) > safeNumber(runSig.counts.shipped, 0) + 8) {
    prey.push({
      module: 'autonomy_selector',
      condition: 'high_no_change_density',
      action: 'shadow_challenge',
      safety: 'no_auto_disable'
    });
  }
  if (safeNumber(runSig.counts.policy_holds, 0) >= 20) {
    prey.push({
      module: 'admission_gate',
      condition: 'policy_hold_churn',
      action: 'shadow_quarantine_tuning',
      safety: 'no_auto_disable'
    });
  }
  if (String(introSig.queue_pressure || '') === 'critical') {
    prey.push({
      module: 'queue_scheduler',
      condition: 'critical_backlog',
      action: 'shadow_backpressure_trial',
      safety: 'no_auto_disable'
    });
  }
  return {
    mode: 'shadow_predator',
    predator: 'red_team_shadow',
    candidates: prey.slice(0, 6)
  };
}

function loadEpigeneticTags() {
  const payload = readJson(EPIGENETIC_PATH, null);
  if (!payload || typeof payload !== 'object') {
    return {
      schema_id: 'epigenetic_tags',
      schema_version: '1.0.0',
      updated_at: null,
      tags: {}
    };
  }
  return payload;
}

function deriveTritValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

function updateEpigeneticTags(current, simSig, introSig) {
  const next = {
    ...current,
    updated_at: nowIso(),
    tags: { ...(current && current.tags && typeof current.tags === 'object' ? current.tags : {}) }
  };
  const drift = Number(simSig.drift);
  const yieldRate = Number(simSig.yieldRate);
  const queuePressure = String(introSig.queue_pressure || 'normal');
  const pressureTrit = queuePressure === 'critical' ? -1 : (queuePressure === 'high' ? -1 : 0);
  next.tags.autonomy_selector = {
    trit: deriveTritValue((Number.isFinite(yieldRate) && yieldRate >= 0.7 ? 1 : -1)),
    tag: Number.isFinite(yieldRate) && yieldRate >= 0.7 ? 'amplify' : 'suppress',
    reason: Number.isFinite(yieldRate) && yieldRate >= 0.7 ? 'yield_healthy' : 'yield_low',
    ttl_hours: 24
  };
  next.tags.risk_governor = {
    trit: deriveTritValue(Number.isFinite(drift) ? (drift <= 0.03 ? 1 : -1) : 0),
    tag: Number.isFinite(drift) && drift <= 0.03 ? 'amplify' : 'suppress',
    reason: Number.isFinite(drift) && drift <= 0.03 ? 'drift_healthy' : 'drift_elevated',
    ttl_hours: 24
  };
  next.tags.queue_scheduler = {
    trit: pressureTrit,
    tag: pressureTrit < 0 ? 'suppress' : 'neutral',
    reason: pressureTrit < 0 ? `queue_pressure_${queuePressure}` : 'queue_normal',
    ttl_hours: 12
  };
  return next;
}

function signPheromone(packet) {
  const body = JSON.stringify(packet);
  return crypto.createHash('sha256').update(`${SALT}|${body}`).digest('hex');
}

function generatePheromones(dateStr, introSig, runSig) {
  const packets = [];
  const base = {
    schema_id: 'fractal_pheromone',
    schema_version: '1.0.0',
    ts: nowIso(),
    date: dateStr,
    ttl_minutes: 30
  };
  if (String(introSig.queue_pressure || '') === 'critical') {
    packets.push({
      ...base,
      id: stableId(`${dateStr}|queue|critical`, 'ph'),
      lane: 'backpressure',
      intensity: 1,
      message: 'prioritize_critical_queue_drain'
    });
  }
  if (safeNumber(runSig.counts.policy_holds, 0) > 20) {
    packets.push({
      ...base,
      id: stableId(`${dateStr}|holds|high`, 'ph'),
      lane: 'governance',
      intensity: 0.8,
      message: 'tighten_admission_for_hold_patterns'
    });
  }
  if (safeNumber(runSig.counts.shipped, 0) > 0) {
    packets.push({
      ...base,
      id: stableId(`${dateStr}|shipped|signal`, 'ph'),
      lane: 'learning',
      intensity: 0.5,
      message: 'reinforce_recent_success_patterns'
    });
  }
  return packets.slice(0, 12).map((packet) => ({
    ...packet,
    signature: signPheromone(packet)
  }));
}

function harmonyScore(simSig, introSig, runSig) {
  let score = 0.5;
  const drift = Number(simSig.drift);
  const yieldRate = Number(simSig.yieldRate);
  if (Number.isFinite(drift) && drift <= 0.03) score += 0.2;
  else if (Number.isFinite(drift) && drift > 0.05) score -= 0.2;
  if (Number.isFinite(yieldRate) && yieldRate >= 0.7) score += 0.2;
  else if (Number.isFinite(yieldRate) && yieldRate < 0.6) score -= 0.15;
  if (String(introSig.queue_pressure || '') === 'normal') score += 0.08;
  else if (String(introSig.queue_pressure || '') === 'critical') score -= 0.15;
  if (safeNumber(runSig.counts.shipped, 0) > safeNumber(runSig.counts.no_change, 0)) score += 0.07;
  score = Math.max(0, Math.min(1, score));
  return {
    score: Number(score.toFixed(4)),
    band: score >= 0.75 ? 'high' : (score >= 0.5 ? 'steady' : 'low')
  };
}

function loadArchetypePool() {
  const payload = readJson(ARCHETYPE_POOL_PATH, null);
  if (!payload || typeof payload !== 'object') {
    return {
      schema_id: 'collective_archetype_pool',
      schema_version: '1.0.0',
      updated_at: null,
      archetypes: []
    };
  }
  return payload;
}

function updateArchetypes(pool, runSig) {
  const archetypes = Array.isArray(pool.archetypes) ? pool.archetypes.slice() : [];
  const push = (name, role, evidence, confidence) => {
    const id = stableId(`${name}|${role}`, 'arc');
    const idx = archetypes.findIndex((a) => String(a && a.id || '') === id);
    const row = {
      id,
      name,
      role,
      confidence: Number(Math.max(0.1, Math.min(0.99, confidence)).toFixed(3)),
      evidence: compact(evidence, 180),
      updated_at: nowIso(),
      decay_days: 21
    };
    if (idx >= 0) archetypes[idx] = { ...archetypes[idx], ...row };
    else archetypes.push(row);
  };

  if (safeNumber(runSig.counts.shipped, 0) > 0) {
    push(
      'execution_with_verification',
      'success',
      `shipped=${safeNumber(runSig.counts.shipped, 0)} executed=${safeNumber(runSig.counts.executed, 0)}`,
      0.72
    );
  }
  if (safeNumber(runSig.counts.policy_holds, 0) > 0) {
    push(
      'policy_hold_prevention',
      'failure_boundary',
      `policy_holds=${safeNumber(runSig.counts.policy_holds, 0)}`,
      0.68
    );
  }
  if (safeNumber(runSig.counts.no_change, 0) > 0) {
    push(
      'no_change_early_filter',
      'efficiency_boundary',
      `no_change=${safeNumber(runSig.counts.no_change, 0)}`,
      0.66
    );
  }
  return {
    ...pool,
    updated_at: nowIso(),
    archetypes: archetypes.slice(0, 80)
  };
}

function archetypeDeltaSummary(beforePool, afterPool) {
  const beforeRows = Array.isArray(beforePool && beforePool.archetypes) ? beforePool.archetypes : [];
  const afterRows = Array.isArray(afterPool && afterPool.archetypes) ? afterPool.archetypes : [];
  const beforeById = new Map(beforeRows.map((row) => [String(row && row.id || ''), row]));
  const newIds = [];
  const confidenceShifts = [];
  for (const row of afterRows) {
    const cur = row && typeof row === 'object' ? row : {};
    const id = String(cur && cur.id || '');
    if (!id) continue;
    const prev = beforeById.get(id);
    if (!prev) {
      newIds.push(id);
      continue;
    }
    const prevRow = prev && typeof prev === 'object' ? prev : {};
    const beforeConf = safeNumber((prevRow as any).confidence, NaN);
    const afterConf = safeNumber((cur as any).confidence, NaN);
    if (!Number.isFinite(beforeConf) || !Number.isFinite(afterConf)) continue;
    const delta = Number((afterConf - beforeConf).toFixed(4));
    if (Math.abs(delta) < ARCHETYPE_NOVELTY_CONFIDENCE_DELTA_MIN) continue;
    confidenceShifts.push({
      id,
      before: Number(beforeConf.toFixed(4)),
      after: Number(afterConf.toFixed(4)),
      delta
    });
  }
  const signals = newIds.length + confidenceShifts.length;
  return {
    new_count: newIds.length,
    confidence_shift_count: confidenceShifts.length,
    signal_count: signals,
    novelty_alert: signals > 0,
    threshold_confidence_delta: ARCHETYPE_NOVELTY_CONFIDENCE_DELTA_MIN,
    sample_new_ids: newIds.slice(0, 5),
    sample_confidence_shifts: confidenceShifts.slice(0, 5)
  };
}

function writeArchetypeAlert(dateStr, delta, context = {}) {
  if (!delta || delta.novelty_alert !== true) return;
  const row = {
    schema_id: 'fractal_archetype_novelty_alert',
    schema_version: '1.0.0',
    ts: nowIso(),
    date: dateStr,
    signal_count: Number(delta.signal_count || 0),
    new_count: Number(delta.new_count || 0),
    confidence_shift_count: Number(delta.confidence_shift_count || 0),
    threshold_confidence_delta: Number(delta.threshold_confidence_delta || 0),
    sample_new_ids: Array.isArray(delta.sample_new_ids) ? delta.sample_new_ids.slice(0, 5) : [],
    sample_confidence_shifts: Array.isArray(delta.sample_confidence_shifts) ? delta.sample_confidence_shifts.slice(0, 5) : [],
    context: context && typeof context === 'object' ? context : {}
  };
  appendJsonl(path.join(ALERTS_DIR, `${dateStr}.jsonl`), row);
}

function outputPath(dateStr) {
  return path.join(OUTPUT_DIR, `${dateStr}.json`);
}

function runCycle(dateStr) {
  const runSig = runSignals(dateStr);
  const simSig = simulationSignals(dateStr);
  const introSig = introspectionSignals(dateStr);

  const dream = dreamConsolidation(dateStr, runSig);
  const symbiosis = symbiosisPlan(introSig, runSig);
  const predatorPrey = predatorPreyModel(runSig, introSig);
  const epigeneticBefore = loadEpigeneticTags();
  const epigenetic = updateEpigeneticTags(epigeneticBefore, simSig, introSig);
  writeJson(EPIGENETIC_PATH, epigenetic);
  const pheromones = generatePheromones(dateStr, introSig, runSig);
  writeJson(path.join(PHEROMONE_DIR, `${dateStr}.json`), {
    ok: true,
    type: 'fractal_pheromone_batch',
    ts: nowIso(),
    date: dateStr,
    packets: pheromones
  });
  const harmony = harmonyScore(simSig, introSig, runSig);
  const archetypeBefore = loadArchetypePool();
  const archetypeAfter = updateArchetypes(archetypeBefore, runSig);
  writeJson(ARCHETYPE_POOL_PATH, archetypeAfter);
  const archetypeDelta = archetypeDeltaSummary(archetypeBefore, archetypeAfter);
  writeArchetypeAlert(dateStr, archetypeDelta, {
    run_counts: runSig && runSig.counts ? runSig.counts : {}
  });

  const payload = {
    ok: true,
    type: 'fractal_organism_cycle',
    ts: nowIso(),
    date: dateStr,
    proposal_only: true,
    dream_consolidation: dream,
    symbiosis_plans: symbiosis,
    predator_prey: predatorPrey,
    epigenetic_tags: {
      updated: Object.keys(epigenetic.tags || {}).length,
      path: path.relative(ROOT, EPIGENETIC_PATH).replace(/\\/g, '/')
    },
    pheromones: {
      count: pheromones.length,
      path: path.relative(ROOT, path.join(PHEROMONE_DIR, `${dateStr}.json`)).replace(/\\/g, '/')
    },
    resonance: harmony,
    archetype_pool: {
      count: Array.isArray(archetypeAfter.archetypes) ? archetypeAfter.archetypes.length : 0,
      path: path.relative(ROOT, ARCHETYPE_POOL_PATH).replace(/\\/g, '/')
    },
    archetype_delta: archetypeDelta,
    recommendations: [
      ...symbiosis.map((s) => `symbiosis:${s.objective}`),
      ...predatorPrey.candidates.map((c) => `predator_shadow:${c.module}`)
    ].slice(0, 12)
  };
  writeJson(outputPath(dateStr), payload);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: payload.type,
    date: dateStr,
    symbiosis_plans: symbiosis.length,
    predator_candidates: predatorPrey.candidates.length,
    pheromones: pheromones.length,
    harmony_score: harmony.score,
    archetypes: payload.archetype_pool.count,
    archetype_novelty_alert: archetypeDelta.novelty_alert === true,
    archetype_new: Number(archetypeDelta.new_count || 0),
    archetype_confidence_shifts: Number(archetypeDelta.confidence_shift_count || 0),
    output_path: path.relative(ROOT, outputPath(dateStr)).replace(/\\/g, '/')
  })}\n`);
}

function status(dateStr) {
  const payload = readJson(outputPath(dateStr), null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'fractal_organism_cycle_status',
      date: dateStr,
      error: 'cycle_not_found'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'fractal_organism_cycle_status',
    date: dateStr,
    symbiosis_plans: Array.isArray(payload.symbiosis_plans) ? payload.symbiosis_plans.length : 0,
    predator_candidates: payload.predator_prey && Array.isArray(payload.predator_prey.candidates)
      ? payload.predator_prey.candidates.length
      : 0,
    pheromones: payload.pheromones ? safeNumber(payload.pheromones.count, 0) : 0,
    harmony_score: payload.resonance ? safeNumber(payload.resonance.score, 0) : 0,
    archetypes: payload.archetype_pool ? safeNumber(payload.archetype_pool.count, 0) : 0,
    archetype_novelty_alert: payload.archetype_delta ? payload.archetype_delta.novelty_alert === true : false,
    archetype_new: payload.archetype_delta ? safeNumber(payload.archetype_delta.new_count, 0) : 0,
    archetype_confidence_shifts: payload.archetype_delta ? safeNumber(payload.archetype_delta.confidence_shift_count, 0) : 0
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  const dateStr = dateArgOrToday(args._[1]);
  if (cmd === 'run') {
    runCycle(dateStr);
    return;
  }
  if (cmd === 'status') {
    status(dateStr);
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}
