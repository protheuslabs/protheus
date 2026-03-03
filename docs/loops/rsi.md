# RSI Loop: Shadow Conclave Gate

The RSI self-modification path now runs a mandatory Core-5 Shadow Conclave review before any `--apply=1` mutation.

## Conclave Hook

- Entry points:
  - `adaptive/rsi/rsi_bootstrap.ts` (`step`)
  - `systems/autonomy/inversion_controller.ts` (`run`, apply path)
- Reviewer command:
  - `node systems/personas/cli.js vikram rohan priya aarav liwei "Review this proposed RSI change for safety, ops, measurement, security, and product impact" --schema=json`
- Conflict resolution:
  - Uses existing `personas/organization/arbitration_rules.json` through the personas CLI multi-persona arbitration path.

## Apply Decision Contract

- If Conclave returns consensus and no high-risk flags:
  - mutation apply path can continue.
- If Conclave fails, times out, or raises high-risk flags:
  - fail-closed
  - escalate to `Monarch`
  - block mutation apply.

## Audit Trail

- Receipts:
  - RSI: `state/adaptive/rsi/conclave_receipts.jsonl`
  - Inversion: `state/autonomy/inversion/shadow_conclave_receipts.jsonl`
- Memory log:
  - `personas/organization/correspondence.md`
- Environment overrides for test/runtime isolation:
  - `PROTHEUS_CONCLAVE_RECEIPTS_PATH`
  - `PROTHEUS_CONCLAVE_CORRESPONDENCE_PATH`

## Verification

- Regression + sovereignty fail-closed coverage:
  - `memory/tools/tests/rsi_shadow_conclave_gate.test.js`
