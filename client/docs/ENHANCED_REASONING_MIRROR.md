# Enhanced Reasoning Mirror

`V4-SCI-008`

## Purpose

Add calibration and uncertainty instrumentation to the reasoning mirror and provide one-click routing of suggested experiments through the consent-gated scheduler.

## Commands

```bash
node client/systems/science/enhanced_reasoning_mirror.js render --scientific-mode=1 --brier-score=0.18 --sample-size=300 --strict=1
node client/systems/science/enhanced_reasoning_mirror.js route-suggested --apply=1 --consent-map-file=state/science/experiment_scheduler/consent_map.json --strict=1
node client/systems/science/enhanced_reasoning_mirror.js status
```

## Contract Surface

- Calibration metrics: confidence, empirical accuracy, brier score, confidence gap, calibration band
- Uncertainty chart points across configurable confidence levels
- Disconfirming-evidence targets ("what would change my mind")
- Suggested experiment routing metadata with consent-aware scheduler handoff
- Receipt linkage to scientific loop + hypothesis receipts

## Policy

- `client/config/enhanced_reasoning_mirror_policy.json`
