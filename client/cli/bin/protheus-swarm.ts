#!/usr/bin/env node
'use strict';

const suite = require('../../lib/protheus_suite_tooling.ts');
suite.runTool('swarm', process.argv.slice(2));
