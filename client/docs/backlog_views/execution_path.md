# Backlog Execution Path

Generated: 2026-03-08T16:37:53.202Z

## Summary

- Queued rows: 50
- Lane run commands discovered: 342
- Lane coverage (queued rows with lane): 0%
- Runnable now (lane + deps closed): 0
- Runnable but blocked by deps: 0
- Ready but no lane implementation: 46
- Blocked + no lane implementation: 4

## Recommended Next Actions

- Execute 0 runnable rows with existing lane commands first (lane:<id>:run + corresponding test:lane:<id>).
- For 46 dependency-ready rows without lanes, add runtime lane + test artifacts before marking done.
- Prioritize blocker dependencies (V6-SEC-001:3, V6-SEC-004:2) to unlock blocked rows fastest.

## Runnable Now

| ID | Wave | Class | Lane | Open Dependencies | Title |
|---|---|---|---|---|---|

## Ready But Missing Lane Implementation

| ID | Wave | Class | Lane | Open Dependencies | Title |
|---|---|---|---|---|---|
| V6-ADAPT-CORE-001 | V6 | backlog | no |  | Port adaptation primitives to core and demote client runtime |
| V6-BROWSER-001 | V6 | backlog | no |  | Native browser daemon binary path |
| V6-BROWSER-002 | V6 | backlog | no |  | Direct CDP native control primitives |
| V6-BROWSER-003 | V6 | backlog | no |  | Encrypted profile/session persistence for browser native mode |
| V6-BROWSER-004 | V6 | backlog | no |  | AI snapshot refs + annotation lane |
| V6-BROWSER-005 | V6 | backlog | no |  | Native browser policy gates and CLI integration |
| V6-BROWSER-006 | V6 | backlog | no |  | Zero-config browser daemon bootstrap lane |
| V6-BROWSER-008 | V6 | backlog | no |  | Multi-instance orchestration + real-time dashboard lane |
| V6-BROWSER-009 | V6 | backlog | no |  | Stealth + headed handoff control lane |
| V6-BROWSER-010 | V6 | backlog | no |  | Blob-backed encrypted session continuity lane |
| V6-BROWSER-011 | V6 | backlog | no |  | Multi-browser fallback profile lane |
| V6-BROWSER-012 | V6 | backlog | no |  | Shadow/persona browser governance + drift breaker lane |
| V6-BROWSER-013 | V6 | backlog | no |  | Browser API conformance harness lane |
| V6-BROWSER-014 | V6 | backlog | no |  | Snapshot/diff token-efficiency SLO gate lane |
| V6-BROWSER-015 | V6 | backlog | no |  | Zero-config startup + footprint verification lane |
| V6-BROWSER-016 | V6 | backlog | no |  | Cross-language HTTP integration contract lane |
| V6-BROWSER-017 | V6 | backlog | no |  | Comparative browser benchmark publication lane |
| V6-COMP-001 | V6 | backlog | no |  | Competitive benchmark matrix with reproducible receipts |
| V6-COMP-002 | V6 | backlog | no |  | `protheus migrate --from openfang` importer lane |
| V6-COMP-003 | V6 | backlog | no |  | Evidence-first audit dashboard drilldown |

## Top Dependency Blockers

| Dependency | Blocked Rows |
|---|---|
| V6-SEC-001 | 3 |
| V6-SEC-004 | 2 |

