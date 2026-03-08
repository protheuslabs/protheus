# Autopilot Strategy Selection

PQTS now supports enterprise-style strategy autopilot with human overrides.

## Modes

- `manual`: preserve current strategy toggles.
- `auto`: choose top-ranked strategies from deterministic scoring + AI recommendations.
- `hybrid`: preserve current set and fill with ranked candidates up to max capacity.

## Human Overrides

Overrides are applied **after** autopilot ranking:

- `include`: force-include strategy names.
- `exclude`: force-exclude strategy names.
- `replace_with`: fully replace autopilot output with explicit strategy list.

Risk controls remain hard-gated through `RiskAwareRouter` regardless of autopilot output.

## Configuration

`config/paper.yaml`:

```yaml
runtime:
  autopilot:
    mode: hybrid
    auto_apply_on_start: true
    min_active_strategies: 2
    max_active_strategies: 6
    ai_rank_weight: 1.25
    simple_strategy_allowlist:
      - trend_following
      - mean_reversion
      - swing_trend
      - hold_carry
```

## CLI usage

```bash
python main.py config/paper.yaml \
  --autopilot-mode auto \
  --autopilot-include mean_reversion \
  --autopilot-exclude ml
```

For a strict manual set:

```bash
python main.py config/paper.yaml \
  --autopilot-mode manual \
  --strategies trend_following,hold_carry
```
