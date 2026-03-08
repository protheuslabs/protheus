"""Optional R-based analytics validation bridge for research experiments."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
from typing import Any, Dict, Iterable, List


class RAnalyticsBridge:
    """Executes an R validator script and enforces a strict JSON contract."""

    REQUIRED_KEYS = {
        "status",
        "validator_passed_r",
        "deflated_sharpe_r",
        "pbo_estimate_r",
        "cv_sharpe_mean_r",
        "cv_sharpe_std_r",
        "bootstrap_mean_ci",
        "reasons",
    }

    def __init__(
        self,
        script_path: str = "scripts/r/validate_experiment.R",
        rscript_bin: str = "Rscript",
        timeout_seconds: float = 30.0,
        bootstrap_samples: int = 2000,
    ):
        self.script_path = Path(script_path)
        self.rscript_bin = rscript_bin
        self.timeout_seconds = float(timeout_seconds)
        self.bootstrap_samples = int(bootstrap_samples)

    def is_available(self) -> bool:
        return self.script_path.exists() and shutil.which(self.rscript_bin) is not None

    @staticmethod
    def _to_csv(values: Iterable[float]) -> str:
        return ",".join(f"{float(v):.10f}" for v in values)

    def run_cv_validation(
        self,
        *,
        cv_sharpes: List[float],
        n_trials: int,
        min_deflated_sharpe: float,
        max_pbo: float,
        min_cv_sharpe: float,
    ) -> Dict[str, Any]:
        if not self.script_path.exists():
            raise RuntimeError(f"R validator script not found: {self.script_path}")
        if shutil.which(self.rscript_bin) is None:
            raise RuntimeError(f"Rscript binary not available: {self.rscript_bin}")
        if not cv_sharpes:
            raise RuntimeError("cv_sharpes cannot be empty for R analytics validation.")

        command = [
            self.rscript_bin,
            str(self.script_path),
            "--cv-sharpes",
            self._to_csv(cv_sharpes),
            "--n-trials",
            str(int(max(n_trials, 1))),
            "--min-deflated-sharpe",
            str(float(min_deflated_sharpe)),
            "--max-pbo",
            str(float(max_pbo)),
            "--min-cv-sharpe",
            str(float(min_cv_sharpe)),
            "--bootstrap-samples",
            str(self.bootstrap_samples),
        ]

        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=self.timeout_seconds,
        )

        if completed.returncode != 0:
            message = completed.stderr.strip() or completed.stdout.strip() or "unknown R validation failure"
            raise RuntimeError(f"R analytics validation failed: {message}")

        stdout = completed.stdout.strip()
        if not stdout:
            raise RuntimeError("R analytics validation returned empty output.")

        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"R analytics validator output is not valid JSON: {stdout}") from exc

        missing = sorted(self.REQUIRED_KEYS.difference(payload.keys()))
        if missing:
            raise RuntimeError(f"R analytics validator response missing required keys: {missing}")

        payload["status"] = str(payload.get("status", "ok"))
        payload["validator_passed_r"] = bool(payload.get("validator_passed_r", False))
        payload["deflated_sharpe_r"] = float(payload.get("deflated_sharpe_r", 0.0))
        payload["pbo_estimate_r"] = float(payload.get("pbo_estimate_r", 1.0))
        payload["cv_sharpe_mean_r"] = float(payload.get("cv_sharpe_mean_r", 0.0))
        payload["cv_sharpe_std_r"] = float(payload.get("cv_sharpe_std_r", 0.0))
        payload["bootstrap_mean_ci"] = list(payload.get("bootstrap_mean_ci", [0.0, 0.0]))
        payload["reasons"] = [str(reason) for reason in payload.get("reasons", [])]
        return payload
