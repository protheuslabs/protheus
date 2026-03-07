#!/usr/bin/env node
/**
 * sensory_digest.js - Sensory Layer v1.1 Phase 1
 * 
 * Rule-based digest generator for sensory and AIE events.
 * NO LLM calls. Pure deterministic analysis.
 * 
 * Outputs:
 *   - state/sensory/digests/YYYY-MM-DD.md (daily)
 *   - state/sensory/digests/YYYY-WW.md (weekly)
 *   - state/sensory/anomalies/YYYY-MM-DD.json (detected)
 */

const fs = require('fs');
const path = require('path');

const SENSORY_DIR = path.join(__dirname, '..', '..', 'state', 'sensory');
const RAW_DIR = path.join(SENSORY_DIR, 'raw');
const DIGESTS_DIR = path.join(SENSORY_DIR, 'digests');
const ANOMALIES_DIR = path.join(SENSORY_DIR, 'anomalies');
const AIE_DIR = path.join(__dirname, '..', '..', 'state', 'aie');
const AIE_EVENTS_DIR = path.join(AIE_DIR, 'events');

// Ensure directories exist
function ensureDirs() {
  [DIGESTS_DIR, ANOMALIES_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

// Get ISO week number (YYYY-WW format)
function getWeekKey(dateStr) {
  const date = new Date(dateStr);
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Get dates for last N days
function getLastNDates(n, endDateStr) {
  const dates = [];
  const endDate = endDateStr ? new Date(endDateStr) : new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(endDate);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// Load sensory events for a date
function loadSensoryEvents(dateStr) {
  const logPath = path.join(RAW_DIR, `${dateStr}.jsonl`);
  if (!fs.existsSync(logPath)) return [];
  
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(l => l);
  return lines.map(line => {
    try { return JSON.parse(line); } catch (e) { return null; }
  }).filter(e => e);
}

// Load AIE events for a date
function loadAIEEvents(dateStr) {
  const logPath = path.join(AIE_EVENTS_DIR, `${dateStr}.jsonl`);
  if (!fs.existsSync(logPath)) return [];
  
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(l => l);
  return lines.map(line => {
    try { return JSON.parse(line); } catch (e) { return null; }
  }).filter(e => e);
}

// Analyze events for a date
function analyzeDay(dateStr) {
  const sensory = loadSensoryEvents(dateStr);
  const aie = loadAIEEvents(dateStr);
  
  // Count by type
  const typeCounts = {};
  sensory.forEach(e => {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  });
  
  // Work roots touched
  const rootCounts = {};
  sensory.filter(e => e.root).forEach(e => {
    rootCounts[e.root] = (rootCounts[e.root] || 0) + 1;
  });
  
  // Top changed paths (file_change only, cap at 10)
  const pathCounts = {};
  sensory.filter(e => e.type === 'file_change' && e.path).forEach(e => {
    pathCounts[e.path] = (pathCounts[e.path] || 0) + 1;
  });
  const topPaths = Object.entries(pathCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  
  // Git dirty snapshots with detailed metrics
  const gitSnapshots = sensory.filter(e => e.type === 'git_dirty').map(e => ({
    branch: e.branch,
    changed_count: e.changed_count,
    repo: e.repo_root
  }));
  
  // Git dirty metrics (v1.1.1: explicit naming)
  const gitDirtyEvents = gitSnapshots.length;
  const gitDirtyChangedCounts = gitSnapshots.map(g => g.changed_count || 0);
  const gitDirtyChangedCountMax = gitDirtyChangedCounts.length > 0 ? Math.max(...gitDirtyChangedCounts) : 0;
  const gitDirtyChangedCountAvg = gitDirtyChangedCounts.length > 0 
    ? Math.round(gitDirtyChangedCounts.reduce((a, b) => a + b, 0) / gitDirtyChangedCounts.length) 
    : 0;
  const gitDirtyChangedCountLast = gitDirtyChangedCounts.length > 0 
    ? gitDirtyChangedCounts[gitDirtyChangedCounts.length - 1] 
    : 0;
  
  // AIE analysis
  const aieCounts = {
    patch_applied: aie.filter(e => e.type === 'patch_applied').length,
    test_run: aie.filter(e => e.type === 'test_run').length,
    verified: aie.filter(e => e.type === 'patch_applied' && e.test_log_sha256).length,
    unverified: aie.filter(e => e.type === 'patch_applied' && !e.test_log_sha256 && e.tests_passed === true).length
  };
  
  // Calculate AQS if scorer available
  let aqs = null;
  try {
    const scorer = require('./aie_scorer.js');
    aqs = scorer.getCurrentAQS();
  } catch (e) {
    // AIE scorer not available
  }
  
  // Signal vs Noise (ensure signalRatio is NUMBER, not string)
  const valuableEvents = sensory.filter(e => 
    e.type === 'git_dirty' || e.type === 'note' || (e.type === 'file_change' && e.bytes > 100)
  ).length;
  const totalEvents = sensory.length;
  const signalRatio = totalEvents > 0 ? Math.round((valuableEvents / totalEvents) * 100) / 100 : 0;
  
  return {
    date: dateStr,
    sensory: {
      total: sensory.length,
      typeCounts,
      rootCounts,
      topPaths,
      gitSnapshots,
      gitDirtyEvents,
      gitDirtyChangedCountMax,
      gitDirtyChangedCountAvg,
      gitDirtyChangedCountLast,
      signalRatio,
      valuableEvents
    },
    aie: {
      total: aie.length,
      counts: aieCounts,
      aqs
    }
  };
}

// Detect anomalies for a date (using 7-day lookback)
function detectAnomalies(dateStr) {
  const dates = getLastNDates(7, dateStr);
  const analyses = dates.map(d => analyzeDay(d));
  const current = analyses[analyses.length - 1];
  const previous = analyses.slice(0, -1);
  
  const anomalies = [];
  
  // Skip if no data for current day
  if (current.sensory.total === 0 && current.aie.total === 0) {
    return { date: dateStr, anomalies: [], metrics: {} };
  }
  
  // Helper: compute 7-day average
  const avg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  
  // 1. File change volume spike
  const fileChangeCounts = previous.map(a => a.sensory.typeCounts.file_change || 0);
  const avgFileChanges = avg(fileChangeCounts);
  const currentFileChanges = current.sensory.typeCounts.file_change || 0;
  const hardCap = 200;
  
  if (currentFileChanges > hardCap || (avgFileChanges > 0 && currentFileChanges > avgFileChanges * 2)) {
    anomalies.push({
      type: 'file_change_spike',
      severity: currentFileChanges > hardCap ? 'high' : 'medium',
      message: `File change volume (${currentFileChanges}) exceeds threshold (avg: ${avgFileChanges.toFixed(1)}, cap: ${hardCap})`,
      value: currentFileChanges,
      threshold: Math.max(hardCap, avgFileChanges * 2)
    });
  }
  
  // 2. Git dirty spike (v1.1.1: use max changed_count consistently)
  const gitDirtyMaxCounts = previous.map(a => a.sensory.gitDirtyChangedCountMax || 0);
  const avgGitDirtyMax = avg(gitDirtyMaxCounts);
  const currentGitDirtyMax = current.sensory.gitDirtyChangedCountMax;
  
  if (avgGitDirtyMax > 0 && currentGitDirtyMax > avgGitDirtyMax * 2) {
    anomalies.push({
      type: 'git_dirty_spike',
      severity: 'medium',
      message: `Git uncommitted changes max (${currentGitDirtyMax}) exceeds 2x 7-day average max (${avgGitDirtyMax.toFixed(1)})`,
      value: currentGitDirtyMax,
      threshold: Math.round(avgGitDirtyMax * 2)
    });
  }
  
  // 3. High churn detection (same path modified ≥3 days in lookback)
  const pathDayCounts = {};
  analyses.forEach(a => {
    a.sensory.topPaths.forEach(([p, count]) => {
      pathDayCounts[p] = (pathDayCounts[p] || 0) + 1;
    });
  });
  
  Object.entries(pathDayCounts).forEach(([p, days]) => {
    if (days >= 3) {
      anomalies.push({
        type: 'high_churn',
        severity: 'medium',
        message: `File '${p}' modified across ${days} days (high churn detected)`,
        path: p,
        days
      });
    }
  });
  
  // 4. AQS drop
  if (current.aie.aqs) {
    const aqsScores = previous.map(a => a.aie.aqs?.today?.score || 0).filter(s => s > 0);
    const avgAQS = avg(aqsScores);
    const currentAQS = current.aie.aqs.today.score;
    
    if (avgAQS > 0 && currentAQS < avgAQS - 20) {
      anomalies.push({
        type: 'aqs_drop',
        severity: 'high',
        message: `AQS dropped to ${currentAQS} (7-day avg: ${avgAQS.toFixed(1)}, threshold: -20)`,
        value: currentAQS,
        avg: avgAQS,
        threshold: avgAQS - 20
      });
    }
  }
  
  // 5. Rework signal (revert events or failing patches)
  const revertCount = current.aie.counts.revert || 0;
  const failingPatches = current.aie.total > 0 ? 
    current.aie.counts.patch_applied - current.aie.counts.verified - current.aie.counts.unverified : 0;
  
  if (revertCount > 0) {
    anomalies.push({
      type: 'rework_signal',
      severity: 'medium',
      message: `${revertCount} revert(s) detected today (rework signal)`,
      reverts: revertCount
    });
  }
  
  return {
    date: dateStr,
    anomalies,
    metrics: {
      file_changes: currentFileChanges,
      git_dirty_events: current.sensory.gitDirtyEvents,
      git_dirty_changed_count_max: current.sensory.gitDirtyChangedCountMax,
      git_dirty_changed_count_avg: current.sensory.gitDirtyChangedCountAvg,
      git_dirty_changed_count_last: current.sensory.gitDirtyChangedCountLast,
      aqs: current.aie.aqs?.today?.score || 0,
      signal_ratio: current.sensory.signalRatio
    }
  };
}

// Generate daily digest markdown
function generateDailyDigest(analysis) {
  const { date, sensory, aie } = analysis;
  
  let md = `# Sensory Digest: ${date}\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  
  // Overview (v1.1.1: show git_dirty metrics explicitly)
  md += `## 📊 Overview\n\n`;
  md += `- **Sensory events**: ${sensory.total}\n`;
  md += `- **AIE events**: ${aie.total}\n`;
  md += `- **Signal/Noise ratio**: ${sensory.signalRatio} (${sensory.valuableEvents} valuable / ${sensory.total} total)\n`;
  md += `- **Git dirty events**: ${sensory.gitDirtyEvents} (max changed_count: ${sensory.gitDirtyChangedCountMax})\n\n`;
  
  // Event type counts
  md += `## 📁 Event Breakdown\n\n`;
  md += `| Type | Count |\n`;
  md += `|------|-------|\n`;
  Object.entries(sensory.typeCounts).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
    md += `| ${type} | ${count} |\n`;
  });
  md += `\n`;
  
  // Work roots
  md += `## 🌳 Work Roots Touched\n\n`;
  md += `| Root | Events |\n`;
  md += `|------|--------|\n`;
  Object.entries(sensory.rootCounts).sort((a, b) => b[1] - a[1]).forEach(([root, count]) => {
    const shortRoot = root.replace(process.env.HOME, '~');
    md += `| \`${shortRoot}\` | ${count} |\n`;
  });
  md += `\n`;
  
  // Top paths
  md += `## 📝 Top Changed Paths (Top 10)\n\n`;
  if (sensory.topPaths.length > 0) {
    md += `| Path | Changes |\n`;
    md += `|------|---------|\n`;
    sensory.topPaths.forEach(([p, count]) => {
      md += `| \`${p}\` | ${count} |\n`;
    });
  } else {
    md += `_No file changes recorded_\n`;
  }
  md += `\n`;
  
  // Git snapshots
  md += `## 🔀 Git Status Snapshots\n\n`;
  if (sensory.gitSnapshots.length > 0) {
    md += `| Repo | Branch | Uncommitted Files |\n`;
    md += `|------|--------|-------------------|\n`;
    sensory.gitSnapshots.forEach(g => {
      const shortRepo = (g.repo || '').replace(process.env.HOME, '~');
      md += `| \`${shortRepo}\` | ${g.branch} | ${g.changed_count} |\n`;
    });
  } else {
    md += `_No git status snapshots_\n`;
  }
  md += `\n`;
  
  // AIE section
  md += `## 🤖 Agent Quality (AIE)\n\n`;
  if (aie.aqs) {
    const today = aie.aqs.today;
    md += `- **AQS Score**: ${today.score}${today.cap_applied ? ' (capped)' : ''}\n`;
    md += `- **Grade**: ${aie.aqs.quality_grade}\n`;
    md += `- **7-day avg**: ${aie.aqs.rolling7.avg_score}\n`;
    md += `- **30-day avg**: ${aie.aqs.rolling30.avg_score}\n`;
    md += `- **Events today**: ${today.events}\n`;
  } else {
    md += `- **AQS**: _Not available_\n`;
  }
  md += `- **Patches applied**: ${aie.counts.patch_applied}\n`;
  md += `- **Test runs**: ${aie.counts.test_run}\n`;
  md += `- **Verified patches**: ${aie.counts.verified}\n`;
  md += `- **Unverified claims**: ${aie.counts.unverified}\n\n`;
  
  return md;
}

// Generate weekly digest
function generateWeeklyDigest(dates, analyses) {
  const weekKey = getWeekKey(dates[dates.length - 1]);
  
  // Aggregate stats
  const totals = {
    sensory: analyses.reduce((sum, a) => sum + a.sensory.total, 0),
    aie: analyses.reduce((sum, a) => sum + a.aie.total, 0),
    patches: analyses.reduce((sum, a) => sum + a.aie.counts.patch_applied, 0),
    testRuns: analyses.reduce((sum, a) => sum + a.aie.counts.test_run, 0)
  };
  
  // Top churn across week
  const pathWeekCounts = {};
  analyses.forEach(a => {
    a.sensory.topPaths.forEach(([p, count]) => {
      pathWeekCounts[p] = (pathWeekCounts[p] || 0) + count;
    });
  });
  const topWeekPaths = Object.entries(pathWeekCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  
  // Top directories (extract dir from path)
  const dirCounts = {};
  Object.entries(pathWeekCounts).forEach(([p, count]) => {
    const dir = path.dirname(p);
    dirCounts[dir] = (dirCounts[dir] || 0) + count;
  });
  const topDirs = Object.entries(dirCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  
  // Collect all anomalies for the week
  const allAnomalies = [];
  dates.forEach(dateStr => {
    const anomalyData = detectAnomalies(dateStr);
    anomalyData.anomalies.forEach(a => {
      allAnomalies.push({ ...a, date: dateStr });
    });
  });
  
  // Trend delta vs previous week (if we had data)
  let delta = { sensory: 0, aie: 0 };
  // Would need to load previous week for real delta
  
  let md = `# Sensory Weekly Digest: ${weekKey}\n\n`;
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Period: ${dates[0]} to ${dates[dates.length - 1]}\n\n`;
  
  md += `## 📈 Week Totals\n\n`;
  md += `- **Sensory events**: ${totals.sensory}\n`;
  md += `- **AIE events**: ${totals.aie}\n`;
  md += `- **Patches applied**: ${totals.patches}\n`;
  md += `- **Test runs**: ${totals.testRuns}\n\n`;
  
  md += `## 🔄 Top Churn Files (Week)\n\n`;
  if (topWeekPaths.length > 0) {
    md += `| Path | Total Changes |\n`;
    md += `|------|---------------|\n`;
    topWeekPaths.forEach(([p, count]) => {
      md += `| \`${p}\` | ${count} |\n`;
    });
  } else {
    md += `_No file changes recorded_\n`;
  }
  md += `\n`;
  
  md += `## 📂 Top Active Directories\n\n`;
  if (topDirs.length > 0) {
    md += `| Directory | Changes |\n`;
    md += `|-----------|---------|\n`;
    topDirs.forEach(([d, count]) => {
      md += `| \`${d}\` | ${count} |\n`;
    });
  } else {
    md += `_No directory activity_\n`;
  }
  md += `\n`;
  
  md += `## ⚠️ Weekly Anomalies (${allAnomalies.length} total)\n\n`;
  if (allAnomalies.length > 0) {
    md += `| Date | Type | Severity | Message |\n`;
    md += `|------|------|----------|---------|\n`;
    allAnomalies.forEach(a => {
      md += `| ${a.date} | ${a.type} | ${a.severity} | ${a.message.slice(0, 50)}${a.message.length > 50 ? '...' : ''} |\n`;
    });
  } else {
    md += `_No anomalies detected this week_\n`;
  }
  md += `\n`;
  
  return md;
}

// Main CLI
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dateStr = args[1] || new Date().toISOString().slice(0, 10);
  
  ensureDirs();
  
  switch (cmd) {
    case 'daily': {
      const analysis = analyzeDay(dateStr);
      const digest = generateDailyDigest(analysis);
      const digestPath = path.join(DIGESTS_DIR, `${dateStr}.md`);
      fs.writeFileSync(digestPath, digest);
      console.log(`✅ Daily digest: ${digestPath}`);
      
      // Also generate anomalies
      const anomalyData = detectAnomalies(dateStr);
      const anomalyPath = path.join(ANOMALIES_DIR, `${dateStr}.json`);
      fs.writeFileSync(anomalyPath, JSON.stringify(anomalyData, null, 2));
      console.log(`✅ Anomalies: ${anomalyPath} (${anomalyData.anomalies.length} detected)`);
      
      // Print summary
      console.log(`\n📊 ${dateStr} Summary:`);
      console.log(`   Sensory events: ${analysis.sensory.total}`);
      console.log(`   AIE events: ${analysis.aie.total}`);
      console.log(`   Signal ratio: ${analysis.sensory.signalRatio}`);
      if (anomalyData.anomalies.length > 0) {
        console.log(`   ⚠️  Anomalies: ${anomalyData.anomalies.length}`);
      }
      break;
    }
    
    case 'weekly': {
      const dates = getLastNDates(7, dateStr);
      const analyses = dates.map(d => analyzeDay(d));
      const digest = generateWeeklyDigest(dates, analyses);
      const weekKey = getWeekKey(dateStr);
      const digestPath = path.join(DIGESTS_DIR, `${weekKey}.md`);
      fs.writeFileSync(digestPath, digest);
      console.log(`✅ Weekly digest: ${digestPath}`);
      
      // Print summary
      const totalSensory = analyses.reduce((s, a) => s + a.sensory.total, 0);
      const totalAIE = analyses.reduce((s, a) => s + a.aie.total, 0);
      console.log(`\n📊 Week ${weekKey} Summary:`);
      console.log(`   Total sensory events: ${totalSensory}`);
      console.log(`   Total AIE events: ${totalAIE}`);
      break;
    }
    
    default: {
      console.log('Sensory Layer v1.1 Digest Generator');
      console.log('');
      console.log('Usage:');
      console.log('  node client/habits/scripts/sensory_digest.js daily [YYYY-MM-DD]');
      console.log('  node client/habits/scripts/sensory_digest.js weekly [YYYY-MM-DD]');
      console.log('');
      console.log('Outputs:');
      console.log('  state/sensory/digests/YYYY-MM-DD.md   (daily)');
      console.log('  state/sensory/digests/YYYY-WW.md      (weekly)');
      console.log('  state/sensory/anomalies/YYYY-MM-DD.json');
    }
  }
}

// Export for tests
module.exports = {
  analyzeDay,
  detectAnomalies,
  generateDailyDigest,
  generateWeeklyDigest,
  getWeekKey,
  getLastNDates,
  loadSensoryEvents,
  loadAIEEvents
};

// Run if called directly
if (require.main === module) {
  main();
}
