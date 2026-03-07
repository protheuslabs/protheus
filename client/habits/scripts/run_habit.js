#!/usr/bin/env node
/**
 * run_habit.js v1.5 - Execute habits with trust verification, permission enforcement,
 * and neural plasticity (outcome tracking + promotion/demotion)
 * 
 * PROMOTION (candidate -> active): Requires ALL of:
 *   - Trusted (pinned sha256 exists)
 *   - lifetime_successes >= 3
 *   - avg outcome_score over last 3 runs >= 0.70
 *   - measured effect/savings meets min_effect_value (default >= 1)
 *   - zero permission violations in last 10 runs
 *   - doctor.js passes after last modification
 * 
 * DEMOTION (active -> disabled): ANY of:
 *   - consecutiveErrors >= 2
 *   - avg outcome_score over last 5 runs <= 0.40
 *   - hash mismatch detected
 *   - permission violation (PERMISSION_DENIED)
 *   - state destructive near-miss
 *   -> cooldown_minutes = 1440 (24h) by default
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { writeContractReceipt } = require('../../lib/action_receipts');
const {
  GLOBAL_BUDGET_DEFAULT_DIR,
  DEFAULT_EVENTS_PATH,
  DEFAULT_AUTOPAUSE_PATH,
  evaluateSystemBudgetGuard,
  loadSystemBudgetAutopauseState,
  writeSystemBudgetDecision,
  setSystemBudgetAutopause
} = require('../../systems/budget/system_budget.js');
const {
  readRegistryWithUids,
  writeRegistryWithUids
} = require('./habit_uid_store.js');

const REGISTRY_PATH = '/Users/jay/.openclaw/workspace/client/habits/registry.json';
const TRUSTED_HABITS_PATH = '/Users/jay/.openclaw/workspace/client/config/trusted_habits.json';
const RUNS_LOG = '/Users/jay/.openclaw/workspace/client/habits/client/logs/habit_runs.ndjson';
const ERRORS_LOG = '/Users/jay/.openclaw/workspace/client/habits/client/logs/habit_errors.ndjson';
const SNIPPET_DIR = '/Users/jay/.openclaw/workspace/memory';
const RECEIPTS_DIR = '/Users/jay/.openclaw/workspace/state/client/habits/receipts';
const HABIT_BUDGET_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.HABIT_BUDGET_ENABLED || '1').trim().toLowerCase());
const HABIT_BUDGET_MODULE = String(process.env.HABIT_BUDGET_MODULE || 'run_habit').trim() || 'run_habit';
const HABIT_BUDGET_STATE_DIR = process.env.HABIT_BUDGET_STATE_DIR
  ? path.resolve(process.env.HABIT_BUDGET_STATE_DIR)
  : GLOBAL_BUDGET_DEFAULT_DIR;
const HABIT_BUDGET_EVENTS_PATH = process.env.HABIT_BUDGET_EVENTS_PATH
  ? path.resolve(process.env.HABIT_BUDGET_EVENTS_PATH)
  : DEFAULT_EVENTS_PATH;
const HABIT_BUDGET_AUTOPAUSE_PATH = process.env.HABIT_BUDGET_AUTOPAUSE_PATH
  ? path.resolve(process.env.HABIT_BUDGET_AUTOPAUSE_PATH)
  : DEFAULT_AUTOPAUSE_PATH;
const HABIT_BUDGET_DEFAULT_TOKENS_EST = Number(process.env.HABIT_BUDGET_DEFAULT_TOKENS_EST || 240);

function computeHash(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex');
}

function computeHashBytes(filepath) {
  const content = fs.readFileSync(filepath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function truncate(s, max = 220) {
  const txt = String(s || '');
  return txt.length <= max ? txt : `${txt.slice(0, max)}...`;
}

function getArgValue(args, name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined ? fallback : v;
}

function parseRequestedTokens(args, inputs) {
  const cliRaw = getArgValue(args, '--tokens_est', getArgValue(args, '--tokens-est', null));
  const fromCli = Number(cliRaw);
  if (Number.isFinite(fromCli) && fromCli > 0) return Math.max(1, Math.min(12000, Math.round(fromCli)));
  const fromInputs = Number(inputs && (inputs.tokens_est || inputs.tokensEst || inputs.request_tokens_est));
  if (Number.isFinite(fromInputs) && fromInputs > 0) return Math.max(1, Math.min(12000, Math.round(fromInputs)));
  const fallback = Number(HABIT_BUDGET_DEFAULT_TOKENS_EST);
  return Number.isFinite(fallback) && fallback > 0
    ? Math.max(1, Math.min(12000, Math.round(fallback)))
    : 240;
}

function evaluateHabitBudgetGate({ habitId, requestTokens }) {
  if (!HABIT_BUDGET_ENABLED) {
    return { allow: true, reason: null, request_tokens_est: requestTokens };
  }
  const date = nowIso().slice(0, 10);
  const capability = `habit:${String(habitId || '').slice(0, 80) || 'unknown'}`;
  const opts = {
    state_dir: HABIT_BUDGET_STATE_DIR,
    events_path: HABIT_BUDGET_EVENTS_PATH,
    autopause_path: HABIT_BUDGET_AUTOPAUSE_PATH
  };
  const autopause = loadSystemBudgetAutopauseState(opts);
  if (autopause.active === true) {
    writeSystemBudgetDecision({
      date,
      module: HABIT_BUDGET_MODULE,
      capability,
      request_tokens_est: requestTokens,
      decision: 'deny',
      reason: 'budget_autopause_active'
    }, opts);
    return {
      allow: false,
      reason: 'budget_autopause_active',
      request_tokens_est: requestTokens
    };
  }

  const guard = evaluateSystemBudgetGuard({
    date,
    request_tokens_est: requestTokens,
    attempts_today: 1
  }, opts);
  if (guard.hard_stop === true) {
    const hardReason = String((guard.hard_stop_reasons && guard.hard_stop_reasons[0]) || 'budget_guard_hard_stop');
    writeSystemBudgetDecision({
      date,
      module: HABIT_BUDGET_MODULE,
      capability,
      request_tokens_est: requestTokens,
      decision: 'deny',
      reason: hardReason
    }, opts);
    setSystemBudgetAutopause({
      source: 'run_habit',
      reason: hardReason,
      pressure: 'hard',
      date,
      minutes: 60
    }, opts);
    return {
      allow: false,
      reason: hardReason,
      request_tokens_est: requestTokens
    };
  }

  writeSystemBudgetDecision({
    date,
    module: HABIT_BUDGET_MODULE,
    capability,
    request_tokens_est: requestTokens,
    decision: 'allow',
    reason: null
  }, opts);
  return {
    allow: true,
    reason: null,
    request_tokens_est: requestTokens
  };
}

function hashJson(v) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
  } catch {
    return null;
  }
}

function writeReceipt(record) {
  const ts = String(record && record.ts || nowIso());
  const day = /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : nowIso().slice(0, 10);
  const fp = path.join(RECEIPTS_DIR, `${day}.jsonl`);
  const verified =
    String(record && record.verdict || '').toLowerCase() === 'pass' &&
    !!(record && record.verification && record.verification.passed === true);
  writeContractReceipt(fp, record, { attempted: true, verified });
}

function verifyPostconditions(result, actions) {
  const writes = (actions || []).filter(a => a && a.type === 'write_file');
  const execs = (actions || []).filter(a => a && a.type === 'exec');
  const checks = [
    { name: 'result_status_success', pass: !!(result && result.status === 'success') },
    { name: 'write_postconditions', pass: writes.every(w => w.status === 'ok' && w.verified === true) },
    { name: 'exec_postconditions', pass: execs.every(e => e.status === 'ok') }
  ];
  const failed = checks.filter(c => !c.pass).map(c => c.name);
  return {
    checks,
    failed,
    passed: failed.length === 0,
    write_count: writes.length,
    exec_count: execs.length
  };
}

function loadRegistry() {
  return readRegistryWithUids(REGISTRY_PATH, { version: 1.5, habits: [] }, true);
}

function loadTrustedHabits() {
  if (!fs.existsSync(TRUSTED_HABITS_PATH)) {
    return { trusted_files: {} };
  }
  return JSON.parse(fs.readFileSync(TRUSTED_HABITS_PATH, 'utf8'));
}

function logRun(record) {
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(RUNS_LOG, line, 'utf8');
}

function logError(record) {
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(ERRORS_LOG, line, 'utf8');
}

function validateInputs(inputs, schema) {
  if (schema.required) {
    for (const req of schema.required) {
      if (!(req in inputs)) {
        throw new Error(`INPUT_VALIDATION_FAILED: Missing required field: ${req}`);
      }
    }
  }
  
  if (schema.properties) {
    for (const [key, val] of Object.entries(inputs)) {
      const propSchema = schema.properties[key];
      if (propSchema && propSchema.type) {
        const actualType = Array.isArray(val) ? 'array' : typeof val;
        if (actualType !== propSchema.type && !(propSchema.type === 'array' && Array.isArray(val))) {
          throw new Error(`INPUT_VALIDATION_FAILED: Field ${key} should be ${propSchema.type}, got ${actualType}`);
        }
      }
    }
  }
  
  return true;
}

function computeOutcomeScore(result, habit) {
  if (!result || result.status !== 'success') {
    return 0.0;
  }
  
  const violations = result.violations || {};
  const format = violations.format || 0;
  const bloat = violations.bloat || 0;
  const registry = violations.registry || 0;
  
  if (format === 0 && bloat === 0 && registry === 0) {
    return 1.0;
  }
  
  return Math.max(0, 1 - (format + bloat + registry) * 0.1);
}

function computeDeltaValue(durationMs, baseline) {
  if (!baseline || !baseline.avg_duration_ms || baseline.avg_duration_ms === 0) {
    return null;
  }
  return baseline.avg_duration_ms - durationMs;
}

function parseFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function updateRollingMetrics(habit, durationMs, success) {
  const metrics = habit.metrics || {};
  const rolling = metrics.rolling || { window_runs: [] };
  
  rolling.window_runs.push({
    duration_ms: durationMs,
    success: success,
    ts: Date.now()
  });
  
  if (rolling.window_runs.length > 20) {
    rolling.window_runs = rolling.window_runs.slice(-20);
  }
  
  if (rolling.window_runs.length > 0) {
    const durations = rolling.window_runs.map(r => r.duration_ms);
    rolling.avg_duration_ms_30d = durations.reduce((a, b) => a + b, 0) / durations.length;
    
    const successes = rolling.window_runs.filter(r => r.success).length;
    rolling.error_rate_30d = (rolling.window_runs.length - successes) / rolling.window_runs.length;
  }
  
  habit.metrics.rolling = rolling;
}

function getLastNOutcomeScores(habit, n) {
  const metrics = habit.metrics || {};
  const rolling = metrics.rolling || { window_runs: [] };
  
  // Get actual outcome scores from run log (last N runs for this habit)
  if (!fs.existsSync(RUNS_LOG)) return [];
  
  const content = fs.readFileSync(RUNS_LOG, 'utf8').trim();
  if (!content) return [];
  
  const runs = content.split('\n')
    .map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    })
    .filter(r => r && r.habit_id === habit.id && r.outcome_score !== undefined)
    .slice(-n);
  
  return runs.map(r => r.outcome_score);
}

/** Check permission violations in last 10 runs */
function getRecentPermissionViolations(habit) {
  if (!fs.existsSync(ERRORS_LOG)) return 0;
  
  const content = fs.readFileSync(ERRORS_LOG, 'utf8').trim();
  if (!content) return 0;
  
  const errors = content.split('\n')
    .map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    })
    .filter(e => e && e.habit_id === habit.id && e.ts)
    .slice(-10);
  
  const permissionErrors = errors.filter(e => 
    e.error && (e.error.includes('PERMISSION_DENIED') || e.error.includes('HASH_MISMATCH'))
  );
  
  return permissionErrors.length;
}

/** Run doctor check */
function doctorPasses(habit) {
  try {
    execSync('node /Users/jay/.openclaw/workspace/client/habits/scripts/doctor.js > /dev/null 2>&1', 
      { timeout: 30000 });
    return true;
  } catch (e) {
    return false;
  }
}

function checkPromotion(habit) {
  const gov = habit.governance || {};
  if (gov.state !== 'candidate') return null;
  const promote = gov.promote || {};
  const minSuccessRuns = parseFiniteNumber(promote.min_success_runs, 3);
  const minOutcomeScore = parseFiniteNumber(promote.min_outcome_score, 0.70);
  const minEffectValue = parseFiniteNumber(promote.min_effect_value, 1);
  const allowedEffectUnits = Array.isArray(promote.effect_units_allowlist)
    ? promote.effect_units_allowlist.map(v => String(v))
    : [];
  
  // Requirement 1: Trusted
  const trusted = loadTrustedHabits();
  const habitPath = path.resolve(habit.entrypoint);
  if (!trusted.trusted_files[habitPath]) {
    return { action: 'block', reason: 'not_trusted' };
  }
  
  // Requirement 2: >= min_success_runs successful runs
  const successes = Math.floor(habit.lifetime_uses * habit.success_rate);
  if (successes < minSuccessRuns) {
    return { action: 'wait', reason: `need_${minSuccessRuns}_successes (have ${successes})` };
  }
  
  // Requirement 3: Avg outcome score last 3 runs >= min_outcome_score
  const scores = getLastNOutcomeScores(habit, 3);
  if (scores.length >= 3) {
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avgScore < minOutcomeScore) {
      return { action: 'wait', reason: `avg_score_${avgScore.toFixed(2)}_below_${minOutcomeScore.toFixed(2)}` };
    }
  } else {
    return { action: 'wait', reason: `need_3_scores (have ${scores.length})` };
  }

  // Requirement 4: Measured effect/savings must pass threshold
  const effectValue = parseFiniteNumber(habit?.outcome?.last_delta_value, null);
  const effectUnit = String(habit?.outcome?.outcome_unit || '');
  if (effectValue === null) {
    return { action: 'wait', reason: 'need_measured_effect' };
  }
  if (effectValue < minEffectValue) {
    return { action: 'wait', reason: `effect_${effectValue.toFixed(2)}_below_${minEffectValue.toFixed(2)}` };
  }
  if (allowedEffectUnits.length > 0 && !allowedEffectUnits.includes(effectUnit)) {
    return { action: 'wait', reason: `effect_unit_${effectUnit || 'unknown'}_not_allowed` };
  }
  
  // Requirement 5: Zero permission violations in last 10 runs
  const permViolations = getRecentPermissionViolations(habit);
  if (permViolations > 0) {
    return { action: 'block', reason: `${permViolations}_permission_violations` };
  }
  
  // Requirement 6: doctor.js passes
  if (!doctorPasses(habit)) {
    return { action: 'block', reason: 'doctor_failed' };
  }
  
  return { action: 'promote', from: 'candidate', to: 'active' };
}

function checkDemotion(habit, error) {
  const gov = habit.governance || {};
  if (gov.state !== 'active') return null;
  
  const demote = gov.demote || { max_consecutive_errors: 2, min_outcome_score: 0.40 };
  
  // Trigger 1: Consecutive errors >= 2
  if (gov.consecutive_errors >= demote.max_consecutive_errors) {
    return { 
      action: 'demote', 
      from: 'active', 
      to: 'disabled', 
      reason: 'consecutive_errors',
      cooldown: 1440 
    };
  }
  
  // Trigger 2: Avg outcome score last 5 runs <= 0.40
  const scores = getLastNOutcomeScores(habit, 5);
  if (scores.length >= 3) {
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avgScore <= demote.min_outcome_score) {
      return { 
        action: 'demote', 
        from: 'active', 
        to: 'disabled', 
        reason: 'low_score',
        cooldown: 1440 
      };
    }
  }
  
  // Trigger 3: Permission violation
  if (error && (error.message.includes('PERMISSION_DENIED') || error.message.includes('HASH_MISMATCH'))) {
    return { 
      action: 'demote', 
      from: 'active', 
      to: 'disabled', 
      reason: 'security_violation',
      cooldown: 1440 
    };
  }
  
  return null;
}

function writeStateChangeSnip(data) {
  const now = new Date();
  const denverDate = now.toLocaleDateString('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const [m, d, y] = denverDate.split('/');
  const today = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  
  const snipFile = path.join(SNIPPET_DIR, `${today}.md`);
  
  const snipContent = `<!-- SNIP: habit-state-${data.habit_id}-${Date.now()} -->
**Habit State Change: ${data.habit_id}**
- Transition: ${data.previous_state} → ${data.new_state}
- Reason: ${data.reason}
- Stats: uses_30d=${data.uses_30d}, errors=${data.consecutiveErrors}, score=${data.avg_outcome_score?.toFixed(2) || 'N/A'}
- Safety: ${data.safety_notes.join('; ')}
`;
  
  if (fs.existsSync(snipFile)) {
    fs.appendFileSync(snipFile, snipContent, 'utf8');
  }
}

function verifyHabitOrThrow(habitId, habit, trusted) {
  const entrypoint = habit.entrypoint;
  const resolvedPath = path.resolve(entrypoint);
  
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`HABIT_FILE_NOT_FOUND: ${resolvedPath}`);
  }
  
  const trustedEntry = trusted.trusted_files[resolvedPath];
  if (!trustedEntry) {
    throw new Error(
      `HABIT_NOT_TRUSTED: ${resolvedPath} has no pinned hash. ` +
      `To approve: node client/habits/scripts/trust_add_habit.js ${entrypoint} "habit approval: ${habitId}"`
    );
  }
  
  const currentHash = computeHash(resolvedPath);
  if (currentHash !== trustedEntry.sha256) {
    throw new Error(
      `HABIT_HASH_MISMATCH: ${resolvedPath} has been modified. ` +
      `Expected: ${trustedEntry.sha256}, Got: ${currentHash}. ` +
      `Re-approve if intentional.`
    );
  }
  
  return { ok: true, hash: currentHash };
}

function createContext(habit, workspaceRoot, actionLog) {
  const permissions = habit.permissions || {};
  
  return {
    workspace_root: workspaceRoot,
    
    log: (msg, ...args) => {
      console.log(`[habit:${habit.id}]`, msg, ...args);
    },
    
    logRun: (data) => {
      logRun({
        ts: new Date().toISOString(),
        habit_id: habit.id,
        intent_key: habit.name || habit.id,
        inputs_hash: 'validated',
        status: data.status || 'unknown',
        duration_ms: data.duration_ms || 0,
        tokens_in_est: null,
        tokens_out_est: null,
        estimated_tokens_saved: habit.estimated_tokens_saved || 0,
        outcome_score: data.outcome_score !== undefined ? data.outcome_score : null,
        delta_value: data.delta_value !== undefined ? data.delta_value : null,
        outcome_unit: data.outcome_unit || null,
        summary: data.summary || {},
        violations: data.violations || {}
      });
    },
    
    safeWriteFile: (filePath, contents) => {
      const started = Date.now();
      const resolved = path.resolve(filePath);
      const allowlist = permissions.write_paths_allowlist || [];
      
      let allowed = false;
      for (const pattern of allowlist) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        if (regex.test(resolved)) {
          allowed = true;
          break;
        }
      }
      
      if (!allowed) {
        throw new Error(`PERMISSION_DENIED: Write to ${resolved} not in allowlist`);
      }

      const beforeExists = fs.existsSync(resolved);
      const beforeHash = beforeExists ? computeHashBytes(resolved) : null;
      const payload = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
      const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');

      fs.writeFileSync(resolved, payload);

      const afterExists = fs.existsSync(resolved);
      const afterHash = afterExists ? computeHashBytes(resolved) : null;
      const verified = afterExists && afterHash === expectedHash;
      actionLog.push({
        ts: nowIso(),
        type: 'write_file',
        path: resolved,
        status: 'ok',
        duration_ms: Date.now() - started,
        before_exists: beforeExists,
        before_hash: beforeHash,
        after_hash: afterHash,
        expected_hash: expectedHash,
        bytes_written: payload.length,
        verified
      });

      if (!verified) {
        throw new Error(`POSTCONDITION_FAILED: write hash mismatch for ${resolved}`);
      }
    },
    
    safeExec: (cmd) => {
      const started = Date.now();
      const allowlist = permissions.exec_allowlist || [];
      
      let allowed = false;
      for (const pattern of allowlist) {
        if (cmd.startsWith(pattern) || cmd === pattern) {
          allowed = true;
          break;
        }
      }
      
      if (!allowed) {
        throw new Error(`PERMISSION_DENIED: Exec '${cmd}' not in allowlist`);
      }
      
      if (permissions.network === 'deny') {
        const networkPatterns = ['curl', 'wget', 'http', 'https://', 'fetch'];
        for (const pattern of networkPatterns) {
          if (cmd.includes(pattern)) {
            throw new Error(`PERMISSION_DENIED: Network access denied for habit (network: deny)`);
          }
        }
      }

      try {
        const out = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
        actionLog.push({
          ts: nowIso(),
          type: 'exec',
          cmd: String(cmd),
          status: 'ok',
          duration_ms: Date.now() - started,
          output_len: String(out || '').length,
          output_hash: hashJson(String(out || ''))
        });
        return out;
      } catch (err) {
        actionLog.push({
          ts: nowIso(),
          type: 'exec',
          cmd: String(cmd),
          status: 'error',
          duration_ms: Date.now() - started,
          error: truncate(err && err.message ? err.message : String(err))
        });
        throw err;
      }
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const forceFlag = args.includes('--force');
  
  if (args.includes('--list') || args.includes('-l')) {
    const registry = loadRegistry();
    console.log('═══════════════════════════════════════════════════════════');
    console.log('               HABIT REGISTRY v1.5 (PLASTICITY)');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Max: ${registry.max_active} | GC: ${registry.gc.inactive_days}d inactive`);
    console.log('');
    
    for (const habit of registry.habits) {
      const gov = habit.governance || {};
      const state = gov.state || 'active';
      const pinned = gov.pinned ? ' [PINNED]' : '';
      
      console.log(`${habit.id} [${state.toUpperCase()}${pinned}]`);
      console.log(`  Name: ${habit.name}`);
      console.log(`  Uses: ${habit.lifetime_uses} total, ${habit.uses_30d} last 30d`);
      console.log(`  Success: ${(habit.success_rate * 100).toFixed(0)}%`);
      if (habit.outcome?.last_outcome_score !== null) {
        console.log(`  Last score: ${habit.outcome.last_outcome_score.toFixed(2)}`);
      }
      if (gov.consecutive_errors > 0) {
        console.log(`  ⚠️  Consecutive errors: ${gov.consecutive_errors}`);
      }
      if (state === 'disabled' && gov.demote?.cooldown_minutes > 0) {
        console.log(`  ⏱️  Cooldown: ${gov.demote.cooldown_minutes} min`);
      }
      console.log('');
    }
    return;
  }
  
  const idIndex = args.indexOf('--id');
  if (idIndex === -1 || !args[idIndex + 1]) {
    console.error('Usage: node run_habit.js --list');
    console.error('       node run_habit.js --id <habit_id> --json \'<inputs>\' [--force] [--tokens_est <n>]');
    process.exit(1);
  }
  
  const habitId = args[idIndex + 1];
  const jsonIndex = args.indexOf('--json');
  const inputsJson = jsonIndex !== -1 && args[jsonIndex + 1] ? args[jsonIndex + 1] : '{}';
  
  let inputs;
  try {
    inputs = JSON.parse(inputsJson);
  } catch (err) {
    console.error('ERROR: Invalid JSON inputs:', err.message);
    process.exit(1);
  }

  const requestTokensEst = parseRequestedTokens(args, inputs);
  const budgetGate = evaluateHabitBudgetGate({
    habitId,
    requestTokens: requestTokensEst
  });
  if (budgetGate.allow !== true) {
    console.error(`ERROR: Habit execution blocked by budget guard: ${budgetGate.reason}`);
    process.exit(1);
  }
  
  const registry = loadRegistry();
  const habit = registry.habits.find(h => h.id === habitId);
  
  if (!habit) {
    console.error(`ERROR: Habit not found: ${habitId}`);
    process.exit(1);
  }
  
  const gov = habit.governance || {};
  const govState = gov.state || 'active';
  const runId = `habit_${Date.now()}_${habitId}`;
  const startedIso = nowIso();
  const actionLog = [];
  const baseReceipt = {
    ts: startedIso,
    type: 'habit_action_receipt',
    run_id: runId,
    habit_id: habitId,
    state_at_start: govState,
    entrypoint: habit.entrypoint,
    intent: {
      input_keys: Object.keys(inputs || {}).sort(),
      inputs_hash: hashJson(inputs)
    }
  };
  
  // Check state restrictions
  if (govState === 'candidate') {
    console.log(`ℹ️  Habit ${habitId} is candidate (unpromoted). Will attempt run but won't auto-execute.`);
  }
  
  if (govState === 'disabled') {
    const cooldown = gov.demote?.cooldown_minutes || 0;
    if (cooldown > 0 && !forceFlag) {
      const lastUsed = new Date(habit.last_used_at || 0);
      const minutesSince = (Date.now() - lastUsed.getTime()) / (1000 * 60);
      if (minutesSince < cooldown) {
        console.error(`ERROR: Habit ${habitId} is disabled (cooldown: ${Math.ceil(cooldown - minutesSince)} min remaining)`);
        console.error(`Use --force to override (not recommended)`);
        process.exit(1);
      }
    } else if (!forceFlag) {
      console.error(`ERROR: Habit ${habitId} is disabled. Use --force to override.`);
      process.exit(1);
    } else {
      console.log(`⚠️  Force-running disabled habit ${habitId}`);
    }
  }
  
  if (govState === 'archived') {
    console.error(`ERROR: Habit ${habitId} is archived`);
    process.exit(1);
  }
  
  try {
    validateInputs(inputs, habit.inputs_schema);
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
  
  const trusted = loadTrustedHabits();
  try {
    verifyHabitOrThrow(habitId, habit, trusted);
    console.log(`✅ Trust verified: ${habit.entrypoint}`);
  } catch (err) {
    console.error('╔════════════════════════════════════════════════════════════╗');
    console.error('║              HABIT EXECUTION BLOCKED                         ║');
    console.error('╚════════════════════════════════════════════════════════════╝');
    console.error(`Reason: ${err.message}`);
    
    // If hash mismatch on active habit, demote
    if (err.message.includes('HASH_MISMATCH') && govState === 'active') {
      habit.governance.state = 'disabled';
      habit.status = 'disabled';
      habit.governance.consecutive_errors = 2;
      habit.governance.demote = habit.governance.demote || {};
      habit.governance.demote.cooldown_minutes = 1440;
      
      writeStateChangeSnip({
        habit_id: habitId,
        previous_state: 'active',
        new_state: 'disabled',
        reason: 'HASH_MISMATCH_DETECTED - security violation',
        uses_30d: habit.uses_30d,
        consecutiveErrors: 2,
        avg_outcome_score: habit.outcome?.last_outcome_score,
        safety_notes: ['Automatic demotion due to supply-chain safety', 'Requires manual review and re-trust']
      });
      
      writeRegistryWithUids(REGISTRY_PATH, registry);
      console.error('\n⚠️  DEMOTED: active → disabled (hash mismatch)');
    }

    writeReceipt({
      ...baseReceipt,
      completed_ts: nowIso(),
      duration_ms: Date.now() - new Date(startedIso).getTime(),
      execution: {
        trust_verified: false,
        actions: []
      },
      verification: {
        checks: [{ name: 'trust_verified', pass: false }],
        failed: ['trust_verified'],
        passed: false
      },
      verdict: 'blocked',
      error: truncate(err && err.message ? err.message : String(err))
    });

    process.exit(1);
  }
  
  const workspaceRoot = '/Users/jay/.openclaw/workspace';
  const ctx = createContext(habit, workspaceRoot, actionLog);
  
  console.log(`Running habit: ${habitId} [state: ${govState}]`);
  console.log(`Inputs: ${JSON.stringify(inputs)}`);
  console.log('');
  
  const startTime = Date.now();
  let result;
  let error = null;
  
  try {
    const habitModule = require(path.resolve(habit.entrypoint));
    result = await habitModule.run(inputs, ctx);
    
    const duration = Date.now() - startTime;
    const verification = verifyPostconditions(result, actionLog);
    if (!verification.passed) {
      throw new Error(`POSTCONDITION_FAILED: ${verification.failed.join(', ')}`);
    }
    const outcomeScore = computeOutcomeScore(result, habit);
    let deltaValue = computeDeltaValue(duration, habit.metrics?.baseline);
    let outcomeUnit = deltaValue !== null ? 'ms_saved' : null;
    if (deltaValue === null) {
      const reportedTokensSaved = parseFiniteNumber(result?.tokens_saved, null);
      const reportedDeltaValue = parseFiniteNumber(result?.delta_value, null);
      if (reportedTokensSaved !== null) {
        deltaValue = reportedTokensSaved;
        outcomeUnit = 'tokens_saved';
      } else if (reportedDeltaValue !== null) {
        deltaValue = reportedDeltaValue;
        outcomeUnit = String(result?.outcome_unit || 'reported_delta').slice(0, 64);
      }
    }
    
    habit.outcome = {
      last_outcome_score: outcomeScore,
      last_delta_value: deltaValue,
      outcome_unit: outcomeUnit
    };
    
    updateRollingMetrics(habit, duration, true);
    
    // Reset consecutive errors on success
    habit.governance.consecutive_errors = 0;
    
    // Update basic stats
    habit.last_used_at = new Date().toISOString();
    habit.uses_30d += 1;
    habit.lifetime_uses += 1;
    habit.success_rate = ((habit.lifetime_uses * habit.success_rate) + 1) / (habit.lifetime_uses + 1);
    
    // Check promotion
    const promo = checkPromotion(habit);
    if (promo && promo.action === 'promote') {
      const oldState = govState;
      habit.governance.state = 'active';
      habit.status = 'active';
      
      writeStateChangeSnip({
        habit_id: habitId,
        previous_state: oldState,
        new_state: 'active',
        reason: 'PROMOTION: trusted(✓) + min_success_runs(✓) + min_outcome_score(✓) + measured_effect(✓) + 0_violations(✓) + doctor_passed(✓)',
        uses_30d: habit.uses_30d,
        consecutiveErrors: 0,
        avg_outcome_score: habit.outcome?.last_outcome_score,
        safety_notes: ['Auto-promoted to active', 'Ready for automatic execution']
      });
      
      console.log(`\n🎉 PROMOTED: ${habitId} candidate → active`);
    }
    
    writeRegistryWithUids(REGISTRY_PATH, registry);
    
    ctx.logRun({
      status: 'success',
      duration_ms: duration,
      outcome_score: outcomeScore,
      delta_value: deltaValue,
      outcome_unit: outcomeUnit,
      summary: result?.summary || {},
      violations: result?.violations || {}
    });
    
    console.log('');
    console.log('✅ Habit completed successfully');
    console.log(`Outcome score: ${outcomeScore?.toFixed(2) || 'N/A'}`);
    if (promo && promo.action === 'wait') {
      console.log(`⏳ Promotion pending: ${promo.reason}`);
    }
    console.log('Result:', JSON.stringify(result, null, 2));

    writeReceipt({
      ...baseReceipt,
      completed_ts: nowIso(),
      duration_ms: duration,
      execution: {
        trust_verified: true,
        actions: actionLog
      },
      verification: verification,
      verdict: 'pass',
      result_status: String(result && result.status || 'unknown'),
      outcome_score: outcomeScore,
      delta_value: deltaValue,
      outcome_unit: outcomeUnit
    });
    
  } catch (err) {
    error = err;
    const duration = Date.now() - startTime;
    
    // Update failure stats
    habit.last_used_at = new Date().toISOString();
    habit.lifetime_uses += 1;
    habit.success_rate = (habit.lifetime_uses * habit.success_rate) / (habit.lifetime_uses + 1);
    habit.governance.consecutive_errors = (habit.governance.consecutive_errors || 0) + 1;
    
    updateRollingMetrics(habit, duration, false);
    
    // Check demotion
    const demotion = checkDemotion(habit, err);
    if (demotion && demotion.action === 'demote') {
      const oldState = habit.governance.state || 'active';
      habit.governance.state = 'disabled';
      habit.status = 'disabled';
      habit.governance.demote = habit.governance.demote || {};
      habit.governance.demote.cooldown_minutes = demotion.cooldown || 1440;
      
      writeStateChangeSnip({
        habit_id: habitId,
        previous_state: oldState,
        new_state: 'disabled',
        reason: `DEMOTION: ${demotion.reason}`,
        uses_30d: habit.uses_30d,
        consecutiveErrors: habit.governance.consecutive_errors,
        avg_outcome_score: habit.outcome?.last_outcome_score,
        safety_notes: ['Automatic demotion', `Cooldown: ${demotion.cooldown || 1440} min`, 'Requires manual review to re-enable']
      });
      
      console.log(`\n⚠️  DEMOTED: ${habitId} ${oldState} → disabled (${demotion.reason}, cooldown: ${demotion.cooldown || 1440}min)`);
    }
    
    writeRegistryWithUids(REGISTRY_PATH, registry);
    
    logError({
      ts: new Date().toISOString(),
      habit_id: habitId,
      intent_key: habit.name || habit.id,
      error: err.message,
      stack: err.stack
    });

    writeReceipt({
      ...baseReceipt,
      completed_ts: nowIso(),
      duration_ms: duration,
      execution: {
        trust_verified: true,
        actions: actionLog
      },
      verification: {
        checks: [
          { name: 'result_or_postcondition', pass: false }
        ],
        failed: ['result_or_postcondition'],
        passed: false
      },
      verdict: 'fail',
      error: truncate(err && err.message ? err.message : String(err))
    });
    
    console.error('');
    console.error('❌ Habit failed:', err.message);
    process.exit(1);
  }
}

main();
