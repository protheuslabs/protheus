#!/usr/bin/env node
/**
 * Test skill with direct exec (to trigger runtime warning)
 */

const { execSync } = require('child_process');

// This should trigger the runtime warning
const result = execSync('echo "Direct exec test"', { encoding: 'utf8' });
console.log(result);