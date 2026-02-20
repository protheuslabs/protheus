# State Stream Tracking Policy

Purpose: keep repository diffs reviewable while preserving intentional audit/governance history.

## Tracked By Default

These are source-of-truth or governance state files and should stay tracked:

- `state/long_term.md`
- `state/session_summary.md`
- `state/approvals_queue.yaml`
- `state/sensory/eyes/registry.json`
- `state/security/break_glass.jsonl`

Note: legacy tracked runtime artifacts may still exist in git history. Do not mass-untrack without an explicit migration change.

## Ignored By Default

High-churn generated runtime streams are ignored:

- sensory raw/digests/proposals/anomalies receipts
- spine run ledgers and router health snapshots
- routing health caches, decisions, outcomes, spend, model-catalog trial artifacts
- autonomy runs/receipts/budgets/calibration/cooldowns/improvement queues
- actuation receipts
- AIE event logs
- emergency stop runtime state and integrity violation runtime logs

Authoritative patterns live in `/Users/jay/.openclaw/workspace/.gitignore`.

## Change Control Rules

When adding a new `state/*` stream:

1. Classify it as `tracked` or `ignored` in this policy.
2. Update `/Users/jay/.openclaw/workspace/.gitignore` in the same change if `ignored`.
3. Do not ignore source code, config, or governance docs to reduce noise.
4. If an ignored runtime stream is needed for incident review, snapshot it deliberately in a tracked artifact (handoff/report), not by permanently tracking all runtime churn.
