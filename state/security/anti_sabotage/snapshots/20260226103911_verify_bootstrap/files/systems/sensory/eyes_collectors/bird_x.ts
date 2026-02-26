'use strict';

const path = require('path');

const ADAPTIVE_PATH = path.join(__dirname, '..', '..', '..', 'adaptive', 'sensory', 'eyes', 'collectors', 'bird_x.js');

function loadAdaptiveFresh() {
  delete require.cache[require.resolve(ADAPTIVE_PATH)];
  return require(ADAPTIVE_PATH);
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
