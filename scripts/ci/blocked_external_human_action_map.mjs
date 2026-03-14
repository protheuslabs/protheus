#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SRS_REGRESSION_JSON = path.join(ROOT, "core", "local", "artifacts", "srs_full_regression_current.json");
const HUMAN_ACTIONS_MD = path.join(ROOT, "docs", "client", "HUMAN_ONLY_ACTIONS.md");
const OUT_JSON = path.join(ROOT, "core", "local", "artifacts", "blocked_external_human_action_map_current.json");
const OUT_MD = path.join(ROOT, "local", "workspace", "reports", "BLOCKED_EXTERNAL_HUMAN_ACTION_MAP.md");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function parseHumanActions(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = new Map();
  for (const line of lines) {
    if (!/^\|\s*HMAN-[A-Z0-9\-]+\s*\|/i.test(line)) continue;
    const cols = line.split("|").map((c) => c.trim());
    const id = String(cols[1] || "").toUpperCase();
    const action = String(cols[2] || "");
    const evidenceCol = String(cols[4] || "");
    const deps = String(cols[5] || "");
    const evidencePathMatch = evidenceCol.match(/state\/ops\/evidence\/[^\s`|]+/);
    out.set(id, {
      id,
      action,
      evidencePath: evidencePathMatch ? evidencePathMatch[0] : "",
      dependencies: deps
    });
  }
  return out;
}

function uniqueById(rows) {
  const byId = new Map();
  for (const row of rows) {
    const id = String(row?.id || "").trim().toUpperCase();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, row);
  }
  return [...byId.values()];
}

function main() {
  const regression = readJson(SRS_REGRESSION_JSON);
  const rows = Array.isArray(regression.rows) ? regression.rows : [];
  const blockedRows = uniqueById(rows.filter((r) => String(r.status || "") === "blocked_external_prepared"));
  const humanActions = parseHumanActions(fs.readFileSync(HUMAN_ACTIONS_MD, "utf8"));

  const mapped = blockedRows.map((row) => {
    const text = [row.upgrade, row.why, row.exitCriteria, row.section].filter(Boolean).join(" ");
    const refs = [...new Set((text.match(/HMAN-[A-Z0-9\-]+/g) || []).map((x) => x.toUpperCase()))].sort();
    const refDetails = refs.map((id) => {
      const meta = humanActions.get(id);
      const evidencePath = meta?.evidencePath || "";
      const evidenceExists = evidencePath ? fs.existsSync(path.join(ROOT, evidencePath)) : false;
      return {
        id,
        action: meta?.action || "",
        evidencePath,
        evidenceExists
      };
    });
    const evidenceMapped = refDetails.filter((r) => r.evidencePath).length;
    const evidenceExisting = refDetails.filter((r) => r.evidenceExists).length;
    let status = "waiting_on_human_evidence";
    if (refs.length === 0) status = "missing_human_mapping";
    else if (evidenceMapped === refs.length && evidenceExisting === refs.length) status = "ready_for_external_reconcile";
    else if (evidenceMapped > 0 && evidenceExisting === 0) status = "mapped_no_evidence_artifacts";
    return {
      id: String(row.id || "").toUpperCase(),
      impact: row.impact,
      layerMap: row.layerMap,
      section: row.section,
      hmanRefs: refs,
      hmanDetails: refDetails,
      status
    };
  });

  const summary = {
    total: mapped.length,
    missing_human_mapping: mapped.filter((m) => m.status === "missing_human_mapping").length,
    mapped_no_evidence_artifacts: mapped.filter((m) => m.status === "mapped_no_evidence_artifacts").length,
    waiting_on_human_evidence: mapped.filter((m) => m.status === "waiting_on_human_evidence").length,
    ready_for_external_reconcile: mapped.filter((m) => m.status === "ready_for_external_reconcile").length
  };

  const payload = {
    ok: true,
    type: "blocked_external_human_action_map",
    source: {
      srsRegression: "core/local/artifacts/srs_full_regression_current.json",
      humanActions: "docs/client/HUMAN_ONLY_ACTIONS.md"
    },
    summary,
    rows: mapped
  };

  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`);

  const lines = [];
  lines.push("# Blocked External Human-Action Map");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- total: ${summary.total}`);
  lines.push(`- missing_human_mapping: ${summary.missing_human_mapping}`);
  lines.push(`- mapped_no_evidence_artifacts: ${summary.mapped_no_evidence_artifacts}`);
  lines.push(`- waiting_on_human_evidence: ${summary.waiting_on_human_evidence}`);
  lines.push(`- ready_for_external_reconcile: ${summary.ready_for_external_reconcile}`);
  lines.push("");
  lines.push("| ID | Impact | Status | HMAN Refs | Section |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const row of mapped.sort((a, b) => Number(b.impact || 0) - Number(a.impact || 0) || a.id.localeCompare(b.id))) {
    lines.push(
      `| ${row.id} | ${row.impact || ""} | ${row.status} | ${(row.hmanRefs || []).join(", ")} | ${(row.section || "").replace(/\|/g, "\\|")} |`
    );
  }

  ensureDir(OUT_MD);
  fs.writeFileSync(OUT_MD, `${lines.join("\n")}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        type: payload.type,
        out_json: path.relative(ROOT, OUT_JSON),
        out_markdown: path.relative(ROOT, OUT_MD),
        summary
      },
      null,
      2
    )
  );
}

main();
