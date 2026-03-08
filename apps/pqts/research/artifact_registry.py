"""Strategy artifact registry for reproducible run manifests."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class StrategyArtifactManifest:
    run_id: str
    experiment_id: str
    strategy_id: str
    stage: str
    created_at: str
    code_sha: str
    config_hash: str
    report_id: str
    report_path: str
    report_sha256: str
    metrics: Dict[str, Any]
    extras: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class StrategyArtifactRegistry:
    """Append-only registry for strategy manifests keyed by run_id."""

    def __init__(self, root: str = "data/research_artifacts"):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.index_path = self.root / "index.jsonl"

    def register(self, manifest: StrategyArtifactManifest) -> Path:
        run_dir = self.root / str(manifest.run_id)
        run_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = run_dir / "manifest.json"
        payload = manifest.to_dict()
        manifest_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        with self.index_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, sort_keys=True) + "\n")
        return manifest_path

    def find_by_run_id(self, run_id: str) -> Optional[Dict[str, Any]]:
        path = self.root / str(run_id) / "manifest.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def list_for_strategy(self, strategy_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        if not self.index_path.exists():
            return []
        out: List[Dict[str, Any]] = []
        for line in reversed(self.index_path.read_text(encoding="utf-8").splitlines()):
            payload = line.strip()
            if not payload:
                continue
            try:
                row = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if str(row.get("strategy_id", "")) != str(strategy_id):
                continue
            out.append(row)
            if len(out) >= max(int(limit), 1):
                break
        return out
