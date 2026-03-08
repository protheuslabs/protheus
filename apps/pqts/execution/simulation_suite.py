"""Deterministic simulation-suite runner with telemetry and optimization artifacts."""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

import numpy as np
import yaml

from analytics.ops_health import OpsThresholds, evaluate_operational_health
from analytics.promotion_gates import PromotionGateThresholds, evaluate_promotion_gate
from analytics.simulation_telemetry import SimulationTelemetryStore
from core.mechanism_switches import apply_mechanism_switches
from execution.paper_campaign import (
    CampaignStats,
    build_portfolio_snapshot,
    build_probe_order,
    iter_cycle_symbols,
    select_symbol_price,
)
from execution.paper_fill_model import MicrostructurePaperFillProvider, PaperFillModelConfig
from execution.risk_aware_router import RiskAwareRouter
from execution.smart_router import OrderType
from risk.kill_switches import RiskLimits
from risk.risk_tolerance import (
    resolve_effective_risk_config,
    risk_profile_payload,
)


@dataclass(frozen=True)
class SimulationScenario:
    """One market/strategy scenario to execute through the simulation suite."""

    market: str
    strategy: str
    symbols: List[str]
    cycles: int
    notional_usd: float


class SimulationSuiteRunner:
    """Run paper-execution simulations across market/strategy scenarios."""

    def __init__(
        self,
        *,
        config_path: str = "config/paper.yaml",
        out_dir: str = "data/reports",
        telemetry_log_path: str = "data/analytics/simulation_events.jsonl",
        tca_dir: str = "data/tca/simulation",
        lookback_days: int = 60,
        min_days: int = 30,
        min_fills: int = 200,
        max_p95_slippage_bps: float = 20.0,
        max_mape_pct: float = 35.0,
        max_reject_rate: float = 0.40,
        max_degraded_venues: int = 0,
        max_calibration_alerts: int = 0,
        promotion_min_days: int = 30,
        promotion_max_days: int = 90,
        paper_base_slippage_bps: float = 3.0,
        paper_min_slippage_bps: float = 0.5,
        paper_stress_multiplier: float = 1.25,
        paper_stress_fill_ratio_multiplier: float = 0.90,
        risk_profile: str | None = None,
        switch_overrides: Dict[str, bool] | None = None,
    ):
        self.config_path = str(config_path)
        base_config = self._load_yaml(self.config_path)
        self.config, self.mechanism_switches = apply_mechanism_switches(
            base_config,
            overrides=switch_overrides,
        )
        self._risk_cfg, self._risk_profile = resolve_effective_risk_config(
            self.config,
            override_profile=risk_profile,
        )

        self.out_dir = Path(out_dir)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.tca_dir = Path(tca_dir)
        self.tca_dir.mkdir(parents=True, exist_ok=True)
        self.telemetry = SimulationTelemetryStore(log_path=telemetry_log_path)

        self.lookback_days = int(lookback_days)
        self.min_days = int(min_days)
        self.min_fills = int(min_fills)
        self.max_p95_slippage_bps = float(max_p95_slippage_bps)
        self.max_mape_pct = float(max_mape_pct)
        self.max_reject_rate = float(max_reject_rate)
        self.max_degraded_venues = int(max_degraded_venues)
        self.max_calibration_alerts = int(max_calibration_alerts)
        self.promotion_min_days = int(promotion_min_days)
        self.promotion_max_days = int(promotion_max_days)

        stress_enabled = bool(self.mechanism_switches.get("slippage_stress_model", True))
        self.paper_fill_config = PaperFillModelConfig(
            adverse_selection_bps=float(paper_base_slippage_bps),
            min_slippage_bps=float(paper_min_slippage_bps),
            reality_stress_mode=bool(stress_enabled),
            stress_slippage_multiplier=float(paper_stress_multiplier) if stress_enabled else 1.0,
            stress_fill_ratio_multiplier=(
                float(paper_stress_fill_ratio_multiplier) if stress_enabled else 1.0
            ),
        )

    @staticmethod
    def _load_yaml(path: str) -> Dict[str, Any]:
        with open(path, "r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
        return data

    @staticmethod
    def _pct(value: Any, default: float) -> float:
        if value is None:
            return float(default)
        token = float(value)
        return token / 100.0 if token > 1.0 else token

    @staticmethod
    def _hash_token(*parts: object, length: int = 10) -> str:
        payload = "|".join(str(part) for part in parts)
        digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        return digest[:length]

    def _create_run_id(self, scenario: SimulationScenario) -> str:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        token = self._hash_token(
            scenario.market,
            scenario.strategy,
            ",".join(scenario.symbols),
            scenario.cycles,
            stamp,
        )
        return f"sim_{scenario.market}_{scenario.strategy}_{token}"

    def _capital(self) -> float:
        if "initial_capital" not in self._risk_cfg:
            raise RuntimeError(
                "config/risk.initial_capital must be set before simulation suite runs."
            )
        return float(self._risk_cfg.get("initial_capital"))

    def _build_risk_limits(self) -> RiskLimits:
        risk_cfg = self._risk_cfg
        return RiskLimits(
            max_daily_loss_pct=self._pct(
                risk_cfg.get("max_daily_loss_pct", risk_cfg.get("max_portfolio_risk_pct", 2.0)),
                0.02,
            ),
            max_drawdown_pct=self._pct(risk_cfg.get("max_drawdown_pct", 0.15), 0.15),
            max_gross_leverage=float(risk_cfg.get("max_leverage", 2.0)),
            max_order_notional=float(risk_cfg.get("max_order_notional", 50000.0)),
            max_participation=self._pct(risk_cfg.get("max_participation", 0.05), 0.05),
            max_slippage_bps=float(risk_cfg.get("max_slippage_bps", 50.0)),
        )

    def _build_broker_config(self, *, tca_db_path: str) -> Dict[str, Any]:
        risk_cfg = self._risk_cfg
        execution_cfg = self.config.get("execution", {})
        return {
            "enabled": True,
            "live_execution": False,
            "max_symbol_notional": risk_cfg.get("max_symbol_notional", {}),
            "max_venue_notional": risk_cfg.get("max_venue_notional", {}),
            "tca_db_path": str(tca_db_path),
            "exchanges": {},
            "max_single_order_size": execution_cfg.get("max_single_order_size", 1.0),
            "twap_interval_seconds": execution_cfg.get("twap_interval_seconds", 60),
            "prefer_maker": execution_cfg.get("prefer_maker", True),
            "default_monthly_volume_usd": execution_cfg.get("default_monthly_volume_usd", 0.0),
            "monthly_volume_by_venue": execution_cfg.get("monthly_volume_by_venue", {}),
            "fee_tiers": execution_cfg.get("fee_tiers", {}),
            "default_maker_fee_bps": execution_cfg.get("default_maker_fee_bps", 2.0),
            "default_taker_fee_bps": execution_cfg.get("default_taker_fee_bps", 4.0),
            "reliability": execution_cfg.get("reliability", {}),
            "regime_overlay": execution_cfg.get("regime_overlay", {}),
            "market_data_resilience": execution_cfg.get("market_data_resilience", {}),
            "tca_calibration": execution_cfg.get("tca_calibration", {}),
            "profitability_gate": execution_cfg.get("profitability_gate", {}),
            "risk_profile": risk_profile_payload(self._risk_profile),
        }

    def _symbols_for_market(self, market: str) -> List[str]:
        market_cfg = self.config.get("markets", {}).get(market, {})
        symbols: List[str] = []
        if market == "crypto":
            for venue in market_cfg.get("exchanges", []):
                symbols.extend(str(symbol) for symbol in venue.get("symbols", []))
        elif market == "equities":
            for venue in market_cfg.get("brokers", []):
                symbols.extend(str(symbol) for symbol in venue.get("symbols", []))
        elif market == "forex":
            for venue in market_cfg.get("brokers", []):
                symbols.extend(str(symbol) for symbol in venue.get("pairs", []))
        return sorted({sym for sym in symbols if sym})

    def _filter_markets_config(self, active_market: str) -> Dict[str, Any]:
        raw = self.config.get("markets", {})
        markets: Dict[str, Any] = {}
        for market in ("crypto", "equities", "forex"):
            cfg = dict(raw.get(market, {}))
            cfg["enabled"] = market == active_market
            markets[market] = cfg
        return markets

    def _strategy_return_profile(self, strategy: str) -> Tuple[Dict[str, np.ndarray], List[float]]:
        seed = int(self._hash_token("strategy", strategy, length=8), 16)
        rng = np.random.default_rng(seed)
        noise = rng.normal(loc=0.0, scale=0.0012, size=60)
        trend = np.linspace(-0.0006, 0.0009, 60)
        seasonal = np.sin(np.linspace(0.0, 2.0 * np.pi, 60)) * 0.0008
        returns = np.round(noise + trend + seasonal, 6)
        changes = list(np.round(np.cumsum(returns) * 5000.0, 6))
        return {"campaign": returns}, changes

    @staticmethod
    def _current_eta_map(router: RiskAwareRouter) -> Dict[Tuple[str, str], float]:
        frame = router.tca_db.as_dataframe()
        profile = str(getattr(router, "prediction_profile", "") or "").strip()
        if profile:
            if "prediction_profile" not in frame.columns:
                frame = frame.iloc[0:0].copy()
            else:
                frame = frame[frame["prediction_profile"].astype(str) == profile].copy()
        if frame.empty:
            return dict(router.eta_by_symbol_venue)

        eta_map = dict(router.eta_by_symbol_venue)
        baseline = float(router.cost_model.eta)
        unique_rows = frame[["symbol", "exchange"]].drop_duplicates()
        for _, row in unique_rows.iterrows():
            key = (str(row["symbol"]), str(row["exchange"]))
            eta_map.setdefault(key, baseline)
        return eta_map

    def build_scenarios(
        self,
        *,
        markets: Iterable[str],
        strategies: Iterable[str],
        cycles_per_scenario: int,
        notional_usd: float,
        symbols_per_market: int = 2,
    ) -> List[SimulationScenario]:
        requested_markets = [str(m).strip().lower() for m in markets if str(m).strip()]
        if "all" in requested_markets:
            requested_markets = ["crypto", "equities", "forex"]

        strategy_list = [str(s).strip() for s in strategies if str(s).strip()]
        if not strategy_list:
            raise ValueError("At least one strategy tag is required for simulation suite.")

        scenarios: List[SimulationScenario] = []
        for market in requested_markets:
            symbols = self._symbols_for_market(market)
            if not symbols:
                continue
            scoped_symbols = symbols[: max(int(symbols_per_market), 1)]
            for strategy in strategy_list:
                scenarios.append(
                    SimulationScenario(
                        market=market,
                        strategy=strategy,
                        symbols=scoped_symbols,
                        cycles=int(cycles_per_scenario),
                        notional_usd=float(notional_usd),
                    )
                )
        return scenarios

    async def run_suite(
        self,
        *,
        markets: Iterable[str],
        strategies: Iterable[str],
        cycles_per_scenario: int = 120,
        notional_usd: float = 150.0,
        symbols_per_market: int = 2,
        readiness_every: int = 30,
        sleep_seconds: float = 0.0,
    ) -> Dict[str, Any]:
        scenarios = self.build_scenarios(
            markets=markets,
            strategies=strategies,
            cycles_per_scenario=int(cycles_per_scenario),
            notional_usd=float(notional_usd),
            symbols_per_market=int(symbols_per_market),
        )
        if not scenarios:
            raise RuntimeError("No simulation scenarios available from current config and filters.")

        results: List[Dict[str, Any]] = []
        for scenario in scenarios:
            result = await self._run_scenario(
                scenario=scenario,
                readiness_every=max(int(readiness_every), 1),
                sleep_seconds=float(sleep_seconds),
            )
            results.append(result)

        leaderboard = self.telemetry.optimization_leaderboard()
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        report_path = self.out_dir / f"simulation_suite_{stamp}.json"
        leaderboard_path = self.out_dir / f"simulation_leaderboard_{stamp}.csv"

        leaderboard.to_csv(leaderboard_path, index=False)
        payload = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "config_path": self.config_path,
            "risk_profile": risk_profile_payload(self._risk_profile),
            "scenario_count": len(results),
            "mechanism_switches": dict(self.mechanism_switches),
            "results": results,
            "leaderboard_path": str(leaderboard_path),
            "telemetry_log_path": str(self.telemetry.log_path),
            "leaderboard": leaderboard.to_dict(orient="records"),
        }
        report_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        payload["report_path"] = str(report_path)
        return payload

    async def _run_scenario(
        self,
        *,
        scenario: SimulationScenario,
        readiness_every: int,
        sleep_seconds: float,
    ) -> Dict[str, Any]:
        run_id = self._create_run_id(scenario)
        tca_path = self.tca_dir / f"{run_id}.csv"
        router = RiskAwareRouter(
            risk_config=self._build_risk_limits(),
            broker_config=self._build_broker_config(tca_db_path=str(tca_path)),
            fill_provider=MicrostructurePaperFillProvider(config=self.paper_fill_config),
            tca_db_path=str(tca_path),
        )
        capital = self._capital()
        router.set_capital(capital, source="simulation_suite")
        router.configure_market_adapters(self._filter_markets_config(scenario.market))

        stats = CampaignStats()
        positions: Dict[str, float] = {}
        prices: Dict[str, float] = {}
        cycle_symbols = iter_cycle_symbols(scenario.symbols)
        strategy_returns, portfolio_changes = self._strategy_return_profile(scenario.strategy)

        self.telemetry.emit(
            event_type="run_started",
            run_id=run_id,
            market=scenario.market,
            strategy=scenario.strategy,
            cycle=0,
            metrics={
                "cycles_target": scenario.cycles,
                "notional_usd": scenario.notional_usd,
                "capital_usd": capital,
                "symbol_count": len(scenario.symbols),
            },
            metadata={"symbols": list(scenario.symbols)},
        )

        last_snapshot: Dict[str, Any] = {}
        await router.start_market_data()
        try:
            for cycle in range(scenario.cycles):
                symbol = cycle_symbols[cycle % len(cycle_symbols)]
                side = "buy" if cycle % 2 == 0 else "sell"

                snapshot = await router.fetch_market_snapshot()
                selected = select_symbol_price(snapshot, symbol)
                if selected is None:
                    continue
                _venue, price = selected
                prices[symbol] = float(price)

                order = build_probe_order(
                    symbol=symbol,
                    side=side,
                    notional_usd=float(scenario.notional_usd),
                    price=float(price),
                    order_type=OrderType.LIMIT,
                )
                portfolio = build_portfolio_snapshot(
                    positions=positions,
                    prices=prices,
                    capital=capital,
                )
                result = await router.submit_order(
                    order=order,
                    market_data=snapshot,
                    portfolio=portfolio,
                    strategy_returns=strategy_returns,
                    portfolio_changes=portfolio_changes,
                )

                stats.submitted += 1
                if result.success:
                    stats.filled += 1
                    signed_qty = order.quantity if side == "buy" else -order.quantity
                    positions[symbol] = float(positions.get(symbol, 0.0)) + float(signed_qty)
                else:
                    stats.rejected += 1

                should_snapshot = (cycle + 1) % int(readiness_every) == 0 or (cycle + 1) == int(
                    scenario.cycles
                )
                if should_snapshot:
                    eta_map = self._current_eta_map(router)
                    updated_eta, calibration = router.run_weekly_tca_calibration(
                        eta_by_symbol_venue=eta_map,
                        min_samples=25,
                        alert_threshold_pct=float(self.max_mape_pct),
                        lookback_days=self.lookback_days,
                    )
                    readiness = router.evaluate_paper_live_readiness(
                        lookback_days=self.lookback_days,
                        min_days_required=self.min_days,
                        min_fills_required=self.min_fills,
                        max_p95_slippage_bps=self.max_p95_slippage_bps,
                        max_mape_pct=self.max_mape_pct,
                    )
                    router_stats = router.get_stats()
                    reliability = router_stats.get("reliability", {})
                    ops_health = evaluate_operational_health(
                        campaign_stats={
                            "submitted": stats.submitted,
                            "filled": stats.filled,
                            "rejected": stats.rejected,
                            "reject_rate": stats.reject_rate,
                        },
                        readiness=readiness,
                        reliability=reliability,
                        calibration=calibration,
                        thresholds=OpsThresholds(
                            max_reject_rate=self.max_reject_rate,
                            max_p95_slippage_bps=self.max_p95_slippage_bps,
                            max_mape_pct=self.max_mape_pct,
                            max_degraded_venues=self.max_degraded_venues,
                            max_calibration_alerts=self.max_calibration_alerts,
                        ),
                    )
                    promotion_gate = evaluate_promotion_gate(
                        readiness=readiness,
                        campaign_stats={
                            "submitted": stats.submitted,
                            "filled": stats.filled,
                            "rejected": stats.rejected,
                            "reject_rate": stats.reject_rate,
                        },
                        ops_summary=ops_health.get("summary", {}),
                        thresholds=PromotionGateThresholds(
                            min_days=self.promotion_min_days,
                            max_days=self.promotion_max_days,
                            min_fills=self.min_fills,
                            max_reject_rate=self.max_reject_rate,
                            max_critical_alerts=0,
                            min_net_pnl_after_costs_usd=0.0,
                            max_slippage_mape_pct=self.max_mape_pct,
                            max_kill_switch_triggers=0,
                        ),
                    )
                    calibration_alerts = sum(
                        1 for row in calibration if str(row.get("status", "")).lower() == "alert"
                    )
                    last_snapshot = {
                        "cycle": cycle + 1,
                        "eta_markets": len(updated_eta),
                        "readiness": readiness,
                        "ops_health": ops_health,
                        "promotion_gate": promotion_gate,
                        "calibration_alerts": calibration_alerts,
                    }
                    self.telemetry.emit(
                        event_type="cycle_snapshot",
                        run_id=run_id,
                        market=scenario.market,
                        strategy=scenario.strategy,
                        cycle=cycle + 1,
                        metrics={
                            "submitted": stats.submitted,
                            "filled": stats.filled,
                            "rejected": stats.rejected,
                            "fill_rate": stats.filled / max(stats.submitted, 1),
                            "reject_rate": stats.reject_rate,
                            "trading_days": int(readiness.get("trading_days", 0)),
                            "fills": int(readiness.get("fills", 0)),
                            "p95_realized_slippage_bps": float(
                                readiness.get("p95_realized_slippage_bps", 0.0)
                            ),
                            "slippage_mape_pct": float(readiness.get("slippage_mape_pct", 0.0)),
                            "ready_for_canary": int(bool(readiness.get("ready_for_canary", False))),
                            "ops_critical": int(
                                (ops_health.get("summary", {}) or {}).get("critical", 0)
                            ),
                            "ops_warning": int(
                                (ops_health.get("summary", {}) or {}).get("warning", 0)
                            ),
                            "calibration_alerts": int(calibration_alerts),
                        },
                        metadata={
                            "promotion_decision": str(promotion_gate.get("decision", "unknown")),
                            "eta_markets": len(updated_eta),
                        },
                    )

                if stats.reject_rate > self.max_reject_rate:
                    break

                if sleep_seconds > 0:
                    await asyncio.sleep(float(sleep_seconds))
        finally:
            await router.stop_market_data()

        readiness = dict(last_snapshot.get("readiness", {}))
        ops_summary = dict((last_snapshot.get("ops_health", {}) or {}).get("summary", {}))
        promotion = dict(last_snapshot.get("promotion_gate", {}))

        self.telemetry.emit(
            event_type="run_completed",
            run_id=run_id,
            market=scenario.market,
            strategy=scenario.strategy,
            cycle=scenario.cycles,
            metrics={
                "submitted": stats.submitted,
                "filled": stats.filled,
                "rejected": stats.rejected,
                "fill_rate": stats.filled / max(stats.submitted, 1),
                "reject_rate": stats.reject_rate,
                "ready_for_canary": int(bool(readiness.get("ready_for_canary", False))),
                "p95_realized_slippage_bps": float(readiness.get("p95_realized_slippage_bps", 0.0)),
                "slippage_mape_pct": float(readiness.get("slippage_mape_pct", 0.0)),
                "ops_critical": int(ops_summary.get("critical", 0)),
                "ops_warning": int(ops_summary.get("warning", 0)),
            },
            metadata={
                "promotion_decision": str(promotion.get("decision", "unknown")),
                "symbols": list(scenario.symbols),
            },
        )

        summary = self.telemetry.summarize_run(run_id)
        return {
            "run_id": run_id,
            "risk_profile": risk_profile_payload(self._risk_profile),
            "scenario": asdict(scenario),
            "submitted": stats.submitted,
            "filled": stats.filled,
            "rejected": stats.rejected,
            "reject_rate": stats.reject_rate,
            "ready_for_canary": bool(readiness.get("ready_for_canary", False)),
            "promotion_decision": str(promotion.get("decision", "unknown")),
            "ops_critical": int(ops_summary.get("critical", 0)),
            "tca_records": len(router.tca_db.records),
            "tca_path": str(router.tca_db.storage_path),
            "quality_score": float(summary.get("quality_score", 0.0)),
        }
