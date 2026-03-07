#!/usr/bin/env node
'use strict';

const suite = require('../systems/cli/protheus_suite_tooling.js');
suite.runTool('mem', process.argv.slice(2));
