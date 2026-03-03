# Rohan Correspondence

## 2026-03-01 - Release gate discipline

Any sprint result without build output and test logs should be treated as unverified, regardless of narrative confidence ([issue #281](https://github.com/protheuslabs/protheus/issues/281), [commit 479e8eb](https://github.com/protheuslabs/protheus/commit/479e8eb)).

## 2026-03-02 - Foundation sequencing

Foundation-first sequencing is correct: memory core stability and security gate enforcement must precede higher-level feature acceleration ([PR #129](https://github.com/protheuslabs/protheus/pull/129), [issue #297](https://github.com/protheuslabs/protheus/issues/297)).

## 2026-03-03 - Operational guardrails

Require explicit stop conditions for every rollout. If stop conditions are vague, default action is hold and audit ([issue #323](https://github.com/protheuslabs/protheus/issues/323), [commit 50cf586](https://github.com/protheuslabs/protheus/commit/50cf586)).

## 2026-03-04 - Rollout timing constraint

Rollout windows must include owner on-call availability and rollback command verification before canary starts ([issue #351](https://github.com/protheuslabs/protheus/issues/351), [PR #148](https://github.com/protheuslabs/protheus/pull/148)).

## 2026-03-05 - Alert fatigue control

Operational alerts must be actionable with bounded false positives, otherwise promotion stays blocked ([issue #364](https://github.com/protheuslabs/protheus/issues/364), [PR #153](https://github.com/protheuslabs/protheus/pull/153)).
