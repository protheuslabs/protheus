# REQ-25: Community and Launch Maturity Gap Closer

Version: 1.0  
Date: 2026-03-06

## Objective

Close remaining public maturity/perception gaps without changing kernel authority boundaries:

- community onboarding signals,
- reusable launch communication assets,
- measurable quality gate tightening.

Rust remains the source of truth for core logic. These requirements only affect packaging/community/documentation/CI maturity.

## Requirements

1. `REQ-25-001` Good-first issue seed pack must exist with at least 10 concrete starter tasks.
- Acceptance:
  - `docs/community/GOOD_FIRST_ISSUES.md` exists with 10 scoped issues.
  - Issue specs include acceptance criteria and labels.

2. `REQ-25-002` Good-first issue publication must be automatable from repo state.
- Acceptance:
  - `systems/ops/good_first_issue_seed.js` supports dry-run and apply modes.
  - Seeder emits deterministic status receipt under `state/ops/good_first_issue_seed/latest.json`.

3. `REQ-25-003` Contributing docs must route first-time contributors to starter tasks.
- Acceptance:
  - `CONTRIBUTING.md` links the good-first issue pack and seeder instructions.

4. `REQ-25-004` Launch announcement templates must be available for X/HN/Reddit.
- Acceptance:
  - `docs/announcements/INFRING_LAUNCH_TEMPLATE.md` exists with ready-to-post templates.

5. `REQ-25-005` Coverage gate must enforce stronger public quality signal.
- Acceptance:
  - `.github/workflows/coverage.yml` gate enforces `combined_lines_pct >= 75`.

6. `REQ-25-006` External publication steps requiring account authority must be split out.
- Acceptance:
  - Human-governed publication of release tags/announcements is tracked in `docs/HUMAN_ONLY_ACTIONS.md`.

## Notes

- Release publication (`v0.2.0` tag push, npm publish, public announcement posting) remains authority-gated.
- This requirement covers implementation-ready artifacts inside the repository.
