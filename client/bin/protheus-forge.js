#!/usr/bin/env node
'use strict';

const suite = require('../systems/cli/protheus_suite_tooling.js');
suite.runTool('forge', process.argv.slice(2));
