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
 *   QUEUE_DIR=state/queue (optional override)
 *
 * Notes:
 * - Calls proposal_queue.js reject command (decision event, deterministic).
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
  const n = Number(x);
  return Number.isFinite(n) ? n : dflt;
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

function rejectProposal(repo, proposalId, reason) {
  const script = path.join(repo, "habits", "scripts", "proposal_queue.js");
  const r = spawnSync("node", [script, "reject", proposalId, reason], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
}

function main() {
  const mode = process.argv[2];
  const dateStr = todayOr(process.argv[3]);
  const capPerEye = asInt(arg("cap-per-eye"), 10);
  const ttlHours = asInt(arg("ttl-hours"), 48);

  if (!mode || mode === "--help" || mode === "-h") {
    console.log("Usage:");
    console.log("  node habits/scripts/queue_gc.js run [YYYY-MM-DD] [--cap-per-eye=N] [--ttl-hours=N]");
    process.exit(0);
  }

  if (mode !== "run") {
    console.error("Usage:");
    console.error("  node habits/scripts/queue_gc.js run [YYYY-MM-DD] [--cap-per-eye=N] [--ttl-hours=N]");
    process.exit(2);
  }

  const repo = repoRoot();
  const queueDir = path.join(repo, process.env.QUEUE_DIR || path.join("state", "queue"));

  // Try a few plausible storage locations (keep this resilient).
  const proposalsPath = findFirstExisting([
    path.join(queueDir, "proposals.jsonl"),
    path.join(queueDir, "proposals", `${dateStr}.jsonl`),
    path.join(queueDir, "proposals", `${dateStr}.json`)
  ]);

  if (!proposalsPath) {
    console.log(`queue_gc: no proposals file found under ${path.relative(repo, queueDir)} (ok)`);
    process.exit(0);
  }

  const proposals = proposalsPath.endsWith(".json")
    ? JSON.parse(fs.readFileSync(proposalsPath, "utf8"))
    : readJsonl(proposalsPath);

  // Normalize and index OPEN proposals.
  const open = [];
  for (const p of proposals) {
    if (!p || typeof p !== "object") continue;
    const st = normalizeStatus(p);
    if (st !== "open") continue;
    const id = (p.id || "").toString().trim();
    if (!id) continue;
    open.push({
      id,
      eye: extractEyeId(p),
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

  // Group remaining by eye
  const byEye = new Map(); // eye -> items
  for (const it of remaining) {
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

  const toReject = [...ttlReject, ...capReject];
  if (!toReject.length) {
    console.log(`queue_gc: no actions (OPEN=${open.length}, cap_per_eye=${capPerEye}, ttl_hours=${ttlHours})`);
    process.exit(0);
  }

  console.log(`queue_gc: rejecting ${toReject.length} proposals (OPEN=${open.length})`);

  // Deterministic order: TTL rejects first (oldest first), then cap rejects (oldest first)
  function oldestFirst(a, b) {
    const at = a.ts ? a.ts.getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.ts ? b.ts.getTime() : Number.MAX_SAFE_INTEGER;
    return at - bt;
  }
  ttlReject.sort(oldestFirst);
  capReject.sort(oldestFirst);

  // Record deterministic reject decisions via proposal_queue.js.
  for (const it of ttlReject) {
    const reason = `auto:queue_gc ttl>${ttlHours}h eye:${it.eye}`;
    rejectProposal(repo, it.id, reason);
  }
  for (const it of capReject) {
    const reason = `auto:queue_gc cap>${capPerEye} eye:${it.eye}`;
    rejectProposal(repo, it.id, reason);
  }

  console.log("queue_gc: done");
}

main();
