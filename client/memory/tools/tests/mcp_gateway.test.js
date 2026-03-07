#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GATEWAY = path.join(ROOT, 'skills', 'mcp', 'mcp_gateway.js');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sig(id, source) {
  return crypto.createHash('sha256').update(`${id}|${source}`, 'utf8').digest('hex').slice(0, 16);
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(script, args, env = {}) {
  const proc = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gateway-'));
  const policyPath = path.join(tmp, 'config', 'mcp_gateway_policy.json');
  const registryPath = path.join(tmp, 'skills', 'mcp', 'registry.json');
  const skills = [
    { id: 'calendar_sync', title: 'Calendar Sync', source: 'mcp://calendar' },
    { id: 'issue_triage', title: 'Issue Triage', source: 'mcp://issues' }
  ].map((row) => ({ ...row, trust_tier: 'verified', signature: sig(row.id, row.source) }));
  writeJson(registryPath, { skills });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'skills.mcp_gateway' },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'skills', 'mcp'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'skills', 'mcp', 'index.json'),
      events_path: path.join(tmp, 'state', 'skills', 'mcp_gateway', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'skills', 'mcp_gateway', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'skills', 'mcp_gateway', 'receipts.jsonl'),
      registry_path: registryPath,
      installs_path: path.join(tmp, 'state', 'skills', 'mcp_gateway', 'installs.json')
    }
  });

  let out = run(GATEWAY, ['discover', '--query=calendar', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mcp_discover');

  out = run(GATEWAY, ['install', '--owner=jay', '--id=calendar_sync', '--risk-tier=2', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mcp_install');

  out = run(PROTHEUSCTL, ['skills', 'discover', '--mcp', '--query=issue'], {
    MCP_GATEWAY_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mcp_discover');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('mcp_gateway.test.js: OK');
} catch (err) {
  console.error(`mcp_gateway.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
