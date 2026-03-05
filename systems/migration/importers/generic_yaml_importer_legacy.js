'use strict';

const genericJson = require('./generic_json_importer');

function parseSimpleYaml(text) {
  const out = {};
  String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .forEach((line) => {
      const idx = line.indexOf(':');
      if (idx <= 0) return;
      const key = line.slice(0, idx).trim();
      const raw = line.slice(idx + 1).trim();
      if (!key) return;
      if (raw === 'true' || raw === 'false') {
        out[key] = raw === 'true';
        return;
      }
      if (/^-?\d+(\.\d+)?$/.test(raw)) {
        out[key] = Number(raw);
        return;
      }
      out[key] = raw.replace(/^['"]|['"]$/g, '');
    });
  return out;
}

function importPayload(payload, context = {}) {
  let parsed = payload;
  if (typeof payload === 'string') {
    parsed = parseSimpleYaml(payload);
  }
  return genericJson.importPayload(parsed, context);
}

module.exports = {
  engine: 'generic_yaml',
  parseSimpleYaml,
  importPayload
};
