# Personas Trigger Rules

Purpose: make persona consults part of normal workflow instead of manual one-off calls.

## pre-sprint

- Route: `protheus lens trigger pre-sprint "<goal or plan>"`
- Default behavior: query core governance personas with decision lens; include verified system-passed feed context when permitted, and gracefully fall back when a persona blocks system-pass data.
- Use when: before kickoff, before reprioritizing, before changing migration sequence.

## drift-alert

- Route: `protheus lens trigger drift-alert "<drift context>"`
- Default behavior: consult `vikram_menon` with fail-closed bias and include verified system-passed feed context.
- Use when: drift risk, rollback risk, parity uncertainty, or safety ambiguity is detected.

## weekly-checkin

- Route: `protheus lens trigger weekly-checkin --persona=jay_haslam --heartbeat=HEARTBEAT.md`
- Default behavior: run checkin routine and append structured correspondence + memory node.
- Use when: weekly planning review and accountability closeout.
