#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.SCRIPT_SURFACE_REDUCTION_WAVE2_POLICY_PATH
  ? path.resolve(process.env.SCRIPT_SURFACE_REDUCTION_WAVE2_POLICY_PATH)
  : path.join(ROOT, 'config', 'script_surface_reduction_wave2_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/script_surface_reduction_wave2.js plan [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/script_surface_reduction_wave2.js apply [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/script_surface_reduction_wave2.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    remove_rules: {
      suffixes: [':status']
    },
    keep: {
      explicit: ['dev', 'build', 'start', 'test', 'lint', 'security:audit'],
      keep_referenced: true,
      keep_curated_operator_surface: true
    },
    paths: {
      package_json_path: 'package.json',
      command_registry_policy_path: 'config/command_registry_policy.json',
      latest_path: 'state/ops/script_surface_reduction_wave2/latest.json',
      receipts_path: 'state/ops/script_surface_reduction_wave2/receipts.jsonl',
      command_map_diff_path: 'state/ops/script_surface_reduction_wave2/command_map_diff.json',
      migration_doc_path: 'docs/ops/SCRIPT_SURFACE_REDUCTION_WAVE2.md'
    }
  };
}

function normalizeStringList(raw: unknown, max = 160, fallback: string[] = []) {
  if (!Array.isArray(raw)) return fallback.slice();
  return raw.map((row) => cleanText(row, max)).filter(Boolean);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const removeRules = raw.remove_rules && typeof raw.remove_rules === 'object' ? raw.remove_rules : {};
  const keep = raw.keep && typeof raw.keep === 'object' ? raw.keep : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    remove_rules: {
      suffixes: normalizeStringList(removeRules.suffixes, 64, base.remove_rules.suffixes)
    },
    keep: {
      explicit: normalizeStringList(keep.explicit, 120, base.keep.explicit),
      keep_referenced: toBool(keep.keep_referenced, base.keep.keep_referenced),
      keep_curated_operator_surface: toBool(keep.keep_curated_operator_surface, base.keep.keep_curated_operator_surface)
    },
    paths: {
      package_json_path: resolvePath(paths.package_json_path, base.paths.package_json_path),
      command_registry_policy_path: resolvePath(paths.command_registry_policy_path, base.paths.command_registry_policy_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      command_map_diff_path: resolvePath(paths.command_map_diff_path, base.paths.command_map_diff_path),
      migration_doc_path: resolvePath(paths.migration_doc_path, base.paths.migration_doc_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function relPath(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function collectReferencedScripts() {
  const out = new Set<string>();
  const stack = [ROOT];
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'state', 'tmp', 'logs', 'build']);
  const re = /npm run(?: -s)? ([A-Za-z0-9:_.-]+)/g;

  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry || !entry.name) continue;
      if (skipDirs.has(entry.name)) continue;
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let src = '';
      try {
        if (fs.statSync(abs).size > 2 * 1024 * 1024) continue;
        src = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      let m = re.exec(src);
      while (m) {
        const name = cleanText(m[1], 160);
        if (name) out.add(name);
        m = re.exec(src);
      }
      re.lastIndex = 0;
    }
  }
  return Array.from(out).sort();
}

function loadCuratedSurface(policy) {
  const row = readJson(policy.paths.command_registry_policy_path, {});
  return Array.isArray(row && row.curated_operator_surface)
    ? row.curated_operator_surface.map((v) => cleanText(v, 120)).filter(Boolean)
    : [];
}

function replacementForStatus(scriptName: string, scripts: Record<string, string>) {
  if (!scriptName.endsWith(':status')) return null;
  const runCandidate = scriptName.slice(0, -':status'.length);
  if (Object.prototype.hasOwnProperty.call(scripts, runCandidate)) return runCandidate;
  const runVariant = `${runCandidate}:run`;
  if (Object.prototype.hasOwnProperty.call(scripts, runVariant)) return runVariant;
  return null;
}

function buildMigrationDoc(out: any, docPath: string) {
  const lines: string[] = [];
  lines.push('# Script Surface Reduction Wave II');
  lines.push('');
  lines.push(`Generated: ${out.ts}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Mode: \`${out.mode}\``);
  lines.push(`- Scripts before: ${out.counts.before}`);
  lines.push(`- Removed: ${out.counts.removed}`);
  lines.push(`- Scripts after: ${out.counts.after}`);
  lines.push(`- Referenced scripts preserved: ${out.counts.referenced}`);
  lines.push(`- Curated operator scripts preserved: ${out.counts.curated}`);
  lines.push('');
  lines.push('## Compatibility Strategy');
  lines.push('- Critical paths are preserved by keep rules (referenced + curated + explicit).');
  lines.push('- Removed commands are low-value status aliases not referenced by repo/CI/docs.');
  lines.push('- Replacement hints are included below when a direct run equivalent exists.');
  lines.push('');
  lines.push('## Command Map Diff');
  lines.push('| Removed Script | Replacement Hint | Reason |');
  lines.push('|---|---|---|');
  for (const row of out.removed.slice(0, 500)) {
    lines.push(`| \`${row.name}\` | ${row.replacement ? `\`${row.replacement}\`` : 'n/a'} | ${row.reason} |`);
  }
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, `${lines.join('\n')}\n`, 'utf8');
}

function runReduction(policy: any, mode: 'plan' | 'apply', strict: boolean) {
  const pkg = readJson(policy.paths.package_json_path, {});
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const scriptNames = Object.keys(scripts);

  const referenced = policy.keep.keep_referenced ? collectReferencedScripts() : [];
  const curated = policy.keep.keep_curated_operator_surface ? loadCuratedSurface(policy) : [];
  const keep = new Set<string>([
    ...policy.keep.explicit,
    ...referenced,
    ...curated
  ]);

  const suffixes = Array.isArray(policy.remove_rules && policy.remove_rules.suffixes)
    ? policy.remove_rules.suffixes
    : [];

  const removed = [];
  for (const name of scriptNames) {
    const keepReason = keep.has(name);
    if (keepReason) continue;
    const matchedSuffix = suffixes.find((suffix: string) => name.endsWith(String(suffix)));
    if (!matchedSuffix) continue;
    removed.push({
      name,
      reason: `suffix_match:${matchedSuffix}`,
      replacement: replacementForStatus(name, scripts)
    });
  }

  const removedNames = new Set(removed.map((row) => row.name));
  const nextScripts: Record<string, string> = {};
  for (const [name, cmd] of Object.entries(scripts)) {
    if (removedNames.has(name)) continue;
    nextScripts[name] = String(cmd);
  }

  if (mode === 'apply' && removed.length > 0) {
    const nextPkg = {
      ...pkg,
      scripts: nextScripts
    };
    writeJsonAtomic(policy.paths.package_json_path, nextPkg);
  }

  const out = {
    ok: true,
    pass: true,
    strict,
    type: 'script_surface_reduction_wave2',
    lane_id: 'V3-RACE-128',
    mode,
    ts: nowIso(),
    counts: {
      before: scriptNames.length,
      removed: removed.length,
      after: scriptNames.length - removed.length,
      referenced: referenced.length,
      curated: curated.length,
      explicit_keep: policy.keep.explicit.length
    },
    keep_rules: {
      explicit: policy.keep.explicit,
      keep_referenced: policy.keep.keep_referenced === true,
      keep_curated_operator_surface: policy.keep.keep_curated_operator_surface === true
    },
    removed,
    artifacts: {
      policy_path: relPath(policy.policy_path),
      package_json_path: relPath(policy.paths.package_json_path),
      command_map_diff_path: relPath(policy.paths.command_map_diff_path),
      migration_doc_path: relPath(policy.paths.migration_doc_path)
    }
  };

  const commandMapDiff = {
    schema_id: 'script_surface_reduction_wave2_diff',
    schema_version: '1.0',
    generated_at: out.ts,
    mode,
    before_count: out.counts.before,
    after_count: out.counts.after,
    removed
  };

  writeJsonAtomic(policy.paths.command_map_diff_path, commandMapDiff);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  buildMigrationDoc(out, policy.paths.migration_doc_path);
  return out;
}

function cmdStatus(policy) {
  const out = readJson(policy.paths.latest_path, {
    ok: true,
    type: 'script_surface_reduction_wave2',
    status: 'no_status'
  });
  return emit(out, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'plan').toLowerCase();
  if (args.help || cmd === 'help' || cmd === '--help') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return emit({ ok: false, type: 'script_surface_reduction_wave2', error: 'lane_disabled' }, 2);
  }

  if (cmd === 'status') return cmdStatus(policy);
  if (cmd !== 'plan' && cmd !== 'apply') {
    usage();
    return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
  }

  const strict = toBool(args.strict, policy.strict_default);
  const out = runReduction(policy, cmd, strict);
  const pass = out.pass === true;
  return emit(out, pass || !strict ? 0 : 1);
}

main();
