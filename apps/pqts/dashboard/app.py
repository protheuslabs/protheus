# Real-time Trading Dashboard
import json
import logging
from datetime import datetime, timedelta
from pathlib import Path

import dash
import numpy as np
import pandas as pd
import plotly.graph_objects as go
from dash import Input, Output, dcc, html
from plotly.subplots import make_subplots

from analytics.research_api import ResearchDashboardAPI
from analytics.simulation_api import get_simulation_kpis, get_simulation_leaderboard

# Initialize Dash app
app = dash.Dash(__name__)
app.title = "PQTS Trading Dashboard"

logger = logging.getLogger(__name__)


def _load_stage_gate_snapshot():
    db_path = Path("data/research.db")
    if not db_path.exists():
        return None

    api = ResearchDashboardAPI(str(db_path))
    try:
        return api.get_stage_gate_health(target_stage="live_canary", lookback_days=365)
    except Exception as exc:
        logger.warning("Unable to load research stage-gate snapshot: %s", exc)
        return None
    finally:
        api.close()


def _load_simulation_snapshot(limit: int = 8):
    try:
        return get_simulation_leaderboard(limit=limit)
    except Exception as exc:
        logger.warning("Unable to load simulation leaderboard snapshot: %s", exc)
        return []


def _load_simulation_kpi_snapshot():
    try:
        return get_simulation_kpis()
    except Exception as exc:
        logger.warning("Unable to load simulation KPI snapshot: %s", exc)
        return {
            "scenario_count": 0,
            "best_quality": {
                "market": "n/a",
                "strategy": "n/a",
                "avg_quality_score": 0.0,
                "runs": 0,
                "canary_ready_rate": 0.0,
            },
            "top_optimization_target": {
                "market": "n/a",
                "strategy": "n/a",
                "optimization_priority": 0.0,
                "avg_slippage_mape_pct": 0.0,
                "avg_reject_rate": 0.0,
                "runs": 0,
            },
        }


# Layout
app.layout = html.Div(
    [
        html.Div(
            [
                html.H1("Protheus Quant Trading System", className="title"),
                html.Div(id="clock", className="clock"),
                html.Div(
                    [
                        html.A(
                            "Upgrade to Protheus",
                            href="https://github.com/jakerslam/protheus?utm_source=pqts_dashboard&utm_medium=cta",
                            target="_blank",
                            style={"marginRight": "16px"},
                        ),
                        html.A(
                            "Toybox Launch Guide",
                            href="https://github.com/jakerslam/pqts/blob/main/docs/PROTHEUS_TOYBOX.md",
                            target="_blank",
                        ),
                    ],
                    className="clock",
                ),
            ],
            className="header",
        ),
        # Summary Cards
        html.Div(
            [
                html.Div(
                    [
                        html.H3("Portfolio Value"),
                        html.H2(id="portfolio-value", children="$0.00"),
                        html.P(id="portfolio-change", children="0.00%"),
                    ],
                    className="card",
                ),
                html.Div(
                    [
                        html.H3("Today's P&L"),
                        html.H2(id="daily-pnl", children="$0.00"),
                        html.P(id="daily-trades", children="0 trades"),
                    ],
                    className="card",
                ),
                html.Div(
                    [
                        html.H3("Open Positions"),
                        html.H2(id="open-positions", children="0"),
                        html.P(id="position-exposure", children="0% invested"),
                    ],
                    className="card",
                ),
                html.Div(
                    [
                        html.H3("Win Rate"),
                        html.H2(id="win-rate", children="0%"),
                        html.P(id="total-trades", children="0 total"),
                    ],
                    className="card",
                ),
                html.Div(
                    [
                        html.H3("Best Sim Quality"),
                        html.H2(id="sim-best-quality-value", children="0.000"),
                        html.P(id="sim-best-quality-detail", children="n/a"),
                    ],
                    className="card",
                ),
                html.Div(
                    [
                        html.H3("Optimization Target"),
                        html.H2(id="sim-opt-target-value", children="0.000"),
                        html.P(id="sim-opt-target-detail", children="n/a"),
                    ],
                    className="card",
                ),
            ],
            className="summary-row",
        ),
        # Main Content
        html.Div(
            [
                # Left Column - Charts
                html.Div(
                    [
                        # Equity Curve
                        html.Div(
                            [
                                html.H3("Equity Curve"),
                                dcc.Graph(id="equity-chart", style={"height": "400px"}),
                            ],
                            className="chart-container",
                        ),
                        # Price Chart
                        html.Div(
                            [
                                html.H3("Price Chart"),
                                dcc.Graph(id="price-chart", style={"height": "400px"}),
                            ],
                            className="chart-container",
                        ),
                    ],
                    className="column-left",
                ),
                # Right Column - Tables
                html.Div(
                    [
                        # Positions Table
                        html.Div(
                            [html.H3("Open Positions"), html.Div(id="positions-table")],
                            className="table-container",
                        ),
                        # Recent Trades
                        html.Div(
                            [html.H3("Recent Trades"), html.Div(id="trades-table")],
                            className="table-container",
                        ),
                        # Strategy Performance
                        html.Div(
                            [html.H3("Strategy Performance"), html.Div(id="strategy-table")],
                            className="table-container",
                        ),
                        # Simulation Leaderboard
                        html.Div(
                            [
                                html.H3("Simulation Leaderboard"),
                                html.Div(id="simulation-leaderboard-table"),
                            ],
                            className="table-container",
                        ),
                    ],
                    className="column-right",
                ),
            ],
            className="main-content",
        ),
        # Update interval
        dcc.Interval(id="interval-component", interval=5000, n_intervals=0),  # 5 seconds
    ],
    className="dashboard",
)


# Callbacks
@app.callback(Output("clock", "children"), Input("interval-component", "n_intervals"))
def update_clock(n):
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@app.callback(
    [
        Output("portfolio-value", "children"),
        Output("portfolio-change", "children"),
        Output("daily-pnl", "children"),
        Output("daily-trades", "children"),
        Output("open-positions", "children"),
        Output("win-rate", "children"),
        Output("total-trades", "children"),
    ],
    Input("interval-component", "n_intervals"),
)
def update_summary(n):
    # Load data from analytics file
    try:
        with open("data/analytics/account.json", "r") as f:
            account = json.load(f)
    except Exception:
        account = {
            "portfolio_value": 10000.0,
            "daily_pnl": 0.0,
            "daily_return": 0.0,
            "daily_trades": 0,
            "open_positions": 0,
            "win_rate": 0.0,
            "total_trades": 0,
        }

    return (
        f"${account['portfolio_value']:,.2f}",
        f"{account.get('daily_return', 0):+.2f}%",
        f"${account['daily_pnl']:+.2f}",
        f"{account['daily_trades']} trades",
        str(account["open_positions"]),
        f"{account['win_rate']:.1f}%",
        f"{account['total_trades']} total",
    )


@app.callback(Output("equity-chart", "figure"), Input("interval-component", "n_intervals"))
def update_equity_chart(n):
    # Load equity curve
    try:
        with open("data/analytics/equity_curve.json", "r") as f:
            equity_data = json.load(f)
    except Exception:
        equity_data = []

    if not equity_data:
        # Demo data
        dates = pd.date_range(start=datetime.now() - timedelta(days=30), periods=100, freq="H")
        values = 10000 + np.cumsum(np.random.randn(100) * 50)
        equity_data = [
            {"timestamp": d.isoformat(), "value": v} for d, v in zip(dates, values, strict=False)
        ]

    df = pd.DataFrame(equity_data)
    df["timestamp"] = pd.to_datetime(df["timestamp"])

    fig = go.Figure()
    fig.add_trace(
        go.Scatter(
            x=df["timestamp"],
            y=df["value"],
            mode="lines",
            name="Portfolio Value",
            line=dict(color="#00ff88", width=2),
        )
    )

    fig.update_layout(
        template="plotly_dark",
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        margin=dict(l=40, r=40, t=40, b=40),
        xaxis_title="Time",
        yaxis_title="Value ($)",
        showlegend=False,
    )

    return fig


@app.callback(Output("price-chart", "figure"), Input("interval-component", "n_intervals"))
def update_price_chart(n):
    # Demo candlestick data
    np.random.seed(42)
    n_periods = 100

    base = 45000
    noise = np.cumsum(np.random.randn(n_periods) * 100)

    dates = pd.date_range(start=datetime.now() - timedelta(hours=100), periods=n_periods, freq="H")

    opens = base + noise + np.random.randn(n_periods) * 50
    closes = opens + np.random.randn(n_periods) * 100
    highs = np.maximum(opens, closes) + np.abs(np.random.randn(n_periods)) * 100
    lows = np.minimum(opens, closes) - np.abs(np.random.randn(n_periods)) * 100
    volumes = np.random.randint(1000000, 5000000, n_periods)

    fig = make_subplots(
        rows=2, cols=1, shared_xaxes=True, vertical_spacing=0.03, row_heights=[0.7, 0.3]
    )

    fig.add_trace(
        go.Candlestick(
            x=dates,
            open=opens,
            high=highs,
            low=lows,
            close=closes,
            name="BTCUSDT",
            increasing_line_color="#00ff88",
            decreasing_line_color="#ff4444",
        ),
        row=1,
        col=1,
    )

    fig.add_trace(go.Bar(x=dates, y=volumes, name="Volume", marker_color="#888888"), row=2, col=1)

    # Add moving averages
    fig.add_trace(
        go.Scatter(
            x=dates,
            y=pd.Series(closes).rolling(20).mean(),
            mode="lines",
            name="SMA 20",
            line=dict(color="#ffa500", width=1),
        ),
        row=1,
        col=1,
    )

    fig.update_layout(
        template="plotly_dark",
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        margin=dict(l=40, r=40, t=40, b=40),
        xaxis_rangeslider_visible=False,
        showlegend=False,
    )

    fig.update_xaxes(title_text="Time", row=2, col=1)
    fig.update_yaxes(title_text="Price ($)", row=1, col=1)
    fig.update_yaxes(title_text="Volume", row=2, col=1)

    return fig


@app.callback(Output("positions-table", "children"), Input("interval-component", "n_intervals"))
def update_positions_table(n):
    # Demo positions
    positions = [
        {
            "symbol": "BTCUSDT",
            "side": "LONG",
            "qty": 0.25,
            "entry": 45200.00,
            "current": 45650.00,
            "pnl": 112.50,
            "pnl_pct": 1.0,
        },
        {
            "symbol": "ETHUSDT",
            "side": "LONG",
            "qty": 2.5,
            "entry": 2400.00,
            "current": 2425.00,
            "pnl": 62.50,
            "pnl_pct": 1.04,
        },
    ]

    rows = []
    for pos in positions:
        pnl_color = "#00ff88" if pos["pnl"] >= 0 else "#ff4444"
        rows.append(
            html.Tr(
                [
                    html.Td(pos["symbol"]),
                    html.Td(pos["side"], style={"color": pnl_color}),
                    html.Td(f"{pos['qty']:.4f}"),
                    html.Td(f"${pos['entry']:,.2f}"),
                    html.Td(f"${pos['current']:,.2f}"),
                    html.Td(f"${pos['pnl']:+.2f}", style={"color": pnl_color}),
                    html.Td(f"{pos['pnl_pct']:+.2f}%", style={"color": pnl_color}),
                ]
            )
        )

    return html.Table(
        [
            html.Thead(
                html.Tr(
                    [
                        html.Th("Symbol"),
                        html.Th("Side"),
                        html.Th("Quantity"),
                        html.Th("Entry"),
                        html.Th("Current"),
                        html.Th("P&L"),
                        html.Th("P&L %"),
                    ]
                )
            ),
            html.Tbody(rows),
        ]
    )


@app.callback(Output("trades-table", "children"), Input("interval-component", "n_intervals"))
def update_trades_table(n):
    # Demo trades
    trades = [
        {
            "time": datetime.now() - timedelta(minutes=5),
            "symbol": "BTCUSDT",
            "action": "BUY",
            "qty": 0.1,
            "price": 45200.00,
            "pnl": None,
        },
        {
            "time": datetime.now() - timedelta(hours=1),
            "symbol": "ETHUSDT",
            "action": "BUY",
            "qty": 1.0,
            "price": 2400.00,
            "pnl": None,
        },
        {
            "time": datetime.now() - timedelta(hours=3),
            "symbol": "BTCUSDT",
            "action": "SELL",
            "qty": 0.05,
            "price": 45600.00,
            "pnl": 20.00,
        },
    ]

    rows = []
    for trade in trades:
        pnl_cell = "-"
        if trade["pnl"] is not None:
            pnl_color = "#00ff88" if trade["pnl"] >= 0 else "#ff4444"
            pnl_cell = html.Td(f"${trade['pnl']:+.2f}", style={"color": pnl_color})
        else:
            pnl_cell = html.Td("-")

        rows.append(
            html.Tr(
                [
                    html.Td(trade["time"].strftime("%H:%M:%S")),
                    html.Td(trade["symbol"]),
                    html.Td(trade["action"]),
                    html.Td(f"{trade['qty']:.4f}"),
                    html.Td(f"${trade['price']:,.2f}"),
                    pnl_cell,
                ]
            )
        )

    return html.Table(
        [
            html.Thead(
                html.Tr(
                    [
                        html.Th("Time"),
                        html.Th("Symbol"),
                        html.Th("Action"),
                        html.Th("Quantity"),
                        html.Th("Price"),
                        html.Th("P&L"),
                    ]
                )
            ),
            html.Tbody(rows),
        ]
    )


@app.callback(Output("strategy-table", "children"), Input("interval-component", "n_intervals"))
def update_strategy_table(n):
    stage_gate = _load_stage_gate_snapshot()
    if stage_gate and stage_gate.get("strategies"):
        strategies = [
            {
                "name": item["experiment_id"],
                "samples": int(item["summary"]["samples"]),
                "sharpe": float(item["summary"]["avg_sharpe"]),
                "profit": float(item["summary"]["total_pnl"]),
                "gate_status": "PASS" if item["passed"] else "HOLD",
            }
            for item in stage_gate["strategies"][:6]
        ]
    else:
        # Demo strategy metrics
        strategies = [
            {
                "name": "Scalping",
                "samples": 45,
                "sharpe": 1.15,
                "profit": 450.00,
                "gate_status": "PASS",
            },
            {
                "name": "Trend Following",
                "samples": 12,
                "sharpe": 0.94,
                "profit": 320.00,
                "gate_status": "PASS",
            },
            {
                "name": "Mean Reversion",
                "samples": 8,
                "sharpe": 0.73,
                "profit": 180.00,
                "gate_status": "HOLD",
            },
            {
                "name": "Arbitrage",
                "samples": 23,
                "sharpe": 1.42,
                "profit": 290.00,
                "gate_status": "PASS",
            },
        ]

    rows = []
    for strat in strategies:
        profit_color = "#00ff88" if strat["profit"] >= 0 else "#ff4444"
        status_color = "#00ff88" if strat["gate_status"] == "PASS" else "#ffa500"
        rows.append(
            html.Tr(
                [
                    html.Td(strat["name"]),
                    html.Td(strat["samples"]),
                    html.Td(f"{strat['sharpe']:.2f}"),
                    html.Td(f"${strat['profit']:+.2f}", style={"color": profit_color}),
                    html.Td(strat["gate_status"], style={"color": status_color}),
                ]
            )
        )

    return html.Table(
        [
            html.Thead(
                html.Tr(
                    [
                        html.Th("Strategy"),
                        html.Th("Samples"),
                        html.Th("Sharpe"),
                        html.Th("Profit"),
                        html.Th("Gate"),
                    ]
                )
            ),
            html.Tbody(rows),
        ]
    )


@app.callback(
    [
        Output("sim-best-quality-value", "children"),
        Output("sim-best-quality-detail", "children"),
        Output("sim-opt-target-value", "children"),
        Output("sim-opt-target-detail", "children"),
    ],
    Input("interval-component", "n_intervals"),
)
def update_simulation_kpi_cards(n):
    _ = n
    snapshot = _load_simulation_kpi_snapshot()
    best = snapshot.get("best_quality", {})
    target = snapshot.get("top_optimization_target", {})

    best_value = f"{float(best.get('avg_quality_score', 0.0)):.3f}"
    best_detail = (
        f"{best.get('strategy', 'n/a')} @ {best.get('market', 'n/a')} | "
        f"runs={int(best.get('runs', 0))} | "
        f"canary={float(best.get('canary_ready_rate', 0.0)):.0%}"
    )

    opt_value = f"{float(target.get('optimization_priority', 0.0)):.3f}"
    opt_detail = (
        f"{target.get('strategy', 'n/a')} @ {target.get('market', 'n/a')} | "
        f"MAPE={float(target.get('avg_slippage_mape_pct', 0.0)):.1f} | "
        f"reject={float(target.get('avg_reject_rate', 0.0)):.0%}"
    )

    return best_value, best_detail, opt_value, opt_detail


@app.callback(
    Output("simulation-leaderboard-table", "children"),
    Input("interval-component", "n_intervals"),
)
def update_simulation_leaderboard_table(n):
    leaderboard = _load_simulation_snapshot(limit=8)
    if not leaderboard:
        leaderboard = [
            {
                "rank": 1,
                "market": "crypto",
                "strategy": "market_making",
                "runs": 0,
                "avg_quality_score": 0.0,
                "avg_fill_rate": 0.0,
                "avg_reject_rate": 0.0,
                "avg_slippage_mape_pct": 0.0,
                "canary_ready_rate": 0.0,
                "promote_rate": 0.0,
                "optimization_priority": 0.0,
            }
        ]

    rows = []
    for item in leaderboard:
        quality = float(item.get("avg_quality_score", 0.0))
        mape = float(item.get("avg_slippage_mape_pct", 0.0))
        quality_color = "#00ff88" if quality >= 0.60 else "#ffa500"
        mape_color = "#ff4444" if mape >= 50.0 else "#00ff88"
        rows.append(
            html.Tr(
                [
                    html.Td(str(item.get("rank", "-"))),
                    html.Td(str(item.get("market", "-"))),
                    html.Td(str(item.get("strategy", "-"))),
                    html.Td(str(item.get("runs", 0))),
                    html.Td(f"{quality:.3f}", style={"color": quality_color}),
                    html.Td(f"{float(item.get('avg_fill_rate', 0.0)):.2%}"),
                    html.Td(f"{float(item.get('avg_reject_rate', 0.0)):.2%}"),
                    html.Td(f"{mape:.1f}", style={"color": mape_color}),
                    html.Td(f"{float(item.get('canary_ready_rate', 0.0)):.2%}"),
                    html.Td(f"{float(item.get('optimization_priority', 0.0)):.3f}"),
                ]
            )
        )

    return html.Table(
        [
            html.Thead(
                html.Tr(
                    [
                        html.Th("#"),
                        html.Th("Market"),
                        html.Th("Strategy"),
                        html.Th("Runs"),
                        html.Th("Quality"),
                        html.Th("Fill"),
                        html.Th("Reject"),
                        html.Th("MAPE"),
                        html.Th("Canary"),
                        html.Th("Opt"),
                    ]
                )
            ),
            html.Tbody(rows),
        ]
    )


# External stylesheet
app.css.append_css({"external_url": "https://codepen.io/chriddyp/pen/bWLwgP.css"})

if __name__ == "__main__":
    app.run_server(debug=True, host="0.0.0.0", port=8050)
