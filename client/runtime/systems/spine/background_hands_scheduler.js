#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/spine::background_hands_scheduler (authoritative)
const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');
const fs = require('fs');
const path = require('path');

process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '1200';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '1500';

const bridge = createOpsLaneBridge(__dirname, 'background_hands_scheduler', 'spine');
const COMMAND = 'background-hands-scheduler';

function parseArgs(args = []) {
  const positional = [];
  const flags = {};
  for (const token of args) {
    const text = String(token || '').trim();
    if (!text.startsWith('--')) {
      positional.push(text);
      continue;
    }
    const idx = text.indexOf('=');
    if (idx >= 0) {
      flags[text.slice(2, idx)] = text.slice(idx + 1);
    } else {
      flags[text.slice(2)] = 'true';
    }
  }
  return { positional, flags };
}

function resolvePath(root, raw, fallbackRel) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return path.join(root, fallbackRel);
  return path.isAbsolute(s) ? s : path.join(root, s);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function localFallback(args = []) {
  const root = path.resolve(__dirname, '..', '..');
  const parsed = parseArgs(args);
  const cmd = String(parsed.positional[0] || 'status').toLowerCase();
  const policyPath = path.resolve(parsed.flags.policy || path.join(root, 'config', 'background_hands_scheduler_policy.json'));
  const policy = readJson(policyPath, {});
  const paths = policy.paths || {};
  const latestPath = resolvePath(root, paths.latest_path, 'state/spine/background_hands/latest.json');
  const eventsPath = resolvePath(root, paths.events_path, 'state/spine/background_hands/events.jsonl');
  const receiptsPath = resolvePath(root, paths.receipts_path, 'state/spine/background_hands/receipts.jsonl');

  if (cmd === 'status') {
    return {
      status: 0,
      payload: {
        ok: true,
        type: 'background_hands_scheduler_status',
        authority: 'client_fallback',
        latest: readJson(latestPath, null)
      }
    };
  }

  const owner = String(parsed.flags.owner || parsed.flags.owner_id || '').trim();
  if (!owner) {
    return {
      status: 1,
      payload: {
        ok: false,
        type: 'background_hands_scheduler_error',
        error: 'missing_owner'
      }
    };
  }

  const event = cmd === 'configure' ? 'background_hand_configure' : 'background_hand_schedule';
  const payload = {
    ok: true,
    type: 'background_hands_scheduler_receipt',
    authority: 'client_fallback',
    event,
    owner_id: owner,
    task: String(parsed.flags.task || 'queue_gc'),
    cadence: String(parsed.flags.cadence || 'hourly'),
    ts: new Date().toISOString()
  };
  appendJsonl(eventsPath, payload);
  appendJsonl(receiptsPath, payload);
  writeJson(latestPath, payload);
  return { status: 0, payload };
}

function runCore(args = []) {
  const out = bridge.run([COMMAND, ...(Array.isArray(args) ? args : [])]);
  if (out && out.status === 0) {
    if (out && out.stdout) process.stdout.write(out.stdout);
    if (out && out.stderr) process.stderr.write(out.stderr);
    if (out && out.payload && !out.stdout) process.stdout.write(`${JSON.stringify(out.payload)}\n`);
    return out;
  }
  const fb = localFallback(args);
  if (fb && fb.payload) process.stdout.write(`${JSON.stringify(fb.payload)}\n`);
  return {
    status: Number.isFinite(fb && fb.status) ? Number(fb.status) : 1,
    payload: fb && fb.payload ? fb.payload : null,
    stdout: '',
    stderr: out && out.stderr ? out.stderr : ''
  };
}

if (require.main === module) {
  const out = runCore(process.argv.slice(2));
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

module.exports = {
  lane: bridge.lane,
  run: (args = []) => bridge.run([COMMAND, ...args])
};
