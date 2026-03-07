const crypto = require('crypto');

type UidOptions = {
  prefix?: string;
  length?: number;
};

function normalizePrefix(v: unknown): string {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4);
}

function toBase36FromHex(hex: unknown): string {
  const clean = String(hex || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (!clean) return '0';
  return BigInt(`0x${clean}`).toString(36);
}

function isAlnum(v: unknown): boolean {
  return /^[A-Za-z0-9]+$/.test(String(v || ''));
}

function stableUid(seed: unknown, opts: UidOptions = {}): string {
  const prefix = normalizePrefix(opts.prefix || '');
  const len = Number.isFinite(Number(opts.length)) ? Math.max(8, Math.min(48, Math.floor(Number(opts.length)))) : 24;
  const hex = crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex');
  const body = toBase36FromHex(hex).slice(0, len);
  const uid = `${prefix}${body}`;
  return uid.slice(0, len);
}

function randomUid(opts: UidOptions = {}): string {
  const prefix = normalizePrefix(opts.prefix || '');
  const len = Number.isFinite(Number(opts.length)) ? Math.max(8, Math.min(48, Math.floor(Number(opts.length)))) : 24;
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(12).toString('hex');
  const body = toBase36FromHex(`${rnd}${rnd}`).slice(0, Math.max(4, len - ts.length));
  const uid = `${prefix}${ts}${body}`;
  return uid.slice(0, len);
}

export {
  isAlnum,
  stableUid,
  randomUid
};
