"""Dashboard-facing helpers for revenue diagnostics."""

from __future__ import annotations

from typing import Any, Dict

from analytics.revenue_diagnostics import RevenueDiagnostics


def get_revenue_diagnostics_payload(
    *,
    tca_db_path: str = "data/tca_records.csv",
    lookback_days: int = 30,
    limit: int = 25,
) -> Dict[str, Any]:
    diagnostics = RevenueDiagnostics(tca_db_path=tca_db_path)
    return diagnostics.payload(lookback_days=lookback_days, limit=limit)


def get_revenue_kpis(
    *,
    tca_db_path: str = "data/tca_records.csv",
    lookback_days: int = 30,
) -> Dict[str, Any]:
    diagnostics = RevenueDiagnostics(tca_db_path=tca_db_path)
    summary = diagnostics.summary(lookback_days=lookback_days)
    return {
        "lookback_days": int(lookback_days),
        "trades": int(summary.get("trades", 0)),
        "notional_usd": float(summary.get("notional_usd", 0.0)),
        "estimated_realized_pnl_usd": float(summary.get("estimated_realized_pnl_usd", 0.0)),
        "avg_realized_net_alpha_bps": float(summary.get("avg_realized_net_alpha_bps", 0.0)),
        "ci95_lower_realized_net_alpha_bps": float(
            summary.get("ci95_lower_realized_net_alpha_bps", 0.0)
        ),
        "slippage_mape_pct": float(summary.get("slippage_mape_pct", 0.0)),
    }
