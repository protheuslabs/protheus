"""Automated strategy tournament + promotion scheduler driven by lakehouse data."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

import pandas as pd

from research.ai_agent import AIResearchAgent
from research.data_lake import DataLakeQualityGate, MarketDataLake


@dataclass(frozen=True)
class LakeSymbolSource:
    venue: str
    symbol: str


@dataclass(frozen=True)
class TournamentConfig:
    interval_seconds: int = 3600
    quality_gate: DataLakeQualityGate = DataLakeQualityGate()
    auto_promote_canary: bool = True


class StrategyTournamentRunner:
    """Execute deterministic research tournaments and stage-promotion evaluation."""

    def __init__(
        self,
        *,
        agent_config: Dict[str, Any],
        lake_root: str = "data/lake",
        out_dir: str = "data/reports",
        config: TournamentConfig | None = None,
    ):
        self.agent_config = dict(agent_config)
        self.lake = MarketDataLake(lake_root)
        self.out_dir = Path(out_dir)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.config = config or TournamentConfig()

    @staticmethod
    def _utc_now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    def _load_frames(
        self,
        *,
        sources: Iterable[LakeSymbolSource],
        start: datetime,
        end: datetime,
    ) -> tuple[Dict[str, pd.DataFrame], List[Dict[str, Any]]]:
        frames: Dict[str, pd.DataFrame] = {}
        quality_rows: List[Dict[str, Any]] = []

        for source in sources:
            frame = self.lake.load_ohlcv_range(
                venue=source.venue,
                symbol=source.symbol,
                start=start,
                end=end,
            )
            summary = MarketDataLake.quality_summary(
                frame,
                interval_seconds=int(self.config.interval_seconds),
            )
            gate_payload = MarketDataLake.enforce_quality_gate(
                summary=summary,
                gate=self.config.quality_gate,
            )
            frames[source.symbol] = frame
            quality_rows.append(
                {
                    "venue": source.venue,
                    "symbol": source.symbol,
                    "quality": gate_payload,
                }
            )

        return frames, quality_rows

    def _evaluate_canary_promotions(self, agent: AIResearchAgent) -> Dict[str, Any]:
        if not bool(self.config.auto_promote_canary):
            return {"attempted": [], "promoted": []}

        paper_df = agent.db.list_experiments(status="paper")
        attempted: List[str] = []
        promoted: List[str] = []
        for strategy_id in paper_df.get("experiment_id", []):
            strategy = str(strategy_id)
            attempted.append(strategy)
            if agent.promote_from_stage(strategy, "live_canary"):
                promoted.append(strategy)

        return {
            "attempted": attempted,
            "promoted": promoted,
        }

    def run_once(
        self,
        *,
        strategy_types: List[str],
        sources: List[LakeSymbolSource],
        start: datetime,
        end: datetime,
    ) -> Dict[str, Any]:
        frames, quality_rows = self._load_frames(sources=sources, start=start, end=end)

        agent = AIResearchAgent(self.agent_config)
        report = agent.research_cycle(frames, strategy_types=strategy_types)
        promotion = self._evaluate_canary_promotions(agent)

        top = agent.get_top_strategies(n=10)
        top_rows = top.to_dict(orient="records") if not top.empty else []
        payload = {
            "timestamp": self._utc_now_iso(),
            "strategy_types": list(strategy_types),
            "sources": [asdict(src) for src in sources],
            "quality_checks": quality_rows,
            "research_report": report,
            "canary_promotion": promotion,
            "top_experiments": top_rows,
        }

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        path = self.out_dir / f"strategy_tournament_{stamp}.json"
        path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        payload["report_path"] = str(path)
        return payload
