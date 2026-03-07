const assert = require("assert");
const { execSync } = require("child_process");
const path = require("path");

function run(cmd, env = {}) {
  return execSync(cmd, { encoding: "utf8", env: { ...process.env, ...env } });
}

function extractCount(blockName, output) {
  const re = new RegExp(`===\\s+${blockName}\\s+===\\s*[\\s\\S]*?Count:\\s*(\\d+)`, "i");
  const m = output.match(re);
  return m ? parseInt(m[1], 10) : null;
}

function mustInclude(needle, output) {
  assert.ok(output.includes(needle), `Expected output to include: ${needle}`);
}

(function main() {
  const workspace = "/Users/jay/.openclaw/workspace";
  const memoryDir = path.join(workspace, "memory");
  const script = path.join(workspace, "client/memory/tools/rebuild_exclusive.js");

  const out = run(`cd ${workspace} && node ${script} 2>&1`, { MEMORY_DIR: memoryDir });
  console.log(out);

  mustInclude("MEMORY_INDEX.md rebuilt", out);
  mustInclude("TAGS_INDEX.md rebuilt", out);
  mustInclude("DECISIONS_INDEX.md rebuilt", out);

  const formatViolations = extractCount("FORMAT VIOLATIONS", out);
  const bloatViolations = extractCount("BLOAT VIOLATIONS", out);
  const registryWarnings = extractCount("REGISTRY WARNINGS", out);

  assert.notStrictEqual(formatViolations, null, "Missing FORMAT VIOLATIONS block");
  assert.notStrictEqual(bloatViolations, null, "Missing BLOAT VIOLATIONS block");
  assert.notStrictEqual(registryWarnings, null, "Missing REGISTRY WARNINGS block");

  assert.strictEqual(formatViolations, 0, `FORMAT_VIOLATIONS must be 0 (got ${formatViolations})`);
  assert.strictEqual(bloatViolations, 0, `BLOAT_VIOLATIONS must be 0 (got ${bloatViolations})`);
  assert.strictEqual(registryWarnings, 0, `REGISTRY_WARNINGS must be 0 (got ${registryWarnings})`);

  // Check for oversized decisions (warn if any, fail if >3)
  const oversizedMatch = out.match(/Oversized warnings:\s*(\d+)/);
  const oversizedCount = oversizedMatch ? parseInt(oversizedMatch[1], 10) : 0;
  if (oversizedCount > 0) {
    console.log(` ⚠️ Warning: ${oversizedCount} oversized decision entries (>120 tokens)`);
  }
  assert.ok(oversizedCount <= 3, `Too many oversized decisions: ${oversizedCount} (max 3 allowed)`);

  console.log(" ✅ Enforcement smoke test PASS (format/bloat/registry/decisions clean)");
})();
