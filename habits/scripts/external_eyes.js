#!/usr/bin/env node
/**
 * external_eyes.js v1.0 - External Eyes Framework
 * 
 * Controlled external intel gathering with budgets, scoring, and evolution.
 * Sensing-only. NO autonomous execution.
 * 
 * Commands:
 *   node habits/scripts/external_eyes.js run [--eye=<id>] [--max-eyes=N]
 *   node habits/scripts/external_eyes.js score [YYYY-MM-DD]
 *   node habits/scripts/external_eyes.js evolve [YYYY-MM-DD]
 *   node habits/scripts/external_eyes.js list
 *   node habits/scripts/external_eyes.js propose "<name>" "<domain>" "<notes>"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { collectHnRss } = require('./eyes_collectors/hn_rss');

// Paths
const WORKSPACE_DIR = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(WORKSPACE_DIR, 'config', 'external_eyes.json');

// Allow overrides (tests / multi-workspace)
const STATE_DIR = process.env.EYES_STATE_DIR
  ? path.resolve(process.env.EYES_STATE_DIR)
  : path.join(WORKSPACE_DIR, 'state', 'sensory', 'eyes');

const RAW_DIR = path.join(STATE_DIR, 'raw');
const METRICS_DIR = path.join(STATE_DIR, 'metrics');
const PROPOSALS_DIR = path.join(STATE_DIR, 'proposals');
const REGISTRY_PATH = path.join(STATE_DIR, 'registry.json');

// Sensory proposals (from eyes_insight.js)
const SENSORY_PROPOSALS_DIR = process.env.EYES_SENSORY_PROPOSALS_DIR
  ? path.resolve(process.env.EYES_SENSORY_PROPOSALS_DIR)
  : path.join(WORKSPACE_DIR, 'state', 'sensory', 'proposals');

// Proposal queue decisions (outcomes live here)
const QUEUE_DIR = process.env.EYES_QUEUE_DIR
  ? path.resolve(process.env.EYES_QUEUE_DIR)
  : path.join(WORKSPACE_DIR, 'state', 'queue');
const DECISIONS_DIR = path.join(QUEUE_DIR, 'decisions');

// Ensure directories exist
function ensureDirs() {
  [STATE_DIR, RAW_DIR, METRICS_DIR, PROPOSALS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// Load config
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found: ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Load or initialize registry (runtime state)
function loadRegistry() {
  ensureDirs(); // Ensure state directory exists before writing
  if (!fs.existsSync(REGISTRY_PATH)) {
    const config = loadConfig();
    const registry = {
      version: '1.0',
      last_updated: new Date().toISOString(),
      eyes: config.eyes.map(eye => ({
        ...eye,
        run_count: 0,
        total_items: 0,
        total_errors: 0
      }))
    };
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
    return registry;
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

// Save registry
function saveRegistry(registry) {
  registry.last_updated = new Date().toISOString();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function asPositiveNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function asFiniteNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Runtime authority is registry first, with config as immutable defaults.
function effectiveEye(eyeConfig, registryEye) {
  return {
    ...eyeConfig,
    status: (registryEye && typeof registryEye.status === 'string' && registryEye.status.trim())
      ? registryEye.status
      : eyeConfig.status,
    cadence_hours: asPositiveNumber(
      registryEye ? registryEye.cadence_hours : undefined,
      asPositiveNumber(eyeConfig.cadence_hours, 24)
    ),
    score_ema: asFiniteNumber(
      registryEye ? registryEye.score_ema : undefined,
      asFiniteNumber(eyeConfig.score_ema, 50)
    )
  };
}

// Get today's date string
function getToday() {
  return new Date().toISOString().slice(0, 10);
}

// Compute hash for deduplication
function computeHash(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

// Check if domain is allowlisted
function isDomainAllowed(eye, url) {
  try {
    const hostname = new URL(url).hostname;
    return eye.allowed_domains.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch (e) {
    return false;
  }
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeReadJsonl(filePath) {
  const events = [];
  try {
    if (!fs.existsSync(filePath)) return events;
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch (e) {
        // ignore malformed line
      }
    }
  } catch (e) {
    return events;
  }
  return events;
}

function dateToMs(d) {
  return new Date(d + 'T00:00:00.000Z').getTime();
}

function datesInWindow(windowDays, nowDateStr) {
  const out = [];
  const nowMs = dateToMs(nowDateStr);
  for (let i = 0; i < windowDays; i++) {
    const ms = nowMs - (i * 24 * 60 * 60 * 1000);
    const iso = new Date(ms).toISOString().slice(0, 10);
    out.push(iso);
  }
  return out;
}

// Yield signals:
// proposed_total: # proposals in state/sensory/proposals for this eye in window
// shipped_total: # outcomes shipped in state/queue/decisions with evidence_ref "eye:<id>"
// yield_rate: shipped_total / proposed_total (0 if none)
function computeYieldSignals(windowDays, nowDateStr) {
  const windowDates = datesInWindow(windowDays, nowDateStr);
  const proposedByEye = {};
  const shippedByEye = {};

  // Proposed counts
  for (const d of windowDates) {
    const fp = path.join(SENSORY_PROPOSALS_DIR, `${d}.json`);
    const arr = safeReadJson(fp, []);
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      const eye = (p && p.meta && p.meta.source_eye) ? String(p.meta.source_eye) : null;
      if (!eye) continue;
      proposedByEye[eye] = (proposedByEye[eye] || 0) + 1;
    }
  }

  // Shipped counts
  for (const d of windowDates) {
    const fp = path.join(DECISIONS_DIR, `${d}.jsonl`);
    const evts = safeReadJsonl(fp);
    for (const e of evts) {
      if (!e || e.type !== 'outcome') continue;
      if (String(e.outcome) !== 'shipped') continue;
      const ref = String(e.evidence_ref || '');
      const m = ref.match(/\beye:([^\s]+)/);
      const eye = m ? m[1] : null;
      if (!eye) continue;
      shippedByEye[eye] = (shippedByEye[eye] || 0) + 1;
    }
  }

  const eyes = new Set([...Object.keys(proposedByEye), ...Object.keys(shippedByEye)]);
  const out = {};
  for (const eye of eyes) {
    const proposed = proposedByEye[eye] || 0;
    const shipped = shippedByEye[eye] || 0;
    const yieldRate = proposed > 0 ? shipped / proposed : 0;
    out[eye] = { proposed_total: proposed, shipped_total: shipped, yield_rate: yieldRate };
  }
  return out;
}

/**
 * Read proposal_queue outcome events and attribute them to eyes.
 * We attribute only when evidence_ref includes "eye:<id>".
 * Deterministic scoring:
 *   shipped => +3
 *   no_change => +1
 *   reverted => -5
 *
 * We compute per-eye avg_points over the window, then delta = clamp(avg_points, -5, +5).
 * If no outcomes for an eye, delta=0.
 */
function computeOutcomeSignals(windowDays, nowDateStr) {
  const results = {}; // eyeId -> { shipped, no_change, reverted, total, points, avg_points, delta }
  const now = new Date(nowDateStr);
  if (!fs.existsSync(DECISIONS_DIR)) return results;

  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const filePath = path.join(DECISIONS_DIR, `${dateStr}.jsonl`);
    const events = safeReadJsonl(filePath);

    for (const ev of events) {
      if (!ev || ev.type !== 'outcome') continue;
      const evidenceRef = String(ev.evidence_ref || '');
      const m = evidenceRef.match(/(?:^|[\s,;])eye:([a-zA-Z0-9_\-]+)/);
      if (!m) continue;
      const eyeId = m[1];
      if (!results[eyeId]) {
        results[eyeId] = { shipped: 0, no_change: 0, reverted: 0, total: 0, points: 0, avg_points: 0, delta: 0 };
      }
      const outcome = String(ev.outcome || '').toLowerCase();
      if (outcome === 'shipped') {
        results[eyeId].shipped++;
        results[eyeId].points += 3;
        results[eyeId].total++;
      } else if (outcome === 'no_change') {
        results[eyeId].no_change++;
        results[eyeId].points += 1;
        results[eyeId].total++;
      } else if (outcome === 'reverted') {
        results[eyeId].reverted++;
        results[eyeId].points -= 5;
        results[eyeId].total++;
      }
    }
  }

  for (const [eyeId, r] of Object.entries(results)) {
    r.avg_points = r.total > 0 ? (r.points / r.total) : 0;
    r.delta = clamp(r.avg_points, -5, 5);
  }
  return results;
}

// STUB: Simulate external eye collection
// In v1.0, this is a stub that generates synthetic events for testing
function stubCollect(eye, budget) {
  const items = [];
  const count = Math.min(3, budget.max_items); // Generate 3 stub items max
  
  const now = new Date().toISOString();
  
  for (let i = 0; i < count; i++) {
    const item = {
      id: computeHash(`${eye.id}-${now}-${i}`),
      url: `https://${eye.allowed_domains[0]}/item/${i}`,
      title: `[STUB] ${eye.name} item ${i+1}`,
      source: eye.id,
      collected_at: now,
      topics: eye.topics || [],
      content_preview: `Stub content from ${eye.name} about ${eye.topics?.[0] || 'general'}`,
      bytes: 256
    };
    items.push(item);
  }
  
  return {
    success: true,
    items,
    duration_ms: 100 + items.length * 10,
    requests: 1,
    bytes: items.reduce((sum, item) => sum + item.bytes, 0)
  };
}

// Append event to raw log
function appendRawLog(dateStr, event) {
  const logPath = path.join(RAW_DIR, `${dateStr}.jsonl`);
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(logPath, line, 'utf8');
}

/**
 * Collector dispatch (deterministic)
 * - Keep collectors tiny and explicit
 * - No LLM calls inside collectors
 */
async function collectEye(eyeConfig) {
  const budgets = eyeConfig.budgets || {};

  // Parser selection
  if (eyeConfig.parser_type === 'hn_rss') {
    const r = await collectHnRss(eyeConfig, budgets);
    return r;
  }

  // Fallback: existing stub
  return stubCollect(eyeConfig, budgets);
}

// RUN: Execute eligible eyes based on cadence and status
async function run(opts = {}) {
  ensureDirs();
  
  const config = loadConfig();
  const registry = loadRegistry();
  const today = getToday();
  const { eye: specificEye, maxEyes = config.global_limits.max_concurrent_runs } = opts;
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   EXTERNAL EYES - RUN CYCLE');
  console.log('═══════════════════════════════════════════════════════════');
  
  let runCount = 0;
  let eyesRun = [];
  
  for (const eyeConfig of config.eyes) {
    let registryEye = registry.eyes.find(e => e.id === eyeConfig.id);
    if (!registryEye) {
      registryEye = {
        ...eyeConfig,
        run_count: 0,
        total_items: 0,
        total_errors: 0
      };
      registry.eyes.push(registryEye);
    }
    const runtimeEye = effectiveEye(eyeConfig, registryEye);

    if (specificEye && eyeConfig.id !== specificEye) continue;
    if (runCount >= maxEyes) break;
    
    // Check status
    if (runtimeEye.status === 'retired') {
      console.log(`⏭️  Skipping ${eyeConfig.id}: retired`);
      continue;
    }
    
    // Check cadence
    const lastRun = registryEye?.last_run ? new Date(registryEye.last_run) : null;
    const hoursSinceLastRun = lastRun ? (Date.now() - lastRun) / (1000 * 60 * 60) : Infinity;
    
    if (hoursSinceLastRun < runtimeEye.cadence_hours) {
      console.log(`⏭️  Skipping ${eyeConfig.id}: cadence (${Math.round(hoursSinceLastRun)}h < ${runtimeEye.cadence_hours}h)`);
      continue;
    }
    
    // RUN the eye
    console.log(`👁️  Running ${eyeConfig.id}...`);
    
    // Emit breadcrumb: eye_run_started
    const startEvent = {
      ts: new Date().toISOString(),
      type: 'eye_run_started',
      eye_id: eyeConfig.id,
      eye_name: eyeConfig.name,
      budget: eyeConfig.budgets,
      status: runtimeEye.status
    };
    appendRawLog(today, startEvent);
    
    try {
      // Deterministic collector dispatch (real collectors + stub fallback)
      const result = await collectEye(eyeConfig);
      
      if (result.success) {
        // Emit items
        result.items.forEach(item => {
          appendRawLog(today, {
            ts: item.collected_at,
            type: 'external_item',
            eye_id: eyeConfig.id,
            item_hash: item.id,
            url: item.url,
            title: item.title,
            topics: item.topics,
            bytes: item.bytes
          });
        });
        
        // Emit breadcrumb: eye_run_ok
        appendRawLog(today, {
          ts: new Date().toISOString(),
          type: 'eye_run_ok',
          eye_id: eyeConfig.id,
          items_collected: result.items.length,
          duration_ms: result.duration_ms,
          requests: result.requests,
          bytes: result.bytes
        });
        
        // Update registry
        registryEye.last_run = new Date().toISOString();
        registryEye.last_success = new Date().toISOString();
        registryEye.run_count++;
        registryEye.total_items += result.items.length;
        
        eyesRun.push({
          id: eyeConfig.id,
          items: result.items.length,
          duration_ms: result.duration_ms
        });
        
        console.log(`   ✅ ${result.items.length} items, ${result.duration_ms}ms`);
      }
      
    } catch (err) {
      // Emit breadcrumb: eye_run_failed
      appendRawLog(today, {
        ts: new Date().toISOString(),
        type: 'eye_run_failed',
        eye_id: eyeConfig.id,
        error: err.message.slice(0, 200)
      });
      
      registryEye.last_run = new Date().toISOString();
      registryEye.total_errors++;
      const runs = Math.max(1, Number(registryEye.run_count || 0));
      registryEye.error_rate = registryEye.total_errors / runs;
      
      console.log(`   ❌ Failed: ${err.message}`);
    }
    
    runCount++;
  }
  
  saveRegistry(registry);
  
  console.log('───────────────────────────────────────────────────────────');
  console.log(`🎯 Ran ${eyesRun.length}/${runCount} eyes eligible`);
  eyesRun.forEach(e => console.log(`   - ${e.id}: ${e.items} items in ${e.duration_ms}ms`));
  console.log('═══════════════════════════════════════════════════════════');
  
  return { ran: eyesRun.length, eyes: eyesRun };
}

// SCORE: Compute usefulness metrics per eye
function score(dateStr) {
  ensureDirs();
  const date = dateStr || getToday();
  const rawLogPath = path.join(RAW_DIR, `${date}.jsonl`);
  
  if (!fs.existsSync(rawLogPath)) {
    console.log(`No raw events for ${date}`);
    return null;
  }
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   EXTERNAL EYES - SCORING');
  console.log(`   Date: ${date}`);
  console.log('═══════════════════════════════════════════════════════════');
  
  // Load events
  const lines = fs.readFileSync(rawLogPath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(e => e !== null);
  
  // Group by eye
  const byEye = {};
  const urlHashes = new Set();
  const signalHeuristics = {
    // Simple heuristics for "signal" content
    hasTopic: (item) => item.topics && item.topics.length > 0,
    hasTitle: (item) => item.title && item.title.length > 20
  };
  
  for (const event of lines) {
    if (event.eye_id) {
      if (!byEye[event.eye_id]) {
        byEye[event.eye_id] = {
          items: [],
          ok_runs: [],
          failed_runs: []
        };
      }
      
      if (event.type === 'external_item') {
        byEye[event.eye_id].items.push(event);
        urlHashes.add(event.item_hash);
      } else if (event.type === 'eye_run_ok') {
        byEye[event.eye_id].ok_runs.push(event);
      } else if (event.type === 'eye_run_failed') {
        byEye[event.eye_id].failed_runs.push(event);
      }
    }
  }
  
  // Compute metrics per eye
  const metrics = {};
  const config = loadConfig();
  const registry = loadRegistry();
  
  const YIELD_WINDOW_DAYS = 14;
  const yieldSignals = computeYieldSignals(YIELD_WINDOW_DAYS, date);
  
  for (const [eyeId, data] of Object.entries(byEye)) {
    const eyeConfig = config.eyes.find(e => e.id === eyeId);
    const regEye = registry.eyes.find(e => e.id === eyeId);
    if (!eyeConfig) continue;
    const runtimeEye = effectiveEye(eyeConfig, regEye);
    
    const items = data.items;
    const uniqueItems = new Set(items.map(i => i.item_hash)).size;
    const totalBytes = items.reduce((sum, i) => sum + (i.bytes || 0), 0);
    const totalRequests = data.ok_runs.reduce((sum, r) => sum + (r.requests || 0), 0);
    const totalDuration = data.ok_runs.reduce((sum, r) => sum + (r.duration_ms || 0), 0);
    const errorCount = data.failed_runs.length;
    const totalRuns = data.ok_runs.length + errorCount;
    
    // Signal rate: items passing heuristics
    const signalItems = items.filter(i => 
      signalHeuristics.hasTopic(i) && signalHeuristics.hasTitle(i)
    ).length;
    
    // Proposal yield (stub: 0 in v1.0)
    const proposalYield = 0;
    
    // Compute quality score (0-100)
    const noveltyRate = uniqueItems / Math.max(items.length, 1);
    const signalRate = items.length > 0 ? signalItems / items.length : 0;
    const errorRate = totalRuns > 0 ? errorCount / totalRuns : 0;
    
    // Composite score
    // Include yield lightly (outcome-weighted sensing):
    // - yield_rate contributes up to +20 points when yield approaches 1.0
    // - but typical yields are low, so this mostly helps distinguish "signal that converts"
    // - confidence = min(1, proposed / 20) to avoid high bonuses on small samples
    const y = yieldSignals[eyeId] ? yieldSignals[eyeId].yield_rate : 0;
    const proposed = yieldSignals[eyeId] ? yieldSignals[eyeId].proposed_total : 0;
    const confidence = Math.min(1, proposed / 20);
    const rawScore = (
      noveltyRate * 30 +      // 30% novelty
      signalRate * 40 +         // 40% signal
      (1 - errorRate) * 20 +   // 20% reliability
      Math.min(proposalYield * 10, 10) +  // 10% proposal yield
      Math.min(y * 20, 20) * confidence    // outcome yield bonus (max +20), confidence-weighted
    );
    
    // Update EMA
    const alpha = config.scoring.ema_alpha || 0.3;
    const oldEma = runtimeEye.score_ema;
    const newEma = alpha * rawScore + (1 - alpha) * oldEma;
    
    metrics[eyeId] = {
      date,
      eye_id: eyeId,
      eye_name: runtimeEye.name,
      
      // Count metrics
      total_items: items.length,
      unique_items: uniqueItems,
      signal_items: signalItems,
      proposal_yield: proposalYield,
      
      // Rate metrics
      novelty_rate: parseFloat(noveltyRate.toFixed(2)),
      signal_rate: parseFloat(signalRate.toFixed(2)),
      error_rate: parseFloat(errorRate.toFixed(2)),
      
      // Cost metrics
      cost_ms: totalDuration,
      cost_requests: totalRequests,
      cost_bytes: totalBytes,
      
      // Score
      raw_score: parseFloat(rawScore.toFixed(1)),
      score_ema: parseFloat(newEma.toFixed(1)),
      score_ema_previous: parseFloat(oldEma.toFixed(1)),

      // Outcome yield signals (windowed)
      yield_window_days: YIELD_WINDOW_DAYS,
      proposed_total: yieldSignals[eyeId] ? yieldSignals[eyeId].proposed_total : 0,
      shipped_total: yieldSignals[eyeId] ? yieldSignals[eyeId].shipped_total : 0,
      yield_rate: parseFloat((yieldSignals[eyeId] ? yieldSignals[eyeId].yield_rate : 0).toFixed(3)),
      yield_confidence: parseFloat(confidence.toFixed(3))
    };
    
    console.log(`📊 ${eyeId}:`);
    console.log(`   Items: ${items.length} (${uniqueItems} unique, ${signalItems} signal)`);
    console.log(`   Rates: novelty=${(noveltyRate*100).toFixed(0)}%, signal=${(signalRate*100).toFixed(0)}%, error=${(errorRate*100).toFixed(0)}%`);
    console.log(`   Cost: ${totalDuration}ms, ${totalRequests} reqs, ${totalBytes} bytes`);
    console.log(`   Score: raw=${rawScore.toFixed(1)}, EMA=${oldEma.toFixed(1)} → ${newEma.toFixed(1)}`);
    if (yieldSignals[eyeId]) {
      console.log(`   Yield(14d): proposed=${yieldSignals[eyeId].proposed_total}, shipped=${yieldSignals[eyeId].shipped_total}, rate=${(yieldSignals[eyeId].yield_rate*100).toFixed(1)}%, conf=${(confidence*100).toFixed(0)}%`);
    }
    console.log('');
  }
  
  // Save metrics
  const metricsPath = path.join(METRICS_DIR, `${date}.json`);
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
  console.log(`✅ Metrics saved: ${metricsPath}`);
  
  return metrics;
}

// EVOLVE: Update score_ema and adjust cadence/status
function evolve(dateStr) {
  ensureDirs();
  const date = dateStr || getToday();
  const metricsPath = path.join(METRICS_DIR, `${date}.json`);
  
  if (!fs.existsSync(metricsPath)) {
    console.log(`No metrics for ${date}. Run 'score' first.`);
    return null;
  }
  
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const registry = loadRegistry();
  const config = loadConfig();
  
  const OUTCOME_WINDOW_DAYS = 14; // deterministic window for outcomes
  // Compute once per evolve (do NOT recompute per eye)
  const outcomeSignals = computeOutcomeSignals(OUTCOME_WINDOW_DAYS, date);
  const yieldSignals = computeYieldSignals(OUTCOME_WINDOW_DAYS, date);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('   EXTERNAL EYES - EVOLUTION');
  console.log(`   Date: ${date}`);
  console.log('═══════════════════════════════════════════════════════════');
  
  const changes = [];
  
  for (const eyeId in metrics) {
    const m = metrics[eyeId];
    const eyeConfig = config.eyes.find(e => e.id === eyeId);
    if (!eyeConfig) continue;
    
    let regEye = registry.eyes.find(e => e.id === eyeId);
    if (!regEye) {
      regEye = {
        ...eyeConfig,
        run_count: 0,
        total_items: 0,
        total_errors: 0
      };
      registry.eyes.push(regEye);
    }
    const runtimeEye = effectiveEye(eyeConfig, regEye);
    
    // Update EMA in registry
    regEye.score_ema = m.score_ema;

    // Store yield observability (derived)
    const ys = yieldSignals[eyeId] || { proposed_total: 0, shipped_total: 0, yield_rate: 0 };
    regEye.yield_window_days = OUTCOME_WINDOW_DAYS;
    regEye.proposed_total = ys.proposed_total;
    regEye.shipped_total = ys.shipped_total;
    regEye.yield_rate = parseFloat((ys.yield_rate || 0).toFixed(3));

    // Outcome-based adjustment (closed-loop attribution)
    // This uses proposal_queue outcomes tagged with evidence_ref "eye:<id>"
    if (outcomeSignals[eyeId] && outcomeSignals[eyeId].total > 0) {
      const sig = outcomeSignals[eyeId];
      // Apply small deterministic bump/penalty to score_ema
      regEye.score_ema = clamp((regEye.score_ema ?? 50) + sig.delta, 0, 100);
      // Store observability fields (non-authoritative, derived)
      regEye.outcomes_window_days = OUTCOME_WINDOW_DAYS;
      regEye.outcomes_total = sig.total;
      regEye.outcomes_shipped = sig.shipped;
      regEye.outcomes_reverted = sig.reverted;
      regEye.outcomes_no_change = sig.no_change;
      regEye.outcomes_points = sig.points;
      regEye.outcomes_delta = sig.delta;
    } else {
      // still keep fields consistent but don't overwrite historic fields aggressively
      regEye.outcomes_window_days = OUTCOME_WINDOW_DAYS;
      regEye.outcomes_total = regEye.outcomes_total ?? 0;
      regEye.outcomes_delta = 0;
    }

    const oldCadence = runtimeEye.cadence_hours;
    const oldStatus = runtimeEye.status;
    let newCadence = oldCadence;
    let newStatus = oldStatus;
    let reason = '';

    // Backlog approximation: proposed_total - shipped_total (windowed)
    // Not perfect (doesn't count rejects/done), but enough to prevent runaway cadence decreases.
    const backlogEst = Math.max(0, (ys.proposed_total || 0) - (ys.shipped_total || 0));
    const BACKLOG_THROTTLE = config.scoring.backlog_throttle || 20;

    // Yield thresholds
    const YIELD_LOW = config.scoring.yield_threshold_low || 0.10; // 10%
    const YIELD_MIN_PROPOSED = config.scoring.yield_min_proposed || 10; // only enforce once we have data

    // Evolution rules
    // 1. If score_ema < 20 for 30 days => dormant
    if (m.score_ema < config.scoring.score_threshold_dormant && regEye.run_count > 30) {
      newStatus = 'dormant';
      newCadence = Math.min(168, config.scoring.cadence_max_hours);
      reason = 'Score < 20 for >30 days';
    }
    // 1b. If yield is low (outcome-weighted) and we have enough volume, slow the eye down
    else if ((ys.proposed_total || 0) >= YIELD_MIN_PROPOSED && (ys.yield_rate || 0) < YIELD_LOW) {
      newCadence = Math.min(oldCadence * 2, config.scoring.cadence_max_hours);
      reason = `Low yield (${(ys.yield_rate*100).toFixed(1)}% < ${(YIELD_LOW*100).toFixed(0)}%) over ${OUTCOME_WINDOW_DAYS}d`;
    }
    // 2. If score_ema < 30 for 14 days => cadence *= 2
    else if (m.score_ema < config.scoring.score_threshold_low && m.raw_score < 30) {
      newCadence = Math.min(oldCadence * 2, config.scoring.cadence_max_hours);
      reason = 'Score < 30 for >14 days';
    }
    // 3. If score_ema > 70 for 14 days => cadence /= 2
    else if (m.score_ema > config.scoring.score_threshold_high && m.raw_score > 70) {
      // Only speed up if backlog is healthy
      if (backlogEst >= BACKLOG_THROTTLE) {
        newCadence = oldCadence; // hold steady
        reason = `High score but backlogEst=${backlogEst} >= ${BACKLOG_THROTTLE} (hold cadence)`;
      } else {
        newCadence = Math.max(oldCadence / 2, config.scoring.cadence_min_hours);
        reason = 'Score > 70 for >14 days';
      }
    }
    
    // Apply changes
    if (newCadence !== oldCadence || newStatus !== oldStatus) {
      regEye.cadence_hours = Math.round(newCadence);
      regEye.status = newStatus;
      
      changes.push({
        eye_id: eyeId,
        old_cadence: oldCadence,
        new_cadence: Math.round(newCadence),
        old_status: oldStatus,
        new_status: newStatus,
        reason
      });
      
      console.log(`🔄 ${eyeId}:`);
      console.log(`   Status: ${oldStatus} → ${newStatus}`);
      console.log(`   Cadence: ${oldCadence}h → ${Math.round(newCadence)}h`);
      console.log(`   Reason: ${reason}`);
      console.log('');
    }
  }
  
  // Persist to registry (config updates are manual for now)
  saveRegistry(registry);
  
  // Write evolution event
  const evolveEvent = {
    ts: new Date().toISOString(),
    type: 'eyes_evolved',
    date,
    changes,
    summary: `${changes.length} eyes adjusted`
  };
  
  const evolvePath = path.join(STATE_DIR, 'evolution.jsonl');
  fs.appendFileSync(evolvePath, JSON.stringify(evolveEvent) + '\n');
  
  if (changes.length === 0) {
    console.log('🟢 No changes needed - all eyes stable');
  }
  
  console.log(`✅ Evolution complete: ${changes.length} eyes adjusted`);
  
  return changes;
}

// LIST: Show all eyes and their status
function list() {
  const config = loadConfig();
  const registry = loadRegistry();
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   EXTERNAL EYES - REGISTRY');
  console.log('═══════════════════════════════════════════════════════════');
  
  config.eyes.forEach(eye => {
    const reg = registry.eyes.find(e => e.id === eye.id);
    const runtimeEye = effectiveEye(eye, reg);
    const statusEmoji = {
      active: '✅',
      probation: '🔍',
      dormant: '💤',
      retired: '⏹️'
    }[runtimeEye.status] || '⚪';
    
    console.log(`${statusEmoji} ${eye.id} (${runtimeEye.status})`);
    console.log(`   Name: ${eye.name}`);
    console.log(`   Cadence: ${runtimeEye.cadence_hours}h`);
    console.log(`   Score EMA: ${runtimeEye.score_ema.toFixed(1)}`);
    console.log(`   Topics: ${eye.topics?.join(', ') || 'none'}`);
    console.log(`   Runs: ${reg?.run_count || 0}, Items: ${reg?.total_items || 0}`);
    console.log(`   Budget: ${eye.budgets?.max_items || 'N/A'} items, ${eye.budgets?.max_seconds || 'N/A'}s`);
    console.log('');
  });
  
  console.log('───────────────────────────────────────────────────────────');
  console.log(`Total: ${config.eyes.length} eyes configured`);
  console.log('═══════════════════════════════════════════════════════════');
  
  return config.eyes;
}

// PROPOSE: Create a new eye proposal
function propose(name, domain, notes) {
  ensureDirs();
  
  if (!name || !domain) {
    console.error('Usage: propose "<name>" "<domain>" "<notes>"');
    return null;
  }
  
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20);
  const date = getToday();
  
  const proposal = {
    id: `proto_${id}`,
    name,
    proposed_domains: [domain],
    notes,
    proposed_status: 'probation',
    proposed_cadence_hours: 24,
    proposed_budgets: {
      max_items: 10,
      max_seconds: 30,
      max_bytes: 1048576,
      max_requests: 3
    },
    proposed_topics: [],
    proposed_date: date,
    proposed_by: 'external_eyes.js propose',
    status: 'pending_review'
  };
  
  const proposalPath = path.join(PROPOSALS_DIR, `${date}.json`);
  let proposals = [];
  if (fs.existsSync(proposalPath)) {
    proposals = JSON.parse(fs.readFileSync(proposalPath, 'utf8'));
  }
  
  proposals.push(proposal);
  fs.writeFileSync(proposalPath, JSON.stringify(proposals, null, 2));
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   EYE PROPOSAL CREATED');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`ID: ${proposal.id}`);
  console.log(`Name: ${name}`);
  console.log(`Domain: ${domain}`);
  console.log(`Status: pending_review`);
  console.log(`File: ${proposalPath}`);
  console.log('');
  console.log('⏭️  Next: Review proposal and add to config/external_eyes.json');
  console.log('═══════════════════════════════════════════════════════════');
  
  return proposal;
}

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = {};
  const positional = [];
  
  for (const arg of args.slice(1)) {
    if (arg.startsWith('--eye=')) {
      opts.eye = arg.slice(6);
    } else if (arg.startsWith('--max-eyes=')) {
      opts.maxEyes = parseInt(arg.slice(11), 10);
    } else if (arg.startsWith('--')) {
      // Other flags
    } else if (!arg.startsWith('-') && positional.length < 3) {
      positional.push(arg);
    }
  }
  
  return { cmd, opts, positional };
}

// Main
async function main() {
  const { cmd, opts, positional } = parseArgs();
  
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('external_eyes.js v1.0 - External Eyes Framework');
    console.log('');
    console.log('Commands:');
    console.log('  run [--eye=<id>] [--max-eyes=N]       Run eligible eyes');
    console.log('  score [YYYY-MM-DD]                    Compute usefulness metrics');
    console.log('  evolve [YYYY-MM-DD]                   Adjust cadence/status based on scores');
    console.log('  list                                  Show all eyes and status');
    console.log('  propose "<name>" "<domain>" "<notes>"  Propose new eye (requires manual review)');
    console.log('');
    console.log('Constraints:');
    console.log('  - Budgets enforced (max_items, max_seconds, max_bytes, max_requests)');
    console.log('  - Domain allowlisting required');
    console.log('  - Probation status for new eyes');
    console.log('  - Deterministic scoring, NO LLM required');
    return;
  }
  
  switch (cmd) {
    case 'run':
      await run(opts);
      break;
    case 'score':
      score(positional[0] || null);
      break;
    case 'evolve':
      evolve(positional[0] || null);
      break;
    case 'list':
      list();
      break;
    case 'propose':
      if (positional.length < 2) {
        console.error('Usage: propose "<name>" "<domain>" ["<notes>"]');
        process.exit(1);
      }
      propose(positional[0], positional[1], positional[2] || '');
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

// Export for testing
module.exports = {
  run,
  score,
  evolve,
  list,
  propose,
  loadConfig,
  loadRegistry,
  saveRegistry,
  isDomainAllowed,
  computeHash,
  computeOutcomeSignals,
  ensureDirs,
  safeReadJsonl,
  computeYieldSignals
};

// Run if called directly
if (require.main === module) {
  main();
}
