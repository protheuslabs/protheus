'use strict';

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function token(v) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function importPayload(payload) {
  const obj = payload && typeof payload === 'object' ? payload : {};
  const keys = Object.keys(obj);
  const records = [];
  let sourceItemCount = 0;

  keys.forEach((key) => {
    const value = obj[key];
    if (Array.isArray(value)) {
      sourceItemCount += value.length;
      value.forEach((row, idx) => {
        records.push({
          id: `${token(key) || 'record'}_${idx + 1}`,
          bucket: key,
          source: row
        });
      });
      return;
    }
    sourceItemCount += 1;
    records.push({
      id: token(key) || `record_${records.length + 1}`,
      bucket: key,
      source: value
    });
  });

  return {
    entities: {
      agents: [],
      tasks: [],
      workflows: [],
      tools: [],
      records
    },
    source_item_count: sourceItemCount,
    mapped_item_count: records.length,
    warnings: []
  };
}

module.exports = {
  engine: 'generic_json',
  importPayload
};
