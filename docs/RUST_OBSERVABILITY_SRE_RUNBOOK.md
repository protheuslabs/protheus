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
