#!/usr/bin/env node
/**
 * dopamine_engine.js - Strategic Dopamine Score (SDS) Engine v1.2.0
 *
 * Directive-aligned behavioral conditioning system.
 * Now with AGENT MODE - synthetic dopamine for Protheus.
 *
 * Formula (v1.1 - Artifact-First Anti-Gaming):
 * SDS = (high_leverage_minutes × multiplier)
 *     + (revenue_progress_score × 2)
 *     + (streak_days × 0.5)
 *     - (drift_minutes × 1.2)
 *     - (context_switches × 0.3)
 *     + (artifact_bonus)
 *
 * Multiplier = 1.5 if entry/day has artifacts, else 1.0
 * Artifact bonus = +3 first, +1 each additional (cap +6/day)
 * Revenue bonus cap = +6/day (max 3 actions)
 *
 * Artifacts = structured proof of output with SHA256 verification
 *
 * AGENT MODE (v1.2):
 * - agentLog() - Quick task completion with immediate celebration
 * - agentTaskStart/Complete - Full task lifecycle tracking
 * - agentCelebrate() - Immediate positive feedback (synthetic dopamine hit)
 * - agentStats() - Session productivity metrics
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_FILE = path.join(__dirname, '..', '..', 'state', 'dopamine_state.json');
const DAILY_LOGS_DIR = path.join(__dirname, '..', '..', 'state', 'daily_logs');
const ACHIEVEMENTS_FILE = path.join(__dirname, '..', '..', 'config', 'achievements_v1.json');

// High-leverage tags aligned with T1 directives
const HIGH_LEVERAGE_TAGS = new Set([
  'automation', 'equity', 'sales', 'product',
  'compounding', 'system_building', 'revenue', 'growth', 'scaling'
]);

// Ensure directories exist
function ensureDirs() {
  if (!fs.existsSync(DAILY_LOGS_DIR)) {
    fs.mkdirSync(DAILY_LOGS_DIR, { recursive: true });
  }
}

/**
 * Load or initialize state
 */
function loadState() {
  ensureDirs();
  const defaultState = {
    current_streak_days: 0,
    last_recorded_date: null,
    rolling_7_day_avg: 0,
    rolling_30_day_avg: 0,
    last_score: 0,
    highest_score: 0,
    unlocked_achievements: [],
    achievement_log: []
  };
  
  if (!fs.existsSync(STATE_FILE)) {
    return { ...defaultState };
  }
  
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  // Ensure v1.1 fields exist
  return {
    ...defaultState,
    ...state,
    unlocked_achievements: state.unlocked_achievements || [],
    achievement_log: state.achievement_log || []
  };
}

/**
 * Save state
 */
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Load achievements config
 */
function loadAchievements() {
  if (!fs.existsSync(ACHIEVEMENTS_FILE)) {
    return { achievements: [] };
  }
  return JSON.parse(fs.readFileSync(ACHIEVEMENTS_FILE, 'utf8'));
}

/**
 * Get daily log file path
 */
function getDailyLogPath(date) {
  const dateStr = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  return path.join(DAILY_LOGS_DIR, `${dateStr}.json`);
}

/**
 * Load or create daily log (v1.1 schema)
 */
function loadDailyLog(date) {
  ensureDirs();
  const logPath = getDailyLogPath(date);
  if (!fs.existsSync(logPath)) {
    return {
      date: typeof date === 'string' ? date : date.toISOString().slice(0, 10),
      entries: [],
      context_switches: 0,
      revenue_actions: [], // v1.1: structured revenue actions
      artifacts: [] // v1.1: aggregate artifacts list
    };
  }
  const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  // Migrate old schema
  if (!log.revenue_actions) log.revenue_actions = [];
  if (!log.artifacts) log.artifacts = [];
  return log;
}

/**
 * Save daily log
 */
function saveDailyLog(log) {
  const logPath = getDailyLogPath(log.date);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
}

/**
 * Calculate SHA256 hash of file
 */
function hashFile(filePath) {
  try {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) return null;
    const content = fs.readFileSync(fullPath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (e) {
    return null;
  }
}

/**
 * Calculate Strategic Dopamine Score for a day (v1.1.1 anti-gaming)
 */
function calculateSDS(dayLog) {
  let hlProvenMinutes = 0;      // 1.5x - entry has artifacts OR day has artifacts
  let hlUnprovenMinutes = 0;    // 1.0x - no artifacts on entry or day
  let driftMinutes = 0;
  let contextSwitches = dayLog.context_switches || 0;
  
  // Separate concerns: entry-level proof vs total artifact count
  const entryHasArtifact = [];   // boolean per entry (for gating)
  let provenEntryCount = 0;      // entries with ANY proof (analytics only)
  let totalArtifacts = 0;        // sum of ALL artifact objects (for bonuses)
  
  for (const entry of dayLog.entries) {
    // Count artifacts in this entry
    const entryArtifacts = Array.isArray(entry.artifacts) ? entry.artifacts : [];
    const legacy = (typeof entry.artifact === 'string' && entry.artifact.trim() !== '') ? 1 : 0;
    const artifactCount = entryArtifacts.length + legacy;
    
    // Track if entry has ANY proof (for gating multiplier)
    const hasArtifact = artifactCount > 0;
    entryHasArtifact.push(hasArtifact);
    if (hasArtifact) provenEntryCount++;
    
    // Track TOTAL artifact objects (for bonus calculation)
    totalArtifacts += artifactCount;
  }
  
  // Add day-level artifacts to total
  const dayLevelArtifacts = dayLog.artifacts || [];
  totalArtifacts += dayLevelArtifacts.length;
  const hasDayArtifacts = dayLevelArtifacts.length > 0;
  
  // Calculate minutes with anti-gaming multiplier
  for (let i = 0; i < dayLog.entries.length; i++) {
    const entry = dayLog.entries[i];
    const minutes = entry.minutes || 0;
    const tag = entry.tag?.toLowerCase() || '';
    
    // Anti-gaming: 1.5x if entry OR day has artifacts
    const hasProof = entryHasArtifact[i] || hasDayArtifacts;
    
    if (HIGH_LEVERAGE_TAGS.has(tag)) {
      if (hasProof) {
        hlProvenMinutes += minutes * 1.5;
      } else {
        hlUnprovenMinutes += minutes; // 1.0x - no bonus without proof
      }
    } else {
      driftMinutes += minutes; // Drift always 1.0x
    }
  }
  
  // Revenue actions: structured, capped at 3 (+6 max)
  const revenueActions = dayLog.revenue_actions || [];
  const revenueCount = Math.min(revenueActions.length, 3);
  const revenueBonus = revenueCount * 2;
  
  // Load state for streak
  const state = loadState();
  const streakDays = state.current_streak_days || 0;
  
  // Artifact bonus: +3 first, +1 each additional (cap +6)
  // Uses totalArtifacts (sum of objects), NOT provenEntryCount
  let artifactBonus = 0;
  if (totalArtifacts > 0) {
    artifactBonus = 3 + Math.min(totalArtifacts - 1, 3) * 1; // +3 first, +1 up to 3 more = max 6
  }
  
  // Formula v1.1.1
  const sds = Math.round(
    hlProvenMinutes +
    hlUnprovenMinutes +
    revenueBonus +
    (streakDays * 0.5) -
    (driftMinutes * 1.2) -
    (contextSwitches * 0.3) +
    artifactBonus
  );
  
  return {
    sds,
    high_leverage_minutes: Math.round(hlProvenMinutes + hlUnprovenMinutes),
    hl_proven_minutes: Math.round(hlProvenMinutes),
    hl_unproven_minutes: hlUnprovenMinutes,
    drift_minutes: driftMinutes,
    revenue_actions_count: revenueCount,
    revenue_bonus: revenueBonus,
    context_switches: contextSwitches,
    streak_days: streakDays,
    proven_entry_count: provenEntryCount,
    artifact_count: totalArtifacts,
    artifact_bonus: artifactBonus,
    has_artifacts: totalArtifacts > 0
  };
}

/**
 * Log a work entry (v1.1 with structured artifacts)
 */
function logWorkEntry(entry) {
  const today = new Date().toISOString().slice(0, 10);
  const log = loadDailyLog(today);
  
  // Build structured artifact if provided
  const artifacts = [];
  if (entry.artifact) {
    if (typeof entry.artifact === 'string') {
      artifacts.push({
        type: 'text',
        ref: entry.artifact,
        timestamp: new Date().toISOString()
      });
    } else if (typeof entry.artifact === 'object') {
      artifacts.push({
        ...entry.artifact,
        timestamp: new Date().toISOString()
      });
    }
  }
  
  log.entries.push({
    minutes: entry.minutes || 0,
    tag: entry.tag || 'uncategorized',
    directive: entry.directive || 'T0_invariants',
    artifacts: artifacts, // v1.1: structured
    timestamp: new Date().toISOString(),
    // Agent mode fields (v1.2)
    agent_work: entry.agent_work || false,
    task_description: entry.task_description || null,
    outcome: entry.outcome || null
  });
  
  // Add to aggregate artifacts
  if (artifacts.length > 0) {
    log.artifacts = log.artifacts || [];
    log.artifacts.push(...artifacts);
  }
  
  if (entry.context_switch) {
    log.context_switches = (log.context_switches || 0) + 1;
  }
  
  if (entry.revenue_action) {
    log.revenue_actions = log.revenue_actions || [];
    log.revenue_actions.push({
      kind: entry.revenue_action.kind || 'general',
      ref: entry.revenue_action.ref || null,
      timestamp: new Date().toISOString()
    });
  }
  
  saveDailyLog(log);
  
  return {
    date: today,
    entries_count: log.entries.length,
    artifact_count: log.artifacts.length,
    score_preview: calculateSDS(log).sds
  };
}

/**
 * Log artifact with auto SHA256 (v1.1 auto-capture)
 */
function logArtifact({ type, ref, directive = 'T1_make_jay_billionaire_v1', computeHash = false }) {
  const today = new Date().toISOString().slice(0, 10);
  const log = loadDailyLog(today);
  
  const artifact = {
    type: type || 'file',
    ref: ref || '',
    timestamp: new Date().toISOString()
  };
  
  // Auto-compute SHA256 for files
  if (computeHash && type === 'file' && ref) {
    const hash = hashFile(ref);
    if (hash) {
      artifact.sha256 = hash;
    }
  }
  
  // Add to aggregate artifacts
  log.artifacts = log.artifacts || [];
  log.artifacts.push(artifact);
  
  // Also tag with directive
  artifact.directive = directive;
  
  saveDailyLog(log);
  
  return {
    date: today,
    artifact: artifact,
    artifact_count: log.artifacts.length
  };
}

/**
 * Calculate daily score and update state
 */
function calculateDailyScore(date) {
  const dayLog = loadDailyLog(date);
  const result = calculateSDS(dayLog);
  
  const state = loadState();
  state.last_score = result.sds;
  
  if (result.sds > state.highest_score) {
    state.highest_score = result.sds;
  }
  
  saveState(state);
  
  return result;
}

/**
 * Update streak based on date
 */
function updateStreak(date) {
  const dayLog = loadDailyLog(date);
  const result = calculateSDS(dayLog);
  const state = loadState();
  
  const today = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  
  if (state.last_recorded_date !== today) {
    if (state.last_recorded_date) {
      const prevLog = loadDailyLog(state.last_recorded_date);
      const prevScore = calculateSDS(prevLog).sds;
      
      if (prevScore > 0) {
        state.current_streak_days += 1;
      } else {
        state.current_streak_days = 0;
      }
    }
    state.last_recorded_date = today;
  }
  
  if (result.sds > 0) {
    if (state.current_streak_days === 0 && result.sds > 0) {
      state.current_streak_days = 1;
    }
  } else {
    state.current_streak_days = 0;
  }
  
  saveState(state);
  return state.current_streak_days;
}

/**
 * Update rolling averages
 */
function updateRollingAverages() {
  const state = loadState();
  const today = new Date();
  const scores = [];
  
  for (let i = 0; i < 30; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    
    const logPath = getDailyLogPath(dateStr);
    if (fs.existsSync(logPath)) {
      const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      const score = calculateSDS(log).sds;
      scores.push({ date: dateStr, score });
    }
  }
  
  if (scores.length === 0) {
    return { avg7: 0, avg30: 0 };
  }
  
  const last7 = scores.slice(0, 7);
  const avg7 = last7.reduce((a, b) => a + b.score, 0) / last7.length;
  const avg30 = scores.reduce((a, b) => a + b.score, 0) / scores.length;
  
  state.rolling_7_day_avg = Math.round(avg7);
  state.rolling_30_day_avg = Math.round(avg30);
  
  saveState(state);
  
  return { avg7: state.rolling_7_day_avg, avg30: state.rolling_30_day_avg };
}

/**
 * Check achievements
 */
function checkAchievements(date = new Date().toISOString().slice(0, 10)) {
  const state = loadState();
  const dayLog = loadDailyLog(date);
  const scored = calculateSDS(dayLog);
  const config = loadAchievements();
  
  const unlocked = state.unlocked_achievements || [];
  const newlyUnlocked = [];
  
  // Check per-achievement conditions
  for (const ach of config.achievements) {
    if (unlocked.includes(ach.id)) continue;
    
    let conditionMet = false;
    
    switch (ach.condition) {
      case 'first_artifact_logged':
        conditionMet = scored.artifact_count >= 1;
        break;
      case 'streak_days >= 3':
        conditionMet = scored.streak_days >= 3;
        break;
      case 'streak_days >= 7':
        conditionMet = scored.streak_days >= 7;
        break;
      case 'streak_days >= 14':
        conditionMet = scored.streak_days >= 14;
        break;
      case 'revenue_actions >= 1':
        conditionMet = scored.revenue_actions_count >= 1;
        break;
      case 'drift_minutes <= 15 AND artifact_count >= 1':
        conditionMet = scored.drift_minutes <= 15 && scored.artifact_count >= 1;
        break;
      case 'context_switches == 0 AND high_leverage_minutes >= 90 AND artifact_count >= 1':
        conditionMet = scored.context_switches === 0 && scored.high_leverage_minutes >= 90 && scored.artifact_count >= 1;
        break;
      case 'artifact_count >= 3':
        conditionMet = scored.artifact_count >= 3;
        break;
    }
    
    // Weekly checks need history
    if (ach.condition.includes('in_7_days')) {
      conditionMet = checkWeeklyCondition(ach.condition, date);
    }
    
    if (conditionMet) {
      unlocked.push(ach.id);
      newlyUnlocked.push(ach);
      state.achievement_log.push({
        id: ach.id,
        unlocked_at: new Date().toISOString(),
        date: date
      });
    }
  }
  
  state.unlocked_achievements = unlocked;
  saveState(state);
  
  return { unlocked, newlyUnlocked };
}

function checkWeeklyCondition(condition, date) {
  const dates = getLastNDates(7);
  let artifactCount = 0;
  let revenueCount = 0;
  let positiveDays = 0;
  
  for (const d of dates) {
    const log = loadDailyLog(d);
    const scored = calculateSDS(log);
    artifactCount += scored.artifact_count;
    revenueCount += scored.revenue_actions_count;
    if (scored.sds > 0) positiveDays++;
  }
  
  if (condition === 'artifacts_in_7_days >= 5') return artifactCount >= 5;
  if (condition === 'revenue_actions_in_7_days >= 3') return revenueCount >= 3;
  if (condition === 'positive_days_in_7 >= 5') return positiveDays >= 5;
  return false;
}

/**
 * Auto-capture proof artifacts from git or filesystem
 * mode: 'git' | 'files'
 * Returns: { added: number, artifacts: [], duplicatesSkipped: number }
 */
function autocap(mode = 'git') {
  const today = new Date().toISOString().slice(0, 10);
  const dayLog = loadDailyLog(today);
  const workspaceRoot = path.join(__dirname, '..', '..');
  
  // Track existing artifacts to avoid duplicates
  const existingKeys = new Set(
    (dayLog.artifacts || []).map(a => `${a.type}:${a.ref}`)
  );
  
  const newArtifacts = [];
  let duplicatesSkipped = 0;
  
  // Caps per day
  const commitCount = (dayLog.artifacts || []).filter(a => a.type === 'commit').length;
  const fileCount = (dayLog.artifacts || []).filter(a => a.type === 'file').length;
  
  if (mode === 'git') {
    // Try to capture git commit info
    try {
      const { execSync } = require('child_process');
      
      // Detect if we're in a repo
      const repoRoot = execSync('git rev-parse --show-toplevel', {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      
      // Recursion guard: Skip if in state/ directory
      if (repoRoot.includes('/state/') || repoRoot.includes('/Users/jay/.openclaw/workspace/state/')) {
        return { added: 0, artifacts: [], duplicatesSkipped: 0 };
      }
      
      // Get latest commit hash (short)
      const commitHash = execSync('git rev-parse --short HEAD', {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      
      // Get commit message
      const commitMsg = execSync('git log -1 --pretty=%s', {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      
      // Get current branch
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      
      // Get changed files from this commit only
      const changedFilesOutput = execSync('git diff-tree --no-commit-id --name-only -r HEAD', {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      
      const changedFiles = changedFilesOutput ? changedFilesOutput.split('\n').filter(f => f.length > 0) : [];
      
      // Anti-noise: Skip if only noisy files and >3 files
      const noisyPatterns = ['package-lock.json', 'yarn.lock', '.DS_Store', 'Thumbs.db'];
      const isNoisyOnly = changedFiles.length > 3 && changedFiles.every(f => 
        noisyPatterns.some(pattern => f.includes(pattern))
      );
      if (isNoisyOnly) {
        return { added: 0, artifacts: [], duplicatesSkipped: 0 };
      }
      
      // Get repo name
      const repoName = path.basename(repoRoot);
      
      // Get remote URL (optional)
      let remoteUrl = '';
      try {
        remoteUrl = execSync('git remote get-url origin 2>/dev/null', {
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
      } catch (e) {
        // No remote configured
      }
      
      // Build enriched commit key for duplicate detection
      const commitKey = `commit:${repoName}:${commitHash}`;
      
      // Check for duplicates
      const existingCommitKeys = new Set(
        (dayLog.artifacts || [])
          .filter(a => a.type === 'commit')
          .map(a => `commit:${a.meta?.repo_name || 'unknown'}:${a.ref}`)
      );
      
      if (existingCommitKeys.has(commitKey)) {
        duplicatesSkipped++;
      } else if (commitCount < 10) { // Cap at 10 commits/day
        newArtifacts.push({
          type: 'commit',
          ref: commitHash,
          sha256: null,
          meta: {
            repo_name: repoName,
            repo_root: repoRoot,
            branch: branch,
            message: commitMsg.slice(0, 100),
            remote_url: remoteUrl,
            changed_files_count: changedFiles.length,
            changed_files: changedFiles.slice(0, 10)
          },
          timestamp: new Date().toISOString()
        });
      }
      
      // Add up to 10 changed files as file artifacts
      const filesToAdd = changedFiles.slice(0, 10 - fileCount);
      for (const filePath of filesToAdd) {
        if (fileCount + newArtifacts.filter(a => a.type === 'file').length >= 10) break;
        
        // Skip excluded patterns
        if (shouldSkipFile(filePath)) continue;
        
        const fullPath = path.join(repoRoot, filePath);
        const fileKey = `file:${filePath}`;
        
        if (existingKeys.has(fileKey)) {
          duplicatesSkipped++;
          continue;
        }
        
        // Hash file if <= 2MB
        let fileHash = null;
        let meta = {};
        try {
          const stats = fs.statSync(fullPath);
          if (stats.size <= 2 * 1024 * 1024) {
            fileHash = hashFile(fullPath);
          } else {
            meta.size_bytes = stats.size;
          }
        } catch (e) {
          meta.error = 'file_not_accessible';
        }
        
        newArtifacts.push({
          type: 'file',
          ref: filePath,
          sha256: fileHash,
          meta: Object.keys(meta).length > 0 ? meta : undefined,
          timestamp: new Date().toISOString()
        });
        existingKeys.add(fileKey);
      }
      
    } catch (e) {
      // Git not available or not a git repo
      if (process.env.DEBUG) {
        console.log('⚠️ Git capture failed:', e.message);
      }
    }
    
  } else if (mode === 'files') {
    // Filesystem mode: capture recently modified files
    try {
      const { execSync } = require('child_process');
      
      // Find files modified in last 24 hours, excluding patterns
      const findCmd = `find "${workspaceRoot}" -type f -mtime -1 \
        -not -path "*/state/*" \
        -not -path "*/logs/*" \
        -not -path "*/node_modules/*" \
        -not -path "*/.git/*" \
        -not -path "*/config/trusted_skills.json" \
        -not -name "*.key" -not -name "*.pem" -not -name "*secret*" -not -name "*credential*" \
        2>/dev/null | head -20`;
      
      const output = execSync(findCmd, {
        encoding: 'utf8',
        timeout: 10000,
        shell: '/bin/bash'
      });
      
      const files = output.trim().split('\n').filter(f => f.length > 0);
      
      for (const fullPath of files) {
        if (fileCount + newArtifacts.filter(a => a.type === 'file').length >= 10) break;
        
        const relPath = path.relative(workspaceRoot, fullPath);
        if (shouldSkipFile(relPath)) continue;
        
        const fileKey = `file:${relPath}`;
        if (existingKeys.has(fileKey)) {
          duplicatesSkipped++;
          continue;
        }
        
        // Hash file if <= 2MB
        let fileHash = null;
        let meta = {};
        try {
          const stats = fs.statSync(fullPath);
          if (stats.size <= 2 * 1024 * 1024) {
            fileHash = hashFile(fullPath);
          } else {
            meta.size_bytes = stats.size;
          }
        } catch (e) {
          meta.error = 'file_not_accessible';
        }
        
        newArtifacts.push({
          type: 'file',
          ref: relPath,
          sha256: fileHash,
          meta: Object.keys(meta).length > 0 ? meta : undefined,
          timestamp: new Date().toISOString()
        });
        existingKeys.add(fileKey);
      }
      
    } catch (e) {
      if (process.env.DEBUG) {
        console.log('⚠️ Filesystem capture failed:', e.message);
      }
    }
  }
  
  // Save new artifacts to day log
  if (newArtifacts.length > 0) {
    dayLog.artifacts = [...(dayLog.artifacts || []), ...newArtifacts];
    saveDailyLog(dayLog);
  }
  
  return {
    added: newArtifacts.length,
    artifacts: newArtifacts,
    duplicatesSkipped
  };
}

/**
 * Check if file should be skipped (security/privacy exclusions)
 */
function shouldSkipFile(filePath) {
  const skipPatterns = [
    /state\//,
    /logs\//,
    /node_modules\//,
    /\.git\//,
    /config\/trusted_skills\.json/,
    /trusted_skills/,
    /credentials/,
    /secrets?/,
    /\.key$/,
    /\.pem$/,
    /password/,
    /token/,
    /api_key/,
    /private/
  ];
  
  return skipPatterns.some(pattern => pattern.test(filePath));
}

/**
 * Daily closeout (v1.1)
 */
/**
 * Frictionless closeout - <10 seconds, one summary, one interpretation, one suggestion
 */
function closeout() {
  const today = new Date().toISOString().slice(0, 10);
  
  // Auto-capture git artifacts FIRST (before scoring)
  const captured = autocap('git');
  if (captured.added > 0) {
    console.log(`🤖 Auto-captured ${captured.added} proof(s)`);
    if (captured.duplicatesSkipped > 0) {
      console.log(`   (${captured.duplicatesSkipped} duplicates skipped)`);
    }
  }
  
  // Update state
  updateRollingAverages();
  updateStreak(today);
  
  // Get fresh score (now includes autocap artifacts)
  const summary = getCurrentSDS();
  
  // ONE compact summary line
  console.log(formatSummary(summary));
  
  // ONE interpretation line
  let interpretation = '';
  if (summary.sds <= 0) {
    interpretation = "📉 You're in drift. Ship one proof tonight.";
  } else if (summary.sds > 0 && !summary.has_artifacts) {
    interpretation = "📋 Good effort, but unproven. Add one artifact to lock in multiplier.";
  } else {
    interpretation = "✅ Proven day. Maintain streak.";
  }
  console.log(interpretation);
  
  // ONE next-step suggestion
  const dayLog = loadDailyLog(today);
  const scored = calculateSDS(dayLog);
  
  let suggestion = '';
  if (!summary.has_artifacts) {
    suggestion = "→ Run: node habits/scripts/dopamine_engine.js log_artifact note \"what you shipped\"";
  } else if (summary.revenue_actions_count < 1) {
    suggestion = "→ Run: node habits/scripts/dopamine_engine.js revenue lead \"what revenue move you made\"";
  } else if (summary.context_switches > 3) {
    suggestion = "→ Tomorrow: 90m Deep Work block (no switches)";
  } else {
    // Find top proven tag
    const topTag = dayLog.entries
      .filter(e => (e.artifacts?.length || 0) > 0 || (typeof e.artifact === 'string' && e.artifact.trim()))
      .sort((a, b) => (b.minutes || 0) - (a.minutes || 0))[0]?.tag || 'automation';
    suggestion = `→ Tomorrow: repeat ${topTag} with another artifact`;
  }
  console.log(suggestion);
  
  // Sensory Layer capture (non-blocking, runs in background)
  // Captures high-signal raw inputs for later idea generation
  setTimeout(() => {
    try {
      const { capture } = require('./sensory_capture.js');
      capture({ lookbackHours: 18 });
      // Silently succeeds or fails - never blocks closeout
    } catch (e) {
      // Ignore errors - sensory layer is best-effort
    }
  }, 0);
}

/**
 * Show achievements
 */
function showAchievements() {
  const state = loadState();
  const config = loadAchievements();
  const unlocked = state.unlocked_achievements || [];
  
  console.log('═══════════════════════════════════════');
  console.log('🏆 ACHIEVEMENTS');
  console.log('═══════════════════════════════════════\n');
  
  console.log(`Unlocked: ${unlocked.length}/${config.achievements.length}\n`);
  
  // Show unlocked
  if (unlocked.length > 0) {
    console.log('✅ UNLOCKED:');
    config.achievements
      .filter(a => unlocked.includes(a.id))
      .forEach(a => {
        console.log(`   ${a.icon} ${a.name} (${a.tier})`);
        console.log(`      ${a.description}`);
      });
    console.log();
  }
  
  // Show next closest
  const locked = config.achievements.filter(a => !unlocked.includes(a.id));
  const today = new Date().toISOString().slice(0, 10);
  const dayLog = loadDailyLog(today);
  const scored = calculateSDS(dayLog);
  
  // Simple proximity sort
  const scoredAchievements = locked.map(a => {
    let progress = 0;
    let target = 1;
    
    if (a.condition.includes('3')) { target = 3; }
    if (a.condition.includes('5')) { target = 5; }
    if (a.condition.includes('7')) { target = 7; }
    if (a.condition.includes('14')) { target = 14; }
    
    if (a.condition.includes('artifact_count')) progress = scored.artifact_count;
    if (a.condition.includes('streak_days')) progress = scored.streak_days;
    if (a.condition.includes('revenue_actions')) progress = scored.revenue_actions_count;
    
    return { ...a, progress, target, percent: Math.min(100, (progress / target) * 100) };
  }).sort((a, b) => b.percent - a.percent);
  
  console.log('🔒 NEXT CLOSEST:');
  scoredAchievements.slice(0, 4).forEach(a => {
    const bar = '█'.repeat(Math.floor(a.percent / 10)) + '░'.repeat(10 - Math.floor(a.percent / 10));
    console.log(`   ${a.icon} ${a.name}: [${bar}] ${Math.round(a.percent)}%`);
  });
  
  console.log('\n═══════════════════════════════════════');
}

/**
 * Get last N dates
 */
function getLastNDates(n) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Format compact summary
 */
function formatSummary(summary) {
  const drift = summary.drift_minutes;
  const driftEmoji = drift > 60 ? '🔴' : drift > 30 ? '🟡' : '✅';
  
  return `📊 Strategic Dopamine Score: ${summary.sds}
🔥 Streak: ${summary.streak} days
📈 7-day avg: ${summary.avg7}
📊 30-day avg: ${summary.avg30}
🎯 High leverage: ${summary.high_leverage_minutes} min (${summary.has_artifacts ? '1.5x' : '1.0x - no artifacts!'})
💰 Revenue: ${summary.revenue_actions_count} actions (+${summary.revenue_bonus})
🧾 Artifacts: ${summary.artifact_count} (+${summary.artifact_bonus})
${driftEmoji} Drift: ${summary.drift_minutes} min | Switches: ${summary.context_switches}`;
}

/**
 * AGENT MODE - Synthetic Dopamine for Protheus
 * 
 * These functions provide immediate positive reinforcement for agent work.
 * Call agentLog() when completing any substantive task.
 */

// Active task tracking
const agentActiveTasks = new Map();

/**
 * Start tracking an agent task
 * Returns taskId for later completion
 */
function agentTaskStart({ description, tag = 'automation', directive = 'T1_make_jay_billionaire_v1', estimatedMinutes = 30 }) {
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  agentActiveTasks.set(taskId, {
    description,
    tag,
    directive,
    estimatedMinutes,
    startTime: Date.now(),
    artifacts: []
  });
  return taskId;
}

/**
 * Add an artifact to an active task (before completing)
 */
function agentTaskArtifact(taskId, { type, ref, meta = {} }) {
  const task = agentActiveTasks.get(taskId);
  if (!task) return false;
  task.artifacts.push({ type, ref, meta, timestamp: new Date().toISOString() });
  return true;
}

/**
 * Complete an agent task and trigger dopamine reward
 * This is the main "synthetic dopamine" entry point
 */
function agentTaskComplete(taskId, { outcome = 'success', note = '' } = {}) {
  const task = agentActiveTasks.get(taskId);
  if (!task) {
    console.log('⚠️ Task not found:', taskId);
    return null;
  }
  
  const duration = Math.round((Date.now() - task.startTime) / 60000); // minutes
  agentActiveTasks.delete(taskId);
  
  // Build enriched log entry
  const entry = {
    minutes: duration,
    tag: task.tag,
    directive: task.directive,
    agent_work: true,  // Flag as agent work
    task_description: task.description,
    outcome,
    note,
    artifacts: task.artifacts,
    context_switch: false
  };
  
  // Log to dopamine system
  const logged = logWorkEntry(entry);
  
  // Immediate celebration feedback (synthetic dopamine hit)
  const celebration = agentCelebrate({
    duration,
    artifactCount: task.artifacts.length,
    tag: task.tag,
    outcome,
    description: task.description
  });
  
  return {
    taskId,
    duration,
    entry: logged,
    celebration,
    currentScore: getCurrentSDS()
  };
}

/**
 * Quick log for simple agent tasks (one-liner completion)
 * Use when you don't need task tracking, just want to log + celebrate
 */
function agentLog({ minutes = 15, tag = 'automation', description, artifacts = [], outcome = 'success' }) {
  const entry = {
    minutes,
    tag,
    directive: 'T1_make_jay_billionaire_v1',
    agent_work: true,
    task_description: description,
    outcome,
    artifacts: artifacts.map(a => ({
      type: a.type || 'output',
      ref: a.ref,
      timestamp: new Date().toISOString()
    }))
  };
  
  const logged = logWorkEntry(entry);
  
  const celebration = agentCelebrate({
    duration: minutes,
    artifactCount: artifacts.length,
    tag,
    outcome,
    description
  });
  
  return { entry: logged, celebration, currentScore: getCurrentSDS() };
}

/**
 * Immediate positive feedback (the "dopamine hit")
 * Prints celebration + returns structured reward object
 */
function agentCelebrate({ duration, artifactCount, tag, outcome, description }) {
  const celebrations = {
    automation: ['🤖', '⚙️', '🔧', '💻'],
    product: ['🚀', '✨', '🎯', '💡'],
    system_building: ['🏗️', '🔨', '⚡', '🧬'],
    revenue: ['💰', '📈', '💵', '🏆'],
    growth: ['🌱', '📊', '🔥', '⭐'],
    default: ['✅', '🎉', '💪', '🔥']
  };
  
  const emojis = celebrations[tag] || celebrations.default;
  const primaryEmoji = emojis[Math.floor(Math.random() * emojis.length)];
  
  const phrases = [
    'Task crushed!',
    'Shipped!',
    'Progress locked in!',
    'Another win!',
    'Momentum building!',
    'Output delivered!'
  ];
  const phrase = phrases[Math.floor(Math.random() * phrases.length)];
  
  // Bonus for artifacts
  const artifactBonus = artifactCount > 0 ? ` (+${artifactCount} artifacts)` : '';
  const timeNote = duration > 0 ? ` in ${duration} min` : '';
  
  // Print celebration
  console.log(`\n${primaryEmoji} ${phrase}${timeNote}${artifactBonus}`);
  console.log(`   → ${description.slice(0, 60)}${description.length > 60 ? '...' : ''}`);
  
  // Check for new achievements
  const today = new Date().toISOString().slice(0, 10);
  const achievements = checkAchievements(today);
  const newAchievements = achievements.newlyUnlocked || [];
  if (newAchievements.length > 0) {
    newAchievements.forEach(a => {
      console.log(`\n🏆 ACHIEVEMENT UNLOCKED: ${a.icon} ${a.name}!`);
      console.log(`   ${a.description}`);
    });
  }
  
  return {
    emoji: primaryEmoji,
    phrase,
    duration,
    artifactCount,
    newAchievements: newAchievements.map(a => a.id)
  };
}

/**
 * Get current agent session stats
 */
function agentStats() {
  const today = new Date().toISOString().slice(0, 10);
  const dayLog = loadDailyLog(today);
  const agentEntries = (dayLog.entries || []).filter(e => e.agent_work);
  
  return {
    date: today,
    tasksCompleted: agentEntries.length,
    totalMinutes: agentEntries.reduce((sum, e) => sum + (e.minutes || 0), 0),
    artifactsCreated: (dayLog.artifacts || []).filter(a => 
      agentEntries.some(e => (e.artifacts || []).some(ea => ea.ref === a.ref))
    ).length,
    activeTasks: agentActiveTasks.size,
    currentScore: getCurrentSDS()
  };
}

/**
 * Get last N dates
 */
function getLastNDates(n) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Get current SDS summary
 */
function getCurrentSDS() {
  const today = new Date().toISOString().slice(0, 10);
  const dayLog = loadDailyLog(today);
  const result = calculateSDS(dayLog);
  const state = loadState();
  
  return {
    date: today,
    sds: result.sds,
    streak: result.streak_days,
    avg7: state.rolling_7_day_avg,
    avg30: state.rolling_30_day_avg,
    high_leverage_minutes: result.high_leverage_minutes,
    drift_minutes: result.drift_minutes,
    revenue_actions_count: result.revenue_actions_count,
    revenue_bonus: result.revenue_bonus,
    context_switches: result.context_switches,
    artifact_count: result.artifact_count,
    artifact_bonus: result.artifact_bonus,
    has_artifacts: result.has_artifacts
  };
}

module.exports = {
  // Core functions
  calculateSDS,
  logWorkEntry,
  logArtifact,
  autocap,
  shouldSkipFile,
  calculateDailyScore,
  updateStreak,
  updateRollingAverages,
  getCurrentSDS,
  formatSummary,
  closeout,
  showAchievements,
  checkAchievements,
  HIGH_LEVERAGE_TAGS,
  loadState,
  saveState,
  loadDailyLog,
  saveDailyLog,
  hashFile,
  // Agent mode (synthetic dopamine for Protheus)
  agentTaskStart,
  agentTaskArtifact,
  agentTaskComplete,
  agentLog,
  agentCelebrate,
  agentStats
};

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  
  switch (cmd) {
    case 'log': {
      const entry = {
        minutes: parseInt(args[1]) || 0,
        tag: args[2] || 'uncategorized',
        directive: args[3] || 'T1_make_jay_billionaire_v1',
        artifact: args.slice(4).join(' ').trim() || null
      };
      const logged = logWorkEntry(entry);
      console.log(`Logged: ${logged.entries_count} entries, ${logged.artifact_count} artifacts`);
      break;
    }
    
    case 'log_artifact': {
      const type = args[1] || 'file';
      const ref = args[2];
      const directive = args[3] || 'T1_make_jay_billionaire_v1';
      const computeHash = type === 'file';
      
      if (!ref) {
        console.log('Usage: log_artifact <type> <ref> [directive]');
        console.log('Example: log_artifact file patches/websocket.js T1_make_jay_billionaire_v1');
        break;
      }
      
      const result = logArtifact({ type, ref, directive, computeHash });
      console.log(`Logged artifact #${result.artifact_count}:`);
      console.log(`  Type: ${result.artifact.type}`);
      console.log(`  Ref: ${result.artifact.ref}`);
      if (result.artifact.sha256) {
        console.log(`  SHA256: ${result.artifact.sha256.slice(0, 16)}...`);
      }
      break;
    }
    
    case 'score':
      console.log(formatSummary(getCurrentSDS()));
      break;
    
    case 'update':
      updateRollingAverages();
      updateStreak(new Date().toISOString().slice(0, 10));
      console.log(formatSummary(getCurrentSDS()));
      break;
    
    case 'closeout':
      closeout();
      break;
    
    case 'revenue': {
      // Frictionless revenue action logging
      const kind = args[1];
      const ref = args.slice(2).join(' ').trim() || null;
      
      if (!kind) {
        console.log('Usage: revenue <kind> [ref]');
        console.log('  kind: lead|proposal|invoice|close|launch');
        console.log('  ref: optional description/reference');
        break;
      }
      
      const today = new Date().toISOString().slice(0, 10);
      const dayLog = loadDailyLog(today);
      
      dayLog.revenue_actions.push({
        kind: kind,
        ref: ref,
        timestamp: new Date().toISOString()
      });
      
      saveDailyLog(dayLog);
      console.log(`💰 Logged revenue action: ${kind}${ref ? ' - ' + ref : ''}`);
      console.log(`   Total today: ${dayLog.revenue_actions.length} (cap enforced in scoring)`);
      break;
    }
    
    case 'switch': {
      // Quick context switch tap
      const today = new Date().toISOString().slice(0, 10);
      const dayLog = loadDailyLog(today);
      
      dayLog.context_switches = (dayLog.context_switches || 0) + 1;
      saveDailyLog(dayLog);
      
      console.log(`🔄 Context switch #${dayLog.context_switches} logged`);
      break;
    }
    
    case 'autocap': {
      // Auto-capture proof artifacts
      const mode = args[1] || 'git';
      
      if (!['git', 'files'].includes(mode)) {
        console.log('Usage: autocap [mode]');
        console.log('  mode: git (default) | files');
        console.log('  git: captures latest commit + changed files');
        console.log('  files: captures recently modified workspace files');
        break;
      }
      
      const result = autocap(mode);
      console.log(`🤖 Auto-captured ${result.added} proof artifact(s)`);
      if (result.duplicatesSkipped > 0) {
        console.log(`   (${result.duplicatesSkipped} duplicates skipped)`);
      }
      if (result.added > 0) {
        console.log('Captured:');
        result.artifacts.forEach(a => {
          console.log(`  ${a.type}: ${a.ref.slice(0, 60)}${a.ref.length > 60 ? '...' : ''}`);
        });
      }
      break;
    }
    
    case 'achieve':
      showAchievements();
      break;
    
    case 'agent_test': {
      // Quick test of agent dopamine system
      console.log('🤖 Testing Agent Dopamine System...\n');
      
      // Test 1: Quick log
      const log1 = agentLog({
        minutes: 5,
        tag: 'automation',
        description: 'Created git hook system',
        artifacts: [{ type: 'file', ref: 'habits/git-hooks/post-commit' }],
        outcome: 'success'
      });
      console.log('\n📊 Current Score:', log1.currentScore.sds);
      
      // Test 2: Task tracking
      const taskId = agentTaskStart({
        description: 'Implement agent dopamine',
        tag: 'system_building',
        estimatedMinutes: 30
      });
      
      // Simulate work...
      agentTaskArtifact(taskId, { type: 'code', ref: 'dopamine_engine.js' });
      agentTaskArtifact(taskId, { type: 'test', ref: 'agent_tests' });
      
      // Complete
      const completed = agentTaskComplete(taskId, { outcome: 'success' });
      console.log('\n✅ Task completed in', completed.duration, 'minutes');
      console.log('📊 New Score:', completed.currentScore.sds);
      
      // Stats
      console.log('\n📈 Agent Stats Today:');
      const stats = agentStats();
      console.log('  Tasks completed:', stats.tasksCompleted);
      console.log('  Total minutes:', stats.totalMinutes);
      console.log('  Artifacts created:', stats.artifactsCreated);
      break;
    }
    
    case 'agent_stats': {
      const stats = agentStats();
      console.log('🤖 Agent Session Stats');
      console.log('═══════════════════════');
      console.log(`Date: ${stats.date}`);
      console.log(`Tasks completed: ${stats.tasksCompleted}`);
      console.log(`Total minutes: ${stats.totalMinutes}`);
      console.log(`Artifacts created: ${stats.artifactsCreated}`);
      console.log(`Active tasks: ${stats.activeTasks}`);
      console.log(`\n📊 Current SDS: ${stats.currentScore.sds}`);
      break;
    }
    
    default:
      console.log('Dopamine Reward Center v1.2.0 - Agent Mode');
      console.log('');
      console.log('HUMAN COMMANDS:');
      console.log('  log <minutes> <tag> <directive> [artifact_desc]');
      console.log('  log_artifact <type> <ref> [directive]');
      console.log('  score - Show current SDS');
      console.log('  update - Update streaks and averages');
      console.log('  closeout - Daily closeout (<10s, auto-captures git proofs)');
      console.log('  autocap [git|files] - Auto-capture proof artifacts');
      console.log('  revenue <kind> [ref] - Log revenue action');
      console.log('  switch - Tap to log context switch');
      console.log('  achieve - Show achievements');
      console.log('');
      console.log('AGENT COMMANDS (Synthetic Dopamine):');
      console.log('  agent_test - Test the agent reward system');
      console.log('  agent_stats - Show agent work stats');
      console.log('');
      console.log('AGENT API (for programmatic use):');
      console.log('  agentTaskStart({description, tag, estimatedMinutes}) → taskId');
      console.log('  agentTaskArtifact(taskId, {type, ref}) → bool');
      console.log('  agentTaskComplete(taskId, {outcome}) → result');
      console.log('  agentLog({minutes, tag, description, artifacts}) → result');
      console.log('  agentStats() → stats');
  }
}
