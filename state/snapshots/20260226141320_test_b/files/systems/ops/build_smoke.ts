#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const REQUIRED_DIST_FILES = [
  'dist/lib/directive_resolver.js',
  'dist/systems/autonomy/autonomy_controller.js',
  'dist/systems/memory/idle_dream_cycle.js',
  'dist/systems/routing/model_router.js',
  'dist/systems/security/directive_gate.js'
];

function main() {
  for (const rel of REQUIRED_DIST_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`missing_dist_file:${rel}`);
    }
    const check = spawnSync(process.execPath, ['--check', abs], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    if (check.status !== 0) {
      const detail = String(check.stderr || check.stdout || '').trim();
      throw new Error(`syntax_check_failed:${rel}:${detail}`);
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'build_smoke',
    checked: REQUIRED_DIST_FILES.length,
    mode: 'emit_and_syntax'
  }) + '\n');
}

try {
  if (require.main === module) {
    main();
  }
} catch (err) {
  process.stderr.write(`build_smoke.js: FAIL: ${err.message}\n`);
  process.exit(1);
}
