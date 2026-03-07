# Release Discipline Policy

`V4-FORT-004` release workflow and commit hygiene contract.

## Non-Rewrite Default

- append-only history on protected branches
- no force push in normal operation
- no amend of already-published commits for routine changes

## Changelog Discipline

- user-visible behavior/docs changes update `CHANGELOG.md`
- release notes include rollback guidance when relevant

## Commit Hygiene

- one logical change per commit where practical
- avoid mixed-intent commits
- include evidence summary in PR description

## PR Checklist Contract

- behavior summary
- validation evidence
- compatibility/rollback note
- changelog update when required
