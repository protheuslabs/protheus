# State Stream Policy

This policy defines which repository streams are source-of-truth (`tracked`) vs runtime/generated (`ignored`) and how that maps to `.gitignore`.

## Classes

| Class ID | Mode | Paths | Intent |
|---|---|---|---|
| `source_of_truth` | tracked | `client/systems/**`, `client/lib/**`, `client/config/**`, `client/docs/**`, `client/memory/tools/**` | Canonical implementation, policies, and operator docs stay reviewable in git history. |
| `runtime_state` | ignored | `state/**`, `tmp/**`, `client/logs/**` | High-churn local runtime outputs are instance-local and should not pollute PRs. |
| `skills_local` | ignored | `client/skills/**` | Local skill installs are machine-specific; only curated MCP stubs are tracked. |

## .gitignore Alignment

Required ignore entries:
- `state/**`
- `tmp/`
- `client/logs/tool_raw/`

Required unignore exceptions:
- `!client/memory/tools/**`
- `!client/skills/mcp/*.ts`
- `!client/skills/mcp/*.js`
- `!client/skills/mcp/*.json`

## Check Command

```bash
node client/systems/ops/state_stream_policy_check.js check --strict=1
```

This command verifies that this document and `.gitignore` remain aligned with the policy contract.
