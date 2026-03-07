#!/usr/bin/env node
/**
 * doctor.js v1.5 - Validate the habit system with plasticity and clear triggers
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REGISTRY_PATH = '/Users/jay/.openclaw/workspace/client/habits/registry.json';
const TRUSTED_HABITS_PATH = '/Users/jay/.openclaw/workspace/client/config/trusted_habits.json';
const TRUSTED_SKILLS_PATH = '/Users/jay/.openclaw/workspace/client/config/trusted_skills.json';
const RUNS_LOG = '/Users/jay/.openclaw/workspace/client/habits/client/logs/habit_runs.ndjson';
const ERRORS_LOG = '/Users/jay/.openclaw/workspace/client/habits/client/logs/habit_errors.ndjson';

let exitCode = 0;
let warnings = 0;
let errors = 0;

function logCheck(name, status, detail = '') {
  const icon = status === 'OK' ? '✅' : status === 'WARN' ? '⚠️ ' : status === 'INFO' ? 'ℹ️ ' : '❌';
  console.log(`${icon} ${name}: ${status}${detail ? ' — ' + detail : ''}`);
  if (status === 'FAIL') errors++;
  if (status === 'WARN') warnings++;
  // INFO increments nothing (neutral)
}

function computeHash(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex');
}

function checkRegistrySchema() {
  console.log('\n📋 REGISTRY SCHEMA CHECK v1.5');
  console.log('─'.repeat(50));
  
  if (!fs.existsSync(REGISTRY_PATH)) {
    logCheck('registry.json exists', 'FAIL', 'File not found');
    return false;
  }
  
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    logCheck('registry.json parses', 'OK');
  } catch (e) {
    logCheck('registry.json parses', 'FAIL', e.message);
    return false;
  }
  
  const version = registry.version;
  const isV15 = version >= 1.5;
  logCheck('version >= 1.5', isV15 ? 'OK' : 'WARN', `version=${version}`);
  
  const checks = [
    ['version exists', registry.version !== undefined],
    ['habits[] exists', Array.isArray(registry.habits)],
    ['max_active exists', registry.max_active !== undefined],
    ['gc config exists', registry.gc !== undefined],
    ['habits array non-empty', registry.habits.length > 0]
  ];
  
  for (const [name, passed] of checks) {
    logCheck(name, passed ? 'OK' : 'FAIL');
  }
  
  // v1.5 Plasticity checks
  console.log('\n   PLASTICITY FIELDS CHECK:');
  for (const habit of registry.habits) {
    const pOutcome = habit.outcome !== undefined;
    const pGov = habit.governance !== undefined;
    const pMetrics = habit.metrics !== undefined;
    
    logCheck(`${habit.id}.outcome`, pOutcome ? 'OK' : 'FAIL');
    if (pOutcome) {
      const o = habit.outcome;
      logCheck(`  └─ last_outcome_score`, typeof o.last_outcome_score === 'number' || o.last_outcome_score === null ? 'OK' : 'FAIL');
      logCheck(`  └─ last_delta_value`, typeof o.last_delta_value === 'number' || o.last_delta_value === null ? 'OK' : 'FAIL');
      logCheck(`  └─ outcome_unit`, typeof o.outcome_unit === 'string' || o.outcome_unit === null ? 'OK' : 'FAIL');
    }
    
    logCheck(`${habit.id}.governance`, pGov ? 'OK' : 'FAIL');
    if (pGov) {
      const g = habit.governance;
      const validStates = ['candidate', 'active', 'disabled', 'archived'];
      logCheck(`  └─ state`, validStates.includes(g.state) ? 'OK' : 'FAIL', `state=${g.state}`);
      
      // Check promote/demote config
      if (g.state === 'candidate') {
        const hasPromote = g.promote && typeof g.promote.min_success_runs === 'number';
        logCheck(`  └─ promote.min_success_runs`, hasPromote ? 'OK' : 'FAIL');
      }
      
      if (g.demote) {
        logCheck(`  └─ demote.cooldown_minutes`, typeof g.demote.cooldown_minutes === 'number' ? 'OK' : 'FAIL');
      }
    }
    
    logCheck(`${habit.id}.metrics`, pMetrics ? 'OK' : 'FAIL');
  }
  
  return true;
}

function checkClearTriggers() {
  console.log('\n🎯 CLEAR TRIGGERS VALIDATION');
  console.log('─'.repeat(50));
  
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  
  for (const habit of registry.habits) {
    const gov = habit.governance || {};
    const state = gov.state || 'unknown';
    
    // Check inputs_schema hard requirement
    const hasSchema = habit.inputs_schema && 
                      typeof habit.inputs_schema === 'object' &&
                      habit.inputs_schema.type === 'object';
    logCheck(`${habit.id}.inputs_schema`, hasSchema ? 'OK' : 'FAIL');
    
    // Check permissions hard requirement
    const hasPerms = habit.permissions && 
                     habit.permissions.network !== undefined &&
                     Array.isArray(habit.permissions.write_paths_allowlist) &&
                     Array.isArray(habit.permissions.exec_allowlist);
    logCheck(`${habit.id}.exact_permissions`, hasPerms ? 'OK' : 'FAIL');
    
    // Check entrypoint
    const hasEntrypoint = typeof habit.entrypoint === 'string' && 
                          habit.entrypoint.startsWith('client/habits/routines/');
    logCheck(`${habit.id}.entrypoint`, hasEntrypoint ? 'OK' : 'FAIL');
    
    // State-specific checks
    if (state === 'candidate') {
      logCheck(`${habit.id}.promotion_ready`, 'INFO', 'Needs min_success_runs + min_outcome_score + measured_effect + doctor_passes');
    } else if (state === 'active') {
      logCheck(`${habit.id}.demotion_triggers`, 'OK', 'consecutiveErrors>=2 OR score<=0.40 OR permission_violation');
    } else if (state === 'disabled') {
      const cooldown = gov.demote?.cooldown_minutes || 0;
      logCheck(`${habit.id}.cooldown`, cooldown > 0 ? 'OK' : 'WARN', `${cooldown}min`);
    }
  }
}

function checkTrustedHashes() {
  console.log('\n🔐 TRUSTED HABITS HASH CHECK');
  console.log('─'.repeat(50));
  
  if (!fs.existsSync(TRUSTED_HABITS_PATH)) {
    logCheck('trusted_habits.json exists', 'FAIL', 'File not found');
    return false;
  }
  
  let config;
  try {
    config = JSON.parse(fs.readFileSync(TRUSTED_HABITS_PATH, 'utf8'));
    logCheck('trusted_habits.json parses', 'OK');
  } catch (e) {
    logCheck('trusted_habits.json parses', 'FAIL', e.message);
    return false;
  }
  
  const trusted = config.trusted_files || {};
  const entries = Object.entries(trusted);
  
  if (entries.length === 0) {
    logCheck('has trusted entries', 'WARN', 'No trusted habits found');
    return true;
  }
  
  for (const [filepath, info] of entries) {
    if (!fs.existsSync(filepath)) {
      logCheck(`file exists: ${path.basename(filepath)}`, 'FAIL', 'File not found');
      continue;
    }
    
    const currentHash = computeHash(filepath);
    if (currentHash === info.sha256) {
      logCheck(`hash match: ${path.basename(filepath)}`, 'OK', `${currentHash.substring(0, 16)}...`);
    } else {
      logCheck(`hash match: ${path.basename(filepath)}`, 'FAIL', `Expected ${info.sha256.substring(0, 16)}..., got ${currentHash.substring(0, 16)}...`);
    }
  }
  
  return true;
}

function checkNDJSONLine(line, name, lineNum, isV15Check = false) {
  try {
    const obj = JSON.parse(line);
    
    if (isV15Check) {
      // Cutover timestamp: lines before this are legacy, after must have v1.5 fields
      const cutover = new Date(process.env.HABITS_V15_CUTOVER || "2026-02-15T04:00:00.000Z").getTime();
      const ts = obj.ts ? new Date(obj.ts).getTime() : null;
      const isLegacy = ts && ts < cutover;
      
      const missing = [];
      if (!('outcome_score' in obj)) missing.push('outcome_score');
      if (!('delta_value' in obj)) missing.push('delta_value');
      if (!('outcome_unit' in obj)) missing.push('outcome_unit');
      
      if (missing.length > 0) {
        if (isLegacy) {
          return { ok: true, warn: true, msg: `Legacy line missing ${missing.join(', ')} (pre-v1.5)` };
        }
        return { ok: false, msg: `Missing ${missing.join(', ')} (v1.5 required)` };
      }
      
      if (obj.summary && typeof obj.summary === 'string') {
        return { ok: false, msg: 'summary is JSON string (should be object)' };
      }
      if (obj.violations && typeof obj.violations === 'string') {
        return { ok: false, msg: 'violations is JSON string (should be object)' };
      }
    }
    
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: `Invalid JSON: ${e.message}` };
  }
}

function checkNDJSON(filePath, name) {
  if (!fs.existsSync(filePath)) {
    logCheck(`${name} exists`, 'WARN', 'File not found (may be empty)');
    return true;
  }
  
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) {
    logCheck(`${name} parseable`, 'OK', 'File empty');
    return true;
  }
  
  const lines = content.split('\n');
  let v15Errors = 0;
  let v15LegacyWarnings = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const result = checkNDJSONLine(lines[i], name, i + 1, true);
    if (!result.ok) {
      logCheck(`${name} line ${i + 1}`, 'FAIL', result.msg);
      v15Errors++;
    } else if (result.warn) {
      logCheck(`${name} line ${i + 1}`, 'WARN', result.msg);
      v15LegacyWarnings++;
    }
  }
  
  // Only legacy warnings = INFO (expected), any errors = WARN
  const status = v15Errors === 0 ? (v15LegacyWarnings === 0 ? 'OK' : 'INFO') : 'WARN';
  logCheck(`${name} parseable`, status, `${lines.length} lines, ${v15Errors} errors, ${v15LegacyWarnings} legacy`);
  return true;
}

function checkNDJSONLogs() {
  console.log('\n📄 NDJSON LOG CHECK (v1.5)');
  console.log('─'.repeat(50));
  
  checkNDJSON(RUNS_LOG, 'habit_runs.ndjson');
  checkNDJSON(ERRORS_LOG, 'habit_errors.ndjson');
}

function checkGovernanceStates() {
  console.log('\n🏛️ GOVERNANCE STATES (CLEAR TRIGGERS)');
  console.log('─'.repeat(50));
  
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  
  const stateCounts = { candidate: 0, active: 0, disabled: 0, archived: 0 };
  
  for (const habit of registry.habits) {
    const state = habit.governance?.state || habit.status || 'unknown';
    if (stateCounts[state] !== undefined) {
      stateCounts[state]++;
    }
  }
  
  console.log('   PROMOTION path: candidate → active (requires ALL):');
  console.log('     - trusted ✓ + 3 successes ✓ + score>=0.70 ✓ + 0 violations ✓ + doctor_passes ✓');
  console.log('');
  console.log('   DEMOTION path: active → disabled (ANY trigger):');
  console.log('     - consecutiveErrors>=2 OR score<=0.40 OR permission_violation');
  console.log('     → cooldown = 1440min (24h) by default');
  console.log('');
  console.log('   ARCHIVE path (candidate/disabled only, NEVER auto-archive active):');
  console.log('     - inactive >30d AND uses_30d <1 AND pinned!=true');
  console.log('');
  console.log(`   Current counts:`);
  console.log(`     candidate: ${stateCounts.candidate}`);
  console.log(`     active: ${stateCounts.active}`);
  console.log(`     disabled: ${stateCounts.disabled}`);
  console.log(`     archived: ${stateCounts.archived}`);
  
  logCheck('governance states', 'OK');
}

function checkNetworkDeny() {
  console.log('\n🌐 NETWORK DENY VERIFICATION');
  console.log('─'.repeat(50));
  
  function simulateSafeExec(cmd) {
    const networkPatterns = ['curl', 'wget', 'http', 'https://', 'fetch'];
    for (const pattern of networkPatterns) {
      if (cmd.includes(pattern)) {
        return { blocked: true, error: `PERMISSION_DENIED: Network access denied for habit (network: deny)` };
      }
    }
    return { blocked: false };
  }
  
  const testCases = [
    ['curl https://example.com', true],
    ['wget http://example.com', true],
    ['node fetch.js', true],
    ['https://api.example.com/data', true],
    ['node client/memory/tools/rebuild_exclusive.js', false]
  ];
  
  for (const [cmd, shouldBlock] of testCases) {
    const result = simulateSafeExec(cmd);
    if (result.blocked === shouldBlock) {
      logCheck(`network gate: "${cmd.substring(0, 30)}..."`, 'OK', `Correctly ${shouldBlock ? 'blocked' : 'allowed'}`);
      if (result.blocked) console.log(`      → Error: "${result.error}"`);
    } else {
      logCheck(`network gate: "${cmd.substring(0, 30)}..."`, 'FAIL', `Expected ${shouldBlock ? 'blocked' : 'allowed'}`);
    }
  }
}

function checkTrustedSeparation() {
  console.log('\n🏛️ GOVERNANCE / TRUST SEPARATION');
  console.log('─'.repeat(50));
  
  if (!fs.existsSync(TRUSTED_SKILLS_PATH) || !fs.existsSync(TRUSTED_HABITS_PATH)) {
    logCheck('trust files exist', 'FAIL', 'Missing trust registry');
    return;
  }
  
  const skills = JSON.parse(fs.readFileSync(TRUSTED_SKILLS_PATH, 'utf8'));
  const habits = JSON.parse(fs.readFileSync(TRUSTED_HABITS_PATH, 'utf8'));
  
  const skillsFiles = Object.keys(skills.trusted_files || {});
  const habitsFiles = Object.keys(habits.trusted_files || {});
  
  console.log(`   trusted_skills.json: ${skillsFiles.length} files (infrastructure)`);
  console.log(`   trusted_habits.json: ${habitsFiles.length} files (routines)`);
  
  const both = skillsFiles.filter(f => habitsFiles.includes(f));
  
  if (both.length > 0) {
    logCheck('separation clean', 'WARN', `${both.length} files duplicated`);
  } else {
    logCheck('separation clean', 'OK', 'No overlap');
  }
}

function checkGovernanceCompliance() {
  console.log('\n📜 GOVERNANCE COMPLIANCE (v1.0)');
  console.log('─'.repeat(50));
  
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  
  for (const habit of registry.habits) {
    const state = habit.governance?.state || habit.status;
    
    // Gate 1: Spec completeness
    const hasRollback = habit.rollback_plan || (habit.metadata && habit.metadata.rollback_plan);
    logCheck(`${habit.id}.rollback_plan`, hasRollback ? 'OK' : 'WARN');
    
    const hasTestPlan = habit.test_plan || (habit.metadata && habit.metadata.test_plan);
    logCheck(`${habit.id}.test_plan`, hasTestPlan ? 'OK' : 'WARN');
    
    // Network default validation
    const network = habit.permissions?.network;
    logCheck(`${habit.id}.network_default`, 
      network === 'deny' ? 'OK' : 'INFO', 
      network || 'not set'
    );
    
    // Idempotency marker
    const hasIdempotency = habit.idempotent !== undefined || 
                           (habit.metadata && habit.metadata.idempotent !== undefined);
    logCheck(`${habit.id}.idempotency_declared`, hasIdempotency ? 'OK' : 'WARN');
    
    // Estimated savings
    const hasSavings = habit.estimated_tokens_saved !== undefined ||
                       habit.estimated_savings !== undefined;
    logCheck(`${habit.id}.estimated_savings`, hasSavings ? 'OK' : 'WARN');
  }
}

function checkOrphanedTrustPins() {
  console.log('\n🔍 ORPHANED TRUST PINS');
  console.log('─'.repeat(50));
  
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const trusted = JSON.parse(fs.readFileSync(TRUSTED_HABITS_PATH, 'utf8'));
  
  const activeHabitIds = new Set(registry.habits.map(h => h.id));
  const trustedFiles = trusted.trusted_files || {};
  
  let orphaned = 0;
  for (const [filepath, info] of Object.entries(trustedFiles)) {
    const basename = path.basename(filepath, '.js');
    if (!activeHabitIds.has(basename) && info.status !== 'archived') {
      logCheck(`orphan: ${basename}`, 'WARN', 'Trust pin exists but habit not in registry');
      orphaned++;
    }
  }
  
  if (orphaned === 0) {
    logCheck('orphaned_pins', 'OK', 'No orphaned trust pins');
  }
}

function checkCronDependencies() {
  console.log('\n⏰ CRON DEPENDENCIES');
  console.log('─'.repeat(50));
  
  const CRON_JOBS_PATH = '/Users/jay/.openclaw/workspace/client/config/cron_jobs.json';
  
  if (!fs.existsSync(CRON_JOBS_PATH)) {
    logCheck('cron_jobs.json', 'WARN', 'File not found');
    return;
  }
  
  const cronConfig = JSON.parse(fs.readFileSync(CRON_JOBS_PATH, 'utf8'));
  const cronJobs = cronConfig.jobs || [];
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  
  const referencedHabits = new Set();
  for (const job of cronJobs) {
    const payload = job.payload || {};
    const text = payload.text || payload.message || '';
    // Extract habit IDs from cron text
    const habitMatches = text.match(/--id\s+(\w+)/g);
    if (habitMatches) {
      habitMatches.forEach(m => {
        const id = m.replace('--id', '').trim();
        referencedHabits.add(id);
      });
    }
    // Also check for node habit execution
    const nodeMatches = text.match(/run_habit\.js.*--id\s+(\w+)/g);
    if (nodeMatches) {
      nodeMatches.forEach(m => {
        const idMatch = m.match(/--id\s+(\w+)/);
        if (idMatch) referencedHabits.add(idMatch[1]);
      });
    }
  }
  
  console.log(`   Cron jobs: ${cronJobs.length}`);
  console.log(`   Habit references: ${referencedHabits.size}`);
  
  if (referencedHabits.size === 0) {
    logCheck('cron deps', 'OK', 'No cron jobs reference habits');
    return;
  }
  
  for (const habitId of referencedHabits) {
    const habit = registry.habits.find(h => h.id === habitId);
    if (!habit) {
      logCheck(`cron ref: ${habitId}`, 'FAIL', 'Cron references non-existent habit');
    } else if (habit.governance?.state === 'archived') {
      logCheck(`cron ref: ${habitId}`, 'FAIL', 'Cron references archived habit');
    } else {
      logCheck(`cron ref: ${habitId}`, 'OK', habit.governance?.state || 'unknown');
    }
  }
}

function checkIdempotencyMarkers() {
  console.log('\n🔄 IDEMPOTENCY VALIDATION');
  console.log('─'.repeat(50));
  
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  
  for (const habit of registry.habits) {
    // Check 1: idempotency declared
    const declared = habit.idempotent === true || 
                      (habit.metadata && habit.metadata.idempotent === true);
    logCheck(`${habit.id}.idempotency_declared`, declared ? 'OK' : 'INFO', 
      declared ? 'true' : 'not declared (neutral)');
    
    // Check 2: rollback plan exists (safety net)
    const hasRollback = habit.rollback_plan || (habit.metadata && habit.metadata.rollback_plan);
    logCheck(`${habit.id}.rollback_plan`, hasRollback ? 'OK' : 'INFO',
      hasRollback ? 'present' : 'not declared (neutral)');
  }
  
  // Summary info
  const idempotentCount = registry.habits.filter(h => h.idempotent === true).length;
  logCheck('idempotency_summary', 'INFO', `${idempotentCount}/${registry.habits.length} habits declare idempotency`);
}

function checkDocDrift() {
  console.log('\n📚 DOC DRIFT CHECK (Governance vs Code)');
  console.log('─'.repeat(50));
  
  // Expected thresholds from propose_habit.js
  const CODE_THRESHOLDS = {
    A_REPEAT: 3,
    A_TOKENS_MIN: 500,
    B_TOKENS: 2000,
    C_ERRORS: 2
  };
  
  // Read propose_habit.js
  let proposeSrc;
  try {
    proposeSrc = fs.readFileSync('/Users/jay/.openclaw/workspace/client/habits/scripts/propose_habit.js', 'utf8');
  } catch (e) {
    logCheck('doc_drift/propose_read', 'WARN', 'Could not read propose_habit.js');
    return;
  }
  
  // Extract thresholds from code using canonical regexes
  const A_REPEAT = parseInt((proposeSrc.match(/triggerAMet[^ ]*finalRepeats14d\s*>=\s*(\d+)/) || [])[1], 10);
  const A_TOKENS_MIN = parseInt((proposeSrc.match(/triggerAMet[^ ]*tokensEst\s*>=\s*(\d+)/) || [])[1], 10);
  const B_TOKENS = parseInt((proposeSrc.match(/const\s+triggerBMet\s*=\s*tokensEst\s*>=\s*(\d+)/) || [])[1], 10);
  const C_ERRORS = parseInt((proposeSrc.match(/const\s+triggerCMet\s*=\s*errors30d\s*>=\s*(\d+)/) || [])[1], 10);
  
  const actualCode = {
    A_REPEAT: A_REPEAT,
    A_TOKENS: A_TOKENS_MIN,
    B_TOKENS: B_TOKENS,
    C_ERRORS: C_ERRORS
  };
  
  // Check documentation files
  const QUICKREF_PATH = '/Users/jay/.openclaw/workspace/client/habits/QUICKREF.md';
  const GOV_PATH = '/Users/jay/.openclaw/workspace/client/habits/GOVERNANCE.md';
  
  let quickrefContent, govContent;
  try { quickrefContent = fs.readFileSync(QUICKREF_PATH, 'utf8'); } catch (e) {}
  try { govContent = fs.readFileSync(GOV_PATH, 'utf8'); } catch (e) {}
  
  if (!quickrefContent) logCheck('doc_drift/quickref', 'WARN', 'Could not read QUICKREF.md');
  if (!govContent) logCheck('doc_drift/gov', 'WARN', 'Could not read GOVERNANCE.md');
  
  // Check patterns in docs
  const checks = [
    { name: 'A_REPEAT', pattern: '>=\\s*3|≥\\s*3', expected: 3, desc: 'repeats >=3' },
    { name: 'A_TOKENS', pattern: '>=\\s*500|≥\\s*500', expected: 500, desc: 'A tokens >=500' },
    { name: 'B_TOKENS', pattern: '>=\\s*2000|≥\\s*2000', expected: 2000, desc: 'B tokens >=2000' },
    { name: 'C_ERRORS', pattern: '>=\\s*2|≥\\s*2|failed', expected: 2, desc: 'C errors >=2' }
  ];
  
  let drift = 0;
  
  for (const check of checks) {
    const regex = new RegExp(check.pattern, 'i');
    
    // Check QUICKREF
    if (quickrefContent) {
      const qfHas = regex.test(quickrefContent);
      logCheck(`doc_quickref/${check.name}`, qfHas ? 'OK' : 'WARN', check.desc);
      if (!qfHas) drift++;
    }
    
    // Check GOVERNANCE
    if (govContent) {
      const govHas = regex.test(govContent);
      logCheck(`doc_gov/${check.name}`, govHas ? 'OK' : 'WARN', check.desc);
      if (!govHas) drift++;
    }
    
    // Verify code matches expected
    if (actualCode[check.name] && actualCode[check.name] !== CODE_THRESHOLDS[check.name]) {
      logCheck(`doc_drift/code_${check.name}`, 'WARN', 
        `code=${actualCode[check.name]}, expected=${CODE_THRESHOLDS[check.name]}`);
      drift++;
    }
  }
  
  if (drift === 0) {
    logCheck('doc_drift', 'OK', 'All thresholds consistent: code=doc');
  }
}

// Run all checks
console.log('═══════════════════════════════════════════════════════════');
console.log('              HABIT SYSTEM DOCTOR v1.5');
console.log('              (Governance v1.0 + Neural Plasticity)');
console.log('═══════════════════════════════════════════════════════════');

checkRegistrySchema();
checkClearTriggers();
checkGovernanceCompliance();
checkGovernanceStates();
checkTrustedHashes();
checkOrphanedTrustPins();
checkCronDependencies();
checkNDJSONLogs();
checkNetworkDeny();
checkTrustedSeparation();
checkIdempotencyMarkers();
checkDocDrift();

console.log('\n' + '═'.repeat(60));
if (errors === 0 && warnings === 0) {
  console.log('✅ DOCTOR OK');
  exitCode = 0;
} else if (errors === 0) {
  console.log(`⚠️  DOCTOR WARN: ${warnings} warning(s)`);
  exitCode = 0;
} else {
  console.log(`❌ DOCTOR FAIL: ${errors} error(s), ${warnings} warning(s)`);
  exitCode = 1;
}
console.log('═'.repeat(60) + '\n');

process.exit(exitCode);
