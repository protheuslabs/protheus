# OpenClaw Workspace

This repository is an agent-operations workspace: orchestration, governed habits, memory indices, and runtime state.

## Architecture Map

- `systems/`  
  Infrastructure/control-plane layer. Contains spine, security, routing, and autonomy controllers.
- `habits/`  
  Dynamic semi-permanent routines with lifecycle governance (`candidate -> active -> disabled -> archived`).
- `skills/`  
  Task-specific skill packs and scripts.
- `config/`  
  Control-plane config (directives, routing, trust lists, budgets, strategy profiles).
- `memory/`  
  Indexed memory graph and tooling for traversal/maintenance.
- `state/`  
  Runtime outputs and ledgers (high churn).
- `lib/`  
  Shared utility modules.
- `docs/` and `patches/`  
  Design notes and implementation patches.

## Core Commands

```bash
# Validate script CLI contracts used by spine
node systems/spine/contract_check.js

# Stable CI test suite (contract + deterministic tests)
npm run test:ci

# Validate habit governance + trust gates
node habits/scripts/doctor.js

# Run sensing pipeline
node systems/spine/spine.js eyes [YYYY-MM-DD] [--max-eyes=N]

# List sensory eyes (passive sources only)
node habits/scripts/eyes_inventory.js [--json]

# Collector reliability doctor (per-eye fetch health/SLOs)
node habits/scripts/external_eyes.js doctor

# Strict signal SLO check (exits non-zero when starved)
node habits/scripts/external_eyes.js slo [YYYY-MM-DD]

# Run daily orchestration pipeline
node systems/spine/spine.js daily [YYYY-MM-DD] [--max-eyes=N]

# Optional: enable daily external runtime-state backups during spine daily
STATE_BACKUP_ENABLED=1 node systems/spine/spine.js daily [YYYY-MM-DD]

# Optional: disable daily local probe-all refresh (enabled by default)
SPINE_ROUTER_PROBE_ALL=0 node systems/spine/spine.js daily [YYYY-MM-DD]

# Routing hardware planner snapshot (local eligibility by CPU/RAM/VRAM class)
node systems/routing/model_router.js hardware-plan

# Optional: increase/decrease score-only evidence attempts per daily run (default 2, max 6)
AUTONOMY_EVIDENCE_RUNS=3 node systems/spine/spine.js daily [YYYY-MM-DD]

# Manual state backup snapshots (outside git workspace)
node systems/ops/state_backup.js run --dry-run
node systems/ops/state_backup.js run --dest=/tmp/protheus-state-backup
node systems/ops/state_backup.js list [--limit=10]

# Non-destructive stale runtime-state cleanup (dry-run by default)
node systems/ops/state_cleanup.js run
node systems/ops/state_cleanup.js run --apply --max-delete=200
node systems/ops/state_cleanup.js profiles

# Heartbeat-safe trigger (throttled, idempotent)
node systems/spine/heartbeat_trigger.js run [--mode=daily|eyes] [--min-hours=N] [--max-eyes=N]

# Generic actuation executor (adapter-based)
node systems/actuation/actuation_executor.js list
node systems/actuation/actuation_executor.js run --kind=<adapter_id> [--params='{"k":"v"}'] [--dry-run]

# Generate a generic actuation proposal template (for state/sensory/proposals/YYYY-MM-DD.json)
node systems/actuation/proposal_template.js generic --kind=<adapter_id> --title="..." [--params='{"k":"v"}']

# Example skill-specific template (Moltbook)
node skills/moltbook/proposal_template.js --title="..." --body="..." [--submolt=general]

# Bridge actuation hints in proposals into meta.actuation (deterministic)
node systems/actuation/bridge_from_proposals.js run [YYYY-MM-DD] [--dry-run]

# Unified autonomy/routing/actuation health view
node systems/autonomy/health_status.js [YYYY-MM-DD]

# 7-day autonomy receipt scorecard (attempted/verified/failure reasons)
node systems/autonomy/receipt_summary.js run [YYYY-MM-DD] [--days=7]

# Strategy schema/policy doctor (active profile + strict validation)
node systems/autonomy/strategy_doctor.js run
node systems/autonomy/strategy_doctor.js run --strict

# Strategy mode readiness gate (score_only -> execute recommendation only)
node systems/autonomy/strategy_readiness.js run [YYYY-MM-DD] [--days=14]

# Strategy mode manager (manual switch with readiness + approval note guards)
node systems/autonomy/strategy_mode.js status
node systems/autonomy/strategy_mode.js recommend [YYYY-MM-DD] [--days=14]
node systems/autonomy/strategy_mode.js set --mode=execute --approval-note="..." --approver-id="<id1>" --second-approver-id="<id2>" --second-approval-note="..."

# Architecture guard (audit by default, strict for CI/gates)
node systems/security/architecture_guard.js run
node systems/security/architecture_guard.js run --strict

# Integrity kernel (tamper-evident hashes for security/directive policy)
node systems/security/integrity_kernel.js run
node systems/security/integrity_kernel.js seal --approval-note="..."

# Tier 1 directive intake (interactive SMART-lite guard before write)
node systems/security/directive_intake.js new --id=T1_example_v1 --interactive
node systems/security/directive_intake.js validate --file=config/directives/T1_example_v1.yaml

# Emergency kill-switch (autonomy/routing/actuation)
node systems/security/emergency_stop.js status
node systems/security/emergency_stop.js engage --scope=all --approval-note="..."
node systems/security/emergency_stop.js release --approval-note="..."
```

## Clearance Tiers

- `CLEARANCE=1`: state data operations (`state/`).
- `CLEARANCE=2`: habits/reflexes (`habits/`).
- `CLEARANCE=3`: infrastructure/config/memory tooling (`systems/`, `config/`, `memory/`, default).
- `CLEARANCE=4`: explicitly protected core files (if declared in guard policy).

## Remote Request Gate

`systems/security/guard.js` supports source-aware gating:
- Remote sources (for example `REQUEST_SOURCE=slack`) are proposal-only by default.
- Direct apply from remote requires `REMOTE_DIRECT_OVERRIDE=1`, `BREAK_GLASS=1`, `APPROVER_ID`, `APPROVAL_NOTE`, `SECOND_APPROVER_ID`, `SECOND_APPROVAL_NOTE`, and a valid signed envelope (`REQUEST_TS`, `REQUEST_NONCE`, `REQUEST_SIG`) verified with `REQUEST_GATE_SECRET` (or `REQUEST_KEY_ID` + `REQUEST_GATE_SECRET_<KEY_ID>`).
- Signed nonces are replay-guarded for remote direct apply (one-time use during TTL window).
- Use ingress wrapper to stamp metadata/signature:
  `node systems/security/request_ingress.js run --source=slack --action=apply --guard-files=config/agent_routing_rules.json --key-id=primary.v1 -- node systems/security/guard.js --files=config/agent_routing_rules.json`

## Automation Policy

- See `docs/AUTOMATION_POLICY.md` for the explicit auto vs gated vs operator-approved contract.

## Autonomy Capability Note

Model catalog maintenance is a built-in autonomy capability via:
- `node systems/autonomy/model_catalog_loop.js propose`
- `node systems/autonomy/model_catalog_loop.js trial --id=...`
- `node systems/autonomy/model_catalog_loop.js report [--id=...]`
- `node systems/autonomy/model_catalog_loop.js apply --id=... --approval-note=\"...\"`

Guardrail: `apply` is elevated only (`CLEARANCE>=3`) and must pass `systems/security/guard.js` with an approval note.

## Routing Variant Policy

`config/agent_routing_rules.json` now supports `routing.model_variant_policy` to route base models to `:thinking` variants only for high-tier reasoning tasks (tier/role/outcome-gated), then auto-return to base via `post_task_return_model` in route decisions.

## Git Hygiene

`.gitignore` now excludes high-churn runtime artifacts (raw sensory streams, run ledgers, daily state dumps, tool raw logs, backups, temp files) so source-level diffs stay reviewable.
State tracking policy is documented in `/Users/jay/.openclaw/workspace/docs/STATE_STREAM_POLICY.md`.

Future upgrade ideas are tracked in `/Users/jay/.openclaw/workspace/UPGRADE_BACKLOG.md`.
