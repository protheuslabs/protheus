# Tests Surface

Top-level tests live in `/tests` and hold integration, regression, system, and end-to-end verification.

Rules:
- Unit tests may remain close to the code they verify.
- Integration, regression, chaos, and end-to-end suites should prefer `/tests`.
- Tests may be polyglot.
- Test helpers must not quietly become production authority logic.

Goal:
- keep verification visible and organized without forcing every small unit test away from the code it exercises
