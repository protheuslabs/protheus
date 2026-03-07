#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function parseJson(stdout) {
  try { return JSON.parse(String(stdout || '').trim()); } catch { return null; }
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'memory', 'creative_links.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-links-'));
  const dreamsDir = path.join(tmpRoot, 'state', 'memory', 'dreams');
  const routingDir = path.join(tmpRoot, 'state', 'routing');
  const routingDecisionsPath = path.join(routingDir, 'routing_decisions.jsonl');
  const memoryDir = path.join(tmpRoot, 'memory');
  const registryPath = path.join(tmpRoot, 'state', 'memory', 'creative_links', 'registry.json');
  const ledgerPath = path.join(tmpRoot, 'state', 'memory', 'creative_links', 'runs.jsonl');

  mkDir(dreamsDir);
  mkDir(routingDir);
  mkDir(memoryDir);

  writeJson(path.join(dreamsDir, '2026-02-20.json'), {
    ts: '2026-02-20T10:00:00.000Z',
    date: '2026-02-20',
    themes: [
      {
        token: 'memory-graph',
        score: 19,
        rows: [
          { memory_file: 'client/memory/2026-02-19.md', node_id: 'graph-bridge-policy' },
          { memory_file: 'client/memory/2026-02-19.md', node_id: 'node-format-policy' }
        ],
        older_refs: [
          { file: 'client/memory/2026-02-13.md', node_id: 'graph-bridge-policy', summary: 'Bridge policy' }
        ]
      }
    ]
  });

  writeJson(path.join(dreamsDir, '2026-02-21.json'), {
    ts: '2026-02-21T10:00:00.000Z',
    date: '2026-02-21',
    themes: [
      {
        token: 'memory-graph',
        score: 17,
        rows: [
          { memory_file: 'client/memory/2026-02-20.md', node_id: 'uid-connections' },
          { memory_file: 'client/memory/2026-02-20.md', node_id: 'memory-dream' }
        ],
        older_refs: [
          { file: 'client/memory/2026-02-13.md', node_id: 'retrieval-rails', summary: 'Retrieval rails' }
        ]
      }
    ]
  });

  fs.writeFileSync(
    routingDecisionsPath,
    [
      JSON.stringify({
        ts: '2026-02-21T12:10:00.000Z',
        type: 'route',
        mode: 'hyper-creative',
        tier: 2,
        model_changed: true,
        intent: 'memory graph bridge experiments',
        task: 'explore distant-node synthesis for adaptable strategy memory'
      })
    ].join('\n') + '\n',
    'utf8'
  );

  const env = {
    ...process.env,
    CREATIVE_LINKS_DREAMS_DIR: dreamsDir,
    CREATIVE_LINKS_ROUTING_DECISIONS_PATH: routingDecisionsPath,
    CREATIVE_LINKS_REGISTRY_PATH: registryPath,
    CREATIVE_LINKS_LEDGER_PATH: ledgerPath,
    CREATIVE_LINKS_MEMORY_DIR: memoryDir
  };

  let r = spawnSync('node', [script, 'run', '2026-02-21', '--days=2', '--top=8', '--max-promotions=2'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(Number(out.promoted_count || 0), 1, 'should promote one creative link');
  assert.strictEqual(Array.isArray(out.promotions), true);
  assert.strictEqual(out.promotions.length, 1);
  assert.ok(out.cross_domain_mapper && typeof out.cross_domain_mapper === 'object', 'cross-domain mapper summary should be present');
  assert.strictEqual(Boolean(out.cross_domain_mapper.enabled), true, 'cross-domain mapper should be enabled by default');

  const memoryFile = path.join(memoryDir, '2026-02-21.md');
  assert.ok(fs.existsSync(memoryFile), 'memory node file should be created');
  const memoryText = fs.readFileSync(memoryFile, 'utf8');
  assert.ok(/node_id:\s*creative-link-memory-graph-[a-z0-9-]+/i.test(memoryText), 'creative node_id should exist');
  assert.ok(/uid:\s*[A-Za-z0-9]+/.test(memoryText), 'creative memory node should have alnum uid');

  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const candidate = reg.candidates && reg.candidates['memory-graph'];
  assert.ok(candidate, 'candidate should exist in registry');
  assert.strictEqual(candidate.status, 'promoted', 'candidate should be promoted');
  assert.ok(/^[A-Za-z0-9]+$/.test(String(candidate.uid || '')), 'candidate uid must be alnum');
  assert.ok(/^[A-Za-z0-9]+$/.test(String(candidate.promoted_uid || '')), 'promoted uid must be alnum');

  const hyperCandidate = reg.candidates && reg.candidates['memory-graph-bridge-experiments'];
  assert.ok(hyperCandidate, 'hyper-creative candidate should be captured');
  assert.ok(
    Array.isArray(hyperCandidate.source_types) && hyperCandidate.source_types.includes('hyper_creative_mode'),
    'hyper-creative candidate should record source type'
  );
  const crossDomainCandidate = reg.candidates && reg.candidates['memory-graph'];
  assert.ok(crossDomainCandidate, 'cross-domain token should remain represented in registry');
  assert.ok(
    Array.isArray(crossDomainCandidate.source_types) && crossDomainCandidate.source_types.includes('cross_domain_mapper'),
    'cross-domain mapper should contribute source evidence for shared tokens'
  );

  r = spawnSync('node', [script, 'run', '2026-02-21', '--days=2', '--top=8', '--max-promotions=2'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(r.status, 0, `second run should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'second run expected ok=true');
  assert.strictEqual(Number(out.promoted_count || 0), 0, 'second run should be idempotent');

  r = spawnSync('node', [script, 'status', '2026-02-21'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'status expected ok=true');
  assert.strictEqual(Number(out.promoted || 0), 1);

  console.log('creative_links.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`creative_links.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
