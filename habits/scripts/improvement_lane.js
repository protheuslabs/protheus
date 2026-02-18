#!/usr/bin/env node
/**
 * habits/scripts/improvement_lane.js — closed-loop improvement lane
 *
 * Habits-layer orchestrator over generic systems controllers:
 * - systems/autonomy/autonomy_controller.js (scorecard)
 * - systems/autonomy/improvement_controller.js (trial + evaluate + optional revert)
 *
 * Commands:
 *   node habits/scripts/improvement_lane.js propose [YYYY-MM-DD] [--days=N]
 *   node habits/scripts/improvement_lane.js queue
 *   node habits/scripts/improvement_lane.js start-next [YYYY-MM-DD] [--id=<lane_id>] --commit=<sha> [--trial-days=N] [--scorecard-days=N] [--auto-revert=1] [--dry-run]
 *   node habits/scripts/improvement_lane.js evaluate-open [YYYY-MM-DD] [--trial-id=<id>] [--id=<lane_id>] [--force=1] [--auto-revert=1] [--dry-run]
 *   node habits/scripts/improvement_lane.js run-daily [YYYY-MM-DD] [--commit=<sha>] [--auto-revert=1] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUTONOMY_CONTROLLER = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const IMPROVEMENT_CONTROLLER = path.join(REPO_ROOT, 'systems', 'autonomy', 'improvement_controller.js');

const IMPROVEMENT_DIR = path.join(REPO_ROOT, 'state', 'autonomy', 'improvements');
const LANE_QUEUE_PATH = path.join(IMPROVEMENT_DIR, 'lane_queue.json');
const LANE_EVENTS_PATH = path.join(IMPROVEMENT_DIR, 'lane_events.jsonl');

const DEFAULT_SCORECARD_DAYS = Number(process.env.IMPROVEMENT_LANE_SCORECARD_DAYS || 7);
const DEFAULT_TRIAL_DAYS = Number(process.env.IMPROVEMENT_LANE_TRIAL_DAYS || 3);

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function clampNumber(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureState() {
  ensureDir(IMPROVEMENT_DIR);
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function optValue(name, fallback = null) {
  const pref = `--${name}=`;
  const fromEq = process.argv.find(a => a.startsWith(pref));
  if (fromEq) return fromEq.slice(pref.length);

  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const nxt = process.argv[idx + 1];
    if (!String(nxt).startsWith('--')) return nxt;
    return '';
  }
  return fallback;
}

function optEnabled(name, fallback = false) {
  const v = optValue(name, null);
  if (v == null) return process.argv.includes(`--${name}`) ? true : fallback;
  if (v === '') return true;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function runNodeJsonLoose(absScript, args) {
  const r = spawnSync(process.execPath, [absScript, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  let json = null;
  if (stdout) {
    try { json = JSON.parse(stdout); } catch {}
  }
  return {
    ok: r.status === 0,
    code: r.status == null ? 1 : r.status,
    stdout,
    stderr,
    json
  };
}

function runNodeJsonStrict(absScript, args) {
  const res = runNodeJsonLoose(absScript, args);
  if (!res.ok || !res.json) {
    throw new Error(`node ${path.relative(REPO_ROOT, absScript)} failed: ${res.stderr || res.stdout || `exit_${res.code}`}`);
  }
  return res.json;
}

function runGit(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function resolveCommit(v) {
  const c = String(v || '').trim();
  if (c) return c;
  const r = runGit(['rev-parse', '--short', 'HEAD']);
  if (r.status !== 0) throw new Error(`git rev-parse failed: ${String(r.stderr || '').trim()}`);
  return String(r.stdout || '').trim();
}

function commitExists(commit) {
  const r = runGit(['cat-file', '-e', `${commit}^{commit}`]);
  return r.status === 0;
}

function queueStore() {
  const raw = loadJson(LANE_QUEUE_PATH, { items: [] });
  if (!raw || !Array.isArray(raw.items)) return { items: [] };
  return raw;
}

function saveQueueStore(store) {
  saveJson(LANE_QUEUE_PATH, store);
}

function nextLaneId(store) {
  return `lane_${Date.now()}_${String(store.items.length + 1).padStart(3, '0')}`;
}

function scorecard(dateStr, days) {
  return runNodeJsonStrict(AUTONOMY_CONTROLLER, ['scorecard', dateStr, `--days=${days}`]);
}

function improvementStatus() {
  const r = runNodeJsonLoose(IMPROVEMENT_CONTROLLER, ['status']);
  return r.json && r.json.ok === true ? r.json : { ok: false, running_trials: 0, total_trials: 0, selected: null, recent: [] };
}

function planForBottleneck(result, recommendation) {
  const r = String(result || 'unknown');
  const rec = String(recommendation || '');
  if (r === 'stop_repeat_gate_candidate_exhausted') {
    return {
      strategy: 'intake_precision',
      hypothesis: 'Improving intake precision will increase attempt_to_ship_rate and reduce no_progress_attempt_rate.',
      actions: [
        'Tighten habits-layer sensory filtering and actionability hints.',
        'Keep systems thresholds stable during this trial.',
        'Measure scorecard deltas over trial window.'
      ]
    };
  }
  if (r === 'stop_init_gate_quality_exhausted') {
    return {
      strategy: 'quality_floor_tuning',
      hypothesis: 'Raising upstream signal quality consistency will reduce quality-gate exhaustion.',
      actions: [
        'Improve source ranking and deterministic quality heuristics in habits.',
        'Avoid changing systems guardrails in the same trial.',
        'Measure impact on quality stop frequency and ship rate.'
      ]
    };
  }
  if (r === 'stop_init_gate_actionability_exhausted') {
    return {
      strategy: 'actionability_tuning',
      hypothesis: 'Generating clearer next-step commands and validation hints will increase executable candidates.',
      actions: [
        'Improve proposal action templates in habits/skills.',
        'Keep core autonomy gates unchanged for clean attribution.',
        'Measure actionability stop frequency and execution success.'
      ]
    };
  }
  if (r === 'stop_init_gate_directive_fit_exhausted') {
    return {
      strategy: 'directive_alignment_tuning',
      hypothesis: 'Better directive-fit extraction in intake will reduce alignment rejects without safety loss.',
      actions: [
        'Tune directive-fit token/phrase mapping in habits.',
        'Retain systems directive enforcement unchanged.',
        'Measure directive-fit stop frequency and no-progress rate.'
      ]
    };
  }
  return {
    strategy: 'general_bottleneck_reduction',
    hypothesis: 'Targeting the dominant bottleneck should improve shipped outcomes with bounded risk.',
    actions: [
      `Address dominant bottleneck: ${r}.`,
      `Use scorecard recommendation as secondary cue: ${rec || 'none'}.`,
      'Run fixed trial window and evaluate before promotion.'
    ]
  };
}

function findStartCandidate(store, laneId) {
  if (laneId) return store.items.find(x => x && x.id === laneId && x.status === 'proposed') || null;
  return store.items.find(x => x && x.status === 'proposed') || null;
}

function updateItem(store, item) {
  const idx = store.items.findIndex(x => x && x.id === item.id);
  if (idx < 0) store.items.push(item);
  else store.items[idx] = item;
}

function proposeCmd(dateStr) {
  const days = clampNumber(Number(optValue('days', DEFAULT_SCORECARD_DAYS)), 1, 30);
  const sc = scorecard(dateStr, days);
  const bottleneck = sc && sc.dominant_bottleneck && sc.dominant_bottleneck.result
    ? String(sc.dominant_bottleneck.result)
    : String((sc.top_stops && sc.top_stops[0] && sc.top_stops[0].result) || 'unknown');

  const store = queueStore();
  const existing = store.items.find(x =>
    x && x.status === 'proposed'
    && x.bottleneck === bottleneck
    && x.scorecard
    && x.scorecard.window_end === sc.window_end
  );
  if (existing) {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'already_proposed',
      lane_item: existing,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const plan = planForBottleneck(bottleneck, sc.recommendation);
  const item = {
    id: nextLaneId(store),
    created_ts: nowIso(),
    status: 'proposed',
    bottleneck,
    strategy: plan.strategy,
    hypothesis: plan.hypothesis,
    actions: plan.actions,
    mutation_scope: ['habits', 'skills', 'config'],
    scorecard: {
      date: sc.date,
      window_days: sc.window_days,
      window_start: sc.window_start,
      window_end: sc.window_end,
      recommendation: sc.recommendation,
      sample_size: sc.sample_size,
      kpis: sc.kpis
    },
    commit: null,
    trial_id: null,
    trial_status: null,
    note: String(optValue('note', '') || '').slice(0, 240)
  };

  store.items.push(item);
  saveQueueStore(store);
  appendJsonl(LANE_EVENTS_PATH, {
    ts: nowIso(),
    type: 'lane_proposed',
    lane_id: item.id,
    bottleneck: item.bottleneck,
    strategy: item.strategy
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'proposed',
    lane_item: item,
    ts: nowIso()
  }) + '\n');
}

function queueCmd() {
  const store = queueStore();
  const status = improvementStatus();
  const counts = { proposed: 0, started: 0, completed: 0 };
  for (const i of store.items) {
    if (!i || !i.status) continue;
    if (i.status === 'proposed') counts.proposed += 1;
    else if (i.status === 'started') counts.started += 1;
    else counts.completed += 1;
  }
  const next = store.items.find(x => x && x.status === 'proposed') || null;
  process.stdout.write(JSON.stringify({
    ok: true,
    queue_counts: counts,
    running_trials: Number(status.running_trials || 0),
    active_trial: status.selected && status.selected.status === 'running' ? status.selected : null,
    next_lane_item: next,
    recent_lane_items: store.items.slice(-5),
    ts: nowIso()
  }, null, 2) + '\n');
}

function startNextCmd(dateStr) {
  const store = queueStore();
  const laneId = String(optValue('id', '') || '').trim();
  const item = findStartCandidate(store, laneId);
  if (!item) {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'no_proposed_items',
      requested_id: laneId || null,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const commit = resolveCommit(optValue('commit', item.commit || ''));
  if (!commitExists(commit)) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `unknown_commit:${commit}`,
      lane_id: item.id,
      ts: nowIso()
    }) + '\n');
    process.exit(2);
  }

  const trialDays = clampNumber(Number(optValue('trial-days', DEFAULT_TRIAL_DAYS)), 1, 30);
  const scorecardDays = clampNumber(Number(optValue('scorecard-days', DEFAULT_SCORECARD_DAYS)), 1, 30);
  const autoRevert = optEnabled('auto-revert', false);
  const dryRun = optEnabled('dry-run', false);

  const args = [
    'start',
    dateStr,
    `--commit=${commit}`,
    `--trial-days=${trialDays}`,
    `--scorecard-days=${scorecardDays}`,
    `--auto-revert=${autoRevert ? 1 : 0}`,
    `--note=lane:${item.id}:${item.strategy}`
  ];

  if (dryRun) {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'dry_run',
      lane_id: item.id,
      command: `node systems/autonomy/improvement_controller.js ${args.join(' ')}`,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const r = runNodeJsonLoose(IMPROVEMENT_CONTROLLER, args);
  if (!r.ok || !r.json || r.json.ok !== true || r.json.result !== 'trial_started') {
    process.stdout.write(JSON.stringify({
      ok: false,
      result: 'trial_start_failed',
      lane_id: item.id,
      controller: r.json || { code: r.code, stdout: r.stdout, stderr: r.stderr },
      ts: nowIso()
    }) + '\n');
    process.exit(1);
  }

  item.status = 'started';
  item.commit = commit;
  item.started_ts = nowIso();
  item.trial_id = r.json.trial && r.json.trial.id ? String(r.json.trial.id) : null;
  item.trial_status = 'running';
  updateItem(store, item);
  saveQueueStore(store);
  appendJsonl(LANE_EVENTS_PATH, {
    ts: nowIso(),
    type: 'lane_started',
    lane_id: item.id,
    trial_id: item.trial_id,
    commit
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'started',
    lane_id: item.id,
    trial_id: item.trial_id,
    commit,
    controller: r.json,
    ts: nowIso()
  }) + '\n');
}

function evaluateOpenCmd(dateStr) {
  const store = queueStore();
  const laneId = String(optValue('id', '') || '').trim();
  const explicitTrialId = String(optValue('trial-id', '') || '').trim();
  const force = optEnabled('force', false);
  const autoRevert = optEnabled('auto-revert', false);
  const dryRun = optEnabled('dry-run', false);

  let targetTrialId = explicitTrialId || null;
  let laneItem = null;
  if (!targetTrialId) {
    if (laneId) {
      laneItem = store.items.find(x => x && x.id === laneId) || null;
      targetTrialId = laneItem && laneItem.trial_id ? String(laneItem.trial_id) : null;
    } else {
      laneItem = store.items.find(x => x && x.status === 'started' && x.trial_id) || null;
      targetTrialId = laneItem && laneItem.trial_id ? String(laneItem.trial_id) : null;
    }
  }
  if (!targetTrialId) {
    const st = improvementStatus();
    if (st && st.selected && st.selected.status === 'running') {
      targetTrialId = String(st.selected.id);
    }
  }

  if (!targetTrialId) {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'no_running_trial',
      ts: nowIso()
    }) + '\n');
    return;
  }

  const args = ['evaluate', dateStr, `--id=${targetTrialId}`];
  if (force) args.push('--force=1');
  if (autoRevert) args.push('--auto-revert=1');

  if (dryRun) {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'dry_run',
      trial_id: targetTrialId,
      command: `node systems/autonomy/improvement_controller.js ${args.join(' ')}`,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const r = runNodeJsonLoose(IMPROVEMENT_CONTROLLER, args);
  if (!r.json) {
    process.stdout.write(JSON.stringify({
      ok: false,
      result: 'trial_evaluate_failed',
      trial_id: targetTrialId,
      controller: { code: r.code, stdout: r.stdout, stderr: r.stderr },
      ts: nowIso()
    }) + '\n');
    process.exit(1);
  }

  const out = r.json;
  const ref = laneItem || store.items.find(x => x && x.trial_id === targetTrialId) || null;
  if (ref) {
    if (out.result === 'trial_evaluated') {
      ref.trial_status = out.status || 'unknown';
      ref.completed_ts = nowIso();
      ref.status = out.status === 'promoted' ? 'promoted'
        : out.status === 'reverted' ? 'reverted'
        : out.status === 'failed' ? 'failed'
        : out.status;
    } else if (out.result === 'trial_in_progress') {
      ref.trial_status = 'running';
    }
    ref.last_evaluation = {
      ts: nowIso(),
      result: out.result,
      status: out.status || null,
      reasons: out.reasons || []
    };
    updateItem(store, ref);
    saveQueueStore(store);
  }

  appendJsonl(LANE_EVENTS_PATH, {
    ts: nowIso(),
    type: 'lane_evaluated',
    lane_id: ref ? ref.id : null,
    trial_id: targetTrialId,
    result: out.result,
    status: out.status || null
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    result: out.result,
    lane_id: ref ? ref.id : null,
    trial_id: targetTrialId,
    controller: out,
    ts: nowIso()
  }) + '\n');
}

function runDailyCmd(dateStr) {
  const dryRun = optEnabled('dry-run', false);
  const actions = [];

  // 1) Evaluate running trial first.
  const evalArgs = ['evaluate-open', dateStr];
  if (optEnabled('auto-revert', false)) evalArgs.push('--auto-revert=1');
  if (dryRun) evalArgs.push('--dry-run');
  const evalRes = runNodeJsonLoose(path.join(REPO_ROOT, 'habits', 'scripts', 'improvement_lane.js'), evalArgs);
  actions.push({ step: 'evaluate-open', ok: evalRes.ok, output: evalRes.json || null });

  const status = improvementStatus();
  if (Number(status.running_trials || 0) > 0) {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'daily_done_running_trial_active',
      actions,
      ts: nowIso()
    }) + '\n');
    return;
  }

  // 2) Propose from latest bottleneck.
  const proposeArgs = ['propose', dateStr, `--days=${clampNumber(Number(optValue('days', DEFAULT_SCORECARD_DAYS)), 1, 30)}`];
  const proposeRes = runNodeJsonLoose(path.join(REPO_ROOT, 'habits', 'scripts', 'improvement_lane.js'), proposeArgs);
  actions.push({ step: 'propose', ok: proposeRes.ok, output: proposeRes.json || null });

  // 3) Start next if commit was supplied.
  const commit = String(optValue('commit', '') || '').trim();
  if (commit) {
    const startArgs = ['start-next', dateStr, `--commit=${commit}`];
    if (optEnabled('auto-revert', false)) startArgs.push('--auto-revert=1');
    if (dryRun) startArgs.push('--dry-run');
    const startRes = runNodeJsonLoose(path.join(REPO_ROOT, 'habits', 'scripts', 'improvement_lane.js'), startArgs);
    actions.push({ step: 'start-next', ok: startRes.ok, output: startRes.json || null });
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'daily_done',
    actions,
    ts: nowIso()
  }) + '\n');
}

function usage() {
  console.log('Usage:');
  console.log('  node habits/scripts/improvement_lane.js propose [YYYY-MM-DD] [--days=N]');
  console.log('  node habits/scripts/improvement_lane.js queue');
  console.log('  node habits/scripts/improvement_lane.js start-next [YYYY-MM-DD] [--id=<lane_id>] --commit=<sha> [--trial-days=N] [--scorecard-days=N] [--auto-revert=1] [--dry-run]');
  console.log('  node habits/scripts/improvement_lane.js evaluate-open [YYYY-MM-DD] [--trial-id=<id>] [--id=<lane_id>] [--force=1] [--auto-revert=1] [--dry-run]');
  console.log('  node habits/scripts/improvement_lane.js run-daily [YYYY-MM-DD] [--commit=<sha>] [--auto-revert=1] [--dry-run]');
}

function main() {
  ensureState();
  const cmd = process.argv[2] || '';
  const dateStr = isDateStr(process.argv[3]) ? process.argv[3] : todayStr();

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }

  if (cmd === 'propose') return proposeCmd(dateStr);
  if (cmd === 'queue') return queueCmd();
  if (cmd === 'start-next') return startNextCmd(dateStr);
  if (cmd === 'evaluate-open') return evaluateOpenCmd(dateStr);
  if (cmd === 'run-daily') return runDailyCmd(dateStr);

  usage();
  process.exit(2);
}

if (require.main === module) main();

module.exports = {
  planForBottleneck,
  nextLaneId
};

