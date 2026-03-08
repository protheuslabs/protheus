"""PnL truth ledger derived from realized TCA records."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Tuple

import pandas as pd

from execution.tca_feedback import TCADatabase


@dataclass(frozen=True)
class StrategyDisableDecision:
    strategy_id: str
    net_alpha_usd: float
    trades: int

    def to_dict(self) -> Dict[str, float | int | str]:
        return {
            "strategy_id": str(self.strategy_id),
            "net_alpha_usd": float(self.net_alpha_usd),
            "trades": int(self.trades),
        }


@dataclass(frozen=True)
class ScopeDisableDecision:
    scope: str
    strategy_id: str
    exchange: str
    symbol: str
    net_alpha_usd: float
    trades: int

    def to_dict(self) -> Dict[str, float | int | str]:
        payload: Dict[str, float | int | str] = {
            "scope": str(self.scope),
            "strategy_id": str(self.strategy_id),
            "net_alpha_usd": float(self.net_alpha_usd),
            "trades": int(self.trades),
        }
        if self.exchange:
            payload["exchange"] = str(self.exchange)
        if self.symbol:
            payload["symbol"] = str(self.symbol)
        return payload


def _recent_frame(tca_db: TCADatabase, lookback_days: int) -> pd.DataFrame:
    frame = tca_db.as_dataframe()
    if frame.empty:
        return frame
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(int(lookback_days), 0))
    timestamps = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
    return frame[timestamps >= cutoff].copy()


def build_pnl_truth_ledger(
    tca_db: TCADatabase,
    *,
    lookback_days: int = 30,
) -> Tuple[Dict[str, float | int], List[Dict[str, float | int | str]]]:
    """
    Build strategy@venue PnL truth rows with explicit decomposition:
    gross alpha, commission cost, slippage cost, net alpha.
    """
    frame = _recent_frame(tca_db, lookback_days)
    if frame.empty:
        return (
            {
                "lookback_days": int(lookback_days),
                "trades": 0,
                "gross_alpha_usd": 0.0,
                "commission_cost_usd": 0.0,
                "slippage_cost_usd": 0.0,
                "net_alpha_usd": 0.0,
            },
            [],
        )

    out = frame.copy()
    out["strategy_id"] = out["strategy_id"].fillna("unknown").astype(str)
    out["exchange"] = out["exchange"].fillna("unknown").astype(str)
    out["symbol"] = out["symbol"].fillna("unknown").astype(str)
    out["notional"] = pd.to_numeric(out["notional"], errors="coerce").fillna(0.0)
    out["expected_alpha_bps"] = pd.to_numeric(out["expected_alpha_bps"], errors="coerce").fillna(
        0.0
    )
    out["realized_commission_bps"] = pd.to_numeric(
        out["realized_commission_bps"], errors="coerce"
    ).fillna(0.0)
    out["realized_slippage_bps"] = pd.to_numeric(
        out["realized_slippage_bps"], errors="coerce"
    ).fillna(0.0)

    out["gross_alpha_usd"] = out["notional"] * out["expected_alpha_bps"] / 10000.0
    out["commission_cost_usd"] = out["notional"] * out["realized_commission_bps"] / 10000.0
    out["slippage_cost_usd"] = out["notional"] * out["realized_slippage_bps"] / 10000.0
    out["net_alpha_usd"] = (
        out["gross_alpha_usd"] - out["commission_cost_usd"] - out["slippage_cost_usd"]
    )

    grouped = (
        out.groupby(["strategy_id", "exchange", "symbol"], as_index=False)
        .agg(
            trades=("trade_id", "count"),
            notional_usd=("notional", "sum"),
            gross_alpha_usd=("gross_alpha_usd", "sum"),
            commission_cost_usd=("commission_cost_usd", "sum"),
            slippage_cost_usd=("slippage_cost_usd", "sum"),
            net_alpha_usd=("net_alpha_usd", "sum"),
        )
        .sort_values(["net_alpha_usd", "trades"], ascending=[False, False])
    )
    rows = [
        {
            "strategy_id": str(row["strategy_id"]),
            "exchange": str(row["exchange"]),
            "symbol": str(row["symbol"]),
            "trades": int(row["trades"]),
            "notional_usd": float(row["notional_usd"]),
            "gross_alpha_usd": float(row["gross_alpha_usd"]),
            "commission_cost_usd": float(row["commission_cost_usd"]),
            "slippage_cost_usd": float(row["slippage_cost_usd"]),
            "net_alpha_usd": float(row["net_alpha_usd"]),
        }
        for _, row in grouped.iterrows()
    ]
    summary = {
        "lookback_days": int(lookback_days),
        "trades": int(len(out)),
        "gross_alpha_usd": float(out["gross_alpha_usd"].sum()),
        "commission_cost_usd": float(out["commission_cost_usd"].sum()),
        "slippage_cost_usd": float(out["slippage_cost_usd"].sum()),
        "net_alpha_usd": float(out["net_alpha_usd"].sum()),
    }
    return summary, rows


def detect_negative_net_alpha_strategies(
    strategy_venue_rows: List[Dict[str, float | int | str]],
    *,
    min_trades: int = 50,
    max_net_alpha_usd: float = 0.0,
) -> List[StrategyDisableDecision]:
    """
    Return strategy disable decisions when rolling net alpha is negative.
    """
    by_strategy: Dict[str, Dict[str, float]] = {}
    for row in strategy_venue_rows:
        strategy_id = str(row.get("strategy_id", "unknown"))
        bucket = by_strategy.setdefault(
            strategy_id,
            {
                "trades": 0.0,
                "net_alpha_usd": 0.0,
            },
        )
        bucket["trades"] += float(row.get("trades", 0))
        bucket["net_alpha_usd"] += float(row.get("net_alpha_usd", 0.0))

    decisions: List[StrategyDisableDecision] = []
    for strategy_id, metrics in sorted(by_strategy.items()):
        trades = int(metrics["trades"])
        net_alpha = float(metrics["net_alpha_usd"])
        if trades < int(min_trades):
            continue
        if net_alpha <= float(max_net_alpha_usd):
            decisions.append(
                StrategyDisableDecision(
                    strategy_id=strategy_id,
                    net_alpha_usd=net_alpha,
                    trades=trades,
                )
            )
    return decisions


def detect_negative_net_alpha_scopes(
    strategy_venue_symbol_rows: List[Dict[str, float | int | str]],
    *,
    min_trades: int = 50,
    max_net_alpha_usd: float = 0.0,
    include_strategy_venue: bool = True,
    include_strategy_symbol: bool = True,
    include_strategy_venue_symbol: bool = True,
) -> Dict[str, List[ScopeDisableDecision]]:
    """
    Return scoped negative-net-alpha disable decisions for finer-grained quarantine.
    """
    out: Dict[str, List[ScopeDisableDecision]] = {
        "strategy_venues": [],
        "strategy_symbols": [],
        "strategy_venue_symbols": [],
    }
    rows = [dict(row) for row in strategy_venue_symbol_rows if isinstance(row, dict)]
    if not rows:
        return out

    frame = pd.DataFrame(rows)
    if frame.empty:
        return out
    for column in ("strategy_id", "exchange", "symbol"):
        if column not in frame.columns:
            frame[column] = "unknown"
        frame[column] = frame[column].fillna("unknown").astype(str)
    for column in ("trades", "net_alpha_usd"):
        if column not in frame.columns:
            frame[column] = 0.0
        frame[column] = pd.to_numeric(frame[column], errors="coerce").fillna(0.0)

    def _collect(group_keys: List[str], scope: str) -> List[ScopeDisableDecision]:
        grouped = (
            frame.groupby(group_keys, as_index=False)
            .agg(trades=("trades", "sum"), net_alpha_usd=("net_alpha_usd", "sum"))
            .sort_values(["net_alpha_usd", "trades"], ascending=[True, False])
        )
        decisions: List[ScopeDisableDecision] = []
        for _, row in grouped.iterrows():
            trades = int(row["trades"])
            net_alpha = float(row["net_alpha_usd"])
            if trades < int(min_trades) or net_alpha > float(max_net_alpha_usd):
                continue
            decisions.append(
                ScopeDisableDecision(
                    scope=scope,
                    strategy_id=str(row.get("strategy_id", "unknown")),
                    exchange=(
                        str(row.get("exchange", "unknown")) if "exchange" in group_keys else ""
                    ),
                    symbol=(str(row.get("symbol", "unknown")) if "symbol" in group_keys else ""),
                    net_alpha_usd=net_alpha,
                    trades=trades,
                )
            )
        return decisions

    if include_strategy_venue:
        out["strategy_venues"] = _collect(["strategy_id", "exchange"], "strategy_venue")
    if include_strategy_symbol:
        out["strategy_symbols"] = _collect(["strategy_id", "symbol"], "strategy_symbol")
    if include_strategy_venue_symbol:
        out["strategy_venue_symbols"] = _collect(
            ["strategy_id", "exchange", "symbol"], "strategy_venue_symbol"
        )
    return out
