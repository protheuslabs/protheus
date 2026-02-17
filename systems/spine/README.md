# Spine

Spine is the orchestration layer: it connects other layers and runs them in order.

## What Spine Does
- Sequences deterministic scripts (eyes, scoring, queue ingest, etc.)
- Calls `systems/security/guard.js` before touching protected code paths
- Sets CLEARANCE=3 (infrastructure tier) by default

## What Spine Does Not Do
- No policies (those live in `systems/security/`)
- No scoring logic (lives in each layer)
- No LLM prompting (keep hot paths deterministic)

## Usage

Run via habit wrapper (recommended):
```bash
node habits/scripts/spine_eyes.js 2026-02-17 --max-eyes=3
node habits/scripts/spine_daily.js 2026-02-17
```

Or invoke spine directly (requires clearance):
```bash
CLEARANCE=3 node systems/spine/spine.js eyes 2026-02-17 --max-eyes=3
CLEARANCE=3 node systems/spine/spine.js daily 2026-02-17
```

## Architecture

```
habits/scripts/spine_*.js   (tier 2 - habits, easy to change)
    ↓
systems/spine/spine.js      (tier 3 - infrastructure, harder to change)
    ↓
systems/security/guard.js   (tier 3 - permission gate)
    ↓
habits/scripts/*            (tier 2 - habit implementations)
```

## Break glass
```bash
BREAK_GLASS=1 APPROVAL_NOTE="emergency hotfix" CLEARANCE=2 node systems/spine/spine.js eyes 2026-02-17
```

This logs an entry to:
`state/security/break_glass.jsonl`
