# Spine

**Spine = plumbing/orchestration only.**

It sequences layer scripts in a deterministic order and runs a single clearance gate:

- `systems/security/guard.js` is the choke point (clearance tiers)
- `systems/spine/spine.js` orchestrates calls (no scoring, no prompting, no habit logic)
- `habits/scripts/spine_*.js` are convenience wrappers ("reflexes")

## Commands

Run eyes pipeline:

```bash
node systems/spine/spine.js eyes [YYYY-MM-DD] [--max-eyes=N]
```

Run daily pipeline (currently same as eyes, reserved for expansion):

```bash
node systems/spine/spine.js daily [YYYY-MM-DD] [--max-eyes=N]
```

## Clearance defaults

- Spine defaults to `CLEARANCE=3` if unset.
- Habits wrappers default to `CLEARANCE=3` (because they invoke spine).

Override (not recommended):

```bash
BREAK_GLASS=1 APPROVAL_NOTE="why" CLEARANCE=2 node systems/spine/spine.js eyes
```
