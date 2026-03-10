#!/usr/bin/env node
'use strict';

// Layer ownership: apps/habits/routines (authoritative)
// Thin compatibility wrapper only.
module.exports = require("../../../../apps/habits/routines/safe_cron_swap.js");
