#!/usr/bin/env node
'use strict';
export {};

/**
 * sovereign_blockchain_bridge.js
 *
 * V3-BLK-001 scaffold:
 * - DNA / initialize-on-birth wallet architecture (no live wallet keys in kernel).
 * - Governed bootstrap proposal lane for per-instance wallet initialization.
 * - Shadow-first identity binding receipts (SBT + ERC-8004 + Helix hash intent).
 *
 * Usage:
 *   node systems/blockchain/sovereign_blockchain_bridge.js status
 *   node systems/blockchain/sovereign_blockchain_bridge.js bootstrap-proposal --instance-id=<id> [--birth-context=<ctx>] [--approval-note="..."] [--constitution-approved=1] [--soul-approved=1] [--apply=1]
 *   node systems/blockchain/sovereign_blockchain_bridge.js bind-identity --proposal-id=<id> --sbt-token-id=<id> --erc8004-agent-id=<id> [--approval-note="..."] [--constitution-approved=1] [--soul-approved=1] [--apply=1]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { recordIterationStep } = require('../../lib/passport_iteration_chain');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SOVEREIGN_BLOCKCHAIN_BRIDGE_POLICY_PATH
  ? path.resolve(process.env.SOVEREIGN_BLOCKCHAIN_BRIDGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'sovereign_blockchain_bridge_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
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

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
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

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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
  const text = cleanText(raw, 420);
  if (!text) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
}

function sha256Hex(v: unknown) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  const obj = value as AnyObj;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    wallet_mode: 'initialize_on_birth',
    dna: {
      prime_profile_path: 'config/protheus_prime_profile.json',
      bootstrap_template_path: 'config/bootstrap_wallet_proposal_template.json',
      genome_ledger_path: 'state/brain/genome_ledger.jsonl',
      secret_template_id: 'wallet_dna_root_v1',
      kernel_live_key_forbidden: true
    },
    governance: {
      require_constitution_approval: true,
      require_soul_token_approval: true,
      require_eye_proposal: true,
      min_approval_note_chars: 12
    },
    chains: {
      ethereum_primary: {
        enabled: true,
        network: 'base',
        account_model: 'erc4337',
        paymaster_ready: true
      },
      solana_secondary: {
        enabled: true,
        optional: true,
        account_model: 'derived_keypair'
      }
    },
    identity_binding: {
      require_sbt_binding: true,
      require_erc8004_registration: true,
      require_helix_binding_hash: true
    },
    payments: {
      x402_enabled: true,
      storm_lane: 'storm_value_distribution',
      burn_oracle_source: 'state/ops/dynamic_burn_budget_oracle/latest.json'
    },
    state: {
      state_path: 'state/blockchain/sovereign_bridge/state.json',
      latest_path: 'state/blockchain/sovereign_bridge/latest.json',
      proposals_path: 'state/blockchain/sovereign_bridge/proposals.jsonl',
      bindings_path: 'state/blockchain/sovereign_bridge/bindings.jsonl',
      receipts_path: 'state/blockchain/sovereign_bridge/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const dna = raw.dna && typeof raw.dna === 'object' ? raw.dna : {};
  const governance = raw.governance && typeof raw.governance === 'object' ? raw.governance : {};
  const chains = raw.chains && typeof raw.chains === 'object' ? raw.chains : {};
  const identity = raw.identity_binding && typeof raw.identity_binding === 'object' ? raw.identity_binding : {};
  const payments = raw.payments && typeof raw.payments === 'object' ? raw.payments : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    wallet_mode: normalizeToken(raw.wallet_mode || base.wallet_mode, 80) || base.wallet_mode,
    dna: {
      prime_profile_path: resolvePath(dna.prime_profile_path, base.dna.prime_profile_path),
      bootstrap_template_path: resolvePath(dna.bootstrap_template_path, base.dna.bootstrap_template_path),
      genome_ledger_path: resolvePath(dna.genome_ledger_path, base.dna.genome_ledger_path),
      secret_template_id: cleanText(dna.secret_template_id || base.dna.secret_template_id, 120) || base.dna.secret_template_id,
      kernel_live_key_forbidden: dna.kernel_live_key_forbidden !== false
    },
    governance: {
      require_constitution_approval: governance.require_constitution_approval !== false,
      require_soul_token_approval: governance.require_soul_token_approval !== false,
      require_eye_proposal: governance.require_eye_proposal !== false,
      min_approval_note_chars: clampInt(
        governance.min_approval_note_chars,
        1,
        200,
        base.governance.min_approval_note_chars
      )
    },
    chains: {
      ethereum_primary: {
        enabled: !chains.ethereum_primary || chains.ethereum_primary.enabled !== false,
        network: cleanText(
          chains.ethereum_primary && chains.ethereum_primary.network || base.chains.ethereum_primary.network,
          80
        ) || base.chains.ethereum_primary.network,
        account_model: normalizeToken(
          chains.ethereum_primary && chains.ethereum_primary.account_model || base.chains.ethereum_primary.account_model,
          80
        ) || base.chains.ethereum_primary.account_model,
        paymaster_ready: !chains.ethereum_primary || chains.ethereum_primary.paymaster_ready !== false
      },
      solana_secondary: {
        enabled: !chains.solana_secondary || chains.solana_secondary.enabled !== false,
        optional: !chains.solana_secondary || chains.solana_secondary.optional !== false,
        account_model: normalizeToken(
          chains.solana_secondary && chains.solana_secondary.account_model || base.chains.solana_secondary.account_model,
          80
        ) || base.chains.solana_secondary.account_model
      }
    },
    identity_binding: {
      require_sbt_binding: identity.require_sbt_binding !== false,
      require_erc8004_registration: identity.require_erc8004_registration !== false,
      require_helix_binding_hash: identity.require_helix_binding_hash !== false
    },
    payments: {
      x402_enabled: payments.x402_enabled !== false,
      storm_lane: normalizeToken(payments.storm_lane || base.payments.storm_lane, 120) || base.payments.storm_lane,
      burn_oracle_source: resolvePath(payments.burn_oracle_source, base.payments.burn_oracle_source)
    },
    state: {
      state_path: resolvePath(state.state_path, base.state.state_path),
      latest_path: resolvePath(state.latest_path, base.state.latest_path),
      proposals_path: resolvePath(state.proposals_path, base.state.proposals_path),
      bindings_path: resolvePath(state.bindings_path, base.state.bindings_path),
      receipts_path: resolvePath(state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state.state_path, {});
  return {
    schema_id: 'sovereign_blockchain_bridge_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 60) || nowIso(),
    last_proposal_id: cleanText(src.last_proposal_id || '', 120) || null,
    last_binding_id: cleanText(src.last_binding_id || '', 120) || null,
    total_proposals: clampInt(src.total_proposals, 0, 1000000000, 0),
    total_bindings: clampInt(src.total_bindings, 0, 1000000000, 0)
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state.state_path, {
    schema_id: 'sovereign_blockchain_bridge_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    last_proposal_id: cleanText(state.last_proposal_id || '', 120) || null,
    last_binding_id: cleanText(state.last_binding_id || '', 120) || null,
    total_proposals: clampInt(state.total_proposals, 0, 1000000000, 0),
    total_bindings: clampInt(state.total_bindings, 0, 1000000000, 0)
  });
}

function loadPrimeProfile(policy: AnyObj) {
  return readJson(policy.dna.prime_profile_path, {});
}

function loadBootstrapTemplate(policy: AnyObj) {
  return readJson(policy.dna.bootstrap_template_path, {});
}

function kernelWalletMaterialGuard(policy: AnyObj) {
  const banned = [
    'private_key',
    'private key',
    'seed phrase',
    'mnemonic',
    'wallet_secret',
    'xprv'
  ];
  const kernelFiles = [
    'systems/spine/spine.ts',
    'systems/eye/eye_kernel.ts',
    'systems/ops/state_kernel.ts',
    'systems/security/integrity_kernel.ts',
    'systems/security/guard.ts'
  ];
  const violations: AnyObj[] = [];
  if (policy.dna.kernel_live_key_forbidden !== true) {
    return {
      ok: false,
      reason: 'kernel_live_key_forbidden_disabled',
      checked_files: kernelFiles,
      violations
    };
  }
  for (const rel of kernelFiles) {
    const abs = path.join(ROOT, rel);
    let src = '';
    try {
      src = fs.readFileSync(abs, 'utf8').toLowerCase();
    } catch {
      src = '';
    }
    for (const token of banned) {
      if (src.includes(token)) {
        violations.push({
          file: rel,
          token
        });
      }
    }
  }
  return {
    ok: violations.length === 0,
    reason: violations.length === 0 ? 'clear' : 'forbidden_wallet_material_detected',
    checked_files: kernelFiles,
    violations
  };
}

function deterministicWalletPlan(policy: AnyObj, instanceId: string, birthContext: string) {
  const template = loadBootstrapTemplate(policy);
  const templateId = normalizeToken(template.template_id || 'wallet_birth_bootstrap_v1', 120) || 'wallet_birth_bootstrap_v1';
  const planSeed = stableStringify({
    version: policy.version,
    instance_id: instanceId,
    birth_context: birthContext,
    template_id: templateId,
    secret_template_id: policy.dna.secret_template_id
  });
  const baseHash = sha256Hex(planSeed);
  const planId = `wplan_${baseHash.slice(0, 12)}`;
  const ethDescriptor = policy.chains.ethereum_primary.enabled
    ? {
      network: policy.chains.ethereum_primary.network,
      account_model: policy.chains.ethereum_primary.account_model,
      account_salt: baseHash.slice(0, 32),
      account_descriptor: `erc4337:${policy.chains.ethereum_primary.network}:${baseHash.slice(0, 20)}`
    }
    : null;
  const solDescriptor = policy.chains.solana_secondary.enabled
    ? {
      optional: policy.chains.solana_secondary.optional === true,
      account_model: policy.chains.solana_secondary.account_model,
      derivation_hint: `solana:${baseHash.slice(20, 52)}`
    }
    : null;
  return {
    plan_id: planId,
    template_id: templateId,
    birth_context: birthContext,
    instance_id: instanceId,
    key_material_in_kernel: false,
    secret_material_lane: {
      storage: 'secret_broker_plus_organ_state_encryption',
      secret_template_id: policy.dna.secret_template_id
    },
    ethereum_primary: ethDescriptor,
    solana_secondary: solDescriptor,
    identity_binding_intent: {
      sbt_required: policy.identity_binding.require_sbt_binding === true,
      erc8004_required: policy.identity_binding.require_erc8004_registration === true,
      helix_binding_required: policy.identity_binding.require_helix_binding_hash === true
    },
    payment_routing_intent: {
      x402_enabled: policy.payments.x402_enabled === true,
      storm_lane: policy.payments.storm_lane,
      burn_oracle_source: relPath(policy.payments.burn_oracle_source)
    }
  };
}

function governanceGate(policy: AnyObj, args: AnyObj) {
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 400);
  const constitutionApproved = toBool(args['constitution-approved'] || args.constitution_approved, false);
  const soulApproved = toBool(args['soul-approved'] || args.soul_approved, false);
  const reasons: string[] = [];
  if (approvalNote.length < Number(policy.governance.min_approval_note_chars || 12)) reasons.push('approval_note_short');
  if (policy.governance.require_constitution_approval && !constitutionApproved) reasons.push('constitution_approval_missing');
  if (policy.governance.require_soul_token_approval && !soulApproved) reasons.push('soul_token_approval_missing');
  return {
    ok: reasons.length === 0,
    approval_note: approvalNote || null,
    constitution_approved: constitutionApproved,
    soul_approved: soulApproved,
    reason_codes: reasons
  };
}

function appendGenomeLedger(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.dna.genome_ledger_path, {
    ts: nowIso(),
    type: 'wallet_dna_event',
    ...row
  });
}

function persistLatest(policy: AnyObj, out: AnyObj) {
  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.receipts_path, out);
}

function cmdBootstrapProposal(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const instanceId = normalizeToken(args['instance-id'] || args.instance_id || '', 160);
  if (!instanceId) {
    const out = {
      ok: false,
      type: 'sovereign_blockchain_bridge_bootstrap_proposal',
      ts: nowIso(),
      error: 'instance_id_required'
    };
    persistLatest(policy, out);
    return out;
  }
  const birthContext = normalizeToken(args['birth-context'] || args.birth_context || 'bootstrap', 120) || 'bootstrap';
  const apply = toBool(args.apply, false);
  const gate = governanceGate(policy, args);
  const kernelGuard = kernelWalletMaterialGuard(policy);
  const plan = deterministicWalletPlan(policy, instanceId, birthContext);
  const proposalId = normalizeToken(
    args['proposal-id']
      || args.proposal_id
      || `blkp_${sha256Hex(`${instanceId}|${birthContext}|${plan.plan_id}|${nowIso()}`).slice(0, 12)}`,
    120
  );

  let stage = 'shadow_proposed';
  let applyAllowed = false;
  const reasons: string[] = [];
  if (policy.shadow_only === true && apply) {
    stage = 'shadow_blocked_apply';
    reasons.push('shadow_only_mode');
  } else if (apply && !gate.ok) {
    stage = 'governance_blocked';
    reasons.push(...gate.reason_codes);
  } else if (apply && !kernelGuard.ok) {
    stage = 'kernel_guard_blocked';
    reasons.push(kernelGuard.reason);
  } else if (apply) {
    stage = 'approved_bootstrap_ready';
    applyAllowed = true;
  }

  const row = {
    ts: nowIso(),
    type: 'sovereign_blockchain_bridge_bootstrap_proposal',
    proposal_id: proposalId,
    instance_id: instanceId,
    birth_context: birthContext,
    stage,
    apply_requested: apply,
    apply_allowed: applyAllowed,
    governance: gate,
    kernel_wallet_material_guard: kernelGuard,
    wallet_plan: plan,
    reason_codes: reasons
  };
  appendJsonl(policy.state.proposals_path, row);
  appendGenomeLedger(policy, {
    event: 'wallet_bootstrap_proposed',
    proposal_id: proposalId,
    instance_id: instanceId,
    stage
  });
  try {
    recordIterationStep({
      lane: 'blockchain_bridge',
      step: 'wallet_bootstrap_proposal',
      objective_id: 'v3_blk_001',
      target_path: 'systems/blockchain/sovereign_blockchain_bridge.ts',
      metadata: {
        proposal_id: proposalId,
        instance_id: instanceId,
        stage
      }
    });
  } catch {}

  state.last_proposal_id = proposalId;
  state.total_proposals = Number(state.total_proposals || 0) + 1;
  saveState(policy, state);

  const out = {
    ok: true,
    ...row,
    paths: {
      policy_path: relPath(policy.policy_path),
      state_path: relPath(policy.state.state_path),
      proposals_path: relPath(policy.state.proposals_path),
      receipts_path: relPath(policy.state.receipts_path)
    }
  };
  persistLatest(policy, out);
  return out;
}

function cmdBindIdentity(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const proposalId = normalizeToken(args['proposal-id'] || args.proposal_id || '', 120);
  if (!proposalId) {
    const out = {
      ok: false,
      type: 'sovereign_blockchain_bridge_bind_identity',
      ts: nowIso(),
      error: 'proposal_id_required'
    };
    persistLatest(policy, out);
    return out;
  }
  const proposals = readJsonl(policy.state.proposals_path);
  const proposal = proposals.find((row: AnyObj) => normalizeToken(row && row.proposal_id || '', 120) === proposalId) || null;
  if (!proposal) {
    const out = {
      ok: false,
      type: 'sovereign_blockchain_bridge_bind_identity',
      ts: nowIso(),
      error: 'proposal_not_found',
      proposal_id: proposalId
    };
    persistLatest(policy, out);
    return out;
  }

  const sbtTokenId = cleanText(args['sbt-token-id'] || args.sbt_token_id || '', 160) || null;
  const erc8004AgentId = cleanText(args['erc8004-agent-id'] || args.erc8004_agent_id || '', 160) || null;
  const apply = toBool(args.apply, false);
  const gate = governanceGate(policy, args);
  const reasons: string[] = [];
  let stage = 'shadow_binding_intent';
  let applyAllowed = false;
  if (policy.shadow_only === true && apply) {
    reasons.push('shadow_only_mode');
    stage = 'shadow_binding_intent';
  } else if (apply && !gate.ok) {
    reasons.push(...gate.reason_codes);
    stage = 'governance_blocked';
  } else if (apply) {
    stage = 'binding_committed';
    applyAllowed = true;
  }

  const bindingId = normalizeToken(
    args['binding-id']
      || args.binding_id
      || `blkb_${sha256Hex(`${proposalId}|${sbtTokenId}|${erc8004AgentId}|${nowIso()}`).slice(0, 12)}`,
    120
  );
  const helixBindingHash = sha256Hex(stableStringify({
    proposal_id: proposalId,
    binding_id: bindingId,
    instance_id: proposal.instance_id || null,
    wallet_plan_id: proposal.wallet_plan && proposal.wallet_plan.plan_id || null,
    sbt_token_id: sbtTokenId,
    erc8004_agent_id: erc8004AgentId
  }));

  const row = {
    ts: nowIso(),
    type: 'sovereign_blockchain_bridge_bind_identity',
    binding_id: bindingId,
    proposal_id: proposalId,
    apply_requested: apply,
    apply_allowed: applyAllowed,
    stage,
    governance: gate,
    binding: {
      sbt_token_id: sbtTokenId,
      erc8004_agent_id: erc8004AgentId,
      helix_binding_hash: helixBindingHash
    },
    reason_codes: reasons
  };
  appendJsonl(policy.state.bindings_path, row);
  appendGenomeLedger(policy, {
    event: 'wallet_identity_binding',
    binding_id: bindingId,
    proposal_id: proposalId,
    stage
  });
  try {
    recordIterationStep({
      lane: 'blockchain_bridge',
      step: 'wallet_identity_binding',
      objective_id: 'v3_blk_001',
      target_path: 'systems/blockchain/sovereign_blockchain_bridge.ts',
      metadata: {
        proposal_id: proposalId,
        binding_id: bindingId,
        stage
      }
    });
  } catch {}

  state.last_binding_id = bindingId;
  state.total_bindings = Number(state.total_bindings || 0) + 1;
  saveState(policy, state);

  const out = {
    ok: true,
    ...row,
    paths: {
      policy_path: relPath(policy.policy_path),
      state_path: relPath(policy.state.state_path),
      bindings_path: relPath(policy.state.bindings_path),
      receipts_path: relPath(policy.state.receipts_path)
    }
  };
  persistLatest(policy, out);
  return out;
}

function cmdStatus(policy: AnyObj) {
  const state = loadState(policy);
  const latest = readJson(policy.state.latest_path, null);
  const proposals = readJsonl(policy.state.proposals_path);
  const bindings = readJsonl(policy.state.bindings_path);
  const kernelGuard = kernelWalletMaterialGuard(policy);
  return {
    ok: true,
    type: 'sovereign_blockchain_bridge_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      path: relPath(policy.policy_path),
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      wallet_mode: policy.wallet_mode
    },
    dna: {
      prime_profile_path: relPath(policy.dna.prime_profile_path),
      bootstrap_template_path: relPath(policy.dna.bootstrap_template_path),
      genome_ledger_path: relPath(policy.dna.genome_ledger_path),
      secret_template_id: policy.dna.secret_template_id,
      kernel_live_key_forbidden: policy.dna.kernel_live_key_forbidden === true
    },
    kernel_wallet_material_guard: kernelGuard,
    counts: {
      total_proposals: proposals.length,
      total_bindings: bindings.length,
      state_total_proposals: Number(state.total_proposals || 0),
      state_total_bindings: Number(state.total_bindings || 0)
    },
    last_ids: {
      proposal_id: state.last_proposal_id || null,
      binding_id: state.last_binding_id || null
    },
    latest: latest && typeof latest === 'object'
      ? {
        type: cleanText(latest.type || '', 120) || null,
        ts: cleanText(latest.ts || '', 60) || null,
        stage: cleanText(latest.stage || '', 80) || null
      }
      : null,
    paths: {
      state_path: relPath(policy.state.state_path),
      proposals_path: relPath(policy.state.proposals_path),
      bindings_path: relPath(policy.state.bindings_path),
      receipts_path: relPath(policy.state.receipts_path),
      latest_path: relPath(policy.state.latest_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/blockchain/sovereign_blockchain_bridge.js status');
  console.log('  node systems/blockchain/sovereign_blockchain_bridge.js bootstrap-proposal --instance-id=<id> [--birth-context=<ctx>] [--approval-note="..."] [--constitution-approved=1] [--soul-approved=1] [--apply=1]');
  console.log('  node systems/blockchain/sovereign_blockchain_bridge.js bind-identity --proposal-id=<id> --sbt-token-id=<id> --erc8004-agent-id=<id> [--approval-note="..."] [--constitution-approved=1] [--soul-approved=1] [--apply=1]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  let out: AnyObj;
  if (!policy.enabled) {
    out = {
      ok: false,
      type: 'sovereign_blockchain_bridge',
      ts: nowIso(),
      error: 'policy_disabled',
      policy_path: relPath(policy.policy_path)
    };
  } else if (cmd === 'status') {
    out = cmdStatus(policy);
  } else if (cmd === 'bootstrap-proposal') {
    out = cmdBootstrapProposal(policy, args);
  } else if (cmd === 'bind-identity') {
    out = cmdBindIdentity(policy, args);
  } else if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
    return;
  } else {
    out = {
      ok: false,
      type: 'sovereign_blockchain_bridge',
      ts: nowIso(),
      error: `unknown_command:${cmd}`
    };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  cmdStatus,
  cmdBootstrapProposal,
  cmdBindIdentity,
  kernelWalletMaterialGuard,
  deterministicWalletPlan
};
