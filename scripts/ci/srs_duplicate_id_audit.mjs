#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const INPUT = path.join(ROOT, "artifacts", "srs_full_regression_current.json");
const OUT_JSON = path.join(ROOT, "artifacts", "srs_duplicate_id_audit_current.json");
const OUT_MD = path.join(ROOT, "docs", "workspace", "SRS_DUPLICATE_ID_AUDIT_CURRENT.md");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const payload = readJson(INPUT);
const rows = Array.isArray(payload.rows) ? payload.rows : [];

const byId = new Map();
for (const row of rows) {
  const id = String(row?.id || "").trim().toUpperCase();
  if (!id) continue;
  if (!byId.has(id)) byId.set(id, []);
  byId.get(id).push(row);
}

const duplicates = [];
for (const [id, items] of byId.entries()) {
  if (items.length <= 1) continue;
  const statusSet = [...new Set(items.map((r) => String(r?.status || "").trim()).filter(Boolean))].sort();
  const sectionSet = [...new Set(items.map((r) => String(r?.section || "").trim()).filter(Boolean))].sort();
  duplicates.push({
    id,
    count: items.length,
    statuses: statusSet,
    sections: sectionSet,
    impactMax: Math.max(...items.map((r) => Number(r?.impact || 0))),
    hasStatusConflict: statusSet.length > 1
  });
}

duplicates.sort((a, b) => b.count - a.count || b.impactMax - a.impactMax || a.id.localeCompare(b.id));

const summary = {
  totalRows: rows.length,
  uniqueIds: byId.size,
  duplicateIds: duplicates.length,
  duplicateRows: duplicates.reduce((acc, d) => acc + d.count - 1, 0),
  duplicateStatusConflicts: duplicates.filter((d) => d.hasStatusConflict).length
};

const out = {
  ok: true,
  type: "srs_duplicate_id_audit",
  source: "core/local/artifacts/srs_full_regression_current.json",
  summary,
  duplicates
};

ensureDir(OUT_JSON);
fs.writeFileSync(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`);

const lines = [];
lines.push("# SRS Duplicate ID Audit");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("## Summary");
lines.push(`- totalRows: ${summary.totalRows}`);
lines.push(`- uniqueIds: ${summary.uniqueIds}`);
lines.push(`- duplicateIds: ${summary.duplicateIds}`);
lines.push(`- duplicateRows: ${summary.duplicateRows}`);
lines.push(`- duplicateStatusConflicts: ${summary.duplicateStatusConflicts}`);
lines.push("");
lines.push("| Rank | ID | Count | Max Impact | Statuses | Conflict | Sections |");
lines.push("| --- | --- | --- | --- | --- | --- | --- |");

duplicates.forEach((d, idx) => {
  lines.push(
    `| ${idx + 1} | ${d.id} | ${d.count} | ${d.impactMax} | ${(d.statuses || []).join(", ")} | ${
      d.hasStatusConflict ? "yes" : "no"
    } | ${(d.sections || []).slice(0, 3).join(" ; ").replace(/\|/g, "\\|")} |`
  );
});

ensureDir(OUT_MD);
fs.writeFileSync(OUT_MD, `${lines.join("\n")}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      type: out.type,
      out_json: path.relative(ROOT, OUT_JSON),
      out_markdown: path.relative(ROOT, OUT_MD),
      summary
    },
    null,
    2
  )
);
