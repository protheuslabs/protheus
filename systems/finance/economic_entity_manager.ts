#!/usr/bin/env node
'use strict';
export {};

/**
 * economic_entity_manager.js
 *
 * V3-029:
 * Autonomous economic entity management with strict governance:
 * - immutable accounting ledger
 * - tax classification + monthly report pipeline
 * - contract signing + verification
 * - constitution-compliant payout routing with Eye + payment bridge gates
 *
 * Commands:
 *   node systems/finance/economic_entity_manager.js ledger-entry --kind=income|expense --amount-usd=<n> --category=<id> [--source=<id>] [--objective-id=<id>] [--apply=1|0]
 *   node systems/finance/economic_entity_manager.js classify-tax --entry-id=<id> [--apply=1|0]
 *   node systems/finance/economic_entity_manager.js tax-report [--month=YYYY-MM] [--apply=1|0] [--approval-note="..."]
 *   node systems/finance/economic_entity_manager.js contract-sign --contract-id=<id> --counterparty=<id> --value-usd=<n> --terms="<text>" [--risk=low|medium|high|critical] [--apply=1|0] [--approval-note="..."]
 *   node systems/finance/economic_entity_manager.js contract-verify --contract-id=<id>
 *   node systems/finance/economic_entity_manager.js payout-route --provider=stripe|paypal|mercury --recipient=<id> --amount-usd=<n> [--apply=1|0] [--approval-note="..."]
 *   node systems/finance/economic_entity_manager.js status [--month=YYYY-MM]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.ECONOMIC_ENTITY_POLICY_PATH
  ? path.resolve(String(process.env.ECONOMIC_ENTITY_POLICY_PATH))
  : path.join(ROOT, 'config', 'economic_entity_management_policy.json');
const EYE_KERNEL_SCRIPT = path.join(ROOT, 'systems', 'eye', 'eye_kernel.js');
const PAYMENT_BRIDGE_SCRIPT = path.join(ROOT, 'systems', 'workflow', 'payment_skills_bridge.js');

function nowIso() {
  return new Date().toISOString();
}

function toMonth(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 7);
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(absPath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(absPath: string, payload: AnyObj) {
  ensureDir(path.dirname(absPath));
  const tmp = `${absPath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, absPath);
}

function appendJsonl(absPath: string, row: AnyObj) {
  ensureDir(path.dirname(absPath));
  fs.appendFileSync(absPath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function resolvePath(v: unknown, fallbackRel: string) {
  const text = clean(v || fallbackRel, 360);
  return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
}

function parseJsonOutput(raw: unknown) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]);
      } catch {}
    }
  }
  return null;
}

function runNodeJson(scriptPath: string, args: string[]) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    ok: r.status === 0,
    code: Number(r.status || 0),
    payload: parseJsonOutput(r.stdout),
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim()
  };
}

function stableId(prefix: string, seed: string) {
  const digest = crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 14);
  return `${prefix}_${digest}`;
}

function hashJson(input: AnyObj) {
  return crypto.createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    currency: 'USD',
    tax_classification_map: {
      saas_income: 'business_income',
      service_income: 'business_income',
      compute: 'cost_of_goods',
      tools: 'operating_expense',
      contractor: 'contractor_expense',
      payout: 'distribution'
    },
    high_risk_filing: {
      amount_usd_threshold: 5000,
      categories: ['tax_filing', 'external_contract_signing', 'capital_transfer'],
      require_human_approval: true,
      min_approval_note_chars: 12
    },
    payout: {
      require_eye_gate: true,
      require_approval_note_for_amount_usd: 1000
    },
    contracts: {
      require_terms_digest: true,
      require_counterparty: true
    },
    paths: {
      state: 'state/finance/economic_entity/state.json',
      latest: 'state/finance/economic_entity/latest.json',
      ledger: 'state/finance/economic_entity/ledger.jsonl',
      receipts: 'state/finance/economic_entity/receipts.jsonl',
      tax_reports: 'state/finance/economic_entity/tax_reports'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const highRisk = raw.high_risk_filing && typeof raw.high_risk_filing === 'object'
    ? raw.high_risk_filing
    : {};
  const payout = raw.payout && typeof raw.payout === 'object' ? raw.payout : {};
  const contracts = raw.contracts && typeof raw.contracts === 'object' ? raw.contracts : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const map = raw.tax_classification_map && typeof raw.tax_classification_map === 'object'
    ? raw.tax_classification_map
    : base.tax_classification_map;
  return {
    version: clean(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    currency: clean(raw.currency || base.currency, 12).toUpperCase() || base.currency,
    tax_classification_map: Object.fromEntries(
      Object.entries(map).map(([k, v]) => [normalizeToken(k, 80), normalizeToken(v, 80)])
    ),
    high_risk_filing: {
      amount_usd_threshold: clampNum(highRisk.amount_usd_threshold, 1, 1_000_000_000, base.high_risk_filing.amount_usd_threshold),
      categories: Array.from(new Set(
        (Array.isArray(highRisk.categories) ? highRisk.categories : base.high_risk_filing.categories)
          .map((row: unknown) => normalizeToken(row, 80))
          .filter(Boolean)
      )),
      require_human_approval: highRisk.require_human_approval !== false,
      min_approval_note_chars: Math.max(1, Number(highRisk.min_approval_note_chars || base.high_risk_filing.min_approval_note_chars) || base.high_risk_filing.min_approval_note_chars)
    },
    payout: {
      require_eye_gate: payout.require_eye_gate !== false,
      require_approval_note_for_amount_usd: clampNum(
        payout.require_approval_note_for_amount_usd,
        0,
        1_000_000_000,
        base.payout.require_approval_note_for_amount_usd
      )
    },
    contracts: {
      require_terms_digest: contracts.require_terms_digest !== false,
      require_counterparty: contracts.require_counterparty !== false
    },
    paths: {
      state: resolvePath(paths.state, base.paths.state),
      latest: resolvePath(paths.latest, base.paths.latest),
      ledger: resolvePath(paths.ledger, base.paths.ledger),
      receipts: resolvePath(paths.receipts, base.paths.receipts),
      tax_reports: resolvePath(paths.tax_reports, base.paths.tax_reports)
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState() {
  return {
    schema_id: 'economic_entity_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    last_receipt_hash: null,
    entries: {},
    contracts: {},
    payouts: {},
    tax_reports: {}
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.paths.state, null);
  if (!src || typeof src !== 'object') return defaultState();
  const base = defaultState();
  return {
    ...base,
    ...src,
    entries: src.entries && typeof src.entries === 'object' ? src.entries : {},
    contracts: src.contracts && typeof src.contracts === 'object' ? src.contracts : {},
    payouts: src.payouts && typeof src.payouts === 'object' ? src.payouts : {},
    tax_reports: src.tax_reports && typeof src.tax_reports === 'object' ? src.tax_reports : {}
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  state.updated_at = nowIso();
  writeJsonAtomic(policy.paths.state, state);
}

function appendImmutableReceipt(policy: AnyObj, state: AnyObj, type: string, body: AnyObj) {
  const prevHash = clean(state.last_receipt_hash || '', 200) || null;
  const row = {
    ts: nowIso(),
    type: normalizeToken(type, 80),
    prev_hash: prevHash,
    body
  };
  const rowHash = hashJson(row);
  const out = { ...row, hash: rowHash };
  appendJsonl(policy.paths.receipts, out);
  state.last_receipt_hash = rowHash;
  return out;
}

function writeLatest(policy: AnyObj, payload: AnyObj) {
  writeJsonAtomic(policy.paths.latest, payload);
}

function ensureApprovalForHighRisk(policy: AnyObj, category: string, amountUsd: number, approvalNote: string) {
  const high = policy.high_risk_filing && typeof policy.high_risk_filing === 'object'
    ? policy.high_risk_filing
    : {};
  const categories = Array.isArray(high.categories) ? high.categories : [];
  const categoryRisk = categories.includes(category);
  const amountRisk = amountUsd >= Number(high.amount_usd_threshold || 0);
  const requireHuman = high.require_human_approval !== false;
  const minChars = Math.max(1, Number(high.min_approval_note_chars || 12) || 12);
  const isHigh = categoryRisk || amountRisk;
  const approved = !isHigh
    || !requireHuman
    || clean(approvalNote, 800).length >= minChars;
  return {
    is_high_risk: isHigh,
    approved,
    reason: approved ? null : 'high_risk_missing_approval_note',
    min_chars: minChars
  };
}

function cmdLedgerEntry(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const kind = normalizeToken(args.kind || '', 32);
  const amountUsd = clampNum(args['amount-usd'] ?? args.amount_usd, 0.01, 1_000_000_000, 0);
  const category = normalizeToken(args.category || '', 80);
  const source = normalizeToken(args.source || 'unknown', 120) || 'unknown';
  const objectiveId = normalizeToken(args['objective-id'] || args.objective_id || '', 120) || null;
  const apply = toBool(args.apply, false) && policy.shadow_only !== true;
  const approvalNote = clean(args['approval-note'] || args.approval_note || '', 800);

  if (!['income', 'expense'].includes(kind)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'economic_entity_ledger_entry', error: 'invalid_kind', allowed: ['income', 'expense'] })}\n`);
    process.exit(2);
  }
  if (!category) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'economic_entity_ledger_entry', error: 'category_required' })}\n`);
    process.exit(2);
  }

  const riskGate = ensureApprovalForHighRisk(policy, category, amountUsd, approvalNote);
  if (riskGate.approved !== true) {
    const out = {
      ok: false,
      type: 'economic_entity_ledger_entry',
      error: riskGate.reason,
      is_high_risk: riskGate.is_high_risk,
      min_approval_note_chars: riskGate.min_chars
    };
    writeLatest(policy, out);
    appendImmutableReceipt(policy, state, 'economic_entity_ledger_entry_blocked', out);
    saveState(policy, state);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
  }

  const entryId = stableId('eem_entry', `${nowIso()}|${kind}|${category}|${amountUsd}|${source}|${objectiveId || ''}`);
  const taxClass = policy.tax_classification_map[category] || 'unclassified';
  const entry = {
    entry_id: entryId,
    ts: nowIso(),
    month: toMonth(nowIso()),
    kind,
    amount_usd: amountUsd,
    currency: policy.currency,
    category,
    tax_classification: taxClass,
    source,
    objective_id: objectiveId,
    mode: apply ? 'applied' : 'shadow',
    is_high_risk: riskGate.is_high_risk
  };
  state.entries[entryId] = entry;
  appendJsonl(policy.paths.ledger, {
    type: 'economic_ledger_entry',
    ...entry
  });
  const out = {
    ok: true,
    type: 'economic_entity_ledger_entry',
    ts: nowIso(),
    entry,
    policy_path: rel(policy.policy_path),
    shadow_only: policy.shadow_only === true,
    apply
  };
  appendImmutableReceipt(policy, state, 'economic_entity_ledger_entry', out);
  saveState(policy, state);
  writeLatest(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdClassifyTax(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const entryId = normalizeToken(args['entry-id'] || args.entry_id || '', 120);
  const apply = toBool(args.apply, false) && policy.shadow_only !== true;
  const entry = state.entries[entryId];
  if (!entry) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'economic_entity_classify_tax', error: 'entry_not_found', entry_id: entryId || null })}\n`);
    process.exit(1);
  }
  const taxClass = policy.tax_classification_map[normalizeToken(entry.category || '', 80)] || 'unclassified';
  if (apply) entry.tax_classification = taxClass;
  const out = {
    ok: true,
    type: 'economic_entity_classify_tax',
    ts: nowIso(),
    entry_id: entryId,
    category: entry.category,
    tax_classification: taxClass,
    apply
  };
  appendImmutableReceipt(policy, state, 'economic_entity_classify_tax', out);
  saveState(policy, state);
  writeLatest(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdTaxReport(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const month = toMonth(args.month || nowIso());
  const apply = toBool(args.apply, false) && policy.shadow_only !== true;
  const approvalNote = clean(args['approval-note'] || args.approval_note || '', 800);

  const rows = Object.values(state.entries || {})
    .filter((row: AnyObj) => String(row.month || '').startsWith(month))
    .map((row: AnyObj) => ({
      kind: normalizeToken(row.kind || '', 32),
      tax_classification: normalizeToken(row.tax_classification || 'unclassified', 80) || 'unclassified',
      amount_usd: clampNum(row.amount_usd, 0, 1_000_000_000, 0)
    }));
  const byClass: Record<string, AnyObj> = {};
  for (const row of rows) {
    if (!byClass[row.tax_classification]) {
      byClass[row.tax_classification] = { income_usd: 0, expense_usd: 0 };
    }
    if (row.kind === 'income') byClass[row.tax_classification].income_usd += row.amount_usd;
    else byClass[row.tax_classification].expense_usd += row.amount_usd;
  }
  const totals = Object.entries(byClass).map(([taxClass, sums]) => ({
    tax_classification: taxClass,
    income_usd: Number((sums as AnyObj).income_usd.toFixed(2)),
    expense_usd: Number((sums as AnyObj).expense_usd.toFixed(2)),
    net_usd: Number(((sums as AnyObj).income_usd - (sums as AnyObj).expense_usd).toFixed(2))
  }));
  const grossAmount = totals.reduce((acc, row) => acc + Math.abs(Number(row.net_usd || 0)), 0);
  const riskGate = ensureApprovalForHighRisk(policy, 'tax_filing', grossAmount, approvalNote);
  if (apply && riskGate.approved !== true) {
    const out = {
      ok: false,
      type: 'economic_entity_tax_report',
      error: riskGate.reason,
      month,
      gross_amount_usd: Number(grossAmount.toFixed(2))
    };
    appendImmutableReceipt(policy, state, 'economic_entity_tax_report_blocked', out);
    saveState(policy, state);
    writeLatest(policy, out);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
  }
  const report = {
    report_id: stableId('eem_tax', `${month}|${JSON.stringify(totals)}`),
    month,
    generated_at: nowIso(),
    totals,
    gross_amount_usd: Number(grossAmount.toFixed(2)),
    mode: apply ? 'applied' : 'shadow'
  };
  if (apply) {
    state.tax_reports[report.report_id] = report;
    ensureDir(policy.paths.tax_reports);
    writeJsonAtomic(path.join(policy.paths.tax_reports, `${month}.json`), report);
  }
  const out = {
    ok: true,
    type: 'economic_entity_tax_report',
    report,
    apply
  };
  appendImmutableReceipt(policy, state, 'economic_entity_tax_report', out);
  saveState(policy, state);
  writeLatest(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdContractSign(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const contractId = normalizeToken(args['contract-id'] || args.contract_id || '', 140);
  const counterparty = normalizeToken(args.counterparty || '', 140);
  const valueUsd = clampNum(args['value-usd'] ?? args.value_usd, 0.01, 1_000_000_000, 0);
  const risk = normalizeToken(args.risk || 'medium', 20) || 'medium';
  const terms = clean(args.terms || '', 4000);
  const apply = toBool(args.apply, false) && policy.shadow_only !== true;
  const approvalNote = clean(args['approval-note'] || args.approval_note || '', 800);
  if (!contractId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'economic_entity_contract_sign', error: 'contract_id_required' })}\n`);
    process.exit(2);
  }
  if (policy.contracts.require_counterparty !== false && !counterparty) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'economic_entity_contract_sign', error: 'counterparty_required' })}\n`);
    process.exit(2);
  }
  if (!terms) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'economic_entity_contract_sign', error: 'terms_required' })}\n`);
    process.exit(2);
  }
  const termsDigest = crypto.createHash('sha256').update(terms, 'utf8').digest('hex');
  const riskCategory = risk === 'high' || risk === 'critical' ? 'external_contract_signing' : 'contract_signing';
  const riskGate = ensureApprovalForHighRisk(policy, riskCategory, valueUsd, approvalNote);
  if (apply && riskGate.approved !== true) {
    const out = {
      ok: false,
      type: 'economic_entity_contract_sign',
      error: riskGate.reason,
      contract_id: contractId,
      value_usd: valueUsd
    };
    appendImmutableReceipt(policy, state, 'economic_entity_contract_sign_blocked', out);
    saveState(policy, state);
    writeLatest(policy, out);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
  }
  const signaturePayload = `${contractId}|${counterparty}|${valueUsd}|${termsDigest}|${nowIso()}`;
  const signature = crypto.createHash('sha256').update(signaturePayload, 'utf8').digest('hex');
  const row = {
    contract_id: contractId,
    counterparty,
    value_usd: valueUsd,
    risk,
    terms_digest: termsDigest,
    signature,
    signed_at: nowIso(),
    mode: apply ? 'applied' : 'shadow'
  };
  if (apply) state.contracts[contractId] = row;
  const out = {
    ok: true,
    type: 'economic_entity_contract_sign',
    contract: row,
    apply
  };
  appendImmutableReceipt(policy, state, 'economic_entity_contract_sign', out);
  saveState(policy, state);
  writeLatest(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdContractVerify(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const contractId = normalizeToken(args['contract-id'] || args.contract_id || '', 140);
  const row = state.contracts[contractId];
  if (!row) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'economic_entity_contract_verify', error: 'contract_not_found', contract_id: contractId || null })}\n`);
    process.exit(1);
  }
  const requiredDigest = policy.contracts.require_terms_digest !== false;
  const digestPresent = !!clean(row.terms_digest || '', 200);
  const signaturePresent = !!clean(row.signature || '', 200);
  const pass = signaturePresent && (!requiredDigest || digestPresent);
  const out = {
    ok: pass,
    type: 'economic_entity_contract_verify',
    contract_id: contractId,
    verify: {
      signature_present: signaturePresent,
      terms_digest_present: digestPresent,
      require_terms_digest: requiredDigest
    }
  };
  appendImmutableReceipt(policy, state, 'economic_entity_contract_verify', out);
  saveState(policy, state);
  writeLatest(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!pass) process.exit(1);
}

function evaluateEyeGate(policy: AnyObj, payout: AnyObj, apply: boolean) {
  if (policy.payout.require_eye_gate !== true) {
    return {
      ok: true,
      payload: {
        ok: true,
        type: 'eye_kernel_route',
        decision: 'allow',
        reasons: ['eye_gate_disabled_by_policy']
      }
    };
  }
  const mock = normalizeToken(process.env.EEM_MOCK_EYE_DECISION || '', 20);
  if (mock) {
    return {
      ok: mock !== 'deny',
      payload: {
        ok: mock !== 'deny',
        type: 'eye_kernel_route',
        decision: mock,
        reasons: mock === 'allow' ? [] : ['mock_eye_decision']
      }
    };
  }
  return runNodeJson(EYE_KERNEL_SCRIPT, [
    'route',
    '--lane=external',
    '--target=payment',
    '--action=execute',
    `--risk=${payout.risk}`,
    '--clearance=L3',
    '--estimated-tokens=300',
    `--apply=${apply ? 1 : 0}`,
    '--reason=economic_entity_payout',
    `--request-id=${payout.payout_id}`
  ]);
}

function evaluatePaymentBridge(payout: AnyObj, apply: boolean, approvalNote: string) {
  const mock = normalizeToken(process.env.EEM_MOCK_PAYMENT_DECISION || '', 20);
  if (mock) {
    return {
      ok: mock !== 'deny',
      payload: {
        ok: mock !== 'deny',
        type: 'payment_skills_bridge',
        decision: mock,
        result: mock === 'execute' ? 'ok' : 'blocked',
        payout_id: payout.payout_id
      }
    };
  }
  const args = [
    'payout',
    `--provider=${payout.provider}`,
    `--amount-usd=${payout.amount_usd}`,
    `--recipient=${payout.recipient}`,
    `--payout-id=${payout.payout_id}`,
    `--apply=${apply ? 1 : 0}`
  ];
  if (approvalNote) args.push(`--approval-note=${approvalNote}`);
  return runNodeJson(PAYMENT_BRIDGE_SCRIPT, args);
}

function cmdPayoutRoute(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const provider = normalizeToken(args.provider || 'stripe', 40) || 'stripe';
  const recipient = clean(args.recipient || '', 200);
  const amountUsd = clampNum(args['amount-usd'] ?? args.amount_usd, 0.01, 1_000_000_000, 0);
  const apply = toBool(args.apply, false) && policy.shadow_only !== true;
  const approvalNote = clean(args['approval-note'] || args.approval_note || '', 800);
  if (!recipient) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'economic_entity_payout_route', error: 'recipient_required' })}\n`);
    process.exit(2);
  }
  const payoutId = stableId('eem_payout', `${nowIso()}|${provider}|${recipient}|${amountUsd}`);
  const risk = amountUsd >= policy.high_risk_filing.amount_usd_threshold ? 'high' : 'medium';
  const highAmountNeedsNote = amountUsd >= Number(policy.payout.require_approval_note_for_amount_usd || 0);
  if (highAmountNeedsNote && clean(approvalNote, 800).length < policy.high_risk_filing.min_approval_note_chars) {
    const out = {
      ok: false,
      type: 'economic_entity_payout_route',
      error: 'approval_note_required_for_high_amount',
      payout_id: payoutId,
      amount_usd: amountUsd
    };
    appendImmutableReceipt(policy, state, 'economic_entity_payout_route_blocked', out);
    saveState(policy, state);
    writeLatest(policy, out);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
  }

  const payout = {
    payout_id: payoutId,
    provider,
    recipient,
    amount_usd: amountUsd,
    risk
  };

  const eyeGate = evaluateEyeGate(policy, payout, apply);
  const eyeDecision = normalizeToken(eyeGate && eyeGate.payload && eyeGate.payload.decision || '', 20);
  if (!eyeGate.ok || eyeDecision === 'deny') {
    const out = {
      ok: false,
      type: 'economic_entity_payout_route',
      error: 'eye_gate_denied',
      payout,
      eye_result: eyeGate && eyeGate.payload ? eyeGate.payload : null
    };
    appendImmutableReceipt(policy, state, 'economic_entity_payout_route_blocked', out);
    saveState(policy, state);
    writeLatest(policy, out);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
  }

  const payment = evaluatePaymentBridge(payout, apply, approvalNote);
  const paymentDecision = normalizeToken(payment && payment.payload && payment.payload.decision || '', 20) || (payment.ok ? 'execute' : 'deny');
  const out = {
    ok: paymentDecision !== 'deny',
    type: 'economic_entity_payout_route',
    ts: nowIso(),
    payout,
    shadow_only: policy.shadow_only === true,
    apply,
    eye_result: eyeGate && eyeGate.payload ? eyeGate.payload : null,
    payment_result: payment && payment.payload ? payment.payload : null,
    decision: paymentDecision
  };
  state.payouts[payoutId] = {
    ...payout,
    ts: nowIso(),
    decision: paymentDecision,
    mode: apply ? 'applied' : 'shadow'
  };
  appendImmutableReceipt(policy, state, 'economic_entity_payout_route', out);
  saveState(policy, state);
  writeLatest(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const month = toMonth(args.month || nowIso());
  const monthEntries = Object.values(state.entries || {}).filter((row: AnyObj) => String(row.month || '').startsWith(month));
  const out = {
    ok: true,
    type: 'economic_entity_status',
    ts: nowIso(),
    month,
    enabled: policy.enabled === true,
    shadow_only: policy.shadow_only === true,
    counts: {
      entries_total: Object.keys(state.entries || {}).length,
      contracts_total: Object.keys(state.contracts || {}).length,
      payouts_total: Object.keys(state.payouts || {}).length,
      tax_reports_total: Object.keys(state.tax_reports || {}).length,
      entries_in_month: monthEntries.length
    },
    paths: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.paths.state),
      latest_path: rel(policy.paths.latest),
      ledger_path: rel(policy.paths.ledger),
      receipts_path: rel(policy.paths.receipts),
      tax_reports_path: rel(policy.paths.tax_reports)
    }
  };
  writeLatest(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/finance/economic_entity_manager.js ledger-entry --kind=income|expense --amount-usd=<n> --category=<id> [--source=<id>] [--objective-id=<id>] [--apply=1|0]');
  console.log('  node systems/finance/economic_entity_manager.js classify-tax --entry-id=<id> [--apply=1|0]');
  console.log('  node systems/finance/economic_entity_manager.js tax-report [--month=YYYY-MM] [--apply=1|0] [--approval-note="..."]');
  console.log('  node systems/finance/economic_entity_manager.js contract-sign --contract-id=<id> --counterparty=<id> --value-usd=<n> --terms="<text>" [--risk=low|medium|high|critical] [--apply=1|0] [--approval-note="..."]');
  console.log('  node systems/finance/economic_entity_manager.js contract-verify --contract-id=<id>');
  console.log('  node systems/finance/economic_entity_manager.js payout-route --provider=stripe|paypal|mercury --recipient=<id> --amount-usd=<n> [--apply=1|0] [--approval-note="..."]');
  console.log('  node systems/finance/economic_entity_manager.js status [--month=YYYY-MM]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'ledger-entry' || cmd === 'ledger_entry') return cmdLedgerEntry(args);
  if (cmd === 'classify-tax' || cmd === 'classify_tax') return cmdClassifyTax(args);
  if (cmd === 'tax-report' || cmd === 'tax_report') return cmdTaxReport(args);
  if (cmd === 'contract-sign' || cmd === 'contract_sign') return cmdContractSign(args);
  if (cmd === 'contract-verify' || cmd === 'contract_verify') return cmdContractVerify(args);
  if (cmd === 'payout-route' || cmd === 'payout_route') return cmdPayoutRoute(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  loadState,
  appendImmutableReceipt
};
