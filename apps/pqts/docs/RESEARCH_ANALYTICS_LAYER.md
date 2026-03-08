# Research Analytics Layer

Last updated: 2026-03-04 (America/Denver)

## Purpose

Provide one canonical, machine-readable artifact per strategy run so research, execution analytics, promotion, and pilot attribution are auditable and comparable.

## Implemented Components

1. Canonical models:
- `research/analytics_models.py`
- Defines:
  - `DataLineage`
  - `ValidationSnapshot`
  - `ExecutionAnalyticsSnapshot`
  - `PromotionSnapshot`
  - `DecisionAttribution`
  - `StrategyAnalyticsReport`

2. Report builder:
- `research/report_builder.py`
- Responsibilities:
  - Build canonical report from AI agent result rows
  - Persist JSON artifacts under `data/research_reports/<experiment_id>/`
  - Compute report SHA-256
  - Log artifact metadata into research DB
  - Summarize TCA with optional regime-conditioned attribution

3. Experiment ledger extension:
- `research/database.py`
- Adds `analytics_reports` table and methods:
  - `log_report_artifact(...)`
  - `get_report_artifacts(...)`

4. Agent integration:
- `research/ai_agent.py`
- `research_cycle(...)` now emits canonical per-strategy report artifacts and returns:
  - `report["analytics"]["report_count"]`
  - `report["analytics"]["report_dir"]`
  - `report["analytics"]["reports"]` (path, hash, action, promotion flag)

5. Tests:
- `tests/test_research_analytics_layer.py`
- Verifies:
  - Canonical artifact persistence and DB logging
  - Agent cycle emits report artifacts
  - Regime-conditioned TCA summary behavior

6. Dashboard API:
- `analytics/research_api.py`
- Exposes deterministic, dashboard-facing accessors:
  - `get_stage_gate_health(...)`
  - `get_pilot_ab_metrics(...)`
  - `get_lineage_drilldown(experiment_id)`
- Uses `stage_metrics`, `promotion_audit`, and canonical report artifacts to provide measurable stage readiness, pilot-vs-control deltas, and provenance drilldowns.

7. Dashboard wiring:
- `dashboard/app.py`
- Strategy table now attempts to render real stage-gate strategy rows from `data/research.db` and falls back to deterministic demo rows when research data is unavailable.

8. Optional R validator bridge:
- Python bridge: `research/r_analytics_bridge.py`
- R script: `scripts/r/validate_experiment.R`
- Agent integration: `research/ai_agent.py`
- Behavior:
  - If `r_analytics.enabled=true`, the agent calls the R script on CV fold sharpes.
  - If `r_analytics.required=true`, promotion gates include `r_validator` and fail closed when R validation fails.
  - R outputs are attached to report `extras.r_analytics` for auditability.

Example config:
```yaml
r_analytics:
  enabled: true
  required: false
  rscript_bin: Rscript
  validator_script: scripts/r/validate_experiment.R
  min_cv_sharpe: 0.8
  bootstrap_samples: 2000
  timeout_seconds: 30
```

## Artifact Structure

Each report JSON includes:
1. Provenance (`lineage`): dataset window, symbols, config hash, code SHA
2. Validation (`validation`): backtest/CV/deflated Sharpe/PBO/walk-forward metrics
3. Execution (`execution`): TCA summary and optional regime breakdown
4. Promotion (`promotion`): stage state and gate checks
5. Decision (`decision`): action + rationale + supporting/counter evidence IDs
6. Objective (`objective`): feasibility and constraint assessment

## Operational Notes

1. Reports are append-only artifacts and are logged in DB for audit trails.
2. Promotion decisions remain gate-driven in agent logic; reports are explanatory and traceable, not authority overrides.
3. For pilot mode, attach `supporting_card_ids` and `counterevidence_card_ids` to decision attribution.
