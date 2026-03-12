#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const CLIENT_SYSTEMS = path.join(ROOT, "client", "runtime", "systems");
const OUT_JSON = path.join(ROOT, "artifacts", "client_wrapper_compaction_candidates_current.json");
const OUT_MD = path.join(ROOT, "docs", "workspace", "CLIENT_WRAPPER_COMPACTION_CANDIDATES.md");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = fs.existsSync(CLIENT_SYSTEMS) ? walk(CLIENT_SYSTEMS) : [];

const groups = new Map();
for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  const hash = crypto.createHash("sha1").update(content).digest("hex");
  if (!groups.has(hash)) groups.set(hash, []);
  groups.get(hash).push({
    path: path.relative(ROOT, file),
    size: Buffer.byteLength(content, "utf8"),
    isBootstrap: content.includes("ts_bootstrap.ts").valueOf()
  });
}

const duplicates = [...groups.values()]
  .filter((g) => g.length > 1)
  .map((g) => ({
    count: g.length,
    approxBytes: g.reduce((acc, f) => acc + f.size, 0),
    bootstrapLike: g.every((f) => f.isBootstrap),
    files: g.map((f) => f.path).sort()
  }))
  .sort((a, b) => b.count - a.count || b.approxBytes - a.approxBytes);

const summary = {
  totalTsFiles: files.length,
  duplicateGroups: duplicates.length,
  duplicateFiles: duplicates.reduce((acc, g) => acc + g.count, 0),
  duplicateRows: duplicates.reduce((acc, g) => acc + (g.count - 1), 0),
  bootstrapDuplicateGroups: duplicates.filter((g) => g.bootstrapLike).length
};

const out = {
  ok: true,
  type: "client_wrapper_compaction_candidates",
  source: "client/runtime/systems/**/*.ts",
  summary,
  duplicates
};

ensureDir(OUT_JSON);
fs.writeFileSync(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`);

const lines = [];
lines.push("# Client Wrapper Compaction Candidates");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("## Summary");
lines.push(`- totalTsFiles: ${summary.totalTsFiles}`);
lines.push(`- duplicateGroups: ${summary.duplicateGroups}`);
lines.push(`- duplicateFiles: ${summary.duplicateFiles}`);
lines.push(`- duplicateRows: ${summary.duplicateRows}`);
lines.push(`- bootstrapDuplicateGroups: ${summary.bootstrapDuplicateGroups}`);
lines.push("");
lines.push("| Rank | Count | Approx Bytes | Bootstrap-like | Sample Files |");
lines.push("| --- | --- | --- | --- | --- |");
duplicates.forEach((g, idx) => {
  lines.push(
    `| ${idx + 1} | ${g.count} | ${g.approxBytes} | ${g.bootstrapLike ? "yes" : "no"} | ${g.files
      .slice(0, 3)
      .join(" ; ")
      .replace(/\|/g, "\\|")} |`
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
