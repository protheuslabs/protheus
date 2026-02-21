'use strict';

const path = require('path');
const {
  defaultCatalog,
  readCatalog,
  ensureCatalog,
  setCatalog,
  mutateCatalog
} = require('../systems/adaptive/sensory/eyes/catalog_store.js');

function canonicalCatalogPath(workspaceDir) {
  return path.resolve(String(workspaceDir || ''), 'adaptive', 'sensory', 'eyes', 'catalog.json');
}

function resolveCatalogPath(workspaceDir, envValue) {
  const canonical = canonicalCatalogPath(workspaceDir);
  const requested = String(envValue || '').trim();
  if (!requested) return canonical;
  const requestedAbs = path.resolve(requested);
  if (requestedAbs !== canonical) {
    throw new Error(`eyes_catalog: catalog path override denied (requested=${requestedAbs})`);
  }
  return canonical;
}

module.exports = {
  canonicalCatalogPath,
  resolveCatalogPath,
  defaultCatalog,
  readCatalog,
  ensureCatalog,
  setCatalog,
  mutateCatalog
};
