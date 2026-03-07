#!/usr/bin/env node
'use strict';

const suite = require('../systems/cli/protheus_suite_tooling.js');
suite.runTool('redlegion', process.argv.slice(2));
