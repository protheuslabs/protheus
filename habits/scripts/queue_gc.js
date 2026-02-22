#!/usr/bin/env node
/**
 * habits/scripts/queue_gc.js — deterministic queue backpressure + auto-triage
 *
 * Goal:
 * - Prevent runaway queue growth when eyes > human throughput
 *
 * Rules (deterministic):
 * 1) Per-eye cap: keep newest OPEN proposals up to cap_per_eye (default 10)
 *    - Extra OPEN proposals beyond cap are auto-rejected (oldest first)
 * 2) TTL auto-reject (default 48h) for low-impact items only:
 *    - expected_impact=low AND age > ttl_hours => reject
 *
 * Usage:
 *   node habits/scripts/queue_gc.js run [YYYY-MM-DD] [--cap-per-eye=N] [--ttl-hours=N]
 *
 * Env:
 *   QUEUE_DIR=state/queue (legacy optional override)
 *
 * Notes:
 * - Calls sensory_queue.js reject command (decision event, deterministic).
 * - If we cannot parse timestamps, TTL rule is skipped for that item.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function arg(name) {
  const pref = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(pref));
  return a ? a.slice(pref.length) : null;
}

function todayOr(dateStr) {
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  return new Date().toISOString().slice(0, 10);
}

function asInt(x, dflt) {
  if (x == null || String(x).trim() === "") return dflt;
  const n = Number(x);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
}

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function readJsonl(filePath) {
  const out = [];
  if (!fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch {}
  }
  return out;
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function resolveSensoryQueueLogPath(repo) {
  const testDir = String(process.env.SENSORY_QUEUE_TEST_DIR || "").trim();
  if (testDir) {
    return path.join(testDir, "state", "sensory", "queue_log.jsonl");
  }
  const override = String(process.env.QUEUE_GC_QUEUE_LOG || "").trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(repo, override);
  }
  return path.join(repo, "state", "sensory", "queue_log.jsonl");
}

function loadSensoryQueueStatus(repo) {
  const queueLog = resolveSensoryQueueLogPath(repo);
  const rows = readJsonl(queueLog)
    .filter((row) => row && typeof row === 'object')
    .sort((a, b) => new Date(String(a.ts || 0)) - new Date(String(b.ts || 0)));
  const statusById = new Map();
  for (const row of rows) {
    const id = String(row && row.proposal_id || '').trim();
    if (!id || id === 'UNKNOWN') continue;
    const t = String(row && row.type || '').trim().toLowerCase();
    if (t === 'proposal_generated') {
      statusById.set(id, 'open');
      continue;
    }
    if (t === 'proposal_filtered') { statusById.set(id, 'filtered'); continue; }
    if (t === 'proposal_accepted') { statusById.set(id, 'accepted'); continue; }
    if (t === 'proposal_rejected') { statusById.set(id, 'rejected'); continue; }
    if (t === 'proposal_done') { statusById.set(id, 'done'); continue; }
    if (t === 'proposal_snoozed') {
      const until = String(row && row.snooze_until || '').trim();
      if (until && new Date(until) > new Date()) statusById.set(id, 'snoozed');
      else statusById.set(id, 'open');
    }
  }
  return statusById;
}

function loadBudgetPressure(repo, dateStr) {
  const tuningEnabled = String(process.env.QUEUE_GC_BUDGET_TUNING_ENABLED || "1") !== "0";
  if (!tuningEnabled) return { pressure: "none", source: "disabled" };

  const override = String(process.env.QUEUE_GC_BUDGET_PRESSURE || "").trim().toLowerCase();
  if (override === "none" || override === "soft" || override === "hard") {
    return { pressure: override, source: "env_override" };
  }

  const autopausePath = path.join(repo, "state", "autonomy", "budget_autopause.json");
  const autopause = readJsonSafe(autopausePath, null);
  if (autopause && autopause.active === true) {
    const until = String(autopause.until || "").trim();
    const untilMs = Date.parse(until);
    if (!Number.isFinite(untilMs) || untilMs > Date.now()) {
      return { pressure: "hard", source: "autopause" };
    }
  }

  try {
    const status = spawnSync(
      "node",
      ["systems/budget/system_budget.js", "status", dateStr, "--request_tokens_est=0"],
      { cwd: repo, encoding: "utf8" }
    );
    if (status.status === 0) {
      const payload = JSON.parse(String(status.stdout || "{}"));
      const p = String(payload && payload.projection && payload.projection.pressure || "")
        .trim()
        .toLowerCase();
      if (p === "none" || p === "soft" || p === "hard") {
        return { pressure: p, source: "system_budget_status" };
      }
    }
  } catch {
    // Keep deterministic fallback.
  }
  return { pressure: "none", source: "fallback" };
}

function tuneGcByBudget(base, pressure) {
  const out = {
    capPerEye: Number(base.capPerEye || 10),
    capPerType: Number(base.capPerType || 25),
    ttlHours: Number(base.ttlHours || 48),
    pressure: pressure || "none"
  };
  if (pressure === "hard") {
    out.capPerEye = Math.max(1, asInt(process.env.QUEUE_GC_HARD_CAP_PER_EYE, Math.floor(out.capPerEye * 0.5)));
    out.capPerType = Math.max(1, asInt(process.env.QUEUE_GC_HARD_CAP_PER_TYPE, Math.floor(out.capPerType * 0.6)));
    out.ttlHours = Math.max(1, asInt(process.env.QUEUE_GC_HARD_TTL_HOURS, Math.floor(out.ttlHours * 0.5)));
  } else if (pressure === "soft") {
    out.capPerEye = Math.max(1, asInt(process.env.QUEUE_GC_SOFT_CAP_PER_EYE, Math.floor(out.capPerEye * 0.8)));
    out.capPerType = Math.max(1, asInt(process.env.QUEUE_GC_SOFT_CAP_PER_TYPE, Math.floor(out.capPerType * 0.85)));
    out.ttlHours = Math.max(1, asInt(process.env.QUEUE_GC_SOFT_TTL_HOURS, Math.floor(out.ttlHours * 0.8)));
  }
  return out;
}

function findFirstExisting(paths) {
  for (const p of paths) if (fs.existsSync(p)) return p;
  return null;
}

function normalizeStatus(p) {
  const s = (p.status || p.state || "").toString().trim().toLowerCase();
  if (!s) return "open";
  if (s === "open") return "open";
  if (s === "rejected" || s === "reject") return "rejected";
  if (s === "shipped") return "shipped";
  if (s === "no_change" || s === "nochange") return "no_change";
  if (s === "reverted") return "reverted";
  return s;
}

function extractEyeId(p) {
  // Prefer explicit meta source_eye
  if (p.meta && typeof p.meta.source_eye === "string" && p.meta.source_eye.trim()) {
    return p.meta.source_eye.trim();
  }

  // Prefer evidence_ref format: "eye:<id>" (strict)
  if (Array.isArray(p.evidence) && p.evidence.length) {
    const ev = p.evidence[0];
    const ref = (ev && ev.evidence_ref) ? String(ev.evidence_ref) : "";
    const m = ref.match(/\beye:([a-zA-Z0-9_\-]+)\b/);
    if (m) return m[1];
  }

  // Fall back to title: "[Eyes:<id>]"
  const t = (p.title || "").toString();
  const mt = t.match(/\[Eyes:([a-zA-Z0-9_\-]+)\]/);
  if (mt) return mt[1];

  return "unknown_eye";
}

function parseTs(p) {
  // Prefer explicit timestamps if present
  const candidates = [
    p.ts,
    p.created_at,
    p.collected_at,
    p.meta && p.meta.collected_at,
    p.meta && p.meta.ts
  ].filter(Boolean);

  for (const c of candidates) {
    const d = new Date(String(c));
    if (!isNaN(d.getTime())) return d;
  }

  // Infer from evidence path: state/sensory/eyes/raw/YYYY-MM-DD.jsonl
  if (Array.isArray(p.evidence) && p.evidence.length) {
    const ev = p.evidence[0] || {};
    const ep = (ev.path || "").toString();
    const m = ep.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) {
      const d = new Date(`${m[1]}T00:00:00.000Z`);
      if (!isNaN(d.getTime())) return d;
    }
  }

  return null;
}

function isLowImpact(p) {
  const v = (p.expected_impact || "").toString().trim().toLowerCase();
  return v === "low" || v === "";
}

function extractProposalType(p) {
  const direct = (p && p.type) ? String(p.type).trim().toLowerCase() : "";
  if (direct) return direct;
  const alt = (p && p.proposal_type) ? String(p.proposal_type).trim().toLowerCase() : "";
  if (alt) return alt;
  return "unknown";
}

function normalizeDedupText(v) {
  return String(v == null ? "" : v)
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/["'`]/g, "")
    .replace(/\b\d+(\.\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function proposalTopicHint(p) {
  const title = String(p && p.title || "");
  const match = title.match(/topic\s+"([^"]+)"/i);
  if (!match) return "";
  return normalizeDedupText(match[1]);
}

function proposalDedupKey(it) {
  const p = it && it.raw && typeof it.raw === "object" ? it.raw : {};
  const type = String(it && it.type || "unknown").trim().toLowerCase() || "unknown";
  const eye = String(it && it.eye || "unknown_eye").trim().toLowerCase() || "unknown_eye";
  const titleNorm = normalizeDedupText(p.title || "");
  if (type === "cross_signal_opportunity") {
    const topic = proposalTopicHint(p) || titleNorm;
    const dir = /\bdiverging\b/i.test(String(p.title || ""))
      ? "diverging"
      : (/\bconverging\b/i.test(String(p.title || "")) ? "converging" : "unknown");
    return `${type}|${topic}|${dir}`;
  }
  if (type.startsWith("pain") || type.includes("escalation")) {
    const code = normalizeDedupText(p && p.meta && p.meta.pain_code);
    const source = normalizeDedupText(p && p.meta && p.meta.source_eye);
    return `${type}|${source || eye}|${code}|${titleNorm}`;
  }
  return `${type}|${eye}|${titleNorm}`;
}

function isEscalationType(type) {
  const t = String(type || "").trim().toLowerCase();
  if (!t) return false;
  return t.includes("escalation") || t.startsWith("pain");
}

function rejectProposal(repo, proposalId, reason) {
  const sensoryScript = path.join(repo, "habits", "scripts", "sensory_queue.js");
  const proposalScript = path.join(repo, "habits", "scripts", "proposal_queue.js");
  const r = spawnSync("node", [sensoryScript, "reject", proposalId, `--reason=${reason}`], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
  // Keep proposal_queue metrics consistent with sensory_queue terminal decisions.
  const q = spawnSync("node", [proposalScript, "reject", proposalId, reason], { cwd: repo, encoding: "utf8" });
  if (q.status !== 0) {
    console.warn(`queue_gc: proposal_queue reject failed for ${proposalId} (continuing)`);
  }
}

function main() {
  const mode = process.argv[2];
  const dateStr = todayOr(process.argv[3]);
  const baseCapPerEye = Math.max(1, asInt(arg("cap-per-eye"), 10));
  const baseCapPerType = Math.max(1, asInt(arg("cap-per-type"), Number(process.env.QUEUE_GC_CAP_PER_TYPE || 25)));
  const baseTtlHours = Math.max(1, asInt(arg("ttl-hours"), 48));
  const escalationTtlHours = Math.max(
    1,
    asInt(arg("escalation-ttl-hours"), Number(process.env.QUEUE_GC_ESCALATION_TTL_HOURS || 16))
  );

  if (!mode || mode === "--help" || mode === "-h") {
    console.log("Usage:");
    console.log("  node habits/scripts/queue_gc.js run [YYYY-MM-DD] [--cap-per-eye=N] [--cap-per-type=N] [--ttl-hours=N]");
    process.exit(0);
  }

  if (mode !== "run") {
    console.error("Usage:");
    console.error("  node habits/scripts/queue_gc.js run [YYYY-MM-DD] [--cap-per-eye=N] [--cap-per-type=N] [--ttl-hours=N]");
    process.exit(2);
  }

  const repo = repoRoot();
  const budgetPressure = loadBudgetPressure(repo, dateStr);
  const tuned = tuneGcByBudget(
    { capPerEye: baseCapPerEye, capPerType: baseCapPerType, ttlHours: baseTtlHours },
    budgetPressure.pressure
  );
  const capPerEye = tuned.capPerEye;
  const capPerType = tuned.capPerType;
  const ttlHours = tuned.ttlHours;
  const queueDir = path.join(repo, process.env.QUEUE_DIR || path.join("state", "queue"));

  // Try storage locations in priority order (legacy queue + active sensory proposals).
  const proposalsPath = findFirstExisting([
    path.join(queueDir, "proposals.jsonl"),
    path.join(queueDir, "proposals", `${dateStr}.jsonl`),
    path.join(queueDir, "proposals", `${dateStr}.json`),
    path.join(repo, "state", "sensory", "proposals", `${dateStr}.json`)
  ]);

  if (!proposalsPath) {
    console.log(`queue_gc: no proposals file found under ${path.relative(repo, queueDir)} (ok)`);
    process.exit(0);
  }

  const proposals = proposalsPath.endsWith(".json")
    ? JSON.parse(fs.readFileSync(proposalsPath, "utf8"))
    : readJsonl(proposalsPath);
  const queueStatusById = loadSensoryQueueStatus(repo);

  // Normalize and index OPEN proposals.
  const open = [];
  for (const p of proposals) {
    if (!p || typeof p !== "object") continue;
    const st = normalizeStatus(p);
    if (st !== "open") continue;
    const id = (p.id || "").toString().trim();
    if (!id) continue;
    const queueStatus = String(queueStatusById.get(id) || '').toLowerCase();
    if (queueStatus && queueStatus !== 'open') continue;
    open.push({
      id,
      eye: extractEyeId(p),
      type: extractProposalType(p),
      ts: parseTs(p),
      lowImpact: isLowImpact(p),
      raw: p
    });
  }

  const now = new Date(`${dateStr}T23:59:59.999Z`);

  // 1) TTL auto-reject (low impact only)
  const ttlReject = [];
  for (const it of open) {
    if (!it.lowImpact) continue;
    if (!it.ts) continue; // cannot prove age deterministically
    const ageHours = (now.getTime() - it.ts.getTime()) / (1000 * 60 * 60);
    if (ageHours > ttlHours) ttlReject.push(it);
  }

  // 2) Per-eye cap reject (oldest first) after TTL is applied
  // Remove TTL rejects from consideration for cap selection.
  const ttlRejectIds = new Set(ttlReject.map(x => x.id));
  const remaining = open.filter(x => !ttlRejectIds.has(x.id));

  // 2) Dedup reject (keep newest by semantic key)
  const dedupReject = [];
  const dedupEnabled = String(process.env.QUEUE_GC_DEDUP_ENABLED || "1") !== "0";
  const dedupSeen = new Set();
  if (dedupEnabled) {
    const newestFirst = remaining.slice().sort((a, b) => {
      const at = a.ts ? a.ts.getTime() : Number.MAX_SAFE_INTEGER;
      const bt = b.ts ? b.ts.getTime() : Number.MAX_SAFE_INTEGER;
      return bt - at;
    });
    for (const it of newestFirst) {
      const key = proposalDedupKey(it);
      if (!key || key.endsWith("|")) continue;
      if (dedupSeen.has(key)) {
        dedupReject.push(it);
        continue;
      }
      dedupSeen.add(key);
    }
  }

  const dedupRejectIds = new Set(dedupReject.map((x) => x.id));
  const remainingAfterDedup = remaining.filter((x) => !dedupRejectIds.has(x.id));

  // 3) Escalation TTL reject (prevents stale pain/escalation churn)
  const escalationReject = [];
  for (const it of remainingAfterDedup) {
    if (!isEscalationType(it.type)) continue;
    if (!it.ts) continue;
    const ageHours = (now.getTime() - it.ts.getTime()) / (1000 * 60 * 60);
    if (ageHours > escalationTtlHours) escalationReject.push(it);
  }
  const escalationRejectIds = new Set(escalationReject.map((x) => x.id));
  const remainingForCaps = remainingAfterDedup.filter((x) => !escalationRejectIds.has(x.id));

  // 4) Group remaining by eye
  const byEye = new Map(); // eye -> items
  for (const it of remainingForCaps) {
    if (!byEye.has(it.eye)) byEye.set(it.eye, []);
    byEye.get(it.eye).push(it);
  }

  const capReject = [];
  for (const [eye, items] of byEye.entries()) {
    // Sort newest first (missing ts treated as newest-ish so we avoid rejecting unknowns)
    items.sort((a, b) => {
      const at = a.ts ? a.ts.getTime() : Number.MAX_SAFE_INTEGER;
      const bt = b.ts ? b.ts.getTime() : Number.MAX_SAFE_INTEGER;
      return bt - at;
    });
    if (items.length <= capPerEye) continue;
    const overflow = items.slice(capPerEye); // reject oldest among those with known ordering
    capReject.push(...overflow);
  }

  // 5) Per-type cap reject (oldest first), after TTL + dedup + escalation + per-eye rejections are selected
  const preSelectedIds = new Set([...ttlReject, ...dedupReject, ...escalationReject, ...capReject].map((it) => it.id));
  const remainingForType = open.filter((it) => !preSelectedIds.has(it.id));
  const byType = new Map();
  for (const it of remainingForType) {
    const key = String(it.type || "unknown").trim().toLowerCase() || "unknown";
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(it);
  }
  const typeCapReject = [];
  for (const [type, items] of byType.entries()) {
    items.sort((a, b) => {
      const at = a.ts ? a.ts.getTime() : Number.MAX_SAFE_INTEGER;
      const bt = b.ts ? b.ts.getTime() : Number.MAX_SAFE_INTEGER;
      return bt - at;
    });
    if (items.length <= capPerType) continue;
    const overflow = items.slice(capPerType);
    typeCapReject.push(...overflow);
  }

  const toReject = [...ttlReject, ...dedupReject, ...escalationReject, ...capReject, ...typeCapReject];
  if (!toReject.length) {
    console.log(
      `queue_gc: no actions (OPEN=${open.length}, cap_per_eye=${capPerEye}, cap_per_type=${capPerType}, ttl_hours=${ttlHours}, escalation_ttl_hours=${escalationTtlHours}, budget_pressure=${budgetPressure.pressure}, pressure_source=${budgetPressure.source})`
    );
    process.exit(0);
  }

  console.log(
    `queue_gc: rejecting ${toReject.length} proposals (OPEN=${open.length}, dedup=${dedupReject.length}, escalation_ttl=${escalationReject.length}, type_cap=${typeCapReject.length}, budget_pressure=${budgetPressure.pressure}, pressure_source=${budgetPressure.source})`
  );

  // Deterministic order: TTL rejects first (oldest first), then cap rejects (oldest first)
  function oldestFirst(a, b) {
    const at = a.ts ? a.ts.getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.ts ? b.ts.getTime() : Number.MAX_SAFE_INTEGER;
    return at - bt;
  }
  ttlReject.sort(oldestFirst);
  dedupReject.sort(oldestFirst);
  escalationReject.sort(oldestFirst);
  capReject.sort(oldestFirst);
  typeCapReject.sort(oldestFirst);

  // Record deterministic reject decisions via proposal_queue.js.
  for (const it of ttlReject) {
    const reason = `auto:queue_gc ttl>${ttlHours}h eye:${it.eye}`;
    rejectProposal(repo, it.id, reason);
  }
  for (const it of dedupReject) {
    const reason = `auto:queue_gc dedup type:${it.type}`;
    rejectProposal(repo, it.id, reason);
  }
  for (const it of escalationReject) {
    const reason = `auto:queue_gc escalation_ttl>${escalationTtlHours}h type:${it.type}`;
    rejectProposal(repo, it.id, reason);
  }
  for (const it of capReject) {
    const reason = `auto:queue_gc cap>${capPerEye} eye:${it.eye}`;
    rejectProposal(repo, it.id, reason);
  }
  for (const it of typeCapReject) {
    const reason = `auto:queue_gc type_cap>${capPerType} type:${it.type}`;
    rejectProposal(repo, it.id, reason);
  }

  console.log("queue_gc: done");
}

main();
