#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const INPUT = path.join(ROOT, "core", "local", "artifacts", "srs_full_regression_current.json");
const OUT_JSON = path.join(ROOT, "core", "local", "artifacts", "todo_audit_full_current.json");
const OUT_MD = path.join(ROOT, "local", "workspace", "reports", "TODO_AUDIT_FULL.md");

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

function mapAuditStatus(row) {
  const original = String(row?.status || "").trim();
  const sourceStatus = ["reviewed", "audited"].includes(original) ? "" : original;
  const severity = String(row?.regression?.severity || "pass").trim();
  const blockedLike = sourceStatus === "blocked" || sourceStatus === "blocked_external_prepared";
  const needsDeepAudit = blockedLike || severity !== "pass";
  return {
    ...row,
    sourceStatus,
    status: needsDeepAudit ? "audited" : "reviewed"
  };
}

function dedupeRows(rows) {
  const byId = new Map();
  for (const row of rows) {
    const key = String(row?.id || "").trim().toUpperCase();
    if (!key) continue;
    if (!byId.has(key)) {
      byId.set(key, {
        ...row,
        id: key,
        duplicateCount: 1,
        duplicateSections: new Set([String(row.section || "").trim()].filter(Boolean)),
        duplicateSourceStatuses: new Set([String(row.sourceStatus || "").trim()].filter(Boolean))
      });
      continue;
    }
    const current = byId.get(key);
    current.duplicateCount += 1;
    const nextImpact = toInt(row.impact, 0);
    const curImpact = toInt(current.impact, 0);
    if (nextImpact > curImpact) {
      current.impact = row.impact;
    }
    if (String(row.status || "") === "audited") {
      current.status = "audited";
    }
    if (String(row.sourceStatus || "") === "blocked_external_prepared") {
      current.sourceStatus = "blocked_external_prepared";
    }
    const severityRank = { fail: 3, warn: 2, pass: 1 };
    const curSev = String(current?.regression?.severity || "pass");
    const nextSev = String(row?.regression?.severity || "pass");
    if ((severityRank[nextSev] || 1) > (severityRank[curSev] || 1)) {
      current.regression = row.regression;
    }
    const curSec = String(current.section || "").trim();
    const nextSec = String(row.section || "").trim();
    if (!curSec && nextSec) current.section = nextSec;
    if (nextSec) current.duplicateSections.add(nextSec);
    const nextSource = String(row.sourceStatus || "").trim();
    if (nextSource) current.duplicateSourceStatuses.add(nextSource);
  }

  return [...byId.values()].map((row) => ({
    ...row,
    duplicateSections: [...row.duplicateSections].sort(),
    duplicateSourceStatuses: [...row.duplicateSourceStatuses].sort()
  }));
}

const data = readJson(INPUT);
const rows = Array.isArray(data.rows) ? data.rows : [];
const normalized = rows.map(mapAuditStatus);
const deduped = dedupeRows(normalized);

const sorted = [...deduped].sort((a, b) => {
  const ai = toInt(a.impact, 0);
  const bi = toInt(b.impact, 0);
  if (ai !== bi) return bi - ai;

  if ((a.status || "") !== (b.status || "")) {
    // Put deeper audits first at equal impact.
    if ((a.status || "") === "audited") return -1;
    if ((b.status || "") === "audited") return 1;
  }

  if ((a.section || "") !== (b.section || "")) {
    return (a.section || "").localeCompare(b.section || "");
  }
  return (a.id || "").localeCompare(b.id || "");
});

const bySourceStatus = {};
for (const row of sorted) {
  const key = String(row.sourceStatus || "cleared_reviewed_or_audited");
  bySourceStatus[key] = (bySourceStatus[key] || 0) + 1;
}

const byRegressionSeverity = {};
for (const row of sorted) {
  const key = String(row?.regression?.severity || "pass");
  byRegressionSeverity[key] = (byRegressionSeverity[key] || 0) + 1;
}

const summary = {
  generatedAt: new Date().toISOString(),
  total: sorted.length,
  rawTotalRows: rows.length,
  duplicateRowsCollapsed: rows.length - sorted.length,
  reviewed: sorted.filter((r) => r.status === "reviewed").length,
  audited: sorted.filter((r) => r.status === "audited").length,
  bySourceStatus,
  byRegressionSeverity
};

const coverage = {
  rawTotalRows: rows.length,
  rawRowsRepresented: rows.length,
  uniqueRows: sorted.length,
  uniqueMappedRows: sorted.filter((r) => r.status === "reviewed" || r.status === "audited").length
};

const payload = {
  ok: coverage.uniqueRows === coverage.uniqueMappedRows && coverage.rawRowsRepresented === coverage.rawTotalRows,
  type: "todo_audit_full",
  source: "core/local/artifacts/srs_full_regression_current.json",
  summary,
  coverage,
  rows: sorted
};

ensureDir(OUT_JSON);
fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`);

const lines = [];
lines.push("# TODO Audit Queue (Full SRS)");
lines.push("");
lines.push(`Generated: ${summary.generatedAt}`);
lines.push("");
lines.push("## Summary");
lines.push(`- total: ${summary.total}`);
lines.push(`- raw total rows: ${summary.rawTotalRows}`);
lines.push(`- duplicate rows collapsed: ${summary.duplicateRowsCollapsed}`);
lines.push(`- reviewed: ${summary.reviewed}`);
lines.push(`- audited: ${summary.audited}`);
lines.push(`- coverage (raw): ${coverage.rawRowsRepresented}/${coverage.rawTotalRows}`);
lines.push(`- coverage (unique): ${coverage.uniqueMappedRows}/${coverage.uniqueRows}`);
lines.push("");
lines.push("## Source Status Breakdown");
Object.keys(bySourceStatus)
  .sort((a, b) => a.localeCompare(b))
  .forEach((k) => lines.push(`- ${k}: ${bySourceStatus[k]}`));
lines.push("");
lines.push("## Regression Severity Breakdown");
Object.keys(byRegressionSeverity)
  .sort((a, b) => a.localeCompare(b))
  .forEach((k) => lines.push(`- ${k}: ${byRegressionSeverity[k]}`));
lines.push("");
lines.push("| Order | ID | Status | Source Status | Impact | Dupes | Layer | Regression | Section |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");

sorted.forEach((row, idx) => {
  lines.push(
    `| ${idx + 1} | ${row.id || ""} | ${row.status || ""} | ${row.sourceStatus || ""} | ${row.impact || ""} | ${row.duplicateCount || 1} | ${row.layerMap || ""} | ${row?.regression?.severity || "pass"} | ${(row.section || "").replace(/\|/g, "\\|")} |`
  );
});

ensureDir(OUT_MD);
fs.writeFileSync(OUT_MD, `${lines.join("\n")}\n`);

console.log(
  JSON.stringify(
    {
      ok: payload.ok,
      type: payload.type,
      out_json: path.relative(ROOT, OUT_JSON),
      out_markdown: path.relative(ROOT, OUT_MD),
      summary,
      coverage
    },
    null,
    2
  )
);

if (!payload.ok) process.exitCode = 1;
