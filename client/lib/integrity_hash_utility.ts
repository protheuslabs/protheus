'use strict';

const crypto = require('crypto');
const fs = require('fs');

type AnyObj = Record<string, any>;

function stableStringify(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const obj = value as AnyObj;
  const keys = Object.keys(obj).sort((a, b) => String(a).localeCompare(String(b)));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function sha256Hex(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function hashFileSha256(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = {
  stableStringify,
  sha256Hex,
  hashFileSha256
};
export {};
