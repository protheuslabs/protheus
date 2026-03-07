# Secrets Channel (V1 Layout)

Purpose:
- Keep credentials and local secret material out of source + state channels.

Rules:
- Do not store real secret values in this repo directory.
- Runtime should prefer external secrets path: `~/.client/config/protheus/client/secrets/`.
- Keep this folder as structure-only (`README.md` + `.gitignore`).

Examples of external files (not in git):
- `~/.client/config/protheus/client/secrets/secret_broker_key.txt`
- `~/.client/config/protheus/client/secrets/moltbook.credentials.json`
- `~/.client/config/protheus/client/secrets/moltstack.credentials.json`

V2:
- Optional encryption-at-rest for external secret files.
