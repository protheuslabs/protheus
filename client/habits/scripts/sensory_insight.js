#!/usr/bin/env node
/**
 * sensory_insight.js - Sensory Layer v1.2.0 (INSIGHT)
 * 
 * Digest → Proposals generator.
 * Reads ONLY digests and anomalies, NEVER raw JSONL logs.
 * Deterministic rules only, NO LLM calls.
 * 
 * Commands:
 *   node client/habits/scripts/sensory_insight.js daily [YYYY-MM-DD]
 *   node client/habits/scripts/sensory_insight.js weekly [YYYY-MM-DD]
 * 
 * Outputs:
 *   state/sensory/insights/YYYY-MM-DD.md (human-readable)
 *   state/sensory/proposals/YYYY-MM-DD.json (machine-readable)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// v1.2.0: Support SENSORY_TEST_DIR for isolated testing
const testDir = process.env.SENSORY_TEST_DIR;
const SENSORY_DIR = testDir || path.join(__dirname, '..', '..', 'state', 'sensory');
const DIGESTS_DIR = path.join(SENSORY_DIR, 'digests');
const ANOMALIES_DIR = path.join(SENSORY_DIR, 'anomalies');
const INSIGHTS_DIR = path.join(SENSORY_DIR, 'insights');
const PROPOSALS_DIR = path.join(SENSORY_DIR, 'proposals');
const SENSORY_INSIGHT_MIN_VALIDATION = Math.max(1, Number(process.env.SENSORY_INSIGHT_MIN_VALIDATION || 1));
const SENSORY_INSIGHT_REQUIRE_COMMAND = String(process.env.SENSORY_INSIGHT_REQUIRE_COMMAND || '1') !== '0';
const META_COORDINATION_RE = /\b(review|prioriti[sz]e|triage|assess|evaluate|health check|high leverage)\b/i;
const CONCRETE_CHANGE_RE = /\b(file|config|script|collector|parser|test|queue|registry|policy|budget|endpoint|model|hook|cadence|capture|digest)\b/i;
const MEASURABLE_OUTCOME_RE = /\b(\d+|rate|ratio|latency|error|count|threshold|target|coverage|artifact|pass|fail|increase|decrease|drop|rise|recover|clear|above|below)\b/i;
const COMMAND_PREFIX_RE = /^(node|npm|npx|python|python3|bash|sh|git|curl)\b/i;

// v1.2.0: HARD CONSTRAINT - This module ONLY reads digests and anomalies
// Raw JSONL event logs are INTENTIONALLY NOT USED - NEVER read from raw logs

// Ensure output directories exist
function ensureDirs() {
  [INSIGHTS_DIR, PROPOSALS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// Load digest for a date (markdown)
function loadDigest(dateStr) {
  const digestPath = path.join(DIGESTS_DIR, `${dateStr}.md`);
  if (!fs.existsSync(digestPath)) {
    return null;
  }
  return fs.readFileSync(digestPath, 'utf8');
}

// Load anomalies for a date (JSON)
function loadAnomalies(dateStr) {
  const anomalyPath = path.join(ANOMALIES_DIR, `${dateStr}.json`);
  if (!fs.existsSync(anomalyPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(anomalyPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Get week key from date
function getWeekKey(dateStr) {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const week = Math.ceil((date.getMonth() + 1) * date.getDate() / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Generate proposal ID
let proposalCounter = 0;
function generateProposalId() {
  proposalCounter++;
  return `P${String(proposalCounter).padStart(3, '0')}`;
}

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function normalizeLine(v) {
  return normalizeText(v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sha16(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16);
}

// Proposal builder
function createProposal(type, title, expectedImpact, risk, validation, suggestedCommand) {
  return {
    id: generateProposalId(),
    title,
    type,
    evidence: [],
    expected_impact: expectedImpact,
    risk,
    validation: validation || [],
    suggested_next_command: suggestedCommand
  };
}

function normalizeImpactWeight(v) {
  const raw = normalizeText(v).toLowerCase();
  if (raw === 'high') return 3;
  if (raw === 'medium') return 2;
  if (raw === 'low') return 1;
  return 0;
}

function proposalQualityScore(p) {
  const validation = Array.isArray(p && p.validation) ? p.validation : [];
  const commandLen = normalizeText(p && p.suggested_next_command).length;
  return (normalizeImpactWeight(p && p.expected_impact) * 10) + validation.length + Math.min(5, Math.floor(commandLen / 40));
}

function proposalPreGate(proposal) {
  if (!proposal || typeof proposal !== 'object') return { allow: false, reason: 'invalid_proposal' };
  const title = normalizeText(proposal.title);
  const command = normalizeText(proposal.suggested_next_command);
  const validation = Array.isArray(proposal.validation) ? proposal.validation.map((v) => normalizeText(v)).filter(Boolean) : [];
  const blob = `${title} ${command} ${validation.join(' ')}`.trim();
  if (!title || title.length < 12) return { allow: false, reason: 'title_too_short' };
  if (SENSORY_INSIGHT_REQUIRE_COMMAND) {
    if (!command || command.length < 8) return { allow: false, reason: 'missing_command' };
    if (!COMMAND_PREFIX_RE.test(command)) return { allow: false, reason: 'command_not_executable' };
  }
  if (validation.length < SENSORY_INSIGHT_MIN_VALIDATION) return { allow: false, reason: 'validation_missing' };
  if (!validation.some((row) => MEASURABLE_OUTCOME_RE.test(row))) return { allow: false, reason: 'validation_not_measurable' };
  if (META_COORDINATION_RE.test(blob) && !CONCRETE_CHANGE_RE.test(blob) && !MEASURABLE_OUTCOME_RE.test(blob)) {
    return { allow: false, reason: 'meta_noop' };
  }
  return { allow: true, reason: null };
}

function proposalDedupeKey(proposal) {
  if (!proposal || typeof proposal !== 'object') return '';
  const type = normalizeLine(proposal.type || 'unknown');
  const titleTokens = normalizeLine(proposal.title)
    .split(' ')
    .filter(Boolean)
    .slice(0, 8)
    .join('_');
  const commandHead = normalizeLine(proposal.suggested_next_command)
    .split(' ')
    .filter(Boolean)
    .slice(0, 3)
    .join('_');
  if (!titleTokens && !commandHead) return '';
  return `${type}|${titleTokens}|${commandHead}`;
}

function normalizeProposalForQueue(proposal) {
  const p = proposal && typeof proposal === 'object' ? { ...proposal } : {};
  const validation = Array.isArray(p.validation) ? p.validation.map((v) => normalizeText(v)).filter(Boolean) : [];
  p.title = normalizeText(p.title);
  p.type = normalizeText(p.type);
  p.expected_impact = normalizeText(p.expected_impact).toLowerCase() || 'medium';
  p.risk = normalizeText(p.risk).toLowerCase() || 'low';
  p.validation = validation;
  p.suggested_next_command = normalizeText(p.suggested_next_command);
  p.status = 'pending';
  p.meta = p.meta && typeof p.meta === 'object'
    ? { ...p.meta, proposal_prepared_by: 'sensory_insight' }
    : { proposal_prepared_by: 'sensory_insight' };
  if (!p.id) {
    const seed = `${p.type}|${p.title}|${p.suggested_next_command}`;
    p.id = `PRP-${sha16(seed)}`;
  }
  return p;
}

function prepareProposalsForQueue(proposals) {
  const src = Array.isArray(proposals) ? proposals : [];
  const byKey = new Map();
  const droppedByReason = {};
  let deduped = 0;
  for (const raw of src) {
    const proposal = normalizeProposalForQueue(raw);
    const gate = proposalPreGate(proposal);
    if (!gate.allow) {
      const reason = String(gate.reason || 'filtered');
      droppedByReason[reason] = Number(droppedByReason[reason] || 0) + 1;
      continue;
    }
    const key = proposalDedupeKey(proposal) || `id:${String(proposal.id || '')}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, proposal);
      continue;
    }
    deduped += 1;
    if (proposalQualityScore(proposal) > proposalQualityScore(prev)) {
      byKey.set(key, proposal);
    }
  }
  return {
    proposals: Array.from(byKey.values()),
    dropped: Object.values(droppedByReason).reduce((sum, n) => sum + Number(n || 0), 0),
    deduped,
    dropped_by_reason: droppedByReason
  };
}

// Add evidence to proposal
function addEvidence(proposal, source, sourcePath, match) {
  proposal.evidence.push({
    source,
    path: sourcePath,
    match: match.slice(0, 200) // Truncate to 200 chars
  });
}

// v1.2.0: Deterministic rule engine - NO LLM, NO raw JSONL
function generateDailyProposals(dateStr, digestContent, anomalyData) {
  const proposals = [];
  proposalCounter = 0;
  
  if (!anomalyData && !digestContent) {
    return proposals;
  }
  
  const anomalies = anomalyData?.anomalies || [];
  const metrics = anomalyData?.metrics || {};
  
  // Rule 1: file_change_spike detected
  const fileChangeSpike = anomalies.find(a => a.type === 'file_change_spike');
  if (fileChangeSpike) {
    const proposal = createProposal(
      'hardening',
      'Reduce capture volume: tighten caps or prune ignore patterns',
      'high',
      'low',
      [
        'Reduce max_events_per_run in client/config/work_roots.json',
        'Add more ignore_patterns for client/build/cache dirs',
        'Reduce lookback_hours_default',
        'Expect file_change_spike count <= 0 in next digest'
      ],
      'node client/habits/scripts/sensory_capture.js capture --lookback-hours=12'
    );
    addEvidence(proposal, 'anomaly', `state/sensory/anomalies/${dateStr}.json`, 
      `file_change_spike: ${fileChangeSpike.message}`);
    proposals.push(proposal);
  }
  
  // Rule 2: git_dirty spike detected
  const gitDirtySpike = anomalies.find(a => a.type === 'git_dirty_spike');
  if (gitDirtySpike) {
    const proposal = createProposal(
      'governance',
      'Commit discipline: reduce uncommitted changes or noise sources',
      'medium',
      'low',
      [
        'Audit work roots for long-lived dirty state',
        'Consider auto-commit hooks for草稿work',
        'Expect git_dirty_changed_count_max to decrease',
        'Add commit reminder in dopamine closeout'
      ],
      'git status in each work root'
    );
    addEvidence(proposal, 'anomaly', `state/sensory/anomalies/${dateStr}.json`,
      `git_dirty_spike: ${gitDirtySpike.message}`);
    proposals.push(proposal);
  }
  
  // Rule 3: High churn (same path ≥3 days)
  const highChurnAnomalies = anomalies.filter(a => a.type === 'high_churn');
  if (highChurnAnomalies.length > 0) {
    const paths = highChurnAnomalies.map(a => a.path || 'unknown').join(', ');
    const proposal = createProposal(
      'refactor',
      `Stabilize high-churn files: ${paths.slice(0, 50)}...`,
      'medium',
      'medium',
      [
        'Add regression tests for churn files',
        'Refactor to reduce surface area',
        'Document why these files change frequently',
        'Expect high_churn anomalies to decrease'
      ],
      'npm test -- files with highest churn'
    );
    highChurnAnomalies.forEach(a => {
      addEvidence(proposal, 'anomaly', `state/sensory/anomalies/${dateStr}.json`,
        `high_churn: ${a.message}`);
    });
    proposals.push(proposal);
  }
  
  // Rule 4: AQS drop detected
  const aqsDrop = anomalies.find(a => a.type === 'aqs_drop');
  if (aqsDrop) {
    const proposal = createProposal(
      'bugfix',
      'Audit recent changes: AQS regression detected',
      'high',
      'low',
      [
        'Re-run full test suite',
        'Check git log for recent reverts',
        'Review unverified AIE events',
        'Expect AQS to recover in next anomaly check'
      ],
      'node client/memory/tools/tests/aie.test.js && node client/habits/scripts/sensory_insight.js daily'
    );
    addEvidence(proposal, 'anomaly', `state/sensory/anomalies/${dateStr}.json`,
      `aqs_drop: ${aqsDrop.message}`);
    proposals.push(proposal);
  }
  
  // Rule 5: Low signal ratio
  const signalRatio = metrics.signal_ratio;
  if (typeof signalRatio === 'number' && signalRatio < 0.6) {
    const proposal = createProposal(
      'hardening',
      'Reduce low-signal events: tweak capture filters',
      'medium',
      'low',
      [
        'Review capture ignore_patterns in client/config/work_roots.json',
        'Increase min file size threshold',
        'Exclude more temp/build artifacts',
        `Expect signal_ratio to rise above 0.6 (current: ${signalRatio.toFixed(2)})`
      ],
      'node client/habits/scripts/sensory_capture.js capture && check signal_ratio'
    );
    addEvidence(proposal, 'metrics', `state/sensory/anomalies/${dateStr}.json`,
      `signal_ratio: ${signalRatio} (below 0.6 threshold)`);
    proposals.push(proposal);
  }
  
  // Rule 6: Rework signal (reverts)
  const reworkSignal = anomalies.find(a => a.type === 'rework_signal');
  if (reworkSignal) {
    const proposal = createProposal(
      'coverage',
      'Address rework pattern: revert activity detected',
      'medium',
      'low',
      [
        'Review revert reasons in git log',
        'Add tests to catch the issue that caused revert',
        'Document lessons learned',
        'Expect rework_signal to clear'
      ],
      'git log --oneline --all | grep -i revert | head -5'
    );
    addEvidence(proposal, 'anomaly', `state/sensory/anomalies/${file}.json`,
      `rework_signal: ${reworkSignal.message}`);
    proposals.push(proposal);
  }
  
  // Rule 7: Digest file missing (from digest content check)
  if (!digestContent) {
    const proposal = createProposal(
      'governance',
      'Missing daily digest: sensory_capture may not be running',
      'high',
      'low',
      [
        'Check if sensory_capture is scheduled (cron/heartbeat)',
        'Verify digests directory permissions',
        'Run manual capture to test',
        'Expect digest to appear after next capture'
      ],
      'node client/habits/scripts/sensory_capture.js capture && node client/habits/scripts/sensory_digest.js daily'
    );
    addEvidence(proposal, 'digest', `state/sensory/digests/${dateStr}.md`,
      'Digest file not found - capture workflow may be broken');
    proposals.push(proposal);
  }
  
  return proposals;
}

// Generate weekly proposals from multiple days
function generateWeeklyProposals(dates, dailyAnalyses) {
  const proposals = [];
  proposalCounter = 0;
  
  // Aggregate patterns across week
  const allChurnFiles = new Set();
  const dailySpikes = [];
  let lowSignalDays = 0;
  
  dailyAnalyses.forEach(({ date, anomalies, metrics }) => {
    // Track file spikes
    const spike = anomalies?.find(a => a.type === 'file_change_spike');
    if (spike) dailySpikes.push({ date, severity: spike.severity });
    
    // Track high churn files
    anomalies?.filter(a => a.type === 'high_churn').forEach(a => {
      if (a.path) allChurnFiles.add(a.path);
    });
    
    // Track low signal days
    if (typeof metrics?.signal_ratio === 'number' && metrics.signal_ratio < 0.6) {
      lowSignalDays++;
    }
  });
  
  // Weekly Rule 1: Recurring spikes
  if (dailySpikes.length >= 2) {
    const proposal = createProposal(
      'hardening',
      'Recurring volume spikes: systemic fix needed',
      'high',
      'medium',
      [
        `Spikes on ${dailySpikes.map(s => s.date).join(', ')}`,
        'Review work_roots for unnecessary large directories',
        'Consider splitting work_roots into smaller units',
        'Add pre-capture size estimation'
      ],
      'ls -la work_roots && review directory sizes'
    );
    addEvidence(proposal, 'weekly_analysis', 'aggregate from daily anomalies',
      `${dailySpikes.length} days with file_change_spike`);
    proposals.push(proposal);
  }
  
  // Weekly Rule 2: Persistent churn
  if (allChurnFiles.size >= 3) {
    const proposal = createProposal(
      'refactor',
      `Persistent churn across ${allChurnFiles.size} files: architectural review`,
      'high',
      'high',
      [
        'Files: ' + Array.from(allChurnFiles).slice(0, 5).join(', ') + '...',
        'These files are modified across multiple days',
        'Consider extracting stable interfaces',
        'Add contract tests to reduce breaking changes'
      ],
      'code review of high-churn files'
    );
    addEvidence(proposal, 'weekly_analysis', 'aggregate from daily anomalies',
      `High churn across ${allChurnFiles.size} distinct files`);
    proposals.push(proposal);
  }
  
  // Weekly Rule 3: Multi-day low signal
  if (lowSignalDays >= 3) {
    const proposal = createProposal(
      'ux',
      'Sustained low signal ratio: capture tuning required',
      'medium',
      'low',
      [
        `${lowSignalDays} days with signal_ratio < 0.6 this week`,
        'Too many low-value events being captured',
        'Review and tighten ignore_patterns',
        'Consider reducing work_roots scope'
      ],
      'review client/config/work_roots.json ignore_patterns'
    );
    addEvidence(proposal, 'weekly_analysis', 'aggregate from daily metrics',
      `${lowSignalDays}/7 days below signal threshold`);
    proposals.push(proposal);
  }
  
  return proposals;
}

// Generate human-readable insights markdown
function generateInsightsMarkdown(dateStr, proposals, isWeekly = false) {
  const header = isWeekly ? `# Sensory Insights: Week ${dateStr}

*Generated: ${new Date().toISOString()}*` : `# Sensory Insights: ${dateStr}

*Generated: ${new Date().toISOString()}*`;
  
  let md = `${header}

## 📋 Summary

**Proposals generated**: ${proposals.length}
**Types**: ${[...new Set(proposals.map(p => p.type))].join(', ') || 'none'}

`;
  
  if (proposals.length === 0) {
    md += `_No proposals. System operating within normal parameters._\n`;
    return md;
  }
  
  md += `## 🎯 Proposals

`;
  
  proposals.forEach((p, i) => {
    const impactEmoji = { low: '🟢', medium: '🟡', high: '🔴' }[p.expected_impact] || '⚪';
    const riskEmoji = { low: '✅', medium: '⚠️', high: '🚨' }[p.risk] || '❓';
    
    md += `### ${p.id}: ${p.title}\n\n`;
    md += `- **Type**: ${p.type}\n`;
    md += `- **Impact**: ${impactEmoji} ${p.expected_impact}\n`;
    md += `- **Risk**: ${riskEmoji} ${p.risk}\n`;
    md += `- **Suggested command**: \`\`\`bash\n${p.suggested_next_command}\n\`\`\`\n\n`;
    
    if (p.evidence.length > 0) {
      md += `**Evidence**:\n`;
      p.evidence.forEach(e => {
        md += `- \`${e.source}\`: ${e.match.slice(0, 100)}${e.match.length > 100 ? '...' : ''}\n`;
      });
      md += '\n';
    }
    
    if (p.validation.length > 0) {
      md += `**Validation plan**:\n`;
      p.validation.forEach(v => {
        md += `- [ ] ${v}\n`;
      });
      md += '\n';
    }
    
    md += '---\n\n';
  });
  
  md += `## 📝 How to Act

Each proposal above is a suggestion. Review, modify, or reject as needed.\n`;
  md += `To implement: copy suggested command, run manually, observe results.\n`;
  md += `Track outcomes: proposals are logged but no auto-action is taken.\n`;
  
  return md;
}

// Save proposals JSON
function saveProposalsJSON(dateStr, proposals) {
  const proposalData = {
    date: dateStr,
    generated_at: new Date().toISOString(),
    count: proposals.length,
    proposals
  };
  
  const proposalPath = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  fs.writeFileSync(proposalPath, JSON.stringify(proposalData, null, 2));
  return proposalPath;
}

// Get last N dates ending at endDate
function getLastNDates(n, endDateStr) {
  const dates = [];
  const end = endDateStr ? new Date(endDateStr) : new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// Parse digest metrics from markdown (for tests)
function parseDigestMetrics(digestContent) {
  const metrics = {
    sensoryEvents: 0,
    aieEvents: 0,
    signalRatio: 1.0,
    gitDirtyEvents: 0,
    gitDirtyMax: 0
  };
  
  if (!digestContent) return metrics;
  
  const lines = digestContent.split('\n');
  for (const line of lines) {
    // **Sensory events**: 35
    const sensoryMatch = line.match(/\*\*Sensory events\*\*:\s*(\d+)/);
    if (sensoryMatch) metrics.sensoryEvents = parseInt(sensoryMatch[1], 10);
    
    // **AIE events**: 23
    const aieMatch = line.match(/\*\*AIE events\*\*:\s*(\d+)/);
    if (aieMatch) metrics.aieEvents = parseInt(aieMatch[1], 10);
    
    // **Signal/Noise ratio**: 0.91
    const ratioMatch = line.match(/\*\*Signal\/Noise ratio\*\*:\s*([\d.]+)/);
    if (ratioMatch) metrics.signalRatio = parseFloat(ratioMatch[1]);
    
    // **Git dirty events**: 4 (max changed_count: 61)
    const gitMatch = line.match(/\*\*Git dirty events\*\*:\s*(\d+)/);
    if (gitMatch) metrics.gitDirtyEvents = parseInt(gitMatch[1], 10);
    
    const gitMaxMatch = line.match(/max changed_count:\s*(\d+)/);
    if (gitMaxMatch) metrics.gitDirtyMax = parseInt(gitMaxMatch[1], 10);
  }
  
  return metrics;
}

// Extract high churn paths from anomaly data (for tests)
function extractHighChurnPaths(anomalyData) {
  const churnPaths = [];
  if (!anomalyData || !anomalyData.anomalies) return churnPaths;
  
  anomalyData.anomalies.forEach(a => {
    if (a.type === 'high_churn' && a.path) {
      const daysMatch = a.message?.match(/(\d+)\s*days?/);
      const days = daysMatch ? parseInt(daysMatch[1], 10) : 1;
      churnPaths.push({
        path: a.path,
        days,
        severity: a.severity || 'medium'
      });
    }
  });
  
  return churnPaths;
}

// Generate proposals wrapper (test-compatible signature)
function generateProposals(dateStr, metrics, anomalyData, churnPaths) {
  // Reconstruct the arguments for generateDailyProposals
  // The function expects dateStr, digestContent, anomalyData
  // We have metrics and churnPaths separately, so we need to package them
  
  // Create synthetic anomaly structure including churn paths
  const enhancedAnomalies = {
    anomalies: anomalyData?.anomalies || [],
    metrics: {
      ...anomalyData?.metrics,
      signal_ratio: metrics?.signalRatio ?? anomalyData?.metrics?.signal_ratio ?? 1.0
    }
  };
  
  // Add high_churn entries from churnPaths if not already in anomalies
  churnPaths?.forEach(c => {
    const exists = enhancedAnomalies.anomalies.find(a => 
      a.type === 'high_churn' && a.path === c.path
    );
    if (!exists) {
      enhancedAnomalies.anomalies.push({
        type: 'high_churn',
        severity: c.severity,
        path: c.path,
        message: `File '${c.path}' modified across ${c.days} days (high churn detected)`
      });
    }
  });
  
  // Call the main generator with null digestContent (we already have metrics)
  return generateDailyProposals(dateStr, null, enhancedAnomalies);
}

// CLI handler
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'daily';
  const dateArg = args[1];
  
  const dateStr = dateArg || new Date().toISOString().slice(0, 10);
  
  ensureDirs();
  
  switch (cmd) {
    case 'daily': {
      console.log(`Generating insights for ${dateStr}...`);
      
      // v1.2.0: ONLY read digests and anomalies, NEVER raw JSONL
      const digestContent = loadDigest(dateStr);
      const anomalyData = loadAnomalies(dateStr);
      
      if (!digestContent && !anomalyData) {
        console.log(`⚠️  No digest or anomaly data found for ${dateStr}`);
        console.log(`   Run: node client/habits/scripts/sensory_digest.js daily ${dateStr}`);
        process.exit(1);
      }
      
      const proposals = generateDailyProposals(dateStr, digestContent, anomalyData);
      const prepared = prepareProposalsForQueue(proposals);
      
      // Generate outputs
      const insightsMd = generateInsightsMarkdown(dateStr, prepared.proposals, false);
      const insightsPath = path.join(INSIGHTS_DIR, `${dateStr}.md`);
      fs.writeFileSync(insightsPath, insightsMd);
      
      const proposalsPath = saveProposalsJSON(dateStr, prepared.proposals);
      
      // v1.2.1: Optionally ingest proposals into queue (best-effort, non-blocking)
      try {
        const { ingest } = require('./sensory_queue.js');
        ingest(dateStr);
      } catch (e) {
        // Queue ingest is optional; don't fail if queue not available
      }
      
      console.log(`✅ Insights: ${insightsPath}`);
      console.log(`✅ Proposals: ${proposalsPath} (${prepared.proposals.length} generated, ${prepared.deduped} deduped, ${prepared.dropped} filtered)`);
      
      if (prepared.proposals.length > 0) {
        console.log(`\n📊 Proposal breakdown:`);
        const byType = {};
        prepared.proposals.forEach(p => {
          byType[p.type] = (byType[p.type] || 0) + 1;
        });
        Object.entries(byType).forEach(([type, count]) => {
          console.log(`   ${type}: ${count}`);
        });
        const filteredReasons = Object.entries(prepared.dropped_by_reason || {})
          .map(([k, v]) => `${k}:${v}`)
          .join(', ');
        if (filteredReasons) {
          console.log(`   filtered: ${filteredReasons}`);
        }
      } else {
        console.log('\n🟢 No proposals - system operating normally');
      }
      break;
    }
    
    case 'weekly': {
      const weekKey = getWeekKey(dateStr);
      console.log(`Generating weekly insights for ${weekKey}...`);
      
      // Get last 7 days
      const dates = [];
      const dailyAnalyses = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(dateStr);
        d.setDate(d.getDate() - i);
        const dStr = d.toISOString().slice(0, 10);
        dates.push(dStr);
        
        // v1.2.0: ONLY read anomalies (weekly doesn't need full digest)
        const anomalyData = loadAnomalies(dStr);
        if (anomalyData) {
          dailyAnalyses.push({
            date: dStr,
            anomalies: anomalyData.anomalies || [],
            metrics: anomalyData.metrics || {}
          });
        }
      }
      
      const proposals = generateWeeklyProposals(dates, dailyAnalyses);
      const prepared = prepareProposalsForQueue(proposals);
      
      // Generate outputs
      const insightsMd = generateInsightsMarkdown(weekKey, prepared.proposals, true);
      const insightsPath = path.join(INSIGHTS_DIR, `${weekKey}.md`);
      fs.writeFileSync(insightsPath, insightsMd);
      
      const proposalsPath = saveProposalsJSON(weekKey, prepared.proposals);
      
      // v1.2.1: Optionally ingest proposals into queue (best-effort, non-blocking)
      try {
        const { ingest } = require('./sensory_queue.js');
        ingest(weekKey);
      } catch (e) {
        // Queue ingest is optional; don't fail if queue not available
      }
      
      console.log(`✅ Weekly Insights: ${insightsPath}`);
      console.log(`✅ Weekly Proposals: ${proposalsPath} (${prepared.proposals.length} generated, ${prepared.deduped} deduped, ${prepared.dropped} filtered)`);
      console.log(`   Analyzed ${dailyAnalyses.length} days`);
      break;
    }
    
    default:
      console.log('Sensory Layer v1.2.0 INSIGHT Generator');
      console.log('');
      console.log('Commands:');
      console.log('  node client/habits/scripts/sensory_insight.js daily [YYYY-MM-DD]');
      console.log('  node client/habits/scripts/sensory_insight.js weekly [YYYY-MM-DD]');
      console.log('');
      console.log('Outputs:');
      console.log('  state/sensory/insights/YYYY-MM-DD.md (human-readable)');
      console.log('  state/sensory/proposals/YYYY-MM-DD.json (machine-readable)');
      console.log('');
      console.log('Constraints:');
      console.log('  - Reads ONLY digests and anomalies (NO raw JSONL)');
      console.log('  - Deterministic rules only (NO LLM calls)');
      console.log('  - Proposals only (NO automatic execution)');
  }
}

// Export for tests
module.exports = {
  generateDailyProposals,
  generateWeeklyProposals,
  generateInsightsMarkdown,
  loadDigest,
  loadAnomalies,
  parseDigestMetrics,
  extractHighChurnPaths,
  generateProposals,
  prepareProposalsForQueue,
  saveProposalsJSON,
  getWeekKey,
  getLastNDates,
  DIGESTS_DIR,
  ANOMALIES_DIR,
  INSIGHTS_DIR,
  PROPOSALS_DIR
  // v1.2.0: RAW_DIR is intentionally NOT exported
};

// Run if called directly
if (require.main === module) {
  main();
}
