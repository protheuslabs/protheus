# Protheus Toybox Launch

This repository can be positioned as **Tool #1 in the Protheus Toybox** with measurable launch mechanics.

## Launch Assets

1. One-command demo:
`python demo.py --market crypto --strat ml-ensemble --source x_launch_thread`
2. Dashboard CTA:
`Upgrade to Protheus` link includes UTM tags from the dashboard header.
3. Agent handoff export:
`demo.py` emits a governed-lane strategy blob suitable for pilot ingestion.
4. Attribution log:
events are appended to `data/analytics/attribution_events.jsonl`.

## Suggested X Thread (Evidence-Safe)

1. Built a quant research/execution toy with real risk gates.
2. Multi-market simulation (crypto/equities/forex), paper-first promotion pipeline.
3. One-command demo in ~5 minutes:
`python demo.py --market crypto --strat ml-ensemble`
4. It exports a pilot handoff blob for agent workflows.
5. Repo: https://github.com/jakerslam/pqts

Do not post fabricated returns. Use only demo output and reproducible reports.

## Toybox Positioning

- PQTS = quant research + execution toy.
- Protheus = governance + agent-pilot operating system.
- Message: standalone is usable, agent-piloted becomes better through governed promotion.

## Metrics to Track (First 30 Days)

1. Demo runs by source: count `event=demo_run` in attribution log.
2. Clickthrough intent: count `source` values containing `utm_source=pqts_dashboard`.
3. Handoff adoption: number of generated `handoff_blob_*.json`.
4. Funnel quality: ratio of demo runs that achieve `promotion_decision=promote_to_live_canary`.

