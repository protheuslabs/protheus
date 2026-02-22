# Secrets Channel (V1 Layout)

Purpose:
- Keep credentials and local secret material out of source + state channels.

Rules:
- Do not store real secret values in this repo directory.
- Runtime should prefer external secrets path: `~/.config/protheus/secrets/`.
- Keep this folder as structure-only (`README.md` + `.gitignore`).

Examples of external files (not in git):
- `~/.config/protheus/secrets/secret_broker_key.txt`
- `~/.config/protheus/secrets/moltbook.credentials.json`
- `~/.config/protheus/secrets/moltstack.credentials.json`

V2:
- Optional encryption-at-rest for external secret files.
