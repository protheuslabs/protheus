# Vikram Correspondence

## 2026-03-01 - Rust migration criteria

The only migration metric that matters is public tracked-source composition and parity stability. Weighted internal metrics are not valid for release claims ([commit 479e8eb](https://github.com/protheuslabs/protheus/commit/479e8eb), [issue #312](https://github.com/protheuslabs/protheus/issues/312)).

## 2026-03-02 - Blob integration sequence

Blob system is acceptable as a packaging mechanism only if manifest verification is mandatory and hash mismatch is fail-closed ([PR #128](https://github.com/protheuslabs/protheus/pull/128), [commit 50cf586](https://github.com/protheuslabs/protheus/commit/50cf586)).

## 2026-03-03 - Foundation lock stance

Security gates must execute before operation dispatch. Do not add post-hoc checks that allow side effects first ([issue #341](https://github.com/protheuslabs/protheus/issues/341), [commit a8facbc](https://github.com/protheuslabs/protheus/commit/a8facbc)).

## 2026-03-04 - Dispatch gate acceptance

Control-plane dispatch should fail closed at the entrypoint to block unsafe downstream execution paths ([issue #362](https://github.com/protheuslabs/protheus/issues/362), [commit 479e8eb](https://github.com/protheuslabs/protheus/commit/479e8eb)).

## 2026-03-05 - Rollback proof requirement

Any migration claim must include an explicit rollback test artifact and owner acknowledgment before promotion ([PR #141](https://github.com/protheuslabs/protheus/pull/141), [issue #377](https://github.com/protheuslabs/protheus/issues/377)).
