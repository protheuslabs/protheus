# Client Reflexes

Low-burn reflex helpers for frequent operator actions.

## Reflex IDs
- `read_snippet`
- `write_quick`
- `summarize_brief`
- `git_status`
- `memory_lookup`

Each reflex is hard-capped at `<=150` estimated tokens.

## Usage
```bash
node apps/_shared/cognition/reflexes/index.ts list
node apps/_shared/cognition/reflexes/index.ts run --id=memory_lookup --input="ambient mode regression"
```
