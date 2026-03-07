#!/usr/bin/env node
/**
 * sensory_capture.js - Sensory Layer v1.0 (CAPTURE)
 * 
 * Append-only event log for high-signal raw inputs.
 * Captures file changes and git state without reading contents.
 * 
 * Commands:
 *   capture [--lookback-hours N]  - Scan work roots, emit events
 *   note "<text>"                 - Append manual note event
 *   show [--days N]               - Show compact summary
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SENSORY_DIR = path.join(__dirname, '..', '..', 'state', 'sensory');
const RAW_DIR = path.join(SENSORY_DIR, 'raw');
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'work_roots.json');

// Ensure directories exist
function ensureDirs() {
  if (!fs.existsSync(RAW_DIR)) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
  }
}

// Load config
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {
      roots: ['/Users/jay/.openclaw/workspace'],
      ignore_patterns: ['node_modules', '.git', 'dist', 'build', '.cache'],
      limits: { max_events_per_run: 50, max_files_per_root: 25, lookback_hours_default: 24 }
    };
  }
}

// Get today's log file path
function getTodayLogPath() {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(RAW_DIR, `${today}.jsonl`);
}

// Get log path for specific date
function getLogPath(dateStr) {
  return path.join(RAW_DIR, `${dateStr}.jsonl`);
}

// Append single event to today's log (append-only, never rewrite)
function appendEvent(event) {
  ensureDirs();
  const logPath = getTodayLogPath();
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(logPath, line);
  return event;
}

// Check if path should be ignored
function shouldIgnore(filePath, ignorePatterns) {
  const normalized = filePath.toLowerCase();
  return ignorePatterns.some(pattern => {
    const pat = pattern.toLowerCase();
    return normalized.includes('/' + pat + '/') || 
           normalized.includes('/' + pat) ||
           normalized.endsWith('/' + pat) ||
           normalized.endsWith('.' + pat.replace('.', ''));
  });
}

// Check if file is within lookback window (hours)
function isWithinLookback(mtimeMs, lookbackHours) {
  const cutoff = Date.now() - (lookbackHours * 60 * 60 * 1000);
  return mtimeMs >= cutoff;
}

// Get file extension safely
function getExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext ? ext.slice(1) : 'none';
}

// Find recently modified files in a root (safe scan, no content read)
function scanRoot(rootPath, ignorePatterns, lookbackHours, maxFiles) {
  const events = [];
  
  try {
    if (!fs.existsSync(rootPath)) {
      return events;
    }
    
    // Use find command for efficiency (no node recursion needed)
    const cutoffMins = lookbackHours * 60;
    
    // Build ignore pattern for find
    const prunes = ignorePatterns.map(p => `-not -path "*/${p}/*" -not -path "*/${p}"`).join(' ');
    
    // Find files modified within lookback, limited count
    const findCmd = `find "${rootPath}" -type f -mtime -${lookbackHours / 24} ${prunes} 2>/dev/null | head -${maxFiles + 10}`;
    
    const output = execSync(findCmd, {
      encoding: 'utf8',
      timeout: 30000,
      shell: '/client/bin/bash'
    });
    
    const files = output.trim().split('\n').filter(f => f.length > 0 && !shouldIgnore(f, ignorePatterns));
    
    for (const filePath of files.slice(0, maxFiles)) {
      try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) continue;
        
        // Only metadata, never content
        events.push({
          ts: new Date().toISOString(),
          type: 'file_change',
          root: rootPath,
          path: path.relative(rootPath, filePath),
          ext: getExtension(filePath),
          bytes: stats.size,
          mtime: stats.mtime.toISOString(),
          source: 'fs_scan'
        });
      } catch (e) {
        // Skip files we can't stat
      }
    }
  } catch (e) {
    // Find failed or no results
  }
  
  return events;
}

// Check git state for dirty repos (v1.1.3: repo-safe, no fatal output)
function checkGitDirty(rootPath) {
  try {
    // Step 1: Check if inside a git work tree (stderr suppressed)
    const isRepo = execSync('git rev-parse --is-inside-work-tree 2>/dev/null', {
      cwd: rootPath,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'] // Suppress stderr
    }).trim();
    
    if (isRepo !== 'true') {
      return null; // Not a git repo
    }
    
    // Step 2: Check if HEAD exists (repo may be fresh/init with no commits)
    let hasHead = false;
    try {
      execSync('git rev-parse --verify HEAD 2>/dev/null', {
        cwd: rootPath,
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore']
      });
      hasHead = true;
    } catch (e) {
      hasHead = false; // Fresh repo, no commits yet
    }
    
    // Step 3: Get uncommitted changes count (works with or without HEAD)
    const status = execSync('git status --porcelain 2>/dev/null | wc -l', {
      cwd: rootPath,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    
    const changedCount = parseInt(status, 10) || 0;
    
    if (changedCount === 0) {
      return null; // Clean repo
    }
    
    // Step 4: Get branch name (guarded for HEAD-less repos)
    let branch = 'unknown';
    try {
      if (hasHead) {
        branch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', {
          cwd: rootPath,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim() || 'unknown';
      } else {
        // Fresh repo: try symbolic-ref, fallback to 'init'
        branch = execSync('git symbolic-ref --short HEAD 2>/dev/null', {
          cwd: rootPath,
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim() || 'init';
      }
    } catch (e) {
      branch = 'unknown'; // Guarded fallback
    }
    
    return {
      ts: new Date().toISOString(),
      type: 'git_dirty',
      repo_root: rootPath,
      branch: branch,
      changed_count: changedCount,
      source: 'git'
    };
    
  } catch (e) {
    // Silent fail - not a git repo or git not available
    return null;
  }
}

// CAPTURE command - scan all roots and emit events
function capture(args = {}) {
  const config = loadConfig();
  const lookbackHours = args.lookbackHours || config.limits.lookback_hours_default;
  const maxPerRoot = config.limits.max_files_per_root;
  const maxTotal = config.limits.max_events_per_run;
  
  let totalEvents = 0;
  const emitted = [];
  
  for (const root of config.roots) {
    if (totalEvents >= maxTotal) break;
    
    // Scan for file changes
    const fileEvents = scanRoot(root, config.ignore_patterns, lookbackHours, maxPerRoot);
    
    for (const event of fileEvents) {
      if (totalEvents >= maxTotal) break;
      appendEvent(event);
      emitted.push(event);
      totalEvents++;
    }
    
    // Check git dirty state (only once per root)
    if (totalEvents < maxTotal) {
      const gitEvent = checkGitDirty(root);
      if (gitEvent) {
        appendEvent(gitEvent);
        emitted.push(gitEvent);
        totalEvents++;
      }
    }
  }
  
  // v1.1.3: Auto-run digest after successful capture (non-blocking, with await option for tests)
  // Production: autoDigest=true, awaitDigest=false (default)
  // Tests: can call capture({awaitDigest:true}) for deterministic behavior
  const shouldAutoDigest = args.autoDigest !== false; // default: true
  const shouldAwaitDigest = args.awaitDigest === true; // default: false
  
  if (shouldAutoDigest) {
    if (shouldAwaitDigest) {
      // Tests: synchronously await digest
      try {
        runDigest();
      } catch (e) {
        // digest_failed event already logged by runDigest
      }
    } else {
      // Production: non-blocking async
      setTimeout(() => {
        try {
          runDigest();
        } catch (e) {
          // Silent fail - digest is best-effort, failure logged as digest_failed event
        }
      }, 0);
    }
  }
  
  // v1.3.0: Optionally run external eyes after capture (best-effort, non-blocking)
  // This is guarded - if file missing or errors, ignore silently
  setTimeout(() => {
    try {
      const { run } = require('./external_eyes.js');
      run({ maxEyes: 3 });
    } catch (e) {
      // External eyes is optional; ignore errors
    }
  }, 100);
  
  return {
    emitted: emitted.length,
    byType: emitted.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {}),
    roots: [...new Set(emitted.map(e => e.root || e.repo_root))]
  };
}

// v1.1.3: Run digest generator for today's date with health breadcrumbs
// Returns: { ok:boolean, date, digestPath?, anomaliesPath?, error? }
// Throws: only if throwOnFailure=true (for tests)
function runDigest(options = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const digestScript = path.join(__dirname, 'sensory_digest.js');
  const digestPath = path.join(__dirname, '..', '..', 'state', 'sensory', 'digests', `${today}.md`);
  const anomaliesPath = path.join(__dirname, '..', '..', 'state', 'sensory', 'anomalies', `${today}.json`);
  
  try {
    const output = execSync(`node "${digestScript}" daily ${today}`, {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      timeout: 10000
    });
    
    // v1.1.2: Log success breadcrumb
    appendEvent({
      ts: new Date().toISOString(),
      type: 'digest_generated',
      date: today,
      digest_exists: fs.existsSync(digestPath),
      source: 'sensory_digest'
    });
    
    const result = { ok: true, date: today, digestPath, anomaliesPath, output };
    
    // For tests: throw if explicitly requested
    if (options.throwOnFailure) {
      return result;
    }
    return result;
    
  } catch (e) {
    // v1.1.2: Log failure breadcrumb (error truncated to 200 chars)
    const errorMsg = String(e.message || e).slice(0, 200);
    appendEvent({
      ts: new Date().toISOString(),
      type: 'digest_failed',
      date: today,
      error: errorMsg,
      source: 'sensory_digest'
    });
    
    const result = { ok: false, date: today, error: errorMsg };
    
    // For tests: throw on failure
    if (options.throwOnFailure) {
      throw new Error(errorMsg);
    }
    return result;
  }
}

// NOTE command - append manual note
function note(text) {
  if (!text || text.trim().length === 0) {
    return { error: 'Note text required' };
  }
  
  const event = appendEvent({
    ts: new Date().toISOString(),
    type: 'note',
    text: text.trim(),
    source: 'manual'
  });
  
  return { emitted: 1, event };
}

// SHOW command - compact summary of recent days
function show(args = {}) {
  const days = args.days || 1;
  const dates = [];
  
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  
  const summaries = [];
  
  for (const date of dates) {
    const logPath = getLogPath(date);
    if (!fs.existsSync(logPath)) {
      summaries.push({ date, count: 0 });
      continue;
    }
    
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(l => l.length > 0);
    const events = lines.map(l => {
      try {
        return JSON.parse(l);
      } catch (e) {
        return null;
      }
    }).filter(e => e !== null);
    
    const byType = events.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {});
    
    const roots = [...new Set(events.filter(e => e.root).map(e => e.root))];
    
    summaries.push({
      date,
      count: events.length,
      byType,
      topRoots: roots.slice(0, 3)
    });
  }
  
  return summaries;
}

// Format show output for CLI
function formatShow(summaries) {
  let output = '\n📡 SENSORY LAYER SUMMARY\n';
  output += '════════════════════════\n';
  
  for (const s of summaries) {
    output += `\n${s.date}: ${s.count} events\n`;
    if (s.count > 0) {
      for (const [type, count] of Object.entries(s.byType)) {
        const emoji = type === 'file_change' ? '📄' : type === 'git_dirty' ? '🌿' : type === 'note' ? '📝' : '•';
        output += `  ${emoji} ${type}: ${count}\n`;
      }
      if (s.topRoots.length > 0) {
        output += `  📁 Roots: ${s.topRoots.map(r => path.basename(r)).join(', ')}\n`;
      }
    }
  }
  
  return output;
}

// CLI
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  
  switch (cmd) {
    case 'capture': {
      const lookbackArg = args.find(a => a.startsWith('--lookback-hours='));
      const lookbackHours = lookbackArg ? parseInt(lookbackArg.split('=')[1], 10) : null;
      
      const result = capture({ lookbackHours });
      console.log(`📡 Captured ${result.emitted} event(s)`);
      for (const [type, count] of Object.entries(result.byType)) {
        console.log(`  • ${type}: ${count}`);
      }
      break;
    }
    
    case 'note': {
      const text = args.slice(1).join(' ');
      const result = note(text);
      if (result.error) {
        console.log(`❌ ${result.error}`);
      } else {
        console.log(`📝 Note appended: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);
      }
      break;
    }
    
    case 'show': {
      const daysArg = args.find(a => a.startsWith('--days='));
      const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 1;
      
      const summaries = show({ days });
      console.log(formatShow(summaries));
      break;
    }
    
    default:
      console.log('Sensory Layer v1.0 - Event Capture');
      console.log('');
      console.log('Commands:');
      console.log('  capture [--lookback-hours=N]  Scan work roots, emit file_change + git_dirty events');
      console.log('  note "<text>"                Append manual note event');
      console.log('  show [--days=N]              Show compact summary (default: 1 day)');
      console.log('');
      console.log('Config: client/config/work_roots.json');
      console.log('Events: state/sensory/raw/YYYY-MM-DD.jsonl');
  }
}

// Export for programmatic use (including dopamine hook)
module.exports = {
  capture,
  note,
  show,
  appendEvent,
  getTodayLogPath,
  getLogPath,
  SENSORY_DIR,
  RAW_DIR,
  runDigest // v1.1.1: exposed for testing
};

// Run if called directly
if (require.main === module) {
  main();
}
