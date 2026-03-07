'use strict';

const path = require('path');
const fs = require('fs');

const ADAPTIVE_DIR = path.join(__dirname, '..', '..', '..', 'adaptive', 'sensory', 'eyes', 'collectors');

function resolveAdaptivePath() {
  const tsPath = path.join(ADAPTIVE_DIR, 'bird_x.ts');
  if (fs.existsSync(tsPath)) return tsPath;
  return path.join(ADAPTIVE_DIR, 'bird_x.js');
}

function loadAdaptiveFresh() {
  const adaptivePath = resolveAdaptivePath();
  delete require.cache[require.resolve(adaptivePath)];
  return require(adaptivePath);
}

async function collectBirdX(options = {}) {
  return loadAdaptiveFresh().collectBirdX(options);
}

async function preflightBirdX() {
  return loadAdaptiveFresh().preflightBirdX();
}

module.exports = {
  collectBirdX,
  preflightBirdX
};
export {};
