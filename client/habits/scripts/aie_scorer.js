#!/usr/bin/env node
/**
 * aie_scorer.js - Agent Improvement Engine Scorer v1.0
 * 
 * Computes Agent Quality Score (AQS) from verifiable events.
 * Rolling 7/30-day windows, daily cap enforcement.
 * 
 * NO autonomy - evaluation only. Score informs human decisions.
 */

const fs = require('fs');
const path = require('path');

const AIE_DIR = path.join(__dirname, '..', '..', 'state', 'aie');
const EVENTS_DIR = path.join(AIE_DIR, 'events');
const SCORES_DIR = path.join(AIE_DIR, 'scores');
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'config', 'aie_schema_v1.json');

// Ensure directories
function ensureDirs() {
  if (!fs.existsSync(SCORES_DIR)) {
    fs.mkdirSync(SCORES_DIR, { recursive: true });
  }
}

// Load scoring rules from schema
function loadScoringRules() {
  try {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    return schema.scoring_rules || {};
  } catch (e) {
    return {
      patch_applied_passing: 10,
      patch_applied_unknown: 5,
      bug_fixed_verified: 5,
      approval_queued: 5,
      revert_within_48h: -10,
      revert_after_48h: -5,
      violation_blocked: -20,
      claim_without_artifact: -10,
      daily_cap: 50
    };
  }
}

// Verify test log evidence for patch_applied events
// Returns { valid: boolean, reason: string }
function verifyTestLogEvidence(event) {
  // If tests_passed is not true, no evidence needed
  if (event.tests_passed !== true) {
    return { valid: false, reason: 'tests_passed is not true' };
  }
  
  // Must have test_log_path
  if (!event.test_log_path) {
    return { valid: false, reason: 'missing test_log_path' };
  }
  
  // Check file exists
  if (!fs.existsSync(event.test_log_path)) {
    return { valid: false, reason: 'test_log_path does not exist' };
  }
  
  // Must have test_log_sha256
  if (!event.test_log_sha256) {
    return { valid: false, reason: 'missing test_log_sha256' };
  }
  
  // Verify hash
  try {
    const fileContent = fs.readFileSync(event.test_log_path);
    const crypto = require('crypto');
    const actualHash = crypto.createHash('sha256').update(fileContent).digest('hex');
    
    if (actualHash !== event.test_log_sha256) {
      return { valid: false, reason: 'sha256 mismatch' };
    }
    
    return { valid: true, reason: 'evidence verified' };
  } catch (e) {
    return { valid: false, reason: `hash verification failed: ${e.message}` };
  }
}

// Get dates for last N days
function getLastNDates(n) {
  const dates = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// Load events for a specific date
function loadEvents(dateStr) {
  const logPath = path.join(EVENTS_DIR, `${dateStr}.jsonl`);
  if (!fs.existsSync(logPath)) {
    return [];
  }
  
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(l => l);
  const events = [];
  
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch (e) {
      // Skip invalid lines
    }
  }
  
  return events;
}

// Compute score for a single event
// Returns { score: number, warning: string | null }
function scoreEvent(event, rules) {
  const type = event.type;
  const timestamp = new Date(event.timestamp);
  let warning = null;
  
  switch (type) {
    case 'patch_applied': {
      if (event.tests_passed === true) {
        // Check for valid evidence
        const evidence = verifyTestLogEvidence(event);
        if (evidence.valid) {
          return { score: rules.patch_applied_passing || 10, warning: null };
        } else {
          // Unverified claim - score as unknown but warn
          warning = `⚠️ Unverified tests_passed claim (${evidence.reason}) → scored as +5`;
          return { score: rules.patch_applied_unknown || 5, warning };
        }
      }
      return { score: rules.patch_applied_unknown || 5, warning: null };
    }
    
    case 'test_run': {
      // v1.0.2: test_run events are scored directly
      if (event.exit_code === 0) {
        return { score: rules.test_run_passing || 6, warning: null };
      }
      return { score: rules.test_run_failing || -6, warning: null };
    }
    
    case 'lint_run':
    case 'build_run':
      // Contextual events - scored via parent patch_applied
      return { score: 0, warning: null };
    
    case 'bug_fixed': {
      if (event.verified === true) {
        return { score: rules.bug_fixed_verified || 5, warning: null };
      }
      return { score: 0, warning: null };
    }
    
    case 'approval_queued': {
      return { score: rules.approval_queued || 5, warning: null };
    }
    
    case 'violation_blocked': {
      return { score: rules.violation_blocked || -20, warning: null };
    }
    
    case 'revert': {
      const hours = event.hours_since_original || 0;
      if (hours <= 48) {
        return { score: rules.revert_within_48h || -10, warning: null };
      }
      return { score: rules.revert_after_48h || -5, warning: null };
    }
    
    case 'claim_without_artifact': {
      return { score: rules.claim_without_artifact || -10, warning: null };
    }
    
    case 'efficiency_marker':
      // Tracked but not directly scored
      return { score: 0, warning: null };
    
    default:
      return { score: 0, warning: null };
  }
}

// Compute daily score with cap
function computeDailyScore(dateStr, rules) {
  const events = loadEvents(dateStr);
  let rawScore = 0;
  const breakdown = {
    positive: [],
    negative: [],
    contextual: []
  };
  const warnings = [];
  
  for (const event of events) {
    const result = scoreEvent(event, rules);
    const entry = { type: event.type, points: result.score, id: event.id };
    
    if (result.score > 0) {
      breakdown.positive.push(entry);
    } else if (result.score < 0) {
      breakdown.negative.push(entry);
    } else {
      breakdown.contextual.push(entry);
    }
    
    rawScore += result.score;
    
    // Collect warnings
    if (result.warning) {
      warnings.push({ event: event.id, type: event.type, warning: result.warning });
    }
  }
  
  // Apply daily cap
  const cap = rules.daily_cap || 50;
  const cappedScore = Math.min(Math.max(rawScore, -cap), cap); // Cap both directions
  
  return {
    date: dateStr,
    raw_score: rawScore,
    capped_score: cappedScore,
    event_count: events.length,
    breakdown,
    cap_applied: rawScore !== cappedScore,
    warnings
  };
}

// Compute rolling averages
function computeRollingAverages(days = [7, 30]) {
  const rules = loadScoringRules();
  const result = {};
  
  for (const window of days) {
    const dates = getLastNDates(window);
    let totalScore = 0;
    let totalEvents = 0;
    const dailyScores = [];
    
    for (const date of dates) {
      const daily = computeDailyScore(date, rules);
      totalScore += daily.capped_score;
      totalEvents += daily.event_count;
      dailyScores.push(daily.capped_score);
    }
    
    result[`${window}d`] = {
      window_days: window,
      avg_score: Math.round(totalScore / window),
      total_events: totalEvents,
      min_day: Math.min(...dailyScores),
      max_day: Math.max(...dailyScores)
    };
  }
  
  return result;
}

// Get current AQS summary
function getCurrentAQS() {
  ensureDirs();
  const rules = loadScoringRules();
  const today = new Date().toISOString().slice(0, 10);
  
  const daily = computeDailyScore(today, rules);
  const rolling = computeRollingAverages([7, 30]);
  
  // Load events for trend calculation
  const last7 = getLastNDates(7);
  let streakDays = 0;
  
  for (const date of last7) {
    const score = computeDailyScore(date, rules);
    if (score.capped_score > 0) {
      streakDays++;
    } else {
      break;
    }
  }
  
  return {
    date: today,
    today: {
      score: daily.capped_score,
      raw_score: daily.raw_score,
      events: daily.event_count,
      cap_applied: daily.cap_applied,
      warnings: daily.warnings
    },
    rolling7: rolling['7d'],
    rolling30: rolling['30d'],
    streak_days: streakDays,
    quality_grade: computeGrade(daily.capped_score, rolling['7d'].avg_score)
  };
}

// Compute letter grade based on today + 7d avg
function computeGrade(today, avg7) {
  const combined = (today + avg7) / 2;
  if (combined >= 40) return 'A';
  if (combined >= 25) return 'B';
  if (combined >= 10) return 'C';
  if (combined >= 0) return 'D';
  return 'F';
}

// Format AQS for display
function formatAQS(aqs) {
  const today = aqs.today;
  const capNote = today.cap_applied ? ' (capped)' : '';
  const verifiedCount = today.warnings?.filter(w => !w.warning.includes('Unverified')).length || 0;
  const unverifiedCount = today.warnings?.filter(w => w.warning.includes('Unverified')).length || 0;
  
  let output = '\n📊 AGENT QUALITY SCORE (AQS)\n';
  output += '═════════════════════════════\n';
  output += `Date: ${aqs.date}\n`;
  output += `Grade: ${aqs.quality_grade} | Score: ${today.score}${capNote}\n`;
  output += `7-day avg: ${aqs.rolling7.avg_score} | 30-day avg: ${aqs.rolling30.avg_score}\n`;
  output += `Streak: ${aqs.streak_days} positive day(s)\n`;
  output += `Events today: ${today.events}`;
  
  // Add verified/unverified breakdown
  if (today.warnings && today.warnings.length > 0) {
    output += ` (${unverifiedCount} unverified)\n`;
  } else {
    output += '\n';
  }
  
  return output;
}

// Save score state
function saveScoreState(aqs) {
  ensureDirs();
  const statePath = path.join(SCORES_DIR, 'aqs_state.json');
  fs.writeFileSync(statePath, JSON.stringify(aqs, null, 2));
}

// Load score state
function loadScoreState() {
  const statePath = path.join(SCORES_DIR, 'aqs_state.json');
  if (!fs.existsSync(statePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

// CLI
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  
  switch (cmd) {
    case 'score': {
      const aqs = getCurrentAQS();
      console.log(formatAQS(aqs));
      
      // Print warnings if any
      if (aqs.today.warnings && aqs.today.warnings.length > 0) {
        console.log('\n⚠️  WARNINGS:');
        aqs.today.warnings.forEach(w => {
          console.log(`   ${w.warning}`);
        });
      }
      
      saveScoreState(aqs);
      break;
    }
    
    case 'rolling': {
      const rules = loadScoringRules();
      const rolling = computeRollingAverages([7, 30]);
      console.log('\n📈 ROLLING AVERAGES');
      console.log('════════════════════');
      console.log(`7-day:  ${rolling['7d'].avg_score} avg (${rolling['7d'].total_events} events)`);
      console.log(`30-day: ${rolling['30d'].avg_score} avg (${rolling['30d'].total_events} events)`);
      break;
    }
    
    case 'daily': {
      const date = args[1] || new Date().toISOString().slice(0, 10);
      const rules = loadScoringRules();
      const daily = computeDailyScore(date, rules);
      
      console.log(`\n📅 DAILY SCORE: ${date}`);
      console.log('════════════════════');
      console.log(`Raw score: ${daily.raw_score}`);
      console.log(`Capped:    ${daily.capped_score}`);
      console.log(`Events:    ${daily.event_count}`);
      
      if (daily.breakdown.positive.length > 0) {
        console.log(`\n✅ Positive (${daily.breakdown.positive.length}):`);
        daily.breakdown.positive.forEach(p => {
          console.log(`   +${p.points} ${p.type} (${p.id.slice(0, 12)})`);
        });
      }
      
      if (daily.breakdown.negative.length > 0) {
        console.log(`\n❌ Negative (${daily.breakdown.negative.length}):`);
        daily.breakdown.negative.forEach(n => {
          console.log(`   ${n.points} ${n.type} (${n.id.slice(0, 12)})`);
        });
      }
      break;
    }
    
    case 'rules': {
      const rules = loadScoringRules();
      console.log('\n📋 SCORING RULES');
      console.log('════════════════');
      for (const [rule, value] of Object.entries(rules)) {
        const sign = value > 0 ? '+' : '';
        console.log(`  ${sign}${value} ${rule}`);
      }
      break;
    }
    
    default:
      console.log('Agent Improvement Engine (AIE) Scorer v1.0');
      console.log('');
      console.log('Commands:');
      console.log('  score      Show current AQS summary');
      console.log('  rolling    Show 7/30-day rolling averages');
      console.log('  daily [date]  Show breakdown for specific date (YYYY-MM-DD)');
      console.log('  rules      Show scoring rules');
      console.log('');
      console.log('AQS = Agent Quality Score (verifiable events only)');
      console.log('Score components:');
      console.log('  +10 patch_applied with passing tests');
      console.log('  +5  bug_fixed with verified test');
      console.log('  +5  approval_queued (directive compliance)');
      console.log('  -10 revert within 48h (rework)');
      console.log('  -20 violation attempt');
      console.log('  -10 claim without artifact (hallucination)');
      console.log('Daily cap: ±50 points');
  }
}

// Export all functions
module.exports = {
  scoreEvent,
  computeDailyScore,
  computeRollingAverages,
  getCurrentAQS,
  formatAQS,
  saveScoreState,
  loadScoreState,
  loadScoringRules,
  computeGrade
};

// Run if called directly
if (require.main === module) {
  main();
}
