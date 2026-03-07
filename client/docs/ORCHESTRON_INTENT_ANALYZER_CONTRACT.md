# Orchestron Intent Analyzer Contract

Status: active (`RM-010`)

Source implementation:
- `client/systems/workflow/orchestron/intent_analyzer.ts`
- `client/systems/workflow/orchestron/contracts.ts`

## Required Output Fields

`intent_analyzer` output must include:

1. `objective`
- Normalized, bounded objective text for candidate generation.

2. `constraints`
- `speed_weight`
- `robustness_weight`
- `cost_weight`
- Weights normalize to approximately `1.0`.

3. `uncertainty_band`
- One of: `low`, `medium`, `high`.

4. Trit-shaped risk signals
- `risk_signals.feasibility` in `{-1,0,1}`
- `risk_signals.risk` in `{-1,0,1}`
- `risk_signals.novelty` in `{-1,0,1}`
- `signals` remains as the canonical compatibility alias with the same trit values.

## CLI Contract

```bash
node client/systems/workflow/orchestron/intent_analyzer.js run --intent="..."
```

Response envelope:
- `ok: true`
- `type: "orchestron_intent"`
- `intent: <normalized_intent_contract>`

## Verification

```bash
node client/memory/tools/tests/orchestron_intent_analyzer.test.js
node client/systems/spine/contract_check.js
```
