# Cognitive Toolkit Suite

The Cognitive Toolkit Suite bundles internal operator tools used for red-teaming, alignment checks, and deterministic governance reviews.

This suite is intentionally practical and sober: each tool maps to an executable command, a demo example, and test-backed behavior.

## Included Tools

1. Personas  
Purpose: Multi-lens red-teaming and alignment pressure testing.

2. Dictionary  
Purpose: Fast lookup for novel internal concepts and definitions.

3. Orchestration  
Purpose: Deterministic meeting/project control-plane with audited artifacts.

4. Blob Morphing  
Purpose: Validate binary blob assets used by fold/unfold logic.

5. Comment Mapper  
Purpose: Stream-of-thought mapping with optional intercept controls.

6. Assimilate  
Purpose: Ingest local/web sources into a deterministic sprint prompt with Core-5 review and safety gates.
Also available as a programmatic API (`client/systems/tools/assimilate_api.js`) for loop/shadow self-use.

7. Research  
Purpose: Run natural-language research queries through hybrid evidence grading + Core-5 arbitration.
Also available as a programmatic API (`client/systems/tools/research_api.js`) for loop/shadow self-use.
Includes proactive assimilation suggestions when tool/path/URL mentions are detected in query text.

8. Tutorial Suggestions
Purpose: Context-aware command nudges in the main CLI loop (external tool, drift, planning signals) with light Core-5 safety review.
Control via `protheus tutorial status|on|off`.

## CLI Entry

Use the suite wrapper:

```bash
protheus toolkit list
```

Tool routes:

```bash
protheus toolkit personas --list
protheus toolkit dictionary term "Binary Blobs"
protheus toolkit orchestration status
protheus toolkit blob-morphing status
protheus toolkit comment-mapper --persona=vikram_menon --query="Should we prioritize memory or security first?" --gap=1 --active=1
protheus toolkit assimilate ./client/docs/cognitive_toolkit.md --dry-run=1
protheus toolkit research "creating a quant trading software" --dry-run=1
```

## Examples

- `client/apps/examples/personas-demo/`
- `client/apps/examples/dictionary-demo/`
- `client/apps/examples/orchestration-demo/`
- `client/apps/examples/blob-morphing-demo/`
- `client/apps/examples/comment-mapper-demo/`
- `client/apps/examples/assimilate-demo/`
- `client/apps/examples/research-demo/`

## Internal Positioning

This is an internal operators toolkit. It is optimized for:

- deterministic evidence paths
- quick auditability
- behavior-preserving workflows
- sovereignty gate compatibility
