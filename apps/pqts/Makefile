SHELL := /bin/bash
PYTHON ?= python3
VENV ?= .venv
VENV_PY := $(VENV)/bin/python

.PHONY: setup setup-lock demo sim-suite stream-worker ws-ingestion tournament canary-ramp reconcile slo-report error-budget control-plane test lint clean

setup:
	bash scripts/bootstrap_env.sh --python "$(PYTHON)" --venv "$(VENV)"

setup-lock:
	bash scripts/bootstrap_env.sh --python "$(PYTHON)" --venv "$(VENV)" --lock

demo:
	$(VENV_PY) demo.py --market crypto --strat ml-ensemble --source make_demo

sim-suite:
	$(VENV_PY) scripts/run_simulation_suite.py --markets crypto,equities,forex --strategies market_making,funding_arbitrage,cross_exchange --cycles-per-scenario 60 --readiness-every 20

stream-worker:
	$(VENV_PY) scripts/run_shadow_stream_worker.py --cycles 10 --sleep-seconds 1.0

ws-ingestion:
	$(VENV_PY) scripts/run_ws_ingestion.py --cycles 30 --sleep-seconds 1.0

tournament:
	$(VENV_PY) scripts/run_strategy_tournament.py --start 2026-01-01T00:00:00Z --end 2026-02-01T00:00:00Z

canary-ramp:
	$(VENV_PY) scripts/run_canary_ramp.py

reconcile:
	$(VENV_PY) scripts/run_reconciliation_daemon.py --cycles 10 --sleep-seconds 5.0 --halt-on-mismatch

slo-report:
	$(VENV_PY) scripts/slo_health_report.py

error-budget:
	$(VENV_PY) scripts/weekly_error_budget_review.py --window-days 7

control-plane:
	$(VENV_PY) scripts/control_plane_report.py

test:
	$(VENV_PY) -m pytest -q

lint:
	$(VENV_PY) -m black --check core execution risk analytics markets demo.py
	$(VENV_PY) -m isort --check-only core execution risk analytics markets demo.py
	$(VENV_PY) -m ruff check core execution risk analytics markets --select E9,F63,F7,F82
	$(VENV_PY) -m flake8 core execution risk analytics markets --count --select=E9,F63,F7,F82 --show-source --statistics

clean:
	rm -rf "$(VENV)"
