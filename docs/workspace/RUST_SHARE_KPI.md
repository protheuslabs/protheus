# Rust Share KPI Contract

Canonical metric source for migration progress is:

```bash
bash scripts/metrics/tracked_loc_report.sh --ref=HEAD
```

Definition:
- Scope: tracked `*.rs`, `*.ts`, `*.js` files at the selected git ref.
- Metric: `rust_share_pct = rs_lines / (rs_lines + ts_lines + js_lines) * 100`.
- CI artifact: `.github/workflows/rust-share-kpi.yml` uploads `core/local/artifacts/rust_share/tracked_loc_report.json` on push/PR.

PR delta mode:

```bash
bash scripts/metrics/tracked_loc_report.sh --ref=HEAD --base-ref=origin/main
```

This report is the required source for Rust-share discussions and coreization milestone checks.
