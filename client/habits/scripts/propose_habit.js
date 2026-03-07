#!/usr/bin/env node
/**
 * propose_habit.js v1.5 - Generate habit candidates (Governance v1.0)
 * Does NOT create habits - only proposes them for user approval
 * 
 * CRYSTALLIZATION TRIGGERS (ANY qualifies for candidate):
 * A) REPETITION: >=3 times in 14d AND tokens_est >=500
 * B) COST: tokens_est >=2000 (heavy workflows)
 * C) FRICTION: >=2 failures in 30d (syntax/schema/rate-limit)
 * 
 * PROMOTION (candidate -> active): ALL gates required:
 *   - Trusted (SHA-256 pinned)
 *   - >=3 successful runs
 *   - Avg outcome_score >=0.70 (last 3 runs)
 *   - 0 permission violations (last 10 runs)
 *   - doctor.js passes
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REGISTRY_PATH = '/Users/jay/.openclaw/workspace/client/habits/registry.json';
const SNIPPET_DIR = '/Users/jay/.openclaw/workspace/memory';
const HABITS_LOG = '/Users/jay/.openclaw/workspace/client/habits/client/logs/habit_runs.ndjson';

/** Normalizes intent text to create deterministic "intent key" */
function normalizeIntent(text) {
  if (!text) return '';
  
  return text
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')           // remove dates
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g, '') // UUIDs
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g, '') // ISO timestamps
    .replace(/["'][^"']*["']/g, '<str>')              // quoted strings
    .replace(/\s+/g, ' ')                             // collapse whitespace
    .trim()
    .split(/\s+/)
    .slice(0, 12)                                     // keep top 12 keywords
    .join('_');
}

/** Counts runs matching intent key from NDJSON log */
function countIntentMatches(intentKey, daysWindow) {
  if (!fs.existsSync(HABITS_LOG)) return { count14d: 0, count30d: 0 };
  
  const content = fs.readFileSync(HABITS_LOG, 'utf8').trim();
  if (!content) return { count14d: 0, count30d: 0 };
  
  const lines = content.split('\n');
  const now = Date.now();
  const ms14d = 14 * 24 * 60 * 60 * 1000;
  const ms30d = 30 * 24 * 60 * 60 * 1000;
  
  let count14d = 0;
  let count30d = 0;
  
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry.ts) continue;
      
      const entryTime = new Date(entry.ts).getTime();
      const age = now - entryTime;
      
      // Check if summary contains matching intent (or use habit_id matching)
      const entryIntent = entry.intent_key || entry.habit_id || '';
      if (entryIntent === intentKey || normalizeIntent(entry.summary?.toString() || '').includes(intentKey)) {
        if (age <= ms14d) count14d++;
        if (age <= ms30d) count30d++;
      }
    } catch (e) {
      continue;
    }
  }
  
  return { count14d, count30d };
}

function main() {
  const args = process.argv.slice(2);
  
  const fromIndex = args.indexOf('--from');
  const tokensIndex = args.indexOf('--tokens_est');
  const repeats14dIndex = args.indexOf('--repeats_14d');
  const repeats30dIndex = args.indexOf('--repeats_30d');
  const opsIndex = args.indexOf('--operations');
  const errorsIndex = args.indexOf('--errors_30d');
  const execAllowIndex = args.indexOf('--exec_allowlist');
  const writeAllowIndex = args.indexOf('--write_allowlist');
  
  const description = fromIndex !== -1 && args[fromIndex + 1] ? args[fromIndex + 1] : '';
  const tokensEst = tokensIndex !== -1 && args[tokensIndex + 1] ? parseInt(args[tokensIndex + 1]) : 0;
  const repeats14d = repeats14dIndex !== -1 && args[repeats14dIndex + 1] ? parseInt(args[repeats14dIndex + 1]) : 0;
  const repeats30d = repeats30dIndex !== -1 && args[repeats30dIndex + 1] ? parseInt(args[repeats30dIndex + 1]) : 0;
  const operationsCount = opsIndex !== -1 && args[opsIndex + 1] ? parseInt(args[opsIndex + 1]) : 0;
  const errors30d = errorsIndex !== -1 && args[errorsIndex + 1] ? parseInt(args[errorsIndex + 1]) : 0;
  
  // Parse allowlists
  const execAllowlist = execAllowIndex !== -1 && args[execAllowIndex + 1] 
    ? args[execAllowIndex + 1].split(',') 
    : [];
  const writeAllowlist = writeAllowIndex !== -1 && args[writeAllowIndex + 1]
    ? args[writeAllowIndex + 1].split(',')
    : ['client/memory/*.md', 'client/habits/client/logs/*'];
  
  // Generate intent key
  const intentKey = normalizeIntent(description);
  
  // Count from logs if not provided
  const { count14d: logged14d, count30d: logged30d } = countIntentMatches(intentKey, 30);
  const finalRepeats14d = repeats14d || logged14d;
  const finalRepeats30d = repeats30d || logged30d;
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           HABIT CANDIDATE ANALYSIS v1.5');
  console.log('           (GOVERNANCE v1.0: ANY of A/B/C qualifies)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log(`Description: ${description || '(none provided)'}`);
  console.log(`Intent Key: ${intentKey || '(empty)'}`);
  console.log('');
  console.log('TRIGGER A - REPETITION (candidate if >=3/14d AND tokens>=500):');
  console.log(`  - 14d count: ${finalRepeats14d} (threshold: >=3)`);
  console.log(`  - Tokens est: ${tokensEst} (threshold: >=500)`);
  console.log('');
  console.log('TRIGGER B - COST (candidate if tokens>=2000, even if repeats<3):');
  console.log(`  - Tokens est: ${tokensEst} (threshold: >=2000)`);
  console.log('');
  console.log('TRIGGER C - FRICTION (candidate if >=2 failures in 30d):');
  console.log(`  - Errors 30d: ${errors30d} (threshold: >=2)`);
  console.log('');
  
  // TRIGGER A: Repetition (must have both count AND minimum cost)
  const triggerAMet = finalRepeats14d >= 3 && tokensEst >= 500;
  
  // TRIGGER B: Cost (high token threshold, qualifies even with low repetition)
  const triggerBMet = tokensEst >= 2000;
  
  // TRIGGER C: Friction (failures from error logs)
  const triggerCMet = errors30d >= 2;
  
  const anyTriggerMet = triggerAMet || triggerBMet || triggerCMet;
  
  console.log(`TRIGGER A (${triggerAMet ? '✅' : '❌'}): repetition >=3(14d) AND tokens>=500`);
  console.log(`TRIGGER B (${triggerBMet ? '✅' : '❌'}): tokens >=2000 (heavy workflow)`);
  console.log(`TRIGGER C (${triggerCMet ? '✅' : '❌'}): errors >=2 in 30d (friction)`);
  console.log('');
  console.log(`RESULT: ${anyTriggerMet ? '✅ ANY TRIGGER MET' : '❌ NO TRIGGERS MET'}`);
  console.log('');
  
  // ANY trigger qualifies for candidate proposal
  if (!anyTriggerMet) {
    console.log('Habit not warranted. To qualify, meet ANY:');
    console.log('  - A: Repetition >=3 times in 14d AND tokens>=500');
    console.log('  - B: Heavy cost >=2,000 tokens (even if repeats<3)');
    console.log('  - C: Friction >=2 failures in 30d (syntax/schema/rate-limit)');
    console.log('');
    console.log('Continue manually until thresholds met.');
    process.exit(0);
  }
  
  // Generate proposal
  const slug = description.toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 40) || 'unnamed_habit';
  
  const proposal = {
    candidate_name: description.substring(0, 60),
    intent_key: intentKey,
    slug: slug,
    replaces: `Manual: ${description.substring(0, 80)}...`,
    triggers: {
      which_met: [triggerAMet && 'A', triggerBMet && 'B', triggerCMet && 'C'].filter(Boolean),
      a_repetition: {
        repeats_14d: finalRepeats14d,
        repeats_30d: finalRepeats30d,
        threshold_met: triggerAMet
      },
      b_cost: {
        tokens_est: tokensEst,
        operations_count: operationsCount,
        threshold_met: triggerBMet
      },
      c_friction: {
        errors_30d: errors30d,
        threshold_met: triggerCMet
      }
    },
    exact_inputs_schema: {
      type: 'object',
      required: [],
      properties: {
        notes: { type: 'string', description: 'Optional context' }
      }
    },
    exact_permissions: {
      network: 'deny',
      write_paths_allowlist: writeAllowlist,
      exec_allowlist: execAllowlist.length > 0 ? execAllowlist : ['DEFINE_EXEC_ALLOWLIST']
    },
    entrypoint: `client/habits/routines/${slug}.js`,
    estimated_savings: Math.round(tokensEst * 0.7),
    target_state: 'candidate',
    governance: {
      promote: { min_success_runs: 3, min_outcome_score: 0.70 },
      demote: { max_consecutive_errors: 2, min_outcome_score: 0.40, cooldown_minutes: 1440 }
    },
    decision: 'APPROVE? y/n'
  };
  
  console.log('RESULT: ✅ PROPOSAL GENERATED');
  console.log('');
  console.log(JSON.stringify(proposal, null, 2));
  console.log('');
  
  // Write state-change SNIP
  const triggersMet = [triggerAMet && 'A', triggerBMet && 'B', triggerCMet && 'C'].filter(Boolean).join(',');
  writeStateChangeSnip({
    habit_id: slug,
    previous_state: 'none',
    new_state: 'candidate',
    reason: `TRIGGERS_MET: ${triggersMet} (Governance v1.0: ANY qualifies)`,
    trigger_a: proposal.triggers.a_repetition,
    trigger_b: proposal.triggers.b_cost,
    trigger_c: proposal.triggers.c_friction,
    last_used_at: null,
    uses_30d: 0,
    consecutiveErrors: 0,
    avg_outcome_score: null,
    safety_notes: ['Awaiting trust approval', 'Promotion requires ALL gates']
  });
  
  console.log('');
  console.log('NEXT STEPS:');
  console.log(`  1. Create: client/habits/routines/${slug}.js`);
  console.log(`  2. Trust: node client/habits/scripts/trust_add_habit.js client/habits/routines/${slug}.js "${description.substring(0, 50)}"`);
  console.log(`  3. Run 3x to meet promotion threshold`);
  console.log(`  4. Once promoted to active, habit will auto-execute`);
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
  
  const triggerCStr = data.trigger_c ? `\n- Trigger C: ${JSON.stringify(data.trigger_c)}` : '';
  const snipContent = `<!-- SNIP: habit-state-${data.habit_id}-${Date.now()} -->
**Habit State Change: ${data.habit_id}**
- Transition: ${data.previous_state} → ${data.new_state}
- Reason: ${data.reason}
- Trigger A: ${JSON.stringify(data.trigger_a || {})}
- Trigger B: ${JSON.stringify(data.trigger_b || {})}${triggerCStr}
- Stats: uses_30d=${data.uses_30d}, errors=${data.consecutiveErrors}, score=${data.avg_outcome_score || 'N/A'}
- Safety: ${data.safety_notes.join('; ')}
`;
  
  if (fs.existsSync(snipFile)) {
    fs.appendFileSync(snipFile, '\n' + snipContent + '\n', 'utf8');
    console.log(`✅ State-change SNIP written to ${snipFile}`);
  } else {
    console.log(`⚠️  ${snipFile} not found. State-change SNIP not persisted.`);
  }
}

module.exports = { normalizeIntent, countIntentMatches, writeStateChangeSnip };

if (require.main === module) {
  main();
}
