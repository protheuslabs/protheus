#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const INPUT = path.join(ROOT, "core", "local", "artifacts", "srs_actionable_map_current.json");
const OUT_JSON = path.join(ROOT, "core", "local", "artifacts", "todo_execution_full_current.json");
const OUT_MD = path.join(ROOT, "local", "workspace", "reports", "TODO_EXECUTION_FULL.md");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseArgs(argv) {
  const out = {
    auditPass: true
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--audit-pass=0" || arg === "--no-audit-pass") out.auditPass = false;
    if (arg === "--audit-pass=1" || arg === "--audit-pass") out.auditPass = true;
  }
  return out;
}

const data = readJson(INPUT);
const rows = Array.isArray(data.rows) ? data.rows : [];
const args = parseArgs(process.argv);

const bucketRank = {
  execute_now: 0,
  repair_lane: 1,
  design_required: 2,
  blocked_external: 3,
  blocked_external_prepared: 3
};

const sourceStatusRank = {
  in_progress: 0,
  queued: 1,
  blocked: 2,
  blocked_external_prepared: 3,
  "": 4
};

const normalized = rows.map((row) => {
  const original = String(row?.status || "").trim();
  const sourceStatus = ["reviewed", "audited"].includes(original) ? "" : original;
  const bucket = String(row?.todoBucket || "");
  const blockedLike =
    bucket === "blocked_external" ||
    bucket === "blocked_external_prepared" ||
    sourceStatus === "blocked" ||
    sourceStatus === "blocked_external_prepared";
  const auditStatus = blockedLike ? "audited" : "reviewed";
  return {
    ...row,
    sourceStatus,
    status: args.auditPass ? auditStatus : sourceStatus || original
  };
});

const sorted = [...normalized].sort((a, b) => {
  const ai = toInt(a.impact, 0);
  const bi = toInt(b.impact, 0);
  if (ai !== bi) return bi - ai;

  const ab = a.todoBucket ?? "";
  const bb = b.todoBucket ?? "";
  const ar = bucketRank[ab] ?? 99;
  const br = bucketRank[bb] ?? 99;
  if (ar !== br) return ar - br;

  const as = sourceStatusRank[a.sourceStatus ?? ""] ?? 99;
  const bs = sourceStatusRank[b.sourceStatus ?? ""] ?? 99;
  if (as !== bs) return as - bs;

  if ((a.section || "") !== (b.section || "")) {
    return (a.section || "").localeCompare(b.section || "");
  }
  return (a.id || "").localeCompare(b.id || "");
});

const summary = {
  generatedAt: new Date().toISOString(),
  total: sorted.length,
  byBucket: {
    execute_now: sorted.filter((r) => r.todoBucket === "execute_now").length,
    repair_lane: sorted.filter((r) => r.todoBucket === "repair_lane").length,
    design_required: sorted.filter((r) => r.todoBucket === "design_required").length,
    blocked_external:
      sorted.filter((r) => r.todoBucket === "blocked_external" || r.todoBucket === "blocked_external_prepared").length
  },
  byAuditStatus: {
    reviewed: sorted.filter((r) => r.status === "reviewed").length,
    audited: sorted.filter((r) => r.status === "audited").length
  },
  bySourceStatus: {
    in_progress: sorted.filter((r) => r.sourceStatus === "in_progress").length,
    queued: sorted.filter((r) => r.sourceStatus === "queued").length,
    blocked: sorted.filter((r) => r.sourceStatus === "blocked").length,
    blocked_external_prepared: sorted.filter((r) => r.sourceStatus === "blocked_external_prepared").length,
    cleared_reviewed_or_audited: sorted.filter((r) => r.sourceStatus === "").length
  }
};

const outPayload = {
  ok: true,
  type: "todo_full_queue",
  source: "core/local/artifacts/srs_actionable_map_current.json",
  summary,
  rows: sorted
};

ensureDir(OUT_JSON);
fs.writeFileSync(OUT_JSON, `${JSON.stringify(outPayload, null, 2)}\n`);

const lines = [];
lines.push("# TODO Execution Queue (Full)");
lines.push("");
lines.push(`Generated: ${summary.generatedAt}`);
lines.push("");
lines.push("## Summary");
lines.push(`- total: ${summary.total}`);
lines.push(`- execute_now: ${summary.byBucket.execute_now}`);
lines.push(`- repair_lane: ${summary.byBucket.repair_lane}`);
lines.push(`- design_required: ${summary.byBucket.design_required}`);
lines.push(`- blocked_external: ${summary.byBucket.blocked_external}`);
lines.push(`- reviewed: ${summary.byAuditStatus.reviewed}`);
lines.push(`- audited: ${summary.byAuditStatus.audited}`);
lines.push(`- source in_progress: ${summary.bySourceStatus.in_progress}`);
lines.push(`- source queued: ${summary.bySourceStatus.queued}`);
lines.push(`- source blocked: ${summary.bySourceStatus.blocked}`);
lines.push(`- source blocked_external_prepared: ${summary.bySourceStatus.blocked_external_prepared}`);
lines.push(`- source cleared_reviewed_or_audited: ${summary.bySourceStatus.cleared_reviewed_or_audited}`);
lines.push("");
lines.push("| Order | ID | Status | Source Status | Bucket | Impact | Layer | Lane | Runnable | Section |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

sorted.forEach((row, idx) => {
  lines.push(
    `| ${idx + 1} | ${row.id || ""} | ${row.status || ""} | ${row.sourceStatus || ""} | ${row.todoBucket || ""} | ${row.impact || ""} | ${row.layerMap || ""} | ${row.laneScript || ""} | ${row.laneRunnable ? "yes" : "no"} | ${(row.section || "").replace(/\|/g, "\\|")} |`
  );
});

ensureDir(OUT_MD);
fs.writeFileSync(OUT_MD, `${lines.join("\n")}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      type: "todo_full_queue",
      out_json: path.relative(ROOT, OUT_JSON),
      out_markdown: path.relative(ROOT, OUT_MD),
      summary
    },
    null,
    2
  )
);
