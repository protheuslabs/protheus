'use strict';
// Layer ownership: adapters/cognition/collectors (authoritative)

const adaptive = require('../../../client/cognition/shared/adaptive/sensory/eyes/collectors/bird_x.ts');

async function collectBirdX(options = {}) {
  return adaptive.collectBirdX(options);
}

async function preflightBirdX() {
  return adaptive.preflightBirdX();
}

module.exports = {
  ...adaptive,
  collectBirdX,
  preflightBirdX,
};
