'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { linkReceiptToPassport } = require('./agent_passport_link');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function chainStatePath(filePath) {
  return `${filePath}.chain.json`;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function optionalHmac(hash) {
  const key = String(process.env.RECEIPT_CHAIN_HMAC_KEY || '').trim();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(String(hash || ''), 'utf8').digest('hex');
}

function readChainState(filePath) {
  const statePath = chainStatePath(filePath);
  try {
    if (!fs.existsSync(statePath)) return { seq: 0, hash: null };
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const seq = Number(raw && raw.seq);
    const hash = raw && typeof raw.hash === 'string' ? raw.hash : null;
    return {
      seq: Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : 0,
      hash: hash || null
    };
  } catch {
    return { seq: 0, hash: null };
  }
}

function writeChainState(filePath, state) {
  const statePath = chainStatePath(filePath);
  ensureDir(path.dirname(statePath));
  const tmpPath = `${statePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify({
    seq: Number(state && state.seq || 0),
    hash: state && state.hash ? String(state.hash) : null,
    ts: nowIso()
  }, null, 2), 'utf8');
  fs.renameSync(tmpPath, statePath);
}

function withReceiptIntegrity(filePath, record) {
  const src = record && typeof record === 'object' ? record : {};
  const chain = readChainState(filePath);
  const seq = Number(chain.seq || 0) + 1;
  const prevHash = chain.hash || null;
  const payloadHash = sha256Hex(JSON.stringify(src));
  const linkHash = sha256Hex([String(seq), String(prevHash || ''), payloadHash].join(':'));
  const hmac = optionalHmac(linkHash);
  const next = {
    ...src,
    receipt_contract: {
      ...(src.receipt_contract && typeof src.receipt_contract === 'object' ? src.receipt_contract : {}),
      integrity: {
        version: '1.0',
        seq,
        prev_hash: prevHash,
        payload_hash: payloadHash,
        hash: linkHash,
        hmac,
        ts: nowIso()
      }
    }
  };
  writeChainState(filePath, { seq, hash: linkHash });
  return next;
}

function withReceiptContract(record, { attempted = true, verified = false } = {}) {
  return {
    ...record,
    receipt_contract: {
      version: '1.0',
      attempted: attempted === true,
      verified: verified === true,
      recorded: true
    }
  };
}

function writeContractReceipt(filePath, record, { attempted = true, verified = false } = {}) {
  const withContract = withReceiptContract(record, { attempted, verified });
  const withIntegrity = withReceiptIntegrity(filePath, withContract);
  appendJsonl(filePath, withIntegrity);
  // Non-blocking adjacent lane: passport chain should never break receipt writes.
  linkReceiptToPassport(filePath, withIntegrity);
  return withIntegrity;
}

module.exports = {
  nowIso,
  appendJsonl,
  withReceiptContract,
  writeContractReceipt
};
export {};
