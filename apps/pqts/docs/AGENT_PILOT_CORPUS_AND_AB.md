# Agent Pilot Corpus + A/B Protocol

Last updated: 2026-03-04 (America/Denver)

## Goal

Turn PQTS pilot mode into a measurable research/execution advantage:
- Better candidate selection and promotion decisions
- Lower live degradation (simulation gap)
- No bypass of existing hard risk/execution controls

This document defines:
1. A strict corpus format the agent can query
2. A decision contract for pilot actions
3. A 60-90 day A/B protocol to measure pilot alpha vs autopilot

## 1) Corpus Design (What the Agent Reads)

### Corpus Unit: Knowledge Card

Use one canonical card type for all agent context. JSON schema lives at:
- `research/agent_corpus_schema.json`

Each card is a falsifiable claim with hard evidence and operational boundaries.

Required card elements:
1. Claim: one-line statement of expected edge or risk relationship
2. Evidence: backtest IDs, date range, OOS windows, cost assumptions
3. Boundaries: regime, symbols, venues, liquidity, turnover, latency
4. Decision rule: exact if/then thresholds for promote/hold/kill
5. Failure modes: how the edge breaks and early warning metrics

### Corpus Buckets

Store cards by bucket to keep retrieval deterministic:
1. `microstructure`: spread/depth/imbalance/toxicity behaviors
2. `execution`: slippage, fill ratio, venue routing, queue dynamics
3. `strategy`: per-strategy rules, parameter envelopes, anti-patterns
4. `risk`: drawdown controls, capacity limits, leverage limits
5. `regime`: trend/range/high-vol/low-liq regime behavior
6. `ops`: incident runbooks and canary rollback triggers

### Card Quality Score

Score each card from 0.0 to 1.0 and only retrieve cards above threshold:
- `quality_score = 0.35*replication + 0.25*oos_strength + 0.20*data_quality + 0.20*recency`

Definitions:
1. `replication`: reproduced across datasets or periods
2. `oos_strength`: walk-forward + purged CV + deflated Sharpe robustness
3. `data_quality`: fill realism, fee/slippage coverage, no leakage
4. `recency`: days since last validation with decay

Recommended retrieval cutoff:
- `quality_score >= 0.65`

## 2) Pilot Decision Contract (What the Agent Is Allowed To Do)

The agent can propose only these actions:
1. `promote_to_paper`
2. `promote_to_live_canary`
3. `promote_to_live`
4. `hold`
5. `demote`
6. `kill`

Every proposal must include:
1. Action
2. Strategy ID
3. Quant rationale with card IDs
4. Current metrics snapshot
5. Gate check results (pass/fail by rule)
6. Risk impact estimate

Hard constraints:
1. Order flow still enters only via `RiskAwareRouter.submit_order`
2. Existing kill switches remain authoritative
3. No decision can override risk caps, drawdown caps, or token gating

## 3) Retrieval Contract (Prompt Context Structure)

At inference time, feed context in fixed blocks:
1. `SYSTEM_FACTS`: hard rules (risk, CI, router constraints)
2. `CURRENT_STATE`: latest strategy metrics and stage summaries
3. `RELEVANT_CARDS`: top-K high-quality cards by regime + strategy + venue
4. `COUNTEREVIDENCE`: cards that contradict current proposal
5. `DECISION_TEMPLATE`: required output JSON schema

Output format should be machine-validated before any action is accepted.

## 4) A/B Protocol: Pilot vs Autopilot (60-90 Days)

### Experiment Design

Two arms under identical risk budget:
1. Control: autopilot (existing deterministic gates only)
2. Treatment: autopilot + agent pilot recommendations

Blocking dimensions:
1. Strategy family
2. Venue
3. Regime state
4. Notional bucket

Randomization unit:
- Candidate promotion decision event (or strategy-day if decisions are sparse)

### Sample and Horizon

Minimum horizon:
1. 60 days for early signal
2. 90 days for decision quality

Minimum sample:
- At least 40 promotion decision events per arm

### Primary Endpoints

1. Net OOS Sharpe differential
2. Net PnL after realistic costs
3. False-promotion rate:
- `FP = promoted strategies that violate canary/live gate within 30 days`

### Secondary Endpoints

1. Max drawdown
2. Slippage MAPE
3. Kill-switch trigger count
4. Promotion-to-kill latency
5. Simulation gap:
- `sim_gap = realized_metric - expected_metric`

### Statistical Tests

Use robust non-parametric stats:
1. Paired bootstrap CI on daily return spread (Treatment - Control)
2. Mann-Whitney U for non-normal endpoint distributions
3. Difference in false-promotion proportions with Wilson interval

Do not accept pilot uplift without confidence interval support.

### Acceptance Criteria (Promote Pilot to Default)

Require all:
1. Primary Sharpe uplift > 0 with 95% CI lower bound > 0
2. False-promotion rate not worse than control by more than 2 percentage points
3. No increase in kill-switch frequency greater than 10%
4. No breach of hard risk controls

If any fail, keep pilot as challenger only.

## 5) Operational Runbook

Weekly cadence:
1. Recompute card quality scores
2. Archive stale cards beyond recency SLA
3. Re-run drift checks on slippage/fill metrics
4. Refit retrieval index with updated metadata

Incident policy:
1. If pilot recommends action violating a hard gate, auto-reject and log
2. If pilot recommendations correlate with rising drawdown, disable pilot actions and keep monitoring-only mode

## 6) Implementation Checklist

1. Add corpus store with schema validation at write time
2. Add retrieval index using card metadata filters first, embeddings second
3. Add decision validation layer before stage transitions
4. Add A/B assignment service and immutable event log
5. Add experiment dashboard with endpoints above

## 7) Suggested Initial Targets

Initial pilot win conditions over first 90 days:
1. +0.20 Sharpe vs control
2. >=20% reduction in false promotions
3. <=10% increase in turnover-adjusted cost drag
4. Zero hard-control bypass incidents
