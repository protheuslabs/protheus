#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const INPUT = path.join(ROOT, "artifacts", "srs_actionable_map_current.json");
const OUT_JSON = path.join(ROOT, "artifacts", "todo_execution_full_current.json");
const OUT_MD = path.join(ROOT, "docs", "workspace", "TODO_EXECUTION_FULL.md");

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

const data = readJson(INPUT);
const rows = Array.isArray(data.rows) ? data.rows : [];

const bucketRank = {
  execute_now: 0,
  repair_lane: 1,
  design_required: 2,
  blocked_external: 3
};

const statusRank = {
  in_progress: 0,
  queued: 1,
  blocked: 2
};

const sorted = [...rows].sort((a, b) => {
  const ab = a.todoBucket ?? "";
  const bb = b.todoBucket ?? "";
  const ar = bucketRank[ab] ?? 99;
  const br = bucketRank[bb] ?? 99;
  if (ar !== br) return ar - br;

  const as = statusRank[a.status] ?? 99;
  const bs = statusRank[b.status] ?? 99;
  if (as !== bs) return as - bs;

  const ai = toInt(a.impact, 0);
  const bi = toInt(b.impact, 0);
  if (ai !== bi) return bi - ai;

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
    blocked_external: sorted.filter((r) => r.todoBucket === "blocked_external").length
  },
  byStatus: {
    in_progress: sorted.filter((r) => r.status === "in_progress").length,
    queued: sorted.filter((r) => r.status === "queued").length,
    blocked: sorted.filter((r) => r.status === "blocked").length
  }
};

const outPayload = {
  ok: true,
  type: "todo_full_queue",
  source: "artifacts/srs_actionable_map_current.json",
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
lines.push(`- in_progress: ${summary.byStatus.in_progress}`);
lines.push(`- queued: ${summary.byStatus.queued}`);
lines.push(`- blocked: ${summary.byStatus.blocked}`);
lines.push("");
lines.push("| Order | ID | Status | Bucket | Impact | Layer | Lane | Runnable | Section |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");

sorted.forEach((row, idx) => {
  lines.push(
    `| ${idx + 1} | ${row.id || ""} | ${row.status || ""} | ${row.todoBucket || ""} | ${row.impact || ""} | ${row.layerMap || ""} | ${row.laneScript || ""} | ${row.laneRunnable ? "yes" : "no"} | ${(row.section || "").replace(/\|/g, "\\|")} |`
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
