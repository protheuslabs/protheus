#!/usr/bin/env python3
"""Build promotion-gate research validation payload from strategy report artifacts."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import numpy as np


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


def _load_json(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected object JSON at {path}")
    return payload


def _iter_reports(reports_dir: Path) -> list[Path]:
    rows = sorted(reports_dir.glob("*/*.json"))
    if not rows:
        raise FileNotFoundError(f"No strategy report JSON files found under {reports_dir}")
    return rows


def _build_payload(
    *,
    report: Dict[str, Any],
    report_path: Path,
    min_purged_cv_sharpe: float,
    min_walk_forward_sharpe: float,
    min_deflated_sharpe: float,
    min_parameter_stability_score: float,
    min_regime_robustness_score: float,
    max_expected_alpha_bps: float,
) -> Dict[str, Any]:
    validation = report.get("validation", {})
    if not isinstance(validation, dict):
        validation = {}
    gate_checks = (
        report.get("promotion", {}).get("gate_checks", {})
        if isinstance(report.get("promotion", {}), dict)
        else {}
    )
    if not isinstance(gate_checks, dict):
        gate_checks = {}

    purged_cv_sharpe = float(_to_float(validation.get("cv_sharpe")) or 0.0)
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

    purged_cv_passed = purged_cv_sharpe >= float(min_purged_cv_sharpe)
    walk_forward_passed = walk_forward_sharpe >= float(min_walk_forward_sharpe)
    deflated_sharpe_passed = deflated_sharpe >= float(min_deflated_sharpe)
    parameter_stability_passed = parameter_stability_score >= float(min_parameter_stability_score)
    regime_robustness_passed = regime_robustness_score >= float(min_regime_robustness_score)

    if "validator" in gate_checks:
        purged_cv_passed = bool(purged_cv_passed and bool(gate_checks.get("validator")))
    if "walk_forward_sharpe" in gate_checks:
        walk_forward_passed = bool(
            walk_forward_passed and bool(gate_checks.get("walk_forward_sharpe"))
        )
    if "deflated_sharpe" in gate_checks:
        deflated_sharpe_passed = bool(
            deflated_sharpe_passed and bool(gate_checks.get("deflated_sharpe"))
        )
    if "parameter_stability" in gate_checks:
        parameter_stability_passed = bool(
            parameter_stability_passed and bool(gate_checks.get("parameter_stability"))
        )
    if "regime_robustness" in gate_checks:
        regime_robustness_passed = bool(
            regime_robustness_passed and bool(gate_checks.get("regime_robustness"))
        )

    extras = report.get("extras", {})
    if not isinstance(extras, dict):
        extras = {}

    expected_alpha_bps = _to_float(validation.get("expected_alpha_bps"))
    if expected_alpha_bps is None:
        turnover = float(
            _to_float(validation.get("turnover_annualized"))
            or _to_float(extras.get("turnover_annualized"))
            or 0.0
        )
        annual_net = float(
            _to_float(extras.get("net_expected_return"))
            or _to_float(report.get("objective", {}).get("net_expected_return"))
            or 0.0
        )
        total_return = float(_to_float(validation.get("total_return")) or 0.0)
        basis_return = annual_net if annual_net > 0.0 else total_return
        if turnover > 0.0 and basis_return > 0.0:
            expected_alpha_bps = float(
                np.clip(
                    (basis_return / turnover) * 10000.0,
                    0.0,
                    float(max_expected_alpha_bps),
                )
            )
        else:
            expected_alpha_bps = 0.0

    return {
        "report_path": str(report_path),
        "report_id": str(report.get("report_id", "")),
        "experiment_id": str(report.get("experiment_id", "")),
        "purged_cv_sharpe": purged_cv_sharpe,
        "walk_forward_sharpe": walk_forward_sharpe,
        "deflated_sharpe": deflated_sharpe,
        "parameter_stability_score": parameter_stability_score,
        "regime_robustness_score": regime_robustness_score,
        "purged_cv_passed": bool(purged_cv_passed),
        "walk_forward_passed": bool(walk_forward_passed),
        "deflated_sharpe_passed": bool(deflated_sharpe_passed),
        "parameter_stability_passed": bool(parameter_stability_passed),
        "regime_robustness_passed": bool(regime_robustness_passed),
        "expected_alpha_bps": float(expected_alpha_bps),
    }


def _is_promotable(payload: Dict[str, Any]) -> bool:
    return bool(
        payload.get("purged_cv_passed")
        and payload.get("walk_forward_passed")
        and payload.get("deflated_sharpe_passed")
        and payload.get("parameter_stability_passed")
        and payload.get("regime_robustness_passed")
    )


def _selection_key(payload: Dict[str, Any]) -> tuple[float, float, float, float, float, float]:
    return (
        float(payload.get("expected_alpha_bps", 0.0)),
        float(payload.get("deflated_sharpe", 0.0)),
        float(payload.get("walk_forward_sharpe", 0.0)),
        float(payload.get("purged_cv_sharpe", 0.0)),
        float(payload.get("parameter_stability_score", 0.0)),
        float(payload.get("regime_robustness_score", 0.0)),
    )


def _select_best_report_payload(
    *,
    reports_dir: Path,
    min_purged_cv_sharpe: float,
    min_walk_forward_sharpe: float,
    min_deflated_sharpe: float,
    min_parameter_stability_score: float,
    min_regime_robustness_score: float,
    max_expected_alpha_bps: float,
) -> tuple[Path, Dict[str, Any], str]:
    best_promotable: (
        tuple[tuple[float, float, float, float, float, float], Path, Dict[str, Any]] | None
    ) = None
    best_fallback: (
        tuple[tuple[float, float, float, float, float, float], Path, Dict[str, Any]] | None
    ) = None

    for path in _iter_reports(reports_dir):
        report = _load_json(path)
        payload = _build_payload(
            report=report,
            report_path=path,
            min_purged_cv_sharpe=float(min_purged_cv_sharpe),
            min_walk_forward_sharpe=float(min_walk_forward_sharpe),
            min_deflated_sharpe=float(min_deflated_sharpe),
            min_parameter_stability_score=float(min_parameter_stability_score),
            min_regime_robustness_score=float(min_regime_robustness_score),
            max_expected_alpha_bps=float(max_expected_alpha_bps),
        )
        key = _selection_key(payload)
        if best_fallback is None or key > best_fallback[0]:
            best_fallback = (key, path, payload)
        if _is_promotable(payload):
            if best_promotable is None or key > best_promotable[0]:
                best_promotable = (key, path, payload)

    if best_promotable is not None:
        _, path, payload = best_promotable
        return path, payload, "best_promotable"

    assert best_fallback is not None
    _, path, payload = best_fallback
    return path, payload, "best_fallback_by_alpha"


def _write_payload(out_dir: Path, payload: Dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = out_dir / f"research_validation_payload_{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", default="")
    parser.add_argument("--reports-dir", default="data/research_reports")
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument("--min-purged-cv-sharpe", type=float, default=1.0)
    parser.add_argument("--min-walk-forward-sharpe", type=float, default=1.0)
    parser.add_argument("--min-deflated-sharpe", type=float, default=0.8)
    parser.add_argument("--min-parameter-stability-score", type=float, default=0.55)
    parser.add_argument("--min-regime-robustness-score", type=float, default=0.55)
    parser.add_argument("--max-expected-alpha-bps", type=float, default=25.0)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.report:
        report_path = Path(args.report)
        report = _load_json(report_path)
        payload = _build_payload(
            report=report,
            report_path=report_path,
            min_purged_cv_sharpe=float(args.min_purged_cv_sharpe),
            min_walk_forward_sharpe=float(args.min_walk_forward_sharpe),
            min_deflated_sharpe=float(args.min_deflated_sharpe),
            min_parameter_stability_score=float(args.min_parameter_stability_score),
            min_regime_robustness_score=float(args.min_regime_robustness_score),
            max_expected_alpha_bps=float(args.max_expected_alpha_bps),
        )
        selection_mode = "explicit_report"
    else:
        report_path, payload, selection_mode = _select_best_report_payload(
            reports_dir=Path(args.reports_dir),
            min_purged_cv_sharpe=float(args.min_purged_cv_sharpe),
            min_walk_forward_sharpe=float(args.min_walk_forward_sharpe),
            min_deflated_sharpe=float(args.min_deflated_sharpe),
            min_parameter_stability_score=float(args.min_parameter_stability_score),
            min_regime_robustness_score=float(args.min_regime_robustness_score),
            max_expected_alpha_bps=float(args.max_expected_alpha_bps),
        )
    payload["selection_mode"] = selection_mode
    output_path = _write_payload(Path(args.out_dir), payload)
    print(output_path)
    print(json.dumps({"payload_path": str(output_path), "payload": payload}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
