# PQTS Agent Operating Instructions

This file defines how an AI pilot should use the PQTS knowledge base and how to pilot strategy promotion safely.

## Scope

Applies to:
- Research/promotion decisions
- Paper/canary/live stage transitions
- Pilot-vs-autopilot challenger operation

Does not override hard execution/risk controls already enforced in code.

## Hard Safety Rules (Non-Bypassable)

1. The only order entry path is `execution.RiskAwareRouter.submit_order()`.
2. Do not instantiate or call exchange adapters directly outside router paths.
3. Respect all kill-switch and risk limits; never override drawdown/leverage/loss limits.
4. If a proposed pilot action conflicts with hard gates, reject the action and log the rejection.

## Knowledge Base: Required Inputs

Primary references:
- `docs/AGENT_PILOT_CORPUS_AND_AB.md`
- `research/agent_corpus_schema.json`
- `research/agent_corpus_card_example.json`

Use only schema-valid knowledge cards for pilot decisions.

## Knowledge Card Workflow

1. Create or update cards with all required fields from `research/agent_corpus_schema.json`.
2. Ensure each card includes:
- Falsifiable claim
- Evidence with OOS/deflated Sharpe/cost realism
- Decision rules and risk constraints
- Failure modes and boundaries (regime/venue/symbol)
3. Compute card quality and retrieve only cards with:
- `quality.quality_score >= quality.min_quality_for_retrieval`
- Recommended default threshold: `0.65`
4. Prefer recent, replicated evidence over single-window results.

## Pilot Decision Contract

Pilot may propose only:
1. `promote_to_paper`
2. `promote_to_live_canary`
3. `promote_to_live`
4. `hold`
5. `demote`
6. `kill`

Every proposal must include:
1. `action`
2. `strategy_id`
3. `rationale`
4. `supporting_card_ids`
5. `current_metrics`
6. `gate_checks`
7. `risk_impact`

If any required field is missing, treat decision as invalid.

## Required Context Assembly Before Decision

Build prompt context in this order:
1. `SYSTEM_FACTS`:
- hard safety rules, risk limits, stage-gate policy
2. `CURRENT_STATE`:
- latest metrics, stage summaries, slippage drift, kill-switch state
3. `RELEVANT_CARDS`:
- top-K cards by strategy+regime+venue (quality threshold enforced)
4. `COUNTEREVIDENCE`:
- cards that contradict the preferred action
5. `DECISION_TEMPLATE`:
- strict structured output fields from the Pilot Decision Contract

## Stage Promotion Rules

Follow stage gates from research logic and documented protocol:
1. Backtest -> Paper:
- requires OOS + walk-forward + overfit controls
2. Paper -> Live Canary:
- requires minimum paper duration and slippage/kill-switch thresholds
3. Live Canary -> Live:
- requires canary stability and no hard-limit violations

Never skip stages.

## Pilot A/B Operation (Challenger Mode)

Run pilot against autopilot under equal risk budget:
1. Control: autopilot-only gate decisions
2. Treatment: autopilot + pilot recommendations

Track at least:
1. Net OOS Sharpe differential
2. Net PnL after realistic costs
3. False-promotion rate
4. Slippage MAPE and kill-switch frequency

Do not make pilot default unless acceptance criteria in `docs/AGENT_PILOT_CORPUS_AND_AB.md` are met.

## Daily Operator Checklist

1. Validate new/changed cards against `research/agent_corpus_schema.json`.
2. Review slippage drift and kill-switch events.
3. Review active canary strategies for gate breaches.
4. Reject and log any pilot recommendation that violates hard rules.

## Weekly Operator Checklist

1. Recompute card quality scores.
2. Archive stale/deprecated cards.
3. Re-run stage-gate summaries for active paper/canary strategies.
4. Compare pilot vs control metrics and update challenger status.

