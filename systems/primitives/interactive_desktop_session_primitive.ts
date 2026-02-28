#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  sha256Hex,
  stableStringify
} = require('../../lib/integrity_hash_utility');
const passportIterationChain = require('../../lib/passport_iteration_chain');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.INTERACTIVE_DESKTOP_SESSION_POLICY_PATH
  ? path.resolve(process.env.INTERACTIVE_DESKTOP_SESSION_POLICY_PATH)
  : path.join(ROOT, 'config', 'interactive_desktop_session_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 280) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 160) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || '', 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    high_risk_action_classes: ['filesystem', 'shell', 'auth', 'network_control', 'payment'],
    require_explicit_approval_for_high_risk: true,
    allowed_opcodes: ['open', 'click', 'type', 'wait', 'assert', 'capture'],
    receipts_path: 'state/primitives/interactive_desktop_session/receipts.jsonl',
    sessions_path: 'state/primitives/interactive_desktop_session/sessions.json',
    latest_path: 'state/primitives/interactive_desktop_session/latest.json'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    shadow_only: toBool(src.shadow_only, base.shadow_only),
    high_risk_action_classes: Array.isArray(src.high_risk_action_classes)
      ? src.high_risk_action_classes.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
      : base.high_risk_action_classes.slice(0),
    require_explicit_approval_for_high_risk: src.require_explicit_approval_for_high_risk !== false,
    allowed_opcodes: Array.isArray(src.allowed_opcodes)
      ? src.allowed_opcodes.map((row: unknown) => normalizeToken(row, 40)).filter(Boolean)
      : base.allowed_opcodes.slice(0),
    receipts_path: resolvePath(src.receipts_path || base.receipts_path, base.receipts_path),
    sessions_path: resolvePath(src.sessions_path || base.sessions_path, base.sessions_path),
    latest_path: resolvePath(src.latest_path || base.latest_path, base.latest_path)
  };
}

function parseActions(args: AnyObj) {
  const raw = cleanText(args['actions-json'] || args.actions_json || '', 2000000);
  if (!raw) {
    return [
      { opcode: 'open', target: 'about:blank' },
      { opcode: 'wait', ms: 200 },
      { opcode: 'assert', condition: 'session_alive' },
      { opcode: 'capture', name: 'default_capture' }
    ];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function runSession(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) {
    return { ok: false, type: 'interactive_desktop_session_run', error: 'interactive_desktop_session_disabled' };
  }

  const sessionId = normalizeToken(args['session-id'] || args.session_id || `session_${Date.now()}`, 140);
  const objectiveId = normalizeToken(args['objective-id'] || args.objective_id || '', 180) || null;
  const riskClass = normalizeToken(args['risk-class'] || args.risk_class || 'low', 80) || 'low';
  const apply = toBool(args.apply, false) && policy.shadow_only !== true;
  const approved = toBool(args.approved, false);
  const actions = parseActions(args);

  if (!sessionId) {
    return { ok: false, type: 'interactive_desktop_session_run', error: 'session_id_required' };
  }
  if (!actions.length) {
    return { ok: false, type: 'interactive_desktop_session_run', error: 'actions_required' };
  }

  const highRisk = policy.high_risk_action_classes.includes(riskClass);
  if (highRisk && policy.require_explicit_approval_for_high_risk === true && approved !== true) {
    return {
      ok: false,
      type: 'interactive_desktop_session_run',
      error: 'high_risk_requires_approval',
      session_id: sessionId,
      risk_class: riskClass
    };
  }

  const sessionDoc = readJson(policy.sessions_path, {
    schema_id: 'interactive_desktop_sessions',
    schema_version: '1.0',
    sessions: {}
  });
  if (!sessionDoc.sessions || typeof sessionDoc.sessions !== 'object') {
    sessionDoc.sessions = {};
  }

  const opcodeSet = new Set(policy.allowed_opcodes || []);
  const executed: AnyObj[] = [];
  let ok = true;

  for (let i = 0; i < actions.length; i += 1) {
    const row = actions[i] && typeof actions[i] === 'object' ? actions[i] : {};
    const opcode = normalizeToken(row.opcode || row.action || '', 40);
    if (!opcodeSet.has(opcode)) {
      ok = false;
      executed.push({
        ok: false,
        index: i,
        opcode,
        error: 'opcode_not_allowed'
      });
      break;
    }
    const replayId = sha256Hex(stableStringify({ session_id: sessionId, index: i, opcode, row }));
    const entry = {
      ok: true,
      index: i,
      opcode,
      replay_id: replayId,
      target: cleanText(row.target || row.selector || row.name || '', 240) || null,
      params: row
    };
    executed.push(entry);

    passportIterationChain.recordIterationStep({
      lane: 'interactive_desktop_session',
      step: opcode,
      iteration: i + 1,
      objective_id: objectiveId,
      target_path: entry.target || sessionId,
      metadata: {
        status: entry.ok ? 'ok' : 'failed',
        replay_id: replayId,
        session_id: sessionId,
        verified: opcode === 'assert' && entry.ok
      }
    });
  }

  const sessionRow = {
    ts: nowIso(),
    session_id: sessionId,
    objective_id: objectiveId,
    apply,
    shadow_only: policy.shadow_only === true,
    risk_class: riskClass,
    high_risk: highRisk,
    approved,
    ok,
    actions_total: actions.length,
    actions_executed: executed.length,
    executed
  };

  appendJsonl(policy.receipts_path, {
    type: 'interactive_desktop_session_run',
    ...sessionRow
  });
  sessionDoc.updated_at = nowIso();
  sessionDoc.sessions[sessionId] = sessionRow;
  writeJsonAtomic(policy.sessions_path, sessionDoc);

  const out = {
    ok,
    type: 'interactive_desktop_session_run',
    ts: nowIso(),
    session_id: sessionId,
    objective_id: objectiveId,
    apply,
    shadow_only: policy.shadow_only === true,
    risk_class: riskClass,
    high_risk: highRisk,
    actions_executed: executed.length,
    receipts_path: relPath(policy.receipts_path),
    sessions_path: relPath(policy.sessions_path),
    first_replay_id: executed.length ? executed[0].replay_id : null
  };
  writeJsonAtomic(policy.latest_path, out);
  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const sessions = readJson(policy.sessions_path, { sessions: {} });
  const sessionRows = sessions && sessions.sessions && typeof sessions.sessions === 'object'
    ? Object.values(sessions.sessions)
    : [];
  const latest = readJson(policy.latest_path, null);
  return {
    ok: true,
    type: 'interactive_desktop_session_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      shadow_only: policy.shadow_only === true,
      require_explicit_approval_for_high_risk: policy.require_explicit_approval_for_high_risk === true
    },
    sessions: {
      total: sessionRows.length,
      successful: sessionRows.filter((row: AnyObj) => row && row.ok === true).length
    },
    latest: latest && typeof latest === 'object'
      ? {
        session_id: latest.session_id || null,
        ts: latest.ts || null,
        ok: latest.ok === true,
        actions_executed: Number(latest.actions_executed || 0)
      }
      : null,
    paths: {
      receipts_path: relPath(policy.receipts_path),
      sessions_path: relPath(policy.sessions_path),
      latest_path: relPath(policy.latest_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/primitives/interactive_desktop_session_primitive.js run --session-id=<id> [--objective-id=<id>] [--risk-class=low] [--actions-json=<json>] [--apply=0|1] [--approved=0|1]');
  console.log('  node systems/primitives/interactive_desktop_session_primitive.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') out = runSession(args);
  else if (cmd === 'status') out = status(args);
  else out = { ok: false, type: 'interactive_desktop_session', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  runSession,
  status
};
