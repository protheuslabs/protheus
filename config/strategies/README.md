# Strategy Profiles

Purpose: keep specialized objective/risk policy out of `systems/` code.

Each `*.json` here is declarative policy consumed by generic controllers.

## Minimal Shape

```json
{
  "version": "1.0",
  "id": "default_general",
  "name": "Default General Strategy",
  "status": "active",
  "objective": { "primary": "...", "fitness_metric": "verified_progress_rate", "target_window_days": 14 },
  "campaigns": [
    {
      "id": "objective_flow",
      "status": "active",
      "priority": 20,
      "phases": [
        { "id": "discover", "status": "active", "order": 1, "priority": 70, "proposal_types": ["external_intel"] },
        { "id": "stabilize", "status": "active", "order": 2, "priority": 60, "proposal_types": ["collector_remediation"] }
      ]
    }
  ],
  "risk_policy": { "allowed_risks": ["low"], "max_risk_per_action": 35 },
  "admission_policy": { "allowed_types": [], "blocked_types": [], "max_remediation_depth": 2, "duplicate_window_hours": 24 },
  "ranking_weights": { "composite": 0.35, "actionability": 0.2, "directive_fit": 0.15, "signal_quality": 0.15, "expected_value": 0.1, "risk_penalty": 0.05 },
  "value_currency_policy": {
    "default_currency": "revenue",
    "currency_overrides": {
      "revenue": { "ranking_weights": { "expected_value": 0.14, "time_to_value": 0.06 } }
    },
    "objective_overrides": {
      "T1_make_jay_billionaire_v1": {
        "primary_currency": "revenue",
        "ranking_weights": { "expected_value": 0.16, "risk_penalty": 0.03 }
      }
    }
  },
  "budget_policy": {
    "daily_runs_cap": 4,
    "daily_token_cap": 4000,
    "max_tokens_per_action": 1600,
    "token_cost_per_1k": 0.003,
    "daily_usd_cap": 3.5,
    "per_action_avg_usd_cap": 1.0,
    "monthly_usd_allocation": 60,
    "monthly_credits_floor_pct": 0.15,
    "min_projected_tokens_for_burn_check": 800
  },
  "exploration_policy": { "fraction": 0.25, "every_n": 3, "min_eligible": 3 },
  "stop_policy": { "circuit_breakers": { "http_429_cooldown_hours": 12 } },
  "promotion_policy": { "min_days": 7, "min_attempted": 12, "min_verified_rate": 0.5, "max_reverted_rate": 0.35, "max_stop_ratio": 0.75, "min_shipped": 1 },
  "execution_policy": { "mode": "score_only" },
  "threshold_overrides": {}
}
```

## Selection Rules

1. `AUTONOMY_STRATEGY_ID=<id>` if provided.
2. Otherwise first `status: "active"` profile by filename sort.
3. If none found, controllers fall back to env/default thresholds.

## Notes

- Put use-case/domain-specific strategy logic here.
- Keep `systems/` broadly reusable and strategy-agnostic.
- Keep platform specifics in `skills/` and high-churn shortcuts in `habits/`.
- Recommended rollout: start with `execution_policy.mode = "score_only"` and switch to `"execute"` only after observed stable scorecards.
- Runtime enforcement now uses:
  - `risk_policy.max_risk_per_action` as an admission cap (0-100 risk score scale)
  - `admission_policy.duplicate_window_hours` to suppress rapid retries of equivalent proposal keys
  - `budget_policy` USD fields for Tier-1 cost governor (env vars still override if explicitly set)
  - `admission_policy.blocked_types` for manual-only proposal types (example: `human_escalation`)
- Value-currency propagation:
  - `value_currency_policy.default_currency` sets fallback success currency when proposal signals are neutral.
  - `value_currency_policy.currency_overrides.<currency>.ranking_weights` applies objective-conditioned ranking overlays.
  - `value_currency_policy.objective_overrides.<objective_id>` can force objective-specific currency and ranking weights.
- Strict validation blocks profiles with contradictory admission lists (`allowed_types` intersect `blocked_types`) or invalid promotion policy (`min_shipped > min_attempted`).
- Strategy lifecycle grading can be generated via:
  - `node systems/strategy/strategy_learner.js run [YYYY-MM-DD] --days=14`
  - Output defaults to `state/adaptive/strategy/scorecards/` with stages: `theory -> trial -> validated -> scaled`.
- Campaign scheduling (v1):
  - Optional `campaigns[]` lets strategy profiles prioritize proposal sequencing by campaign phase before flat ranking.
  - Matching keys are phase/campaign `proposal_types`, `source_eyes`, `tags`, and optional `objective_id`.
  - Scheduler is additive: unmatched proposals still flow through normal ranking/gates.
