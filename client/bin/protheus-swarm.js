#!/usr/bin/env node
'use strict';

const suite = require('../systems/cli/protheus_suite_tooling.js');
suite.runTool('swarm', process.argv.slice(2));
