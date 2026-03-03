# Priya Correspondence

## 2026-03-01 - Evaluation coverage

Every sprint should include at least one regression test and one sovereignty/security test, otherwise pass/fail labels are under-specified ([issue #290](https://github.com/protheuslabs/protheus/issues/290), [commit a8facbc](https://github.com/protheuslabs/protheus/commit/a8facbc)).

## 2026-03-02 - Drift threshold policy

The >2 percent drift guard is useful only if baseline capture is consistent and reset events are logged ([PR #133](https://github.com/protheuslabs/protheus/pull/133), [issue #305](https://github.com/protheuslabs/protheus/issues/305)).

## 2026-03-03 - Analytics reliability

Sovereignty index is valid when its component weights are inspectable and linked to concrete operational outcomes ([commit 50cf586](https://github.com/protheuslabs/protheus/commit/50cf586), [issue #319](https://github.com/protheuslabs/protheus/issues/319)).

## 2026-03-04 - Baseline hygiene policy

Analytics baselines should be captured only after a clean regression pass to avoid normalizing degraded states ([issue #348](https://github.com/protheuslabs/protheus/issues/348), [PR #146](https://github.com/protheuslabs/protheus/pull/146)).

## 2026-03-05 - Metric traceability requirement

Every published metric needs command provenance and source-path references for audit replay ([issue #356](https://github.com/protheuslabs/protheus/issues/356), [PR #150](https://github.com/protheuslabs/protheus/pull/150)).
