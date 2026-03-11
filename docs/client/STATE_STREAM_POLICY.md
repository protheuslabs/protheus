# State Stream Policy

This policy defines which repository streams are source-of-truth (`tracked`) vs runtime/generated (`ignored`) and how that maps to `.gitignore`.

## Classes

| Class ID | Mode | Paths | Intent |
|---|---|---|---|
| `source_of_truth` | tracked | `client/runtime/systems/**`, `client/runtime/lib/**`, `client/runtime/config/**`, `docs/client/**`, `scripts/memory/**` | Canonical implementation, policies, and operator docs stay reviewable in git history. |
| `runtime_state` | ignored | `state/**`, `tmp/**`, `client/runtime/local/logs/**` | High-churn local runtime outputs are instance-local and should not pollute PRs. |
| `skills_local` | ignored | `client/cognition/skills/**` | Local skill installs are machine-specific; only curated MCP stubs are tracked. |

## .gitignore Alignment

Required ignore entries:
- `state/**`
- `tmp/`
- `client/runtime/local/logs/tool_raw/`

Required unignore exceptions:
- `!scripts/memory/**`
- `!client/cognition/skills/mcp/*.ts`
- `!client/cognition/skills/mcp/*.js`
- `!client/cognition/skills/mcp/*.json`

## Check Command

```bash
node client/runtime/systems/ops/state_stream_policy_check.js check --strict=1
```

This command verifies that this document and `.gitignore` remain aligned with the policy contract.
