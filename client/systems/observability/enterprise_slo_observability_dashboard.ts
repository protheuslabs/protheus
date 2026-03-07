#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-041
 * Enterprise SLO and Observability Command Dashboard
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.ENTERPRISE_SLO_OBSERVABILITY_DASHBOARD_POLICY_PATH
  ? path.resolve(process.env.ENTERPRISE_SLO_OBSERVABILITY_DASHBOARD_POLICY_PATH)
  : path.join(ROOT, 'config/enterprise_slo_observability_dashboard_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-041',
  title: 'Enterprise SLO and Observability Command Dashboard',
  type: 'enterprise_slo_observability_dashboard',
  default_action: 'slo',
  script_label: 'systems/observability/enterprise_slo_observability_dashboard.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "slo_contract_definitions",
        "description": "SLO definitions and burn rules are configured"
    },
    {
        "id": "otel_default_profiles",
        "description": "OpenTelemetry defaults configured for logs/metrics/traces"
    },
    {
        "id": "burn_alert_routes",
        "description": "Burn alert routes and severities configured"
    },
    {
        "id": "runbook_auto_generation",
        "description": "Runbook generation from incident signatures enabled"
    }
],
    paths: {
      state_path: 'state/observability/enterprise_slo_observability_dashboard/state.json',
      latest_path: 'state/observability/enterprise_slo_observability_dashboard/latest.json',
      receipts_path: 'state/observability/enterprise_slo_observability_dashboard/receipts.jsonl',
      history_path: 'state/observability/enterprise_slo_observability_dashboard/history.jsonl'
    }
  }
});
