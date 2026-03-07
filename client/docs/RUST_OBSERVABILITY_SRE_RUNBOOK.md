# Rust Observability & SRE Runbook

## Parity Requirements
- Rust and TS lanes must emit equivalent service, route, lane_id, and error taxonomy fields.
- All Rust cutovers must preserve trace/span correlation with existing control-plane identifiers.

## Incident Workflow
1. Detect regression in p95/p99/error-budget dashboards.
2. Switch rollout flag to previous stable profile.
3. Capture rollback receipt and incident timeline.
4. Re-open lane only after benchmark and parity receipts pass.

## Mandatory Drills
- Quarterly rollback drill per migrated Rust lane.
- Monthly telemetry-parity verification between TS and Rust paths.

## Baseline SLOs
- Spine success rate: `>=99.9%` (rolling 30d)
- Deterministic receipt latency: `<100ms p95` for local lanes
- Conduit hosted roundtrip: `<5ms` average
- Conduit embedded/stdin roundtrip: `<20ms`
- Cron delivery integrity: `100%` enabled isolated jobs with valid announce delivery (no `mode=none`)

## Mandatory Health Commands
- `protheus-ops status --dashboard`
- `protheus-ops contract-check`
- `npm run -s formal:invariants:run`

## Alerting Contract
- Any `cron_delivery_integrity != pass` is treated as sev-2.
- Any `rust_source_of_truth != pass` is treated as sev-1.
- Any conduit budget violation (`>10` bridge message types) is fail-closed and sev-1.
