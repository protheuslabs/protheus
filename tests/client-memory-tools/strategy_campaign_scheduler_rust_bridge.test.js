#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

if (!require.extensions['.ts']) {
  require.extensions['.ts'] = function compileTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true
      },
      fileName: filename,
      reportDiagnostics: false
    }).outputText;
    module._compile(transpiled, filename);
  };
}

const ROOT = path.resolve(__dirname, '../..');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function main() {
  process.env.PROTHEUS_OPS_USE_PREBUILT = '0';
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = '120000';
  const mod = resetModule(path.join(ROOT, 'client', 'lib', 'strategy_campaign_scheduler.ts'));

  const strategy = {
    campaigns: [
      {
        id: 'Objective Flow',
        name: 'Objective Flow',
        status: 'active',
        priority: 20,
        objective_id: 'OBJ-1',
        proposal_types: ['strategy'],
        phases: [
          {
            id: 'stabilize',
            name: 'stabilize',
            status: 'active',
            order: 1,
            priority: 10,
            proposal_types: ['infrastructure_outage'],
            source_eyes: ['health'],
            tags: ['ops']
          }
        ]
      }
    ]
  };

  const campaigns = mod.normalizeCampaigns(strategy);
  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0].phases.length, 1);

  const candidates = [{
    proposal: {
      type: 'infrastructure_outage',
      meta: { source_eye: 'health', objective_id: 'OBJ-1', tags: ['ops'] },
      tags: ['ops']
    }
  }];
  const summary = mod.annotateCampaignPriority(candidates, strategy);
  assert.equal(summary.enabled, true);
  assert.equal(summary.matched_count, 1);
  assert.equal(candidates[0].campaign_match.campaign_id, 'objective flow');

  const plan = mod.buildCampaignDecompositionPlans([], strategy, {
    max_additions: 1,
    min_open_per_type: 1,
    default_risk: 'low',
    default_impact: 'medium'
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.additions.length, 1);
  assert.match(plan.additions[0].title, /^\[Campaign]/);

  console.log(JSON.stringify({ ok: true, type: 'strategy_campaign_scheduler_rust_bridge_test' }));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
