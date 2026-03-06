#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-135
 * Pinnacle technology integration engine.
 */

const fs = require('fs');
const path = require('path');
const {
  readJson,
  appendJsonl,
  normalizeToken,
  stableHash,
  nowIso
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.PINNACLE_TECH_INTEGRATION_POLICY_PATH
  ? path.resolve(process.env.PINNACLE_TECH_INTEGRATION_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'pinnacle_tech_integration_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/research/pinnacle_tech_integration_engine.js configure --owner=<owner_id> [--adoption_mode=observe_only]');
  console.log('  node systems/research/pinnacle_tech_integration_engine.js scan [--class=crdt] [--risk-tier=2] [--approved=1]');
  console.log('  node systems/research/pinnacle_tech_integration_engine.js status [--owner=<owner_id>]');
}

function loadCatalog(policy: any) {
  const catalogPath = policy.research && policy.research.catalog_path
    ? String(policy.research.catalog_path)
    : '';
  const row = readJson(catalogPath, { classes: [] });
  const classes = Array.isArray(row && row.classes) ? row.classes : [];
  return {
    catalog_path: catalogPath,
    classes
  };
}

function scoreForClass(classId: string) {
  const raw = parseInt(stableHash(`pinnacle|${classId}`, 4), 16);
  return 50 + (raw % 50);
}

runStandardLane({
  lane_id: 'V3-RACE-135',
  script_rel: 'systems/research/pinnacle_tech_integration_engine.js',
  policy_path: POLICY_PATH,
  stream: 'research.pinnacle_tech',
  paths: {
    memory_dir: 'memory/research/preferences',
    adaptive_index_path: 'adaptive/research/preferences/index.json',
    events_path: 'state/research/pinnacle_tech/events.jsonl',
    latest_path: 'state/research/pinnacle_tech/latest.json',
    receipts_path: 'state/research/pinnacle_tech/receipts.jsonl',
    proposals_path: 'state/research/pinnacle_tech/proposals.jsonl'
  },
  usage,
  handlers: {
    scan(policy: any, args: any, ctx: any) {
      const catalog = loadCatalog(policy);
      const requestedClass = normalizeToken(args.class || args.tech_class || '', 120) || null;
      const selected = catalog.classes
        .filter((row: any) => !requestedClass || normalizeToken(row.id || '', 120) === requestedClass)
        .map((row: any) => ({
          class_id: normalizeToken(row.id || 'unknown', 120) || 'unknown',
          title: String(row.title || row.id || 'Untitled class').slice(0, 220),
          readiness: String(row.readiness || 'research').slice(0, 60),
          roi_score: scoreForClass(normalizeToken(row.id || 'unknown', 120) || 'unknown'),
          guardrails: Array.isArray(row.guardrails) ? row.guardrails.slice(0, 8) : []
        }))
        .slice(0, 16);
      if (selected.length < 1) {
        return {
          ok: false,
          error: 'no_matching_tech_classes',
          requested_class: requestedClass,
          catalog_path: catalog.catalog_path
        };
      }

      const ts = nowIso();
      const proposalsPath = String(policy.paths.proposals_path);
      fs.mkdirSync(path.dirname(proposalsPath), { recursive: true });
      for (const item of selected) {
        appendJsonl(proposalsPath, {
          ts,
          proposal_id: `pti_${stableHash(`${item.class_id}|${ts}`, 16)}`,
          lane_id: 'V3-RACE-135',
          type: 'pinnacle_integration_candidate',
          class_id: item.class_id,
          title: item.title,
          readiness: item.readiness,
          roi_score: item.roi_score,
          guardrails: item.guardrails,
          proposal_mode: 'governed_proposal_only'
        });
      }

      const record = ctx.cmdRecord(policy, {
        ...args,
        event: 'pinnacle_scan',
        payload_json: JSON.stringify({
          candidate_count: selected.length,
          classes: selected.map((row: any) => row.class_id),
          proposal_mode: 'governed_proposal_only',
          catalog_path: catalog.catalog_path
        })
      });
      if (!record.ok) return record;
      return {
        ...record,
        candidates: selected,
        artifacts: {
          ...(record.artifacts || {}),
          proposals_path: proposalsPath
        }
      };
    }
  }
});
