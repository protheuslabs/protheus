'use strict';
export {};

const path = require('path');

let _lane = null;
let _loadAttempted = false;

function loadLane() {
  if (_lane) return _lane;
  if (_loadAttempted) return null;
  _loadAttempted = true;
  try {
    const lanePath = path.join(__dirname, '..', 'systems', 'security', 'agent_passport.js');
    const mod = require(lanePath);
    if (mod && typeof mod.appendActionFromReceipt === 'function') {
      _lane = mod;
      return _lane;
    }
  } catch {
    return null;
  }
  return null;
}

function linkReceiptToPassport(filePath, receiptRecord) {
  const autoLink = String(process.env.AGENT_PASSPORT_AUTOLINK || '1').trim() !== '0';
  if (!autoLink) return null;
  const lane = loadLane();
  if (!lane) return null;
  try {
    return lane.appendActionFromReceipt({
      receipt_path: filePath,
      receipt_record: receiptRecord
    });
  } catch {
    return null;
  }
}

module.exports = {
  linkReceiptToPassport
};

