#!/usr/bin/env node
'use strict';
export {};

const {
  nowIso,
  cleanText,
  stableHash,
  readJson,
  writeJsonAtomic,
  appendJsonl
} = require('./_shared');

function loadContributions(policy: Record<string, any>) {
  const rows = readJson(policy.paths.contributions_path, []);
  return Array.isArray(rows) ? rows : [];
}

function saveContributions(policy: Record<string, any>, rows: any[]) {
  writeJsonAtomic(policy.paths.contributions_path, rows.slice(-5000));
}

function recordContribution(policy: Record<string, any>, input: Record<string, any>) {
  const donorId = cleanText(input.donor_id || input.donor || '', 120) || 'anonymous';
  const gpuHours = Math.max(0, Number(input.gpu_hours || input.hours || 0));
  const proofRef = cleanText(input.proof_ref || input.proof || '', 320) || 'unspecified';
  const contributionId = `gpu_${stableHash(`${donorId}|${gpuHours}|${proofRef}|${Date.now()}`, 18)}`;
  const row = {
    contribution_id: contributionId,
    donor_id: donorId,
    gpu_hours: Number(gpuHours.toFixed(6)),
    proof_ref: proofRef,
    received_at: nowIso(),
    status: 'received'
  };
  const rows = loadContributions(policy);
  rows.push(row);
  saveContributions(policy, rows);
  return row;
}

function updateContributionStatus(policy: Record<string, any>, contributionId: string, status: string, details: Record<string, any> = {}) {
  const rows = loadContributions(policy);
  let updated = null;
  const next = rows.map((row: any) => {
    if (String(row.contribution_id || '') !== String(contributionId || '')) return row;
    updated = {
      ...row,
      status: cleanText(status || 'unknown', 40) || 'unknown',
      status_updated_at: nowIso(),
      ...details
    };
    return updated;
  });
  saveContributions(policy, next);
  return updated;
}

function peerLendingEventsPath(policy: Record<string, any>) {
  const p = policy && policy.paths && policy.paths.peer_lending_events_path
    ? String(policy.paths.peer_lending_events_path)
    : '';
  if (p) return p;
  const fallback = policy && policy.paths && policy.paths.receipts_path
    ? String(policy.paths.receipts_path)
    : 'state/economy/peer_lending/settlement_events.jsonl';
  return fallback;
}

function recordPeerLendingEvent(policy: Record<string, any>, input: Record<string, any>) {
  const kind = cleanText(input.kind || 'lend', 32) || 'lend';
  const lenderId = cleanText(input.lender_id || input.lender || '', 120) || 'unknown_lender';
  const borrowerId = cleanText(input.borrower_id || input.borrower || '', 120) || 'unknown_borrower';
  const gpuHours = Math.max(0, Number(input.gpu_hours || input.hours || 0));
  const settlementCredit = Number(input.settlement_credit || 0);
  const creditRate = Number(input.credit_rate || 0);
  const eventId = `peer_lend_${stableHash(`${kind}|${lenderId}|${borrowerId}|${gpuHours}|${settlementCredit}|${Date.now()}`, 18)}`;
  const row = {
    ts: nowIso(),
    event_id: eventId,
    kind,
    lender_id: lenderId,
    borrower_id: borrowerId,
    gpu_hours: Number(gpuHours.toFixed(6)),
    credit_rate: Number.isFinite(creditRate) ? Number(creditRate.toFixed(6)) : 0,
    settlement_credit: Number.isFinite(settlementCredit) ? Number(settlementCredit.toFixed(6)) : 0,
    contract_ref: cleanText(input.contract_ref || '', 200) || null,
    settlement_ref: cleanText(input.settlement_ref || '', 200) || null
  };
  appendJsonl(peerLendingEventsPath(policy), row);
  return row;
}

module.exports = {
  loadContributions,
  recordContribution,
  updateContributionStatus,
  recordPeerLendingEvent
};
