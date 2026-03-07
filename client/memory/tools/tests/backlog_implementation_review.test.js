#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'backlog_implementation_review.js');

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: Number.isFinite(proc.status) ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-review-'));
  writeText(path.join(tmp, 'AGENTS.md'), '# test workspace\n');
  writeText(path.join(tmp, 'package.json'), '{}\n');

  const registryPath = path.join(tmp, 'client', 'config', 'backlog_registry.json');
  writeJson(registryPath, {
    schema_id: 'backlog_registry_v1',
    schema_version: '1.0',
    rows: [
      {
        id: 'V3-RACE-900',
        class: 'backlog',
        wave: 'V3',
        status: 'done',
        title: 'substantive impl',
        problem: 'x',
        acceptance: '`client/systems/foo.js` + `client/config/foo.json` + `client/memory/tools/tests/foo.test.js`',
        dependencies: []
      },
      {
        id: 'V3-RACE-901',
        class: 'backlog',
        wave: 'V3',
        status: 'done',
        title: 'wrapper only',
        problem: 'x',
        acceptance: '`client/systems/wrapper_only.js`',
        dependencies: []
      },
      {
        id: 'V2-012',
        class: 'backlog',
        wave: 'V2',
        status: 'blocked',
        title: 'external',
        problem: 'x',
        acceptance: 'external only',
        dependencies: []
      }
    ]
  });

  writeText(path.join(tmp, 'client', 'systems', 'foo.js'), [
    '#!/usr/bin/env node',
    "'use strict';",
    '',
    "require('../../lib/ts_bootstrap').bootstrap(__filename, module);",
    ''
  ].join('\n'));
  writeText(path.join(tmp, 'client', 'systems', 'foo.ts'), [
    '#!/usr/bin/env node',
    "'use strict';",
    'export {};',
    '/** V3-RACE-900 */',
    'const items = [];',
    'for (let i = 0; i < 40; i += 1) {',
    '  items.push(i);',
    '}',
    'console.log(items.length);',
    ''
  ].join('\n'));
  writeJson(path.join(tmp, 'client', 'config', 'foo.json'), { ok: true, id: 'V3-RACE-900' });
  writeText(path.join(tmp, 'client', 'memory', 'tools', 'tests', 'foo.test.js'), 'console.log("V3-RACE-900");\n');

  writeText(path.join(tmp, 'client', 'systems', 'wrapper_only.js'), [
    '#!/usr/bin/env node',
    "'use strict';",
    '',
    "require('../../lib/ts_bootstrap').bootstrap(__filename, module);",
    ''
  ].join('\n'));

  const policyPath = path.join(tmp, 'client', 'config', 'policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: false,
    source_registry_path: registryPath,
    outputs: {
      review_registry_path: path.join(tmp, 'client', 'config', 'backlog_review_registry.json'),
      reviewed_view_path: path.join(tmp, 'client', 'docs', 'backlog_views', 'reviewed.md'),
      latest_path: path.join(tmp, 'state', 'ops', 'backlog_implementation_review', 'latest.json'),
      history_path: path.join(tmp, 'state', 'ops', 'backlog_implementation_review', 'history.jsonl')
    },
    review: {
      done_statuses: ['done'],
      blocked_statuses: ['blocked'],
      wrapper_max_bytes: 300,
      min_substantive_lines: 5,
      max_scan_bytes: 1048576
    },
    search: {
      roots: ['client/systems', 'client/config', 'client/docs', 'client/memory/tools/tests'],
      exclude_paths: ['client/config/backlog_registry.json', 'client/docs/backlog_views/reviewed.md']
    }
  });

  let out = run(['run', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload, 'expected run payload');
  assert.strictEqual(out.payload.fail_count, 1, 'expected wrapper-only fail');
  assert.strictEqual(out.payload.blocked_count, 1, 'expected blocked count');

  out = run(['run', `--policy=${policyPath}`, '--strict=1'], { OPENCLAW_WORKSPACE: tmp });
  assert.notStrictEqual(out.status, 0, 'strict should fail with nonzero fail_count');
  assert.ok(out.payload && out.payload.fail_count === 1, 'strict payload should keep fail count');

  out = run(['status', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.registry_summary, 'status should return registry summary');
  assert.strictEqual(out.payload.registry_summary.row_count, 3);
  assert.strictEqual(out.payload.registry_summary.fail_count, 1);

  const reviewedPath = path.join(tmp, 'client', 'docs', 'backlog_views', 'reviewed.md');
  assert.ok(fs.existsSync(reviewedPath), 'reviewed view should be written');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('backlog_implementation_review.test.js: OK');
} catch (err) {
  console.error(`backlog_implementation_review.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
