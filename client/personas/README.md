# Personas

This directory stores internal operator lenses used for planning, audits, and decision pressure-testing.

## Structure

- `personas/controls/controls.md` - global control rules (cognizance-gap, alignment indicator, intercept)
- `personas/<name>/profile.md` - background, strengths, failure modes, communication style
- `personas/<name>/decision_lens.md` - tactical decision filters and default pushback
- `personas/<name>/strategic_lens.md` - long-horizon mission and scale framing
- `personas/<name>/lens.md` - legacy compatibility shim (mirrors decision lens)
- `personas/<name>/correspondence.md` - timestamped notes and decision history
- `personas/<name>/data_streams.md` - consent-bound Slack/LinkedIn stream configuration template
- `personas/<name>/data_permissions.md` - explicit source permissions (feed/slack/linkedin), all external sources off by default
- `personas/<name>/feed.md` - internal feed log from master orchestration to keep personas dynamic offline (`## System Passed` holds hash-verified system payloads)
- `personas/<name>/memory.md` - simplified node/tag memory used for persona recall
- `personas/<name>/values_philosophy_lens.md` - philosophy/values filters layered on top of decision/strategic lenses
- `personas/<name>/llm_config.md` - local persona LLM toggle/config (off by default, importance-gated build trigger)
- `personas/<name>/obfuscation_encryption.md` - persona data protection mode (off/obfuscate/encrypt; default off)
- `personas/<name>/soul_token.md` - owner-bound token metadata, usage rules, data-pass rules, and bundle hash
- `personas/<name>/emotion_lens.md` (optional) - emotional response patterns used to enrich lens output
- `personas/organization/organization.md` - higher-level organization scope, reporting chain, and escalation model
- `personas/organization/data_permissions.template.md` - canonical permission template (Core 5 default `system_internal` enabled)
- `personas/organization/triggers.md` - workflow trigger playbook for automated persona consult points
- `personas/organization/stance_cache.json` - pre-computed stances for recurring decisions (migration/API/safety defaults)
- `personas/organization/feedback.jsonl` (runtime) - session meta-feedback loop (`surprising`, `changed_decision`, `useful_persona`)

## Operating Rules

- Use personas as analysis lenses, not as authority replacement.
- Use `protheus lens <persona> --lens=decision|strategic|full "<query>"` for targeted mode selection.
- Use `protheus lens <persona1> <persona2> "<query>" [--expected="<baseline>"]` for deterministic multi-persona conflict + arbitration output.
- Use `protheus arbitrate --between=vikram,priya --issue="<query>"` for dedicated disagreement resolution output.
- Use `protheus lens <persona> --gap=<seconds> [--active=1] [--intercept="<override>"] "<query>"` for control-mode simulation (`e`=edit, `a`=approve early during gap).
- Use `--emotion=on|off` and `--values=on|off` to include or suppress emotion/values signals (defaults `on`).
- Use `--include-feed=1` to include hash-verified `## System Passed` feed payloads in response reasoning.
- Use `--surprise=on` to enable a deterministic 20% anti-puppet deviation die for challenge-style responses.
- Use `--schema=json` to emit structured response payloads for easier aggregation.
- Use `--max-context-tokens=<n>` (default `2000`) and `--context-budget-mode=trim|reject` to enforce bootstrap-vs-dynamic context budgeting before every lens call.
- Use `protheus lens update-stream <persona>` to simulate stream sync and append correspondence updates.
- Use `protheus lens feed <persona> "<snippet>"` (or `protheus persona feed ...`) to push master-feed insights to a persona.
- Use `protheus lens checkin --persona=jay_haslam --heartbeat=HEARTBEAT.md` for daily drift/alignment logging.
- Use `protheus lens feedback --surprising=0|1 --changed-decision=0|1 --useful=<persona>` after sessions to tune persona utility.
- Use `protheus lens feedback-summary [--window=<n>]` to monitor usefulness and decision-impact rates.
- Use `protheus lens trigger <pre-sprint|drift-alert|weekly-checkin> ...` to run codified trigger workflows.
- Use `protheus lens dashboard [--window=<n>]` for recent telemetry + checkin/intercept activity.
- Record significant decisions in correspondence logs.
- Keep language concise, technical, and auditable.
- Do not put secrets in this directory.

## Internal Usage Guide

- Daily check-in:
  - Run `protheus lens checkin --persona=jay_haslam --heartbeat=HEARTBEAT.md`.
  - Review recommendation + signals.
  - Confirm correspondence log updated.
- Red-team a decision:
  - Run `protheus lens all "<decision or plan>"`.
  - Compare hard constraints across personas before implementation.
- Suppress emotional cues for strict technical review:
  - Run `protheus lens <persona> --emotion=off "<query>"`.
- Suppress philosophy/value framing when you need purely tactical output:
  - Run `protheus lens <persona> --values=off "<query>"`.
- Use intercept controls when stakes are high:
  - Run with `--gap`, then `e` to override or `a` to approve early.
- Keep persona memory fresh without external integrations:
  - Push internal insights via `protheus lens feed <persona> "<snippet>" --tags=...`.
  - Use `protheus lens checkin` to append tagged memory nodes automatically.

## Context Budget Guard

- Bootstrap context is loaded first and treated as immutable minimum context (profile highlights, decision/strategic/values constraints, and non-negotiables).
- Dynamic memory context is loaded separately from `correspondence.md`, `feed.md`, and `memory.md` query recall.
- Guard defaults to `2000` estimated tokens (`--max-context-tokens` overrides).
- If over budget:
  - `trim` mode: trim dynamic context first and continue.
  - `reject` mode: fail closed.
- Every over-budget event is logged to:
  - `personas/organization/telemetry.jsonl` (`metric=context_budget_guard`)
  - `personas/<name>/correspondence.md` (`Re: context budget guard`)

## Orchestration Guide

- Run control-plane status:
  - `protheus orchestrate status`
- Inspect orchestration telemetry:
  - `protheus orchestrate telemetry --window=20`
- Run a meeting (deterministic attendee selection + arbitration + hash-chained artifact):
  - `protheus orchestrate meeting "Prioritize memory or security first?" --approval-note="operator-reviewed" --monarch-token=<token_id>`
- Create a project (state machine starts at `proposed`):
  - `protheus orchestrate project "foundation-lock" "Finish memory + security parity" --approval-note="operator-reviewed" --monarch-token=<token_id>`
- Transition a project:
  - `protheus orchestrate project --id=<project_id> --transition=active --approval-note="operator-reviewed" --monarch-token=<token_id>`
  - For `resumed` / `rolled_back`, pass `--drift-rate=<0..1>`; values above `0.02` auto-escalate to Core 5 review.
- Optional emotion enrichment:
  - `--emotion=on` appends tone notes to artifacts (context only; never used in arbitration).
- Override path (explicitly audited):
  - Add `--override-reason=... --override-actor=... --override-expiry=<ISO8601>`
  - Monarch token is required for high-risk and override paths by `soul_token_policy.json`.
- Audit and retention:
  - `protheus orchestrate audit "<artifact_id>"` reruns hash-chain/schema/policy checks.
  - `protheus orchestrate prune [--ttl-days=90]` prunes artifacts with a hard max TTL of 90 days.

Artifacts are append-only and hash-chained:
- Meetings: `personas/organization/meetings/ledger.jsonl`
- Projects: `personas/organization/projects/ledger.jsonl`
- Telemetry: `personas/organization/telemetry.jsonl`

Shadow mode starts enabled and exits only after metric thresholds in `personas/organization/risk_policy.json` are met.
Breaker behavior and recovery paths are defined in `personas/organization/breaker_policy.json`.
Soul-token authorization requirements are defined in `personas/organization/soul_token_policy.json`.

## Current Personas

- Persona roster is intentionally broad and evolves over time.
- Run `protheus lens --list` to get the canonical current set from disk.
- Core governance personas remain: `jay_haslam`, `vikram_menon`, `priya_venkatesh`, `rohan_kapoor`, `li_wei`, `aarav_singh`.

## Internal Cognitive Tools Guide

- Treat persona files as working internal docs, not storytelling artifacts.
- Use deterministic references (commits, receipts, artifacts) in correspondence.
- Use disagreement + meeting artifacts to show how decisions were resolved.
- Keep emotional context subtle in `profile.md` and operational in `emotion_lens.md`.
- Keep external sources off by default; use `system_internal` feed paths first.

This system is designed to make decision pressure-testing look and behave like a serious internal operating layer.
