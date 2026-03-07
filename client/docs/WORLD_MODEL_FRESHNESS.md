# World-Model Freshness Loop

`client/systems/assimilation/world_model_freshness.ts` implements `V3-060`.

It continuously re-validates capability profile assumptions and emits freshness receipts + compiler deltas.

## What It Checks

- profile age vs warning/stale thresholds
- legal surface completeness (`tos_ok`, `robots_ok`, `data_rights_ok`)
- auth model presence
- rate-limit hint presence
- minimum refresh interval backoff

## Outputs

- `state/assimilation/world_model_freshness/latest.json`
- `state/assimilation/world_model_freshness/receipts.jsonl`
- `state/assimilation/world_model_freshness/deltas.jsonl`
- `state/assimilation/world_model_freshness/compiler_queue.jsonl`

Each stale profile emits a compiler-queue delta payload with normalized `capability_id`, `source_type`, reasons, and profile-derived `research_json` for downstream profile-compiler paths.

## Commands

- `node client/systems/assimilation/world_model_freshness.js run [--apply=1|0] [--strict=1|0] [--max-profiles=N]`
- `node client/systems/assimilation/world_model_freshness.js status`

## Notes

- `shadow_only=true` by default.
- `apply=1` only mutates profile freshness fields when not shadow-only.
- strict mode can fail closed if freshness SLO drops below policy target.

