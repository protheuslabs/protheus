# REQ-34 — Executable System Map Registry

## Purpose

Provide one generated, always-current system map that explains each major subsystem in one sentence, its layer ownership, its core I/O contracts, failure mode, health check, and SRS linkage.

## Contract

- Source of truth: `client/config/system_map_registry.json`
- Generator lane: `client/systems/ops/system_map_generator.ts`
- Published map artifact: `client/docs/architecture/SYSTEM_MAP.md`
- Runtime receipts/state: `client/local/state/ops/system_map/latest.json` and `history.jsonl`

## Required Fields Per Subsystem

- `id`
- `subsystem`
- `layer`
- `owner`
- `purpose`
- `inbound`
- `outbound`
- `failure_mode`
- `health_check`
- `srs`

## Commands

```bash
npm run -s ops:system-map:run
npm run -s ops:system-map:status
npm run -s test:ops:system-map-generator
```

## Exit Criteria

- Generated markdown exists and is current.
- All listed subsystems include layer + owner + health-check + SRS references.
- Generator test passes in CI/local runtime.
