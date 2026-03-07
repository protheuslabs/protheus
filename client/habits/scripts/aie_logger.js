#!/usr/bin/env node
/**
 * aie_logger.js - Agent Improvement Engine Event Logger v1.0
 * 
 * Append-only JSONL event log for agent quality tracking.
 * Captures verifiable agent outputs: patches, tests, violations, reverts.
 * 
 * NO autonomy - sensing and logging only. All execution requires human approval.
 * 
 * Commands:
 *   log <type> [key=value ...]   - Log a structured event
 *   show [--days N]              - Show event summary
 *   verify <claim>               - Check if claim is supported by evidence
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AIE_DIR = path.join(__dirname, '..', '..', 'state', 'aie');
const EVENTS_DIR = path.join(AIE_DIR, 'events');
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'config', 'aie_schema_v1.json');

// Ensure directories exist
function ensureDirs() {
  if (!fs.existsSync(EVENTS_DIR)) {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
  }
}

// Load schema for validation
function loadSchema() {
  try {
    return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  } catch (e) {
    return { event_types: {}, required_fields_all: ['timestamp', 'type', 'artifact_refs'] };
  }
}

// Get today's event log path
function getTodayLogPath() {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(EVENTS_DIR, `${today}.jsonl`);
}

// Get log path for specific date
function getLogPath(dateStr) {
  return path.join(EVENTS_DIR, `${dateStr}.jsonl`);
}

// Generate event ID
function generateEventId() {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// Validate event against schema
function validateEvent(type, data, schema) {
  const errors = [];
  const typeDef = schema.event_types?.[type];
  
  if (!typeDef) {
    errors.push(`Unknown event type: ${type}`);
  }
  
  // Check required fields
  const required = schema.required_fields_all || [];
  for (const field of required) {
    if (data[field] === undefined || data[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  // Check timestamp format
  if (data.timestamp) {
    const ts = new Date(data.timestamp);
    if (isNaN(ts.getTime())) {
      errors.push(`Invalid timestamp format: ${data.timestamp}`);
    }
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * Log an AIE event (append-only, never rewrite)
 * 
 * @param {string} type - Event type (patch_applied, test_run, etc.)
 * @param {object} data - Event data (merged with timestamp, id)
 * @returns {object} {success, event, error}
 */
function logEvent(type, data = {}) {
  ensureDirs();
  const schema = loadSchema();
  
  // Build full event
  const event = {
    id: generateEventId(),
    timestamp: data.timestamp || new Date().toISOString(),
    type,
    ...data,
    // Ensure artifact_refs exists
    artifact_refs: data.artifact_refs || [],
    // Add hash of event for integrity
    _hash: null
  };
  
  // Validate
  const validation = validateEvent(type, event, schema);
  if (!validation.valid) {
    return { success: false, error: validation.errors.join(', ') };
  }
  
  // Compute hash (excluding _hash field)
  const eventForHash = { ...event };
  delete eventForHash._hash;
  event._hash = crypto.createHash('sha256').update(JSON.stringify(eventForHash)).digest('hex').slice(0, 16);
  
  // Append to log
  const logPath = getTodayLogPath();
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(logPath, line);
  
  return { success: true, event };
}

/**
 * Convenience loggers for common event types
 */

function logPatchApplied({ repo, path, files_changed, tests_passed, artifact_refs = [], summary }) {
  return logEvent('patch_applied', {
    repo,
    path,
    files_changed,
    tests_passed,
    artifact_refs,
    summary
  });
}

function logTestRun({ repo, test_file, passed, failed, duration_ms, artifact_refs = [] }) {
  return logEvent('test_run', {
    repo,
    test_file,
    passed,
    failed,
    duration_ms,
    artifact_refs,
    outcome: failed === 0 ? 'pass' : 'fail'
  });
}

function logLintRun({ repo, linter, errors, warnings, passed, artifact_refs = [] }) {
  return logEvent('lint_run', {
    repo,
    linter,
    errors,
    warnings,
    passed,
    artifact_refs,
    outcome: passed ? 'pass' : 'fail'
  });
}

function logBuildRun({ repo, target, success, duration_ms, errors = [], artifact_refs = [] }) {
  return logEvent('build_run', {
    repo,
    target,
    success,
    duration_ms,
    errors,
    artifact_refs,
    outcome: success ? 'pass' : 'fail'
  });
}

function logApprovalQueued({ action_type, description, risk_level, artifact_refs = [] }) {
  return logEvent('approval_queued', {
    action_type,
    description,
    risk_level,
    queued_at: new Date().toISOString(),
    artifact_refs
  });
}

function logViolationBlocked({ violation_type, attempted_action, blocked_by, artifact_refs = [] }) {
  return logEvent('violation_blocked', {
    violation_type,
    attempted_action,
    blocked_by,
    artifact_refs
  });
}

function logRevert({ original_patch, reason, hours_since_original, artifact_refs = [] }) {
  return logEvent('revert', {
    original_patch,
    reason,
    hours_since_original,
    artifact_refs
  });
}

function logBugFixed({ bug_description, test_before, test_after, verified, artifact_refs = [] }) {
  return logEvent('bug_fixed', {
    bug_description,
    test_before,
    test_after,
    verified,
    artifact_refs
  });
}

function logClaimWithoutArtifact({ claimed_state, actual_state, output_excerpt, artifact_refs = [] }) {
  return logEvent('claim_without_artifact', {
    claimed_state,
    actual_state,
    output_excerpt: output_excerpt?.slice(0, 200), // Cap length
    artifact_refs
  });
}

function logEfficiencyMarker({ task_description, tokens_used, output_lines, redundancy_detected }) {
  return logEvent('efficiency_marker', {
    task_description,
    tokens_used,
    output_lines,
    redundancy_detected
  });
}

/**
 * Verify if a claim is supported by artifacts
 * Returns {supported, evidence, confidence}
 */
function verifyClaim(claim, lookbackDays = 1) {
  const evidence = [];
  const today = new Date();
  
  // Search recent logs for supporting evidence
  for (let i = 0; i < lookbackDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const logPath = getLogPath(dateStr);
    
    if (!fs.existsSync(logPath)) continue;
    
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(l => l);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        // Check if event supports the claim
        if (event.artifact_refs?.some(ref => claim.includes(ref))) {
          evidence.push({ date: dateStr, event });
        }
      } catch (e) {
        // Skip invalid lines
      }
    }
  }
  
  const supported = evidence.length > 0;
  const confidence = Math.min(evidence.length * 0.3, 0.95); // Cap at 95%
  
  return { supported, evidence, confidence };
}

/**
 * Show summary of recent events
 */
function showSummary(days = 1) {
  const summaries = [];
  const today = new Date();
  
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const logPath = getLogPath(dateStr);
    
    if (!fs.existsSync(logPath)) {
      summaries.push({ date: dateStr, count: 0, types: {} });
      continue;
    }
    
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(l => l);
    const events = [];
    
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch (e) {}
    }
    
    const types = events.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {});
    
    summaries.push({
      date: dateStr,
      count: events.length,
      types,
      passing_patches: events.filter(e => e.type === 'patch_applied' && e.tests_passed).length,
      violations: events.filter(e => e.type === 'violation_blocked').length,
      reverts: events.filter(e => e.type === 'revert').length
    });
  }
  
  return summaries;
}

// CLI
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  
  switch (cmd) {
    case 'log': {
      const type = args[1];
      const kvPairs = args.slice(2);
      const data = {};
      let autoHash = false;
      
      for (const pair of kvPairs) {
        const [key, ...valueParts] = pair.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('='); // Rejoin in case value had =
          
          // Check for auto_hash flag
          if (key === 'auto_hash' && value === 'true') {
            autoHash = true;
            continue;
          }
          
          // Never parse test_log_sha256 as number (always string)
          if (key === 'test_log_sha256') {
            data[key] = value;
            continue;
          }
          
          // Try to parse as number/boolean
          if (value === 'true') data[key] = true;
          else if (value === 'false') data[key] = false;
          else if (!isNaN(parseFloat(value)) && !value.includes(':')) data[key] = parseFloat(value);
          else data[key] = value;
        }
      }
      
      // Auto-compute hash if:
      // 1. auto_hash explicitly requested, OR
      // 2. test_log_path provided but no sha (v1.0.2: auto-compute by default)
      const shouldAutoHash = autoHash || (data.test_log_path && !data.test_log_sha256);
      
      if (shouldAutoHash && data.test_log_path) {
        try {
          if (fs.existsSync(data.test_log_path)) {
            const fileContent = fs.readFileSync(data.test_log_path);
            const crypto = require('crypto');
            data.test_log_sha256 = crypto.createHash('sha256').update(fileContent).digest('hex');
          }
        } catch (e) {
          // Hash computation failed, will be logged without evidence
        }
      }
      
      const result = logEvent(type, data);
      if (result.success) {
        console.log(`✅ Logged ${type}: ${result.event.id}`);
        if (data.test_log_sha256) {
          console.log(`   📎 Test log verified: ${data.test_log_sha256.slice(0, 16)}...`);
        }
      } else {
        console.log(`❌ Failed: ${result.error}`);
      }
      break;
    }
    
    case 'verify': {
      const claim = args.slice(1).join(' ');
      const result = verifyClaim(claim);
      console.log(`Claim: "${claim.slice(0, 60)}${claim.length > 60 ? '...' : ''}"`);
      console.log(`Supported: ${result.supported ? '✅ YES' : '❌ NO'}`);
      console.log(`Confidence: ${Math.round(result.confidence * 100)}%`);
      if (result.evidence.length > 0) {
        console.log(`Evidence: ${result.evidence.length} event(s)`);
      }
      break;
    }
    
    case 'show': {
      const daysArg = args.find(a => a.startsWith('--days='));
      const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 1;
      
      const summaries = showSummary(days);
      console.log('\n📊 AIE EVENT SUMMARY');
      console.log('════════════════════');
      
      for (const s of summaries) {
        console.log(`\n${s.date}: ${s.count} events`);
        if (s.count > 0) {
          console.log(`  ✅ Patches (passing): ${s.passing_patches || 0}`);
          console.log(`  🚫 Violations: ${s.violations || 0}`);
          console.log(`  ↩️  Reverts: ${s.reverts || 0}`);
          if (Object.keys(s.types).length > 0) {
            console.log(`  Types: ${Object.entries(s.types).map(([t, c]) => `${t}(${c})`).join(', ')}`);
          }
        }
      }
      break;
    }
    
    default:
      console.log('Agent Improvement Engine (AIE) v1.0 - Event Logger');
      console.log('');
      console.log('Commands:');
      console.log('  log <type> [key=value ...]  Log a structured event');
      console.log('    Example: log patch_applied repo=workspace path=scripts tests_passed=true');
      console.log('  verify <claim>              Check if claim is supported by evidence');
      console.log('  show [--days=N]            Show event summary');
      console.log('');
      console.log('Event types:');
      const schema = loadSchema();
      for (const [type, def] of Object.entries(schema.event_types || {})) {
        console.log(`  ${type}: ${def.description}`);
      }
  }
}

// Export all functions for programmatic use
module.exports = {
  logEvent,
  logPatchApplied,
  logTestRun,
  logLintRun,
  logBuildRun,
  logApprovalQueued,
  logViolationBlocked,
  logRevert,
  logBugFixed,
  logClaimWithoutArtifact,
  logEfficiencyMarker,
  verifyClaim,
  showSummary,
  getTodayLogPath,
  getLogPath,
  loadSchema,
  EVENTS_DIR
};

// Run if called directly
if (require.main === module) {
  main();
}
