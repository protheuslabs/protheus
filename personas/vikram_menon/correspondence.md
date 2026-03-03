# Vikram Correspondence

## 2026-03-01 - Rust migration criteria

The only migration metric that matters is public tracked-source composition and parity stability. Weighted internal metrics are not valid for release claims.

## 2026-03-02 - Blob integration sequence

Blob system is acceptable as a packaging mechanism only if manifest verification is mandatory and hash mismatch is fail-closed.

## 2026-03-03 - Foundation lock stance

Security gates must execute before operation dispatch. Do not add post-hoc checks that allow side effects first.
