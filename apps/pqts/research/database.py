# Research Database
import hashlib
import json
import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

logger = logging.getLogger(__name__)

_STAGE_ORDER = {
    "backtest": 0,
    "paper": 1,
    "live_canary": 2,
    "live": 3,
}


def _stage_rank(value: Optional[str]) -> int:
    if value is None:
        return -1
    return int(_STAGE_ORDER.get(str(value), -1))


@dataclass
class BacktestResult:
    strategy_id: str
    features_used: List[str]
    hyperparameters: Dict
    pnl: float
    sharpe: float
    drawdown: float
    win_rate: float
    total_trades: int
    market_regime: str
    timestamp: datetime
    fitness: float = 0.0


@dataclass
class Experiment:
    experiment_id: str
    strategy_name: str
    variant_id: str
    features: List[str]
    parameters: Dict
    status: str  # 'backtest', 'walk_forward', 'paper', 'live'
    results: Optional[BacktestResult] = None


class ResearchDatabase:
    """
    Research database for AI-driven strategy optimization.

    Stores every experiment for meta-optimization:
    - Backtest results
    - Walk-forward performance
    - Live trading metrics
    - Regime-specific performance
    """

    def __init__(self, db_path: str = "data/research.db"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row

        self._create_tables()

        logger.info(f"ResearchDatabase initialized: {self.db_path}")

    def _create_tables(self):
        """Create schema for research data"""
        cursor = self.conn.cursor()

        # Experiments table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS experiments (
                experiment_id TEXT PRIMARY KEY,
                strategy_name TEXT NOT NULL,
                variant_id TEXT NOT NULL,
                features TEXT,  -- JSON list
                parameters TEXT,  -- JSON dict
                status TEXT DEFAULT 'backtest',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                promoted_at TIMESTAMP,
                UNIQUE(strategy_name, variant_id)
            )
        """)

        # Backtest results
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS backtest_results (
                result_id INTEGER PRIMARY KEY AUTOINCREMENT,
                experiment_id TEXT NOT NULL,
                pnl_pct REAL,
                sharpe_ratio REAL,
                max_drawdown_pct REAL,
                win_rate_pct REAL,
                total_trades INTEGER,
                market_regime TEXT,
                fitness_score REAL,
                run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                data_end_date TEXT,
                FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id)
            )
        """)

        # Live performance metrics
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS live_metrics (
                metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
                experiment_id TEXT NOT NULL,
                timestamp TIMESTAMP,
                realized_pnl REAL,
                unrealized_pnl REAL,
                sharpe_24h REAL,
                drawdown_current REAL,
                exposure REAL,
                num_positions INTEGER,
                FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id)
            )
        """)

        # Stage metrics for promotion gating (paper, live_canary, live)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS stage_metrics (
                metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
                experiment_id TEXT NOT NULL,
                stage TEXT NOT NULL,
                timestamp TIMESTAMP NOT NULL,
                pnl REAL DEFAULT 0,
                sharpe REAL DEFAULT 0,
                drawdown REAL DEFAULT 0,
                slippage_mape REAL DEFAULT 0,
                kill_switch_triggers INTEGER DEFAULT 0,
                notes TEXT,
                FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id)
            )
        """)

        # Immutable pilot-arm assignment for control/treatment analytics.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS pilot_assignments (
                experiment_id TEXT PRIMARY KEY,
                arm TEXT NOT NULL,
                assigned_at TIMESTAMP NOT NULL,
                assignment_hash TEXT NOT NULL,
                FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id)
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS promotion_audit (
                audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
                experiment_id TEXT NOT NULL,
                from_stage TEXT,
                to_stage TEXT NOT NULL,
                reason TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id)
            )
        """)

        # Canonical strategy analytics report artifacts
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS analytics_reports (
                report_id TEXT PRIMARY KEY,
                experiment_id TEXT NOT NULL,
                created_at TIMESTAMP NOT NULL,
                report_path TEXT NOT NULL,
                report_sha256 TEXT NOT NULL,
                schema_version TEXT NOT NULL,
                decision_action TEXT NOT NULL,
                promoted INTEGER NOT NULL DEFAULT 0,
                summary TEXT,
                FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id)
            )
        """)

        # Immutable run registry for experiment governance and provenance.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS experiment_run_registry (
                run_id TEXT PRIMARY KEY,
                experiment_id TEXT NOT NULL,
                stage TEXT NOT NULL,
                decision_action TEXT NOT NULL,
                operator TEXT NOT NULL,
                created_at TIMESTAMP NOT NULL,
                config_hash TEXT NOT NULL,
                evidence TEXT NOT NULL,
                parent_run_id TEXT,
                FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id),
                FOREIGN KEY (parent_run_id) REFERENCES experiment_run_registry(run_id)
            )
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS trg_experiment_run_registry_no_update
            BEFORE UPDATE ON experiment_run_registry
            BEGIN
                SELECT RAISE(FAIL, 'experiment_run_registry rows are immutable');
            END;
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS trg_experiment_run_registry_no_delete
            BEFORE DELETE ON experiment_run_registry
            BEGIN
                SELECT RAISE(FAIL, 'experiment_run_registry rows are immutable');
            END;
        """)

        # Rollback lineage table linking run transitions.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS experiment_rollbacks (
                rollback_id INTEGER PRIMARY KEY AUTOINCREMENT,
                experiment_id TEXT NOT NULL,
                from_run_id TEXT,
                to_run_id TEXT,
                reason TEXT,
                operator TEXT NOT NULL,
                evidence TEXT,
                timestamp TIMESTAMP NOT NULL,
                FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id),
                FOREIGN KEY (from_run_id) REFERENCES experiment_run_registry(run_id),
                FOREIGN KEY (to_run_id) REFERENCES experiment_run_registry(run_id)
            )
        """)

        # Feature importance tracking
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS feature_importance (
                importance_id INTEGER PRIMARY KEY AUTOINCREMENT,
                experiment_id TEXT NOT NULL,
                feature_name TEXT NOT NULL,
                importance_score REAL,
                calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id)
            )
        """)

        # Regime detection history
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS regime_history (
                regime_id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                symbol TEXT,
                regime_type TEXT,  -- trend, mean_reversion, high_vol, low_liq
                regime_score REAL,
                vol_regime REAL,
                trend_regime REAL,
                liquidity_regime REAL
            )
        """)

        self.conn.commit()
        logger.info("Research database schema created")

    def log_experiment(self, experiment: Experiment) -> str:
        """Log a new experiment to the database"""
        cursor = self.conn.cursor()

        try:
            cursor.execute(
                """
                INSERT OR REPLACE INTO experiments 
                (experiment_id, strategy_name, variant_id, features, parameters, status, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    experiment.experiment_id,
                    experiment.strategy_name,
                    experiment.variant_id,
                    json.dumps(experiment.features),
                    json.dumps(experiment.parameters),
                    experiment.status,
                    datetime.now().isoformat(),
                ),
            )

            self.conn.commit()
            logger.info(f"Logged experiment: {experiment.experiment_id}")
            return experiment.experiment_id

        except sqlite3.Error as e:
            logger.error(f"Failed to log experiment: {e}")
            return None

    def log_backtest_result(self, result: BacktestResult) -> bool:
        """Log backtest results with fitness calculation"""
        cursor = self.conn.cursor()

        # Calculate fitness: maximize sharpe, minimize drawdown
        fitness = result.sharpe - 0.5 * result.drawdown

        try:
            cursor.execute(
                """
                INSERT INTO backtest_results 
                (experiment_id, pnl_pct, sharpe_ratio, max_drawdown_pct, 
                 win_rate_pct, total_trades, market_regime, fitness_score, data_end_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    result.strategy_id,
                    result.pnl,
                    result.sharpe,
                    result.drawdown,
                    result.win_rate,
                    result.total_trades,
                    result.market_regime,
                    fitness,
                    result.timestamp.isoformat(),
                ),
            )

            self.conn.commit()
            logger.info(f"Logged backtest for {result.strategy_id}: fitness={fitness:.3f}")
            return True

        except sqlite3.Error as e:
            logger.error(f"Failed to log backtest result: {e}")
            return False

    def log_live_metrics(self, experiment_id: str, metrics: Dict) -> bool:
        """Log real-time trading metrics"""
        cursor = self.conn.cursor()

        try:
            cursor.execute(
                """
                INSERT INTO live_metrics 
                (experiment_id, timestamp, realized_pnl, unrealized_pnl,
                 sharpe_24h, drawdown_current, exposure, num_positions)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    experiment_id,
                    datetime.now().isoformat(),
                    metrics.get("realized_pnl", 0),
                    metrics.get("unrealized_pnl", 0),
                    metrics.get("sharpe_24h", 0),
                    metrics.get("drawdown_current", 0),
                    metrics.get("exposure", 0),
                    metrics.get("num_positions", 0),
                ),
            )

            self.conn.commit()
            return True

        except sqlite3.Error as e:
            logger.error(f"Failed to log live metrics: {e}")
            return False

    def log_regime(self, symbol: str, regime: str, scores: Dict) -> bool:
        """Log market regime detection"""
        cursor = self.conn.cursor()

        try:
            cursor.execute(
                """
                INSERT INTO regime_history 
                (symbol, regime_type, regime_score, vol_regime, trend_regime, liquidity_regime)
                VALUES (?, ?, ?, ?, ?, ?)
            """,
                (
                    symbol,
                    regime,
                    scores.get("overall", 0),
                    scores.get("volatility", 0),
                    scores.get("trend", 0),
                    scores.get("liquidity", 0),
                ),
            )

            self.conn.commit()
            return True

        except sqlite3.Error as e:
            logger.error(f"Failed to log regime: {e}")
            return False

    def get_top_experiments(self, n: int = 10, regime: str = None) -> pd.DataFrame:
        """Get top performing experiments for meta-optimization"""
        query = """
            SELECT e.experiment_id, e.strategy_name, e.features, e.parameters,
                   b.sharpe_ratio, b.max_drawdown_pct, b.win_rate_pct,
                   b.fitness_score, b.total_trades, b.market_regime,
                   b.pnl_pct
            FROM experiments e
            JOIN backtest_results b ON e.experiment_id = b.experiment_id
            WHERE b.run_at = (
                SELECT MAX(run_at) FROM backtest_results WHERE experiment_id = e.experiment_id
            )
        """

        if regime:
            query += f" AND b.market_regime = '{regime}'"

        query += " ORDER BY b.fitness_score DESC LIMIT ?"

        df = pd.read_sql_query(query, self.conn, params=(n,))

        # Parse JSON columns
        df["features"] = df["features"].apply(json.loads)
        df["parameters"] = df["parameters"].apply(json.loads)

        return df

    def get_strategy_evolution(self, strategy_name: str) -> pd.DataFrame:
        """Get evolution of a strategy over time"""
        query = """
            SELECT b.*, e.variant_id
            FROM backtest_results b
            JOIN experiments e ON b.experiment_id = e.experiment_id
            WHERE e.strategy_name = ?
            ORDER BY b.run_at ASC
        """

        return pd.read_sql_query(query, self.conn, params=(strategy_name,))

    def promote_to_paper(self, experiment_id: str) -> bool:
        """Promote experiment from backtest to paper trading"""
        cursor = self.conn.cursor()

        try:
            previous_status = self.get_experiment_status(experiment_id)
            cursor.execute(
                """
                UPDATE experiments 
                SET status = 'paper', promoted_at = ?
                WHERE experiment_id = ?
            """,
                (datetime.now().isoformat(), experiment_id),
            )
            cursor.execute(
                """
                INSERT INTO promotion_audit (experiment_id, from_stage, to_stage, reason, timestamp)
                VALUES (?, ?, ?, ?, ?)
            """,
                (
                    experiment_id,
                    previous_status,
                    "paper",
                    "research_promotion",
                    datetime.now().isoformat(),
                ),
            )

            self.conn.commit()
            logger.info(f"Promoted {experiment_id} to paper trading")
            return True

        except sqlite3.Error as e:
            logger.error(f"Failed to promote experiment: {e}")
            return False

    def get_experiment_status(self, experiment_id: str) -> Optional[str]:
        cursor = self.conn.cursor()
        row = cursor.execute(
            "SELECT status FROM experiments WHERE experiment_id = ?",
            (experiment_id,),
        ).fetchone()
        return row["status"] if row else None

    def get_experiment(self, experiment_id: str) -> Optional[Dict[str, Any]]:
        cursor = self.conn.cursor()
        row = cursor.execute(
            """
            SELECT experiment_id, strategy_name, variant_id, features, parameters, status,
                   created_at, updated_at, promoted_at
            FROM experiments
            WHERE experiment_id = ?
            """,
            (experiment_id,),
        ).fetchone()
        if row is None:
            return None
        return {
            "experiment_id": str(row["experiment_id"]),
            "strategy_name": str(row["strategy_name"]),
            "variant_id": str(row["variant_id"]),
            "features": json.loads(row["features"]) if row["features"] else [],
            "parameters": json.loads(row["parameters"]) if row["parameters"] else {},
            "status": str(row["status"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "promoted_at": row["promoted_at"],
        }

    def list_experiments(self, status: Optional[str] = None) -> pd.DataFrame:
        query = """
            SELECT experiment_id, strategy_name, variant_id, status, created_at, updated_at, promoted_at
            FROM experiments
        """
        params: tuple = ()
        if status is not None:
            query += " WHERE status = ?"
            params = (status,)
        query += " ORDER BY updated_at DESC"
        return pd.read_sql_query(query, self.conn, params=params)

    def update_experiment_status(self, experiment_id: str, status: str, reason: str = "") -> bool:
        cursor = self.conn.cursor()
        try:
            previous_status = self.get_experiment_status(experiment_id)
            cursor.execute(
                """
                UPDATE experiments
                SET status = ?, updated_at = ?
                WHERE experiment_id = ?
                """,
                (status, datetime.now().isoformat(), experiment_id),
            )
            cursor.execute(
                """
                INSERT INTO promotion_audit (experiment_id, from_stage, to_stage, reason, timestamp)
                VALUES (?, ?, ?, ?, ?)
                """,
                (experiment_id, previous_status, status, reason, datetime.now().isoformat()),
            )
            self.conn.commit()
            if _stage_rank(status) < _stage_rank(previous_status):
                latest_from = self.latest_experiment_run(experiment_id)
                latest_to = self.latest_experiment_run(experiment_id, stage=status)
                self.log_rollback_provenance(
                    experiment_id=experiment_id,
                    from_run_id=(latest_from or {}).get("run_id"),
                    to_run_id=(latest_to or {}).get("run_id"),
                    reason=reason or "stage_regression",
                    operator="autopilot",
                    evidence={
                        "from_stage": previous_status,
                        "to_stage": status,
                    },
                )
            return True
        except sqlite3.Error as e:
            logger.error(f"Failed to update experiment status: {e}")
            return False

    def assign_pilot_arm(
        self,
        experiment_id: str,
        arm: Optional[str] = None,
        namespace: str = "pqts_pilot",
    ) -> str:
        """
        Assign immutable pilot A/B arm for an experiment.

        If already assigned, returns existing assignment and ignores requested arm.
        """
        cursor = self.conn.cursor()
        existing = cursor.execute(
            "SELECT arm FROM pilot_assignments WHERE experiment_id = ?",
            (experiment_id,),
        ).fetchone()
        if existing:
            return str(existing["arm"])

        if arm is None:
            digest = hashlib.sha256(f"{namespace}:{experiment_id}".encode("utf-8")).hexdigest()
            arm = "control" if int(digest[:2], 16) % 2 == 0 else "treatment"
            assignment_hash = digest
        else:
            normalized = str(arm).strip().lower()
            if normalized not in {"control", "treatment"}:
                raise ValueError("arm must be 'control' or 'treatment'")
            arm = normalized
            assignment_hash = hashlib.sha256(
                f"{namespace}:{experiment_id}:{arm}".encode("utf-8")
            ).hexdigest()

        cursor.execute(
            """
            INSERT INTO pilot_assignments (experiment_id, arm, assigned_at, assignment_hash)
            VALUES (?, ?, ?, ?)
            """,
            (experiment_id, arm, datetime.now().isoformat(), assignment_hash),
        )
        self.conn.commit()
        return str(arm)

    def get_pilot_assignment(self, experiment_id: str) -> Optional[Dict[str, str]]:
        cursor = self.conn.cursor()
        row = cursor.execute(
            """
            SELECT experiment_id, arm, assigned_at, assignment_hash
            FROM pilot_assignments
            WHERE experiment_id = ?
            """,
            (experiment_id,),
        ).fetchone()
        if row is None:
            return None
        return {
            "experiment_id": str(row["experiment_id"]),
            "arm": str(row["arm"]),
            "assigned_at": str(row["assigned_at"]),
            "assignment_hash": str(row["assignment_hash"]),
        }

    def list_pilot_assignments(self) -> pd.DataFrame:
        return pd.read_sql_query(
            """
            SELECT experiment_id, arm, assigned_at, assignment_hash
            FROM pilot_assignments
            ORDER BY assigned_at DESC
            """,
            self.conn,
        )

    def log_stage_metric(
        self, experiment_id: str, stage: str, metrics: Dict, timestamp: Optional[datetime] = None
    ) -> bool:
        ts = (timestamp or datetime.now()).isoformat()
        cursor = self.conn.cursor()
        try:
            cursor.execute(
                """
                INSERT INTO stage_metrics
                (experiment_id, stage, timestamp, pnl, sharpe, drawdown, slippage_mape, kill_switch_triggers, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    experiment_id,
                    stage,
                    ts,
                    float(metrics.get("pnl", 0.0)),
                    float(metrics.get("sharpe", 0.0)),
                    float(metrics.get("drawdown", 0.0)),
                    float(metrics.get("slippage_mape", 0.0)),
                    int(metrics.get("kill_switch_triggers", 0)),
                    json.dumps(metrics.get("notes", {})),
                ),
            )
            self.conn.commit()
            return True
        except sqlite3.Error as e:
            logger.error(f"Failed to log stage metrics: {e}")
            return False

    def get_stage_summary(
        self, experiment_id: str, stage: str, lookback_days: int = 365
    ) -> Dict[str, float]:
        query = """
            SELECT
                COUNT(*) AS samples,
                MIN(timestamp) AS first_timestamp,
                MAX(timestamp) AS last_timestamp,
                AVG(sharpe) AS avg_sharpe,
                AVG(drawdown) AS avg_drawdown,
                AVG(slippage_mape) AS avg_slippage_mape,
                SUM(kill_switch_triggers) AS total_kill_switch_triggers,
                SUM(pnl) AS total_pnl
            FROM stage_metrics
            WHERE experiment_id = ?
              AND stage = ?
              AND timestamp >= datetime('now', ?)
        """
        lookback = f"-{int(lookback_days)} days"
        frame = pd.read_sql_query(query, self.conn, params=(experiment_id, stage, lookback))
        if frame.empty:
            return {
                "samples": 0,
                "days": 0,
                "avg_sharpe": 0.0,
                "avg_drawdown": 0.0,
                "avg_slippage_mape": 0.0,
                "total_kill_switch_triggers": 0,
                "total_pnl": 0.0,
            }
        row = frame.iloc[0]
        first_ts = (
            pd.to_datetime(row.get("first_timestamp")) if row.get("first_timestamp") else None
        )
        last_ts = pd.to_datetime(row.get("last_timestamp")) if row.get("last_timestamp") else None
        days = (
            int((last_ts - first_ts).days + 1)
            if first_ts is not None and last_ts is not None
            else 0
        )
        return {
            "samples": int(row.get("samples") or 0),
            "days": max(days, 0),
            "avg_sharpe": float(row.get("avg_sharpe") or 0.0),
            "avg_drawdown": float(row.get("avg_drawdown") or 0.0),
            "avg_slippage_mape": float(row.get("avg_slippage_mape") or 0.0),
            "total_kill_switch_triggers": int(row.get("total_kill_switch_triggers") or 0),
            "total_pnl": float(row.get("total_pnl") or 0.0),
        }

    def get_stage_metrics(
        self,
        experiment_id: str,
        stage: str,
        lookback_days: int = 365,
    ) -> pd.DataFrame:
        query = """
            SELECT experiment_id, stage, timestamp, pnl, sharpe, drawdown, slippage_mape, kill_switch_triggers, notes
            FROM stage_metrics
            WHERE experiment_id = ?
              AND stage = ?
              AND timestamp >= datetime('now', ?)
            ORDER BY timestamp ASC, metric_id ASC
        """
        lookback = f"-{int(lookback_days)} days"
        frame = pd.read_sql_query(query, self.conn, params=(experiment_id, stage, lookback))
        if frame.empty:
            return frame
        frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        frame = frame[frame["timestamp"].notna()]
        if "notes" in frame.columns:
            frame["notes"] = frame["notes"].apply(
                lambda text: json.loads(text) if isinstance(text, str) and text else {}
            )
        return frame.reset_index(drop=True)

    def list_stage_metrics(
        self,
        *,
        stage: Optional[str] = None,
        lookback_days: int = 365,
    ) -> pd.DataFrame:
        query = """
            SELECT experiment_id, stage, timestamp, pnl, sharpe, drawdown, slippage_mape, kill_switch_triggers, notes
            FROM stage_metrics
            WHERE timestamp >= datetime('now', ?)
        """
        params: tuple[Any, ...] = (f"-{int(lookback_days)} days",)
        if stage is not None:
            query += " AND stage = ?"
            params += (str(stage),)
        query += " ORDER BY timestamp ASC, metric_id ASC"
        frame = pd.read_sql_query(query, self.conn, params=params)
        if frame.empty:
            return frame
        frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        frame = frame[frame["timestamp"].notna()]
        if "notes" in frame.columns:
            frame["notes"] = frame["notes"].apply(
                lambda text: json.loads(text) if isinstance(text, str) and text else {}
            )
        return frame.reset_index(drop=True)

    def get_promotion_candidates(
        self, min_sharpe: float = 1.0, max_drawdown: float = 0.2
    ) -> pd.DataFrame:
        """Get experiments ready for promotion to next stage"""
        query = """
            SELECT e.*, b.sharpe_ratio, b.max_drawdown_pct, b.fitness_score
            FROM experiments e
            JOIN backtest_results b ON e.experiment_id = b.experiment_id
            WHERE e.status = 'backtest'
            AND b.sharpe_ratio >= ?
            AND b.max_drawdown_pct <= ?
            ORDER BY b.fitness_score DESC
        """

        return pd.read_sql_query(query, self.conn, params=(min_sharpe, max_drawdown))

    def log_report_artifact(
        self,
        *,
        report_id: str,
        experiment_id: str,
        report_path: str,
        report_sha256: str,
        schema_version: str,
        decision_action: str,
        promoted: bool,
        summary: Optional[Dict[str, Any]] = None,
    ) -> bool:
        cursor = self.conn.cursor()
        try:
            cursor.execute(
                """
                INSERT OR REPLACE INTO analytics_reports
                (report_id, experiment_id, created_at, report_path, report_sha256, schema_version, decision_action, promoted, summary)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    report_id,
                    experiment_id,
                    datetime.now().isoformat(),
                    report_path,
                    report_sha256,
                    schema_version,
                    decision_action,
                    1 if promoted else 0,
                    json.dumps(summary or {}, sort_keys=True),
                ),
            )
            self.conn.commit()
            return True
        except sqlite3.Error as e:
            logger.error(f"Failed to log report artifact: {e}")
            return False

    def get_report_artifacts(self, experiment_id: Optional[str] = None) -> pd.DataFrame:
        query = """
            SELECT report_id, experiment_id, created_at, report_path,
                   report_sha256, schema_version, decision_action, promoted, summary
            FROM analytics_reports
        """
        params: tuple = ()
        if experiment_id:
            query += " WHERE experiment_id = ?"
            params = (experiment_id,)
        query += " ORDER BY created_at DESC"

        frame = pd.read_sql_query(query, self.conn, params=params)
        if not frame.empty and "summary" in frame.columns:
            frame["summary"] = frame["summary"].apply(
                lambda text: json.loads(text) if isinstance(text, str) and text else {}
            )
        return frame

    def register_experiment_run(
        self,
        *,
        experiment_id: str,
        stage: str,
        decision_action: str,
        operator: str,
        config_hash: str,
        evidence: Optional[Dict[str, Any]] = None,
        parent_run_id: Optional[str] = None,
        created_at: Optional[datetime] = None,
    ) -> str:
        """
        Register immutable experiment run metadata.

        Rows are append-only and protected by DB triggers from update/delete.
        """
        timestamp = (created_at or datetime.now()).isoformat()
        evidence_payload = dict(evidence or {})
        if parent_run_id is None:
            latest = self.latest_experiment_run(experiment_id)
            parent_run_id = str(latest["run_id"]) if latest else None
        seed = {
            "experiment_id": str(experiment_id),
            "stage": str(stage),
            "decision_action": str(decision_action),
            "operator": str(operator),
            "config_hash": str(config_hash),
            "parent_run_id": str(parent_run_id or ""),
            "created_at": str(timestamp),
            "evidence": evidence_payload,
        }
        run_id = f"run_{hashlib.sha256(json.dumps(seed, sort_keys=True).encode('utf-8')).hexdigest()[:20]}"

        cursor = self.conn.cursor()
        try:
            cursor.execute(
                """
                INSERT OR IGNORE INTO experiment_run_registry
                (run_id, experiment_id, stage, decision_action, operator, created_at, config_hash, evidence, parent_run_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    str(experiment_id),
                    str(stage),
                    str(decision_action),
                    str(operator),
                    str(timestamp),
                    str(config_hash),
                    json.dumps(evidence_payload, sort_keys=True),
                    parent_run_id,
                ),
            )
            self.conn.commit()
            return run_id
        except sqlite3.Error as e:
            logger.error(f"Failed to register experiment run: {e}")
            return ""

    def list_experiment_runs(self, experiment_id: Optional[str] = None) -> pd.DataFrame:
        query = """
            SELECT run_id, experiment_id, stage, decision_action, operator,
                   created_at, config_hash, evidence, parent_run_id
            FROM experiment_run_registry
        """
        params: tuple = ()
        if experiment_id:
            query += " WHERE experiment_id = ?"
            params = (experiment_id,)
        query += " ORDER BY created_at DESC"
        frame = pd.read_sql_query(query, self.conn, params=params)
        if not frame.empty and "evidence" in frame.columns:
            frame["evidence"] = frame["evidence"].apply(
                lambda text: json.loads(text) if isinstance(text, str) and text else {}
            )
        return frame

    def latest_experiment_run(
        self,
        experiment_id: str,
        stage: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        query = """
            SELECT run_id, experiment_id, stage, decision_action, operator,
                   created_at, config_hash, evidence, parent_run_id
            FROM experiment_run_registry
            WHERE experiment_id = ?
        """
        params: tuple[Any, ...] = (experiment_id,)
        if stage is not None:
            query += " AND stage = ?"
            params += (stage,)
        query += " ORDER BY created_at DESC LIMIT 1"
        row = self.conn.execute(query, params).fetchone()
        if row is None:
            return None
        return {
            "run_id": str(row["run_id"]),
            "experiment_id": str(row["experiment_id"]),
            "stage": str(row["stage"]),
            "decision_action": str(row["decision_action"]),
            "operator": str(row["operator"]),
            "created_at": str(row["created_at"]),
            "config_hash": str(row["config_hash"]),
            "evidence": (
                json.loads(row["evidence"])
                if isinstance(row["evidence"], str) and row["evidence"]
                else {}
            ),
            "parent_run_id": (
                str(row["parent_run_id"]) if row["parent_run_id"] is not None else None
            ),
        }

    def log_rollback_provenance(
        self,
        *,
        experiment_id: str,
        from_run_id: Optional[str],
        to_run_id: Optional[str],
        reason: str,
        operator: str = "autopilot",
        evidence: Optional[Dict[str, Any]] = None,
        timestamp: Optional[datetime] = None,
    ) -> bool:
        cursor = self.conn.cursor()
        try:
            cursor.execute(
                """
                INSERT INTO experiment_rollbacks
                (experiment_id, from_run_id, to_run_id, reason, operator, evidence, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(experiment_id),
                    from_run_id,
                    to_run_id,
                    str(reason),
                    str(operator),
                    json.dumps(dict(evidence or {}), sort_keys=True),
                    (timestamp or datetime.now()).isoformat(),
                ),
            )
            self.conn.commit()
            return True
        except sqlite3.Error as e:
            logger.error(f"Failed to log rollback provenance: {e}")
            return False

    def list_rollback_events(self, experiment_id: Optional[str] = None) -> pd.DataFrame:
        query = """
            SELECT rollback_id, experiment_id, from_run_id, to_run_id, reason,
                   operator, evidence, timestamp
            FROM experiment_rollbacks
        """
        params: tuple = ()
        if experiment_id:
            query += " WHERE experiment_id = ?"
            params = (experiment_id,)
        query += " ORDER BY timestamp DESC, rollback_id DESC"
        frame = pd.read_sql_query(query, self.conn, params=params)
        if not frame.empty and "evidence" in frame.columns:
            frame["evidence"] = frame["evidence"].apply(
                lambda text: json.loads(text) if isinstance(text, str) and text else {}
            )
        return frame

    def close(self):
        self.conn.close()
