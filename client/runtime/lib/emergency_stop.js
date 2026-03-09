'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const STOP_PATH = path.join(REPO_ROOT, 'state', 'security', 'emergency_stop.json');
const VALID_SCOPES = new Set(['all', 'autonomy', 'routing', 'actuation', 'spine']);

function nowIso() {
  return new Date().toISOString();
}

function asString(v) {
  return String(v == null ? '' : v).trim();
}

function normalizeScopes(raw) {
  const src = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of src) {
    for (const seg of String(item == null ? '' : item).split(',')) {
      const s = asString(seg).toLowerCase();
      if (!s) continue;
      if (!VALID_SCOPES.has(s)) continue;
      if (!out.includes(s)) out.push(s);
    }
  }
  if (!out.length) out.push('all');
  if (out.includes('all')) return ['all'];
  return out.sort((a, b) => a.localeCompare(b));
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function getStopState() {
  const raw = readJsonSafe(STOP_PATH, null);
  if (!raw || typeof raw !== 'object') {
    return {
      engaged: false,
      scopes: [],
      updated_at: null,
      reason: null,
      actor: null
    };
  }
  const engaged = raw.engaged === true;
  const scopes = engaged ? normalizeScopes(raw.scopes || raw.scope || []) : [];
  return {
    engaged,
    scopes,
    updated_at: asString(raw.updated_at || ''),
    reason: asString(raw.reason || ''),
    actor: asString(raw.actor || ''),
    approval_note: asString(raw.approval_note || '')
  };
}

function isEmergencyStopEngaged(scope) {
  const st = getStopState();
  if (!st.engaged) return { engaged: false, scope, state: st };
  const wanted = asString(scope).toLowerCase() || 'all';
  const hit = st.scopes.includes('all') || st.scopes.includes(wanted);
  return { engaged: hit, scope: wanted, state: st };
}

function engageEmergencyStop({ scopes, approval_note, actor, reason }) {
  const note = asString(approval_note).slice(0, 240);
  const why = asString(reason).slice(0, 240);
  const who = asString(actor || process.env.USER || 'unknown').slice(0, 120);
  const next = {
    engaged: true,
    scopes: normalizeScopes(scopes),
    updated_at: nowIso(),
    actor: who,
    reason: why || 'manual_emergency_stop',
    approval_note: note
  };
  writeJsonAtomic(STOP_PATH, next);
  return next;
}

function releaseEmergencyStop({ approval_note, actor, reason }) {
  const note = asString(approval_note).slice(0, 240);
  const why = asString(reason).slice(0, 240);
  const who = asString(actor || process.env.USER || 'unknown').slice(0, 120);
  const next = {
    engaged: false,
    scopes: [],
    updated_at: nowIso(),
    actor: who,
    reason: why || 'manual_release',
    approval_note: note
  };
  writeJsonAtomic(STOP_PATH, next);
  return next;
}

module.exports = {
  STOP_PATH,
  VALID_SCOPES,
  normalizeScopes,
  getStopState,
  isEmergencyStopEngaged,
  engageEmergencyStop,
  releaseEmergencyStop
};
