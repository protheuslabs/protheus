#!/usr/bin/env node
'use strict';

const path = require('path');

const runtimeHelper = require(path.join(
  __dirname,
  '..',
  '..',
  'runtime',
  'lib',
  'legacy_retired_wrapper.js'
));

function laneIdFromCognitionPath(filePath) {
  const cognitionRoot = path.resolve(__dirname, '..');
  const rel = path
    .relative(cognitionRoot, filePath)
    .replace(/\\/g, '/')
    .replace(/\.[^.]+$/, '');
  return runtimeHelper.normalizeLaneId(`COGNITION-${rel}`, 'COGNITION-LEGACY-RETIRED');
}

function createCognitionModule(scriptDir, scriptName, laneId) {
  return runtimeHelper.createLegacyRetiredModule(
    scriptDir,
    scriptName,
    runtimeHelper.normalizeLaneId(laneId, 'COGNITION-LEGACY-RETIRED')
  );
}

module.exports = {
  createCognitionModule,
  laneIdFromCognitionPath,
  runAsMain: runtimeHelper.runAsMain
};
