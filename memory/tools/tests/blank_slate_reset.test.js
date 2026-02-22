#!/usr/bin/env node
'use strict';

/**
 * blank_slate_reset.test.js
 * Contract tests for systems/ops/blank_slate_reset.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'blank_slate_reset.js');
const TEMP = path.join(ROOT, 'memory', 'tools', 'tests', 'temp_blank_slate_reset');
const DEST = path.join(TEMP, 'backups');

function clean() {
  if (fs.existsSync(TEMP)) fs.rmSync(TEMP, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, body) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, body, 'utf8');
}

function setupWorkspace() {
  clean();

  const policy = {
    version: '1.0',
    default_profile: 'test_blank_slate',
    profiles: {
      test_blank_slate: {
        includes: [
          'adaptive/sensory/eyes/catalog.json',
          'state/adaptive/strategy/*.json',
          'MEMORY.md',
          'memory/*.md',
          'memory/_archive'
        ],
        exclude_exact: ['memory/README.md'],
        exclude_prefixes: ['memory/tools'],
        exclude_suffixes: ['.jsonl']
      }
    }
  };

  writeFile(path.join(TEMP, 'config', 'blank_slate_reset_policy.json'), JSON.stringify(policy, null, 2));

  writeFile(path.join(TEMP, 'adaptive', 'sensory', 'eyes', 'catalog.json'), '{"ok":true}\n');
  writeFile(path.join(TEMP, 'state', 'adaptive', 'strategy', 'outcome_fitness.json'), '{"score":1}\n');
  writeFile(path.join(TEMP, 'state', 'adaptive', 'strategy', 'receipts.jsonl'), '{"keep":"log"}\n');
  writeFile(path.join(TEMP, 'MEMORY.md'), '# memory\n');
  writeFile(path.join(TEMP, 'memory', '2026-02-21.md'), '# day\n');
  writeFile(path.join(TEMP, 'memory', 'README.md'), '# keep\n');
  writeFile(path.join(TEMP, 'memory', 'tools', 'keep.js'), 'module.exports = true;\n');
  writeFile(path.join(TEMP, 'memory', '_archive', 'old.md'), '# old\n');
}

function run(args) {
  const env = {
    ...process.env,
    BLANK_SLATE_ROOT: TEMP,
    BLANK_SLATE_POLICY: path.join(TEMP, 'config', 'blank_slate_reset_policy.json')
  };
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env });
  const stdout = String(r.stdout || '').trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  return { code: r.status ?? 1, payload, stdout, stderr: String(r.stderr || '') };
}

let failed = false;

function test(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err.message}`);
  }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   BLANK SLATE RESET TESTS');
console.log('═══════════════════════════════════════════════════════════');

test('run defaults to dry-run and preserves source paths', () => {
  setupWorkspace();
  const r = run(['run', '--profile=test_blank_slate', `--dest=${DEST}`]);
  assert.strictEqual(r.code, 0, `exit should be 0; stderr=${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'payload.ok should be true');
  assert.strictEqual(r.payload.dry_run, true, 'run should default to dry-run');

  assert.ok(fs.existsSync(path.join(TEMP, 'adaptive', 'sensory', 'eyes', 'catalog.json')), 'adaptive catalog should remain');
  assert.ok(fs.existsSync(path.join(TEMP, 'MEMORY.md')), 'MEMORY.md should remain');
  assert.ok(fs.existsSync(path.join(TEMP, 'memory', '2026-02-21.md')), 'daily memory should remain');
  assert.strictEqual(fs.existsSync(DEST), false, 'dry-run should not create backup destination');
});

test('apply requires explicit confirmation token', () => {
  setupWorkspace();
  const r = run(['run', '--profile=test_blank_slate', `--dest=${DEST}`, '--apply']);
  assert.notStrictEqual(r.code, 0, 'missing confirm should fail');
  assert.ok(/confirm=RESET/.test(r.stderr), 'stderr should mention confirm token');
});

test('apply archives target set and rollback restores it', () => {
  setupWorkspace();

  const apply = run(['run', '--profile=test_blank_slate', `--dest=${DEST}`, '--apply', '--confirm=RESET']);
  assert.strictEqual(apply.code, 0, `apply exit should be 0; stderr=${apply.stderr}`);
  assert.ok(apply.payload && apply.payload.ok === true, 'apply payload.ok should be true');
  assert.strictEqual(apply.payload.dry_run, false, 'apply should not be dry-run');
  assert.ok(apply.payload.id, 'apply should return snapshot id');

  assert.strictEqual(fs.existsSync(path.join(TEMP, 'adaptive', 'sensory', 'eyes', 'catalog.json')), false, 'adaptive catalog should be archived');
  assert.strictEqual(fs.existsSync(path.join(TEMP, 'MEMORY.md')), false, 'MEMORY.md should be archived');
  assert.strictEqual(fs.existsSync(path.join(TEMP, 'memory', '2026-02-21.md')), false, 'daily memory should be archived');
  assert.ok(fs.existsSync(path.join(TEMP, 'state', 'adaptive', 'strategy', 'receipts.jsonl')), 'jsonl log should remain in place');
  assert.ok(fs.existsSync(path.join(TEMP, 'memory', 'README.md')), 'excluded memory README should remain');
  assert.ok(fs.existsSync(path.join(TEMP, 'memory', 'tools', 'keep.js')), 'excluded tools tree should remain');

  const rollback = run([
    'rollback',
    '--profile=test_blank_slate',
    `--dest=${DEST}`,
    `--id=${apply.payload.id}`
  ]);
  assert.strictEqual(rollback.code, 0, `rollback exit should be 0; stderr=${rollback.stderr}`);
  assert.ok(rollback.payload && rollback.payload.ok === true, 'rollback payload.ok should be true');

  assert.ok(fs.existsSync(path.join(TEMP, 'adaptive', 'sensory', 'eyes', 'catalog.json')), 'adaptive catalog should be restored');
  assert.ok(fs.existsSync(path.join(TEMP, 'MEMORY.md')), 'MEMORY.md should be restored');
  assert.ok(fs.existsSync(path.join(TEMP, 'memory', '2026-02-21.md')), 'daily memory should be restored');
  assert.ok(fs.existsSync(path.join(TEMP, 'memory', '_archive', 'old.md')), 'archived memory subtree should be restored');
});

clean();

if (failed) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   ❌ BLANK SLATE RESET TESTS FAILED');
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   ✅ BLANK SLATE RESET TESTS PASS');
console.log('═══════════════════════════════════════════════════════════');
