#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;

function planHunterActions(sentinel: AnyObj = {}, policy: AnyObj = {}) {
  const shadowOnly = policy && policy.shadow_only !== false;
  const tier = String(sentinel && sentinel.tier || 'clear');
  const actions: AnyObj[] = [];
  if (tier === 'clear') {
    actions.push({
      action: 'observe_only',
      mode: 'telemetry',
      apply: false
    });
  } else if (tier === 'stasis') {
    actions.push({
      action: 'freeze_high_risk_lanes',
      mode: shadowOnly ? 'shadow' : 'active',
      apply: !shadowOnly
    });
    actions.push({
      action: 'isolate_tampered_strands',
      mode: shadowOnly ? 'shadow' : 'active',
      apply: !shadowOnly
    });
  } else {
    actions.push({
      action: 'freeze_all_actuation',
      mode: shadowOnly ? 'shadow' : 'active',
      apply: !shadowOnly
    });
    actions.push({
      action: 'isolate_instance_perimeter',
      mode: shadowOnly ? 'shadow' : 'active',
      apply: !shadowOnly
    });
    actions.push({
      action: 'trigger_controlled_unravel',
      mode: shadowOnly ? 'shadow' : 'active',
      apply: !shadowOnly
    });
  }
  return {
    ok: true,
    tier,
    shadow_only: shadowOnly,
    actions
  };
}

module.exports = {
  planHunterActions
};
