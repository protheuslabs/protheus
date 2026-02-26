#!/usr/bin/env node
'use strict';

/**
 * postmortem_loop.js
 *
 * Blameless incident postmortem workflow with enforceable preventive checks.
 *
 * Usage:
 *   node systems/ops/postmortem_loop.js open --incident-id=INC-001 --summary="..." [--severity=sev1|sev2|sev3|sev4] [--owner=...]
 *   node systems/ops/postmortem_loop.js add-action --incident-id=INC-001 --type=corrective|preventive --description="..." --owner=... [--due=YYYY-MM-DD] [--check-ref=...]
 *   node systems/ops/postmortem_loop.js verify-action --incident-id=INC-001 --action-id=A1 --pass=1|0 [--evidence=...]
 *   node systems/ops/postmortem_loop.js resolve-action --incident-id=INC-001 --action-id=A1 [--resolution=...]
 *   node systems/ops/postmortem_loop.js status --incident-id=INC-001
 *   node systems/ops/postmortem_loop.js close --incident-id=INC-001 [--strict=1|0]
 *   node systems/ops/postmortem_loop.js list [--status=open|closed] [--limit=N]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.POSTMORTEM_POLICY_PATH
  ? path.resolve(process.env.POSTMORTEM_POLICY_PATH)
  : path.join(ROOT, 'config', 'postmortem_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/postmortem_loop.js open --incident-id=INC-001 --summary="..." [--severity=sev1|sev2|sev3|sev4] [--owner=...]');
  console.log('  node systems/ops/postmortem_loop.js add-action --incident-id=INC-001 --type=corrective|preventive --description="..." --owner=... [--due=YYYY-MM-DD] [--check-ref=...]');
  console.log('  node systems/ops/postmortem_loop.js verify-action --incident-id=INC-001 --action-id=A1 --pass=1|0 [--evidence=...]');
  console.log('  node systems/ops/postmortem_loop.js resolve-action --incident-id=INC-001 --action-id=A1 [--resolution=...]');
  console.log('  node systems/ops/postmortem_loop.js status --incident-id=INC-001');
  console.log('  node systems/ops/postmortem_loop.js close --incident-id=INC-001 [--strict=1|0]');
  console.log('  node systems/ops/postmortem_loop.js list [--status=open|closed] [--limit=N]');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toBool(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function normText(v, max = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function incidentSlug(raw) {
  const clean = normText(raw, 120).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return clean || '';
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function loadPolicy() {
  const raw = readJson(POLICY_PATH, {});
  return {
    version: String(raw.version || '1.0'),
    postmortem_dir: normText(raw.postmortem_dir || 'state/ops/postmortems', 240),
    receipts_path: normText(raw.receipts_path || 'state/ops/postmortem_receipts.jsonl', 240),
    default_severity: normText(raw.default_severity || 'sev2', 24).toLowerCase(),
    require_preventive_check_ref: toBool(raw.require_preventive_check_ref, true),
    require_preventive_verification_pass: toBool(raw.require_preventive_verification_pass, true),
    max_open_days_warn: Math.max(1, Number(raw.max_open_days_warn || 14))
  };
}

function policyPaths(policy) {
  const dir = path.resolve(ROOT, policy.postmortem_dir);
  const receipts = path.resolve(ROOT, policy.receipts_path);
  return { dir, receipts };
}

function incidentPaths(policy, incidentId) {
  const paths = policyPaths(policy);
  const id = incidentSlug(incidentId);
  return {
    id,
    jsonPath: path.join(paths.dir, `${id}.json`),
    mdPath: path.join(paths.dir, `${id}.md`),
    receiptsPath: paths.receipts
  };
}

function writeTemplate(mdPath, record) {
  const lines = [
    `# Postmortem ${record.incident_id}`,
    '',
    `- Status: ${record.status}`,
    `- Severity: ${record.severity}`,
    `- Opened: ${record.opened_at}`,
    `- Owner: ${record.owner || 'unassigned'}`,
    '',
    '## Summary',
    record.summary || '',
    '',
    '## Impact',
    '- Scope:',
    '- Duration:',
    '- User/business impact:',
    '',
    '## Root Cause',
    '- Primary:',
    '- Contributing factors:',
    '',
    '## Timeline',
    '- Detection:',
    '- Containment:',
    '- Recovery:',
    '',
    '## Actions',
    '- Corrective:',
    '- Preventive:',
    '',
    '## Verification',
    '- Preventive checks linked and passing before closure.',
    ''
  ];
  ensureDir(path.dirname(mdPath));
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
}

function readIncident(policy, incidentId) {
  const p = incidentPaths(policy, incidentId);
  const rec = readJson(p.jsonPath, null);
  if (!rec) return null;
  return { record: rec, paths: p };
}

function nextActionId(actions) {
  const n = Array.isArray(actions) ? actions.length + 1 : 1;
  return `A${n}`;
}

function evaluateCloseGuard(record, policy) {
  const actions = Array.isArray(record && record.actions) ? record.actions : [];
  const openActions = actions.filter((a) => String(a && a.status || '').toLowerCase() !== 'resolved');
  const preventive = actions.filter((a) => String(a && a.type || '').toLowerCase() === 'preventive');
  const preventiveMissingLink = preventive.filter((a) => !normText(a && a.check_ref, 240));
  const preventiveUnverified = preventive.filter((a) => {
    const ver = a && a.verification && typeof a.verification === 'object' ? a.verification : null;
    return !ver || ver.pass !== true;
  });
  const reasons = [] as string[];
  if (openActions.length > 0) reasons.push('open_actions_remaining');
  if (preventiveMissingLink.length > 0 && policy.require_preventive_check_ref) reasons.push('preventive_check_ref_missing');
  if (preventiveUnverified.length > 0 && policy.require_preventive_verification_pass) reasons.push('preventive_verification_pending');
  return {
    closable: reasons.length === 0,
    open_actions: openActions.length,
    preventive_actions: preventive.length,
    preventive_missing_link: preventiveMissingLink.length,
    preventive_unverified: preventiveUnverified.length,
    reasons
  };
}

function cmdOpen(args) {
  const policy = loadPolicy();
  const incidentId = incidentSlug(args['incident-id'] || args.id);
  const summary = normText(args.summary, 500);
  if (!incidentId) throw new Error('incident_id_required');
  if (!summary) throw new Error('summary_required');
  const sev = normText(args.severity || policy.default_severity, 24).toLowerCase();
  const owner = normText(args.owner || '', 120) || null;
  const paths = incidentPaths(policy, incidentId);
  if (fs.existsSync(paths.jsonPath)) throw new Error(`incident_exists:${incidentId}`);

  const record = {
    schema_version: '1.0',
    type: 'incident_postmortem',
    incident_id: incidentId,
    status: 'open',
    severity: sev,
    opened_at: nowIso(),
    detected_at: normText(args['detected-at'] || '', 40) || null,
    owner,
    summary,
    actions: [],
    closed_at: null
  };
  writeJson(paths.jsonPath, record);
  writeTemplate(paths.mdPath, record);
  const receipt = {
    ok: true,
    type: 'postmortem_opened',
    ts: nowIso(),
    incident_id: incidentId,
    severity: sev,
    summary,
    path: path.relative(ROOT, paths.jsonPath)
  };
  appendJsonl(paths.receiptsPath, receipt);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

function cmdAddAction(args) {
  const policy = loadPolicy();
  const incidentId = incidentSlug(args['incident-id'] || args.id);
  if (!incidentId) throw new Error('incident_id_required');
  const loaded = readIncident(policy, incidentId);
  if (!loaded) throw new Error(`incident_not_found:${incidentId}`);
  const { record, paths } = loaded;
  const type = normText(args.type || '', 40).toLowerCase();
  const description = normText(args.description, 500);
  const owner = normText(args.owner, 120);
  const due = normText(args.due, 32) || null;
  const checkRef = normText(args['check-ref'], 240) || null;
  if (!['corrective', 'preventive'].includes(type)) throw new Error('action_type_invalid');
  if (!description) throw new Error('action_description_required');
  if (!owner) throw new Error('action_owner_required');
  if (type === 'preventive' && policy.require_preventive_check_ref && !checkRef) {
    throw new Error('preventive_check_ref_required');
  }
  const actions = Array.isArray(record.actions) ? record.actions : [];
  const action = {
    action_id: nextActionId(actions),
    type,
    description,
    owner,
    due_date: due,
    status: 'open',
    check_ref: checkRef,
    verification: null,
    resolution: null,
    created_at: nowIso(),
    resolved_at: null
  };
  actions.push(action);
  record.actions = actions;
  writeJson(paths.jsonPath, record);
  const receipt = {
    ok: true,
    type: 'postmortem_action_added',
    ts: nowIso(),
    incident_id: incidentId,
    action_id: action.action_id,
    action_type: type
  };
  appendJsonl(paths.receiptsPath, receipt);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

function cmdVerifyAction(args) {
  const policy = loadPolicy();
  const incidentId = incidentSlug(args['incident-id'] || args.id);
  const actionId = normText(args['action-id'], 32);
  if (!incidentId) throw new Error('incident_id_required');
  if (!actionId) throw new Error('action_id_required');
  const loaded = readIncident(policy, incidentId);
  if (!loaded) throw new Error(`incident_not_found:${incidentId}`);
  const { record, paths } = loaded;
  const actions = Array.isArray(record.actions) ? record.actions : [];
  const idx = actions.findIndex((a) => String(a && a.action_id || '') === actionId);
  if (idx < 0) throw new Error(`action_not_found:${actionId}`);
  const action = actions[idx];
  const pass = toBool(args.pass, null);
  if (pass == null) throw new Error('pass_required');
  const evidence = normText(args.evidence, 320) || null;
  action.verification = {
    pass,
    check_ref: normText(args['check-ref'], 240) || action.check_ref || null,
    evidence,
    verified_at: nowIso()
  };
  actions[idx] = action;
  record.actions = actions;
  writeJson(paths.jsonPath, record);
  const receipt = {
    ok: true,
    type: 'postmortem_action_verified',
    ts: nowIso(),
    incident_id: incidentId,
    action_id: actionId,
    pass
  };
  appendJsonl(paths.receiptsPath, receipt);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

function cmdResolveAction(args) {
  const policy = loadPolicy();
  const incidentId = incidentSlug(args['incident-id'] || args.id);
  const actionId = normText(args['action-id'], 32);
  if (!incidentId) throw new Error('incident_id_required');
  if (!actionId) throw new Error('action_id_required');
  const loaded = readIncident(policy, incidentId);
  if (!loaded) throw new Error(`incident_not_found:${incidentId}`);
  const { record, paths } = loaded;
  const actions = Array.isArray(record.actions) ? record.actions : [];
  const idx = actions.findIndex((a) => String(a && a.action_id || '') === actionId);
  if (idx < 0) throw new Error(`action_not_found:${actionId}`);
  const action = actions[idx];
  if (String(action.type || '') === 'preventive' && policy.require_preventive_verification_pass) {
    const ver = action && action.verification && typeof action.verification === 'object' ? action.verification : null;
    if (!ver || ver.pass !== true) throw new Error('preventive_action_requires_passing_verification');
  }
  action.status = 'resolved';
  action.resolution = normText(args.resolution, 500) || null;
  action.resolved_at = nowIso();
  actions[idx] = action;
  record.actions = actions;
  writeJson(paths.jsonPath, record);
  const receipt = {
    ok: true,
    type: 'postmortem_action_resolved',
    ts: nowIso(),
    incident_id: incidentId,
    action_id: actionId
  };
  appendJsonl(paths.receiptsPath, receipt);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

function cmdStatus(args) {
  const policy = loadPolicy();
  const incidentId = incidentSlug(args['incident-id'] || args.id);
  if (!incidentId) throw new Error('incident_id_required');
  const loaded = readIncident(policy, incidentId);
  if (!loaded) throw new Error(`incident_not_found:${incidentId}`);
  const { record, paths } = loaded;
  const guard = evaluateCloseGuard(record, policy);
  const openedMs = Date.parse(String(record.opened_at || ''));
  const ageDays = Number.isFinite(openedMs)
    ? Number(((Date.now() - openedMs) / 86400000).toFixed(2))
    : null;
  const out = {
    ok: true,
    type: 'postmortem_status',
    ts: nowIso(),
    incident_id: incidentId,
    status: String(record.status || 'open'),
    severity: String(record.severity || 'unknown'),
    path: path.relative(ROOT, paths.jsonPath),
    age_days: ageDays,
    open_days_warn: Number(policy.max_open_days_warn || 14),
    warn_stale_open: String(record.status || 'open') === 'open' && ageDays != null && ageDays > Number(policy.max_open_days_warn || 14),
    close_guard: guard
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdClose(args) {
  const policy = loadPolicy();
  const strict = toBool(args.strict, true);
  const incidentId = incidentSlug(args['incident-id'] || args.id);
  if (!incidentId) throw new Error('incident_id_required');
  const loaded = readIncident(policy, incidentId);
  if (!loaded) throw new Error(`incident_not_found:${incidentId}`);
  const { record, paths } = loaded;
  const guard = evaluateCloseGuard(record, policy);
  const out = {
    ok: guard.closable,
    type: 'postmortem_close',
    ts: nowIso(),
    incident_id: incidentId,
    close_guard: guard
  };
  if (guard.closable) {
    record.status = 'closed';
    record.closed_at = nowIso();
    writeJson(paths.jsonPath, record);
  }
  appendJsonl(paths.receiptsPath, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (strict && out.ok !== true) process.exitCode = 1;
}

function cmdList(args) {
  const policy = loadPolicy();
  const p = policyPaths(policy);
  ensureDir(p.dir);
  const limit = Math.max(1, Math.min(200, Number(args.limit || 20)));
  const statusFilter = normText(args.status, 16).toLowerCase();
  const files = fs.readdirSync(p.dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const outRows = [];
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const row = readJson(path.join(p.dir, files[i]), null);
    if (!row) continue;
    const status = String(row.status || '').toLowerCase();
    if (statusFilter && statusFilter !== status) continue;
    outRows.push({
      incident_id: String(row.incident_id || ''),
      status: String(row.status || ''),
      severity: String(row.severity || ''),
      opened_at: String(row.opened_at || ''),
      closed_at: row.closed_at || null,
      actions: Array.isArray(row.actions) ? row.actions.length : 0
    });
    if (outRows.length >= limit) break;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'postmortem_list',
    ts: nowIso(),
    count: outRows.length,
    rows: outRows
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normText(args._[0], 64).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'open') return cmdOpen(args);
  if (cmd === 'add-action') return cmdAddAction(args);
  if (cmd === 'verify-action') return cmdVerifyAction(args);
  if (cmd === 'resolve-action') return cmdResolveAction(args);
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'close') return cmdClose(args);
  if (cmd === 'list') return cmdList(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'postmortem_loop_failed')
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  evaluateCloseGuard,
  incidentSlug,
  parseArgs
};
export {};
