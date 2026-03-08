# Incident Runbook

## Scope
This runbook covers production paper/live incidents for:
- Kill-switch transitions (`HALT`, `FLATTEN`)
- Slippage drift (`MAPE`, `p95 slippage`)
- Venue reliability degradation
- Elevated reject-rate and calibration alerts

## Alert Sources
- `scripts/run_paper_campaign.py` snapshot fields:
  - `ops_health.alerts`
  - `ops_health.summary`
  - `promotion_gate.decision`
  - `reliability`
- `scripts/daily_paper_ops.py` return code:
  - `3`: readiness gate failed with `--require-ready`
  - `4`: critical ops alerts with `--require-no-critical-alerts`

## Severity Matrix
- `critical`:
  - `reject_rate` breach
  - `p95_slippage_bps` breach
  - `slippage_mape_pct` breach
  - `degraded_venues` breach
- `warning`:
  - `readiness` false
  - `calibration_alerts` above threshold

## Response Playbooks
1. `HALT` / `FLATTEN` active:
   - Stop strategy promotion immediately.
   - Confirm no new orders are admitted via `RiskAwareRouter.submit_order()`.
   - Verify cancelled/open orders and persisted shutdown state.
   - Root-cause before reset.
2. Slippage drift critical:
   - Run weekly eta calibration immediately.
   - Reduce per-symbol notional caps by 30-50%.
   - Enable strict paper stress mode and re-evaluate 24h.
3. Degraded venue(s):
   - Remove degraded venues from active routing set.
   - Force failover target validation with small probe notional.
   - Keep venue disabled until `degraded=0` for 3 consecutive windows.
4. Reject-rate critical:
   - Cut order frequency and notional.
   - Inspect reject reason mix (`POSITION_LIMIT`, `DEGRADED_VENUE`, `NO_FILL`, etc.).
   - Do not re-enable full flow until reject-rate normalizes.

## Escalation
- Critical alerts:
  - Immediate response (SRE on-call).
  - Promotion gate hard-block (`remain_in_paper` or `reject_or_research`).
- Warning alerts:
  - Investigate within same trading day.
  - Do not promote while warnings persist for >5 consecutive daily cycles.

## Post-Incident Requirements
- Update incident timeline and cause in ops log.
- Add or tighten deterministic regression tests for discovered failure mode.
- If loss event occurred, run staged canary replay before resuming.
