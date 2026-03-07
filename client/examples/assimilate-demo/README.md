# Assimilate Demo

Run the assimilation command in proposal mode (no persona file mutations):

```bash
protheus assimilate ./client/docs/cognitive_toolkit.md --dry-run=1
```

Optional URL example (allowlisted domains only):

```bash
protheus assimilate https://github.com/example/repo --dry-run=1
```

Expected output includes:

- extracted requirements
- research-organ probe summary
- Core-5 review/arbitration snapshot
- Codex-ready sprint prompt
- estimated diff + risk summary
