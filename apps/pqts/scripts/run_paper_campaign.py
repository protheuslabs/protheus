#!/usr/bin/env python3
"""Run continuous paper-trading campaign and emit readiness snapshots."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analytics.ops_health import OpsThresholds, evaluate_operational_health  # noqa: E402
from analytics.promotion_gates import (  # noqa: E402
    PromotionGateThresholds,
    evaluate_promotion_gate,
)
from analytics.revenue_diagnostics import RevenueDiagnostics  # noqa: E402
from core.mechanism_switches import (  # noqa: E402
    apply_mechanism_switches,
    parse_switch_overrides,
)
from core.operator_tier import resolve_operator_tier, validate_operator_tier_overrides  # noqa: E402
from execution.paper_campaign import (  # noqa: E402
    CampaignStats,
    bounded_probe_notional,
    build_portfolio_snapshot,
    build_probe_order,
    iter_cycle_symbols,
    select_probe_side,
    select_symbol_price,
)
from execution.paper_fill_model import (  # noqa: E402
    MicrostructurePaperFillProvider,
    PaperFillModelConfig,
)
from execution.risk_aware_router import RiskAwareRouter  # noqa: E402
from execution.smart_router import OrderType  # noqa: E402
from risk.kill_switches import RiskLimits  # noqa: E402
from risk.risk_tolerance import (  # noqa: E402
    resolve_effective_risk_config,
    risk_profile_payload,
)

MAJOR_BOOTSTRAP_SYMBOLS: tuple[str, ...] = ("BTCUSDT", "ETHUSDT", "BTC-USD", "ETH-USD")

_DIRECT_EXPECTED_ALPHA_PATHS: tuple[tuple[Any, ...], ...] = (
    ("expected_alpha_bps",),
    ("campaign_expected_alpha_bps",),
    ("strategy", "expected_alpha_bps"),
    ("validation", "expected_alpha_bps"),
    ("top_strategy", "expected_alpha_bps"),
    ("top_strategies", 0, "expected_alpha_bps"),
)

_DERIVED_EXPECTED_RETURN_PATHS: tuple[tuple[Any, ...], ...] = (
    ("net_expected_return",),
    ("top_strategy", "net_expected_return"),
    ("top_strategies", 0, "net_expected_return"),
    ("extras", "net_expected_return"),
    ("objective", "net_expected_return"),
)

_DERIVED_TURNOVER_PATHS: tuple[tuple[Any, ...], ...] = (
    ("turnover_annualized",),
    ("validation", "turnover_annualized"),
    ("top_strategy", "turnover_annualized"),
    ("top_strategies", 0, "turnover_annualized"),
)


def _parse_csv(value: str) -> List[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _load_yaml(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    return data


def _pct(value: Any, default: float) -> float:
    if value is None:
        return default
    token = float(value)
    return token / 100.0 if token > 1.0 else token


def _to_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _first_float(*values: Any) -> float | None:
    for value in values:
        parsed = _to_float(value)
        if parsed is not None:
            return parsed
    return None


def _build_risk_limits(risk_cfg: Dict[str, Any]) -> RiskLimits:
    return RiskLimits(
        max_daily_loss_pct=_pct(
            risk_cfg.get("max_daily_loss_pct", risk_cfg.get("max_portfolio_risk_pct", 2.0)),
            0.02,
        ),
        max_drawdown_pct=_pct(risk_cfg.get("max_drawdown_pct", 0.15), 0.15),
        max_gross_leverage=float(risk_cfg.get("max_leverage", 2.0)),
        max_order_notional=float(risk_cfg.get("max_order_notional", 50000.0)),
        max_participation=_pct(risk_cfg.get("max_participation", 0.05), 0.05),
        max_slippage_bps=float(risk_cfg.get("max_slippage_bps", 50.0)),
        max_single_position_pct=_pct(risk_cfg.get("max_single_position_pct", 0.25), 0.25),
    )


def _build_broker_config(
    config: Dict[str, Any],
    *,
    risk_cfg: Dict[str, Any],
    tca_db_path_override: str = "",
) -> Dict[str, Any]:
    execution_cfg = config.get("execution", {})
    analytics_cfg = config.get("analytics", {})
    tca_db_path = str(
        tca_db_path_override or analytics_cfg.get("tca_db_path", "data/tca_records.csv")
    )
    return {
        "enabled": True,
        "live_execution": False,
        "max_symbol_notional": risk_cfg.get("max_symbol_notional", {}),
        "max_venue_notional": risk_cfg.get("max_venue_notional", {}),
        "tca_db_path": tca_db_path,
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
        "capacity_curves": execution_cfg.get("capacity_curves", {}),
        "expected_alpha_bps_by_strategy": execution_cfg.get("expected_alpha_bps_by_strategy", {}),
        "profitability_gate": execution_cfg.get("profitability_gate", {}),
        "require_live_client_order_id": execution_cfg.get("require_live_client_order_id", True),
        "idempotency_ttl_seconds": execution_cfg.get("idempotency_ttl_seconds", 300.0),
        "distributed_ops_state": execution_cfg.get("distributed_ops_state", {}),
        "rate_limits": execution_cfg.get("rate_limits", {}),
        "strategy_disable_list_path": execution_cfg.get(
            "strategy_disable_list_path",
            "data/analytics/strategy_disable_list.json",
        ),
        "strategy_disable_reload_seconds": execution_cfg.get(
            "strategy_disable_reload_seconds",
            30.0,
        ),
        "allocation_controls": execution_cfg.get("allocation_controls", {}),
        "market_data_resilience": execution_cfg.get("market_data_resilience", {}),
        "tca_calibration": execution_cfg.get("tca_calibration", {}),
        "confidence_allocator": execution_cfg.get("confidence_allocator", {}),
        "maker_urgency_ladder": execution_cfg.get("maker_urgency_ladder", {}),
        "paper_prediction_blend": execution_cfg.get("paper_prediction_blend", 1.0),
    }


def _default_symbols(config: Dict[str, Any]) -> List[str]:
    symbols: List[str] = []
    markets = config.get("markets", {})
    for venue in markets.get("crypto", {}).get("exchanges", []):
        symbols.extend(venue.get("symbols", []))
    for venue in markets.get("equities", {}).get("brokers", []):
        symbols.extend(venue.get("symbols", []))
    for venue in markets.get("forex", {}).get("brokers", []):
        symbols.extend(venue.get("pairs", []))
    return sorted(set(str(s) for s in symbols if s))


def _bootstrap_symbols(symbols: List[str], *, major_only: bool) -> List[str]:
    deduped = sorted(set(str(s).strip() for s in symbols if str(s).strip()))
    if not major_only:
        return deduped

    symbol_set = set(deduped)
    majors = [symbol for symbol in MAJOR_BOOTSTRAP_SYMBOLS if symbol in symbol_set]
    return majors or deduped


def _write_snapshot(out_dir: Path, payload: Dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = out_dir / f"paper_campaign_snapshot_{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def _load_research_validation(path: str) -> Dict[str, Any]:
    token = str(path or "").strip()
    if not token:
        return {}
    payload = json.loads(Path(token).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected object JSON at --research-validation: {path}")
    return payload


def _extract_path(payload: Any, path: tuple[Any, ...]) -> Any:
    current = payload
    for part in path:
        if isinstance(part, int):
            if not isinstance(current, list) or part < 0 or part >= len(current):
                return None
            current = current[part]
            continue
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _load_research_validation_from_report(path: str) -> Dict[str, Any]:
    token = str(path or "").strip()
    if not token:
        return {}
    payload = json.loads(Path(token).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected object JSON at --research-report: {path}")

    validation = payload.get("validation", {})
    if not isinstance(validation, dict):
        validation = {}
    gate_checks = (
        payload.get("promotion", {}).get("gate_checks", {})
        if isinstance(payload.get("promotion", {}), dict)
        else {}
    )
    if not isinstance(gate_checks, dict):
        gate_checks = {}

    cv_sharpe = float(_to_float(validation.get("cv_sharpe")) or 0.0)
    walk_forward_sharpe = float(_to_float(validation.get("walk_forward_sharpe")) or 0.0)
    deflated_sharpe = float(_to_float(validation.get("deflated_sharpe")) or 0.0)
    walk_forward_consistency = float(_to_float(validation.get("walk_forward_consistency")) or 1.0)
    cv_sharpe_std = float(_to_float(validation.get("cv_sharpe_std")) or 0.0)
    parameter_stability_score = float(
        _first_float(
            validation.get("parameter_stability_score"),
            validation.get("parameter_stability"),
            max(min(1.0 / (1.0 + max(cv_sharpe_std, 0.0)), 1.0), 0.0),
        )
        or 0.0
    )
    regime_robustness_score = float(
        _first_float(
            validation.get("regime_robustness_score"),
            validation.get("regime_robustness"),
            max(min(walk_forward_consistency, 1.0), 0.0),
        )
        or 0.0
    )
    payload_out = {
        "purged_cv_sharpe": cv_sharpe,
        "walk_forward_sharpe": walk_forward_sharpe,
        "deflated_sharpe": deflated_sharpe,
        "parameter_stability_score": parameter_stability_score,
        "regime_robustness_score": regime_robustness_score,
        "purged_cv_passed": bool(gate_checks.get("validator", cv_sharpe > 0.0)),
        "walk_forward_passed": bool(
            gate_checks.get("walk_forward_sharpe", walk_forward_sharpe > 0.0)
        ),
        "deflated_sharpe_passed": bool(gate_checks.get("deflated_sharpe", deflated_sharpe > 0.0)),
        "parameter_stability_passed": bool(
            gate_checks.get("parameter_stability", parameter_stability_score >= 0.55)
        ),
        "regime_robustness_passed": bool(
            gate_checks.get("regime_robustness", regime_robustness_score >= 0.55)
        ),
    }

    turnover = float(_to_float(validation.get("turnover_annualized")) or 0.0)
    total_return = float(_to_float(validation.get("total_return")) or 0.0)
    if turnover > 0.0 and total_return > 0.0:
        # Conservative proxy: annual return per annual turnover converted to bps, clipped.
        payload_out["expected_alpha_bps"] = float(
            np.clip(total_return / turnover * 10000.0, 0.0, 25.0)
        )
    return payload_out


def _resolve_campaign_expected_alpha_bps(
    *,
    explicit_expected_alpha_bps: float | None,
    research_validation: Dict[str, Any],
    broker_default_expected_alpha_bps: float,
) -> tuple[float, str]:
    explicit = _to_float(explicit_expected_alpha_bps)
    if explicit is not None:
        return float(explicit), "cli_override"

    for path in _DIRECT_EXPECTED_ALPHA_PATHS:
        value = _to_float(_extract_path(research_validation, path))
        if value is not None:
            return float(value), f"research_validation:{'.'.join(map(str, path))}"

    derived_return = None
    for path in _DERIVED_EXPECTED_RETURN_PATHS:
        value = _to_float(_extract_path(research_validation, path))
        if value is not None:
            derived_return = value
            break

    derived_turnover = None
    for path in _DERIVED_TURNOVER_PATHS:
        value = _to_float(_extract_path(research_validation, path))
        if value is not None:
            derived_turnover = value
            break

    if derived_return is not None and derived_turnover is not None and derived_turnover > 0.0:
        expected_alpha_bps = float(
            np.clip((max(derived_return, 0.0) / derived_turnover) * 10000.0, 0.0, 25.0)
        )
        return expected_alpha_bps, "research_validation:derived_return_over_turnover"

    return float(broker_default_expected_alpha_bps), "broker_config_default"


def _current_eta_map(router: RiskAwareRouter) -> Dict[tuple[str, str], float]:
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


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config/paper.yaml")
    parser.add_argument(
        "--operator-tier",
        choices=["simple", "pro"],
        default="",
        help="Operator UX tier override (simple or pro).",
    )
    parser.add_argument(
        "--risk-profile",
        default="",
        help=(
            "Risk tolerance profile override "
            "(conservative, balanced, aggressive, professional, or custom key)."
        ),
    )
    parser.add_argument("--symbols", default="")
    parser.add_argument(
        "--disable-major-bootstrap",
        action="store_true",
        help="Disable BTC/ETH-first bootstrap universe when --symbols is omitted.",
    )
    parser.add_argument("--cycles", type=int, default=500)
    parser.add_argument("--sleep-seconds", type=float, default=1.0)
    parser.add_argument("--notional-usd", type=float, default=200.0)
    parser.add_argument("--readiness-every", type=int, default=50)
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument("--max-reject-rate", type=float, default=0.4)
    parser.add_argument("--lookback-days", type=int, default=60)
    parser.add_argument("--min-days", type=int, default=30)
    parser.add_argument("--min-fills", type=int, default=200)
    parser.add_argument("--max-p95-slippage-bps", type=float, default=20.0)
    parser.add_argument("--max-mape-pct", type=float, default=35.0)
    parser.add_argument(
        "--calibration-min-samples",
        type=int,
        default=10,
        help="Minimum fills required before eta calibration updates.",
    )
    parser.add_argument(
        "--calibration-adaptation-rate",
        type=float,
        default=0.75,
        help="Blend factor [0,1] for eta movement toward calibration target.",
    )
    parser.add_argument(
        "--calibration-max-step-pct",
        type=float,
        default=0.80,
        help="Maximum absolute eta step per calibration run (percent of current eta).",
    )
    parser.add_argument("--paper-base-slippage-bps", type=float, default=3.0)
    parser.add_argument("--paper-min-slippage-bps", type=float, default=0.5)
    parser.add_argument("--paper-stress-multiplier", type=float, default=1.25)
    parser.add_argument("--paper-stress-fill-ratio-multiplier", type=float, default=0.90)
    parser.add_argument(
        "--tca-db-path",
        default="",
        help=(
            "Override analytics.tca_db_path for isolated A/B and tuning runs "
            "(prevents mixing historical fills across experiments)."
        ),
    )
    parser.add_argument("--max-degraded-venues", type=int, default=0)
    parser.add_argument("--max-calibration-alerts", type=int, default=0)
    parser.add_argument("--promotion-min-days", type=int, default=30)
    parser.add_argument("--promotion-max-days", type=int, default=90)
    parser.add_argument("--promotion-min-net-pnl-usd", type=float, default=0.0)
    parser.add_argument("--promotion-max-kill-switch-triggers", type=int, default=0)
    parser.add_argument("--research-validation", default="")
    parser.add_argument(
        "--research-report",
        default="",
        help="Optional strategy analytics report JSON; used to derive research-validation payload.",
    )
    parser.add_argument(
        "--campaign-expected-alpha-bps",
        type=float,
        default=None,
        help="Optional expected alpha override for campaign probe orders.",
    )
    parser.add_argument("--promotion-min-purged-cv-sharpe", type=float, default=1.0)
    parser.add_argument("--promotion-min-walk-forward-sharpe", type=float, default=1.0)
    parser.add_argument("--promotion-min-deflated-sharpe", type=float, default=0.8)
    parser.add_argument("--promotion-min-parameter-stability-score", type=float, default=0.55)
    parser.add_argument("--promotion-min-regime-robustness-score", type=float, default=0.55)
    parser.add_argument("--promotion-min-realized-net-alpha-bps", type=float, default=0.0)
    parser.add_argument(
        "--promotion-min-ci95-lower-realized-net-alpha-bps", type=float, default=0.0
    )
    parser.add_argument(
        "--allow-short-probes",
        action="store_true",
        help="Allow probe campaign to open short inventory from flat.",
    )
    parser.add_argument(
        "--switch",
        dest="switches",
        action="append",
        default=[],
        help=(
            "Mechanism switch override for ablations, e.g. --switch capacity_curves=off. "
            "Valid keys: routing_failover,capacity_curves,allocation_controls,regime_overlay,"
            "maker_urgency_ladder,confidence_allocator,shorting_controls,profitability_gate,"
            "market_data_resilience,tca_calibration_feedback,"
            "slippage_stress_model"
        ),
    )
    return parser


async def _run(args: argparse.Namespace) -> Dict[str, Any]:
    base_config = _load_yaml(args.config)
    switch_overrides = parse_switch_overrides(args.switches)
    config, mechanism_switches = apply_mechanism_switches(
        base_config,
        overrides=switch_overrides,
    )
    operator_tier = resolve_operator_tier(config, override=(args.operator_tier or None))
    validate_operator_tier_overrides(
        tier=operator_tier,
        has_market_override=False,
        has_strategy_override=False,
        has_symbol_override=bool(args.symbols),
    )
    risk_cfg, risk_profile = resolve_effective_risk_config(
        config,
        override_profile=(args.risk_profile or None),
    )

    risk_limits = _build_risk_limits(risk_cfg)
    broker_config = _build_broker_config(
        config,
        risk_cfg=risk_cfg,
        tca_db_path_override=str(args.tca_db_path or "").strip(),
    )
    stress_enabled = bool(mechanism_switches.get("slippage_stress_model", True))
    fill_provider = MicrostructurePaperFillProvider(
        config=PaperFillModelConfig(
            adverse_selection_bps=float(args.paper_base_slippage_bps),
            min_slippage_bps=float(args.paper_min_slippage_bps),
            reality_stress_mode=bool(stress_enabled),
            stress_slippage_multiplier=(
                float(args.paper_stress_multiplier) if bool(stress_enabled) else 1.0
            ),
            stress_fill_ratio_multiplier=(
                float(args.paper_stress_fill_ratio_multiplier) if bool(stress_enabled) else 1.0
            ),
        )
    )
    router = RiskAwareRouter(
        risk_config=risk_limits,
        broker_config=broker_config,
        fill_provider=fill_provider,
    )

    if "initial_capital" not in risk_cfg:
        raise ValueError("risk.initial_capital must be set in config before paper campaign runs.")
    capital = float(risk_cfg.get("initial_capital"))
    router.set_capital(capital, source="paper_campaign")

    router.configure_market_adapters(config.get("markets", {}))
    await router.start_market_data()

    symbol_list = (
        _parse_csv(args.symbols)
        if args.symbols
        else _bootstrap_symbols(
            _default_symbols(config),
            major_only=not bool(args.disable_major_bootstrap),
        )
    )
    cycle_symbols = iter_cycle_symbols(symbol_list)
    research_validation = _load_research_validation(args.research_validation)
    if not research_validation and str(args.research_report or "").strip():
        research_validation = _load_research_validation_from_report(args.research_report)

    positions: Dict[str, float] = {}
    prices: Dict[str, float] = {}
    stats = CampaignStats()
    strategy_returns = {
        "campaign": np.linspace(-0.002, 0.002, 30),
    }
    revenue_diagnostics = RevenueDiagnostics(
        str(broker_config.get("tca_db_path", "data/tca_records.csv"))
    )
    campaign_expected_alpha, campaign_expected_alpha_source = _resolve_campaign_expected_alpha_bps(
        explicit_expected_alpha_bps=args.campaign_expected_alpha_bps,
        research_validation=research_validation,
        broker_default_expected_alpha_bps=float(
            broker_config.get("expected_alpha_bps_by_strategy", {}).get("campaign", 0.0)
        ),
    )
    portfolio_changes = list(np.linspace(-5.0, 5.0, 30))

    out_dir = Path(args.out_dir)
    last_snapshot: Dict[str, Any] = {}

    try:
        for cycle in range(args.cycles):
            symbol = cycle_symbols[cycle % len(cycle_symbols)]

            snapshot = await router.fetch_market_snapshot()
            selected = select_symbol_price(snapshot, symbol)
            if selected is None:
                continue

            _venue, price = selected
            prices[symbol] = float(price)
            current_qty = float(positions.get(symbol, 0.0))
            side = select_probe_side(
                current_qty=current_qty,
                cycle=cycle,
                allow_short=bool(args.allow_short_probes),
            )
            probe_notional = bounded_probe_notional(
                side=side,
                requested_notional_usd=float(args.notional_usd),
                current_qty=current_qty,
                price=float(price),
                capital=capital,
                max_single_position_pct=float(risk_limits.max_single_position_pct),
                allow_short=bool(args.allow_short_probes),
            )
            if probe_notional <= 0.0:
                continue
            order = build_probe_order(
                symbol=symbol,
                side=side,
                notional_usd=float(probe_notional),
                price=float(price),
                order_type=OrderType.LIMIT,
                strategy_id="campaign",
                expected_alpha_bps=campaign_expected_alpha,
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

            if stats.reject_rate > float(args.max_reject_rate):
                break

            should_snapshot = ((cycle + 1) % max(int(args.readiness_every), 1) == 0) or (
                cycle + 1 == args.cycles
            )
            if should_snapshot:
                revenue_payload = revenue_diagnostics.payload(
                    lookback_days=int(args.lookback_days),
                    limit=20,
                    prediction_profile=str(getattr(router, "prediction_profile", "") or ""),
                )
                eta_map = _current_eta_map(router)
                updated_eta, calibration = router.run_weekly_tca_calibration(
                    eta_by_symbol_venue=eta_map,
                    min_samples=int(args.calibration_min_samples),
                    alert_threshold_pct=float(args.max_mape_pct),
                    adaptation_rate=float(args.calibration_adaptation_rate),
                    max_step_pct=float(args.calibration_max_step_pct),
                    lookback_days=int(args.lookback_days),
                )
                readiness = router.evaluate_paper_live_readiness(
                    lookback_days=int(args.lookback_days),
                    min_days_required=int(args.min_days),
                    min_fills_required=int(args.min_fills),
                    max_p95_slippage_bps=float(args.max_p95_slippage_bps),
                    max_mape_pct=float(args.max_mape_pct),
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
                        max_reject_rate=float(args.max_reject_rate),
                        max_p95_slippage_bps=float(args.max_p95_slippage_bps),
                        max_mape_pct=float(args.max_mape_pct),
                        max_degraded_venues=int(args.max_degraded_venues),
                        max_calibration_alerts=int(args.max_calibration_alerts),
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
                    research_validation=research_validation,
                    revenue_summary=(revenue_payload or {}).get("summary", {}),
                    thresholds=PromotionGateThresholds(
                        min_days=int(args.promotion_min_days),
                        max_days=int(args.promotion_max_days),
                        min_fills=int(args.min_fills),
                        max_reject_rate=float(args.max_reject_rate),
                        max_critical_alerts=0,
                        min_net_pnl_after_costs_usd=float(args.promotion_min_net_pnl_usd),
                        max_slippage_mape_pct=float(args.max_mape_pct),
                        max_kill_switch_triggers=int(args.promotion_max_kill_switch_triggers),
                        min_purged_cv_sharpe=float(args.promotion_min_purged_cv_sharpe),
                        min_walk_forward_sharpe=float(args.promotion_min_walk_forward_sharpe),
                        min_deflated_sharpe=float(args.promotion_min_deflated_sharpe),
                        min_parameter_stability_score=float(
                            args.promotion_min_parameter_stability_score
                        ),
                        min_regime_robustness_score=float(
                            args.promotion_min_regime_robustness_score
                        ),
                        min_realized_net_alpha_bps=float(args.promotion_min_realized_net_alpha_bps),
                        min_ci95_lower_realized_net_alpha_bps=float(
                            args.promotion_min_ci95_lower_realized_net_alpha_bps
                        ),
                    ),
                )
                last_snapshot = {
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "risk_profile": risk_profile_payload(risk_profile),
                    "operator_tier": operator_tier.name,
                    "cycle": cycle + 1,
                    "symbols": symbol_list,
                    "campaign_expected_alpha_bps": float(campaign_expected_alpha),
                    "campaign_expected_alpha_source": campaign_expected_alpha_source,
                    "mechanism_switches": dict(mechanism_switches),
                    "stats": {
                        "submitted": stats.submitted,
                        "filled": stats.filled,
                        "rejected": stats.rejected,
                        "reject_rate": stats.reject_rate,
                    },
                    "eta": {
                        "markets": {
                            f"{key[0]}@{key[1]}": float(val) for key, val in updated_eta.items()
                        },
                    },
                    "reliability": reliability,
                    "calibration": calibration,
                    "readiness": readiness,
                    "ops_health": ops_health,
                    "promotion_gate": promotion_gate,
                    "revenue": revenue_payload,
                    "research_validation": research_validation,
                }
                path = _write_snapshot(out_dir, last_snapshot)
                print(
                    "snapshot="
                    f"{path} readiness={readiness['ready_for_canary']} "
                    f"promotion={promotion_gate['decision']}"
                )

            if float(args.sleep_seconds) > 0:
                await asyncio.sleep(float(args.sleep_seconds))

    finally:
        await router.stop_market_data()

    final = {
        "risk_profile": risk_profile_payload(risk_profile),
        "operator_tier": operator_tier.name,
        "submitted": stats.submitted,
        "filled": stats.filled,
        "rejected": stats.rejected,
        "reject_rate": stats.reject_rate,
        "symbols": symbol_list,
        "campaign_expected_alpha_bps": float(campaign_expected_alpha),
        "campaign_expected_alpha_source": campaign_expected_alpha_source,
        "mechanism_switches": dict(mechanism_switches),
        "ops_health": last_snapshot.get("ops_health", {}),
        "promotion_gate": last_snapshot.get("promotion_gate", {}),
        "reliability": last_snapshot.get("reliability", {}),
        "readiness": last_snapshot.get("readiness", {}),
        "revenue": last_snapshot.get("revenue", {}),
    }
    return final


def main() -> int:
    args = build_arg_parser().parse_args()
    final = asyncio.run(_run(args))
    print(json.dumps(final, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
