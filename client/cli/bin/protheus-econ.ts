#!/usr/bin/env node
'use strict';

const suite = require('../../lib/protheus_suite_tooling.ts');
suite.runTool('econ', process.argv.slice(2));
